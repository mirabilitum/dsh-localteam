/**
 * The project layout library.
 *
 * What is worth protecting: the five directories and the rules file appear
 * exactly once and are never overwritten, a target that is a link or the wrong
 * kind of entry is refused rather than written through, a refusal is a value
 * rather than an exception, and the read-only inspection keeps "where is this
 * directory" apart from "is the layout intact".
 */

import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROJECT_DIRECTORIES,
  PROJECT_RULES,
  PROJECT_RULES_FILE_NAME,
  ensureProjectLayout,
  inspectProjectLayout,
} from '../src/project-layout.ts'

const roots: string[] = []

function temp(prefix: string): string {
  // Canonical, because the library reports canonical paths and a Windows temp
  // directory may be handed back under its 8.3 short name.
  const created = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(created)
  return created
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A project container holding one empty project directory. */
function container(): { readonly root: string; readonly project: string } {
  const root = temp('dsh-layout-')
  const project = join(root, 'P')
  mkdirSync(project)
  return { root, project }
}

/** SHA-256 as the library reports it, so the expectation is not a copy of the code. */
function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Create a directory link, or report that this host will not allow one. */
function linkDirectory(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'junction')
    return true
  } catch {
    // Windows denies unprivileged links in some configurations; the case is
    // then simply not exercised here.
    return false
  }
}

describe('ensuring a project layout', () => {
  it('creates the five directories and the rules file', () => {
    const { project } = container()
    const result = ensureProjectLayout(project)

    expect(result.state).toBe('created')
    expect(result.failed).toEqual([])
    expect(result.wroteRules).toBe(true)
    expect(result.rulesHash).toBe(hash(PROJECT_RULES))
    for (const name of PROJECT_DIRECTORIES) {
      expect(lstatSync(join(project, name)).isDirectory()).toBe(true)
    }
    expect(readFileSync(join(project, PROJECT_RULES_FILE_NAME), 'utf8')).toBe(PROJECT_RULES)
  })

  it('leaves a complete layout alone and reports it as already', () => {
    const { project } = container()
    ensureProjectLayout(project)
    const second = ensureProjectLayout(project)

    expect(second.state).toBe('already')
    expect(second.created).toEqual([])
    expect(second.failed).toEqual([])
    expect(second.wroteRules).toBe(false)
  })

  it('keeps rules a member has edited', () => {
    const { project } = container()
    const mine = '# 我自己的规矩\n'
    writeFileSync(join(project, PROJECT_RULES_FILE_NAME), mine, 'utf8')

    const result = ensureProjectLayout(project)

    // Not overwritten, and the reported hash describes what is actually there.
    expect(readFileSync(join(project, PROJECT_RULES_FILE_NAME), 'utf8')).toBe(mine)
    expect(result.wroteRules).toBe(false)
    expect(result.rulesHash).toBe(hash(mine))
  })

  it('refuses a plain file where work belongs', () => {
    const { project } = container()
    writeFileSync(join(project, 'work'), 'not a directory')

    const result = ensureProjectLayout(project)

    expect(result.state).toBe('refused')
    expect(result.reason).toBe('work-not-a-directory')
    // `created` still reports what was made; only `work` was refused.
    expect(result.created).not.toContain(join(project, 'work'))
    expect(result.created).toHaveLength(PROJECT_DIRECTORIES.length)
    expect(result.failed.map(entry => entry.path)).toEqual([join(project, 'work')])
    // The file is left exactly as it was.
    expect(readFileSync(join(project, 'work'), 'utf8')).toBe('not a directory')
  })

  it('refuses the whole layout when one target is occupied by a file', () => {
    const { project } = container()
    writeFileSync(join(project, 'input'), 'not a directory')

    const result = ensureProjectLayout(project)

    // The state says a human has to look; `created` still says what was made.
    expect(result.state).toBe('refused')
    expect(result.reason).toBe('not-a-directory')
    expect(result.created).toContain(join(project, 'work'))
    expect(result.created).toContain(join(project, PROJECT_RULES_FILE_NAME))
    expect(result.failed.map(entry => entry.path)).toEqual([join(project, 'input')])
    expect(readFileSync(join(project, 'input'), 'utf8')).toBe('not a directory')
  })

  it('refuses to write through a link', () => {
    const { project } = container()
    const outside = temp('dsh-layout-outside-')
    if (!linkDirectory(outside, join(project, 'input'))) return

    const result = ensureProjectLayout(project)

    expect(result.state).toBe('refused')
    expect(result.failed).toEqual([{ path: join(project, 'input'), reason: 'link-not-allowed' }])
    // Nothing was created outside, and the link itself was not followed.
    expect(existsSync(join(outside, 'build'))).toBe(false)
    expect(lstatSync(join(project, 'input')).isSymbolicLink()).toBe(true)
  })

  it('refuses a rules file that is not a file', () => {
    const { project } = container()
    mkdirSync(join(project, PROJECT_RULES_FILE_NAME))

    const result = ensureProjectLayout(project)

    expect(result.failed).toEqual([{ path: join(project, PROJECT_RULES_FILE_NAME), reason: 'rules-not-a-file' }])
    // A refusal, not "mostly fine": nothing was written to it either.
    expect(result.state).toBe('refused')
    expect(result.wroteRules).toBe(false)
    expect(result.rulesHash).toBeUndefined()
    expect(lstatSync(join(project, PROJECT_RULES_FILE_NAME)).isDirectory()).toBe(true)
  })

  it('refuses a project root that is not there', () => {
    const missing = join(temp('dsh-layout-'), 'no-such-project')
    const result = ensureProjectLayout(missing)

    expect(result.state).toBe('refused')
    expect(result.created).toEqual([])
    expect(existsSync(missing)).toBe(false)
  })

  it('can skip the rules file', () => {
    const { project } = container()
    const result = ensureProjectLayout(project, { writeRules: false })

    expect(result.state).toBe('created')
    expect(result.wroteRules).toBe(false)
    expect(result.rulesHash).toBeUndefined()
    expect(existsSync(join(project, PROJECT_RULES_FILE_NAME))).toBe(false)
  })

  it('finishes a layout somebody else started, over the top of what is there', () => {
    const { project } = container()
    // Exactly the interleaving two creators produce: part of the layout already
    // exists when the second one looks. It must complete the rest, keep what it
    // found, and report which of the two it did.
    mkdirSync(join(project, 'work'))
    writeFileSync(join(project, 'work', 'kept.txt'), 'kept', 'utf8')

    const result = ensureProjectLayout(project)

    expect(result.state).toBe('created')
    // It reports what **this** call made, in creation order, and the directory it
    // found is not among them.
    expect(result.created).toEqual([
      join(project, 'input'),
      join(project, 'build'),
      join(project, 'logs'),
      join(project, 'sessions'),
      join(project, PROJECT_RULES_FILE_NAME),
    ])
    expect(result.wroteRules).toBe(true)
    expect(readFileSync(join(project, 'work', 'kept.txt'), 'utf8')).toBe('kept')
  })
})

