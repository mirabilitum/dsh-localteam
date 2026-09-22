/**
 * The deployment's team surface, as one browser can see it: whether this page
 * belongs to a signed-in member of a shared deployment, who else is a member,
 * what a conversation's project has produced, and the gestures that need both
 * answers — packaging a chosen part of that output, and moving who speaks for
 * the conversation.
 *
 * Every gesture is plain same-origin HTTP against the routes the Host's
 * team-identity plugin serves, so nothing here needs a Remote, a service, or a
 * message: the browser already carries the team cookie, and the Host decides
 * what the caller may do. A deployment without that plugin answers 404 and is
 * reported as `personal`, which is what keeps these controls out of a
 * single-operator instance entirely.
 *
 * Bytes a member asked for are saved from a **local** blob, never by navigating
 * to the export route: a navigation would replace the page with whatever the
 * Host answered, including its error bodies. The selection travels as a form
 * body for the same reason a URL is the wrong place for it — a project with
 * hundreds of files cannot name them in a query string.
 *
 * @module @deepseek-ai/dsh-client-ui-deliverables/client/team-surface
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * The three team routes, owned by `packages/identity/team-identity/src/paths.ts`
 * and served by that package's `http-route.ts`.
 *
 * They are repeated rather than imported because the owning package is Host-only:
 * importing it for three strings would drag a Node module graph into the browser
 * bundle. The literals are asserted on both sides, so a rename cannot land
 * silently in one of them.
 */
const TEAM_STATUS_PATH = '/api/team.identity'
const TEAM_EXPORT_PATH = '/api/team.export'
const TEAM_HANDOVER_PATH = '/api/team.identity.handover'

/** One member, as the deployment lets another member see them. */
export interface TeamMemberView {
  readonly userId: string
  readonly name: string
}

/**
 * What this page knows about the deployment.
 *
 * `unknown` is the state before the first read answers and after a read that
 * failed: it renders no controls, which is the safe reading of "not known to be
 * a member".
 */
export type TeamView =
  | { readonly status: 'unknown' }
  | { readonly status: 'personal' }
  | { readonly status: 'member'; readonly userId: string; readonly members: readonly TeamMemberView[] }

/** How much of a conversation's output a package covers. */
export type TeamScope = 'all' | 'latest'

/** One file a project has produced, as the manifest reports it. */
export interface TeamProduct {
  /** Manifest path, `work/…` — what a selection names. */
  readonly path: string
  readonly bytes: number
  /** Who and which turn produced it, so far as the ledger can say. */
  readonly sessionId: string | null
  readonly member: string | null
  readonly turn: number | null
  readonly producedAt: string
}

/** Where a conversation's directory sits, and whether its layout is intact. */
export interface TeamLayout {
  /** `project` is the supported case; the others are reported, not hidden. */
  readonly location: 'project' | 'container' | 'nested' | 'outside'
  readonly missing: readonly string[]
  readonly conflicts: readonly { readonly name: string; readonly kind: string }[]
  readonly complete: boolean
}

/** The byte budgets the Host states, so the client never invents its own. */
export interface TeamLimits {
  /** Above this, the page must narrow its selection rather than buffer it. */
  readonly blobMax: number
  /** Above this, the Host refuses the package itself. */
  readonly archiveMax: number
  /** Above this, one file is refused even as a single-file download. */
  readonly fileMax: number
}

/** One conversation's readable output, or why it could not be read. */
export type TeamManifest =
  | {
    readonly ok: true
    readonly project: string
    readonly products: readonly TeamProduct[]
    /** Read successfully and there is nothing in it — not an error. */
    readonly empty: boolean
    readonly limits: TeamLimits
    readonly layout?: TeamLayout
  }
  | { readonly ok: false; readonly reason: string; readonly missing?: readonly string[] }

/** Who drives one conversation, and whether it can be taken over. */
export interface TeamControlState {
  readonly sessionId: string
  readonly driven: boolean
  readonly controller?: string
  /** Milliseconds since the holder's last accepted act. */
  readonly idleMs: number
  /** How long the holder must be idle before a takeover is accepted. */
  readonly requiredIdleMs: number
  /** Whether the conversation is waiting on an answer from its holder. */
  readonly pending: boolean
  readonly mayTakeOver: boolean
}

