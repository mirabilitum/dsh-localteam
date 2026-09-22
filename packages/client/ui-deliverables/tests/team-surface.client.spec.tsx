// @vitest-environment jsdom
/**
 * The team controls: reading whether this page is a member of a shared
 * deployment, saving a conversation's output, and handing its control over.
 *
 * The cases worth protecting are the ones that decide whether a control should
 * exist at all — a single-operator instance must render nothing, a conversation
 * with no output must not save an error body, and a refused hand-over must say
 * which rule it hit — plus the two gestures addressing the Host's own routes.
 */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { TeamSurface } from '../src/client/team-surface.ts'
import type { TeamView } from '../src/client/team-surface.ts'
import { TeamSurfaceActions, type TeamSurfaceActionProps, type TeamSurfaceInjected } from '../src/client/TeamSurfaceActions.tsx'

afterEach(() => {  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const STATUS = '/api/team.identity'
const EXPORT = '/api/team.export'
const HANDOVER = '/api/team.identity.handover'

/** One stubbed answer. */
type FetchAnswer = () => Response | Promise<Response>

/**
 * A fetch stub that answers by URL, recording every request.
 *
 * An answer may be keyed by path alone or by `METHOD path`, because the export
 * route serves both a manifest read and an archive write — the same path with
 * two very different answers.
 */
function stubFetch(answers: Record<string, FetchAnswer>) {
  const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = []
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    const path = url.split('?')[0] as string
    const answer = answers[`${init?.method ?? 'GET'} ${path}`] ?? answers[path]
    return Promise.resolve(answer === undefined ? new Response(null, { status: 404 }) : answer())
  })
  vi.stubGlobal('fetch', fetcher)
  return { calls, fetcher }
}

const memberStatus = () => Response.json({
  signedIn: true,
  userId: 'p-alpha',
  members: [{ userId: 'p-alpha', name: 'alpha' }, { userId: 'p-bravo', name: 'bravo' }],
})

/** Render one team-controls entry over an already-resolved view. */
function renderControls(surface: TeamSurface, sessionId = 'session-1', locale = zh) {
  const face: TeamSurfaceInjected = {
    hooks: { team: surface.view },
    readManifest: scope => surface.manifest(sessionId, scope),
    downloadSelection: paths => surface.downloadSelection(sessionId, paths),
    downloadFile: path => surface.downloadFile(sessionId, path),
    readControl: () => surface.control(sessionId),
    takeOver: () => surface.takeOver(sessionId),
    handOver: to => surface.handOver(sessionId, to),
  }
  // The slot hands every header entry the whole Session kit; this entry reads
  // the session id, the shared view, and its injected face, so the rest of the
  // kit is not stubbed here.
  const props = {
    sessionId: SessionId(sessionId),
    useTeam: <S,>(select: (state: TeamView) => S): S => select(surface.view.getSnapshot()),
    ...face,
    t: makeTranslate(locale),
  }
  return render(<TeamSurfaceActions {...props as unknown as TeamSurfaceActionProps} />)
}

describe('reading the deployment', () => {
  it('reports a member with the roster', async () => {
    stubFetch({ [STATUS]: memberStatus })
    const surface = new TeamSurface()
    await surface.load()
    expect(surface.view.getSnapshot()).toEqual({
      status: 'member',
      userId: 'p-alpha',
      members: [{ userId: 'p-alpha', name: 'alpha' }, { userId: 'p-bravo', name: 'bravo' }],
    })
    await surface.dispose()
  })

  it('reports a deployment with no team route as personal, and one failed read as unknown', async () => {
    stubFetch({})
    const personal = new TeamSurface()
    await personal.load()
    // No route is the single-operator instance: not a failure, an answer.
    expect(personal.view.getSnapshot()).toEqual({ status: 'personal' })
    await personal.dispose()

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const failing = new TeamSurface()
    await failing.load()
    // A read that failed is not an answer, so no control is offered on a guess.
    expect(failing.view.getSnapshot()).toEqual({ status: 'unknown' })
    await failing.dispose()
  })

  it('keeps a roster entry out when the Host sent a shape it should not have', async () => {
    stubFetch({ [STATUS]: () => Response.json({ signedIn: true, userId: 'p-alpha', members: [{ userId: 'p-alpha' }, 'nope'] }) })
    const surface = new TeamSurface()
    await surface.load()
    expect(surface.view.getSnapshot()).toEqual({ status: 'member', userId: 'p-alpha', members: [] })
    await surface.dispose()
  })

  it('re-reads after a connection replacement', async () => {
    const { calls } = stubFetch({ [STATUS]: memberStatus })
    const surface = new TeamSurface()
    // Two reads in flight at once are one request; a read after the first settled
    // is a new one, which is what a connection replacement asks for.
    await Promise.all([surface.load(), surface.load()])
    expect(calls).toHaveLength(1)
    surface.forget()
    await waitFor(() => { expect(calls).toHaveLength(2) })
    await surface.dispose()
  })
})

