/**
 * Where one Session is told to put its scratch files.
 *
 * The workspace layout gives every Session its own `sessions\<会话>\temp\`, and
 * the project's own `AGENTS.md` states the rule — but a rule needs a path the
 * Session can name without guessing its own id. This registers `DSH_SESSION_TEMP`
 * for every model shell call, so a command can write a scratch file without the
 * Agent inventing a location (or, worse, writing scratch into the shared `work\`
 * and handing it to a colleague).
 *
 * The directory is created on first use rather than at registration: a Session
 * that never runs a command should not leave an empty tree behind, and the
 * deployment that owns the layout is the one that asks for this.
 *
 * @module @deepseek-ai/dsh-team-identity/session-temp
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BashEnvContributor } from '@deepseek-ai/dsh-shell-env'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** The variable a Session's shell receives. */
export const SESSION_TEMP_KEY = 'DSH_SESSION_TEMP'

/** The per-Session directory level inside a project. */
const SESSIONS_DIRECTORY = 'sessions'

/** The scratch level inside one Session's own directory. */
const TEMP_DIRECTORY = 'temp'

/** Stable contributor name, used in diagnostics and duplicate detection. */
export const SESSION_TEMP_CONTRIBUTOR = 'team-identity/session-temp'

/**
 * The scratch directory one Session owns.
 * @param workspace - the Session's workspace (its project directory).
 * @param sessionId - the Session's own id.
 * @returns the absolute directory.
 */
export function sessionTempPath(workspace: string, sessionId: string): string {
  return join(workspace, SESSIONS_DIRECTORY, sessionId, TEMP_DIRECTORY)
}

/**
 * Declare `DSH_SESSION_TEMP` for the shell tools.
 *
 * A shell call with no calling Agent (or a Session with no workspace) gets no
 * value rather than a path that would resolve against the host's own cwd — an
 * absent variable is something a command can test for, while a wrong directory
 * silently collects scratch files somewhere nobody cleans.
 * @returns the contributor `ctx.shellEnv` registers.
 */
export function sessionTempContributor(): BashEnvContributor {
  return {
    name: SESSION_TEMP_CONTRIBUTOR,
    variables: {
      [SESSION_TEMP_KEY]: {
        description: 'This Session\'s own scratch directory (safe to recreate; never a deliverable).',
      },
    },
    resolve(execution: ToolExecution): Readonly<Partial<Record<string, string>>> {
      const header = execution.agent?.session.header
      const workspace = header?.cwd
      const sessionId = header?.id
      if (typeof workspace !== 'string' || workspace === '') return {}
      if (typeof sessionId !== 'string' || sessionId === '') return {}
      const directory = sessionTempPath(workspace, sessionId)
      try {
        mkdirSync(directory, { recursive: true })
      } catch {
        // A workspace that cannot be written to is reported by the command that
        // tries to use it; the variable still names where scratch belongs.
      }
      return { [SESSION_TEMP_KEY]: directory }
    },
  }
}
