/**
 * Mounting team identity onto a real Connection host.
 *
 * The service tests drive `TeamIdentity` directly; this one proves the plugin's
 * own contribution — that `apply` installs the transport identity resolver and
 * the exact sign-in route, that a request through the shared dispatcher resolves
 * the member, and that disposing the plugin removes both again. It mounts the
 * real `HostConnectionService` against a stub browser auth, because the point is
 * the wiring rather than the DSH transport itself.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService, type HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEAM_IDENTITY_PATH } from '../src/http-route.ts'
import { apply, type Config, type TeamMemberConfig } from '../src/index.ts'
import { SessionControl } from '../src/session-control.ts'
import type { TeamIdentity } from '../src/service.ts'

const homes: string[] = []

afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function home(): string {
  const created = mkdtempSync(join(tmpdir(), 'dsh-team-mount-'))
  homes.push(created)
  return created
}

/** Browser auth stand-in: this suite covers identity, not DSH admission. */
const ADMITTED_AUTH = {
  isAuthenticated: () => true,
  authorizeIndex: () => true,
  authenticatedUrl: (baseUrl: string) => baseUrl,
}

function configuration(homePath: string) {
  return {
    members: [{ userId: 'u-alice', name: '爱丽丝', signInCode: 'alice-code' }],
    homePath,
  }
}

/**
 * Mount the real Connection host plus a recording web carrier.
 *
 * The carrier stub captures the index transform instead of applying it, so the
 * test can assert on the gate without a browser: `tapIndex` is the plugin's only
 * path into the served page.
 */
async function hostWith(config: Config): Promise<{
  readonly connection: HostConnectionHandle
  readonly transformIndex: (html: string) => string
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  let connection!: HostConnectionHandle
  let tap: ((html: string) => string) | undefined
  const fiber = ctx.plugin((pluginCtx) => {
    connection = new HostConnectionService(pluginCtx, [], ADMITTED_AUTH as never)
    pluginCtx.provide('webServer', {
      tapIndex: (transform: (html: string) => string) => {
        tap = transform
        return () => { tap = undefined }
      },
    })
  })
  await fiber.await()
  const team = ctx.plugin({ apply }, config)
  await team.await()
  return {
    connection,
    transformIndex: (html) => {
      if (tap === undefined) throw new Error('the index gate was not installed')
      return tap(html)
    },
    dispose: () => fiber.dispose(),
  }
}

const AUTHORITY = 'dsh.internal:3080'

