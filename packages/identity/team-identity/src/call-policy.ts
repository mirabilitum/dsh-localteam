/**
 * The deployment's access policy for Remote calls: which member may write to
 * which conversation.
 *
 * Reading stays open on purpose — a team deployment exists so members can watch
 * each other's work — so this refuses only the calls that act: those that drive a
 * conversation, those that execute in its name (the terminal and the command
 * channel), and those that change the deployment itself. It is asked by the
 * Remote transport before the business method runs, which is the only place that
 * knows both the server-resolved caller and the endpoint.
 *
 * @module @deepseek-ai/dsh-team-identity/call-policy
 */

import type { ConnectionSubject } from '@deepseek-ai/dsh-client-connection'
import type {
  RemoteCallContext, RemoteCallPolicy, RemoteEventAnswerPolicy, RemoteEventOwnerResolver,
} from '@deepseek-ai/dsh-api-gateway'
import type { SessionControl } from './session-control.ts'
import { sameController } from './session-control.ts'
import { isWithin } from './workspace-root.ts'

/**
 * Endpoints that drive one conversation, so must have a single controller.
 *
 * These are the canonical `<namespace>/<method>` names the Remote transport
 * dispatches, taken from the session controller's own namespace (`session`, not
 * the package or service name) and its exported method names.
 */
const CONTROL_ENDPOINTS: ReadonlySet<string> = new Set([
  'session/prompt',
  'session/cancel',
  'session/updateQueue',
  'session/selectModel',
  'session/rename',
  'session/fork',
])

/**
 * Endpoints that run commands in a conversation's workspace.
 *
 * The interactive terminal is a second execution entry beside the Agent's own
 * tools, and it carries no per-call ownership of its own: any signed-in member
 * could otherwise spawn a shell in any Session's working directory and type into
 * it, unrecorded. Reading a terminal stays open — watching someone work is the
 * point of a team deployment — so only the three calls that drive it are
 * governed. `terminal/follow` deliberately stays open: attaching is how a member
 * watches, and the terminal's own attachment rule already makes the newest
 * attachment the only writable one.
 */
const TERMINAL_ENDPOINTS: ReadonlySet<string> = new Set([
  'terminal/create',
  'terminal/write',
  'terminal/resize',
])

/**
 * Endpoints that act on a conversation through the slash-command channel.
 *
 * A command is not a read: `/permission` rewrites the target conversation's
 * sandbox and approval policy. This is a second way to act on a conversation
 * beside `session/*`, and leaving it open made the write restriction cosmetic —
 * a member refused `session/prompt` could still change what the controller's own
 * session is allowed to do.
 */
const COMMAND_ENDPOINTS: ReadonlySet<string> = new Set([
  'commands/execute',
])

/**
 * Endpoints that change the deployment rather than a conversation.
 *
 * A conversation lease says nothing about these, so what they need is the thing
 * they never had: a resolved caller. They used to be reachable with nothing but
 * the transport's own browser cookie, which let a browser that had never signed
 * in rewrite the deployment's settings and its stored model credential.
 *
 * Admission is deliberately all-or-nothing per deployment. Deciding *which*
 * member may change global settings would be resource authorization, which this
 * round does not do (checklist §11); requiring that there be a member at all is
 * the part that closes an anonymous write path.
 */
const MANAGEMENT_ENDPOINTS: ReadonlySet<string> = new Set([
  'settings/update',
  'settings/replace',
  'settings/mutate',
  'settings/openSettingsDocument',
  'credentials/set',
  'credentials/unset',
])

/** Wire field every control endpoint addresses its conversation with. */
const SESSION_FIELD = 'sessionId'

/**
 * Wire field a Session-scoped endpoint names its Agent with.
 *
 * The Gateway resolves the `Agent` parameter from the context wire field, and an
 * Agent's identity **is** its Session id, so this is the same conversation the
 * `session/*` endpoints reach through `request.sessionId`.
 */
const AGENT_FIELD = 'agentId'

/** Wire field carrying a control endpoint's single decoded parameter. */
const REQUEST_FIELD = 'request'

/** Endpoint that creates a conversation, and therefore chooses its workspace. */
const SESSION_CREATE_ENDPOINT = 'session/create'

/**
 * Endpoint that starts one turn in a conversation.
 *
 * A turn is what the provenance ledger records, and this is the moment its start
 * is known: the conversation, the member, and the time are all here together, and
 * the record is written before the Agent runs so everything it produces is newer
 * than the record that will claim it. The other control endpoints are left out on
 * purpose — renaming a conversation is not a turn, and logging it as one would
 * renumber the turns a download reports.
 */
const PROMPT_ENDPOINT = 'session/prompt'

