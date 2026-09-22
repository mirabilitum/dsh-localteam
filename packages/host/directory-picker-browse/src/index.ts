/**
 * Browse backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `browse` capability — one-level directory listing and child-directory
 * creation over the host filesystem via Node's stdlib (which already carries
 * the per-OS adaptation). Nothing renders on the host display, so this backend
 * serves remote clients the dialog backend cannot. Policy decisions (hidden
 * entries flagged but returned, symlinks followed) are recorded in the
 * directory-picker seam Agent Note; the scope is the whole filesystem unless
 * `root` confines it, which is how a deployment serves browsers it does not
 * control without handing them every directory on the host.
 * @module @deepseek-ai/dsh-host-directory-picker-browse
 */

import { mkdir, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DirectoryPicker, DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry, DirectoryListing, DirectoryPickerCapability, DirectoryPickerErrorCode,
} from '@deepseek-ai/dsh-host-directory-picker'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One directory was just created, and the create call is waiting for this to
     * finish before it returns.
     *
     * Dispatched with `ctx.parallel` rather than `ctx.emit` on purpose: a
     * deployment that gives new projects a layout has to have that layout on
     * disk by the time the browser's create call returns, or the very next
     * Session can be created in a directory with no rules in it. The dispatcher
     * contains a listener's failure — the directory exists either way, so a
     * refused post-create step must not be reported as a failed create.
     * @param target - absolute path of the directory that was created.
     * @mode parallel
     */
    'directory-picker/created'(target: string): void
  }
}

/**
 * Ancestor chain from the filesystem root — or from `stopAt` — to `target`
 * inclusive: the breadcrumb rows of a listing, every one a jump target.
 * @param target - the directory being listed.
 * @param stopAt - highest ancestor to include; omitted walks to the filesystem root.
 * @returns the chain, root-first.
 */
function ancestryCrumbs(target: string, stopAt?: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    // basename of a root is '' — label the root crumb by its full path ('/', 'C:\').
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    if (stopAt !== undefined && current === stopAt) return crumbs
    current = parent
  }
}

/**
 * Whether `candidate` is `root` itself or lies beneath it.
 *
 * Both arguments must already be canonical: a symlink inside the root that
 * points outside it would otherwise pass a purely lexical check.
 * @param root - canonical root directory.
 * @param candidate - canonical candidate path.
 * @returns whether the candidate stays inside the root.
 */
function containsDirectory(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\…`) or complete UNC (`\\server\share…`) forms. Rooted drive-less
 * forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`)
 * pass `isAbsolute` yet still resolve against the process's current drive.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/** One streamed listing candidate: the dirent facts a row needs, nothing else retained. */
export interface ListingCandidate {
  /** Base name within the streamed level. */
  name: string
  /** Dirent says directory (no probe needed). */
  isDirectory: boolean
  /** Dirent says symlink (enterability needs a stat probe). */
  isSymbolicLink: boolean
}

/**
 * Insert a streamed candidate into the name-sorted bounded window, evicting
 * the name-largest candidate when the window exceeds `keep`. Memory over an
 * arbitrarily large level therefore stays O(keep) regardless of how many
 * children the directory holds.
 * @param window - the name-ascending window, mutated in place.
 * @param candidate - the streamed candidate to place.
 * @param keep - the window bound.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
export function boundedInsert(window: ListingCandidate[], candidate: ListingCandidate, keep: number): boolean {
  // Full window, name at or beyond the tail: one comparison rejects, so an
  // oversized level costs O(1) per candidate past the head instead of a
  // window scan (100k children against a 1,001 window must not approach
  // 10^8 comparisons).
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a full window (length === keep >= 1) has a tail
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1]!.name) >= 0) return true
  // Binary insertion keeps a retained candidate at O(log keep) comparisons.
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. Node's filesystem reads are not retractable, so the operation
 * itself keeps running against a handle the caller then closes — its late
 * settlement is swallowed here so an abandoned read cannot surface as an
 * unhandled rejection.
 * @param operation - the in-flight filesystem step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned read: its handle is being closed by the aborting caller,
        // and the abort reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/* v8 ignore start -- a close failure of an abandoned handle has no consumer, and forcing one needs a filesystem torn down mid-request. */
