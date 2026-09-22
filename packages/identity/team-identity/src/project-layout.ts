/**
 * The project layout: the five directories and the rules file every Session in
 * a project reads, plus the read-only inspection that says whether a directory
 * is one.
 *
 * Every writer of this layout goes through here — the browser's new-project
 * entry, `new-project.mjs`, and the explicit repair script — so the rules text
 * has exactly one source and so "was it created?" is answered the same way
 * everywhere. It is a plain module rather than a service on purpose: the
 * operator scripts run outside the Host process and have no Context to inject.
 *
 * Two properties matter more than the happy path. First, **nothing here
 * throws**: a caller that cannot scaffold must still be able to finish its own
 * job, so a refusal is a structured result, never an exception. Second,
 * **nothing here writes through a link**: a target that is a symlink or a
 * junction is reported rather than followed, because "create the directories"
 * must not become "write somewhere else on the host".
 *
 * @module @deepseek-ai/dsh-team-identity/project-layout
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalize, isWithin } from './workspace-root.ts'

/** The rules file a project carries, relative to its root. */
export const PROJECT_RULES_FILE_NAME = 'AGENTS.md'

/**
 * The directories every project has.
 *
 * `sessions` holds each conversation's private scratch tree; the other four are
 * shared. The order is the order they are created in, which is also the order
 * they are reported in.
 */
export const PROJECT_DIRECTORIES = ['input', 'build', 'work', 'logs', 'sessions'] as const

/** One directory of the layout, as {@link PROJECT_DIRECTORIES} names it. */
export type ProjectDirectory = typeof PROJECT_DIRECTORIES[number]

/**
 * The rules every Session in a project reads, stated once for all of them.
 *
 * This text is the single source: `new-project.mjs` and the repair script print
 * from it rather than carrying a copy, so a project created by the browser and
 * one created by an operator are byte-for-byte the same file.
 */
export const PROJECT_RULES = `# 这个项目的目录约定

你在这个项目里工作时，按"**能不能重新造出来**"和"**要不要交出去**"决定文件放哪。

| 目录 | 放什么 | 判据 |
|---|---|---|
| \`input\\\` | 从外面拿来的原始数据：上传的表格、对方给的数据包 | **不是我们产生的**。**只读** |
| \`build\\\` | 加工出来的大件：sqlite、清洗后的表、索引 | 能重建，但**重建有代价**（要跑很久，或要记得当初怎么建的） |
| \`work\\\` | 要交出去的成品：报告、图表、最终脚本 | **显式交付**的成果 |
| \`logs\\\` | 过程记录 | 只增不删 |
| \`sessions\\<会话>\\temp\\\` | 临时脚本、试算草稿、下载缓存 | **随手就能再造** |

按顺序问三个问题：

1. 这东西是**从外面拿来的**吗？→ \`input\\\`
2. 是**要交给人看/用的成果**吗？→ \`work\\\`
3. 丢掉以后**能不能便宜地再造**？不能 → \`build\\\`；能 → 你自己的 \`temp\\\`

## 硬规矩

- **临时文件写 \`$env:DSH_SESSION_TEMP\`**：这个环境变量就是本会话自己的 \`sessions\\<会话>\\temp\\\`，每次跑命令都会带上。**不要**把临时脚本、试算草稿、下载缓存写进 \`work\\\` —— 那是要交出去的东西，别人会当成品看。
- **\`input\\\` 只读**：要加工就在 \`build\\\` 或 \`temp\\\` 里放副本，不要就地改。
- **大件不要就地写**，尤其是 sqlite：先写到你自己的 \`temp\\\`，写完再**原子地挪进** \`build\\\`（先写临时名，再 rename）。这样别人读到的永远是一个完整的文件，不会读到一半。
- **\`work\\\` 是共享的**：所有人都看得见，也可能有人正在写。要改之前先确认没有别人在改同一个文件；同一个项目同时只有一个会话在写（服务端会拒第二个）。
- **\`temp\\\` 是你自己的**：别人不会看，也不该依赖里面的东西。
`

/** How one scaffold attempt ended. */
export type ProjectLayoutState = 'created' | 'partial' | 'already' | 'refused'

/** One target that could not be created, and why. */
export interface ProjectLayoutFailure {
  /** Absolute path of the target. */
  readonly path: string
  /**
   * Why it was refused. `work-not-a-directory` is its own reason because a
   * plain file named `work` is the one collision that silently breaks
   * downloads instead of merely looking odd.
   */
  readonly reason:
    | 'work-not-a-directory'
    | 'not-a-directory'
    | 'link-not-allowed'
    | 'rules-not-a-file'
    | 'unreadable'
    | 'create-failed'
}