/** Outcome of asking for a packaged download. */
export type TeamDownloadResult =
  | { readonly ok: true; readonly files: number; readonly bytes: number }
  | { readonly ok: false; readonly reason: string; readonly missing?: readonly string[] }

/** Outcome of one control hand-over. */
export type TeamHandOverResult =
  | { readonly ok: true; readonly controller: string | undefined }
  | { readonly ok: false; readonly reason: string; readonly controller: string | undefined }

/** Outcome of one takeover attempt. */
export type TeamTakeOverResult =
  | { readonly ok: true; readonly controller: string }
  | {
    readonly ok: false
    readonly reason: string
    readonly controller?: string
    /** The clock the refusal was made against, so the UI can say when to retry. */
    readonly idleMs?: number
    readonly requiredIdleMs?: number
  }

/** Most bytes the page will hold when the Host states no budget. */
const DEFAULT_BLOB_MAX = 64 * 1024 * 1024

/** One browser plugin's team reads and team gestures, cancelled when it is disposed. */
export class TeamSurface {
  /** What this page knows; every control reads it through a selector hook. */
  readonly view = createSnapshotStore<TeamView>({ status: 'unknown' })
  private loading: Promise<void> | undefined
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  /** Last budget the Host stated; the Host owns it, this only remembers it. */
  private blobMax = DEFAULT_BLOB_MAX

  /**
   * Read the deployment's team surface once, coalescing concurrent reads.
   * @returns after the view is published, or after a failed read left it unknown.
   */
  async load(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    if (this.loading !== undefined) return this.loading
    const task = this.read()
    this.loading = task
    this.pending.add(task)
    try {
      await task
    } finally {
      if (this.loading === task) this.loading = undefined
      this.pending.delete(task)
    }
  }

  /** Re-read after a connection replacement, whose earlier answer may be stale. */
  forget(): void {
    this.view.set({ status: 'unknown' })
    void this.load()
  }