describe('the two gestures', () => {
  it('reads the manifest, posts the selection, and saves a local blob', async () => {
    const { calls } = stubFetch({
      [`GET ${EXPORT}`]: () => Response.json({
        project: 'P',
        products: [{ path: 'work/a.txt', bytes: 3 }, { path: 'work/b.txt', bytes: 4 }],
        empty: false,
        limits: { blobMax: 1024, archiveMax: 1024, fileMax: 1024 },
      }),
      [`POST ${EXPORT}`]: () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          // A Chinese name only survives in the extended form; the ASCII fallback
          // is a row of underscores.
          'content-disposition': 'attachment; filename="P.zip"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A.zip',
          'x-team-export-files': '2',
        },
      }),
    })
    const saved: { readonly href: string | null; readonly name: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      // The attribute, not `href`: the DOM resolves `href` against the page.
      saved.push({ href: this.getAttribute('href'), name: this.download })
    })
    const surface = new TeamSurface()
    expect(await surface.download('session-1')).toEqual({ ok: true, files: 2, bytes: 3 })
    expect(calls[0]?.url).toBe(`${EXPORT}?sessionId=session-1&scope=all&form=manifest`)
    // The selection travels as a form body — hundreds of paths do not fit in a
    // query string — and the save is a local blob URL, never a navigation to the
    // export route.
    expect(calls[1]?.init?.method).toBe('POST')
    expect(calls[1]?.init?.body).toBe('path=work%2Fa.txt&path=work%2Fb.txt')
    expect(saved).toHaveLength(1)
    expect(saved[0]?.href?.startsWith('blob:')).toBe(true)
    expect(saved[0]?.name).toBe('报告.zip')
    await surface.dispose()
  })

  it('refuses a package the page could not hold, instead of buffering it', async () => {
    stubFetch({
      [`GET ${EXPORT}`]: () => Response.json({
        project: 'P',
        products: [{ path: 'work/a.txt', bytes: 3 }],
        empty: false,
        limits: { blobMax: 4, archiveMax: 1024, fileMax: 1024 },
      }),
      [`POST ${EXPORT}`]: () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), { status: 200 }),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const surface = new TeamSurface()
    // Past the Host's own budget for this page: the answer is that the selection
    // has to shrink, which is something a member can act on.
    expect(await surface.download('session-1')).toEqual({ ok: false, reason: 'too-large' })
    expect(click).not.toHaveBeenCalled()
    await surface.dispose()
  })

  it('does not start a download for a conversation that produced nothing', async () => {
    stubFetch({ [EXPORT]: () => Response.json({ error: 'export-refused', reason: 'nothing-produced' }, { status: 404 }) })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const surface = new TeamSurface()
    expect(await surface.download('session-1')).toEqual({ ok: false, reason: 'nothing-produced' })
    // Saving the refusal body under the project's name would be worse than saying so.
    expect(click).not.toHaveBeenCalled()
    await surface.dispose()
  })

  it('reports an unreachable Host rather than a silent failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const surface = new TeamSurface()
    expect(await surface.download('session-1')).toEqual({ ok: false, reason: 'unreachable' })
    expect(await surface.handOver('session-1', 'p-bravo')).toEqual({ ok: false, reason: 'unreachable', controller: undefined })
    await surface.dispose()
  })

  it('hands control to a named member and reads the Host’s refusals apart', async () => {
    const { calls } = stubFetch({
      [HANDOVER]: () => Response.json({ handedOver: true, controller: 'p-bravo' }),
    })
    const surface = new TeamSurface()
    expect(await surface.handOver('session-1', 'p-bravo')).toEqual({ ok: true, controller: 'p-bravo' })
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe('{"sessionId":"session-1","to":"p-bravo"}')

    // Releasing names no recipient, and the refusal carries who is driving it.
    stubFetch({ [HANDOVER]: () => Response.json({ ok: false, reason: 'not-controller', controller: 'p-bravo', error: 'hand-over-refused' }, { status: 409 }) })
    expect(await surface.handOver('session-1')).toEqual({ ok: false, reason: 'not-controller', controller: 'p-bravo' })
    await surface.dispose()
  })
})

