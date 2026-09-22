/**
 * Team identity: membership matching, token lifetime and revocation, cookie
 * binding, and the HTTP surface the browser page actually signs in through.
 *
 * The tests drive the real service against a temporary harness home, so
 * persistence and revocation are exercised through the on-disk registry rather
 * than through an in-memory stand-in.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEAM_EXPORT_PATH, TEAM_HANDOVER_PATH, TEAM_IDENTITY_PATH, handleTeamIdentityHttp } from '../src/http-route.ts'
import { TeamIdentity } from '../src/service.ts'
import { TEAM_IDENTITY_FILE_NAME, type TeamMember } from '../src/registry.ts'

const homes: string[] = []

function home(): string {
  const created = mkdtempSync(join(tmpdir(), 'dsh-team-identity-'))
  homes.push(created)
  return created
}

afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const AUTHORITY = 'dsh.internal:3080'

const DEFAULT_MEMBERS: readonly TeamMember[] = [
  { userId: 'u-alice', name: '爱丽丝', signInCode: 'alice-code' },
  { userId: 'u-bob', name: '鲍勃', alternateSignInCode: 'shared-code' },
]

async function mounted(options: {
  readonly ttlMs?: number
  readonly limit?: number
  readonly directory?: string
  readonly members?: readonly TeamMember[]
} = {}): Promise<{ readonly identity: TeamIdentity; readonly dispose: () => Promise<void> }> {
  const ctx = new Context()
  let identity!: TeamIdentity
  const fiber = ctx.plugin((pluginCtx) => {
    identity = new TeamIdentity(
      pluginCtx,
      options.members ?? DEFAULT_MEMBERS,
      options.ttlMs ?? 60_000,
      options.limit ?? 200,
      options.directory ?? home(),
    )
  })
  // Plugin callbacks run when the fiber settles, not when it is created.
  await fiber.await()
  return { identity, dispose: () => fiber.dispose() }
}

function signInRequest(body: unknown, authority = AUTHORITY): Request {
  return new Request(`http://${authority}${TEAM_IDENTITY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: authority },
    body: JSON.stringify(body),
  })
}

function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie')
  if (header === null) throw new Error('expected a Set-Cookie header')
  return header.split(';', 1)[0] as string
}

function withCookie(cookie: string, authority = AUTHORITY): Headers {
  return new Headers({ host: authority, cookie })
}

describe('team sign-in', () => {
  it('mints a cookie for a personal code and resolves the member from it', async () => {
    const { identity, dispose } = await mounted()
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ signedIn: true, userId: 'u-alice' })

    const headers = withCookie(cookieOf(response))
    expect(identity.resolve(headers)).toMatchObject({ userId: 'u-alice', actorType: 'user' })
    await dispose()
  })

  it('admits a member who only holds the shared code', async () => {
    const { identity, dispose } = await mounted()
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '鲍勃', code: 'shared-code' }))
    expect(response.status).toBe(200)
    expect(identity.resolve(withCookie(cookieOf(response)))?.userId).toBe('u-bob')
    await dispose()
  })

  it('refuses a wrong code and an unknown name without saying which', async () => {
    const { identity, dispose } = await mounted()
    const wrongCode = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'nope' }))
    const unknownName = await handleTeamIdentityHttp(identity, signInRequest({ name: '陌生人', code: 'alice-code' }))
    expect(wrongCode.status).toBe(401)
    expect(unknownName.status).toBe(401)
    expect(wrongCode.headers.get('set-cookie')).toBeNull()
    expect(unknownName.headers.get('set-cookie')).toBeNull()
    await dispose()
  })

  it('admits nobody when the roster is empty', async () => {
    const { identity, dispose } = await mounted({ members: [] })
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    expect(response.status).toBe(401)
    await dispose()
  })

  it('rejects a malformed body and a non-JSON content type', async () => {
    const { identity, dispose } = await mounted()
    expect((await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝' }))).status).toBe(400)
    const form = new Request(`http://${AUTHORITY}${TEAM_IDENTITY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: AUTHORITY },
      body: 'name=x&code=y',
    })
    expect((await handleTeamIdentityHttp(identity, form)).status).toBe(400)
    await dispose()
  })

  it('reports signed-in state over GET without a session', async () => {
    const { identity, dispose } = await mounted()
    const anonymous = await handleTeamIdentityHttp(identity, new Request(
      `http://${AUTHORITY}${TEAM_IDENTITY_PATH}`,
      { headers: { host: AUTHORITY } },
    ))
    await expect(anonymous.json()).resolves.toEqual({ signedIn: false })

    const signedIn = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const status = await handleTeamIdentityHttp(identity, new Request(
      `http://${AUTHORITY}${TEAM_IDENTITY_PATH}`,
      { headers: withCookie(cookieOf(signedIn)) },
    ))
    await expect(status.json()).resolves.toEqual({
      signedIn: true,
      userId: 'u-alice',
      // Who a conversation can be handed to, without anyone's sign-in code.
      members: [{ userId: 'u-alice', name: '爱丽丝' }, { userId: 'u-bob', name: '鲍勃' }],
    })
    await dispose()
  })
})

describe('team cookie binding', () => {
  it('does not resolve for another authority', async () => {
    const { identity, dispose } = await mounted()
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    // The cookie name is derived from the authority, so another host cannot even
    // find it, and the payload would not match if it did.
    expect(identity.resolve(withCookie(cookieOf(response), 'other.internal:3080'))).toBeUndefined()
    await dispose()
  })

  it('rejects a tampered cookie value', async () => {
    const { identity, dispose } = await mounted()
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const cookie = cookieOf(response)
    const [name, value] = cookie.split('=', 2) as [string, string]
    const tampered = `${name}=${value.slice(0, -2)}xx`
    expect(identity.resolve(withCookie(tampered))).toBeUndefined()
    await dispose()
  })

  it('rejects a cookie signed by another harness home', async () => {
    const first = await mounted()
    const response = await handleTeamIdentityHttp(first.identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const cookie = cookieOf(response)
    await first.dispose()

    // Same members, different home: the signing secret differs, so the token id
    // in the cookie is worthless even though the registry can be read again.
    const second = await mounted()
    expect(second.identity.resolve(withCookie(cookie))).toBeUndefined()
    await second.dispose()
  })

  it('rejects an expired token', async () => {
    const { identity, dispose } = await mounted({ ttlMs: -1 })
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    // Issued already expired, so the registry drops it before it can be used.
    expect(identity.resolve(withCookie(cookieOf(response)))).toBeUndefined()
    await dispose()
  })
})

describe('handing control over', () => {
  const alice = { userId: 'u-alice', tokenId: 't-a', actorType: 'user' } as const
  const bob = { userId: 'u-bob', tokenId: 't-b', actorType: 'user' } as const
  const aliceSession = { userId: 'u-alice', tokenId: 't-a', expiresAt: 0 }

  it('moves control to another declared member at the controller’s request', async () => {
    const { identity, dispose } = await mounted()
    identity.control.decide('s-1', alice)
    expect(identity.handOver('s-1', aliceSession, 'u-bob')).toEqual({ ok: true, controller: 'u-bob' })
    expect(identity.control.controllerOf('s-1')).toEqual({ userId: 'u-bob', tokenId: '', actorType: 'user' })
    await dispose()
  })

  it('refuses a member who is not driving the conversation', async () => {
    const { identity, dispose } = await mounted()
    identity.control.decide('s-1', alice)
    // A rule that let anyone take control would be no rule at all.
    expect(identity.handOver('s-1', { userId: 'u-bob', tokenId: 't-b', expiresAt: 0 }))
      .toEqual({ ok: false, reason: 'not-controller', controller: 'u-alice' })
    expect(identity.control.controllerOf('s-1')).toEqual(alice)
    await dispose()
  })

  it('releases control when no recipient is named', async () => {
    const { identity, dispose } = await mounted()
    identity.control.decide('s-1', alice)
    expect(identity.handOver('s-1', aliceSession)).toEqual({ ok: true })
    expect(identity.control.controllerOf('s-1')).toBeUndefined()
    // Released, so the next writer takes it rather than waiting out a lease.
    expect(identity.control.decide('s-1', bob).allowed).toBe(true)
    await dispose()
  })

  it('treats handing control to yourself as a release', async () => {
    const { identity, dispose } = await mounted()
    identity.control.decide('s-1', alice)
    expect(identity.handOver('s-1', aliceSession, 'u-alice')).toEqual({ ok: true })
    expect(identity.control.controllerOf('s-1')).toBeUndefined()
    await dispose()
  })

  it('refuses a recipient who is not a member, and an undriven conversation', async () => {
    const { identity, dispose } = await mounted()
    identity.control.decide('s-1', alice)
    expect(identity.handOver('s-1', aliceSession, 'u-nobody')).toEqual({ ok: false, reason: 'no-such-member' })
    expect(identity.handOver('s-2', aliceSession)).toEqual({ ok: false, reason: 'not-driven' })
    await dispose()
  })

  it('resolves the caller from their own cookie, never from the body', async () => {
    const { identity, dispose } = await mounted()
    const signedIn = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const cookie = cookieOf(signedIn)
    identity.control.decide('s-1', alice)

    const refused = await handleTeamIdentityHttp(identity, new Request(
      `http://${AUTHORITY}${TEAM_HANDOVER_PATH}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-1' }) },
    ))
    expect(refused.status).toBe(401)

    const moved = await handleTeamIdentityHttp(identity, new Request(
      `http://${AUTHORITY}${TEAM_HANDOVER_PATH}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: AUTHORITY, cookie },
        body: JSON.stringify({ sessionId: 's-1', to: 'u-bob' }),
      },
    ))
    expect(moved.status).toBe(200)
    expect(await moved.json()).toEqual({ handedOver: true, controller: 'u-bob' })
    await dispose()
  })
})

describe('handing a produced file back', () => {
  /** A workspace with a `work\` file, an `input\` file, and a session that owns it. */
  async function workspace(): Promise<{
    identity: TeamIdentity
    directory: string
    dispose: () => Promise<void>
  }> {
    const directory = mkdtempSync(join(home(), 'ws-'))
    mkdirSync(join(directory, 'work'), { recursive: true })
    mkdirSync(join(directory, 'input'), { recursive: true })
    writeFileSync(join(directory, 'work', '报告 2026Q1.txt'), 'produced')
    writeFileSync(join(directory, 'input', 'raw.csv'), 'somebody else\'s data')
    const ctx = new Context()
    // Stand in for the Session store: the workspace comes from the conversation,
    // never from the request.
    ctx.provide('sessions', {
      get: (id: string) => (id === 's-1' ? { header: { cwd: directory } } : undefined),
    } as never)
    let identity!: TeamIdentity
    const fiber = ctx.plugin((pluginCtx) => {
      identity = new TeamIdentity(pluginCtx, DEFAULT_MEMBERS, 60_000, 200, home())
    })
    await fiber.await()
    return { identity, directory, dispose: () => fiber.dispose() }
  }

  it('reads a file out of the conversation’s work directory', async () => {
    const fixture = await workspace()
    const file = await fixture.identity.exportFile('s-1', '报告 2026Q1.txt')
    expect(file).toMatchObject({ ok: true, name: '报告 2026Q1.txt' })
    expect(file.ok && file.bytes.toString('utf8')).toBe('produced')
    await fixture.dispose()
  })

  it('refuses every directory but work, however the path is spelled', async () => {
    const fixture = await workspace()
    for (const relative of ['../input/raw.csv', '..\\input\\raw.csv', join('..', 'input', 'raw.csv')]) {
      expect(await fixture.identity.exportFile('s-1', relative)).toEqual({ ok: false, reason: 'outside-work' })
    }
    // A conversation with no workspace has nothing to hand over.
    expect(await fixture.identity.exportFile('s-unknown', 'x')).toEqual({ ok: false, reason: 'unknown-session' })
    await fixture.dispose()
  })

  it('refuses a directory and a path that is not there', async () => {
    const fixture = await workspace()
    expect(await fixture.identity.exportFile('s-1', '.')).toEqual({ ok: false, reason: 'unreadable' })
    expect(await fixture.identity.exportFile('s-1', 'missing.txt')).toEqual({ ok: false, reason: 'unreadable' })
    await fixture.dispose()
  })

  it('packages the conversation’s work directory and nothing else', async () => {
    const fixture = await workspace()
    fixture.identity.recordPrompt('s-1', 'u-alice')
    writeFileSync(join(fixture.directory, 'work', 'later 报告.txt'), 'second turn')

    const archive = await fixture.identity.exportArchive('s-1')
    expect(archive).toMatchObject({ ok: true, products: 2 })
    if (!archive.ok) throw new Error('expected an archive')
    // The inner structure mirrors the server: `work/…`, `/`-separated, and no
    // entry from `input\` — the tree a member may read is the tree they receive.
    expect(archive.bytes.includes(Buffer.from('work/报告 2026Q1.txt', 'utf8'))).toBe(true)
    expect(archive.bytes.includes(Buffer.from('work/later 报告.txt', 'utf8'))).toBe(true)
    expect(archive.bytes.includes(Buffer.from('input/', 'utf8'))).toBe(false)
    expect(archive.bytes.includes(Buffer.from('raw.csv', 'utf8'))).toBe(false)
    expect(archive.name.endsWith('.zip')).toBe(true)
    // Packaging is a read: it must not claim the conversation for the caller.
    expect(fixture.identity.control.controllerOf('s-1')).toBeUndefined()
    await fixture.dispose()
  })

  it('refuses to package a project that has produced nothing yet', async () => {
    const fixture = await workspace()
    rmSync(join(fixture.directory, 'work', '报告 2026Q1.txt'))
    expect(await fixture.identity.exportArchive('s-1')).toEqual({ ok: false, reason: 'nothing-produced' })
    // And an unknown conversation is a different refusal from an empty one.
    expect(await fixture.identity.exportArchive('s-unknown')).toEqual({ ok: false, reason: 'unknown-session' })
    await fixture.dispose()
  })

  it('lists what was produced, and which turn produced it', async () => {
    const fixture = await workspace()
    // A file time can land a millisecond or two after the `Date.now()` that
    // follows it, so records written in the same instant are not ordered by this
    // mechanism. Real prompts are seconds apart; the test gives them that room.
    const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25))
    fixture.identity.recordPrompt('s-1', 'u-alice')
    await settle()
    writeFileSync(join(fixture.directory, 'work', 'later 报告.txt'), 'second turn')
    await settle()
    fixture.identity.recordPrompt('s-1', 'u-bob')
    await settle()
    writeFileSync(join(fixture.directory, 'work', '图表 销量.png'), 'chart')

    const manifest = await fixture.identity.manifest('s-1')
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) throw new Error('expected a manifest')
    const byPath = new Map(manifest.products.map(product => [product.path, product]))
    expect(byPath.get('work/later 报告.txt')).toMatchObject({ member: 'u-alice', turn: 1 })
    expect(byPath.get('work/图表 销量.png')).toMatchObject({ member: 'u-bob', turn: 2 })
    // Written before any recorded turn, so it is reported as unattributed rather
    // than credited to whoever happens to be first.
    expect(byPath.get('work/报告 2026Q1.txt')).toMatchObject({ member: null, turn: null })

    // `latest` keeps the conversation's newest turn only.
    const latest = await fixture.identity.manifest('s-1', 'latest')
    expect(latest.ok).toBe(true)
    expect(latest.ok && latest.products.map(product => product.path)).toEqual(['work/图表 销量.png'])
    await fixture.dispose()
  })

  it('serves the manifest and the archive over one route, and neither without a member', async () => {
    const fixture = await workspace()
    const signedIn = await handleTeamIdentityHttp(fixture.identity, signInRequest({ name: '鲍勃', code: 'shared-code' }))
    const cookie = cookieOf(signedIn)
    const exportUrl = (query: string): string => `http://${AUTHORITY}${TEAM_EXPORT_PATH}?${query}`

    const anonymous = await handleTeamIdentityHttp(fixture.identity, new Request(exportUrl('sessionId=s-1&form=zip')))
    expect(anonymous.status).toBe(401)

    const manifest = await handleTeamIdentityHttp(fixture.identity, new Request(
      exportUrl('sessionId=s-1&form=manifest'),
      { headers: { host: AUTHORITY, cookie } },
    ))
    expect(manifest.status).toBe(200)
    await expect(manifest.json()).resolves.toMatchObject({
      sessionId: 's-1',
      scope: 'all',
      products: [expect.objectContaining({ path: 'work/报告 2026Q1.txt' })],
    })

    const archive = await handleTeamIdentityHttp(fixture.identity, new Request(
      exportUrl('sessionId=s-1&form=zip'),
      { headers: { host: AUTHORITY, cookie } },
    ))
    expect(archive.status).toBe(200)
    expect(archive.headers.get('content-type')).toBe('application/zip')
    expect(archive.headers.get('content-disposition')).toContain('attachment;')
    expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(0)

    const unknown = await handleTeamIdentityHttp(fixture.identity, new Request(
      exportUrl('sessionId=s-1&form=tar'),
      { headers: { host: AUTHORITY, cookie } },
    ))
    expect(unknown.status).toBe(400)
    await fixture.dispose()
  })

  it('takes a selection as a form body and says what the package holds', async () => {
    const fixture = await workspace()
    const signedIn = await handleTeamIdentityHttp(fixture.identity, signInRequest({ name: '鲍勃', code: 'shared-code' }))
    const cookie = cookieOf(signedIn)
    const url = `http://${AUTHORITY}${TEAM_EXPORT_PATH}`
    const form = { host: AUTHORITY, cookie, 'content-type': 'application/x-www-form-urlencoded' }
    const query = { headers: { host: AUTHORITY, cookie } }

    // The byte budgets travel with the manifest, so raising them is a Host
    // change rather than a client rebuild.
    const manifest = await handleTeamIdentityHttp(
      fixture.identity, new Request(`${url}?sessionId=s-1&form=manifest`, query),
    )
    const manifestBody = await manifest.json() as {
      readonly empty: boolean
      readonly limits: { readonly blobMax: number; readonly archiveMax: number; readonly fileMax: number }
    }
    expect(manifestBody.empty).toBe(false)
    // The budgets are the Host's decision and reach the client as numbers; the
    // exact values are the deployment's, so only their presence is asserted here.
    expect(typeof manifestBody.limits.blobMax).toBe('number')
    expect(typeof manifestBody.limits.archiveMax).toBe('number')
    expect(typeof manifestBody.limits.fileMax).toBe('number')

    const posted = await handleTeamIdentityHttp(fixture.identity, new Request(url, {
      method: 'POST',
      headers: form,
      body: new URLSearchParams([
        ['sessionId', 's-1'], ['form', 'zip'], ['path', 'work/报告 2026Q1.txt'],
      ]).toString(),
    }))
    expect(posted.status).toBe(200)
    // What was actually packed, rather than a manifest read before the files were.
    expect(posted.headers.get('x-team-export-files')).toBe('1')
    expect(Number(posted.headers.get('x-team-export-bytes'))).toBeGreaterThan(0)

    // An empty selection is refused, never read as "everything".
    const empty = await handleTeamIdentityHttp(fixture.identity, new Request(url, {
      method: 'POST',
      headers: form,
      body: new URLSearchParams([['sessionId', 's-1'], ['form', 'zip']]).toString(),
    }))
    expect(empty.status).toBe(404)
    await expect(empty.json()).resolves.toMatchObject({ reason: 'nothing-produced' })

    // A body that cannot be read is a bad request, not a silent whole project.
    const broken = await handleTeamIdentityHttp(fixture.identity, new Request(url, {
      method: 'POST',
      headers: { host: AUTHORITY, cookie, 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(broken.status).toBe(400)

    // Nothing produced yet answers 200 with `empty`, so the client can say so
    // without asking for a package it would only have to refuse.
    rmSync(join(fixture.directory, 'work', '报告 2026Q1.txt'))
    const nothing = await handleTeamIdentityHttp(
      fixture.identity, new Request(`${url}?sessionId=s-1&form=manifest`, query),
    )
    expect(nothing.status).toBe(200)
    await expect(nothing.json()).resolves.toMatchObject({ empty: true, products: [] })
    await fixture.dispose()
  })
})

describe('moving control over the route', () => {
  it('reports who drives a conversation, and takes it over only once it is idle', async () => {
    vi.useFakeTimers()
    try {
      // A token that outlives the idle window: the default here is 60 seconds,
      // and this test deliberately advances past it.
      const fixture = await mounted({ ttlMs: 30 * 24 * 60 * 60 * 1000 })
      const alice = cookieOf(await handleTeamIdentityHttp(
        fixture.identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }),
      ))
      const bob = cookieOf(await handleTeamIdentityHttp(
        fixture.identity, signInRequest({ name: '鲍勃', code: 'shared-code' }),
      ))
      const call = (method: string, cookie: string, body?: unknown): Promise<Response> =>
        handleTeamIdentityHttp(fixture.identity, new Request(
          `http://${AUTHORITY}${TEAM_HANDOVER_PATH}${method === 'GET' ? '?sessionId=s-1' : ''}`,
          {
            method,
            headers: {
              host: AUTHORITY,
              cookie,
              ...body === undefined ? {} : { 'content-type': 'application/json' },
            },
            ...body === undefined ? {} : { body: JSON.stringify(body) },
          },
        ))

      // Nobody drives it yet, so there is nothing to take over.
      await expect((await call('GET', alice)).json())
        .resolves.toMatchObject({ driven: false, mayTakeOver: true })

      fixture.identity.control.decide('s-1', { userId: 'u-alice', tokenId: 't1', actorType: 'user' })
      await expect((await call('GET', bob)).json())
        .resolves.toMatchObject({ driven: true, controller: 'u-alice', mayTakeOver: false })

      // Too soon: refused, with the clock the member needs to decide when to try.
      const early = await call('POST', bob, { sessionId: 's-1', take: true })
      expect(early.status).toBe(409)
      await expect(early.json()).resolves.toMatchObject({ error: 'take-over-refused', reason: 'not-idle' })

      vi.advanceTimersByTime(16 * 60 * 1000)
      const taken = await call('POST', bob, { sessionId: 's-1', take: true })
      expect(taken.status).toBe(200)
      await expect(taken.json()).resolves.toMatchObject({ takenOver: true, controller: 'u-bob' })
      // And the takeover is visible afterwards, which is the whole point.
      await expect((await call('GET', alice)).json())
        .resolves.toMatchObject({ controller: 'u-bob', mayTakeOver: false })
      await fixture.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('team revocation', () => {
  it('stops accepting a revoked token and emits the transport signal', async () => {
    const ctx = new Context()
    const revoked: string[] = []
    ctx.on('identity/revoked', (userId: string) => { revoked.push(userId) })
    let identity!: TeamIdentity
    const fiber = ctx.plugin((pluginCtx) => {
      identity = new TeamIdentity(
        pluginCtx,
        [{ userId: 'u-alice', name: '爱丽丝', signInCode: 'c' }],
        60_000,
        200,
        home(),
      )
    })
    await fiber.await()
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'c' }))
    const headers = withCookie(cookieOf(response))
    expect(identity.resolve(headers)?.userId).toBe('u-alice')

    expect(identity.revoke('u-alice')).toBe(1)
    expect(identity.resolve(headers)).toBeUndefined()
    expect(revoked).toEqual(['u-alice'])
    await fiber.dispose()
  })

  it('keeps other members signed in when one is disabled', async () => {
    const { identity, dispose } = await mounted()
    const alice = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const bob = await handleTeamIdentityHttp(identity, signInRequest({ name: '鲍勃', code: 'shared-code' }))
    identity.revoke('u-alice')
    expect(identity.resolve(withCookie(cookieOf(alice)))).toBeUndefined()
    expect(identity.resolve(withCookie(cookieOf(bob)))?.userId).toBe('u-bob')
    await dispose()
  })

  it('refuses a live token whose member the roster no longer declares', async () => {
    // The token table is durable and outlives any particular roster, so removing
    // someone from configuration must end what they already hold — not merely
    // stop them signing in again.
    const directory = home()
    const { identity, dispose } = await mounted({ directory })
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const headers = withCookie(cookieOf(response))
    expect(identity.resolve(headers)?.userId).toBe('u-alice')

    // Same home, smaller roster: the restart an operator's edit produces.
    const shrunk = await mounted({ directory, members: [DEFAULT_MEMBERS[1] as TeamMember] })
    expect(shrunk.identity.resolve(headers)).toBeUndefined()
    // And the refusal is durable: the stale record is gone from the file, so the
    // member cannot come back by restoring the old roster.
    const stored = JSON.parse(readFileSync(join(directory, TEAM_IDENTITY_FILE_NAME), 'utf8')) as {
      readonly tokens: readonly { readonly userId: string }[]
    }
    expect(stored.tokens.map(token => token.userId)).not.toContain('u-alice')
    await shrunk.dispose()
    await dispose()
  })

  it('reconciles a shrunk roster at boot and tells the transport which members left', async () => {
    const directory = home()
    const first = await mounted({ directory })
    await handleTeamIdentityHttp(first.identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    await handleTeamIdentityHttp(first.identity, signInRequest({ name: '鲍勃', code: 'shared-code' }))
    await first.dispose()

    const ctx = new Context()
    const revoked: string[] = []
    ctx.on('identity/revoked', (userId: string) => { revoked.push(userId) })
    const fiber = ctx.plugin((pluginCtx) => {
      new TeamIdentity(pluginCtx, [DEFAULT_MEMBERS[1] as TeamMember], 60_000, 200, directory)
    })
    await fiber.await()
    // The connection a removed member already opened will not read again, so the
    // boot-time reconcile is what reaches it.
    const identity = ctx.get('teamIdentity') as TeamIdentity
    expect(identity.reconcile()).toEqual(['u-alice'])
    expect(revoked).toEqual(['u-alice'])
    await fiber.dispose()
  })

  it('reports a registry write that fails instead of swallowing it', async () => {
    const ctx = new Context()
    const failures: unknown[] = []
    // A file standing where the registry's parent directory would go: the read
    // starts empty and every write fails.
    const blocker = join(home(), 'blocker')
    writeFileSync(blocker, 'not a directory')
    let identity!: TeamIdentity
    const fiber = ctx.plugin((pluginCtx) => {
      identity = new TeamIdentity(
        pluginCtx,
        [{ userId: 'u-alice', name: '爱丽丝', signInCode: 'c' }],
        60_000,
        200,
        blocker,
        (error) => { failures.push(error) },
      )
    })
    await fiber.await()
    // A failed write must still leave the caller working, but the operator has to
    // be able to learn that a revocation never reached the disk.
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'c' }))
    expect(identity.resolve(withCookie(cookieOf(response)))?.userId).toBe('u-alice')
    expect(failures.length).toBeGreaterThan(0)
    await fiber.dispose()
  })

  it('takes the disabled member control of their conversations with them', async () => {
    const { identity, dispose } = await mounted()
    const alice = { userId: 'u-alice', tokenId: 't1', actorType: 'user' } as const
    identity.control.decide('s-1', alice)
    expect(identity.control.controllerOf('s-1')).toEqual(alice)

    identity.revoke('u-alice')

    // Control must not outlive the tokens: a binding that survived would keep
    // routing approvals and questions to a member who can no longer answer.
    expect(identity.control.controllerOf('s-1')).toBeUndefined()
    await dispose()
  })

  it('ends the earlier session when a member signs in again', async () => {
    const { identity, dispose } = await mounted()
    const first = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const firstCookie = withCookie(cookieOf(first))
    expect(identity.resolve(firstCookie)?.userId).toBe('u-alice')

    const second = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    expect(second.status).toBe(200)

    // One member, one live session: the newest sign-in is the only one that works.
    expect(identity.resolve(firstCookie)).toBeUndefined()
    expect(identity.resolve(withCookie(cookieOf(second)))?.userId).toBe('u-alice')
    await dispose()
  })

  it('keeps other members signed in when one signs in again', async () => {
    const { identity, dispose } = await mounted()
    const alice = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const bob = await handleTeamIdentityHttp(identity, signInRequest({ name: '鲍勃', code: 'shared-code' }))

    await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))

    expect(identity.resolve(withCookie(cookieOf(alice)))).toBeUndefined()
    // A different member is a different account and is untouched.
    expect(identity.resolve(withCookie(cookieOf(bob)))?.userId).toBe('u-bob')
    await dispose()
  })

  it('releases the earlier session control when a member signs in again', async () => {
    const { identity, dispose } = await mounted()
    const first = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    expect(identity.resolve(withCookie(cookieOf(first)))?.userId).toBe('u-alice')
    identity.control.decide('s-1', { userId: 'u-alice', tokenId: 't1', actorType: 'user' })
    expect(identity.control.controllerOf('s-1')).toBeDefined()

    await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))

    // The older browser must not keep driving a conversation it can no longer
    // speak for.
    expect(identity.control.controllerOf('s-1')).toBeUndefined()
    await dispose()
  })
})

