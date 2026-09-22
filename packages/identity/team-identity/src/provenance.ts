/**
 * Who produced what: the ledger that makes "this conversation's output" a fact
 * rather than a guess.
 *
 * A shared `work\` directory is the collaboration surface — one member's report
 * must be visible to the next one immediately — but a shared directory is not
 * the same thing as "what *this* conversation produced". Something has to answer
 * which conversation, which member, and which turn wrote a file, or a packaged
 * download can only hand over the whole project.
 *
 * The answer is a turn log appended to the project's own `provenance.jsonl`:
 * every member-issued prompt is one line, written before the Agent runs, so the
 * turn's start time is recorded independently of what the Agent then does. A file
 * is attributed to the newest turn that had already started when the file was
 * last written.
 *
 * Two honest limits, both deliberate:
 *
 * - **Attribution is by time**, not by observing the write. DSH's file tools run
 *   inside an Agent turn, not inside a Remote call, so no layer here sees a write
 *   and its caller together. A file copied in with a preserved timestamp, or
 *   written by hand outside any turn, is reported as unattributed rather than
 *   guessed at. The comparison is also only as sharp as a file timestamp: a turn
 *   recorded within a millisecond or two of a file's own time cannot be ordered
 *   against it, and the newer turn wins. Prompts are seconds apart, so this
 *   bounds the mechanism's resolution rather than its usefulness.
 * - **A product record is derived, not stored.** The log holds turns; the product
 *   list is computed from the log plus the directory as it is now, so an
 *   overwritten file reports the attribution of the version that is actually
 *   there. Versioned history is out of scope this round.
 *
 * @module @deepseek-ai/dsh-team-identity/provenance
 */

import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistFailureReporter } from './registry.ts'
import { isWithin } from './workspace-root.ts'

/** The project-level ledger's file name, as the workspace layout defines it. */
export const PROVENANCE_FILE_NAME = 'provenance.jsonl'

/** The only directory whose contents may be handed over. */
const WORK_DIRECTORY = 'work'

/** One member-issued turn, as the ledger stores it. */
export interface ProvenanceTurn {
  readonly kind: 'turn'
  readonly sessionId: string
  readonly member: string
  /** 1-based index of this turn within its own conversation. */
  readonly turn: number
  /** ISO timestamp the turn started at. */
  readonly at: string
}

/**
 * One file in `work\`, with the turn that most plausibly produced it.
 *
 * `sessionId`, `member`, and `turn` are null together for a file no recorded turn
 * can claim — see the module note on why that is reported rather than guessed.
 */
export interface ProvenanceProduct {
  /** Path as the archive spells it: `work/…`, `/`-separated, relative to the project. */
  readonly path: string
  readonly sessionId: string | null
  readonly member: string | null
  readonly turn: number | null
  /** The file's own modification time, which is what the attribution was made from. */
  readonly producedAt: string
  readonly bytes: number
}

/** How much of a conversation's output to include. */
export type ProvenanceScope = 'all' | 'latest'

/**
 * Why one project's `work\` could not be read.
 *
 * `work-escapes-project` is its own reason, and not a flavour of "unreadable":
 * the directory is readable, it is simply not inside the project, so the answer
 * is "refused" rather than "try again".
 */
export type WorkScanFailure = 'unreadable' | 'work-escapes-project'

/**
 * What one read of a project's `work\` found.
 *
 * A project with no `work\` is `ok` with no products — that is what "has not
 * produced anything yet" means — while a directory that cannot be listed or
 * that points out of the project is a failure the caller must report as itself.
 */
export type WorkScan =
  | { readonly ok: true; readonly products: readonly ProvenanceProduct[] }
  | { readonly ok: false; readonly reason: WorkScanFailure }

/**
 * Read the ledger and attribute the project's current `work\` to it.
 *
 * The project root is resolved by the caller from the Session, never from a
 * request: a member names a conversation, and the directory follows from it.
 */
export class ProvenanceLedger {
  /**
   * @param projectOf - resolves one conversation's project directory.
   * @param onFailure - told when a turn could not be recorded; defaults to silence,
   * because the service that owns this passes its own reporter.
   */
  constructor(
    private readonly projectOf: (sessionId: string) => string | undefined,
    private readonly onFailure?: PersistFailureReporter,
  ) {}

  /**
   * Append one prompt to the project's ledger.
   *
   * Written before the Agent runs, so a file the turn produces is always newer
   * than the record that claims it. A failure here must never refuse the prompt:
   * the ledger is provenance, and losing it costs attribution, not the work.
   * @param sessionId - conversation the prompt was issued on.
   * @param member - member the transport resolved as the caller.
   * @param at - when the turn started; defaults to now.
   * @returns the turn's number, or undefined when nothing could be written.
   */
  recordTurn(sessionId: string, member: string, at: number = Date.now()): number | undefined {
    const project = this.projectOf(sessionId)
    if (project === undefined) return undefined
    try {
      // Numbered within the conversation, so "turn 3" means the same thing to
      // every reader, and a second conversation in the same project does not
      // renumber the first one's history.
      const previous = this.readTurns(project).filter(turn => turn.sessionId === sessionId).length
      const turn: ProvenanceTurn = {
        kind: 'turn',
        sessionId,
        member,
        turn: previous + 1,
        at: new Date(at).toISOString(),
      }
      appendFileSync(join(project, PROVENANCE_FILE_NAME), `${JSON.stringify(turn)}\n`, 'utf8')
      return turn.turn
    } catch (error) {
      this.onFailure?.(error)
      return undefined
    }
  }

