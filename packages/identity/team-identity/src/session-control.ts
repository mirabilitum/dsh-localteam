/**
 * Who may drive a conversation, which lease they hold it under, and who its
 * interaction requests belong to.
 *
 * Shared viewing is the point of a team deployment, so this does **not** hide
 * other members' conversations: every member may read any conversation and watch
 * its progress. What it restricts is the writing — sending a prompt, cancelling a
 * turn, editing the queue, switching the model — because two people driving one
 * conversation at the same time is what actually corrupts work.
 *
 * **Why a lease number and not just a member id.** Comparing the caller against
 * the current controller is not enough. Member A hands off to B and later takes
 * control again: a late answer A produced during their *first* tenure would match
 * "A is the controller" and be accepted. The lease number is what makes that
 * answer stale, so every acquisition — including re-acquisition — mints a new one.
 *
 * A lease never ends on its own. Control moves only when its holder hands it over
 * or another member explicitly takes it, and the takeover window below decides
 * *when* that is allowed rather than doing it: a member who went home must be
 * taken over by somebody, not silently replaced.
 *
 * @module @deepseek-ai/dsh-team-identity/session-control
 */

import type { ConnectionSubject } from '@deepseek-ai/dsh-client-connection'

/** How one write attempt fared against the current lease. */
export type SessionControlDecision =
  | { readonly allowed: true; readonly controller: ConnectionSubject; readonly leaseId: string }
  | {
    readonly allowed: false
    readonly reason: 'not-controller'
    readonly controller: ConnectionSubject
    readonly leaseId: string
  }
  | {
    /**
     * A different conversation is already driving this one's project.
     *
     * Neither caller is at fault: the conversation lease admits both, and what
     * collides is the directory they would both write into.
     */
    readonly allowed: false
    readonly reason: 'project-busy'
    /** The conversation currently holding the project's write right. */
    readonly holderSessionId: string
  }

/**
 * One project's write right, held by the conversation that last wrote in it.
 *
 * Projects are shared on purpose — a member has to see what another produced —
 * which is exactly why two conversations writing one directory is a collision
 * and not an isolation problem. The right serializes the writes instead of
 * splitting the directory.
 */
interface ProjectRight {
  /** Conversation holding it. */
  readonly sessionId: string
  /** Unix milliseconds after which the project may be claimed by another conversation. */
  expiresAt: number
}

/** One conversation's controller and the lease they hold it under. */
interface Lease {
  readonly controller: ConnectionSubject
  /** Monotonic per conversation; every acquisition mints a new one. */
  readonly leaseId: string
  /**
   * Unix milliseconds of the last accepted act by this controller.
   *
   * Not an expiry: a lease no longer ends on its own. It is the clock the
   * takeover window is measured against, so a holder who is working is never
   * mistaken for one who went home.
   */
  readonly lastActiveAt: number
}

/** How long one conversation has been idle, and whether it may be taken over. */
export interface ControlState {
  /** Current holder, or undefined when nobody drives the conversation. */
  readonly controller?: ConnectionSubject
  /** Milliseconds since the holder's last accepted act; 0 when unclaimed. */
  readonly idleMs: number
  /** How long a holder must be idle before anyone else may take over. */
  readonly requiredIdleMs: number
  /** Whether the conversation is waiting on an answer from its holder. */
  readonly pending: boolean
  /** Whether a takeover would be accepted right now. */
  readonly mayTakeOver: boolean
}

/** How one takeover attempt fared. */
export type TakeOverOutcome =
  | { readonly ok: true; readonly controller: ConnectionSubject; readonly leaseId: string }
  | {
    /** Someone else holds it and has not been idle long enough. */
    readonly ok: false
    readonly reason: 'not-idle'
    readonly controller: ConnectionSubject
    readonly idleMs: number
    readonly requiredIdleMs: number
  }

/**
 * Whether an incoming request is the same controller as the lease holder.
 *
 * The member id alone is not enough. One member with two tabs open is still one
 * person, but it is two independent editors, and two editors writing one
 * conversation is exactly what this binding exists to prevent — so when the
 * incoming request declares a page instance, the holder must be that same page.
 *
 * A request that declares no page instance is treated as the member: an older
 * client, or a caller that simply does not send the header, must not be locked out
 * of its own conversation. The cost is that such a client cannot be told apart
 * from another tab, which is the honest consequence of not identifying itself.
 * @param controller - the subject holding the lease.
 * @param subject - the subject attempting to write.
 * @returns true when this write belongs to the lease holder.
 */