function signIn(): Request {
  return new Request(`http://${AUTHORITY}${TEAM_IDENTITY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: AUTHORITY },
    body: JSON.stringify({ name: '爱丽丝', code: 'alice-code' }),
  })
}

describe('mounting team identity', () => {
  it('serves sign-in through the shared dispatcher and resolves the caller', async () => {
    const { connection, dispose } = await hostWith(configuration(home()))
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(signIn())
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] as string

    // The same dispatcher, one request later: the identity the transport resolved
    // for this exact request object is the member the signed cookie names.
    const authenticated = await shared.fetch(new Request(
      `http://${AUTHORITY}/api/session.list`,
      { method: 'POST', headers: { 'content-type': 'application/json', host: AUTHORITY, cookie } },
    ))
    // No endpoint claims this path, so a 404 proves dispatch got past identity.
    expect(authenticated.status).toBe(404)
    await dispose()
  })

  it('resolves the member for a raw request the fence already admitted', async () => {
    const { connection, dispose } = await hostWith(configuration(home()))
    const shared = connection.createSharedFetchHandler('/api')
    const signInResponse = await shared.fetch(signIn())
    const cookie = signInResponse.headers.get('set-cookie')?.split(';', 1)[0] as string

    const probe = new Request(`http://${AUTHORITY}/api/anything`, { headers: { host: AUTHORITY, cookie } })
    await shared.fetch(probe)
    expect(shared.subjectOf(probe)).toMatchObject({ userId: 'u-alice', actorType: 'user' })
    await dispose()
  })

  it('leaves anonymous requests without a subject', async () => {
    const { connection, dispose } = await hostWith(configuration(home()))
    const shared = connection.createSharedFetchHandler('/api')
    const probe = new Request(`http://${AUTHORITY}/api/anything`, { headers: { host: AUTHORITY } })
    await shared.fetch(probe)
    expect(shared.subjectOf(probe)).toBeUndefined()
    await dispose()
  })

  it('installs the index gate so a signed-out browser never mounts the shell', async () => {
    const { transformIndex, dispose } = await hostWith(configuration(home()))
    const gated = transformIndex('<!doctype html><html><head></head><body></body></html>')
    const gate = gated.indexOf('<script>(function(){')
    expect(gate).toBeGreaterThan(gated.indexOf('<head>'))
    expect(gate).toBeLessThan(gated.indexOf('</head>'))
    await dispose()
  })

  it('removes the resolver, the routes, and the gate when the plugin is disposed', async () => {
    const ctx = new Context()
    let connection!: HostConnectionHandle
    let tap: ((html: string) => string) | undefined
    const hostFiber = ctx.plugin((pluginCtx) => {
      connection = new HostConnectionService(pluginCtx, [], ADMITTED_AUTH as never)
      pluginCtx.provide('webServer', {
        tapIndex: (transform: (html: string) => string) => {
          tap = transform
          return () => { tap = undefined }
        },
      })
    })
    await hostFiber.await()
    const teamFiber = ctx.plugin({ apply }, configuration(home()))
    await teamFiber.await()
    const shared = connection.createSharedFetchHandler('/api')
    expect((await shared.fetch(signIn())).status).toBe(200)
    expect(tap).toBeDefined()

    await teamFiber.dispose()

    // Every contribution must go together: a route left mounted after its
    // resolver is gone would sign members in and then resolve nobody.
    expect((await shared.fetch(signIn())).status).toBe(404)
    expect(tap).toBeUndefined()
    await hostFiber.dispose()
  })
})

describe('mounting the per-Session scratch directory', () => {
  /** Records what the plugin contributes, standing in for the shell-env registry. */
  async function withShellEnv(config: Config): Promise<{
    readonly contributed: () => readonly { readonly name: string }[]
    readonly dispose: () => Promise<void>
  }> {
    const ctx = new Context()
    const registered: { readonly name: string }[] = []
    const hostFiber = ctx.plugin((pluginCtx) => {
      new HostConnectionService(pluginCtx, [], ADMITTED_AUTH as never)
      pluginCtx.provide('webServer', { tapIndex: () => () => {} })
      pluginCtx.provide('shellEnv', {
        register: (contributor: { readonly name: string }) => {
          registered.push(contributor)
          return () => {
            const index = registered.indexOf(contributor)
            if (index !== -1) registered.splice(index, 1)
          }
        },
      })
    })
    await hostFiber.await()
    const teamFiber = ctx.plugin({ apply }, config)
    await teamFiber.await()
    return { contributed: () => registered, dispose: () => hostFiber.dispose() }
  }

  it('contributes the scratch variable when the deployment asks for the layout', async () => {
    const shell = await withShellEnv({ ...configuration(home()), sessionTempDirectory: true })
    expect(shell.contributed().map(entry => entry.name)).toEqual(['team-identity/session-temp'])
    await shell.dispose()
  })

  it('contributes nothing when the deployment does not use the layout', async () => {
    // Off by default: a deployment without the directory convention must not be
    // handed a path nobody reads.
    const shell = await withShellEnv(configuration(home()))
    expect(shell.contributed()).toEqual([])
    await shell.dispose()
  })
})