describe('inspecting a project layout', () => {
  it('separates where a directory is from whether it is intact', () => {
    const { root, project } = container()
    expect(inspectProjectLayout(root, root).location).toBe('container')
    expect(inspectProjectLayout(project, root).location).toBe('project')
    const nested = join(project, 'sub')
    mkdirSync(nested)
    expect(inspectProjectLayout(nested, root).location).toBe('nested')
    expect(inspectProjectLayout(temp('dsh-layout-elsewhere-'), root).location).toBe('outside')
  })

  it('reports a complete project as complete', () => {
    const { root, project } = container()
    ensureProjectLayout(project)

    expect(inspectProjectLayout(project, root)).toMatchObject({ location: 'project', missing: [], conflicts: [], complete: true })
  })

  it('names what is missing', () => {
    const { root, project } = container()
    ensureProjectLayout(project)
    rmSync(join(project, 'sessions'), { recursive: true })

    const inspection = inspectProjectLayout(project, root)

    expect(inspection.missing).toEqual(['sessions'])
    expect(inspection.complete).toBe(false)
  })

  it('reports a file where a directory belongs instead of calling it present', () => {
    const { root, project } = container()
    ensureProjectLayout(project)
    rmSync(join(project, 'input'), { recursive: true })
    writeFileSync(join(project, 'input'), 'not a directory')

    expect(inspectProjectLayout(project, root).conflicts).toEqual([{ name: 'input', kind: 'not-a-directory' }])
  })

  it('reports rules that are not a readable file', () => {
    const { root, project } = container()
    ensureProjectLayout(project)
    rmSync(join(project, PROJECT_RULES_FILE_NAME))
    mkdirSync(join(project, PROJECT_RULES_FILE_NAME))

    expect(inspectProjectLayout(project, root).conflicts)
      .toEqual([{ name: PROJECT_RULES_FILE_NAME, kind: 'not-a-file' }])
  })

  it('reports a linked directory as a conflict rather than a match', () => {
    const { root, project } = container()
    ensureProjectLayout(project)
    rmSync(join(project, 'logs'), { recursive: true })
    const outside = temp('dsh-layout-linked-')
    if (!linkDirectory(outside, join(project, 'logs'))) return

    expect(inspectProjectLayout(project, root).conflicts).toEqual([{ name: 'logs', kind: 'link' }])
  })
})