  /**
   * Read what one conversation's project has produced.
   *
   * The whole list is kept, not just its length: the list is the interface a
   * member chooses from, and the byte totals in it are what let the page say
   * "this will not fit" before anything is downloaded.
   * @param sessionId - conversation whose project to describe.
   * @param scope - every recorded turn, or each conversation's newest.
   * @returns the products and their budgets, or why the read was refused.
   */
  async manifest(sessionId: string, scope: TeamScope = 'all'): Promise<TeamManifest> {
    const query = `sessionId=${encodeURIComponent(sessionId)}&scope=${scope}&form=manifest`
    let response: Response
    try {
      response = await fetch(`${TEAM_EXPORT_PATH}?${query}`, { signal: this.lifetime.signal })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (!response.ok) return { ok: false, ...await refusalOf(response) }
    try {
      const value = asRecord(await response.json())
      const limits = limitsOf(value.limits)
      this.blobMax = limits.blobMax
      const layout = layoutOf(value.layout)
      return {
        ok: true,
        project: typeof value.project === 'string' ? value.project : '',
        products: productsOf(value.products),
        empty: value.empty === true,
        limits,
        ...layout === undefined ? {} : { layout },
      }
    } catch {
      return { ok: false, reason: 'refused' }
    }
  }

  /**
   * Hand one selection of a conversation's output to the member's own machine.
   *
   * The selection is a snapshot of manifest paths: files produced after the list
   * was read are not in it, and nothing here adds them, because a package that
   * quietly grew is not the one that was agreed to.
   * @param sessionId - conversation whose `work\` directory to package.
   * @param paths - manifest paths to include; an empty selection is refused by
   *   the Host rather than read as "everything".
   * @returns what the package held, or why it was refused.
   */
  async downloadSelection(sessionId: string, paths: readonly string[]): Promise<TeamDownloadResult> {
    const body = new URLSearchParams()
    for (const path of paths) body.append('path', path)
    return await this.requestArchive(sessionId, body)
  }

  /**
   * Package everything one conversation's project has produced.
   *
   * Kept as the plain "save this conversation's output" gesture: it reads the
   * manifest first, so a conversation with nothing to hand over is reported as
   * such instead of asking for a package that would only be refused.
   * @param sessionId - conversation whose `work\` directory to package.
   * @param scope - every recorded turn, or each conversation's newest.
   * @returns what the package held, or why it was not produced.
   */
  async download(sessionId: string, scope: TeamScope = 'all'): Promise<TeamDownloadResult> {
    const manifest = await this.manifest(sessionId, scope)
    if (!manifest.ok) return { ok: false, reason: manifest.reason, ...manifest.missing === undefined ? {} : { missing: manifest.missing } }
    if (manifest.products.length === 0) return { ok: false, reason: 'nothing-produced' }
    return await this.downloadSelection(sessionId, manifest.products.map(product => product.path))
  }

  /**
   * Hand one file out of a conversation's `work\` directory.
   *
   * Manifest paths carry the `work/` prefix the archive uses; this route names a
   * path *inside* `work\`, so the prefix comes off here rather than being sent
   * and rejected.
   * @param sessionId - conversation whose `work\` directory to read.
   * @param path - manifest path of the file.
   * @returns what was saved, or why it was refused.
   */
  async downloadFile(sessionId: string, path: string): Promise<TeamDownloadResult> {
    const relative = path.startsWith('work/') ? path.slice('work/'.length) : path
    const query = `sessionId=${encodeURIComponent(sessionId)}&form=file&path=${encodeURIComponent(relative)}`
    let response: Response
    try {
      response = await fetch(`${TEAM_EXPORT_PATH}?${query}`, { signal: this.lifetime.signal })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (!response.ok) return { ok: false, ...await refusalOf(response) }
    const saved = await saveResponse(response, this.blobMax, basenameOf(relative))
    if (!saved.ok) return saved
    return { ok: true, files: 1, bytes: saved.bytes }
  }

  /**
   * Read who is driving one conversation.
   * @param sessionId - conversation to inspect.
   * @returns the control state, or undefined when it cannot be read.
   */
  async control(sessionId: string): Promise<TeamControlState | undefined> {
    try {
      const response = await fetch(
        `${TEAM_HANDOVER_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
        { signal: this.lifetime.signal },
      )
      if (!response.ok) return undefined
      const value = asRecord(await response.json().catch(() => undefined))
      return {
        sessionId,
        driven: value.driven === true,
        ...typeof value.controller === 'string' ? { controller: value.controller } : {},
        idleMs: typeof value.idleMs === 'number' ? value.idleMs : 0,
        requiredIdleMs: typeof value.requiredIdleMs === 'number' ? value.requiredIdleMs : 0,
        pending: value.pending === true,
        mayTakeOver: value.mayTakeOver === true,
      }
    } catch {
      return undefined
    }
  }

  /**
   * Take one conversation over from a holder who has been idle long enough.
   *
   * The page only asks: whether the moment is right is the Host's decision, made
   * against its own clock when the request arrives — an answer read a second ago
   * is not an entitlement.
   * @param sessionId - conversation to take over.
   * @returns the new holder, or why the takeover was refused.
   */
  async takeOver(sessionId: string): Promise<TeamTakeOverResult> {
    try {
      const response = await fetch(TEAM_HANDOVER_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, take: true }),
        signal: this.lifetime.signal,
      })
      const record = asRecord(await response.json().catch(() => undefined))
      if (response.ok) {
        return { ok: true, controller: typeof record.controller === 'string' ? record.controller : '' }
      }
      return {
        ok: false,
        reason: typeof record.reason === 'string' ? record.reason : 'refused',
        ...typeof record.controller === 'string' ? { controller: record.controller } : {},
        ...typeof record.idleMs === 'number' ? { idleMs: record.idleMs } : {},
        ...typeof record.requiredIdleMs === 'number' ? { requiredIdleMs: record.requiredIdleMs } : {},
      }
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
  }

  /**
   * Hand one conversation's control to another member, or release it.
   *
   * Only the member driving the conversation may do either; the Host refuses
   * anyone else, and the refusal names the member it belongs to.
   * @param sessionId - conversation whose control changes.
   * @param to - member to hand it to; absent means release.
   * @returns the outcome, including the new controller when control moved.
   */
  async handOver(sessionId: string, to?: string): Promise<TeamHandOverResult> {
    try {
      const response = await fetch(TEAM_HANDOVER_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(to === undefined ? { sessionId } : { sessionId, to }),
        signal: this.lifetime.signal,
      })
      const record = asRecord(await response.json().catch(() => undefined))
      const controller = typeof record.controller === 'string' ? record.controller : undefined
      if (response.ok) return { ok: true, controller }
      return {
        ok: false,
        reason: typeof record.reason === 'string' ? record.reason : 'refused',
        controller,
      }
    } catch {
      return { ok: false, reason: 'unreachable', controller: undefined }
    }
  }

  /** Cancel outstanding requests and wait until none can publish state. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.all([...this.pending])
  }

  /**
   * Ask the Host for one archive and save what it answers with.
   * @param sessionId - conversation whose project to package.
   * @param body - the selection, as the form fields the route reads.
   * @returns what the package held, or why it was refused.
   */
  private async requestArchive(sessionId: string, body: URLSearchParams): Promise<TeamDownloadResult> {
    const query = `sessionId=${encodeURIComponent(sessionId)}&form=zip`
    let response: Response
    try {
      response = await fetch(`${TEAM_EXPORT_PATH}?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: this.lifetime.signal,
      })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (!response.ok) return { ok: false, ...await refusalOf(response) }
    const saved = await saveResponse(response, this.blobMax, 'download.zip')
    if (!saved.ok) return saved
    // The count comes from the response the Host actually built, not from the
    // manifest that was read before it: the two can disagree, and the package is
    // the one that exists.
    const files = Number.parseInt(response.headers.get('x-team-export-files') ?? '', 10)
    return { ok: true, files: Number.isFinite(files) ? files : 0, bytes: saved.bytes }
  }

  private async read(): Promise<void> {
    try {
      const response = await fetch(TEAM_STATUS_PATH, { signal: this.lifetime.signal })
      // A deployment without the team plugin has no such route, and any other
      // answer that is not the member shape leaves the controls off.
      if (response.ok) {
        const value = asRecord(await response.json().catch(() => undefined))
        if (value.signedIn === true && typeof value.userId === 'string' && Array.isArray(value.members)) {
          const members = value.members.filter((entry): entry is TeamMemberView => {
            const member = asRecord(entry)
            return typeof member.userId === 'string' && typeof member.name === 'string'
          })
          if (!this.lifetime.signal.aborted) {
            this.view.set({ status: 'member', userId: value.userId, members })
          }
          return
        }
      }
      if (!this.lifetime.signal.aborted) this.view.set({ status: 'personal' })
    } catch {
      // A read that failed is not an answer: leaving the view unknown keeps the
      // controls hidden, and the next connection reset reads again.
    }
  }
}

/** One saved response: the bytes the page held, and how many. */
type SavedResponse =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: string }

/**
 * Read one response under a byte budget and save what it carries.
 *
 * The budget is enforced while reading, not after: the manifest that was read a
 * moment ago is an estimate, and a project can grow between the two requests. A
 * response that would exceed it is dropped where it stands rather than turned
 * into a blob first, and the answer says so, which is what a member can act on
 * ("narrow the selection") instead of a tab that dies holding it.
 * @param response - the archive response, already known to be ok.
 * @param budget - most bytes the page will hold.
 * @param fallbackName - name to save under when the Host names no file.
 * @returns how many bytes were saved, or why nothing was.
 */
async function saveResponse(response: Response, budget: number, fallbackName: string): Promise<SavedResponse> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > budget) return { ok: false, reason: 'too-large' }
  let blob: Blob
  try {
    const body = response.body
    if (body === null) {
      blob = await response.blob()
      if (blob.size > budget) return { ok: false, reason: 'too-large' }
    } else {
      const reader = body.getReader()
      const chunks: BlobPart[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > budget) {
          await reader.cancel()
          return { ok: false, reason: 'too-large' }
        }
        // A stream reader always hands back a view over an ordinary ArrayBuffer;
        // the DOM's `BlobPart` is typed more narrowly than the view type, so this
        // is the same bytes under the name the constructor accepts.
        chunks.push(value as unknown as BlobPart)
      }
      blob = new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' })
    }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  saveBlob(blob, attachmentName(response.headers.get('content-disposition')) ?? fallbackName)
  return { ok: true, bytes: blob.size }
}

