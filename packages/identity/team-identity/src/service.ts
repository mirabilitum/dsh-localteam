/**
 * Team identity service: the deployment's answer to "who is calling".
 *
 * The service owns three things the transport deliberately does not: the member
 * list, the issued-token table, and the signed cookie that carries one token id.
 * It publishes itself as the Connection identity resolver, so every request the
 * transport admits resolves its caller here — and every consumer reads that
 * identity from the transport, never from a payload.
 *
 * @module @deepseek-ai/dsh-team-identity/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionSubject } from '@deepseek-ai/dsh-client-connection'
import { Service } from '@deepseek-ai/cordis'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isWithin } from './workspace-root.ts'
import {
  decodeTeamCookie,
  encodeTeamCookie,
  readCookie,
  requestAuthority,
  teamCookie,
  teamCookieName,
} from './cookie.ts'
import { ProvenanceLedger, type ProvenanceProduct, type ProvenanceScope } from './provenance.ts'
import { inspectProjectLayout, type ProjectLayoutInspection } from './project-layout.ts'
import { TEAM_IDENTITY_FILE_NAME, TeamRegistry, type PersistFailureReporter, type TeamMember, type TeamSession } from './registry.ts'
import { IDLE_BEFORE_TAKEOVER_MS, SessionControl, type ControlState, type TakeOverOutcome } from './session-control.ts'
import { ZipTooLargeError, buildZip, type ZipEntry } from './zip.ts'

/** Team identity is decided from the browser cookie, so it belongs to this set. */
export type TeamSignInOutcome =
  | { readonly ok: true; readonly session: TeamSession }
  | { readonly ok: false; readonly reason: 'name' | 'code' }

/** The one directory a member may take files out of. */
const WORK_DIRECTORY = 'work'

/**
 * Most bytes one packaged download may hold.
 *
 * The archive is assembled in memory, so an unbounded `work\` would be a way to
 * make the deployment's own process allocate whatever a member has accumulated.
 * Half a gigabyte is far above a report and its charts, and refusing is reported
 * as a refusal rather than as a failed download.
 */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

/**
 * Most bytes one single-file download may hold.
 *
 * The same ceiling as an archive, because a file larger than this could not be
 * packaged either: the answer is "refuse and say why", never "read it and find
 * out after the allocation already happened".
 */
const MAX_FILE_BYTES = MAX_ARCHIVE_BYTES

/**
 * Most bytes a browser is asked to buffer before it saves.
 *
 * Stated by the Host rather than compiled into the client, so raising it is a
 * configuration change instead of a client rebuild. Above it, the honest answer
 * is "narrow the selection", because a larger archive would be held in memory
 * twice — once in the Host, once in the page.
 */
const BLOB_MAX_BYTES = 64 * 1024 * 1024

/** The byte budgets a download client works within, as the Host states them. */
export const TEAM_EXPORT_LIMITS = {
  /** Above this, a client should narrow its selection rather than buffer it. */
  blobMax: BLOB_MAX_BYTES,
  /** Above this, the Host refuses the package itself. */
  archiveMax: MAX_ARCHIVE_BYTES,
  /** Above this, one file is refused even as a single-file download. */
  fileMax: MAX_FILE_BYTES,
} as const

/** Bytes read per `readSync` call when staging one file. */
const READ_CHUNK_BYTES = 1024 * 1024

/** How one bounded read of one file fared. */
type BoundedRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'too-large' | 'changed-during-read' | 'unreadable' }

/**
 * Read one file without ever allocating more than the budget allows.
 *
 * The budget is enforced **while reading**, not after: a file that was 60MB when
 * it was measured and several GB by the time it is opened must not be read into
 * memory first and judged second. The size is taken from the open handle's own
 * `fstat`, so it describes the file that is actually being read, and the read
 * stops the moment the accumulated bytes pass the budget — memory is bounded by
 * the budget plus one chunk, whatever the file does meanwhile.
 *
 * A file that changed size while being read is its own answer: the bytes on hand
 * are not the bytes that were promised, and the caller is told to retry rather
 * than handed a package nobody can trust.
 * @param absolute - absolute path of the file to read.
 * @param budget - most bytes this read may consume.
 * @returns the bytes, or why they could not be read.
 */