/** Swallow the close failure of a handle its caller already departed. */
function swallowCloseFailure(): void {}
/* v8 ignore stop */

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/**
 * One listing row for a dirent, following symlinks to directories; null for
 * non-directories and broken/cyclic links (skipped silently — the browser
 * shows what can be entered, and a broken link cannot).
 */
async function directoryRow(
  parent: string, name: string, isDirectory: boolean, isSymbolicLink: boolean, signal: AbortSignal | undefined,
): Promise<DirectoryEntry | null> {
  const path = join(parent, name)
  let enterable = isDirectory
  if (!enterable && isSymbolicLink) {
    try {
      // The probe races the caller too: a symlink target on a stalled
      // network filesystem must not keep a departed caller's request alive.
      enterable = (await raceAbort(stat(path), signal)).isDirectory()
    } catch {
      /* v8 ignore next 2 -- an abort landing mid-probe needs a stalled stat; the per-candidate check in list covers the settled path. */
      if (signal?.aborted) throw asError(signal.reason)
      // Broken or cyclic symlink: stat is the probe, failure means "not enterable".
      return null
    }
  }
  if (!enterable) return null
  // POSIX hidden convention; Windows' hidden attribute is not exposed by
  // dirents (Known Limitations). The client owns whether hidden rows show.
  return { name, path, hidden: name.startsWith('.') }
}

/** Complete-result bound of one listing level when a deployment states none. */
const DEFAULT_MAX_ENTRIES = 1000

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. @default DEFAULT_MAX_ENTRIES */
  maxEntries?: number | null
  /**
   * Directory the whole interaction is confined to.
   *
   * Omitted means the backend keeps the seam's whole-filesystem scope, which is
   * right for a loopback-only host whose chooser serves the person at the
   * console. A deployment that serves browsers it does not control sets this so
   * a remote visitor cannot make any directory on the host their workspace.
   */
  root?: string | null
}