/** What one {@link ensureProjectLayout} call did. */
export interface ProjectLayoutResult {
  /** The overall outcome, derived from the targets below. */
  readonly state: ProjectLayoutState
  /** Absolute paths this call created, in creation order. */
  readonly created: readonly string[]
  /** Targets this call refused to touch. */
  readonly failed: readonly ProjectLayoutFailure[]
  /** The first refusal's reason, for a caller that only shows one line. */
  readonly reason?: ProjectLayoutFailure['reason']
  /** Whether this call wrote the rules file (false when it was kept). */
  readonly wroteRules: boolean
  /** SHA-256 of the rules file as it stands now, for the operator's report. */
  readonly rulesHash?: string
}

/** What kind of place one directory is, for {@link inspectProjectLayout}. */
export type ProjectLocation = 'project' | 'container' | 'nested' | 'outside'

/** One structure problem found by {@link inspectProjectLayout}. */
export interface ProjectLayoutConflict {
  /** The expected name, as {@link PROJECT_DIRECTORIES} or the rules file spells it. */
  readonly name: string
  /** What is there instead of the expected kind of entry. */
  readonly kind: ProjectEntryProblem
}

/** How one expected entry differs from what the layout requires. */
export type ProjectEntryProblem = 'not-a-directory' | 'not-a-file' | 'link' | 'unreadable'

/** The read-only answer to "is this a project, and is it intact?". */
export interface ProjectLayoutInspection {
  /** Where `directory` sits relative to the project container. */
  readonly location: ProjectLocation
  /** Expected names that are not there at all. */
  readonly missing: readonly string[]
  /** Expected names that are there as the wrong kind of thing. */
  readonly conflicts: readonly ProjectLayoutConflict[]
  /** True when nothing is missing and nothing conflicts. */
  readonly complete: boolean
}

/** SHA-256 of one string, as lowercase hex. */
function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Create the five directories and the rules file under one project root.
 *
 * Idempotent and additive: existing targets are left exactly as they are, and
 * only what is missing is created. Where two callers race — the browser entry
 * and a repair script, say — each reports what **it** created rather than
 * claiming the whole layout, because per-target exclusivity is the strongest
 * promise that can be kept without a cross-process lock.
 * @param projectRoot - absolute project root; must already exist.
 * @param options - whether to write the rules file, and the text to write.
 * @returns the structured outcome; never throws.
 */
export function ensureProjectLayout(
  projectRoot: string,
  options: { readonly writeRules?: boolean; readonly rules?: string } = {},
): ProjectLayoutResult {
  const created: string[] = []
  const failed: ProjectLayoutFailure[] = []
  const root = canonicalize(projectRoot)
  let rootExists = true
  try {
    rootExists = lstatSync(root).isDirectory()
  } catch {
    rootExists = false
  }
  if (!rootExists) {
    return { state: 'refused', created, failed: [], reason: 'create-failed', wroteRules: false }
  }

  for (const name of PROJECT_DIRECTORIES) {
    const target = join(root, name)
    let present: ReturnType<typeof lstatSync> | undefined
    try {
      present = lstatSync(target)
    } catch {
      present = undefined
    }
    if (present !== undefined) {
      if (present.isSymbolicLink()) {
        // A link is never written through, even when it points back inside:
        // "the directory exists" and "we may add to it" are different claims.
        failed.push({ path: target, reason: 'link-not-allowed' })
        continue
      }
      if (!present.isDirectory()) {
        failed.push({ path: target, reason: name === 'work' ? 'work-not-a-directory' : 'not-a-directory' })
      }
      continue
    }
    try {
      // Exclusive by construction: `mkdir` without `recursive` fails with
      // EEXIST when another caller won the race, which is "already", not a bug.
      mkdirSync(target)
      created.push(target)
    } catch (error: unknown) {
      if (isAlreadyThere(error)) continue
      failed.push({ path: target, reason: 'create-failed' })
    }
  }

  const rulesPath = join(root, PROJECT_RULES_FILE_NAME)
  let wroteRules = false
  let rulesHash: string | undefined
  if (options.writeRules !== false) {
    const text = options.rules ?? PROJECT_RULES
    let present: ReturnType<typeof lstatSync> | undefined
    try {
      present = lstatSync(rulesPath)
    } catch {
      present = undefined
    }
    if (present === undefined) {
      try {
        // `wx` is the file half of exclusive creation: a second writer gets
        // EEXIST instead of overwriting rules it did not author.
        writeFileSync(rulesPath, text, { encoding: 'utf8', flag: 'wx' })
        wroteRules = true
        created.push(rulesPath)
      } catch (error: unknown) {
        if (!isAlreadyThere(error)) failed.push({ path: rulesPath, reason: 'create-failed' })
      }
    } else if (present.isSymbolicLink() || !present.isFile()) {
      // Nothing is read through it and nothing is written to it: reporting the
      // conflict is the whole answer for a target that is not a plain file.
      failed.push({ path: rulesPath, reason: 'rules-not-a-file' })
    }
    if (present === undefined || (!present.isSymbolicLink() && present.isFile())) {
      try {
        // Reported whether we wrote it or kept someone else's: a rollback needs
        // the hash of the file as it stands, not of the file we meant to write.
        rulesHash = hashOf(readFileSync(rulesPath, 'utf8'))
      } catch {
        failed.push({ path: rulesPath, reason: 'unreadable' })
      }
    }
  }

  const structural = failed.some(entry => STRUCTURAL_REASONS.has(entry.reason))
  const state: ProjectLayoutState = structural || failed.length > 0
    ? created.length === 0 || structural ? 'refused' : 'partial'
    : created.length === 0 ? 'already' : 'created'
  return {
    state,
    created,
    failed,
    ...failed[0] === undefined ? {} : { reason: failed[0].reason },
    wroteRules,
    ...rulesHash === undefined ? {} : { rulesHash },
  }
}

