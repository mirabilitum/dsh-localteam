/**
 * The caller travelling beside an invocation.
 *
 * The cases worth protecting: what the invocation wrote down is what the
 * transport resolved, work outside any invocation attributes nothing rather than
 * guessing, and the value survives the awaits a business method performs.
 */

import { describe, expect, it } from 'vitest'
import type { ConnectionSubject } from '@deepseek-ai/dsh-client-connection'
import { remoteCaller, runWithRemoteCaller } from '../src/caller.ts'

const alice: ConnectionSubject = { userId: 'u-alice', tokenId: 't-1', actorType: 'user' }

describe('the invocation caller', () => {
  it('is visible to the code the invocation runs', () => {
    expect(runWithRemoteCaller(alice, () => remoteCaller())).toEqual(alice)
  })

  it('survives the awaits a business method performs', async () => {
    await expect(runWithRemoteCaller(alice, async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return remoteCaller()?.userId
    })).resolves.toBe('u-alice')
  })

  it('is absent outside any invocation', () => {
    // Work an invocation started and did not await runs here. Reading a caller
    // that is no longer on the stack would attribute it to whoever asked last.
    expect(remoteCaller()).toBeUndefined()
  })

  it('is absent inside an invocation the deployment could not attribute', () => {
    expect(runWithRemoteCaller(undefined, () => remoteCaller())).toBeUndefined()
  })

  it('restores the enclosing caller when a nested invocation returns', () => {
    const bob: ConnectionSubject = { userId: 'u-bob', tokenId: 't-2', actorType: 'user' }
    expect(runWithRemoteCaller(alice, () => {
      const inner = runWithRemoteCaller(bob, () => remoteCaller()?.userId)
      return [inner, remoteCaller()?.userId]
    })).toEqual(['u-bob', 'u-alice'])
  })
})
