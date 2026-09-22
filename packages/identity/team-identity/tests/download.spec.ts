/**
 * Reading a project's output: the boundaries, the byte budget, and the choice of
 * what to hand over.
 *
 * What is worth protecting: only `work\` is reachable and only from inside the
 * deployment's workspace, a `work\` that leaves the project is refused rather
 * than followed, an over-budget file is refused without ever being read, and a
 * selection is taken literally — an empty one is refused instead of read as
 * "everything", and a selected file that has since disappeared refuses the whole
 * package instead of quietly leaving it out.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamIdentity } from '../src/service.ts'
import { ensureProjectLayout } from '../src/project-layout.ts'
import type { TeamMember } from '../src/registry.ts'

const roots: string[] = []

function temp(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix))
  roots.push(created)
  return created
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const MEMBERS: readonly TeamMember[] = [{ userId: 'u-alice', name: '爱丽丝', signInCode: 'alice-code' }]

/** One mounted service whose single conversation owns `project`. */
async function fixture(project: string, workspaceRoot?: string): Promise<{
  readonly identity: TeamIdentity
  readonly project: string
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  // Stand in for the Session store: the workspace comes from the conversation,
  // never from the request.
  ctx.provide('sessions', {
    get: (id: string) => (id === 's-1' ? { header: { cwd: project } } : undefined),
  } as never)
  let identity!: TeamIdentity
  const fiber = ctx.plugin((pluginCtx) => {
    identity = new TeamIdentity(
      pluginCtx, MEMBERS, 60_000, 200, temp('dsh-download-home-'), undefined, undefined, workspaceRoot,
    )
  })
  await fiber.await()
  return { identity, project, dispose: () => fiber.dispose() }
}

/** A project with a `work\` holding the given files. */
function projectWith(files: Record<string, string>): string {
  const project = temp('dsh-download-')
  mkdirSync(join(project, 'work'), { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    const target = join(project, 'work', ...name.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text)
  }
  return project
}

/** Link a directory, or report that this host will not allow one. */
function linkDirectory(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'junction')
    return true
  } catch {
    return false
  }
}

