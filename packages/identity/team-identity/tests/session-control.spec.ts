/**
 * Who may drive a conversation, which lease they hold it under, whose
 * interaction requests it owns, and which answers the deployment admits.
 *
 * The behaviour worth protecting: watching stays open, writing has one
 * controller, control never changes silently — and, most importantly, **the
 * lease is what makes a late answer stale**. Comparing members alone accepts an
 * answer from a controller's earlier tenure, which is the A → B → A case below.
 * The lease is read on the live path: the transport asks this deployment's rule
 * before it settles a forwarded request.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionSubject } from '@deepseek-ai/dsh-client-connection'
import {
  controlEndpoints, managementEndpoints, sessionAnswerPolicy, sessionControlPolicy, sessionEventOwner,
} from '../src/call-policy.ts'
import { SessionControl } from '../src/session-control.ts'

function member(userId: string, clientInstanceId?: string): ConnectionSubject {
  return {
    userId,
    tokenId: `t-${userId}`,
    actorType: 'user',
    ...clientInstanceId === undefined ? {} : { clientInstanceId },
  }
}

function policy(control = new SessionControl()) {
  return sessionControlPolicy(control, userId => `成员 ${userId}`)
}

/**
 * The controller clock a refusal carries.
 *
 * It is measured from the holder's last accepted act, so a millisecond or two of
 * real time passes between claiming a conversation and being refused it — an
 * exact expectation would make these tests depend on how fast the machine is.
 * @param details - the refusal's `details` field.
 * @returns the idle time it reported.
 */
function idleClockOf(details: unknown): number {
  const idleMs = (details as { readonly idleMs?: unknown } | undefined)?.idleMs
  expect(typeof idleMs).toBe('number')
  return idleMs as number
}

/** The window a holder must be idle for before anyone else may take over. */
const WINDOW_MS = 15 * 60 * 1000

describe('claims and refusal', () => {
  it('lets the first writer claim a conversation', () => {
    const control = new SessionControl()
    const alice = member('alice')
    const decision = control.decide('s1', alice)
    expect(decision.allowed).toBe(true)
    expect(decision).toMatchObject({ controller: alice })
    expect(control.controllerOf('s1')).toEqual(alice)
    expect(control.leaseOf('s1')).toMatch(/^l-/u)
  })

  it('keeps the same controller writing under the same lease', () => {
    const control = new SessionControl()
    const first = control.decide('s1', member('alice'))
    const second = control.decide('s1', member('alice'))
    // Renewal is not a new tenure.
    if (!first.allowed || !second.allowed) throw new Error('expected both writes to be allowed')
    expect(second.leaseId).toBe(first.leaseId)
  })

  it('refuses a second member without displacing the controller', () => {
    const control = new SessionControl()
    const alice = member('alice')
    control.decide('s1', alice)
    const refused = control.decide('s1', member('bob'))
    expect(refused).toMatchObject({ allowed: false, reason: 'not-controller', controller: alice })
    expect(control.controllerOf('s1')).toEqual(alice)
  })

  it('scopes control per conversation', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    expect(control.decide('s2', member('bob')).allowed).toBe(true)
  })

  it('mints a new lease on an explicit handover', () => {
    const control = new SessionControl()
    const before = control.decide('s1', member('alice'))
    const moved = control.handOver('s1', member('bob'))
    if (!before.allowed) throw new Error('expected the first write to be allowed')
    expect(moved.leaseId).not.toBe(before.leaseId)
    expect(control.controllerOf('s1')).toEqual(member('bob'))
  })

  it('lets the next writer claim a released conversation', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    control.handOver('s1')
    expect(control.controllerOf('s1')).toBeUndefined()
    expect(control.decide('s1', member('bob')).allowed).toBe(true)
  })

  it('refuses the next writer however long the holder has been idle', () => {
    const control = new SessionControl()
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      vi.advanceTimersByTime(16 * 60 * 1000)
      // Nothing lapses on a clock: the holder may be reading a long run, and a
      // silent reassignment is how a working member loses their place.
      expect(control.controllerOf('s1')).toEqual(member('alice'))
      expect(control.decide('s1', member('bob'))).toMatchObject({ allowed: false, reason: 'not-controller' })
      // What the window buys is the *permission* to take it over, visibly.
      expect(control.controlState('s1')).toMatchObject({ idleMs: 16 * 60 * 1000, mayTakeOver: true })
      expect(control.takeOver('s1', member('bob'))).toMatchObject({ ok: true })
      expect(control.decide('s1', member('bob')).allowed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an active controller past the idle window', () => {
    const control = new SessionControl()
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      // Writes every few minutes: the lease renews, so it never lapses mid-work.
      for (let minute = 0; minute < 5; minute += 1) {
        vi.advanceTimersByTime(10 * 60 * 1000)
        expect(control.decide('s1', member('alice')).allowed).toBe(true)
      }
      expect(control.controllerOf('s1')).toEqual(member('alice'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases every conversation one member was driving', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    control.decide('s2', member('alice'))
    control.decide('s3', member('bob'))

    expect(control.forgetUser('alice')).toBe(2)
    expect(control.controllerOf('s1')).toBeUndefined()
    expect(control.decide('s1', member('bob')).allowed).toBe(true)
    expect(control.controllerOf('s3')).toEqual(member('bob'))
  })

  it('keeps the reverse index honest across a handover', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    control.handOver('s1', member('bob'))
    expect(control.forgetUser('alice')).toBe(0)
    expect(control.controllerOf('s1')).toEqual(member('bob'))
  })
})

