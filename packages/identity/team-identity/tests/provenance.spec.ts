/**
 * The product ledger.
 *
 * What is worth protecting: a turn is recorded against the conversation that
 * issued it, a file is attributed to the newest turn that had already started
 * when it was written, a file no turn can claim is reported as unattributed
 * rather than guessed, and a damaged or unwritable ledger never refuses work.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROVENANCE_FILE_NAME, ProvenanceLedger } from '../src/provenance.ts'
import type { ProvenanceProduct, ProvenanceScope } from '../src/provenance.ts'

const roots: string[] = []

function project(): string {
  const created = mkdtempSync(join(tmpdir(), 'dsh-provenance-'))
  roots.push(created)
  mkdirSync(join(created, 'work'), { recursive: true })
  return created
}

/** An empty temporary directory that has no `work\` of its own yet. */
function bare(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix))
  roots.push(created)
  return created
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Write a file and give it an exact modification time, which is what attribution reads. */
function produced(root: string, relative: string, text: string, at: string): void {
  const target = join(root, ...relative.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  const when = new Date(at)
  utimesSync(target, when, when)
}

/** A ledger whose only conversation is `s-1` in the given project. */
function ledgerFor(root: string, failures: unknown[] = []): ProvenanceLedger {
  return new ProvenanceLedger(
    sessionId => (sessionId === 's-1' || sessionId === 's-2' ? root : undefined),
    (error) => { failures.push(error) },
  )
}

/** The products of one scan, insisting the read itself succeeded. */
function scanned(ledger: ProvenanceLedger, root: string, scope: ProvenanceScope = 'all'): readonly ProvenanceProduct[] {
  const scan = ledger.scanWork(root, scope)
  if (!scan.ok) throw new Error(`expected a readable work directory, got ${scan.reason}`)
  return scan.products
}

describe('the product ledger', () => {
  it('numbers turns within their own conversation', () => {
    const root = project()
    const ledger = ledgerFor(root)
    expect(ledger.recordTurn('s-1', 'u-alice', Date.parse('2026-01-01T00:00:00Z'))).toBe(1)
    expect(ledger.recordTurn('s-1', 'u-alice', Date.parse('2026-01-01T00:10:00Z'))).toBe(2)
    // A second conversation in the same project keeps its own numbering: "turn 1"
    // has to mean the same thing to everyone reading the ledger.
    expect(ledger.recordTurn('s-2', 'u-bob', Date.parse('2026-01-01T00:20:00Z'))).toBe(1)
    expect(ledger.readTurns(root)).toHaveLength(3)

    const stored = readFileSync(join(root, PROVENANCE_FILE_NAME), 'utf8').trim().split('\n')
    expect(stored).toHaveLength(3)
    expect(JSON.parse(stored[0] as string)).toMatchObject({ kind: 'turn', sessionId: 's-1', member: 'u-alice', turn: 1 })
  })

  it('attributes a file to the newest turn that had started when it was written', () => {
    const root = project()
    const ledger = ledgerFor(root)
    ledger.recordTurn('s-1', 'u-alice', Date.parse('2026-01-01T00:00:00Z'))
    produced(root, 'work/first.txt', 'one', '2026-01-01T00:05:00Z')
    ledger.recordTurn('s-2', 'u-bob', Date.parse('2026-01-01T00:10:00Z'))
    produced(root, 'work/图表/second.txt', 'two', '2026-01-01T00:15:00Z')

    expect(scanned(ledger, root)).toEqual([
      {
        path: 'work/first.txt',
        sessionId: 's-1',
        member: 'u-alice',
        turn: 1,
        producedAt: new Date('2026-01-01T00:05:00Z').toISOString(),
        bytes: 3,
      },
      {
        path: 'work/图表/second.txt',
        sessionId: 's-2',
        member: 'u-bob',
        turn: 1,
        producedAt: new Date('2026-01-01T00:15:00Z').toISOString(),
        bytes: 3,
      },
    ])
  })

  it('reports a file no turn can claim as unattributed instead of guessing', () => {
    const root = project()
    const ledger = ledgerFor(root)
    produced(root, 'work/handed-in.txt', 'from somewhere', '2020-01-01T00:00:00Z')
    ledger.recordTurn('s-1', 'u-alice', Date.parse('2026-01-01T00:00:00Z'))
    produced(root, 'work/after.txt', 'ours', '2026-01-01T00:01:00Z')

    const products = scanned(ledger, root)
    expect(products[0]).toMatchObject({ path: 'work/after.txt', member: 'u-alice', turn: 1 })
    expect(products[1]).toMatchObject({ path: 'work/handed-in.txt', sessionId: null, member: null, turn: null })
  })

  it('keeps each conversation’s newest turn under the latest scope', () => {
    const root = project()
    const ledger = ledgerFor(root)
    ledger.recordTurn('s-1', 'u-alice', Date.parse('2026-01-01T00:00:00Z'))
    produced(root, 'work/one.txt', 'one', '2026-01-01T00:01:00Z')
    ledger.recordTurn('s-1', 'u-alice', Date.parse('2026-01-01T00:10:00Z'))
    produced(root, 'work/two.txt', 'two', '2026-01-01T00:11:00Z')
    ledger.recordTurn('s-2', 'u-bob', Date.parse('2026-01-01T00:20:00Z'))
    produced(root, 'work/three.txt', 'three', '2026-01-01T00:21:00Z')

    expect(scanned(ledger, root, 'all').map(product => product.path))
      .toEqual(['work/one.txt', 'work/three.txt', 'work/two.txt'])
    // Two conversations, so "latest" drops only the earlier turn of the first one.
    expect(scanned(ledger, root, 'latest').map(product => product.path))
      .toEqual(['work/three.txt', 'work/two.txt'])
  })

  it('skips a damaged line rather than losing the ledger', () => {
    const root = project()
    const ledger = ledgerFor(root)
    ledger.recordTurn('s-1', 'u-alice', Date.parse('2026-01-01T00:00:00Z'))
    writeFileSync(
      join(root, PROVENANCE_FILE_NAME),
      `{ not json\n${JSON.stringify({ kind: 'turn', sessionId: 's-1', member: 'u-alice', turn: 1, at: '2026-01-01T00:00:00.000Z' })}\n\n`,
      'utf8',
    )
    expect(ledger.readTurns(root)).toHaveLength(1)
    // And the next turn still numbers on from what survived.
    expect(ledger.recordTurn('s-1', 'u-alice', Date.parse('2026-01-01T00:10:00Z'))).toBe(2)
  })

  it('treats a project with no ledger as one with nothing recorded', () => {
    const root = project()
    const ledger = ledgerFor(root)
    expect(ledger.readTurns(root)).toEqual([])
    expect(scanned(ledger, root)).toEqual([])
  })

  it('records nothing for a conversation with no workspace', () => {
    const ledger = ledgerFor(project())
    expect(ledger.recordTurn('s-unknown', 'u-alice')).toBeUndefined()
  })

  it('reports a ledger write that fails instead of refusing the turn', () => {
    const failures: unknown[] = []
    const blocker = join(mkdtempSync(join(tmpdir(), 'dsh-provenance-blocked-')), 'blocker')
    roots.push(blocker)
    writeFileSync(blocker, 'not a directory')
    const ledger = ledgerFor(blocker, failures)
    // The prompt must still run; what is lost is the attribution, not the work.
    expect(ledger.recordTurn('s-1', 'u-alice')).toBeUndefined()
    expect(failures.length).toBeGreaterThan(0)
  })

  it('ignores a symbolic link rather than following it out of the workspace', () => {
    const root = project()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-provenance-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'not ours')
    try {
      symlinkSync(outside, join(root, 'work', 'escape'), 'junction')
    } catch {
      // Windows denies unprivileged links in some configurations; the case is then
      // simply not exercised here.
      return
    }
    expect(scanned(ledgerFor(root), root).map(product => product.path)).toEqual([])
  })

  it('reports an unreadable work directory as unreadable, not as empty', () => {
    const project = bare('dsh-provenance-unreadable-')
    const ledger = ledgerFor(project)
    // A plain file named `work` cannot be listed: that is a fault, not "nothing
    // produced yet", and the two lead an operator to different actions.
    writeFileSync(join(project, 'work'), 'not a directory')

    expect(ledger.scanWork(project)).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('refuses a work directory that is a junction out of the project', () => {
    const project = bare('dsh-provenance-project-')
    const outside = bare('dsh-provenance-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'not ours')
    try {
      symlinkSync(outside, join(project, 'work'), 'junction')
    } catch {
      return
    }
    // The container itself escapes, which a per-entry link test cannot see.
    expect(ledgerFor(project).scanWork(project)).toEqual({ ok: false, reason: 'work-escapes-project' })
  })
})