describe('the boundaries around work', () => {
  it('refuses a project outside the deployment’s workspace root', async () => {
    const project = projectWith({ 'report.txt': 'produced' })
    const elsewhere = temp('dsh-download-elsewhere-')
    const fixtureUnder = await fixture(project, elsewhere)

    expect(await fixtureUnder.identity.manifest('s-1')).toEqual({ ok: false, reason: 'outside-work' })
    expect(await fixtureUnder.identity.exportArchive('s-1')).toEqual({ ok: false, reason: 'outside-work' })
    expect(await fixtureUnder.identity.exportFile('s-1', 'report.txt')).toEqual({ ok: false, reason: 'outside-work' })
    await fixtureUnder.dispose()
  })

  it('serves a project outside the container but inside the workspace root', async () => {
    const root = temp('dsh-download-root-')
    const project = join(root, '旧项目')
    mkdirSync(join(project, 'work'), { recursive: true })
    writeFileSync(join(project, 'work', 'report.txt'), 'produced')
    const mounted = await fixture(project, root)

    // The compatibility case: history lives where it always lived.
    expect(await mounted.identity.exportFile('s-1', 'report.txt')).toMatchObject({ ok: true })
    expect(await mounted.identity.manifest('s-1')).toMatchObject({ ok: true })
    await mounted.dispose()
  })

  it('refuses a work directory that is a junction out of the project', async () => {
    const project = temp('dsh-download-project-')
    const outside = temp('dsh-download-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'not ours')
    if (!linkDirectory(outside, join(project, 'work'))) return
    const mounted = await fixture(project)

    // The container escapes, which a per-entry symlink test cannot see.
    expect(await mounted.identity.manifest('s-1')).toEqual({ ok: false, reason: 'work-escapes-project' })
    expect(await mounted.identity.exportArchive('s-1')).toEqual({ ok: false, reason: 'work-escapes-project' })
    expect(await mounted.identity.exportFile('s-1', 'secret.txt')).toEqual({ ok: false, reason: 'work-escapes-project' })
    await mounted.dispose()
  })

  it('refuses paths outside work under any spelling', async () => {
    const project = projectWith({ 'report.txt': 'produced' })
    mkdirSync(join(project, 'input'), { recursive: true })
    writeFileSync(join(project, 'input', 'raw.csv'), 'somebody else\'s data')
    const mounted = await fixture(project)

    for (const relative of ['../input/raw.csv', '..\\input\\raw.csv', join('..', 'input', 'raw.csv')]) {
      expect(await mounted.identity.exportFile('s-1', relative)).toEqual({ ok: false, reason: 'outside-work' })
    }
    await mounted.dispose()
  })
})

describe('the byte budget', () => {
  /** A nominal 600MB file: `truncate` makes it sparse, so the test costs nothing. */
  function oversized(project: string, name: string): void {
    const target = join(project, 'work', name)
    writeFileSync(target, '')
    truncateSync(target, 600 * 1024 * 1024)
  }

  it('refuses an over-budget package before reading anything', async () => {
    const project = projectWith({ 'small.txt': 'produced' })
    oversized(project, 'huge.bin')
    const mounted = await fixture(project)

    // The whole package is refused; nothing was allocated to find that out.
    expect(await mounted.identity.exportArchive('s-1')).toEqual({ ok: false, reason: 'too-large' })
    await mounted.dispose()
  })

  it('refuses one over-budget file as a single-file download', async () => {
    const project = projectWith({ 'small.txt': 'produced' })
    oversized(project, 'huge.bin')
    const mounted = await fixture(project)

    expect(await mounted.identity.exportFile('s-1', 'huge.bin')).toEqual({ ok: false, reason: 'too-large' })
    // The budget is per request, not per project: the small file still works.
    expect(await mounted.identity.exportFile('s-1', 'small.txt')).toMatchObject({ ok: true })
    await mounted.dispose()
  })
})

describe('choosing what to hand over', () => {
  it('packages only the selected paths', async () => {
    const project = projectWith({ 'keep-a.txt': 'a', 'keep-b.txt': 'b', 'drop.txt': 'c' })
    const mounted = await fixture(project)

    const archive = await mounted.identity.exportArchive('s-1', 'all', ['work/keep-a.txt', 'work/keep-b.txt'])

    expect(archive).toMatchObject({ ok: true, products: 2 })
    if (!archive.ok) throw new Error('expected an archive')
    expect(archive.bytes.includes(Buffer.from('work/keep-a.txt'))).toBe(true)
    expect(archive.bytes.includes(Buffer.from('work/drop.txt'))).toBe(false)
    await mounted.dispose()
  })

  it('refuses an empty selection instead of reading it as everything', async () => {
    const project = projectWith({ 'report.txt': 'produced' })
    const mounted = await fixture(project)

    expect(await mounted.identity.exportArchive('s-1', 'all', [])).toEqual({ ok: false, reason: 'nothing-produced' })
    await mounted.dispose()
  })

  it('refuses a selection that is not a manifest path', async () => {
    const project = projectWith({ 'report.txt': 'produced' })
    const mounted = await fixture(project)

    // Filesystem paths are not an interface: a selection names what the member
    // saw in the manifest, and nothing else.
    expect(await mounted.identity.exportArchive('s-1', 'all', ['report.txt']))
      .toEqual({ ok: false, reason: 'outside-work' })
    expect(await mounted.identity.exportArchive('s-1', 'all', ['work/../secret.txt']))
      .toEqual({ ok: false, reason: 'outside-work' })
    await mounted.dispose()
  })

  it('refuses the whole package when a selected file is gone, and names it', async () => {
    const project = projectWith({ 'keep.txt': 'a' })
    const mounted = await fixture(project)

    expect(await mounted.identity.exportArchive('s-1', 'all', ['work/keep.txt', 'work/vanished.txt']))
      .toEqual({ ok: false, reason: 'unreadable', missing: ['work/vanished.txt'] })
    await mounted.dispose()
  })

  it('applies the budget to the selection rather than the project', async () => {
    const project = projectWith({ 'small.txt': 'produced' })
    writeFileSync(join(project, 'work', 'huge.bin'), '')
    truncateSync(join(project, 'work', 'huge.bin'), 600 * 1024 * 1024)
    const mounted = await fixture(project)

    // Selecting only the small file is the way out of an over-budget project.
    expect(await mounted.identity.exportArchive('s-1', 'all', ['work/small.txt'])).toMatchObject({ ok: true, products: 1 })
    await mounted.dispose()
  })
})

describe('a conversation that is only in storage', () => {
  /** A service whose single conversation is persisted but not live. */
  async function restored(options: {
    readonly cwd?: string
    readonly failure?: string
    readonly queryMounted?: boolean
  }): Promise<{ readonly identity: TeamIdentity; readonly dispose: () => Promise<void> }> {
    const ctx = new Context()
    ctx.provide('sessions', { get: () => undefined } as never)
    if (options.queryMounted !== false) {
      ctx.provide('sessionQuery', {
        readSession: async (sessionId: string) => {
          if (options.failure !== undefined) {
            throw Object.assign(new Error(`query failed: ${sessionId}`), { code: options.failure })
          }
          return { session: options.cwd === undefined ? {} : { cwd: options.cwd } }
        },
      } as never)
    }
    let identity!: TeamIdentity
    const fiber = ctx.plugin((pluginCtx) => {
      identity = new TeamIdentity(pluginCtx, MEMBERS, 60_000, 200, temp('dsh-download-home-'))
    })
    await fiber.await()
    return { identity, dispose: () => fiber.dispose() }
  }

  it('hands over files from a conversation that survived a restart', async () => {
    const project = projectWith({ 'report.txt': 'produced' })
    const mounted = await restored({ cwd: project })

    // Not live, and that is the point: handing over files must not resume an
    // Agent, but it must still work for last week's conversation.
    expect(await mounted.identity.exportFile('s-restored', 'report.txt')).toMatchObject({ ok: true })
    expect(await mounted.identity.manifest('s-restored')).toMatchObject({ ok: true })
    await mounted.dispose()
  })

  it('distinguishes a missing conversation from an unreadable one', async () => {
    const notFound = await restored({ failure: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    expect(await notFound.identity.manifest('s-gone')).toEqual({ ok: false, reason: 'unknown-session' })
    await notFound.dispose()

    const broken = await restored({ failure: 'SESSION_QUERY_PERSISTENCE_FAILED' })
    expect(await broken.identity.manifest('s-broken')).toEqual({ ok: false, reason: 'unreadable' })
    await broken.dispose()
  })

  it('stays unknown when the deployment has no query service at all', async () => {
    const mounted = await restored({ queryMounted: false })

    expect(await mounted.identity.manifest('s-restored')).toEqual({ ok: false, reason: 'unknown-session' })
    await mounted.dispose()
  })

  it('answers unknown when the stored header carries no workspace', async () => {
    const mounted = await restored({})

    expect(await mounted.identity.manifest('s-restored')).toEqual({ ok: false, reason: 'unknown-session' })
    await mounted.dispose()
  })
})

describe('reporting where a conversation lives', () => {
  /** A mounted service that knows its projects container. */
  async function withContainer(project: string, container: string): Promise<{
    readonly identity: TeamIdentity
    readonly dispose: () => Promise<void>
  }> {
    const ctx = new Context()
    ctx.provide('sessions', {
      get: (id: string) => (id === 's-1' ? { header: { cwd: project } } : undefined),
    } as never)
    let identity!: TeamIdentity
    const fiber = ctx.plugin((pluginCtx) => {
      identity = new TeamIdentity(
        pluginCtx, MEMBERS, 60_000, 200, temp('dsh-download-home-'), undefined, undefined, container, container,
      )
    })
    await fiber.await()
    return { identity, dispose: () => fiber.dispose() }
  }

  it('reports where the directory sits and what its layout is missing', async () => {
    const container = temp('dsh-download-container-')
    const project = join(container, '客户A')
    mkdirSync(join(project, 'work'), { recursive: true })
    writeFileSync(join(project, 'work', 'report.txt'), 'produced')
    const mounted = await withContainer(project, container)

    const manifest = await mounted.identity.manifest('s-1')

    // A project at the right level whose layout is incomplete: the two facts are
    // reported separately, so the client never says "you picked the wrong
    // directory" about a directory that is in the right place.
    expect(manifest).toMatchObject({ ok: true, layout: { location: 'project', conflicts: [], complete: false } })
    expect(manifest.ok && manifest.layout?.missing).toContain('input')
    await mounted.dispose()
  })

  it('reports a project whose layout is intact', async () => {
    const container = temp('dsh-download-container-')
    const project = join(container, '客户A')
    mkdirSync(project)
    ensureProjectLayout(project)
    const mounted = await withContainer(project, container)

    const manifest = await mounted.identity.manifest('s-1')

    expect(manifest.ok && manifest.layout).toMatchObject({ location: 'project', complete: true, missing: [], conflicts: [] })
    await mounted.dispose()
  })

  it('reports a directory that is not a project at all', async () => {
    const container = temp('dsh-download-container-')
    const nested = join(container, '客户A', 'sub')
    mkdirSync(join(nested, 'work'), { recursive: true })
    const mounted = await withContainer(nested, container)

    const manifest = await mounted.identity.manifest('s-1')

    expect(manifest.ok && manifest.layout?.location).toBe('nested')
    await mounted.dispose()
  })

  it('reports a type conflict instead of calling the entry present', async () => {
    const container = temp('dsh-download-container-')
    const project = join(container, '客户A')
    mkdirSync(join(project, 'work'), { recursive: true })
    writeFileSync(join(project, 'input'), 'not a directory')
    const mounted = await withContainer(project, container)

    const manifest = await mounted.identity.manifest('s-1')

    expect(manifest.ok && manifest.layout?.conflicts).toContainEqual({ name: 'input', kind: 'not-a-directory' })
    await mounted.dispose()
  })

  it('omits the layout when the deployment declared no container', async () => {
    const project = projectWith({ 'report.txt': 'produced' })
    const mounted = await fixture(project)

    const manifest = await mounted.identity.manifest('s-1')

    expect(manifest.ok && manifest.layout).toBeUndefined()
    await mounted.dispose()
  })
})