describe('the team controls', () => {
  it('renders nothing for a single-operator instance', async () => {
    stubFetch({})
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)
    expect(view.container.querySelector('[data-team-actions]')).toBeNull()
    await surface.dispose()
  })

  it('offers the files in a header panel, then saves the selection', async () => {
    const { calls } = stubFetch({
      [STATUS]: memberStatus,
      [`GET ${EXPORT}`]: () => Response.json({
        project: 'P',
        products: [
          { path: 'work/a.txt', bytes: 3, sessionId: 'session-1', member: 'p-alpha', turn: 1, producedAt: '2026-01-01T00:00:00.000Z' },
          { path: 'work/b.txt', bytes: 4, sessionId: null, member: null, turn: null, producedAt: '2026-01-01T00:00:00.000Z' },
        ],
        empty: false,
        limits: { blobMax: 1024, archiveMax: 1024, fileMax: 1024 },
      }),
      [`POST ${EXPORT}`]: () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'x-team-export-files': '1' },
      }),
      [`GET ${HANDOVER}`]: () => Response.json({
        sessionId: 'session-1', driven: true, controller: 'p-alpha', idleMs: 0,
        requiredIdleMs: 900_000, pending: false, mayTakeOver: false,
      }),
      [HANDOVER]: () => Response.json({ handedOver: true, controller: 'p-bravo' }),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)

    fireEvent.click(view.getByRole('button', { name: zh['team.download'] }))
    // Everything is selected to begin with, and the unattributed file is one of
    // them: a package that silently left files out is the worse failure.
    await waitFor(() => { expect(view.getByLabelText('work/b.txt')).toBeTruthy() })
    expect((view.getByLabelText('work/a.txt') as HTMLInputElement).checked).toBe(true)
    expect((view.getByLabelText('work/b.txt') as HTMLInputElement).checked).toBe(true)
    expect(view.getByText(/所选 2 个文件/)).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: zh['team.downloadChosen'] }))
    await waitFor(() => { expect(view.getByRole('status').textContent).toContain('已获取 1 个文件') })
    // The selection was posted as a form body, not navigated to.
    const posted = calls.find(call => call.init?.method === 'POST' && call.url.includes('form=zip'))
    expect(posted?.init?.body).toBe('path=work%2Fa.txt&path=work%2Fb.txt')
    await surface.dispose()
  })

  it('offers the other members and the release to the member driving it', async () => {
    const { calls } = stubFetch({
      [STATUS]: memberStatus,
      [`GET ${HANDOVER}`]: () => Response.json({
        sessionId: 'session-1', driven: true, controller: 'p-alpha', idleMs: 0,
        requiredIdleMs: 900_000, pending: false, mayTakeOver: false,
      }),
      [HANDOVER]: () => Response.json({ handedOver: true, controller: 'p-bravo' }),
    })
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)

    fireEvent.click(view.getByRole('button', { name: zh['team.control'] }))
    await waitFor(() => { expect(view.getByRole('menuitem', { name: '移交给 bravo' })).toBeTruthy() })
    // The member reading the page is not offered as a recipient of their own control.
    expect(view.queryByRole('menuitem', { name: '移交给 alpha' })).toBeNull()
    fireEvent.click(view.getByRole('menuitem', { name: '移交给 bravo' }))
    await waitFor(() => { expect(view.getByRole('status').textContent).toBe('控制权已移交') })
    expect(calls.filter(call => call.url === HANDOVER)).toHaveLength(1)

    fireEvent.click(view.getByRole('menuitem', { name: zh['team.release'] }))
    await waitFor(() => { expect(calls.filter(call => call.url === HANDOVER)).toHaveLength(2) })
    // Releasing names no recipient: the absence of `to` is the decision.
    expect(calls.filter(call => call.url === HANDOVER)[1]?.init?.body).toBe('{"sessionId":"session-1"}')
    await surface.dispose()
  })

  it('offers a takeover only once the holder has been idle long enough', async () => {
    stubFetch({
      [STATUS]: memberStatus,
      [`GET ${HANDOVER}`]: () => Response.json({
        sessionId: 'session-1', driven: true, controller: 'p-bravo', idleMs: 0,
        requiredIdleMs: 900_000, pending: true, mayTakeOver: false,
      }),
      [HANDOVER]: () => Response.json({
        ok: false, reason: 'not-idle', controller: 'p-bravo', idleMs: 0, requiredIdleMs: 900_000,
        error: 'take-over-refused',
      }, { status: 409 }),
    })
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)

    fireEvent.click(view.getByRole('button', { name: zh['team.control'] }))
    // Not yet: the button says how long is left instead of offering the gesture.
    await waitFor(() => { expect(view.getByRole('menuitem', { name: /还差 \d+ 分钟可接管/ })).toBeTruthy() })
    expect((view.getByRole('menuitem', { name: /还差 \d+ 分钟可接管/ }) as HTMLButtonElement).disabled).toBe(true)
    // The conversation is waiting on its holder, which the panel says out loud.
    expect(view.getByText(zh['team.pendingNote'])).toBeTruthy()
    await surface.dispose()
  })

  it('takes the refusal’s own clock back into the countdown it shows', async () => {
    stubFetch({
      [STATUS]: memberStatus,
      // The panel read says a takeover is possible; the Host decides otherwise,
      // because the holder acted again in between.
      [`GET ${HANDOVER}`]: () => Response.json({
        sessionId: 'session-1', driven: true, controller: 'p-bravo', idleMs: 900_000,
        requiredIdleMs: 900_000, pending: false, mayTakeOver: true,
      }),
      [HANDOVER]: () => Response.json({
        ok: false, reason: 'not-idle', controller: 'p-bravo', idleMs: 600_000, requiredIdleMs: 900_000,
        error: 'take-over-refused',
      }, { status: 409 }),
    })
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)

    fireEvent.click(view.getByRole('button', { name: zh['team.control'] }))
    await waitFor(() => { expect(view.getByRole('menuitem', { name: zh['team.takeOver'] })).toBeTruthy() })
    fireEvent.click(view.getByRole('menuitem', { name: zh['team.takeOver'] }))
    await waitFor(() => { expect(view.getByRole('status').textContent).toBe(zh['team.notIdle']) })

    // The refusal carries newer numbers than the panel had, and those are what
    // the countdown is built from: 900000 − 600000 is five minutes.
    const waiting = view.getByRole('menuitem', { name: /还差 \d+ 分钟可接管/ }) as HTMLButtonElement
    expect(waiting.disabled).toBe(true)
    expect(waiting.textContent).toContain('还差 5 分钟可接管')
    await surface.dispose()
  })

  it('keeps the panel and the selection when the save is refused', async () => {
    stubFetch({
      [STATUS]: memberStatus,
      [`GET ${EXPORT}`]: () => Response.json({
        project: 'P',
        products: [
          { path: 'work/a.txt', bytes: 3, sessionId: 'session-1', member: 'p-alpha', turn: 1, producedAt: '2026-01-01T00:00:00.000Z' },
          { path: 'work/b.txt', bytes: 4, sessionId: null, member: null, turn: null, producedAt: '2026-01-01T00:00:00.000Z' },
        ],
        empty: false,
        limits: { blobMax: 1024, archiveMax: 1024, fileMax: 1024 },
      }),
      [`POST ${EXPORT}`]: () => Response.json({ reason: 'unreadable' }, { status: 500 }),
    })
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)

    fireEvent.click(view.getByRole('button', { name: zh['team.download'] }))
    await waitFor(() => { expect(view.getByLabelText('work/b.txt')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: zh['team.downloadChosen'] }))

    // The failure is said in the page, and nothing was navigated away from: the
    // panel is still open with the same two files ticked.
    await waitFor(() => { expect(view.getByRole('status').textContent).toBe(zh['team.reason.unreadable']) })
    expect((view.getByLabelText('work/a.txt') as HTMLInputElement).checked).toBe(true)
    expect((view.getByLabelText('work/b.txt') as HTMLInputElement).checked).toBe(true)
    expect(view.getByText(/所选 2 个文件/)).toBeTruthy()
    await surface.dispose()
  })

  it('will not offer a package over the budget, and says why', async () => {
    stubFetch({
      [STATUS]: memberStatus,
      [`GET ${EXPORT}`]: () => Response.json({
        project: 'P',
        products: [
          { path: 'work/big-1.bin', bytes: 800, sessionId: 'session-1', member: 'p-alpha', turn: 1, producedAt: '2026-01-01T00:00:00.000Z' },
          { path: 'work/big-2.bin', bytes: 800, sessionId: 'session-1', member: 'p-alpha', turn: 1, producedAt: '2026-01-01T00:00:00.000Z' },
        ],
        empty: false,
        limits: { blobMax: 1024, archiveMax: 1024, fileMax: 1024 },
      }),
    })
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)

    fireEvent.click(view.getByRole('button', { name: zh['team.download'] }))
    // Everything is selected, the total is over the limit, and the gesture is
    // taken away rather than offered and then refused: narrowing the selection is
    // the only thing that can succeed, so that is the only thing left to do.
    await waitFor(() => { expect(view.getByText(/所选超过上限/)).toBeTruthy() })
    expect((view.getByRole('button', { name: zh['team.downloadChosen'] }) as HTMLButtonElement).disabled).toBe(true)
    await surface.dispose()
  })

  it('takes the unattributed files out when a preset is asked for', async () => {
    stubFetch({
      [STATUS]: memberStatus,
      [`GET ${EXPORT}`]: () => Response.json({
        project: 'P',
        products: [
          { path: 'work/mine.txt', bytes: 3, sessionId: 'session-1', member: 'p-alpha', turn: 1, producedAt: '2026-01-01T00:00:00.000Z' },
          { path: 'work/orphan.txt', bytes: 4, sessionId: null, member: null, turn: null, producedAt: '2026-01-01T00:00:00.000Z' },
        ],
        empty: false,
        limits: { blobMax: 1024, archiveMax: 1024, fileMax: 1024 },
      }),
    })
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)

    fireEvent.click(view.getByRole('button', { name: zh['team.download'] }))
    await waitFor(() => { expect(view.getByLabelText('work/orphan.txt')).toBeTruthy() })
    expect((view.getByLabelText('work/orphan.txt') as HTMLInputElement).checked).toBe(true)
    expect(view.getByText(zh['team.presetNote'])).toBeTruthy()

    // A preset narrows to what a turn can claim; the file no turn can claim is
    // left out, which the note above it already said.
    fireEvent.click(view.getByRole('button', { name: zh['team.presetMine'] }))
    expect((view.getByLabelText('work/mine.txt') as HTMLInputElement).checked).toBe(true)
    expect((view.getByLabelText('work/orphan.txt') as HTMLInputElement).checked).toBe(false)
    await surface.dispose()
  })

  it('saves the selection it showed, not what the list says now', async () => {
    const answers: Record<string, () => Response> = {
      [STATUS]: memberStatus,
      [`GET ${EXPORT}`]: () => Response.json({
        project: 'P',
        products: [
          { path: 'work/a.txt', bytes: 3, sessionId: 'session-1', member: 'p-alpha', turn: 1, producedAt: '2026-01-01T00:00:00.000Z' },
          { path: 'work/b.txt', bytes: 4, sessionId: 'session-1', member: 'p-alpha', turn: 2, producedAt: '2026-01-01T00:00:00.000Z' },
        ],
        empty: false,
        limits: { blobMax: 1024, archiveMax: 1024, fileMax: 1024 },
      }),
      [`POST ${EXPORT}`]: () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'x-team-export-files': '2' },
      }),
    }
    const { calls } = stubFetch(answers)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface)

    fireEvent.click(view.getByRole('button', { name: zh['team.download'] }))
    await waitFor(() => { expect(view.getByLabelText('work/b.txt')).toBeTruthy() })

    // The project produces one more file while the panel is open. The panel is a
    // snapshot: the new file is not selected behind the member's back, because
    // the package has to be the one they looked at.
    answers[`GET ${EXPORT}`] = () => Response.json({
      project: 'P',
      products: [
        { path: 'work/a.txt', bytes: 3, sessionId: 'session-1', member: 'p-alpha', turn: 1, producedAt: '2026-01-01T00:00:00.000Z' },
        { path: 'work/b.txt', bytes: 4, sessionId: 'session-1', member: 'p-alpha', turn: 2, producedAt: '2026-01-01T00:00:00.000Z' },
        { path: 'work/late.txt', bytes: 5, sessionId: 'session-1', member: 'p-alpha', turn: 3, producedAt: '2026-01-01T00:00:00.000Z' },
      ],
      empty: false,
      limits: { blobMax: 1024, archiveMax: 1024, fileMax: 1024 },
    })
    fireEvent.click(view.getByRole('button', { name: zh['team.downloadChosen'] }))
    await waitFor(() => { expect(view.getByRole('status').textContent).toContain('已获取 2 个文件') })

    const posted = calls.find(call => call.init?.method === 'POST' && call.url.includes('form=zip'))
    expect(posted?.init?.body).toBe('path=work%2Fa.txt&path=work%2Fb.txt')
    await surface.dispose()
  })

  it('says which rule refused a hand-over, in the reader’s language', async () => {
    stubFetch({
      [STATUS]: memberStatus,
      [`GET ${HANDOVER}`]: () => Response.json({
        sessionId: 'session-1', driven: true, controller: 'p-alpha', idleMs: 0,
        requiredIdleMs: 900_000, pending: false, mayTakeOver: false,
      }),
      [HANDOVER]: () => Response.json({ ok: false, reason: 'not-controller', controller: 'p-bravo', error: 'hand-over-refused' }, { status: 409 }),
    })
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface, 'session-1', en)
    fireEvent.click(view.getByRole('button', { name: en['team.control'] }))
    await waitFor(() => { expect(view.getByRole('menuitem', { name: 'Hand to bravo' })).toBeTruthy() })
    fireEvent.click(view.getByRole('menuitem', { name: 'Hand to bravo' }))
    await waitFor(() => { expect(view.getByRole('status').textContent).toBe(en['team.notController']) })
    await surface.dispose()
  })

  it('says a conversation has produced nothing rather than saving an error', async () => {
    stubFetch({
      [STATUS]: memberStatus,
      [EXPORT]: () => Response.json({ error: 'export-refused', reason: 'nothing-produced' }, { status: 404 }),
    })
    const surface = new TeamSurface()
    await surface.load()
    const view = renderControls(surface, 'session-1', en)
    fireEvent.click(view.getByRole('button', { name: en['team.download'] }))
    await waitFor(() => { expect(view.getByRole('status').textContent).toBe(en['team.nothingProduced']) })
    await surface.dispose()
  })
})

describe('plugin registration', () => {
  it('registers the team entry and fiber disposal removes it', async () => {
    stubFetch({ [STATUS]: memberStatus })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    // The plugin injects `uiConversation` for the turn-tail registration, so a
    // tree without it would leave this whole fiber waiting and register nothing.
    new UiConversation(ctx, { binding: () => undefined } as never)
    ctx.slots.register({
      name: 'root',
      children: {
        'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
        'tool.call.toolview': { kind: 'keyed', scope: 'session' },
        // Where the team controls live: the session header, so a first turn
        // blocked on an approval still has them.
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    ctx.provide('remote', { $on: () => () => {}, $host: { home: undefined, isLoopback: false } } as never)
    ctx.provide('remote.session', {} as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entries = ctx.slots.entries('conversation.session.header.actions')
    expect(entries).toHaveLength(1)
    expect((entries[0] as unknown as { options?: { id?: string } }).options?.id).toBe('team-surface')
    const face = entries[0]!.inject!(SessionId('session-1') as never) as unknown as TeamSurfaceInjected
    await waitFor(() => { expect(face.hooks.team.getSnapshot().status).toBe('member') })

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
  })
})
