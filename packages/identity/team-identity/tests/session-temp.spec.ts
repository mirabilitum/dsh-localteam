/**
 * The per-Session scratch directory.
 *
 * What is worth protecting: the variable names a path inside the Session's own
 * workspace, it is created on first use rather than handed out as a path that may
 * not exist, and a shell call that cannot be attributed to a Session gets no
 * value at all — an absent variable can be tested for, while a wrong directory
 * silently collects files nobody cleans.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { SESSION_TEMP_CONTRIBUTOR, SESSION_TEMP_KEY, sessionTempContributor, sessionTempPath } from '../src/session-temp.ts'

const roots: string[] = []

function workspace(): string {
  const created = mkdtempSync(join(tmpdir(), 'dsh-session-temp-'))
  roots.push(created)
  return created
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One shell call as the tools describe it, with only the fields this resolves from. */
function execution(cwd?: string, sessionId?: string): ToolExecution {
  return {
    signal: new AbortController().signal,
    token: Symbol('session-temp-test'),
    callId: 'session-temp-call',
    rootCallId: 'session-temp-call',
    name: 'pwsh',
    arguments: { command: 'true' },
    ...(sessionId === undefined ? {} : { agent: { session: { header: { id: sessionId, cwd } } } }),
  } as unknown as ToolExecution
}

describe('the per-Session scratch directory', () => {
  it('names a directory inside the Session’s own workspace', () => {
    expect(sessionTempPath('D:\\forteamwork\\hanbao', 'session-1')).toBe(
      join('D:\\forteamwork\\hanbao', 'sessions', 'session-1', 'temp'),
    )
  })

  it('declares one variable with a description', () => {
    const contributor = sessionTempContributor()
    expect(contributor.name).toBe(SESSION_TEMP_CONTRIBUTOR)
    expect(Object.keys(contributor.variables)).toEqual([SESSION_TEMP_KEY])
    expect(contributor.variables[SESSION_TEMP_KEY]?.description.length).toBeGreaterThan(0)
  })

  it('creates the directory on first use and returns its path', () => {
    const root = workspace()
    const resolved = sessionTempContributor().resolve(execution(root, 'session-a'))
    const expected = join(root, 'sessions', 'session-a', 'temp')
    expect(resolved[SESSION_TEMP_KEY]).toBe(expected)
    // Created, not merely named: a rule whose path may not exist is a rule the
    // command has to work around.
    expect(existsSync(expected)).toBe(true)
  })

  it('gives no value to a shell call with no Session, or a Session with no workspace', () => {
    // No calling Agent at all.
    expect(sessionTempContributor().resolve(execution())).toEqual({})
    // An Agent whose Session has no workspace: the path would otherwise resolve
    // against the host's own directory.
    expect(sessionTempContributor().resolve(execution(undefined, 'session-a'))).toEqual({})
    expect(sessionTempContributor().resolve(execution('', 'session-a'))).toEqual({})
  })

  it('keeps working when the workspace cannot be written to', () => {
    // A path whose parent is a file: the directory cannot be created, and the
    // command that tries to use it is what reports that — not a thrown resolver.
    const root = workspace()
    const blocker = join(root, 'blocker')
    mkdirSync(blocker)
    const resolved = sessionTempContributor().resolve(execution(join(blocker, 'nope'), 'session-a'))
    expect(resolved[SESSION_TEMP_KEY]).toBe(join(blocker, 'nope', 'sessions', 'session-a', 'temp'))
  })

  it('rides the real registry: collected alongside the built-in facts, removed with its owner', () => {
    const root = workspace()
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    const dispose = registry.register(sessionTempContributor())

    const collected = registry.collect(execution(root, 'session-a'))
    expect(collected[SESSION_TEMP_KEY]).toBe(join(root, 'sessions', 'session-a', 'temp'))
    // The built-in facts are untouched by the contribution.
    expect(collected.DSH_SESSION_ID).toBe('session-a')
    expect(collected.DSH_SHELL).toBe('1')
    expect(registry.list()).toEqual([
      { contributor: SESSION_TEMP_CONTRIBUTOR, description: expect.any(String), key: SESSION_TEMP_KEY },
    ])

    dispose()
    expect(registry.collect(execution(root, 'session-a'))).not.toHaveProperty(SESSION_TEMP_KEY)
  })
})
