/**
 * `/api/team.identity` — the one plugin route reachable without a team identity,
 * and the only place a team cookie is minted.
 *
 * It is registered as an **exact** Fetch route rather than as an `/api`
 * interceptor endpoint: the shared dispatcher looks up exact routes before the
 * interceptor chain, so this route is exempt from the "must already have a team
 * identity" check by construction instead of by a branch that could be
 * mis-evaluated. The DSH browser cookie is still required, because the transport
 * fence runs in front of both paths — this route adds to admission, it never
 * replaces it.
 *
 * @module @deepseek-ai/dsh-team-identity/http-route
 */

import { basename } from 'node:path'
import { requestAuthority } from './cookie.ts'
import { TEAM_EXPORT_PATH, TEAM_HANDOVER_PATH, TEAM_SIGN_IN_DOCUMENT_PATH } from './paths.ts'
import type { ProvenanceScope } from './provenance.ts'
import { signInDocumentBody } from './sign-in-page.ts'
import { TEAM_EXPORT_LIMITS } from './service.ts'
import type { TeamExportFailure, TeamIdentity } from './service.ts'

export { TEAM_EXPORT_PATH, TEAM_IDENTITY_PATH, TEAM_HANDOVER_PATH, TEAM_SIGN_IN_DOCUMENT_PATH } from './paths.ts'

/** Maximum sign-in body accepted; a name and a code never approach this. */
const MAX_SIGN_IN_BYTES = 8 * 1024

interface SignInBody {
  readonly name: string
  readonly code: string
}

/** Body of one control-handover request. */
interface HandOverBody {
  readonly sessionId: string
  readonly to?: string
  /**
   * Take the conversation over from a holder who has been idle long enough.
   *
   * A form of the same gesture rather than a separate route: both answer "who
   * speaks for this conversation now", and one member's release is another's
   * takeover.
   */
  readonly take?: boolean
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * The status one refused export reports.
 *
 * The `reason` in the body is the answer the member sees; the status is what a
 * proxy or a log sees, so it has to be true on its own. "Nothing produced" and
 * "no such conversation" are both 404; a boundary the caller may not cross is
 * 403, size is 413, a file that changed under the reader is a conflict they can
 * retry (409), and a read the Host could not complete is 500 — the one status
 * that tells an operator to look instead of a member to act.
 * @param reason - the refusal the service reported.
 * @returns the HTTP status for it.
 */
function refusalStatus(reason: TeamExportFailure): number {
  switch (reason) {
    case 'work-escapes-project':
    case 'outside-work':
      return 403
    case 'too-large':
      return 413
    case 'changed-during-read':
      return 409
    case 'unreadable':
      return 500
    case 'unknown-session':
    case 'nothing-produced':
      return 404
  }
}

/**
 * Read the fields of one export POST.
 *
 * A form body rather than JSON, because the selection is a repeated field and
 * this is the shape a browser submits without a URL-length ceiling. An
 * unreadable body is `undefined`, which the caller answers as a bad request:
 * "we could not read what you sent" must never be read as "you sent nothing",
 * or a failed request would quietly hand over the whole project.
 * @param request - the exact request, already past the transport fence.
 * @returns the parsed form, or undefined when it cannot be read as one.
 */
async function readExportBody(request: Request): Promise<FormData | undefined> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/x-www-form-urlencoded' && mediaType !== 'multipart/form-data') return undefined
  try {
    return await request.formData()
  } catch {
    return undefined
  }
}

/**
 * Name one downloaded file for the browser.
 *
 * A Chinese file name cannot go in `filename=` — an HTTP header is bytes, and the
 * ASCII fallback would be a row of underscores. RFC 5987's `filename*` carries the
 * real name percent-encoded, and the plain form stays for anything that ignores it.
 * @param name - the file's own name.
 * @returns the `content-disposition` value.
 */
function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Serve one team-identity request.
 * @param identity - the owning service.
 * @param request - the exact request, already past the transport fence.
 * @returns the status, sign-in, or sign-in-document response.
 */