/**
 * Reasons that mean a human has to look, not that a retry might work.
 *
 * A missing directory can be created later; a directory occupied by a file or a
 * link cannot, and calling that "partial" would read as "mostly fine". The
 * overall state therefore says `refused` whenever one of these is present, even
 * though `created` still lists the targets that were made.
 */
const STRUCTURAL_REASONS: ReadonlySet<ProjectLayoutFailure['reason']> = new Set([
  'work-not-a-directory',
  'not-a-directory',
  'link-not-allowed',
  'rules-not-a-file',
])

/**
 * Whether an error is the "somebody else got there first" kind.
 *
 * A racing creator is the expected outcome under concurrency, and it is not a
 * failure: the target exists, which is all this layout needs.
 * @param error - the value thrown by the filesystem call.
 * @returns whether the target already existed.
 */
function isAlreadyThere(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

/**
 * Inspect a directory without changing anything.
 *
 * The two questions a caller needs answered are kept apart on purpose: **where**
 * the directory sits decides which messages even apply, and **whether the
 * layout is intact** decides if the project is usable. Folding them together is
 * what produced the original bug report — "structure is broken" was being shown
 * as "you picked the wrong directory".
 * @param directory - absolute directory to inspect.
 * @param projectsRoot - absolute project container.
 * @returns where the directory is, and what the layout is missing or has wrong.
 */
export function inspectProjectLayout(directory: string, projectsRoot: string): ProjectLayoutInspection {
  const target = canonicalize(directory)
  const root = canonicalize(projectsRoot)
  const inside = isWithin(root, target)
  let location: ProjectLocation
  if (target === root) location = 'container'
  else if (inside) location = dirname(target) === root ? 'project' : 'nested'
  else location = 'outside'

  const missing: string[] = []
  const conflicts: ProjectLayoutConflict[] = []
  for (const name of PROJECT_DIRECTORIES) {
    const state = describeEntry(join(target, name), 'directory')
    if (state === 'missing') missing.push(name)
    else if (state !== 'ok') conflicts.push({ name, kind: state })
  }
  const rules = describeEntry(join(target, PROJECT_RULES_FILE_NAME), 'file')
  if (rules === 'missing') missing.push(PROJECT_RULES_FILE_NAME)
  else if (rules !== 'ok') conflicts.push({ name: PROJECT_RULES_FILE_NAME, kind: rules })

  return { location, missing, conflicts, complete: missing.length === 0 && conflicts.length === 0 }
}

/**
 * Classify one expected entry.
 *
 * A link counts as a conflict rather than a match: the download side refuses to
 * read through one, so calling a linked directory "present" would promise a
 * project that downloads cannot serve. An unreadable rules file is a conflict
 * too — the model would not be instructed by a file nobody can open.
 * @param path - absolute path of the expected entry.
 * @param expected - what it has to be.
 * @returns whether it is there, absent, or there as something else.
 */
function describeEntry(
  path: string,
  expected: 'directory' | 'file',
): 'ok' | 'missing' | ProjectEntryProblem {
  let present: ReturnType<typeof lstatSync>
  try {
    present = lstatSync(path)
  } catch {
    return 'missing'
  }
  if (present.isSymbolicLink()) return 'link'
  if (expected === 'directory') return present.isDirectory() ? 'ok' : 'not-a-directory'
  if (!present.isFile()) return 'not-a-file'
  try {
    readFileSync(path)
    return 'ok'
  } catch {
    return 'unreadable'
  }
}