/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  /**
   * `maxEntries` bounds the complete listing level a single `list` call may
   * materialize and put on the wire: at most this many child-directory rows
   * (hidden rows included), with `truncated` flagging a cut level. The
   * default follows GitHub's web UI, which truncates directory listings at
   * 1,000 entries. `root` confines the whole interaction when set.
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(DEFAULT_MAX_ENTRIES),
    root: z.string(),
  })

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
  }

  /** Resolved level bound; the schema default is the usual source. */
  private readonly maxEntries: number

  /** Memoized canonical `root`; undefined when no root is configured. */
  private rootPath: Promise<string> | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    // The schema already filled this; the fallback covers a hand-built tree that
    // bypassed it, so the class never reads a bound that could be undefined.
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  /**
   * Canonical configured root, or undefined when the deployment set none.
   *
   * Canonical, not as written: the confinement below compares real paths, and a
   * textual root would be escaped by any symlinked ancestor. The resolution is
   * memoized on success only — an operator who creates a missing root should not
   * have to restart the process.
   * @returns the canonical root, or undefined for an unfenced deployment.
   */
  private async resolveRoot(): Promise<string | undefined> {
    const configured = this.config.root
    if (configured === undefined || configured === null || configured === '') return undefined
    this.rootPath ??= realpath(resolve(configured)).catch((error: unknown) => {
      this.rootPath = undefined
      throw new DirectoryPickerError(
        'directory-unreadable', configured, `configured root "${configured}" cannot be resolved: ${messageOf(error)}`,
      )
    })
    return await this.rootPath
  }

  /**
   * Canonicalize one path and refuse it when it leaves the configured root.
   *
   * An unfenced deployment gets the path back exactly as resolved, so the
   * whole-filesystem behavior is unchanged in both value and failure mode.
   * @param target - the resolved path to check.
   * @param requested - the path as the caller named it, for the error message.
   * @param code - error code the caller's operation reports.
   * @param action - leading verb of the error message.
   * @returns the canonical path, or the resolved one when nothing is configured.
   */
  private async confine(
    target: string, requested: string, code: DirectoryPickerErrorCode, action: string,
  ): Promise<string> {
    const root = await this.resolveRoot()
    if (root === undefined) return target
    let canonical: string
    try {
      canonical = await realpath(target)
    } catch (error: unknown) {
      throw new DirectoryPickerError(code, requested, `${action} ${requested}: ${messageOf(error)}`)
    }
    if (!containsDirectory(root, canonical)) {
      throw new DirectoryPickerError(code, requested, `${action} ${requested}: outside the configured root ${root}`)
    }
    return canonical
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const root = await this.resolveRoot()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    // An unfenced deployment opens on the operator's home; a fenced one opens on
    // the fence, so the first listing is already inside it and the browser's
    // home affordance cannot point outside.
    const home = root ?? homedir()
    const target = await this.confine(resolve(path ?? home), path ?? home, 'directory-unreadable', 'cannot list')
    // Stream the level (opendir, one dirent at a time) into a name-sorted
    // window of maxEntries + 1 candidates: memory stays bounded no matter how
    // many children the directory holds, the window keeps the name-sorted
    // head, and the +1 slot lets an in-window extra row prove the cut. A
    // window candidate that turns out non-enterable (broken symlink) is not
    // backfilled from beyond the window — an eviction already marks the
    // level truncated, which stays the honest answer.
    const keep = this.maxEntries + 1
    const window: ListingCandidate[] = []
    let evicted = false
    try {
      // Every filesystem await races the caller's signal: a stalled
      // opendir/read on a network filesystem must not keep a departed
      // caller's scan alive, and an already-aborted request rejects even
      // when the level is empty.
      const opening = opendir(target)
      const level = await raceAbort(opening, signal).catch((error: unknown) => {
        // The abandoned open can still mint a handle after the abort won;
        // close it so a departed caller cannot leak a descriptor. (A lost
        // race against opendir's own rejection has nothing to close, and
        // the close's own failure is swallowed — the request already
        // returned, so a cleanup error has no consumer.)
        void opening.then(dir => dir.close().catch(swallowCloseFailure), () => {
          // Already rejected: raceAbort surfaced or swallowed it.
        })
        throw error
      })
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal)
          if (dirent === null) break
          // Only rows a browser could enter contend for the window; dirent
          // says "directory" outright, a symlink needs the later stat probe.
          if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
          const candidate = { name: dirent.name, isDirectory: dirent.isDirectory(), isSymbolicLink: dirent.isSymbolicLink() }
          if (boundedInsert(window, candidate, keep)) evicted = true
        }
      } finally {
        // Manual read() never auto-closes; close on every exit. The aborted
        // exit must not await it — Node queues close behind any in-flight
        // read, so awaiting would chain the departed caller back onto the
        // very stall the abort escaped (the abandoned read's settlement is
        // already swallowed by raceAbort).
        const closing = level.close()
        /* v8 ignore next 3 -- an abort between open and close needs a stalled read; the abandoned-close arm has no observable outcome. */
        if (signal?.aborted) {
          closing.catch(swallowCloseFailure)
        } else {
          await closing
        }
      }
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      // A caller that departed between reads and probes stops before the
      // next probe (each probe's own await is raced inside directoryRow).
      signal?.throwIfAborted()
      const row = await directoryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal)
      if (row === null) continue
      if (entries.length === this.maxEntries) {
        truncated = true
        break
      }
      entries.push(row)
    }
    return { path: target, home, crumbs: ancestryCrumbs(target, root), entries, truncated }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    // Same fully-qualified fence as list: never rebase a parent under the
    // cwd or the current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    // The parent is confined before the child is named, so a fenced deployment
    // cannot be walked out of one segment at a time.
    const parent = await this.confine(resolve(path), path, 'directory-create-failed', 'cannot create under')
    // The backend owns segment validation; the Remote controller also refuses
    // invalid wire input, but direct service consumers must hit the same fence.
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = join(parent, name)
    try {
      // Non-recursive: the parent is the directory the browser is showing, so
      // a missing parent is a real failure, not a level to invent.
      await mkdir(target)
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
    await this.announceCreated(target)
    return target
  }

  /**
   * Wait for the deployment's post-create step, if it has one.
   *
   * Awaited, not fired and forgotten: the caller's next move is to select this
   * directory as a Session's workspace, and a project layout that lands after
   * that would be a project without rules. A listener that fails is logged and
   * swallowed — the directory is already there, and reporting it as a failed
   * create would be a lie the user cannot act on.
   * @param target - absolute path of the directory that was created.
   */
  private async announceCreated(target: string): Promise<void> {
    try {
      await this.ctx.parallel('directory-picker/created', target)
    } catch (error: unknown) {
      this.ctx.logger.warn(`directory-picker: post-create handling failed for ${target}: ${messageOf(error)}`)
    }
  }
}
