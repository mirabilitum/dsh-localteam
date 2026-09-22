/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { CLIENT_INSTANCE_HEADER } from './identity.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import type {
  ConnectionAuthentication,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  ConnectionIdentityResolver,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionSubject,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/**
 * Longest accepted page instance id. It is opaque correlation the browser mints,
 * so the bound only keeps a hostile header from becoming unbounded state.
 */
const MAX_CLIENT_INSTANCE_BYTES = 128

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()
  private readonly requestSubjects = new WeakMap<object, ConnectionSubject>()
  private identityResolver: ConnectionIdentityResolver | undefined

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
  ) {
    super(ctx, 'connection')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Apply the configured Host/Origin fence, then browser authentication. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    return this.authenticate(request).rejection
  }

  /**
   * Apply the trust fence and resolve the caller identity in one pass.
   *
   * Admission is decided before identity is read, so a deployment resolver can
   * never widen who reaches the transport; it only decides who an already
   * admitted request belongs to.
   */
  authenticate(request: ConnectionTrustRequest): ConnectionAuthentication {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return { rejection: 403, subject: undefined }
    if (!this.browserAuth.isAuthenticated(request)) return { rejection: 401, subject: undefined }
    return { rejection: undefined, subject: this.subjectWithInstance(request) }
  }

  /**
   * Resolve the caller and attach the page instance id the request declares.
   *
   * The member always comes from the resolver's own cookie read; the instance id
   * is correlation the transport carries for control-lease checks, never a claim
   * of identity. A request that omits or repeats the header still resolves its
   * member, it simply cannot be told apart from another tab of that member.
   */
  private subjectWithInstance(request: ConnectionTrustRequest): ConnectionSubject | undefined {
    const subject = this.identityResolver?.resolve(request.headers)
    if (subject === undefined || subject.clientInstanceId !== undefined) return subject
    const raw = request.headers instanceof Headers
      ? request.headers.get(CLIENT_INSTANCE_HEADER)
      : request.headers[CLIENT_INSTANCE_HEADER]
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CLIENT_INSTANCE_BYTES) return subject
    return { ...subject, clientInstanceId: raw }
  }

  /** Install the deployment's team-identity resolver for the calling fiber's lifetime. */
  setIdentityResolver(resolver: ConnectionIdentityResolver): () => Promise<void> {
    return this.ctx.effect(() => {
      this.identityResolver = resolver
      return () => {
        if (this.identityResolver === resolver) this.identityResolver = undefined
      }
    }, 'client-connection: team identity resolver')
  }

  /**
   * Read the subject resolved for one dispatched Fetch request.
   * @param request - the exact request object handed to `createSharedFetchHandler().fetch`.
   * @returns that request's subject, or undefined when it was not dispatched through this service.
   */
  subjectOf(request: Request): ConnectionSubject | undefined {
    return this.requestSubjects.get(request)
  }

  /** Authenticate an index request through the process-token exchange or cookie. */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    return this.browserAuth.authorizeIndex(request, response)
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   *
   * The returned dispatcher applies no trust fence and no browser
   * authentication: the owning Web route applies both before delegating here, as
   * it always has. It does resolve the caller identity once per request when a
   * deployment resolver is installed, so {@link ConnectionFetchHandler.subjectOf}
   * can hand it to the route and endpoint owners below.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      subjectOf: request => this.requestSubjects.get(request),
      fetch: (request, subject) => {
        this.recordSubjectFor(request, subject)
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) return route.fetch(request)
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request)
      },
    }
  }

  /**
   * Record the caller identity for one request that is already below the trust fence.
   *
   * The `/api` Web route authenticates first and then delegates here, so the
   * subject usually arrives resolved. A route reached without that step still
   * resolves from the request's own headers, so identity never depends on which
   * entry performed the fencing.
   * @param request - request object handed to the shared dispatcher.
   * @param resolved - identity the caller already resolved, when it did.
   * @returns the recorded subject, or undefined when the deployment has none.
   */
  private recordSubjectFor(
    request: Request,
    resolved?: ConnectionSubject,
  ): ConnectionSubject | undefined {
    const existing = resolved ?? this.requestSubjects.get(request)
    if (existing !== undefined) {
      this.requestSubjects.set(request, existing)
      return existing
    }
    const subject = this.identityResolver?.resolve(request.headers)
    if (subject !== undefined) this.requestSubjects.set(request, subject)
    return subject
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler, request => this.subjectOf(request))
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const rejection = this.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler)
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler, request => this.subjectOf(request)),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  subjectOf: (request: Request) => ConnectionSubject | undefined,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    subjectOf,
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal, subjectOf(request))
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: ConnectionRpcResult<unknown>): Response {
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
