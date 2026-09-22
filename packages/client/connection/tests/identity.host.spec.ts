/**
 * The caller identity the transport resolves for one request.
 *
 * Two rules matter here and are easy to get wrong: admission is decided before
 * identity is read (so a resolver can never widen who reaches the transport),
 * and the page instance id is correlation rather than identity — it may be
 * absent or hostile without ever changing which member the request belongs to.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { CLIENT_INSTANCE_HEADER } from '../src/identity.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

const MEMBER = { userId: 'u-alice', tokenId: 't-1', actorType: 'user' } as const

async function mounted(options: {
  readonly browserAuth?: unknown
  readonly resolver?: (headers: unknown) => unknown
} = {}): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    const service = new HostConnectionService(
      pluginCtx,
      [],
      (options.browserAuth ?? { isAuthenticated: () => true }) as BrowserAuth,
    )
    if (options.resolver !== undefined) service.setIdentityResolver({ resolve: options.resolver } as never)
  })
  await fiber.await()
  return { connection: ctx.get('connection') as HostConnectionService, dispose: () => fiber.dispose() }
}

function headers(extra: Record<string, string> = {}): Headers {
  // Loopback is inherently trusted, so these cases reach identity resolution
  // instead of stopping at the Host/Origin fence.
  return new Headers({ host: '127.0.0.1:3080', ...extra })
}

describe('transport authentication', () => {
  it('refuses an untrusted authority before consulting identity', async () => {
    const { connection, dispose } = await mounted({ resolver: () => MEMBER })
    // The fence runs first: a resolver can never widen who reaches the transport.
    expect(connection.authenticate({ headers: new Headers({ host: 'evil.test' }) }))
      .toEqual({ rejection: 403, subject: undefined })
    await dispose()
  })

  it('resolves no subject when the deployment has no resolver', async () => {
    const { connection, dispose } = await mounted()
    expect(connection.authenticate({ headers: headers() })).toEqual({ rejection: undefined, subject: undefined })
    await dispose()
  })

  it('keeps the fence status separate from identity', async () => {
    const { connection, dispose } = await mounted({ browserAuth: { isAuthenticated: () => false } })
    // Unauthenticated: no resolver is even consulted, so no identity leaks out.
    expect(connection.authenticate({ headers: headers() })).toEqual({ rejection: 401, subject: undefined })
    expect(connection.requestRejection({ headers: headers() })).toBe(401)
    await dispose()
  })

  it('attaches the page instance id the request declares', async () => {
    const { connection, dispose } = await mounted({ resolver: () => MEMBER })
    const resolved = connection.authenticate({
      headers: headers({ [CLIENT_INSTANCE_HEADER]: 'tab-7' }),
    })
    expect(resolved.subject).toEqual({ ...MEMBER, clientInstanceId: 'tab-7' })
    await dispose()
  })

  it('still resolves the member when the instance id is absent', async () => {
    const { connection, dispose } = await mounted({ resolver: () => MEMBER })
    const resolved = connection.authenticate({ headers: headers() })
    // The member never depends on the header: losing it only makes this request
    // indistinguishable from another tab of the same member.
    expect(resolved.subject).toEqual(MEMBER)
    await dispose()
  })

  it('ignores an empty and an oversized instance id', async () => {
    const { connection, dispose } = await mounted({ resolver: () => MEMBER })
    expect(connection.authenticate({ headers: headers({ [CLIENT_INSTANCE_HEADER]: '' }) }).subject).toEqual(MEMBER)
    expect(connection.authenticate({
      headers: headers({ [CLIENT_INSTANCE_HEADER]: 'x'.repeat(1024) }),
    }).subject).toEqual(MEMBER)
    await dispose()
  })

  it('keeps the id a resolver already decided', async () => {
    const { connection, dispose } = await mounted({
      resolver: () => ({ ...MEMBER, clientInstanceId: 'from-resolver' }),
    })
    const resolved = connection.authenticate({
      headers: headers({ [CLIENT_INSTANCE_HEADER]: 'from-header' }),
    })
    expect(resolved.subject).toEqual({ ...MEMBER, clientInstanceId: 'from-resolver' })
    await dispose()
  })

  it('removes the resolver on dispose', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((pluginCtx) => {
      const service = new HostConnectionService(
        pluginCtx,
        [],
        { isAuthenticated: () => true } as unknown as BrowserAuth,
      )
      service.setIdentityResolver({ resolve: () => MEMBER } as never)
    })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionService
    expect(connection.authenticate({ headers: headers() }).subject).toEqual(MEMBER)

    // Back to the single-user baseline: no resolver, so no subject, and the
    // transport still admits the request.
    await fiber.dispose()
    expect(connection.authenticate({ headers: headers() })).toEqual({ rejection: undefined, subject: undefined })
  })
})