export function sameController(controller: ConnectionSubject, subject: ConnectionSubject): boolean {
  if (controller.userId !== subject.userId) return false
  if (subject.clientInstanceId === undefined) return true
  // A holder that never declared a page cannot be compared to one that did, so it
  // adopts the first instance its member declares rather than refusing its own
  // conversation. Once a holder has an instance, only that page matches.
  if (controller.clientInstanceId === undefined) return true
  return controller.clientInstanceId === subject.clientInstanceId
}

/**
 * Controller leases for the conversations this process is serving.
 *
 * Leases are process-local and in memory: a restart clears them and lets the
 * first caller claim each conversation again. Losing them is safe — the failure
 * mode is "the first person to act becomes the controller" rather than "nobody
 * may act" — and it avoids inventing durable state ahead of the report-side
 * control-lease table that will own this properly.
 */
export class SessionControl {
  private readonly leases = new Map<string, Lease>()
  /** Reverse index so disabling a member can release everything they were driving. */
  private readonly held = new Map<string, Set<string>>()
  /**
   * Project write rights, keyed by canonical project root.
   *
   * A project directory is shared on purpose, so two conversations writing it is
   * a collision to serialize rather than a directory to split. Held by the
   * conversation that last wrote there, and released with that conversation.
   */
  private readonly projects = new Map<string, ProjectRight>()
  private sequence = 0

  /**
   * @param onControlMoved - called with the conversation whose control changed,
   *   so the owner can withdraw and re-deliver whatever that conversation was
   *   still waiting on. Absent, control still moves; only the re-delivery hook is
   *   skipped.
   * @param takeoverIdleMs - how long a holder may be idle before anyone else may
   *   take the conversation over. Deliberately **not** an expiry: control only
   *   ever moves by an explicit act.
   * @param projectWriteTtlMs - how long one conversation's project write right
   *   survives without a write. Its own clock, because it answers a different
   *   question: which conversation is allowed to write this directory, not who
   *   may speak for a conversation.
   */
  constructor(
    private readonly onControlMoved?: (sessionId: string) => void,
    private readonly takeoverIdleMs: number = IDLE_BEFORE_TAKEOVER_MS,
    private readonly projectWriteTtlMs: number = PROJECT_WRITE_TTL_MS,
  ) {}

  /**
   * Tell the binding how to recognize a conversation that is still being waited on.
   *
   * It no longer decides whether a lease survives — nothing expires any more —
   * but it is what {@link SessionControl.controlState} reports, so a member
   * deciding whether to take a conversation over can see that its holder is being
   * waited on rather than merely quiet.
   * @param busy - reports whether one conversation is still waiting on an answer.
   */
  watchBusy(busy: (sessionId: string) => boolean): void {
    this.busyOf = busy
  }

  /** Set by {@link watchBusy}; absent when the deployment has no request surface. */
  private busyOf: ((sessionId: string) => boolean) | undefined

  /**
   * Decide whether one member may drive one conversation, claiming it if free.
   *
   * Control never lapses on its own. A lease that exists belongs to somebody
   * until they hand it over or somebody else explicitly takes it (see
   * {@link SessionControl.takeOver}), so a caller who is not the controller is
   * refused however long the controller has been quiet — the quiet holder may be
   * reading a long run, and silently reassigning the conversation on a timer is
   * how a working member loses their place.
   *
   * A conversation that names a project is also checked against that project's
   * write right, and that check comes first: a caller refused for the project has
   * no business claiming the conversation on the way past.
   * @param sessionId - conversation being addressed.
   * @param subject - member attempting the write.
   * @param project - canonical root of the directory this write would touch, when known.
   * @returns the decision, including the controller it was made against.
   */
  decide(sessionId: string, subject: ConnectionSubject, project?: string): SessionControlDecision {
    if (project !== undefined && !this.mayWriteProject(project, sessionId)) {
      const holder = this.projects.get(project)
      if (holder !== undefined) {
        return { allowed: false, reason: 'project-busy', holderSessionId: holder.sessionId }
      }
    }
    const lease = this.leases.get(sessionId)
    if (lease === undefined) {
      const claimed = this.claim(sessionId, subject)
      this.takeProject(project, sessionId)
      // Claiming is control moving, so the transport has to hear about it just as
      // it does for a handover. Without this, a request that was raised while
      // nobody owned the conversation stays with whoever received it then — the
      // member who just claimed never gets the question they are now the one who
      // can answer.
      this.onControlMoved?.(sessionId)
      return { allowed: true, ...claimed }
    }
    if (!sameController(lease.controller, subject)) {
      return {
        allowed: false,
        reason: 'not-controller',
        controller: lease.controller,
        leaseId: lease.leaseId,
      }
    }
    // An active controller must not lose the conversation while still working in
    // it, so every accepted write marks them active. The lease number stays the
    // same: renewal is not a new tenure, and interactions already delivered under
    // it remain answerable. A caller that has since declared a page instance
    // adopts it, so every later request from that page matches consistently.
    const adopted: ConnectionSubject = subject.clientInstanceId === undefined
      || subject.clientInstanceId === lease.controller.clientInstanceId
      ? lease.controller
      : { ...lease.controller, clientInstanceId: subject.clientInstanceId }
    const renewed: Lease = { ...lease, controller: adopted, lastActiveAt: Date.now() }
    this.leases.set(sessionId, renewed)
    this.takeProject(project, sessionId)
    return { allowed: true, controller: renewed.controller, leaseId: renewed.leaseId }
  }

