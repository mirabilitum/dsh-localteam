/**
 * The browser caller's page instance id.
 *
 * It is correlation, not identity — the server resolves the member from the signed
 * cookie — but a control decision needs it to tell two tabs of the same member
 * apart. What matters here: it rides on every call, and it is the *same* value for
 * every call from this page, because a value that changed per request would make
 * every request look like a different tab.
 */

import { describe, expect, it, vi } from 'vitest'
import { CLIENT_INSTANCE_HEADER } from '../src/identity.ts'
import { createWebConnectionRpc, type RpcFetch } from '../src/client/rpc.ts'

/** Capture the init each call was posted with. */
function recordingFetch(): { readonly send: RpcFetch; readonly inits: RequestInit[] } {
  const inits: RequestInit[] = []
  const send: RpcFetch = (_input, init) => {
    inits.push(init)
    return Promise.resolve(Response.json({
      type: 'server-response',
      rpcId: (JSON.parse(String(init.body)) as { rpcId: string }).rpcId,
      result: { ok: true, value: null },
    }))
  }
  return { send, inits }
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name]
}

describe('browser RPC page instance', () => {
  it('sends a page instance id with every call', async () => {
    const { send, inits } = recordingFetch()
    const rpc = createWebConnectionRpc(send)
    await rpc.call('/api', 'session-controller/list', { args: {} })
    await rpc.call('/api', 'session-controller/list', { args: {} })

    expect(inits).toHaveLength(2)
    const ids = inits.map(init => headerOf(init, CLIENT_INSTANCE_HEADER))
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/u)
    // A value that changed per call would make one tab look like many.
    expect(ids[1]).toBe(ids[0])
  })

  it('keeps the JSON content type alongside the instance id', async () => {
    const { send, inits } = recordingFetch()
    const rpc = createWebConnectionRpc(send)
    await rpc.call('/api', 'session-controller/list', { args: {} })
    expect(headerOf(inits[0] as RequestInit, 'content-type')).toBe('application/json')
  })

  it('mints the id only when a call is actually made', () => {
    // Constructing a caller must not touch `crypto`: a caller created during
    // module evaluation would otherwise mint an id before the page is ready.
    const getRandomValues = vi.fn(globalThis.crypto.getRandomValues.bind(globalThis.crypto))
    const original = globalThis.crypto.getRandomValues
    try {
      Object.defineProperty(globalThis.crypto, 'getRandomValues', {
        value: getRandomValues,
        configurable: true,
        writable: true,
      })
      createWebConnectionRpc(recordingFetch().send)
      expect(getRandomValues).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(globalThis.crypto, 'getRandomValues', {
        value: original,
        configurable: true,
        writable: true,
      })
    }
  })
})