/**
 * Save bytes the page already holds.
 *
 * A local blob URL, never a navigation to the export route: navigating would
 * replace the page with whatever the Host answered, and an error body would be
 * saved under the project's name. `createObjectURL` alone does not save
 * anything, so the anchor is what performs the gesture — and the URL is revoked
 * on the next turn of the loop, once the browser has begun reading the blob,
 * because an object URL that outlives its download pins the bytes.
 * @param blob - the bytes to save.
 * @param name - the file name to save them under.
 */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    setTimeout(() => { URL.revokeObjectURL(url) }, 0)
  }
}

/**
 * The file name the Host chose for one response.
 *
 * RFC 5987 first: the plain `filename=` is an ASCII fallback, so a Chinese name
 * arrives there as a row of underscores.
 * @param disposition - the response's `content-disposition`, if it had one.
 * @returns the name, or undefined when the header names none.
 */
function attachmentName(disposition: string | null): string | undefined {
  if (disposition === null) return undefined
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (extended?.[1] !== undefined) {
    try {
      return decodeURIComponent(extended[1])
    } catch {
      // A malformed escape is not worth failing a download over; the plain form
      // below, or the caller's fallback, is used instead.
    }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition)
  return plain?.[1] === undefined || plain[1] === '' ? undefined : plain[1]
}

