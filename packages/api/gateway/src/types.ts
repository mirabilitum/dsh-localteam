/**
 * Carrier-independent Typert Gateway request, service, and error contracts.
 * @module @deepseek-ai/dsh-api-gateway/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionSubject } from '@deepseek-ai/dsh-client-connection'
import type { RemoteEventHostInfo } from './stream-protocol.ts'

/**
 * One decoded Remote call offered to the deployment's access policy.
 *
 * The policy sees what the transport knows and nothing else: the server-resolved
 * caller, the endpoint, and the decoded arguments. It is asked **before** the
 * business method runs, so a refusal is a refusal to act rather than an
 * after-the-fact correction.
 */
export interface RemoteCallContext {
  /** Server-resolved caller, or undefined when the deployment resolves no identity. */
  readonly subject: ConnectionSubject | undefined
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /** Decoded wire arguments exactly as the business method will receive them. */
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * Deployment-owned decision on whether one Remote call may proceed.
 *
 * Absent a policy every call proceeds, which is DSH's single-user baseline. A
 * policy is asked for every call and returns the failure to report, or undefined
 * to allow it — so a refusal reaches the caller with the vocabulary the transport
 * already uses for business failures.
 */
export interface RemoteCallPolicy {
  /**
   * Decide whether one call may proceed.
   * @param context - the resolved caller, endpoint, and decoded arguments.
   * @returns the failure to report, or undefined to allow the call.
   */
  decide(context: RemoteCallContext):
    | { readonly code: string; readonly message: string; readonly details: object }
    | undefined
}

/**
 * Deployment-owned lookup for who owns one Agent's interaction requests.
 *
 * A forwarded waterfall request — a tool approval, an Agent question — needs an
 * answer from exactly the member driving that conversation, and a bystander
 * answering for someone else is the failure this prevents. The event itself does
 * not name its owner, so the transport asks the deployment, which is the only
 * layer that knows who claimed the Agent.
 */
export interface RemoteEventOwnerResolver {
  /**
   * Resolve the member a forwarded interaction request belongs to.
   * @param agentId - Agent identity carried by the scoped event, which is its Session id.
   * @returns the owner, or undefined when nobody owns this Agent (broadcast as before).
   */
  ownerOf(agentId: string): ConnectionSubject | undefined
}

/**
 * Deployment-owned admission for answers to one Agent's interaction requests.
 *
 * Holding a delivery is a transport fact, not a permission: it says a connection
 * was offered the request, not that it may settle it now. A deployment that
 * decides who drives a conversation installs this so a lease that has moved —
 * or a page that is no longer the one holding it — cannot settle a request the
 * old holder is still sitting on.
 */
export interface RemoteEventAnswerPolicy {
  /**
   * Decide whether one caller may settle one forwarded request.
   * @param agentId - Agent the request belongs to, which is its Session id.
   * @param subject - the answering request's server-resolved caller, when it has one.
   * @returns whether this caller may answer now.
   */
  accepts(agentId: string, subject: ConnectionSubject | undefined): boolean
}

/** One Remote method request after a carrier has decoded its envelope. */
export interface InvokeRemoteRequest {
  /** Remote namespace selected by the generated descriptor. */
  readonly namespace: string
  /** Exported Service method name. */
  readonly method: string
  /** Named wire values; fields must exactly match the descriptor. */
  readonly args: Readonly<Record<string, unknown>>
  /** Carrier or direct-caller cancellation injected only into cancellation-aware methods. */
  readonly signal?: AbortSignal
  /**
   * Server-resolved caller identity for this invocation.
   *
   * Absent for in-process callers and for deployments without team identity,
   * which is the single-user baseline. A browser caller never supplies this: the
   * connection transport resolves it from the request's own cookies.
   */
  readonly subject?: ConnectionSubject
}

/** One Host Cordis notification forwarded unchanged to Client Remote subscribers. */
export interface TypertRemoteEventFrame {
  /** Original Host Cordis event name. */
  readonly event: string
  /** Original event argument list after the owner validates it for JSON transport. */
  readonly args: readonly unknown[]
}

/** Live Host values used to project one scoped Remote Event. */
export interface TypertRemoteEventContext {
  /** Live Agent Context that owns cancellation of the forwarded waterfall. */
  readonly value: Context
  /** Agent object carried directly by the waterfall request. */
  readonly subject: object
  /** Agent identity read directly from the scoped event subject. */
  readonly agentId: string
}

/** Result returned from a Client waterfall, or delegation back to the Host chain. */
export type TypertRemoteEventOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'next' }

/**
 * One scoped waterfall invocation yielded by the application event source.
 * The Gateway alone assigns transport ids and resolves the continuation after
 * a Client result or explicit delegation.
 */
export interface TypertRemoteEventInvocation {
  /** Original Host Cordis event name. */
  readonly event: string
  /** Sole request argument before the waterfall's `next()` callback. */
  readonly request: object
  readonly context: TypertRemoteEventContext
  /** Resume the source's Cordis listener with a Client result or `next()`. */
  readonly resolve: (outcome: TypertRemoteEventOutcome) => void
  /** Reject the source's Cordis listener after cancellation, transport failure, or Client rejection. */
  readonly reject: (reason: unknown) => void
}

/** Notification or scoped waterfall accepted from the sole Remote Event source. */
export type TypertRemoteEventDispatch = TypertRemoteEventFrame | TypertRemoteEventInvocation

/**
 * Open the application-selected event stream for one Client carrier. The
 * factory must attach all incremental Host listeners before it returns; the
 * Gateway publishes its readiness item immediately afterward.
 * @param signal - cancellation shared with the Client stream and registration.
 * @returns the long-lived stream of notifications and scoped waterfall invocations.
 */