  /**
   * Read one conversation's controller without claiming it.
   * @param sessionId - conversation to inspect.
   * @returns the controller, or undefined when the conversation is unclaimed.
   */
  controllerOf(sessionId: string): ConnectionSubject | undefined {
    return this.leases.get(sessionId)?.controller
  }

  /**
   * Read the lease one conversation is currently held under.
   * @param sessionId - conversation to inspect.
   * @returns the lease number, or undefined when unclaimed.
   */
  leaseOf(sessionId: string): string | undefined {
    return this.leases.get(sessionId)?.leaseId
  }

  /**
   * Hand control to another member, or release it so the next writer claims it.
   *
   * Both outcomes mint a new lease, which is what makes a request the previous
   * controller is still holding answerable by nobody: the transport is told to
   * withdraw it, and the rule that admits an answer reads this lease.
   * @param sessionId - conversation whose control changes.
   * @param subject - member receiving control, or undefined to release it.
   * @returns the new lease number, or undefined when control was released.
   */
  handOver(sessionId: string, subject?: ConnectionSubject): { readonly leaseId?: string } {
    if (subject === undefined) {
      this.release(sessionId)
      // The transport owns the forwarded requests themselves, so telling it that
      // control moved is what withdraws them from a holder who can no longer
      // answer.
      this.onControlMoved?.(sessionId)
      return {}
    }
    const claimed = this.claim(sessionId, subject)
    this.onControlMoved?.(sessionId)
    return { leaseId: claimed.leaseId }
  }

  /**
   * Drop one conversation's lease.
   * @param sessionId - conversation to forget.
   */
  forget(sessionId: string): void {
    this.release(sessionId)
  }

  /**
   * Release every conversation one member was driving.
   *
   * Disabling an account has to take its control with it: a lease that outlived
   * the revocation would keep routing interaction requests to a member who can no
   * longer answer them.
   * @param userId - member whose leases must end.
   * @returns how many conversations were released.
   */
  forgetUser(userId: string): number {
    const sessions = this.held.get(userId)
    if (sessions === undefined) return 0
    // Snapshot first: forgetting detaches the holder, which mutates this very Set.
    const released = [...sessions]
    for (const sessionId of released) this.forget(sessionId)
    // Ending an account's control is control moving too. Without the notice the
    // transport keeps the requests it addressed to this member and still accepts
    // their answers, so a disabled account could settle an approval after being
    // disabled — the very thing revocation is supposed to stop.
    for (const sessionId of released) this.onControlMoved?.(sessionId)
    return released.length
  }

  /**
   * Read how long one conversation has been idle, and whether it can be taken.
   * @param sessionId - conversation to inspect.
   * @returns the holder, its idle time, whether it is waiting on an answer, and
   *   whether a takeover would be accepted now.
   */
  controlState(sessionId: string): ControlState {
    const lease = this.leases.get(sessionId)
    const pending = this.busyOf?.(sessionId) === true
    if (lease === undefined) {
      return { idleMs: 0, requiredIdleMs: this.takeoverIdleMs, pending, mayTakeOver: true }
    }
    const idleMs = Math.max(0, Date.now() - lease.lastActiveAt)
    return {
      controller: lease.controller,
      idleMs,
      requiredIdleMs: this.takeoverIdleMs,
      pending,
      mayTakeOver: idleMs >= this.takeoverIdleMs,
    }
  }

  /**
   * Mark one conversation's holder as active without moving control.
   *
   * Called for every act that can only come from the holder, including an
   * accepted answer to a forwarded request — which does not pass through
   * {@link SessionControl.decide} and would otherwise leave the clock running
   * while the member is demonstrably present. Reads, downloads, and refused
   * requests deliberately do not call this.
   * @param sessionId - conversation whose holder is active.
   */
  touch(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    this.leases.set(sessionId, { ...lease, lastActiveAt: Date.now() })
  }

