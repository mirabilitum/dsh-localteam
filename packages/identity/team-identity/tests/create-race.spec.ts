/**
 * Two creators on one project, at the same time.
 *
 * The web entry, `new-project.mjs`, and the repair script all call the same
 * library, and two of them can be pointed at one directory at once — a member
 * clicking "new directory" while an operator runs the script is the ordinary
 * case, not a contrived one. The failure this guards against is the shape the
 * old script had (`existsSync` → `writeFileSync`): a second creator overwrites
 * the rules file, or reports a layout as complete that it never finished.
 *
 * A single-process test cannot produce the interleaving: the library is
 * synchronous, so nothing in this process runs between one creator's check and
 * its write. Second processes are what actually race, exactly as the deployment
 * would have them. Nothing comes back over a pipe — a sandboxed host refuses
 * piped stdio — so each creator leaves its result in a file and the parent reads
 * those after every one of them has exited.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_DIRECTORIES, PROJECT_RULES, PROJECT_RULES_FILE_NAME } from '../src/project-layout.ts'

/** How many creators race at once: enough to interleave, few enough to finish. */
const CREATORS = 4

const roots: string[] = []
const children = new Set<ChildProcess>()

afterEach(() => {
  for (const child of children) child.kill()
  children.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix))
  roots.push(created)
  return created
}

/** What one creator reports, as it wrote it down. */
interface CreatorReport {
  readonly state?: string
  readonly created?: readonly string[]
  readonly failed?: readonly { readonly path: string; readonly reason: string }[]
  readonly wroteRules?: boolean
  readonly error?: string
}

/** The library under test, as a URL the child process can import directly. */
const MODULE_URL = new URL('../src/project-layout.ts', import.meta.url).href

/** The child program: create the layout once and write down what happened. */
const CREATOR_SOURCE = [
  "import { writeFileSync } from 'node:fs'",
  'const [moduleUrl, project, resultPath] = process.argv.slice(2)',
  'try {',
  '  const mod = await import(moduleUrl)',
  '  const result = mod.ensureProjectLayout(project)',
  '  writeFileSync(resultPath, JSON.stringify({',
  '    state: result.state, created: result.created, failed: result.failed, wroteRules: result.wroteRules,',
  '  }))',
  '} catch (error) {',
  '  writeFileSync(resultPath, JSON.stringify({ error: String(error) }))',
  '}',
].join('\n')

/**
 * Run one round of creators against a project and collect their reports.
 * @param project - directory every creator is pointed at.
 * @returns each creator's report, or undefined when this host refuses to spawn.
 */
async function race(project: string): Promise<readonly CreatorReport[] | undefined> {
  const script = join(temp('dsh-create-race-src-'), 'creator.mjs')
  writeFileSync(script, CREATOR_SOURCE, 'utf8')
  const results = temp('dsh-create-race-out-')
  const paths = Array.from({ length: CREATORS }, (_, index) => join(results, `r-${String(index)}.json`))

  const started: ChildProcess[] = []
  try {
    for (const resultPath of paths) {
      // `ignore`, not a pipe: the child says nothing, it writes its report down.
      started.push(spawn(process.execPath, [script, MODULE_URL, project, resultPath], { stdio: 'ignore' }))
    }
  } catch {
    for (const child of started) child.kill()
    return undefined
  }
  for (const child of started) children.add(child)

  await Promise.all(started.map(child => new Promise<void>((resolve) => {
    child.on('exit', () => { resolve() })
    // A creator that never exits must not hang the suite: the reports are only
    // read when every one of them has stopped.
    setTimeout(() => { child.kill() }, 30_000).unref()
  })))
  for (const child of started) children.delete(child)

  return paths.map(path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as CreatorReport : { error: 'no report' }))
}

describe('two creators, one project', () => {
  it('builds one complete layout, with the rules written exactly once', async () => {
    const project = temp('dsh-create-race-')
    const reports = await race(project)
    if (reports === undefined) return

    for (const report of reports) {
      expect(report.error).toBeUndefined()
      // Nobody crashed into a half-made layout: a creator either made its part or
      // found it already there.
      expect(report.failed).toEqual([])
      expect(['created', 'already', 'partial']).toContain(report.state)
    }
    // Exclusive creation is what makes this true: the loser of the race finds
    // the file rather than overwriting it.
    expect(reports.filter(report => report.wroteRules === true)).toHaveLength(1)
    for (const name of PROJECT_DIRECTORIES) expect(lstatSync(join(project, name)).isDirectory()).toBe(true)
    expect(readFileSync(join(project, PROJECT_RULES_FILE_NAME), 'utf8')).toBe(PROJECT_RULES)
    // And nothing else was dropped into the project on the way.
    expect(readdirSync(project).sort()).toEqual([...PROJECT_DIRECTORIES, PROJECT_RULES_FILE_NAME].sort())
  }, 60_000)

  it('keeps the rules a human already wrote in that project', async () => {
    const project = temp('dsh-create-race-seeded-')
    const mine = '# 这个项目的规矩由我定\n'
    writeFileSync(join(project, PROJECT_RULES_FILE_NAME), mine, 'utf8')

    const reports = await race(project)
    if (reports === undefined) return

    // Not one of them touched it, however they interleaved.
    for (const report of reports) {
      expect(report.error).toBeUndefined()
      expect(report.wroteRules).toBe(false)
    }
    expect(readFileSync(join(project, PROJECT_RULES_FILE_NAME), 'utf8')).toBe(mine)
    for (const name of PROJECT_DIRECTORIES) expect(lstatSync(join(project, name)).isDirectory()).toBe(true)
  }, 60_000)
})
