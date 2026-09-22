/**
 * The caller of the Remote invocation currently running.
 *
 * The transport is the only layer that resolves who is calling, and the layers
 * that write durable records — the prompt that opens a turn, the lifecycle entry
 * a slash command leaves — are business code that never sees a request. Passing
 * the subject down every method signature would change every call site to carry
 * something most of them ignore, so it travels beside the call instead: the
 * transport runs the invocation inside this store and anything that needs to
 * attribute what it records reads it back.
 *
 * Only the invocation itself is inside the store. Work the invocation starts and
 * does not await — a turn continuing after the prompt returns — runs outside it,
 * and reads nothing rather than reading a caller that is no longer there.
 *
 * @module @deepseek-ai/dsh-api-gateway/caller
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ConnectionSubject } from '@deepseek-ai/dsh-client-connection'

/** One invocation's caller, absent for in-process calls and unauthenticated deployments. */
const storage = new AsyncLocalStorage<ConnectionSubject | undefined>()

/**
 * Run one invocation with its caller in scope.
 * @param subject - the transport-resolved caller, or undefined when there is none.
 * @param run - the invocation to run.
 * @returns whatever `run` returns.
 */
export function runWithRemoteCaller<T>(subject: ConnectionSubject | undefined, run: () => T): T {
  return storage.run(subject, run)
}

/**
 * The caller of the invocation this code is running inside.
 *
 * A record written outside any invocation, or by an unauthenticated deployment,
 * gets undefined — which is the honest answer, not a guess.
 * @returns the caller, or undefined when the current work belongs to no invocation.
 */
export function remoteCaller(): ConnectionSubject | undefined {
  return storage.getStore()
}
