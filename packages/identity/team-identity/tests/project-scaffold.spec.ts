/**
 * Creating a directory through the browser's picker, with the team plugin
 * mounted: the moment the project layout is created.
 *
 * What is worth protecting: the create call returns only **after** the
 * deployment's post-create step has finished (or the next Session can be
 * created in a directory with no rules in it), a failing post-create step does
 * not turn a created directory into a reported failure, and only a direct child
 * of the container is treated as a project.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import type { DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'
import { PROJECT_DIRECTORIES, PROJECT_RULES, PROJECT_RULES_FILE_NAME } from '../src/project-layout.ts'

const roots: string[] = []

function temp(prefix: string): string {
  const created = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(created)
  return created
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One mounted deployment: the real picker backend plus the team plugin. */
interface Mounted {
  /** The capability the browser's create-directory call reaches. */
  readonly capability: DirectoryPickerBrowseCapability
  readonly dispose: () => Promise<void>
}

/**
 * Mount both plugins for real.
 * @param container - the picker root, which is also the projects container.
 * @param config - team identity configuration to mount with.
 * @param extra - optional extra plugin body, mounted before the team plugin.
 * @returns the browse capability and a disposer.
 */
async function mount(
  container: string,
  config: Partial<Config>,
  extra?: (ctx: Context) => void,
): Promise<Mounted> {
  const ctx = new Context()
  const picker = ctx.plugin(BrowseDirectoryPicker, { root: container })
  await picker.await()
  if (extra !== undefined) {
    const plugin = ctx.plugin(extra)
    await plugin.await()
  }
  const team = ctx.plugin({ apply }, { homePath: temp('dsh-team-home-'), workspaceRoot: container, ...config })
  await team.await()
  const picked = ctx.get('directoryPicker')?.capability()
  if (picked === undefined || picked.kind !== 'browse') throw new Error('the browse backend must be mounted')
  return {
    capability: picked,
    dispose: async () => {
      await team.dispose()
      await picker.dispose()
    },
  }
}

describe('creating a project through the picker', () => {
  it('has the whole layout on disk by the time the create call returns', async () => {
    const container = temp('dsh-scaffold-')
    const mounted = await mount(container, { projectScaffold: true, projectsRoot: container })

    const created = await mounted.capability.createDirectory(container, '客户A')

    expect(created).toBe(join(container, '客户A'))
    for (const name of PROJECT_DIRECTORIES) {
      expect(existsSync(join(created, name))).toBe(true)
    }
    expect(readFileSync(join(created, PROJECT_RULES_FILE_NAME), 'utf8')).toBe(PROJECT_RULES)
    await mounted.dispose()
  })

  it('leaves a directory inside a project alone', async () => {
    const container = temp('dsh-scaffold-')
    const mounted = await mount(container, { projectScaffold: true, projectsRoot: container })
    const project = await mounted.capability.createDirectory(container, '客户A')

    const nested = await mounted.capability.createDirectory(project, 'sub')

    expect(existsSync(join(nested, 'work'))).toBe(false)
    expect(existsSync(join(nested, PROJECT_RULES_FILE_NAME))).toBe(false)
    await mounted.dispose()
  })

  it('does nothing when the deployment did not ask for the layout', async () => {
    const container = temp('dsh-scaffold-')
    const mounted = await mount(container, {})

    const created = await mounted.capability.createDirectory(container, '客户A')

    expect(existsSync(join(created, 'work'))).toBe(false)
    await mounted.dispose()
  })

  it('still reports the create as successful when a post-create step fails', async () => {
    const container = temp('dsh-scaffold-')
    const mounted = await mount(
      container,
      { projectScaffold: true, projectsRoot: container },
      (ctx) => {
        ctx.on('directory-picker/created', () => { throw new Error('post-create step failed') })
      },
    )

    const created = await mounted.capability.createDirectory(container, '客户A')

    // The directory exists and the call succeeded; the failure is the
    // deployment's problem, not the caller's.
    expect(existsSync(created)).toBe(true)
    expect(existsSync(join(created, 'work'))).toBe(true)
    await mounted.dispose()
  })

  it('reports an unusable projects root and creates no layout', async () => {
    const container = temp('dsh-scaffold-')
    const elsewhere = temp('dsh-scaffold-outside-')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const mounted = await mount(container, { projectScaffold: true, projectsRoot: elsewhere })

      const created = await mounted.capability.createDirectory(container, '客户A')

      expect(existsSync(join(created, 'work'))).toBe(false)
      expect(warn.mock.calls.some(call => String(call[0]).includes('outside workspaceRoot'))).toBe(true)
      await mounted.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  it('refuses a directory name that is already taken, without touching it', async () => {
    const container = temp('dsh-scaffold-')
    const mounted = await mount(container, { projectScaffold: true, projectsRoot: container })
    mkdirSync(join(container, '客户A'))

    await expect(mounted.capability.createDirectory(container, '客户A')).rejects.toMatchObject({
      code: 'directory-exists',
    })
    expect(existsSync(join(container, '客户A', 'work'))).toBe(false)
    await mounted.dispose()
  })
})