function readBounded(absolute: string, budget: number): BoundedRead {
  let handle: number
  try {
    handle = openSync(absolute, 'r')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  try {
    const before = fstatSync(handle)
    if (!before.isFile()) return { ok: false, reason: 'unreadable' }
    if (before.size > budget) return { ok: false, reason: 'too-large' }
    const scratch = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, budget + 1))
    const chunks: Buffer[] = []
    let read = 0
    for (;;) {
      const want = Math.min(scratch.byteLength, budget + 1 - read)
      if (want <= 0) return { ok: false, reason: 'too-large' }
      const got = readSync(handle, scratch, 0, want, null)
      if (got === 0) break
      read += got
      if (read > budget) return { ok: false, reason: 'too-large' }
      chunks.push(Buffer.from(scratch.subarray(0, got)))
    }
    const after = fstatSync(handle)
    // Equal length is not enough: a shorter file read to its new end, or a
    // longer one still under budget, both mean the bytes changed under us.
    if (after.size !== before.size || read !== before.size) return { ok: false, reason: 'changed-during-read' }
    return { ok: true, bytes: Buffer.concat(chunks, read) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    closeSync(handle)
  }
}

/** How one request to read a project file fared. */
export type TeamExportOutcome =
  | {
    readonly ok: true
    /** Absolute path that was read, for the operator's log line. */
    readonly absolutePath: string
    /** File name as the browser should save it. */
    readonly name: string
    readonly bytes: Buffer
  }
  | { readonly ok: false; readonly reason: TeamExportFailure }

/** How one request to package a conversation's output fared. */
export type TeamArchiveOutcome =
  | {
    readonly ok: true
    /** Absolute path of the project the archive was built from. */
    readonly project: string
    /** File name as the browser should save it. */
    readonly name: string
    readonly bytes: Buffer
    /** How many files the archive holds, for the operator's log line. */
    readonly products: number
  }
  | {
    readonly ok: false
    readonly reason: TeamExportFailure
    /**
     * Paths the caller asked for that could not be handed over.
     *
     * Present when a package is refused because part of it was gone or
     * unreadable: a package missing files is more dangerous than no package,
     * because nobody counts the entries before sending it on.
     */
    readonly missing?: readonly string[]
  }

/**
 * Why a read of a project's output could not be answered.
 *
 * `nothing-produced` and `unreadable` are deliberately separate: the first is
 * normal and tells a member to wait, the second is a fault and tells an
 * operator to look. `work-escapes-project` is a refusal, not a retry.
 */
export type TeamReadFailure =
  | 'unknown-session'
  | 'nothing-produced'
  | 'unreadable'
  | 'work-escapes-project'
  | 'outside-work'

/**
 * Every reason a download can be refused.
 *
 * `too-large` is a budget the caller can act on and `changed-during-read` is a
 * race they can simply retry — different next steps, so different words.
 */
export type TeamExportFailure = TeamReadFailure | 'too-large' | 'changed-during-read'

/** One conversation's resolved project and `work\` directories. */
type ProjectAccess =
  | { readonly ok: true; readonly project: string; readonly work: string }
  | { readonly ok: false; readonly reason: TeamReadFailure }

/** One conversation's workspace, live or read back from storage. */
type WorkspaceLookup =
  | { readonly ok: true; readonly project: string }
  | { readonly ok: false; readonly reason: TeamReadFailure }

/**
 * The slice of the Session query service this service reads history through.
 *
 * Structural rather than imported: a deployment without that plugin simply has
 * no `sessionQuery`, and this plugin must not require it to load.
 */
interface SessionQueryLookup {
  /**
   * Read one persisted Session's header without making it live.
   * @param sessionId - durable conversation identity.
   * @returns the stored header snapshot.
   */
  readSession(sessionId: string): Promise<{ readonly session: { readonly cwd?: string } }>
}

