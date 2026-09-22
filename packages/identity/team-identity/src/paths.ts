/**
 * The Fetch paths the team-identity surface owns.
 *
 * They live apart from the handlers because both the HTTP route and the sign-in
 * page need them, and importing one from the other would form a cycle: the page
 * module would read a path constant before the route module finished evaluating,
 * and the generated client script would silently carry `undefined`.
 *
 * @module @deepseek-ai/dsh-team-identity/paths
 */

/** Exact Fetch path owning team sign-in status and sign-in itself. */
export const TEAM_IDENTITY_PATH = '/api/team.identity'

/**
 * Exact Fetch path exposing the sign-in document as JSON.
 *
 * The gate script needs the page as data rather than as embedded HTML — HTML
 * inside a script would have to be escaped, and that escaping would be the only
 * thing standing between the page and a broken document.
 */
export const TEAM_SIGN_IN_DOCUMENT_PATH = '/api/team.identity.page'

/**
 * Exact Fetch path for handing one conversation's control to another member.
 *
 * Control otherwise changes only when somebody takes it: a holder stays the
 * holder until another member has been idle long enough to claim the
 * conversation. That is the wrong way to say "I am done, you take over" — the
 * other person has to sit out the whole window first — and it gives the outgoing
 * controller nothing to do with the page they are leaving.
 */
export const TEAM_HANDOVER_PATH = '/api/team.identity.handover'

/**
 * Exact Fetch path that hands one file back to a member's own machine.
 *
 * Reading is open to every member (checklist §11: members watch each other's
 * work), and a member who can already see a file in the preview pane saving a copy
 * of it is the same permission. What this route adds is the trip to the viewer's
 * own disk, which no other DSH surface offers.
 */
export const TEAM_EXPORT_PATH = '/api/team.export'
