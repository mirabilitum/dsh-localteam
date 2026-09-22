/**
 * Where a Session's workspace may live.
 *
 * The cases worth protecting: a directory under the root is allowed at any
 * depth, a sibling or a parent is not, a directory that does not exist yet is
 * still judged by where it would land, and a junction pointing out of the root
 * does not become an entry to the outside.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonicalize, isWithin } from '../src/workspace-root.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-workspace-root-'))
const outside = mkdtempSync(join(tmpdir(), 'dsh-workspace-outside-'))
mkdirSync(join(root, 'projects', 'alpha'), { recursive: true })
mkdirSync(join(outside, 'elsewhere'), { recursive: true })

let junctionCreated = false
try {
  symlinkSync(outside, join(root, 'escape'), 'junction')
  junctionCreated = true
} catch {
  // Windows denies unprivileged links in some configurations; the escape case is
  // then simply not exercised here.
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('a workspace root', () => {
  it('admits the root itself and anything under it', () => {
    expect(isWithin(root, root)).toBe(true)
    expect(isWithin(root, join(root, 'projects'))).toBe(true)
    expect(isWithin(root, join(root, 'projects', 'alpha'))).toBe(true)
  })

  it('refuses a parent, a sibling, and an unrelated directory', () => {
    expect(isWithin(root, join(root, '..'))).toBe(false)
    expect(isWithin(root, outside)).toBe(false)
    expect(isWithin(root, join(outside, 'elsewhere'))).toBe(false)
    expect(isWithin(root, tmpdir())).toBe(false)
  })

  it('judges a directory that does not exist yet by where it would land', () => {
    // A Session's workspace usually does not exist on first use, so the check
    // cannot require the path to be there.
    expect(isWithin(root, join(root, 'projects', 'not-created-yet'))).toBe(true)
    expect(isWithin(root, join(outside, 'not-created-yet'))).toBe(false)
    expect(isWithin(root, join(root, 'projects', '..', '..', '..'))).toBe(false)
  })

  it('resolves the existing part of a path, so a traversal cannot hide in it', () => {
    const viaParent = join(root, 'projects', '..', '..', 'outside-not-real')
    expect(isWithin(root, viaParent)).toBe(false)
    // Compared against the canonical temp directory, not the string `tmpdir()`
    // returned: on Windows that is the short name, and canonicalizing is exactly
    // what turns it back into the long one.
    expect(canonicalize(viaParent)).toBe(join(realpathSync.native(tmpdir()), 'outside-not-real'))
  })

  it('refuses a junction under the root that points outside it', () => {
    if (!junctionCreated) return
    // A purely lexical comparison would accept this: the path is spelled inside
    // the root. Only canonicalizing it shows where it really lands.
    expect(isWithin(root, join(root, 'escape'))).toBe(false)
    expect(isWithin(root, join(root, 'escape', 'elsewhere'))).toBe(false)
  })
})