  /**
   * Read one project's turn log.
   *
   * A missing ledger is an empty one — a project that has never been prompted
   * into is not an error. A malformed line is skipped rather than fatal, for the
   * same reason the token registry starts clean on a damaged file: the ledger
   * must never be able to take the deployment down.
   * @param project - the project directory.
   * @returns the turns in the order they were written.
   */
  readTurns(project: string): readonly ProvenanceTurn[] {
    let text: string
    try {
      text = readFileSync(join(project, PROVENANCE_FILE_NAME), 'utf8')
    } catch {
      return []
    }
    const turns: ProvenanceTurn[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const record = parsed as Partial<ProvenanceTurn>
      if (record.kind !== 'turn') continue
      if (typeof record.sessionId !== 'string' || typeof record.member !== 'string') continue
      if (typeof record.turn !== 'number' || typeof record.at !== 'string') continue
      turns.push({
        kind: 'turn',
        sessionId: record.sessionId,
        member: record.member,
        turn: record.turn,
        at: record.at,
      })
    }
    return turns
  }

  /**
   * Read one project's `work\` directory and attribute what is in it.
   *
   * The directory is read as it is now, so the answer describes the bytes a
   * download would actually contain. Symbolic links inside it are skipped
   * instead of followed: a link under `work\` is the one way a file there could
   * really live somewhere else, and "hand over the workspace" must not become
   * "hand over the host".
   *
   * The **container itself** is checked the same way before anything is listed.
   * `isWithin` canonicalizes both sides, so a `work\` that is itself a junction
   * out of the project fails this check — the escape a per-entry symlink test
   * cannot see, because it is in the container rather than in a row.
   * @param project - the project directory.
   * @param scope - `all` for the whole conversation history, `latest` for the
   * newest turn of each conversation only.
   * @returns the products, or why the directory could not be read.
   */
  scanWork(project: string, scope: ProvenanceScope = 'all'): WorkScan {
    const root = join(project, WORK_DIRECTORY)
    if (!isWithin(project, root)) return { ok: false, reason: 'work-escapes-project' }
    let present: ReturnType<typeof lstatSync> | undefined
    try {
      present = lstatSync(root)
    } catch {
      present = undefined
    }
    // A project that never produced anything is not an error, and "nothing was
    // produced" is a different fact from "here is an empty archive".
    if (present === undefined) return { ok: true, products: [] }
    let files: readonly WalkedFile[]
    try {
      files = walkFiles(root)
    } catch {
      // Unreadable is its own answer: reporting it as "nothing produced" would
      // send an operator to wait for output from a directory nobody can open.
      return { ok: false, reason: 'unreadable' }
    }
    const turns = this.readTurns(project)
    const products: ProvenanceProduct[] = []
    for (const file of files) {
      const attribution = attribute(turns, file.modifiedMs)
      products.push({
        path: `${WORK_DIRECTORY}/${file.relative}`,
        sessionId: attribution?.sessionId ?? null,
        member: attribution?.member ?? null,
        turn: attribution?.turn ?? null,
        producedAt: new Date(file.modifiedMs).toISOString(),
        bytes: file.bytes,
      })
    }
    if (scope === 'all') return { ok: true, products }
    // "Latest" is per conversation: two members working in one project each have
    // their own newest turn, and neither one's output is the other's to drop.
    const newest = new Map<string, number>()
    for (const turn of turns) {
      newest.set(turn.sessionId, Math.max(newest.get(turn.sessionId) ?? 0, turn.turn))
    }
    return {
      ok: true,
      products: products.filter(product => product.sessionId !== null
        && product.turn !== null
        && newest.get(product.sessionId) === product.turn),
    }
  }
}

/** One file inside `work\`, as the walk reports it. */
interface WalkedFile {
  /** `/`-separated path relative to `work\`. */
  readonly relative: string
  readonly modifiedMs: number
  readonly bytes: number
}

/**
 * List the regular files under one directory, recursively.
 *
 * Symlinks of any kind are skipped, and anything that canonicalizes outside the
 * root is skipped with them, so the caller can trust that every returned path is
 * a file that really is there.
 * @param root - directory to walk; the caller has already established it exists.
 * @returns the files found.
 * @throws when a level cannot be listed — an unreadable directory is not an
 *   empty one, and the caller has to be able to tell the two apart.
 */
function walkFiles(root: string): readonly WalkedFile[] {
  const found: WalkedFile[] = []
  const visit = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (isWithin(root, absolute)) visit(absolute, relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!isWithin(root, absolute)) continue
      try {
        const stats = lstatSync(absolute)
        found.push({ relative, modifiedMs: stats.mtimeMs, bytes: stats.size })
      } catch {
        // Vanished between listing and reading: nothing to hand over.
      }
    }
  }
  visit(root, '')
  return found.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0))
}

/**
 * Find the newest turn that had started when a file was last written.
 * @param turns - the project's turn log, in write order.
 * @param modifiedMs - the file's modification time.
 * @returns the most recent qualifying turn, or undefined when none does.
 */
function attribute(turns: readonly ProvenanceTurn[], modifiedMs: number): ProvenanceTurn | undefined {
  let best: ProvenanceTurn | undefined
  let bestAt = Number.NEGATIVE_INFINITY
  for (const turn of turns) {
    const at = Date.parse(turn.at)
    if (Number.isNaN(at) || at > modifiedMs) continue
    // `>=` keeps the later-written of two turns sharing one timestamp.
    if (at >= bestAt) {
      best = turn
      bestAt = at
    }
  }
  return best
}