/**
 * The `code` of a thrown harness error, when it carries one.
 * @param error - the value thrown.
 * @returns the code, or undefined when it is not the shape being asked about.
 */
function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/** How one request for the product manifest fared. */
export type TeamManifestOutcome =
  | {
    readonly ok: true
    readonly project: string
    readonly products: readonly ProvenanceProduct[]
    /**
     * Where this project sits and whether its layout is intact.
     *
     * A read-only probe taken at request time, so it describes the tree the
     * listing just walked rather than a remembered creation result. Present only
     * when the deployment declared a projects container: without one there is no
     * "where" to report.
     */
    readonly layout?: ProjectLayoutInspection
  }
  | { readonly ok: false; readonly reason: TeamReadFailure }

/** How one request to move a conversation's control fared. */
export type TeamHandOverOutcome =
  | { readonly ok: true; readonly controller?: string }
  | { readonly ok: false; readonly reason: 'not-driven' }
  | { readonly ok: false; readonly reason: 'not-controller'; readonly controller: string }
  | { readonly ok: false; readonly reason: 'no-such-member' }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Team membership, issued tokens, and the deployment identity resolver. */
    teamIdentity: TeamIdentity
  }
  interface Events {
    /**
     * Control of one conversation moved, so whatever it was waiting on must be
     * withdrawn from the old controller and offered to the new one.
     * @param sessionId - conversation whose control changed.
     * @mode emit
     */
    'identity/control-moved'(sessionId: string): void
  }
}

/**
 * Members, tokens, and the cookie codec for one deployment.
 *
 * The registry is read once at construction so the resolver can stay
 * synchronous: the transport asks it on every request's hot path.
 */
export class TeamIdentity extends Service {
  private readonly registry: TeamRegistry
  /**
   * Member ids this instance admits.
   *
   * Held beside the registry on purpose. The token table is durable and outlives
   * any particular roster, so "is this token valid" and "is its member still a
   * member" are two different questions, and only the second one can change
   * without the registry being touched.
   */
  private readonly roster: ReadonlySet<string>
  /** Which member is driving which conversation, and who its requests belong to. */
  readonly control: SessionControl
  /**
   * The project-level record of which turn wrote what.
   *
   * It shares this service's view of a Session's workspace on purpose: the
   * directory a turn is logged against and the directory a download is read from
   * have to be the same one, or the ledger would describe a tree nobody reads.
   */
  readonly provenance: ProvenanceLedger

  /**
   * @param ctx - owning Host context.
   * @param members - operator-declared membership list.
   * @param tokenTtlMs - lifetime of one issued token.
   * @param tokenLimit - maximum live tokens kept before the oldest expire.
   * @param homePath - harness home holding the registry; defaults to the resolved `$DSH_HOME`.
   * @param onPersistFailure - told when a registry write fails; defaults to a warning.
   * @param takeoverIdleMs - how long a holder must be idle before anyone else may
   *   take the conversation over; defaults to {@link IDLE_BEFORE_TAKEOVER_MS}. A
   *   permission, not an expiry: nothing moves control on its own.
   */
  constructor(
    ctx: Context,
    members: readonly TeamMember[],
    private readonly tokenTtlMs: number,
    tokenLimit: number,
    homePath?: string,
    onPersistFailure?: PersistFailureReporter,
    takeoverIdleMs: number = IDLE_BEFORE_TAKEOVER_MS,
    /**
     * Directory every Session's workspace must live under, when the deployment
     * states one. Re-checked on every download rather than trusted from the
     * Session: the fence decides where a Session may be *created*, and a
     * directory can predate it or be edited afterwards.
     */
    private readonly workspaceRoot?: string,
    /**
     * The container whose direct children are projects, when the deployment
     * states one. Used only to report *where* a conversation's directory sits;
     * the byte boundaries above never depend on it.
     */
    private readonly projectsRoot?: string,
  ) {
    super(ctx, 'teamIdentity')
    this.control = new SessionControl(
      sessionId => this.ctx.emit('identity/control-moved', sessionId),
      takeoverIdleMs,
    )
    this.provenance = new ProvenanceLedger(sessionId => this.workspaceOf(sessionId), onPersistFailure)
    this.roster = new Set(members.map(member => member.userId))
    this.registry = TeamRegistry.open(
      join(homePath ?? resolveDshHome(undefined, process.env), TEAM_IDENTITY_FILE_NAME),
      members,
      tokenLimit,
      onPersistFailure,
    )
  }