describe('mounting an empty roster', () => {  /** Mount the plugin with whatever configuration a deployment actually wrote. */
  async function mountWith(config: Config): Promise<{
    readonly connection: HostConnectionHandle
    readonly dispose: () => Promise<void>
  }> {
    const ctx = new Context()
    let connection!: HostConnectionHandle
    const hostFiber = ctx.plugin((pluginCtx) => {
      connection = new HostConnectionService(pluginCtx, [], ADMITTED_AUTH as never)
      pluginCtx.provide('webServer', { tapIndex: () => () => {} })
      pluginCtx.provide('typertGateway', {
        setCallPolicy: () => () => {},
        setEventOwnerResolver: () => () => {},
        hasPendingRemoteEvents: () => false,
        reDeliverRemoteEvents: () => 0,
      })
    })
    await hostFiber.await()
    const teamFiber = ctx.plugin({ apply }, config)
    await teamFiber.await()
    return { connection, dispose: () => hostFiber.dispose() }
  }

  it('still mounts and still admits nobody when the roster is empty', async () => {
    // The unconfigured case is the dangerous one: a deployment that forgot its
    // members must not accidentally admit everyone.
    const { connection, dispose } = await mountWith({ homePath: home() })
    const shared = connection.createSharedFetchHandler('/api')
    const response = await shared.fetch(signIn())
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
    await dispose()
  })

  it('refuses a malformed member entry instead of admitting an unaddressable member', () => {
    // Failing loudly here is what keeps a typo from turning into a member nobody
    // can name, or a name with no id to record against. It is asserted at the
    // plugin boundary rather than through a mount: the invariant harness starts a
    // plugin's readiness promise eagerly and does not follow it through the
    // wrapper's inherited `await`, so mounting a deliberately-throwing plugin
    // leaves one rejection unobserved and vitest reports the whole run as failed
    // for a reason that has nothing to do with this guard.
    const ctx = new Context()
    const malformed: readonly TeamMemberConfig[] = [
      { userId: '', name: '爱丽丝', signInCode: 'x' },
      { userId: 'u-alice', name: '', signInCode: 'x' },
    ]
    for (const member of malformed) {
      expect(() => { apply(ctx, { members: [member], homePath: home() }) })
        .toThrow(/non-empty userId and name/u)
    }
  })
})