  /**
   * Take one conversation over from a holder who has been idle long enough.
   *
   * The explicit counterpart to a lease that no longer expires: control changes
   * because a member decided it should, at a moment when the holder has clearly
   * stopped acting. Taking over an unclaimed conversation is the same act as
   * claiming it, and taking over one's own is a no-op — it must not mint a new
   * lease, because a new lease re-delivers the conversation's outstanding
   * requests and nobody asked for that twice.
   * @param sessionId - conversation to take over.
   * @param subject - member taking it.
   * @returns the new holder, or why the takeover was refused.
   */
  takeOver(sessionId: string, subject: ConnectionSubject): TakeOverOutcome {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) {
      const claimed = this.claim(sessionId, subject)
      this.onControlMoved?.(sessionId)
      return { ok: true, ...claimed }
    }
    if (sameController(lease.controller, subject)) {
      return { ok: true, controller: lease.controller, leaseId: lease.leaseId }
    }
    const idleMs = Math.max(0, Date.now() - lease.lastActiveAt)
    if (idleMs < this.takeoverIdleMs) {
      return {
        ok: false,
        reason: 'not-idle',
        controller: lease.controller,
        idleMs,
        requiredIdleMs: this.takeoverIdleMs,
      }
    }
    const claimed = this.claim(sessionId, subject)
    this.onControlMoved?.(sessionId)
    return { ok: true, ...claimed }
  }

  private claim(    sessionId: string,
    subject: ConnectionSubject,
  ): { readonly controller: ConnectionSubject; readonly leaseId: string } {
    const previous = this.leases.get(sessionId)
    if (previous !== undefined) this.detachHolder(sessionId, previous.controller.userId)
    const lease: Lease = {
      controller: subject,
      leaseId: this.nextLeaseId(),
      lastActiveAt: Date.now(),
    }
    this.leases.set(sessionId, lease)
    const sessions = this.held.get(subject.userId) ?? new Set<string>()
    sessions.add(sessionId)
    this.held.set(subject.userId, sessions)
    return { controller: lease.controller, leaseId: lease.leaseId }
  }

  private release(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined) return
    this.leases.delete(sessionId)
    this.detachHolder(sessionId, lease.controller.userId)
    this.releaseProjects(sessionId)
  }

  /**
   * Whether one conversation may write into one project right now.
   * @param project - canonical project root.
   * @param sessionId - conversation attempting the write.
   * @returns true when the project is free, held by this conversation, or lapsed.
   */
  private mayWriteProject(project: string, sessionId: string): boolean {
    const right = this.projects.get(project)
    if (right === undefined || right.sessionId === sessionId) return true
    return right.expiresAt <= Date.now()
  }

  /**
   * Take or refresh one project's write right for a conversation.
   * @param project - canonical project root, absent when the caller named none.
   * @param sessionId - conversation taking it.
   */
  private takeProject(project: string | undefined, sessionId: string): void {
    if (project === undefined) return
    // Its own clock: shortening the takeover window must not also shorten how
    // long a conversation holds a project against another one.
    this.projects.set(project, { sessionId, expiresAt: Date.now() + this.projectWriteTtlMs })
  }

  /**
   * Drop every project right one conversation was holding.
   * @param sessionId - conversation whose rights end.
   */
  private releaseProjects(sessionId: string): void {
    for (const [project, right] of [...this.projects]) {
      if (right.sessionId === sessionId) this.projects.delete(project)
    }
  }

  private detachHolder(sessionId: string, userId: string): void {
    const sessions = this.held.get(userId)
    if (sessions === undefined) return
    sessions.delete(sessionId)
    if (sessions.size === 0) this.held.delete(userId)
  }

  private nextLeaseId(): string {
    this.sequence += 1
    return `l-${String(this.sequence)}`
  }
}

/**
 * How long a holder must be idle before anyone else may take the conversation.
 *
 * Long enough that a member reading a long run, or deciding what to say, is not
 * displaced mid-thought; short enough that a member who closed the page does not
 * lock the conversation for the rest of the day. Note what this is **not**: it
 * does not end a lease. Nothing moves control except a handover or an explicit
 * takeover, so the idle window is a permission, never an event.
 */
export const IDLE_BEFORE_TAKEOVER_MS = 15 * 60 * 1000

/**
 * How long one conversation's project write right survives without a write.
 *
 * Separate from {@link IDLE_BEFORE_TAKEOVER_MS} on purpose: it answers "which
 * conversation may write this directory", not "who may speak for this
 * conversation", and an operator tuning one must not silently retune the other.
 */
export const PROJECT_WRITE_TTL_MS = 15 * 60 * 1000
