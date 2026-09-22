/**
 * The team controls beside one conversation's title: save a chosen part of what
 * the conversation's project produced, and decide who speaks for it.
 *
 * Both controls are shown only to a member of a shared deployment — a
 * single-operator instance renders nothing at all, because its Host has no team
 * route to answer with. Neither control is a write to the conversation: handing
 * over, releasing, and taking over are the only gestures here that change who
 * may speak, and the Host admits each by its own rule.
 *
 * They live in the **session header**, not beside a finished reply, because the
 * moment a takeover is most needed is the moment there is no finished reply: a
 * first turn blocked on an approval, its holder gone. An entry attached to a
 * message row would simply not exist there.
 *
 * @module @deepseek-ai/dsh-client-ui-deliverables/client/TeamSurfaceActions
 */

import { useCallback, useEffect, useState } from 'react'
import { IconDownloadOutline16, IconShareOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge that declares this slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type {
  TeamControlState, TeamDownloadResult, TeamHandOverResult, TeamLayout, TeamManifest, TeamProduct, TeamScope,
  TeamTakeOverResult, TeamView,
} from './team-surface.ts'
import css from './TeamSurfaceActions.module.css'

/** Injected business face of the team controls: the reads, and the gestures. */
export interface TeamSurfaceInjected {
  hooks: {
    /** What this page knows about the deployment, shared by every header. */
    team: HostObservable<TeamView>
  }
  /** Read what this conversation's project has produced. */
  readManifest: (scope: TeamScope) => Promise<TeamManifest>
  /** Save the chosen part of it. */
  downloadSelection: (paths: readonly string[]) => Promise<TeamDownloadResult>
  /** Save one file. */
  downloadFile: (path: string) => Promise<TeamDownloadResult>
  /** Read who drives this conversation, and whether it can be taken over. */
  readControl: () => Promise<TeamControlState | undefined>
  /** Take this conversation over from a holder who has been idle long enough. */
  takeOver: () => Promise<TeamTakeOverResult>
  /** Hand this conversation's control to a member, or release it. */
  handOver: (to?: string) => Promise<TeamHandOverResult>
}

/** Full props of one team-controls entry. */
export type TeamSurfaceActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<TeamSurfaceInjected>
  & PropsLocale<typeof NS>

/** Which panel is open, if any. */
type Panel = 'none' | 'files' | 'control'

/** Milliseconds as a short human size. */
function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Whole minutes remaining, rounded up, never negative. */
function minutesLeft(ms: number): number {
  return Math.max(0, Math.ceil(ms / 60_000))
}

/** The reader's own language, applied to one refusal reason. */
function reasonText(reason: string, t: (key: never, params?: never) => string): string {
  const key = `team.reason.${reason}`
  const text = (t as unknown as (name: string) => string | undefined)(key)
  return typeof text === 'string' ? text : (t as unknown as (name: string) => string)('team.reason.refused')
}

/** What the layout probe says, as the sentences a member can act on. */
function layoutNotes(layout: TeamLayout, t: (key: never, params?: never) => string): readonly string[] {
  const say = t as unknown as (name: string, params?: Record<string, string>) => string
  const notes: string[] = []
  if (layout.location !== 'project') notes.push(say('team.layout.notProject'))
  if (layout.missing.length > 0) notes.push(say('team.layout.missing', { names: layout.missing.join(', ') }))
  if (layout.conflicts.length > 0) {
    notes.push(say('team.layout.conflict', { names: layout.conflicts.map(conflict => conflict.name).join(', ') }))
  }
  return notes
}

/**
 * Render the team controls for one conversation's header.
 * @param props - the injected reads and gestures, and the localized copy.
 * @returns the two controls, or nothing outside a shared deployment.
 */
export function TeamSurfaceActions({
  sessionId, useTeam, readManifest, downloadSelection, downloadFile, readControl, takeOver, handOver, t,
}: TeamSurfaceActionProps) {
  const say = t as unknown as (name: string, params?: Record<string, string>) => string
  const view = useTeam(value => value)
  const [panel, setPanel] = useState<Panel>('none')
  const [manifest, setManifest] = useState<TeamManifest | null>(null)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [control, setControl] = useState<TeamControlState | null>(null)
  const [readAt, setReadAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [, tick] = useState(0)

  // The idle window elapses with no traffic at all, so a page that never
  // re-rendered would keep the takeover button disabled past the moment it
  // became possible. Ticking while the panel is open is what keeps the offer
  // honest; the Host still decides when the request arrives.
  useEffect(() => {
    if (panel !== 'control') return
    const timer = setInterval(() => { tick(value => value + 1) }, 15_000)
    return () => { clearInterval(timer) }
  }, [panel])

  const loadFiles = useCallback(() => {
    setBusy(true)
    setNotice(null)
    void readManifest('all').then((result) => {
      setBusy(false)
      setManifest(result)
      // Everything is selected to begin with: a package that silently left files
      // out is worse than one that is too big to make, because nobody counts the
      // entries of a ZIP before sending it on.
      setChosen(result.ok ? new Set(result.products.map(product => product.path)) : new Set<string>())
    })
  }, [readManifest])

  // Deliberately does not clear the notice: this runs right after a gesture that
  // just reported its outcome, and wiping that message would leave a member who
  // handed a conversation over looking at a panel that says nothing happened.
  const loadControl = useCallback(() => {
    void readControl().then((state) => {
      setControl(state ?? null)
      setReadAt(Date.now())
    })
  }, [readControl])

  const openFiles = useCallback(() => {
    setPanel(current => (current === 'files' ? 'none' : 'files'))
    loadFiles()
  }, [loadFiles])

  const openControl = useCallback(() => {
    setPanel(current => (current === 'control' ? 'none' : 'control'))
    loadControl()
  }, [loadControl])

  const save = useCallback(() => {
    if (manifest?.ok !== true) return
    setBusy(true)
    setNotice(null)
    void downloadSelection([...chosen]).then((result) => {
      setBusy(false)
      setNotice(savedNotice(result, say))
    })
  }, [chosen, downloadSelection, manifest, say])

  const saveOne = useCallback((path: string) => {
    setNotice(null)
    void downloadFile(path).then((result) => { setNotice(savedNotice(result, say)) })
  }, [downloadFile, say])

  const give = useCallback((to?: string) => {
    setPending(true)
    setNotice(null)
    void handOver(to).then((result) => {
      setPending(false)
      if (result.ok) {
        setNotice(say('team.moved'))
        loadControl()
        return
      }
      // The Host's refusal says which rule was hit; each is a different thing for
      // the member to do next, so they do not collapse into one message.
      if (result.reason === 'not-controller') setNotice(say('team.notController'))
      else if (result.reason === 'not-driven') setNotice(say('team.notDriven'))
      else setNotice(say('team.handOverFailed'))
    })
  }, [handOver, loadControl, say])

  const take = useCallback(() => {
    setPending(true)
    setNotice(null)
    void takeOver().then((result) => {
      setPending(false)
      if (result.ok) {
        setNotice(say('team.takenOver'))
        loadControl()
        return
      }
      if (result.reason === 'not-idle') {
        // The refusal carries the clock it was made against, which is newer than
        // the answer this panel read a moment ago.
        setControl(current => current === null ? current : {
          ...current,
          idleMs: result.idleMs ?? current.idleMs,
          requiredIdleMs: result.requiredIdleMs ?? current.requiredIdleMs,
          mayTakeOver: false,
        })
        setReadAt(Date.now())
        setNotice(say('team.notIdle'))
        return
      }
      setNotice(reasonText(result.reason, t))
    })
  }, [loadControl, say, t, takeOver])

  // Not a member means not this deployment: no control can succeed, so none is shown.
  if (view.status !== 'member') return null
  const others = view.members.filter(member => member.userId !== view.userId)
  const products = manifest?.ok === true ? manifest.products : []
  const idleNow = control === null ? 0 : control.idleMs + (Date.now() - readAt)
  const canTakeOver = control !== null
    && (control.mayTakeOver || idleNow >= control.requiredIdleMs)
  const totalBytes = products.reduce((sum, product) => chosen.has(product.path) ? sum + product.bytes : sum, 0)
  const overBudget = manifest?.ok === true && totalBytes > manifest.limits.blobMax

  return (
    <span className={css.root} data-team-actions>
      <Tooltip label={say('team.download')} side="bottom">
        <button
          type="button"
          className={css.action}
          aria-label={say('team.download')}
          aria-expanded={panel === 'files'}
          data-open={panel === 'files' || undefined}
          onClick={openFiles}
        >
          <IconDownloadOutline16 />
        </button>
      </Tooltip>
      <Tooltip label={say('team.control')} side="bottom">
        <button
          type="button"
          className={css.action}
          aria-label={say('team.control')}
          aria-expanded={panel === 'control'}
          data-open={panel === 'control' || undefined}
          onClick={openControl}
        >
          <IconShareOutline16 />
        </button>
      </Tooltip>

      {panel === 'files' && <span className={css.menu} role="dialog" aria-label={say('team.files')}>
        {busy && <span className={css.item} role="status">{say('team.saving')}</span>}
        {manifest !== null && !manifest.ok && (
          <span className={css.item} role="status">{reasonText(manifest.reason, t)}</span>
        )}
        {manifest?.ok === true && manifest.layout !== undefined
          && layoutNotes(manifest.layout, t).map(note => (
            <span key={note} className={css.item} role="note">{note}</span>
          ))}
        {manifest?.ok === true && products.length === 0
          && <span className={css.item}>{say('team.nothingProduced')}</span>}
        {manifest?.ok === true && products.map(product => (
          <span key={product.path} className={css.row} data-file={product.path}>
            <label>
              <input
                type="checkbox"
                checked={chosen.has(product.path)}
                aria-label={product.path}
                onChange={() => {
                  setChosen((previous) => {
                    const next = new Set(previous)
                    if (next.has(product.path)) next.delete(product.path)
                    else next.add(product.path)
                    return next
                  })
                }}
              />
              {product.path}
              {' · '}{size(product.bytes)}
              {' · '}{attributionOf(product, view.userId, view.members, say)}
            </label>
            <button
              type="button"
              className={css.item}
              aria-label={say('team.single', { name: product.path })}
              onClick={() => { saveOne(product.path) }}
            >
              {say('team.one')}
            </button>
          </span>
        ))}
        {manifest?.ok === true && <>
          <span className={css.item}>{say('team.filesHint')}</span>
          <button type="button" className={css.item} onClick={loadFiles}>{say('team.refresh')}</button>
          <button
            type="button"
            className={css.item}
            onClick={() => { setChosen(new Set(products.map(product => product.path))) }}
          >
            {say('team.selectAll')}
          </button>
          <button type="button" className={css.item} onClick={() => { setChosen(new Set<string>()) }}>
            {say('team.selectNone')}
          </button>
          <button
            type="button"
            className={css.item}
            onClick={() => {
              setChosen(new Set(products.filter(product => product.sessionId === sessionId).map(product => product.path)))
            }}
          >
            {say('team.presetMine')}
          </button>
          <button
            type="button"
            className={css.item}
            onClick={() => { setChosen(new Set(latestTurnPaths(products))) }}
          >
            {say('team.presetLatest')}
          </button>
          <span className={css.item}>{say('team.presetNote')}</span>
          <span className={css.item}>
            {say('team.total', { count: String(chosen.size), size: size(totalBytes) })}
          </span>
          <span className={css.item}>{say('team.limit', { size: size(manifest.limits.blobMax) })}</span>
          {overBudget && <span className={css.item} role="alert">
            {say('team.overBlob', { size: size(manifest.limits.blobMax) })}
          </span>}
          <button
            type="button"
            className={css.item}
            disabled={busy || chosen.size === 0 || overBudget}
            onClick={save}
          >
            {say('team.downloadChosen')}
          </button>
        </>}
      </span>}

      {panel === 'control' && <span className={css.menu} role="dialog" aria-label={say('team.control')}>
        {control === null && <span className={css.item} role="status">{say('team.controlUnreadable')}</span>}
        {control !== null && !control.driven && <span className={css.item}>{say('team.unheld')}</span>}
        {control !== null && control.driven && <>
          <span className={css.item}>
            {say('team.drivenBy', {
              name: nameOf(control.controller, view.members),
              minutes: String(Math.floor(idleNow / 60_000)),
            })}
          </span>
          {control.pending && <span className={css.item} role="note">{say('team.pendingNote')}</span>}
          {control.controller === view.userId
            ? <>
              {others.map(member => (
                <button
                  key={member.userId}
                  type="button"
                  role="menuitem"
                  className={css.item}
                  disabled={pending}
                  onClick={() => { give(member.userId) }}
                >
                  {say('team.giveTo', { name: member.name })}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className={css.item}
                disabled={pending}
                onClick={() => { give() }}
              >
                {say('team.release')}
              </button>
            </>
            : <button
              type="button"
              role="menuitem"
              className={css.item}
              disabled={pending || !canTakeOver}
              onClick={take}
            >
              {canTakeOver
                ? say('team.takeOver')
                : say('team.waitToTakeOver', {
                  minutes: String(minutesLeft((control.requiredIdleMs ?? 0) - idleNow)),
                })}
            </button>}
        </>}
        <button type="button" className={css.item} onClick={loadControl}>{say('team.controlRefresh')}</button>
      </span>}

      {notice !== null && <span className={css.notice} role="status">{notice}</span>}
    </span>
  )
}

/** The paths of each conversation's newest turn that still has files. */
function latestTurnPaths(products: readonly TeamProduct[]): readonly string[] {
  const newest = new Map<string, number>()
  for (const product of products) {
    if (product.sessionId === null || product.turn === null) continue
    newest.set(product.sessionId, Math.max(newest.get(product.sessionId) ?? 0, product.turn))
  }
  return products
    .filter(product => product.sessionId !== null
      && product.turn !== null
      && newest.get(product.sessionId) === product.turn)
    .map(product => product.path)
}

/** How one file is attributed, in the reader's language. */
function attributionOf(
  product: TeamProduct,
  self: string,
  members: readonly { readonly userId: string; readonly name: string }[],
  say: (name: string, params?: Record<string, string>) => string,
): string {
  if (product.sessionId === null) return say('team.attribution.none')
  const who = product.sessionId === self ? say('team.attribution.mine') : nameOf(product.member ?? undefined, members)
  return product.turn === null ? who : say('team.attribution.turn', { who, turn: String(product.turn) })
}

/** A member id as the roster spells it, falling back to the id itself. */
function nameOf(userId: string | undefined, members: readonly { readonly userId: string; readonly name: string }[]): string {
  if (userId === undefined) return ''
  return members.find(member => member.userId === userId)?.name ?? userId
}

/** What a finished download says, or why there is none. */
function savedNotice(result: TeamDownloadResult, say: (name: string, params?: Record<string, string>) => string): string {
  if (result.ok) return say('team.saved', { count: String(result.files), size: size(result.bytes) })
  const reason = say(`team.reason.${result.reason}`) || say('team.reason.refused')
  return result.missing === undefined || result.missing.length === 0
    ? reason
    : `${reason} ${say('team.missing', { count: String(result.missing.length), names: result.missing.join(', ') })}`
}