describe('team registry durability', () => {
  it('keeps issued tokens across a restart of the same home', async () => {
    const directory = home()
    const first = await mounted({ directory })
    const response = await handleTeamIdentityHttp(first.identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    const headers = withCookie(cookieOf(response))
    await first.dispose()

    const second = await mounted({ directory })
    expect(second.identity.resolve(headers)?.userId).toBe('u-alice')
    await second.dispose()
  })

  it('starts clean when the registry file is corrupt', async () => {
    const directory = home()
    writeFileSync(join(directory, TEAM_IDENTITY_FILE_NAME), '{ not json', 'utf8')
    const { identity, dispose } = await mounted({ directory })
    // A damaged registry must not prevent sign-in; it only loses old sessions.
    const response = await handleTeamIdentityHttp(identity, signInRequest({ name: '爱丽丝', code: 'alice-code' }))
    expect(response.status).toBe(200)
    expect(JSON.parse(readFileSync(join(directory, TEAM_IDENTITY_FILE_NAME), 'utf8'))).toMatchObject({
      version: 1,
    })
    await dispose()
  })

  it('caps live tokens by dropping the ones expiring soonest', async () => {
    const directory = home()
    // The cap is per deployment, not per member: signing in again ends that
    // member's earlier session, so the table only grows across distinct members.
    const members = ['a', 'b', 'c'].map(name => ({ userId: `u-${name}`, name, signInCode: 'code' }))
    const { identity, dispose } = await mounted({ directory, limit: 2, ttlMs: 60_000, members })
    for (const name of ['a', 'b', 'c']) {
      const response = await handleTeamIdentityHttp(identity, signInRequest({ name, code: 'code' }))
      expect(response.status).toBe(200)
    }
    const stored = JSON.parse(readFileSync(join(directory, TEAM_IDENTITY_FILE_NAME), 'utf8')) as {
      readonly tokens: readonly unknown[]
    }
    expect(stored.tokens).toHaveLength(2)
    await dispose()
  })
})