describe('control changes hands only when somebody acts', () => {
  it('never releases a lease on its own', () => {
    const moved: string[] = []
    const control = new SessionControl((sessionId) => { moved.push(sessionId) })
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      // Claiming is control moving, so the transport hears about it here as well.
      expect(moved).toEqual(['s1'])
      moved.length = 0
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      // A day later the conversation is still hers: an idle window is not an
      // expiry, and nothing is withdrawn from a member who never left.
      expect(control.controllerOf('s1')).toEqual(member('alice'))
      expect(moved).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a takeover while the holder has not been idle long enough', () => {
    const control = new SessionControl()
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(control.takeOver('s1', member('bob'))).toMatchObject({
        ok: false,
        reason: 'not-idle',
        controller: member('alice'),
        idleMs: 5 * 60 * 1000,
        requiredIdleMs: 15 * 60 * 1000,
      })
      // And the refusal changed nothing at all.
      expect(control.controllerOf('s1')).toEqual(member('alice'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes over after the window, and tells the transport', () => {
    const moved: string[] = []
    const control = new SessionControl((sessionId) => { moved.push(sessionId) })
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      moved.length = 0
      vi.advanceTimersByTime(16 * 60 * 1000)
      expect(control.takeOver('s1', member('bob'))).toMatchObject({ ok: true, controller: member('bob') })
      // Requests addressed to the member who left have to be withdrawn and
      // offered to the one who took over, and the old holder stopped writing.
      expect(moved).toEqual(['s1'])
      expect(control.decide('s1', member('bob')).allowed).toBe(true)
      expect(control.decide('s1', member('alice'))).toMatchObject({ allowed: false, reason: 'not-controller' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a takeover by the holder as a no-op', () => {
    const moved: string[] = []
    const control = new SessionControl((sessionId) => { moved.push(sessionId) })
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      const lease = control.leaseOf('s1')
      moved.length = 0
      vi.advanceTimersByTime(16 * 60 * 1000)
      // Idempotent, and deliberately not a renewal: minting a lease here would
      // re-deliver the conversation's outstanding requests, and re-arming the
      // clock would let anyone hold a conversation merely by asking for it.
      expect(control.takeOver('s1', member('alice'))).toMatchObject({ ok: true, leaseId: lease })
      expect(control.leaseOf('s1')).toBe(lease)
      expect(moved).toEqual([])
      expect(control.controlState('s1').idleMs).toBe(16 * 60 * 1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets anyone take an unheld conversation', () => {
    const control = new SessionControl()

    expect(control.takeOver('s1', member('bob'))).toMatchObject({ ok: true, controller: member('bob') })
    expect(control.controllerOf('s1')).toEqual(member('bob'))
  })

  it('lets only one of two takeovers win, judging the second against the new holder', () => {
    const moved: string[] = []
    const control = new SessionControl((sessionId) => { moved.push(sessionId) })
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      moved.length = 0
      vi.advanceTimersByTime(16 * 60 * 1000)

      // Two members ask at the same instant. The second is decided against what
      // the first left behind, not against the holder who was idle: whoever just
      // took over has been idle for no time at all, so the loser is refused and
      // told who holds it now.
      const first = control.takeOver('s1', member('bob'))
      const second = control.takeOver('s1', member('carol'))

      expect(first).toMatchObject({ ok: true, controller: member('bob') })
      expect(second).toMatchObject({
        ok: false,
        reason: 'not-idle',
        controller: member('bob'),
        idleMs: 0,
        requiredIdleMs: 15 * 60 * 1000,
      })
      expect(control.controllerOf('s1')).toEqual(member('bob'))
      // One takeover, so the conversation's outstanding requests move once.
      expect(moved).toEqual(['s1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a conversation waiting on an answer without blocking a takeover', () => {
    let busy = true
    const control = new SessionControl(undefined, 60_000)
    control.watchBusy(() => busy)
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(control.controlState('s1')).toMatchObject({ pending: true, mayTakeOver: true })
      // The holder is being waited on but has been quiet past the window, and
      // taking over is exactly how an unanswered request stops waiting on
      // somebody who is not there. The re-delivery that follows offers it to the
      // new holder, which is what used to be impossible.
      expect(control.takeOver('s1', member('bob'))).toMatchObject({ ok: true, controller: member('bob') })
      busy = false
      expect(control.controlState('s1').pending).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms the idle clock when the holder is touched', () => {
    const control = new SessionControl(undefined, 60_000)
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      vi.advanceTimersByTime(59_000)
      control.touch('s1')
      vi.advanceTimersByTime(59_000)
      expect(control.controlState('s1').mayTakeOver).toBe(false)
      vi.advanceTimersByTime(1_000)
      expect(control.controlState('s1').mayTakeOver).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honours a configured window', () => {
    const control = new SessionControl(undefined, 60_000)
    vi.useFakeTimers()
    try {
      control.decide('s1', member('alice'))
      vi.advanceTimersByTime(30_000)
      expect(control.takeOver('s1', member('bob'))).toMatchObject({ ok: false, reason: 'not-idle' })
      vi.advanceTimersByTime(31_000)
      expect(control.takeOver('s1', member('bob'))).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the takeover window out of the project write right', () => {
    const control = new SessionControl(undefined, 60_000, 10 * 60 * 1000)
    vi.useFakeTimers()
    try {
      expect(control.decide('s1', member('alice'), 'p')).toMatchObject({ allowed: true })
      // Past the takeover window, nowhere near the project's own TTL: the second
      // conversation is still refused the directory.
      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(control.decide('s2', member('bob'), 'p')).toMatchObject({ allowed: false, reason: 'project-busy' })
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(control.decide('s2', member('bob'), 'p')).toMatchObject({ allowed: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('one member, two pages', () => {
  it('refuses a second tab of the same member', () => {
    // One member is one person, but two tabs are two independent editors, and two
    // editors writing one conversation is what this binding exists to prevent.
    const control = new SessionControl()
    const firstTab = member('alice', 'tab-1')
    const secondTab = member('alice', 'tab-2')
    expect(control.decide('s1', firstTab).allowed).toBe(true)
    expect(control.decide('s1', secondTab)).toMatchObject({ allowed: false, reason: 'not-controller' })
    // The second tab must not have displaced the first.
    expect(control.controllerOf('s1')).toEqual(firstTab)
  })

  it('still lets the same tab keep writing', () => {
    const control = new SessionControl()
    const tab = member('alice', 'tab-1')
    control.decide('s1', tab)
    expect(control.decide('s1', tab).allowed).toBe(true)
  })

  it('lets each tab drive its own conversation', () => {
    const control = new SessionControl()
    expect(control.decide('s1', member('alice', 'tab-1')).allowed).toBe(true)
    // Per conversation, not per member: a second tab is a different editor, and
    // different conversations are different work.
    expect(control.decide('s2', member('alice', 'tab-2')).allowed).toBe(true)
  })

  it('admits a caller that declares no page instance', () => {
    // An older client, or one that simply does not send the header, must not be
    // locked out of its own conversation. It just cannot be told from a tab.
    const control = new SessionControl()
    control.decide('s1', member('alice', 'tab-1'))
    expect(control.decide('s1', member('alice')).allowed).toBe(true)
  })

  it('adopts the first page instance a caller declares', () => {
    const control = new SessionControl()
    // Claimed without an instance, then the same member declares one: the lease
    // adopts it so later requests from that page match consistently.
    expect(control.decide('s1', member('alice')).allowed).toBe(true)
    expect(control.decide('s1', member('alice', 'tab-1')).allowed).toBe(true)
    expect(control.controllerOf('s1')).toEqual(member('alice', 'tab-1'))
    // Now the other tab is a different editor.
    expect(control.decide('s1', member('alice', 'tab-2')).allowed).toBe(false)
  })

  it('moves control when it is handed to the same member on another page', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice', 'tab-1'))
    control.handOver('s1', member('alice', 'tab-2'))
    expect(control.controllerOf('s1')).toEqual(member('alice', 'tab-2'))
    expect(control.decide('s1', member('alice', 'tab-1')).allowed).toBe(false)
    expect(control.decide('s1', member('alice', 'tab-2')).allowed).toBe(true)
  })

  it('disabling a member still releases every page they held', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice', 'tab-1'))
    control.decide('s2', member('alice', 'tab-2'))
    // The reverse index is keyed by member, so revocation is unaffected by which
    // page held what.
    expect(control.forgetUser('alice')).toBe(2)
  })
})

describe('interaction request owners', () => {
  it('routes an Agent interaction request to the member driving it', () => {
    const control = new SessionControl()
    const owner = sessionEventOwner(control)
    expect(owner.ownerOf('s1')).toBeUndefined()
    control.decide('s1', member('alice'))
    // An Agent's identity is its Session id, so the lease answers directly.
    expect(owner.ownerOf('s1')).toEqual(member('alice'))
    expect(owner.ownerOf('s2')).toBeUndefined()
  })

  it('resolves to nobody after a release, so delivery is unchanged', () => {
    const control = new SessionControl()
    const owner = sessionEventOwner(control)
    control.decide('s1', member('alice'))
    control.handOver('s1')
    // No owner means the request fans out as it always did, rather than being lost.
    expect(owner.ownerOf('s1')).toBeUndefined()
  })

  it('follows a handover to the new controller', () => {
    const control = new SessionControl()
    const owner = sessionEventOwner(control)
    control.decide('s1', member('alice'))
    control.handOver('s1', member('bob'))
    expect(owner.ownerOf('s1')).toEqual(member('bob'))
  })
})

describe('one project, two conversations', () => {
  /** A project root; nothing here touches the filesystem. */
  const project = join(tmpdir(), 'dsh-team-project')

  it('admits the first conversation and refuses the second, without claiming it', () => {
    const control = new SessionControl()
    expect(control.decide('s-a', member('alice'), project).allowed).toBe(true)
    // The two conversations are separate and both would be admitted on their own
    // merits; what they share is a directory.
    const refusal = control.decide('s-b', member('bob'), project)
    expect(refusal).toMatchObject({ allowed: false, reason: 'project-busy', holderSessionId: 's-a' })
    // Refused for the project, so it must not have claimed the conversation too.
    expect(control.controllerOf('s-b')).toBeUndefined()
  })

  it('leaves a conversation in another project alone', () => {
    const control = new SessionControl()
    control.decide('s-a', member('alice'), project)
    expect(control.decide('s-b', member('bob'), join(tmpdir(), 'dsh-other-project')).allowed).toBe(true)
  })

  it('admits the holder again, because it already has the project', () => {
    const control = new SessionControl()
    control.decide('s-a', member('alice'), project)
    expect(control.decide('s-a', member('alice'), project).allowed).toBe(true)
  })

  it('lets the project go when its holder stops driving it', () => {
    const control = new SessionControl()
    control.decide('s-a', member('alice'), project)
    control.handOver('s-a')
    expect(control.decide('s-b', member('bob'), project).allowed).toBe(true)
  })

  it('lets the project go when its holder is disabled', () => {
    const control = new SessionControl()
    control.decide('s-a', member('alice'), project)
    // A disabled member must not keep the project locked behind them.
    control.forgetUser('alice')
    expect(control.decide('s-b', member('bob'), project).allowed).toBe(true)
  })

  it('lets the project lapse on its own', () => {
    // Its own clock, given as its own argument: the second argument is the
    // takeover window, and tuning that must not retune the project right.
    const control = new SessionControl(undefined, 15 * 60 * 1000, 60_000)
    vi.useFakeTimers()
    try {
      control.decide('s-a', member('alice'), project)
      expect(control.decide('s-b', member('bob'), project).allowed).toBe(false)
      vi.advanceTimersByTime(61_000)
      expect(control.decide('s-b', member('bob'), project).allowed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not engage at all when a conversation names no project', () => {
    const control = new SessionControl()
    control.decide('s-a', member('alice'))
    expect(control.decide('s-b', member('bob')).allowed).toBe(true)
  })
})

describe('admitting an answer', () => {
  it('admits the controller and refuses everyone else', () => {
    const control = new SessionControl()
    const alice = member('alice')
    control.decide('s1', alice)
    const policy = sessionAnswerPolicy(control)
    expect(policy.accepts('s1', alice)).toBe(true)
    expect(policy.accepts('s1', member('bob'))).toBe(false)
  })

  it('refuses every answer while nobody drives the conversation', () => {
    // Nobody to accept it from: the request may still be waiting, but its
    // controller is gone, and an answer arriving now settles nothing.
    expect(sessionAnswerPolicy(new SessionControl()).accepts('s1', member('alice'))).toBe(false)
  })

  it('refuses an answer from a caller the deployment cannot name', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    // Being unidentifiable must not be a way to settle someone else's request.
    expect(sessionAnswerPolicy(control).accepts('s1', undefined)).toBe(false)
  })

  it('refuses the old controller the moment control moves', () => {
    const control = new SessionControl()
    const alice = member('alice')
    const bob = member('bob')
    control.decide('s1', alice)
    control.handOver('s1', bob)
    const policy = sessionAnswerPolicy(control)
    expect(policy.accepts('s1', alice)).toBe(false)
    expect(policy.accepts('s1', bob)).toBe(true)
  })

  it('refuses the same member answering from a different page', () => {
    const control = new SessionControl()
    const tabOne = member('alice', 'tab-1')
    control.decide('s1', tabOne)
    const policy = sessionAnswerPolicy(control)
    // The request reached one page; the other tab of the same member is a
    // different editor and must not settle it.
    expect(policy.accepts('s1', member('alice', 'tab-2'))).toBe(false)
    expect(policy.accepts('s1', tabOne)).toBe(true)
  })

  it('still admits the holder’s answer however long the conversation has been idle', () => {
    const control = new SessionControl()
    const alice = member('alice')
    control.decide('s1', alice)
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(16 * 60 * 1000)
      // Nothing expires, so the member the Agent is waiting on is still the one
      // who can answer it — and answering marks them present again, which is
      // what keeps somebody else from taking the conversation over mid-answer.
      expect(sessionAnswerPolicy(control).accepts('s1', alice)).toBe(true)
      expect(control.controlState('s1').idleMs).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses an answer once the account is disabled', () => {
    const control = new SessionControl()
    const alice = member('alice')
    control.decide('s1', alice)
    // A disabled member must not settle an approval they were holding when they
    // were disabled; that is what revoking them has to mean.
    control.forgetUser('alice')
    expect(sessionAnswerPolicy(control).accepts('s1', alice)).toBe(false)
  })

  it('admits an answer when the request carries no page of its own', () => {
    const control = new SessionControl()
    const alice = member('alice')
    control.decide('s1', alice)
    // The holder declared no page, so its member may answer from any of them;
    // that is the honest consequence of not identifying the page.
    expect(sessionAnswerPolicy(control).accepts('s1', member('alice', 'tab-9'))).toBe(true)
  })
})

describe('a bounded workspace root', () => {
  /** A root that deliberately does not exist: creation usually precedes it. */
  const root = join(tmpdir(), 'dsh-team-workspace')

  function policyFor() {
    return sessionControlPolicy(new SessionControl(), userId => userId, { workspaceRoot: root })
  }

  function create(cwd: string | undefined): unknown {
    return policyFor().decide({
      subject: member('alice'),
      endpoint: 'session/create',
      args: { request: cwd === undefined ? {} : { cwd } },
    })
  }

  it('admits a workspace under the root, at any depth', () => {
    expect(create(root)).toBeUndefined()
    expect(create(join(root, 'bob'))).toBeUndefined()
    expect(create(join(root, 'bob', 'hanbao-2026Q1'))).toBeUndefined()
  })

  it('refuses a workspace outside it, which is the picker bypass', () => {
    // The picker bounds what a browser may choose; a creation request names its
    // own directory, so the bound has to be enforced here as well.
    for (const cwd of [tmpdir(), join(root, '..'), join(root, '..', 'elsewhere')]) {
      const refusal = create(cwd)
      expect(refusal).toMatchObject({ code: 'session/workspace-not-allowed' })
    }
  })

  it('leaves a request that names no directory to the deployment default', () => {
    // The default the deployment chose is already inside the bound; refusing a
    // request that simply accepts it would break every ordinary creation.
    expect(create(undefined)).toBeUndefined()
  })

  it('leaves creation alone when the deployment states no root', () => {
    const unbounded = sessionControlPolicy(new SessionControl(), userId => userId)
    expect(unbounded.decide({
      subject: member('alice'),
      endpoint: 'session/create',
      args: { request: { cwd: tmpdir() } },
    })).toBeUndefined()
  })
})

describe('session control policy', () => {
  it('governs exactly the endpoints that drive a conversation', () => {
    expect(controlEndpoints()).toEqual(expect.arrayContaining([
      'session/prompt',
      'session/cancel',
      'session/updateQueue',
      'session/selectModel',
    ]))
    expect(controlEndpoints()).not.toContain('session/list')
    expect(controlEndpoints()).not.toContain('session/follow')
  })

  it('governs the terminal calls that execute, and leaves watching open', () => {
    expect(controlEndpoints()).toEqual(expect.arrayContaining([
      'terminal/create',
      'terminal/write',
      'terminal/resize',
    ]))
    // Attaching is how a member watches someone work, and the terminal's own
    // attachment rule already decides who may type; reading stays open.
    expect(controlEndpoints()).not.toContain('terminal/follow')
    expect(controlEndpoints()).not.toContain('terminal/list')
  })

  it('governs the command channel, which can rewrite a conversation’s policy', () => {
    // `/permission` reaches the sandbox and approval policy of the target
    // conversation, so the channel is a way to act on it, not to read it.
    expect(controlEndpoints()).toContain('commands/execute')
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    const refusal = policy(control).decide({
      subject: member('bob'),
      endpoint: 'commands/execute',
      args: { agentId: 's1', line: '/permission danger-full-access' },
    })
    expect(refusal?.code).toBe('session/not-controller')
    expect(refusal?.details).toMatchObject({
      sessionId: 's1',
      reason: 'not-controller',
      // The clock travels with the refusal, so the client can tell a member
      // whether taking the conversation over is possible yet.
      requiredIdleMs: WINDOW_MS,
      mayTakeOver: false,
    })
    // Not idle yet: the holder acted a moment ago.
    expect(idleClockOf(refusal?.details)).toBeLessThan(WINDOW_MS)
  })

  it('requires a resolved caller for every deployment-management write', () => {
    const managed = managementEndpoints()
    expect(managed).toEqual(expect.arrayContaining([
      'settings/update',
      'settings/replace',
      'settings/mutate',
      'settings/openSettingsDocument',
      'credentials/set',
      'credentials/unset',
    ]))
    for (const endpoint of managed) {
      // Without a caller these were reachable on the transport cookie alone.
      expect(policy().decide({ subject: undefined, endpoint, args: {} })?.code)
        .toBe('identity/required')
      // With one they are admitted whole: who may change deployment state is a
      // resource-authorization question this round does not answer.
      expect(policy().decide({ subject: member('alice'), endpoint, args: {} })).toBeUndefined()
    }
  })

  it('leaves deployment reads open', () => {
    for (const endpoint of ['settings/describe', 'credentials/describe', 'session/list']) {
      expect(policy().decide({ subject: undefined, endpoint, args: {} })).toBeUndefined()
    }
  })

  it('refuses a write into a project another conversation is driving', () => {
    const control = new SessionControl()
    const project = join(tmpdir(), 'dsh-policy-project')
    const bounded = sessionControlPolicy(control, userId => `成员 ${userId}`, {
      projectOf: () => project,
    })
    const write = (subject: ConnectionSubject, sessionId: string) => bounded.decide({
      subject,
      endpoint: 'session/prompt',
      args: { request: { sessionId } },
    })
    expect(write(member('alice'), 's-a')).toBeUndefined()
    // Distinct conversations, distinct controllers, one directory: the refusal is
    // about the project, and it says so rather than blaming the member.
    expect(write(member('bob'), 's-b')).toMatchObject({
      code: 'project/busy',
      details: { sessionId: 's-b', holderSessionId: 's-a' },
    })
  })

  it('reads a terminal call conversation from the resolved Agent', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    const refusal = policy(control).decide({
      subject: member('bob'),
      endpoint: 'terminal/create',
      args: { agentId: 's1', request: { id: 'probe', cols: 80, rows: 24 } },
    })
    expect(refusal?.code).toBe('session/not-controller')
    expect(refusal?.details).toMatchObject({
      sessionId: 's1',
      reason: 'not-controller',
      // The clock travels with the refusal, so the client can tell a member
      // whether taking the conversation over is possible yet.
      requiredIdleMs: WINDOW_MS,
      mayTakeOver: false,
    })
    expect(idleClockOf(refusal?.details)).toBeLessThan(WINDOW_MS)
  })

  it('lets the conversation controller open a terminal', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    expect(policy(control).decide({
      subject: member('alice'),
      endpoint: 'terminal/write',
      args: { agentId: 's1', id: 'probe', attachmentId: 'a', data: 'dir\r' },
    })).toBeUndefined()
  })

  it('refuses a terminal from a caller with no resolved identity', () => {
    expect(policy().decide({
      subject: undefined,
      endpoint: 'terminal/create',
      args: { agentId: 's1', request: { id: 'probe', cols: 80, rows: 24 } },
    })?.code).toBe('session/control-required')
  })

  it('allows every non-control endpoint', () => {
    expect(policy().decide({
      subject: undefined,
      endpoint: 'session/list',
      args: {},
    })).toBeUndefined()
  })

  it('refuses a write from a member who is not the controller', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    const refusal = policy(control).decide({
      subject: member('bob'),
      endpoint: 'session/prompt',
      args: { request: { sessionId: 's1' } },
    })
    expect(refusal?.code).toBe('session/not-controller')
    expect(refusal?.message).toContain('成员 alice')
    expect(refusal?.details).toMatchObject({
      sessionId: 's1',
      reason: 'not-controller',
      // The clock travels with the refusal, so the client can tell a member
      // whether taking the conversation over is possible yet.
      requiredIdleMs: WINDOW_MS,
      mayTakeOver: false,
    })
    expect(idleClockOf(refusal?.details)).toBeLessThan(WINDOW_MS)
  })

  it('lets the controller write', () => {
    const control = new SessionControl()
    control.decide('s1', member('alice'))
    expect(policy(control).decide({
      subject: member('alice'),
      endpoint: 'session/cancel',
      args: { request: { sessionId: 's1' } },
    })).toBeUndefined()
  })

  it('refuses a write from a caller with no resolved identity', () => {
    expect(policy().decide({
      subject: undefined,
      endpoint: 'session/prompt',
      args: { request: { sessionId: 's1' } },
    })?.code).toBe('session/control-required')
  })

  it('leaves a malformed request to the endpoint own validation', () => {
    expect(policy().decide({
      subject: member('alice'),
      endpoint: 'session/prompt',
      args: {},
    })).toBeUndefined()
  })
})
