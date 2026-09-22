/**
 * A file that changes while it is being read.
 *
 * This is the one case a single-process test cannot produce: the read is
 * synchronous, so nothing in this process can run between the size check and the
 * bytes, and the whole point of the check is that the file changed in that
 * window. A second process is what actually writes, exactly as an Agent's shell
 * command would.
 *
 * The answer being protected is that the reader refuses and says to retry,
 * rather than handing over bytes that do not match the file it measured — and
 * that it is **not** reported as `too-large`, which is a different thing a member
 * would act on differently.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamIdentity } from '../src/service.ts'
import type { TeamMember } from '../src/registry.ts'

const roots: string[] = []
const writers = new Set<ChildProcess>()

afterEach(() => {
  for (const writer of writers) writer.kill()
  writers.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A project whose `work\` holds one file of the given size. */
function projectWithBigFile(bytes: number): { readonly project: string; readonly file: string } {
  const project = mkdtempSync(join(tmpdir(), 'dsh-race-'))
  roots.push(project)
  mkdirSync(join(project, 'work'), { recursive: true })
  const file = join(project, 'work', 'big.bin')
  // Real bytes, not a sparse hole: the read has to take long enough for another
  // process to get a write in.
  writeFileSync(file, Buffer.alloc(bytes, 0x61))
  return { project, file }
}

/** The writer: append one byte at a time until it is killed. */
const WRITER_SOURCE = [
  "const { openSync, writeSync } = require('node:fs')",
  "const fd = openSync(process.argv[1], 'a')",
  'const until = Date.now() + 20000',
  'while (Date.now() < until) { try { writeSync(fd, "x") } catch { /* the reader closed it */ } }',
].join('; ')

/** Start an external appender, or report that this host will not allow one. */
function startWriter(file: string): ChildProcess | undefined {
  try {
    // `ignore`, not a pipe: a sandboxed host refuses piped stdio, and this child
    // has nothing to say — its progress is visible in the file's size.
    const child = spawn(process.execPath, ['-e', WRITER_SOURCE, file], { stdio: 'ignore' })
    writers.add(child)
    return child
  } catch {
    return undefined
  }
}

/** Wait until the external writer has actually written something. */
function waitForGrowth(file: string, from: number): boolean {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (statSync(file).size > from) return true
  }
  return false
}

/** One mounted service whose single conversation owns `project`. */
async function fixture(project: string): Promise<{ readonly identity: TeamIdentity; readonly dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.provide('sessions', {
    get: (id: string) => (id === 's-1' ? { header: { cwd: project } } : undefined),
  } as never)
  let identity!: TeamIdentity
  const members: readonly TeamMember[] = [{ userId: 'u-alice', name: '爱丽丝', signInCode: 'alice-code' }]
  const home = mkdtempSync(join(tmpdir(), 'dsh-race-home-'))
  roots.push(home)
  const fiber = ctx.plugin((pluginCtx) => {
    identity = new TeamIdentity(pluginCtx, members, 60_000, 200, home)
  })
  await fiber.await()
  return { identity, dispose: () => fiber.dispose() }
}

describe('a file that changes while it is being read', () => {
  it('refuses the read and asks for a retry, instead of reporting a size problem', async () => {
    const { project, file } = projectWithBigFile(24 * 1024 * 1024)
    const mounted = await fixture(project)
    const writer = startWriter(file)
    if (writer === undefined) {
      // A host that will not spawn a second process cannot exercise this at all;
      // the single-process budget cases still hold.
      await mounted.dispose()
      return
    }
    expect(waitForGrowth(file, 24 * 1024 * 1024)).toBe(true)

    // The writer keeps appending, so at least one attempt reads a file whose
    // size moved underneath it. Retrying covers the rare attempt that finished
    // between two writes.
    const outcomes: string[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await mounted.identity.exportFile('s-1', 'big.bin')
      outcomes.push(result.ok ? 'ok' : result.reason)
      if (!result.ok && result.reason === 'changed-during-read') break
    }

    expect(outcomes).toContain('changed-during-read')
    // Everything else the reader could have said would send the member to the
    // wrong next step: `too-large` means "narrow the selection", and a size
    // change is not that.
    expect(outcomes).not.toContain('too-large')
    writer.kill()
    await mounted.dispose()
  })
})