export async function handleTeamIdentityHttp(
  identity: TeamIdentity,
  request: Request,
): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (pathname === TEAM_SIGN_IN_DOCUMENT_PATH) {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405)
    // `invalid` is the honest reason: this is fetched only when the browser has
    // no usable team cookie, which includes one that has just expired.
    return json(signInDocumentBody('invalid'))
  }
  if (pathname === TEAM_HANDOVER_PATH) {
    const actor = identity.sessionOf(request.headers)
    // Reading who drives a conversation is a read, open to every member: it is
    // what lets a bystander tell "the holder is working" from "the holder left",
    // and decide whether taking it over is possible yet.
    if (request.method === 'GET') {
      if (actor === undefined) return json({ error: 'identity-required' }, 401)
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (sessionId === null || sessionId === '') return json({ error: 'invalid-query' }, 400)
      const state = identity.controlOf(sessionId)
      return json({
        sessionId,
        driven: state.controller !== undefined,
        ...state.controller === undefined ? {} : { controller: state.controller.userId },
        idleMs: state.idleMs,
        requiredIdleMs: state.requiredIdleMs,
        pending: state.pending,
        mayTakeOver: state.mayTakeOver,
      })
    }
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    // The caller is whoever their cookie says, resolved here rather than read
    // from the body: a member does not get to name themselves.
    if (actor === undefined) return json({ error: 'identity-required' }, 401)
    const body = await readHandOverBody(request)
    if (body === undefined) return json({ error: 'invalid-body' }, 400)
    if (body.take === true) {
      // The idle window is re-read here rather than trusted from the GET above:
      // the holder may have acted again in between, and a takeover that was
      // possible a second ago is not owed to anybody.
      const taken = identity.takeOver(body.sessionId, actor)
      if (taken.ok) return json({ takenOver: true, controller: taken.controller.userId })
      return json({ ...taken, error: 'take-over-refused' }, 409)
    }
    const result = identity.handOver(body.sessionId, actor, body.to)
    if (result.ok) {
      return json(result.controller === undefined
        ? { handedOver: true, released: true }
        : { handedOver: true, controller: result.controller })
    }
    const status = result.reason === 'no-such-member' ? 400 : 409
    return json({ ...result, error: 'hand-over-refused' }, status)
  }
  if (pathname === TEAM_EXPORT_PATH) {
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    // Reading is what every member may do; the transport fence has already run, so
    // reaching here without a team identity means only "not signed in".
    if (identity.sessionOf(request.headers) === undefined) return json({ error: 'identity-required' }, 401)
    const query = new URL(request.url).searchParams
    // A selection of paths arrives as a form body, because a project with
    // hundreds of files cannot name them all in a query string. It is read
    // strictly: a POST whose body cannot be read is a bad request, never a
    // silent "everything".
    const body = request.method === 'POST' ? await readExportBody(request) : undefined
    if (request.method === 'POST' && body === undefined) return json({ error: 'invalid-body' }, 400)
    const field = (name: string): string | null => query.get(name) ?? body?.get(name)?.toString() ?? null
    const sessionId = field('sessionId')
    if (sessionId === null || sessionId === '') return json({ error: 'invalid-query' }, 400)
    const form = field('form') ?? 'file'
    // "Only the newest turn of each conversation" — the whole history is the
    // default, because a download that silently dropped earlier turns would be
    // the more surprising of the two.
    const scope: ProvenanceScope = field('scope') === 'latest' ? 'latest' : 'all'
    if (form === 'manifest') {
      const manifest = await identity.manifest(sessionId, scope)
      if (!manifest.ok) {
        return json({ error: 'export-refused', reason: manifest.reason }, refusalStatus(manifest.reason))
      }
      // The project's name, not its path: a member needs to know which project
      // they are looking at, and the host's directory layout is not theirs.
      // `empty` is what lets the client say "nothing yet" without asking for a
      // second request it would only have to refuse, and `limits` keeps the
      // byte budgets a Host decision rather than a client build.
      return json({
        sessionId,
        project: basename(manifest.project),
        scope,
        products: manifest.products,
        empty: manifest.products.length === 0,
        limits: TEAM_EXPORT_LIMITS,
        // Where this directory sits and whether its layout is intact: the two
        // questions the client needs to tell "nothing yet" apart from "this
        // conversation is not in a project at all".
        ...manifest.layout === undefined ? {} : { layout: manifest.layout },
      })
    }
    if (form === 'zip') {
      const selected = body === undefined ? undefined : body.getAll('path').map(value => String(value))
      const archive = await identity.exportArchive(sessionId, scope, selected)
      if (!archive.ok) {
        // `missing` names what could not be handed over; the status says which
        // kind of refusal it was.
        return json({
          error: 'export-refused',
          reason: archive.reason,
          ...archive.missing === undefined ? {} : { missing: archive.missing },
        }, refusalStatus(archive.reason))
      }
      return new Response(new Uint8Array(archive.bytes), {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/zip',
          'content-length': String(archive.bytes.byteLength),
          'content-disposition': attachmentHeader(archive.name),
          // What the package actually holds: the client shows these rather than
          // repeating a manifest it read before the files were read.
          'x-team-export-files': String(archive.products),
          'x-team-export-bytes': String(archive.bytes.byteLength),
        },
      })
    }
    if (form !== 'file') return json({ error: 'invalid-query', reason: 'unknown-form' }, 400)
    const relative = field('path')
    if (relative === null || relative === '') return json({ error: 'invalid-query' }, 400)
    const file = await identity.exportFile(sessionId, relative)
    if (!file.ok) {
      return json({ error: 'export-refused', reason: file.reason }, refusalStatus(file.reason))
    }
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/octet-stream',
        'content-length': String(file.bytes.byteLength),
        'content-disposition': attachmentHeader(file.name),
      },
    })
  }
  if (request.method === 'GET') {
    const session = identity.sessionOf(request.headers)
    if (session === undefined) return json({ signedIn: false })
    return json({
      signedIn: true,
      userId: session.userId,
      // The roster, because a member-facing control has to name the member it
      // hands a conversation to. Names and ids only: a sign-in code is the
      // member's own secret and never leaves the Host.
      members: identity.listMembers().map(member => ({ userId: member.userId, name: member.name })),
    })
  }
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)

  const authority = requestAuthority(request.headers)
  if (authority === undefined) return json({ error: 'missing-authority' }, 400)

  const body = await readSignInBody(request)
  if (body === undefined) return json({ error: 'invalid-body' }, 400)

  const result = identity.signIn(body.name, body.code, authority)
  if (!result.ok) {
    // One undifferentiated status: which half was wrong is not the caller's to learn.
    return json({ error: 'sign-in-failed', reason: result.reason }, 401)
  }
  return new Response(JSON.stringify({ signedIn: true, userId: result.session.userId }), {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': identity.cookieHeader(result.session, authority),
    },
  })
}

async function readSignInBody(request: Request): Promise<SignInBody | undefined> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') return undefined
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_SIGN_IN_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Partial<SignInBody>
  if (typeof record.name !== 'string' || typeof record.code !== 'string') return undefined
  if (record.name.length === 0 || record.code.length === 0) return undefined
  return { name: record.name, code: record.code }
}

async function readHandOverBody(request: Request): Promise<HandOverBody | undefined> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') return undefined
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_SIGN_IN_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Partial<HandOverBody>
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return undefined
  // Absent `to` means "release it", which is a decision, not a malformed body.
  if (record.to !== undefined && (typeof record.to !== 'string' || record.to.length === 0)) return undefined
  if (record.take !== undefined && typeof record.take !== 'boolean') return undefined
  return {
    sessionId: record.sessionId,
    ...record.to === undefined ? {} : { to: record.to },
    ...record.take === undefined ? {} : { take: record.take },
  }
}