describe('mounting the call policy', () => {
  /** Records what the plugin installs, standing in for the Remote transport. */
  async function withGateway(): Promise<{
    readonly decide: (context: unknown) => unknown
    readonly ownerOf: (agentId: string) => unknown
    readonly accepts: (agentId: string, subject: unknown) => unknown
    readonly control: SessionControl
    readonly moved: () => readonly string[]
    readonly installed: () => boolean
    readonly ownersInstalled: () => boolean
    readonly answersInstalled: () => boolean
    readonly dispose: () => Promise<void>
  }> {
    const ctx = new Context()
    let policy: { decide(context: never): unknown } | undefined
    let owners: { ownerOf(agentId: string): unknown } | undefined
    let answers: { accepts(agentId: string, subject: unknown): unknown } | undefined
    const moved: string[] = []
    const hostFiber = ctx.plugin((pluginCtx) => {
      new HostConnectionService(pluginCtx, [], ADMITTED_AUTH as never)
      pluginCtx.provide('typertGateway', {
        setCallPolicy: (next: { decide(context: never): unknown }) => {
          policy = next
          return () => {
            if (policy === next) policy = undefined
          }
        },
        setEventOwnerResolver: (next: { ownerOf(agentId: string): unknown }) => {
          owners = next
          return () => {
            if (owners === next) owners = undefined
          }
        },
        setEventAnswerPolicy: (next: { accepts(agentId: string, subject: unknown): unknown }) => {
          answers = next
          return () => {
            if (answers === next) answers = undefined
          }
        },
        hasPendingRemoteEvents: () => false,
        reDeliverRemoteEvents: (agentId: string) => {
          moved.push(agentId)
          return 1
        },
      })
    })
    await hostFiber.await()
    const teamFiber = ctx.plugin({ apply }, configuration(home()))
    await teamFiber.await()
    return {
      decide: (context) => {
        if (policy === undefined) throw new Error('the call policy was not installed')
        return policy.decide(context as never)
      },
      ownerOf: (agentId) => {
        if (owners === undefined) throw new Error('the event owner resolver was not installed')
        return owners.ownerOf(agentId)
      },
      accepts: (agentId, subject) => {
        if (answers === undefined) throw new Error('the event answer policy was not installed')
        return answers.accepts(agentId, subject)
      },
      control: (ctx.get('teamIdentity') as TeamIdentity).control,
      moved: () => moved,
      installed: () => policy !== undefined,
      ownersInstalled: () => owners !== undefined,
      answersInstalled: () => answers !== undefined,
      dispose: () => hostFiber.dispose(),
    }
  }

  it('installs a policy the Remote transport can consult', async () => {
    const gateway = await withGateway()
    expect(gateway.installed()).toBe(true)
    expect(gateway.ownersInstalled()).toBe(true)
    // Routing a request and admitting its answer are two halves of one rule, so
    // the transport must be given both or an old holder could still settle it.
    expect(gateway.answersInstalled()).toBe(true)
    // Shared viewing stays open: a read endpoint is never refused.
    expect(gateway.decide({
      subject: { userId: 'u-alice', tokenId: 't', actorType: 'user' },
      endpoint: 'session/list',
      args: {},
    })).toBeUndefined()
    await gateway.dispose()
  })

  it('admits an answer only from the conversation’s current controller', async () => {
    const gateway = await withGateway()
    const alice = { userId: 'u-alice', tokenId: 't1', actorType: 'user' as const }
    const bob = { userId: 'u-bob', tokenId: 't2', actorType: 'user' as const }
    // Nobody drives it yet, so there is nobody to accept an answer from.
    expect(gateway.accepts('s-1', alice)).toBe(false)
    gateway.decide({ subject: alice, endpoint: 'session/prompt', args: { request: { sessionId: 's-1' } } })
    expect(gateway.accepts('s-1', alice)).toBe(true)
    expect(gateway.accepts('s-1', bob)).toBe(false)
    // An unidentified answer is refused even while the controller is unchanged:
    // holding a delivery is not the same as being allowed to settle it.
    expect(gateway.accepts('s-1', undefined)).toBe(false)
    // Control moving takes the old holder's answer with it.
    gateway.control.handOver('s-1', bob)
    expect(gateway.accepts('s-1', alice)).toBe(false)
    expect(gateway.accepts('s-1', bob)).toBe(true)
    await gateway.dispose()
  })

  it('refuses a second member driving a conversation the first claimed', async () => {
    const gateway = await withGateway()
    const alice = { userId: 'u-alice', tokenId: 't1', actorType: 'user' }
    const bob = { userId: 'u-bob', tokenId: 't2', actorType: 'user' }
    const prompt = (subject: unknown): unknown => gateway.decide({
      subject,
      endpoint: 'session/prompt',
      args: { request: { sessionId: 's-1' } },
    })
    expect(prompt(alice)).toBeUndefined()
    expect(prompt(bob)).toMatchObject({ code: 'session/not-controller' })
    await gateway.dispose()
  })

  it('refuses a second member opening a terminal in a claimed conversation', async () => {
    const gateway = await withGateway()
    const alice = { userId: 'u-alice', tokenId: 't1', actorType: 'user' }
    const bob = { userId: 'u-bob', tokenId: 't2', actorType: 'user' }
    gateway.decide({ subject: alice, endpoint: 'session/prompt', args: { request: { sessionId: 's-1' } } })
    const create = (subject: unknown): unknown => gateway.decide({
      subject,
      endpoint: 'terminal/create',
      args: { agentId: 's-1', request: { id: 'probe', cols: 80, rows: 24 } },
    })
    expect(create(alice)).toBeUndefined()
    expect(create(bob)).toMatchObject({ code: 'session/not-controller' })
    // Watching a terminal is not driving one, so attaching is never refused.
    expect(gateway.decide({
      subject: bob,
      endpoint: 'terminal/follow',
      args: { agentId: 's-1', id: 'probe', attachmentId: 'a' },
    })).toBeUndefined()
    await gateway.dispose()
  })

  it('routes an Agent interaction request to whoever claimed that conversation', async () => {
    const gateway = await withGateway()
    const alice = { userId: 'u-alice', tokenId: 't1', actorType: 'user' }
    // An unclaimed Agent resolves to no owner, leaving delivery as it always was.
    expect(gateway.ownerOf('s-1')).toBeUndefined()

    gateway.decide({ subject: alice, endpoint: 'session/prompt', args: { request: { sessionId: 's-1' } } })
    // An Agent's identity is its Session id, so the claim answers the event too.
    expect(gateway.ownerOf('s-1')).toEqual(alice)
    expect(gateway.ownerOf('s-2')).toBeUndefined()
    await gateway.dispose()
  })

  it('asks the transport to move outstanding requests when control changes', async () => {
    const gateway = await withGateway()
    // Control moving is what makes a request's holder wrong, so the plugin must
    // tell the transport to withdraw and re-offer that conversation's requests.
    // Claiming counts: a request raised while nobody owned the conversation has
    // to reach whoever just took it.
    gateway.control.decide('s-1', { userId: 'u-alice', tokenId: 't1', actorType: 'user' })
    expect(gateway.moved()).toEqual(['s-1'])

    gateway.control.handOver('s-1', { userId: 'u-bob', tokenId: 't2', actorType: 'user' })
    expect(gateway.moved()).toEqual(['s-1', 's-1'])

    // Releasing control also moves it — there is nobody to re-deliver to, but the
    // old holder must still be told to stop waiting.
    gateway.control.handOver('s-1')
    expect(gateway.moved().filter(entry => entry === 's-1')).toHaveLength(3)
    await gateway.dispose()
  })

  it('tells the transport when a disabled member loses their conversations', async () => {
    const gateway = await withGateway()
    const alice = { userId: 'u-alice', tokenId: 't1', actorType: 'user' as const }
    gateway.control.decide('s-1', alice)
    // The claim already moved control, so only what follows it is under test.
    const before = gateway.moved().length
    // Ending an account's control is control moving too: without the notice the
    // transport keeps the requests it addressed to them and still accepts their
    // answers, which is the thing revocation exists to stop.
    expect(gateway.control.forgetUser('u-alice')).toBe(1)
    expect(gateway.moved().slice(before)).toEqual(['s-1'])
    await gateway.dispose()
  })

  it('moves control by an explicit takeover, never on a timer', async () => {
    const ctx = new Context()
    let tick: (() => void) | undefined
    const moved: string[] = []
    const hostFiber = ctx.plugin((pluginCtx) => {
      new HostConnectionService(pluginCtx, [], ADMITTED_AUTH as never)
      // A timer is available, and must stay unused: nothing moves control on a
      // clock any more, because a holder may be reading a long run.
      pluginCtx.provide('timer', {
        interval: (callback: () => void) => {
          tick = callback
          return () => { tick = undefined }
        },
      })
      pluginCtx.provide('typertGateway', {
        setCallPolicy: () => () => {},
        setEventOwnerResolver: () => () => {},
        setEventAnswerPolicy: () => () => {},
        hasPendingRemoteEvents: () => false,
        reDeliverRemoteEvents: (agentId: string) => {
          moved.push(agentId)
          return 1
        },
      })
    })
    await hostFiber.await()
    const teamFiber = ctx.plugin({ apply }, configuration(home()))
    await teamFiber.await()
    expect(tick).toBeUndefined()

    const identity = ctx.get('teamIdentity') as TeamIdentity
    const alice = { userId: 'u-alice', tokenId: 't1', actorType: 'user' } as const
    vi.useFakeTimers()
    try {
      identity.control.decide('s-1', alice)
      vi.advanceTimersByTime(16 * 60 * 1000)
      // Still hers after the window: the window is a permission, not an event.
      expect(identity.control.controllerOf('s-1')).toEqual(alice)
      // Taking it over is what withdraws the requests addressed to a member who
      // left and offers them to the one who took the conversation — the thing
      // nobody could do for themselves before.
      expect(identity.takeOver('s-1', { userId: 'u-bob', tokenId: 't2', expiresAt: 0 })).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
    expect(moved).toContain('s-1')

    await teamFiber.dispose()
    await hostFiber.dispose()
  })
})