/** Wire field a creation request names its workspace directory with. */
const CWD_FIELD = 'cwd'

/**
 * Read the workspace directory a creation request asks for.
 * @param args - decoded wire arguments as the transport received them.
 * @returns the requested directory, or undefined when the request names none.
 */
function requestedCwdOf(args: Readonly<Record<string, unknown>>): string | undefined {
  const request = args[REQUEST_FIELD]
  if (typeof request !== 'object' || request === null) return undefined
  const cwd = (request as Record<string, unknown>)[CWD_FIELD]
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Read the conversation one control call addresses.
 *
 * The policy sees the **wire** payload, not the decoded parameter list: a
 * generated Remote method taking one `request` object arrives as
 * `{ request: { sessionId, ... } }`. Reading through that wrapper is what makes
 * the endpoint's own argument validation the thing that reports a malformed call,
 * while a well-formed call always carries its conversation here.
 *
 * The terminal endpoints are the exception: they name the conversation through
 * the resolved `Agent` parameter (`agentId`) instead of a field of their own
 * request, so that is read last.
 * @param args - decoded wire arguments as the transport received them.
 * @returns the session id, or undefined when the call does not carry one.
 */
function conversationOf(args: Readonly<Record<string, unknown>>): string | undefined {
  const direct = args[SESSION_FIELD]
  if (typeof direct === 'string' && direct.length > 0) return direct
  const request = args[REQUEST_FIELD]
  if (typeof request === 'object' && request !== null) {
    const nested = (request as Record<string, unknown>)[SESSION_FIELD]
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  const agent = args[AGENT_FIELD]
  return typeof agent === 'string' && agent.length > 0 ? agent : undefined
}

/**
 * The endpoints this policy refuses on its own terms, without a conversation.
 * @param endpoint - the `<namespace>/<method>` name the transport dispatched.
 * @returns whether the call changes the deployment rather than a conversation.
 */
function manages(endpoint: string): boolean {
  return MANAGEMENT_ENDPOINTS.has(endpoint)
}

/**
 * The endpoints whose conversation decides whether the call may run.
 * @param endpoint - the `<namespace>/<method>` name the transport dispatched.
 * @returns whether a conversation lease must admit the caller.
 */
function drivesConversation(endpoint: string): boolean {
  return CONTROL_ENDPOINTS.has(endpoint)
    || TERMINAL_ENDPOINTS.has(endpoint)
    || COMMAND_ENDPOINTS.has(endpoint)
}

/**
 * Build the deployment policy layered over the transport.
 * @param control - controller bindings shared with the identity service.
 * @param describeController - renders the current controller for a refusal message.
 * @param options - deployment-wide bounds the transport cannot know on its own.
 * @returns the policy the gateway asks for every call.
 */
export function sessionControlPolicy(
  control: SessionControl,
  describeController: (userId: string) => string,
  options: {
    readonly workspaceRoot?: string | undefined
    /**
     * Resolve one conversation's project directory, when the deployment shares
     * directories on purpose and wants its writes serialized.
     */
    readonly projectOf?: ((sessionId: string) => string | undefined) | undefined
    /**
     * Record one admitted turn, so a project can answer which conversation, which
     * member, and which turn produced a file. Called only for a prompt that this
     * policy has just admitted: a refused prompt starts nothing, so recording it
     * would put a turn in the ledger that never happened.
     */
    readonly recordPrompt?: ((sessionId: string, member: string) => void) | undefined
  } = {},
): RemoteCallPolicy {
  const workspaceRoot = options.workspaceRoot
  const projectOf = options.projectOf
  const recordPrompt = options.recordPrompt
  return {
    decide(context: RemoteCallContext) {
      // The directory picker confines what a browser may choose; this confines
      // what a request may ask for. Without it the fence covers the dialog and
      // not the entry, and a caller can name any directory on the host.
      if (context.endpoint === SESSION_CREATE_ENDPOINT && workspaceRoot !== undefined) {
        const requested = requestedCwdOf(context.args)
        // No directory named means the deployment's own default applies, which is
        // already inside the bound.
        if (requested === undefined) return undefined
        if (isWithin(workspaceRoot, requested)) return undefined
        return {
          code: 'session/workspace-not-allowed',
          message: `a workspace must be created under ${workspaceRoot}`,
          details: { requested },
        }
      }
      const subject = context.subject
      if (manages(context.endpoint)) {
        // Not a conversation decision: a deployment-wide write needs a resolved
        // caller, and nothing else about it is decidable here.
        if (subject !== undefined) return undefined
        return {
          code: 'identity/required',
          message: 'changing this deployment’s settings requires a signed-in member',
          details: { endpoint: context.endpoint },
        }
      }
      if (!drivesConversation(context.endpoint)) return undefined
      if (subject === undefined) {
        // No identity at all means the deployment has no resolver, which cannot
        // happen for a call that reached this policy — but refusing is the safe
        // reading rather than letting an unidentified caller drive a conversation.
        return {
          code: 'session/control-required',
          message: 'acting on a conversation requires a signed-in member',
          details: {},
        }
      }
      const sessionId = conversationOf(context.args)
      if (sessionId === undefined) {
        // The endpoint's own argument validation owns this failure; the policy has
        // nothing to decide without a conversation.
        return undefined
      }
      const decision = control.decide(sessionId, subject, projectOf?.(sessionId))
      if (decision.allowed) {
        if (context.endpoint === PROMPT_ENDPOINT) recordPrompt?.(sessionId, subject.userId)
        return undefined
      }
      if (decision.reason === 'project-busy') {
        // Neither caller did anything wrong: their conversations are separate and
        // both were admitted. What they share is a directory, and the project
        // serializes writes into it rather than splitting it — because a split
        // directory is exactly the collaboration this deployment exists for.
        return {
          code: 'project/busy',
          message: 'another conversation is writing this project right now',
          details: { sessionId, holderSessionId: decision.holderSessionId },
        }
      }
      // The refusal says who is driving it, because that is what the member needs
      // to act on; it does not publish the controller's internal id. It also
      // carries the clock, so the client can say "you may take this over now"
      // instead of making the member guess when to try again.
      const state = control.controlState(sessionId)
      return {
        code: 'session/not-controller',
        message: `this conversation is being driven by ${describeController(decision.controller.userId)}`,
        details: {
          sessionId,
          reason: decision.reason,
          idleMs: state.idleMs,
          requiredIdleMs: state.requiredIdleMs,
          mayTakeOver: state.mayTakeOver,
        },
      }
    },
  }
}

/**
 * Build the lookup that routes one Agent's interaction requests to its controller.
 *
 * A forwarded waterfall request — a tool approval, an Agent question — needs an
 * answer from the member driving that conversation. The event names its Agent and
 * nothing else, and an Agent's identity **is** its Session id, so the controller
 * binding answers directly. An unclaimed Agent resolves to no owner, which leaves
 * delivery as it always was rather than dropping the request.
 * @param control - controller bindings shared with the identity service.
 * @returns the resolver the Remote transport asks per interaction request.
 */
export function sessionEventOwner(control: SessionControl): RemoteEventOwnerResolver {
  return {
    ownerOf(agentId: string): ConnectionSubject | undefined {
      return control.controllerOf(agentId)
    },
  }
}

/**
 * Build the admission rule for answers to one Agent's interaction requests.
 *
 * Routing a request to the controller is only half the job: the request is then
 * carried by a connection, and holding it says nothing about who may settle it.
 * An answer is admitted by the same rule that routed the request — the caller is
 * the conversation's current controller, on the page that holds it — so a lease
 * that moved, or an account that was disabled while an approval was outstanding,
 * cannot settle it through a delivery it still happens to sit on.
 * @param control - controller bindings shared with the identity service.
 * @returns the policy the transport asks before it settles a forwarded request.
 */
export function sessionAnswerPolicy(control: SessionControl): RemoteEventAnswerPolicy {
  return {
    accepts(agentId: string, subject: ConnectionSubject | undefined): boolean {
      if (subject === undefined) return false
      const controller = control.controllerOf(agentId)
      if (controller === undefined) return false
      if (!sameController(controller, subject)) return false
      // An accepted answer is the holder acting, and this path never goes through
      // `decide()`. Without this the idle clock would keep running while the
      // member is demonstrably present, and somebody else could take the
      // conversation over in the middle of their answer.
      control.touch(agentId)
      return true
    },
  }
}

/**
 * The endpoints this policy governs, for tests and documentation.
 *
 * Three groups: the calls that drive a conversation, the calls that run commands
 * in its workspace or through its command channel, and the calls that change the
 * deployment. Everything else — every read — is left to the caller.
 * @returns the governed endpoint names.
 */
export function controlEndpoints(): readonly string[] {
  return [...CONTROL_ENDPOINTS, ...TERMINAL_ENDPOINTS, ...COMMAND_ENDPOINTS, ...MANAGEMENT_ENDPOINTS]
}

/**
 * The endpoints that need a resolved caller but no conversation lease, for
 * tests and documentation.
 * @returns the deployment-management endpoint names.
 */
export function managementEndpoints(): readonly string[] {
  return [...MANAGEMENT_ENDPOINTS]
}