export type TypertRemoteEventSource = (
  signal: AbortSignal,
) => AsyncIterable<TypertRemoteEventDispatch>

/** Carrier-facing access to decoded Remote streams and their stable failures. */
export interface TypertGatewayWireStream {
  /**
   * Open one logical stream from its wire endpoint and payload.
   * @param endpoint - canonical Remote endpoint or Gateway-owned stream name.
   * @param payload - decoded carrier payload.
   * @param signal - logical-stream cancellation.
   * @param subject - server-resolved caller identity carried by the physical carrier, when it has one.
   * @returns validated stream values.
   */
  readonly open: (
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    subject?: ConnectionSubject,
  ) => Promise<AsyncIterable<unknown>>

  /**
   * Convert a stream failure to the carrier-safe Remote failure fields.
   * @param error - failure raised while opening or consuming a stream.
   * @returns stable code, message, and details for the Client.
   */
  readonly failure: (error: unknown) => {
    readonly code: string
    readonly message: string
    readonly details: object
  }
}

/** Stable infrastructure and boundary failures emitted before or after business execution. */
export type TypertGatewayErrorCode =
  | 'gateway/ambiguous-endpoint'
  | 'gateway/arguments-invalid'
  | 'gateway/binding-invalid'
  | 'gateway/context-failed'
  | 'gateway/context-not-found'
  | 'gateway/context-unavailable'
  | 'gateway/definition-unavailable'
  | 'gateway/input-invalid'
  | 'gateway/invocation-unavailable'
  | 'gateway/lookup-failed'
  | 'gateway/lookup-not-found'
  | 'gateway/lookup-unavailable'
  | 'gateway/method-unavailable'
  | 'gateway/provider-mismatch'
  /** The deployment's access policy refused this call before it reached the method. */
  | 'gateway/refused'
  | 'gateway/result-invalid'
  | 'gateway/service-unavailable'
  | 'gateway/signature-invalid'

/** Host dispatcher consumed by Connection adapters. */
export interface TypertGateway {
  /** Carrier adapter shared by WebSocket and in-process transports. */
  readonly wireStream: TypertGatewayWireStream

  /**
   * Register the application-selected forwarded-event source.
   * @param source - stream factory installed by the Remote assembly.
   * @param host - stable Host facts included in each Client generation's opening frame.
   * @returns disposer removing this exact source and cancelling its active streams.
   */
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>

  /**
   * Invoke one live Remote method without assuming a carrier or response envelope.
   * @param request - decoded endpoint and named wire arguments.
   * @returns the business result without output decoding.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  invoke(request: InvokeRemoteRequest): Promise<unknown>

  /**
   * Open one live stream Remote method without assuming a physical carrier.
   * @param request - decoded endpoint and named wire arguments.
   * @returns a cancellation-aware iterable over the business results.
   */
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>

  /**
   * Terminate every Remote stream connection recorded for one team user.
   *
   * Revocation must reach established connections: a WebSocket generation the
   * browser already holds is not re-checked per stream, so disabling an account
   * has to close it from the server side.
   * @param userId - team user whose connections must end.
   * @returns how many sockets were closed.
   */
  closeSubjectStreams(userId: string): number

  /**
   * Install the deployment's access policy for Remote calls.
   *
   * The transport is where the caller identity exists, so it is where a decision
   * about that caller can be enforced before any business method runs. Absent a
   * policy every call proceeds.
   * @param policy - policy owned by the calling fiber.
   * @returns disposer removing this exact policy.
   */
  setCallPolicy(policy: RemoteCallPolicy): () => Promise<void>

  /**
   * Install the deployment's lookup for who owns one Agent's interaction requests.
   *
   * Absent a resolver no event has an owner, and interaction requests fan out as
   * they always have; a deployment that claims conversations installs one so an
   * approval or question reaches the member driving it and nobody else.
   * @param resolver - resolver owned by the calling fiber.
   * @returns disposer removing this exact resolver.
   */
  setEventOwnerResolver(resolver: RemoteEventOwnerResolver): () => Promise<void>

  /**
   * Install the deployment's admission rule for answers to interaction requests.
   *
   * Absent a policy any connection holding a delivery may settle it, which is the
   * single-user baseline. A deployment that decides who drives a conversation
   * installs one so an answer is admitted by the same rule that routed the
   * request, not merely by having been offered it.
   * @param policy - policy owned by the calling fiber.
   * @returns disposer removing this exact policy.
   */
  setEventAnswerPolicy(policy: RemoteEventAnswerPolicy): () => Promise<void>

  /**
   * Re-deliver every outstanding interaction request for one Agent.
   *
   * Control of a conversation can change while a tool approval or an Agent
   * question is still waiting. The old controller's answer must not settle it —
   * they may have been replaced precisely because they are no longer there — so
   * the request is withdrawn from every holder and re-delivered to whoever owns
   * the Agent now.
   * @param agentId - Agent whose outstanding interaction requests move.
   * @returns how many requests were re-delivered.
   */
  reDeliverRemoteEvents(agentId: string): number

  /**
   * Whether one Agent is still waiting on an answer it forwarded.
   *
   * A conversation can be waiting for a tool approval or an Agent question while
   * nobody types anything: the member is reading, or deciding, and has not
   * written a single request since. Presence cannot be inferred from requests
   * alone, so a deployment that hands control away on inactivity asks here before
   * it treats an unanswered conversation as an abandoned one.
   * @param agentId - Agent whose outstanding interaction requests to report.
   * @returns whether at least one forwarded request is still unanswered.
   */
  hasPendingRemoteEvents(agentId: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host dispatcher for Typert Remote calls. */
    typertGateway: TypertGateway
  }
}