/**
 * The refusal one non-2xx export response carries.
 * @param response - the refused response.
 * @returns the reason the body states, or a status-derived stand-in.
 */
async function refusalOf(response: Response): Promise<{ reason: string; missing?: readonly string[] }> {
  try {
    const value = asRecord(await response.json())
    const reason = typeof value.reason === 'string' ? value.reason : 'refused'
    const missing = Array.isArray(value.missing)
      ? value.missing.filter((entry): entry is string => typeof entry === 'string')
      : undefined
    return { reason, ...missing === undefined ? {} : { missing } }
  } catch {
    return { reason: response.status === 404 ? 'nothing-produced' : 'refused' }
  }
}

/** The base name of one `work\`-relative path, as a browser would save it. */
function basenameOf(relative: string): string {
  const parts = relative.split(/[\\/]/u)
  return parts[parts.length - 1] === '' || parts[parts.length - 1] === undefined ? 'download' : parts[parts.length - 1] as string
}

/** Read one object-valued JSON field, treating anything else as absent. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Read the Host's byte budgets, falling back to this page's own default. */
function limitsOf(value: unknown): TeamLimits {
  const record = asRecord(value)
  return {
    blobMax: typeof record.blobMax === 'number' && record.blobMax > 0 ? record.blobMax : DEFAULT_BLOB_MAX,
    archiveMax: typeof record.archiveMax === 'number' ? record.archiveMax : 0,
    fileMax: typeof record.fileMax === 'number' ? record.fileMax : 0,
  }
}

/** Read the products of one manifest response, dropping anything malformed. */
function productsOf(value: unknown): readonly TeamProduct[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): TeamProduct[] => {
    const record = asRecord(entry)
    if (typeof record.path !== 'string' || typeof record.bytes !== 'number') return []
    return [{
      path: record.path,
      bytes: record.bytes,
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
      member: typeof record.member === 'string' ? record.member : null,
      turn: typeof record.turn === 'number' ? record.turn : null,
      producedAt: typeof record.producedAt === 'string' ? record.producedAt : '',
    }]
  })
}

/** Read one layout report, or undefined when the Host sent none. */
function layoutOf(value: unknown): TeamLayout | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = asRecord(value)
  const location = record.location
  if (location !== 'project' && location !== 'container' && location !== 'nested' && location !== 'outside') return undefined
  return {
    location,
    missing: Array.isArray(record.missing) ? record.missing.filter((entry): entry is string => typeof entry === 'string') : [],
    conflicts: Array.isArray(record.conflicts)
      ? record.conflicts.flatMap((entry) => {
        const conflict = asRecord(entry)
        return typeof conflict.name === 'string' && typeof conflict.kind === 'string'
          ? [{ name: conflict.name, kind: conflict.kind }]
          : []
      })
      : [],
    complete: record.complete === true,
  }
}
