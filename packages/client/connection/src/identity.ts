/**
 * The resolved caller identity carried by every authenticated Host transport.
 *
 * A subject is always **server-derived**: the resolver reads it from the
 * request's own cookies. A client never supplies its own identity, and no field
 * here is ever read back from a request payload — the same discipline the
 * report-side contract states for `actor_type` ("由服务端按调用路径判定").
 *
 * Team identity is optional by construction: when no {@link ConnectionIdentityResolver}
 * is installed the deployment keeps DSH's single-user behaviour and no subject
 * exists. The transport fence ({@link HostConnectionHandle.requestRejection})
 * never changes meaning either way.
 *
 * @module @deepseek-ai/dsh-client-connection/identity
 */

/** Which server-classified caller class produced one operation. */
export type ConnectionActorType =
  /** A Remote entry reached from the browser. */
  | 'user'
  /** The model tool pipeline after a message was accepted. */
  | 'agent'
  /** The project task runner. */
  | 'runner'

/**
 * One server-resolved caller identity.
 *
 * The three correlation fields exist for the control-lease checks the
 * multi-tenant contract requires (control lease + client instance + delivery
 * id): the lease and delivery id live with the conversation owner, while
 * {@link ConnectionSubject.clientInstanceId} is what distinguishes one tab or
 * device of the same user from another.
 */
export interface ConnectionSubject {
  /** Stable team user id the server resolved from the team cookie. */
  readonly userId: string
  /** Server-side revocation key for this exact token. */
  readonly tokenId: string
  /** Caller-declared per-page instance id; never used for identity or authorization. */
  readonly clientInstanceId?: string
  /** Caller class assigned by the server path that resolved this subject. */
  readonly actorType: ConnectionActorType
}

/**
 * Deployment-owned resolver that reads team identity from request cookies.
 *
 * Installed by the team-identity plugin through
 * {@link HostConnectionHandle.setIdentityResolver}; every method is synchronous
 * because the transport resolves one subject per request on the hot path.
 */
export interface ConnectionIdentityResolver {
  /**
   * Resolve the caller identity for one request.
   * @param headers - the request's own headers, carrying the team cookie.
   * @returns the resolved subject, or undefined when no valid team identity exists.
   */
  resolve(headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>): ConnectionSubject | undefined
}

/**
 * Header carrying the browser page's own instance id.
 *
 * It is correlation, not identity: the transport reads it and attaches it to the
 * subject so the conversation-control checks can tell two tabs of the same member
 * apart, but nothing is authorized by it. A client that omits it, or lies about
 * it, only loses its own ability to be distinguished — it can never claim to be
 * someone else, because the member always comes from the signed cookie.
 */
export const CLIENT_INSTANCE_HEADER = 'x-dsh-client-instance'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One team user's credentials were revoked.
     *
     * The transport listens for this instead of reaching into the identity
     * plugin, so the two stay independent: whoever owns revocation emits it, and
     * whoever owns a connection ends that user's connections. It exists because
     * revocation has to reach connections that are already established — a
     * WebSocket generation a browser holds is not re-checked per stream.
     * @param userId - user whose credentials are no longer valid.
     * @mode emit
     */
    'identity/revoked'(userId: string): void
  }
}