  /** Members this deployment admits, in declaration order. */
  listMembers(): readonly TeamMember[] {
    return this.registry.listMembers()
  }

  /**
   * Resolve the caller from one request's own cookie.
   *
   * This is the transport's resolver: it sees headers only, so a request that
   * carries no valid signed cookie resolves to nobody. It never reads a body or
   * a client-declared field.
   * @param headers - the request's headers.
   * @returns the subject, or undefined when the request is not signed in.
   */
  resolve(headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>): ConnectionSubject | undefined {
    const session = this.sessionOf(headers)
    if (session === undefined) return undefined
    return { userId: session.userId, tokenId: session.tokenId, actorType: 'user' }
  }

  /**
   * Resolve one live team session from a request's cookie.
   * @param headers - the request's headers.
   * @returns the session, or undefined when absent, invalid, expired, or revoked.
   */
  sessionOf(
    headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>,
  ): TeamSession | undefined {
    const authority = requestAuthority(headers)
    if (authority === undefined) return undefined
    const raw = headers instanceof Headers ? headers.get('cookie') : headers['cookie']
    if (typeof raw !== 'string') return undefined
    const value = readCookie(raw, teamCookieName(authority))
    if (value === undefined) return undefined
    const payload = decodeTeamCookie(value, this.registry.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    if (payload.issuedAt > Date.now() || payload.expiresAt <= Date.now()) return undefined
    const session = this.registry.lookup(payload.tokenId)
    if (session === undefined) return undefined
    if (this.roster.has(session.userId)) return session
    // The member is not in the roster any more, so this token must stop working
    // even though the table still holds an unexpired record for it. Removing
    // someone has to end what they already hold, not merely stop them signing in
    // again — the check lives on every read for exactly that reason.
    this.endSessions(session.userId)
    this.ctx.emit('identity/revoked', session.userId)
    return undefined
  }

  /**
   * End the sessions of members this roster no longer declares.
   *
   * The token table survives configuration changes, so a member removed while
   * the deployment was running keeps both their token and — until something
   * closes it — the WebSocket they already opened. Every read refuses them from
   * now on; this is what reaches the connection that will not read again.
   * @returns the member ids whose sessions were ended.
   */
  reconcile(): readonly string[] {
    const ended: string[] = []
    for (const userId of this.registry.tokenUserIds()) {
      if (this.roster.has(userId)) continue
      this.endSessions(userId)
      this.ctx.emit('identity/revoked', userId)
      ended.push(userId)
    }
    return ended
  }

  /**
   * Resolve one conversation's workspace directory, live or from storage.
   *
   * The live store answers for a conversation this process is serving. A
   * conversation that was persisted and then survived a restart is not live
   * until something resumes it, and its workspace is exactly what a member
   * asking for last week's report needs — so the durable read is the fallback,
   * deliberately without making the Session live (the query service documents
   * that it reads "without making it live"), because handing over files must not
   * start an Agent.
   * @param sessionId - conversation whose workspace to resolve.
   * @returns the project directory, or why there is none.
   */
  private async projectWorkspaceOf(sessionId: string): Promise<WorkspaceLookup> {
    const live = this.workspaceOf(sessionId)
    if (live !== undefined) return { ok: true, project: live }
    const query = this.ctx.get('sessionQuery') as SessionQueryLookup | undefined
    // No query service means the deployment cannot read history at all, which is
    // today's behaviour: the session is simply unknown.
    if (query === undefined) return { ok: false, reason: 'unknown-session' }
    try {
      const record = await query.readSession(sessionId)
      const cwd = record.session.cwd
      if (cwd === undefined || cwd === '') return { ok: false, reason: 'unknown-session' }
      return { ok: true, project: cwd }
    } catch (error: unknown) {
      // "Not found" and "could not be read" lead an operator to different
      // actions, so they are not collapsed into one answer.
      const code = errorCodeOf(error)
      if (code === 'SESSION_QUERY_PERSISTENCE_FAILED' || code === 'SESSION_QUERY_CORRUPT_SESSION') {
        return { ok: false, reason: 'unreadable' }
      }
      return { ok: false, reason: 'unknown-session' }
    }
  }

  /**
   * Resolve one conversation's project root and its `work\` directory.
   *
   * Both boundaries are checked before anything is read or listed. The project
   * has to sit inside the deployment's workspace root — the same boundary
   * `session/create` enforces, re-checked here because an old directory or a
   * later edit can leave a Session pointing somewhere the fence no longer
   * covers. `work\` then has to be inside the project **for real**: a `work\`
   * that is itself a junction out of the project would otherwise hand over
   * whatever it points at, and a check that canonicalizes only the candidate
   * cannot see it.
   * @param sessionId - conversation whose project to resolve.
   * @returns the project and work directories, or why they cannot be read.
   */
  private async projectFor(sessionId: string): Promise<ProjectAccess> {
    const lookup = await this.projectWorkspaceOf(sessionId)
    if (!lookup.ok) return lookup
    const project = lookup.project
    if (this.workspaceRoot !== undefined && !isWithin(this.workspaceRoot, project)) {
      return { ok: false, reason: 'outside-work' }
    }
    const work = join(project, WORK_DIRECTORY)
    if (!isWithin(project, work)) return { ok: false, reason: 'work-escapes-project' }
    return { ok: true, project, work }
  }

  /**
   * Read one file out of a conversation's `work\` directory.
   *
   * The directory comes from the Session, never from the request, so a caller
   * cannot name the tree it reads out of — it names a path *inside* whatever that
   * conversation's workspace already is. Only `work\` is reachable: `input\` is
   * somebody else's data, `build\` is a rebuildable intermediate, and `temp\` is
   * the session's own scratch. What is left is the part meant to be handed over.
   * @param sessionId - conversation whose workspace to read from.
   * @param relative - path relative to that conversation's `work\` directory.
   * @returns the bytes and the name to save them under, or why it was refused.
   */
  async exportFile(sessionId: string, relative: string): Promise<TeamExportOutcome> {
    const access = await this.projectFor(sessionId)
    if (!access.ok) return { ok: false, reason: access.reason }
    const target = resolve(access.work, relative)
    // Canonical paths, so a junction under `work\` cannot hand over the host.
    if (!isWithin(access.work, target)) return { ok: false, reason: 'outside-work' }
    const read = readBounded(target, MAX_FILE_BYTES)
    if (!read.ok) return { ok: false, reason: read.reason }
    return { ok: true, absolutePath: target, name: basename(target), bytes: read.bytes }
  }

  /**
   * Record that one member started a turn on one conversation.
   *
   * Called by the call policy at the moment a prompt is admitted, which is the
   * only place that holds the conversation, the resolved member, and the time
   * together. A conversation with no resolvable workspace is simply not recorded:
   * there is no project to write a ledger into.
   * @param sessionId - conversation the prompt was issued on.
   * @param userId - member the transport resolved as the caller.
   * @returns the turn's number, or undefined when nothing was recorded.
   */
  recordPrompt(sessionId: string, userId: string): number | undefined {
    return this.provenance.recordTurn(sessionId, userId)
  }

  /**
   * List what one conversation's project has produced, with attribution.
   *
   * This is what makes a packaged download meaningful: without it the only honest
   * package is the whole `work\` directory, with no way to say which turn or which
   * member put a file there.
   * @param sessionId - conversation whose project to describe.
   * @param scope - `all` for every recorded turn, `latest` for each conversation's newest.
   * @returns the manifest, or why it could not be produced.
   */
  async manifest(sessionId: string, scope: ProvenanceScope = 'all'): Promise<TeamManifestOutcome> {
    const access = await this.projectFor(sessionId)
    if (!access.ok) return { ok: false, reason: access.reason }
    const scan = this.provenance.scanWork(access.project, scope)
    if (!scan.ok) return { ok: false, reason: scan.reason }
    const layout = this.projectsRoot === undefined
      ? undefined
      : inspectProjectLayout(access.project, this.projectsRoot)
    return {
      ok: true,
      project: access.project,
      products: scan.products,
      ...layout === undefined ? {} : { layout },
    }
  }

  /**
   * Package one conversation's project output as a ZIP archive.
   *
   * The archive mirrors the project exactly: entries are named `work/…`, the same
   * layout the member sees on the server, and nothing from `input\`, `build\`,
   * `logs\`, or the per-conversation `temp\` is included. A project that has not
   * produced anything yet is refused rather than answered with an empty archive,
   * because "there is nothing to hand over" is a different fact from "here is an
   * empty file".
   *
   * Every byte is measured before it is read, and read under a budget rather than
   * judged after the fact, so a file that grows between the measurement and the
   * read cannot make the Host allocate it. A package that would be missing files
   * is refused whole and names them: nobody counts the entries of a ZIP before
   * sending it on.
   * @param sessionId - conversation whose project to package.
   * @param scope - `all` for every recorded turn, `latest` for each conversation's newest.
   * @param selected - manifest paths to include; omitted means everything.
   * @returns the archive's bytes and name, or why it was refused.
   */
  async exportArchive(
    sessionId: string,
    scope: ProvenanceScope = 'all',
    selected?: readonly string[],
  ): Promise<TeamArchiveOutcome> {
    const access = await this.projectFor(sessionId)
    if (!access.ok) return { ok: false, reason: access.reason }
    const scan = this.provenance.scanWork(access.project, scope)
    if (!scan.ok) return { ok: false, reason: scan.reason }
    const choice = selectProducts(scan.products, selected)
    if (!choice.ok) return choice.outcome
    const products = choice.products
    if (products.length === 0) return { ok: false, reason: 'nothing-produced' }
    // Budget first, reads second: nothing is allocated for a package that is
    // already known to be too large.
    let planned = 0
    for (const product of products) {
      if (product.bytes > MAX_ARCHIVE_BYTES - planned) return { ok: false, reason: 'too-large' }
      planned += product.bytes
    }
    const entries: ZipEntry[] = []
    const missing: string[] = []
    let changed = false
    let total = 0
    for (const product of products) {
      const absolute = join(access.work, ...product.path.slice(WORK_DIRECTORY.length + 1).split('/'))
      const read = readBounded(absolute, MAX_ARCHIVE_BYTES - total)
      if (!read.ok) {
        if (read.reason === 'too-large') return { ok: false, reason: 'too-large' }
        if (read.reason === 'changed-during-read') changed = true
        missing.push(product.path)
        continue
      }
      total += read.bytes.byteLength
      entries.push({ name: product.path, data: read.bytes, modified: new Date(product.producedAt) })
    }
    if (missing.length > 0) {
      // Refused whole, with the reason that tells the member what to do about
      // it: a race is worth retrying, an unreadable file is worth reporting.
      return { ok: false, reason: changed && entries.length === 0 ? 'changed-during-read' : 'unreadable', missing }
    }
    try {
      return {
        ok: true,
        project: access.project,
        // Named for the project and the conversation, so two members downloading
        // two conversations do not produce two files called `download.zip`. The
        // session prefix is dropped, or every name would start with "session-".
        name: archiveName(basename(access.project), sessionId),
        bytes: buildZip(entries),
        products: entries.length,
      }
    } catch (error) {
      if (error instanceof ZipTooLargeError) return { ok: false, reason: 'too-large' }
      throw error
    }
  }

  /**
   * Take one conversation over from a holder who has been idle long enough.
   *
   * The caller is resolved from their own cookie, never from the body: a member
   * does not get to name themselves as the new controller either. Nothing here
   * decides *whether* they may — the holder's idle time does, and a conversation
   * that is not idle enough is refused with the clock the member needs to see.
   * @param sessionId - conversation to take over.
   * @param actor - member making the request, as the transport resolved them.
   * @returns the new holder, or why the takeover was refused.
   */
  takeOver(sessionId: string, actor: TeamSession): TakeOverOutcome {
    return this.control.takeOver(sessionId, {
      userId: actor.userId,
      tokenId: actor.tokenId,
      actorType: 'user',
    })
  }

  /**
   * Read who is driving one conversation, and whether it can be taken over.
   * @param sessionId - conversation to inspect.
   * @returns the holder, its idle time, and whether a takeover would be accepted.
   */
  controlOf(sessionId: string): ControlState {
    return this.control.controlState(sessionId)
  }

  /**
   * Read one live Session's workspace directory.
   *
   * Resolved lazily: the Session store may mount after this plugin does, and a
   * deployment without one simply has no files to hand over.
   * @param sessionId - conversation whose workspace to read.
   * @returns the workspace directory, or undefined when there is none.
   */
  private workspaceOf(sessionId: string): string | undefined {
    const sessions = this.ctx.get('sessions') as
      | { get(id: string): { readonly header?: { readonly cwd?: string } } | undefined }
      | undefined
    const cwd = sessions?.get(sessionId)?.header?.cwd
    return cwd === undefined || cwd === '' ? undefined : cwd
  }

  /**
   * Hand one conversation's control to another member, or release it.
   *
   * Only the member driving the conversation may decide this: control exists so
   * that one person speaks for a conversation, and a rule that let anyone take it
   * would be no rule at all.
   * @param sessionId - conversation whose control changes.
   * @param actor - member making the request, as the transport resolved them.
   * @param toUserId - member to hand it to, or undefined to release it.
   * @returns the outcome, including the new controller when control moved.
   */
  handOver(sessionId: string, actor: TeamSession, toUserId?: string): TeamHandOverOutcome {
    const controller = this.control.controllerOf(sessionId)
    if (controller === undefined) return { ok: false, reason: 'not-driven' }
    if (controller.userId !== actor.userId) {
      return { ok: false, reason: 'not-controller', controller: controller.userId }
    }
    if (toUserId !== undefined) {
      // Only a declared member can be given control, and handing it to yourself
      // is a release in disguise — answer it as what it means.
      const member = this.registry.listMembers().find(candidate => candidate.userId === toUserId)
      if (member === undefined) return { ok: false, reason: 'no-such-member' }
      if (member.userId === actor.userId) {
        this.control.handOver(sessionId)
        return { ok: true }
      }
      this.control.handOver(sessionId, { userId: member.userId, tokenId: '', actorType: 'user' })
      return { ok: true, controller: member.userId }
    }
    this.control.handOver(sessionId)
    return { ok: true }
  }

  /**
   * Check a submitted name and code and, on success, mint one token.
   *
   * Signing in ends the member's earlier sessions first. One member is one person,
   * and a second live session is either the same person on a second device or
   * someone else holding their code; both are answered the same way, by leaving the
   * newest session as the only one. The revoked session's open streams are closed
   * with it, so a browser left open on the older session stops receiving anything.
   * @param name - display name exactly as declared.
   * @param code - fine-grained or shared sign-in code.
   * @param authority - request authority the resulting cookie is bound to.
   * @returns the new session, or which half of the pair failed.
   */
  signIn(name: string, code: string, authority: string): TeamSignInOutcome {
    if (authority === '') return { ok: false, reason: 'name' }
    const member = this.registry.matchMember(name, code)
    if (member === undefined) {
      // Distinguish "no such member" from "wrong code" only in the service API;
      // the HTTP route collapses both to one status.
      const known = this.registry.listMembers().some(candidate => candidate.name === name)
      return { ok: false, reason: known ? 'code' : 'name' }
    }
    // Revoke before issuing, never after: doing it the other way round would revoke
    // the session this call is about to return.
    const ended = this.endSessions(member.userId)
    if (ended.revoked > 0) this.ctx.emit('identity/revoked', member.userId)
    return { ok: true, session: this.registry.issue(member.userId, this.tokenTtlMs) }
  }

  /**
   * End every session of one member without touching their membership.
   * @param userId - member whose sessions must end.
   * @returns how many tokens were revoked and how many conversations were released.
   */
  private endSessions(userId: string): { readonly revoked: number; readonly released: number } {
    const revoked = this.registry.revoke(userId)
    // Control goes with the session: the older browser could otherwise keep driving
    // a conversation it is no longer allowed to speak for.
    const released = this.control.forgetUser(userId)
    return { revoked, released }
  }

  /**
   * Build the `Set-Cookie` value for one issued session.
   * @param session - session to carry.
   * @param authority - request authority the cookie is bound to.
   * @returns the header value.
   */
  cookieHeader(session: TeamSession, authority: string): string {
    const value = encodeTeamCookie({
      version: 1,
      authority,
      tokenId: session.tokenId,
      issuedAt: Date.now(),
      expiresAt: session.expiresAt,
    }, this.registry.secret)
    return teamCookie(teamCookieName(authority), value, session.expiresAt)
  }

  /**
   * Revoke every token of one member and end their open streams.
   *
   * Disabling an account has to reach connections that were already accepted;
   * a stream opened before revocation would otherwise keep serving that account.
   * @param userId - member to disable.
   * @returns how many tokens were revoked.
   */
  revoke(userId: string): number {
    const { revoked } = this.endSessions(userId)
    this.ctx.emit('identity/revoked', userId)
    return revoked
  }
}

/** How much of a Session id a download's file name carries. */
const ARCHIVE_ID_LENGTH = 8

/** The effect of applying one caller's selection to a project's products. */
type ProductChoice =
  | { readonly ok: true; readonly products: readonly ProvenanceProduct[] }
  | { readonly ok: false; readonly outcome: TeamArchiveOutcome }

/**
 * Narrow one project's products to the paths a member chose.
 *
 * The selection is manifest paths as the member saw them (`work/…`), never
 * filesystem paths: a request may name what it wants handed over, and nothing
 * else. An empty selection is refused rather than read as "everything" — the
 * one reading that would silently hand over more than was asked for. A selected
 * path that is no longer in the manifest is reported as missing rather than
 * dropped, for the same reason a partly readable package is refused: nobody
 * counts the entries before sending a ZIP on.
 * @param all - every product the current scan found.
 * @param selected - paths the caller asked for; undefined means all of them.
 * @returns the chosen products, or the refusal to report as-is.
 */
function selectProducts(
  all: readonly ProvenanceProduct[],
  selected?: readonly string[],
): ProductChoice {
  if (selected === undefined) return { ok: true, products: all }
  const wanted = new Set<string>()
  for (const path of selected) {
    // A selection names manifest entries and nothing else: not an absolute path,
    // not a `..` segment, always under `work/`. The bytes are checked against the
    // real work directory later; this is what keeps the *reason* honest, since a
    // path that escapes would otherwise be reported as a missing file — which
    // reads like a race rather than like a boundary.
    if (!path.startsWith(`${WORK_DIRECTORY}/`) || path.split('/').includes('..')) {
      return { ok: false, outcome: { ok: false, reason: 'outside-work' } }
    }
    wanted.add(path)
  }
  if (wanted.size === 0) return { ok: false, outcome: { ok: false, reason: 'nothing-produced' } }
  const available = new Set(all.map(product => product.path))
  const gone = [...wanted].filter(path => !available.has(path))
  if (gone.length > 0) return { ok: false, outcome: { ok: false, reason: 'unreadable', missing: gone } }
  return { ok: true, products: all.filter(product => wanted.has(product.path)) }
}

/**
 * Name one packaged download.
 *
 * A browser saves by this name, so it has to say which project and which
 * conversation without being a path: only the base name is used, and a Session's
 * own `session-` prefix is dropped so the readable part of its id survives the
 * truncation.
 * @param project - the project directory's own name.
 * @param sessionId - the conversation the package belongs to.
 * @returns the file name.
 */
function archiveName(project: string, sessionId: string): string {
  const short = sessionId.replace(/^session-/, '').slice(0, ARCHIVE_ID_LENGTH)
  return short === '' ? `${project}.zip` : `${project}-${short}.zip`
}
