/**
 * Team identity for a shared DSH deployment: who may sign in, which issued
 * tokens are still live, and the signed cookie that carries one of them.
 *
 * This plugin is the second half of the two-cookie design. The DSH browser
 * cookie answers "did this request come from a legitimately opened page" and is
 * owned by the transport; this plugin answers "which member is calling" and
 * installs itself as the transport's identity resolver. Neither cookie can do
 * the other's job, and the transport's admission fence is unchanged by either.
 *
 * Member codes live in configuration rather than in the registry file so the
 * operator can rotate them without touching issued sessions, and so a member's
 * enrolment can never be edited through the HTTP surface.
 *
 * @module @deepseek-ai/dsh-team-identity
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
// Activates the `directory-picker/created` event the project layout listens to.
import type {} from '@deepseek-ai/dsh-host-directory-picker-browse'
// Activates the webServer Context merge used by the index gate below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { sessionAnswerPolicy, sessionControlPolicy, sessionEventOwner } from './call-policy.ts'
import {
  handleTeamIdentityHttp, TEAM_EXPORT_PATH, TEAM_HANDOVER_PATH, TEAM_IDENTITY_PATH, TEAM_SIGN_IN_DOCUMENT_PATH,
} from './http-route.ts'
import { ensureProjectLayout } from './project-layout.ts'
import { signInGateScript } from './sign-in-page.ts'
import type { TeamMember } from './registry.ts'
import { sessionTempContributor } from './session-temp.ts'
import { TeamIdentity } from './service.ts'
import { canonicalize, isWithin } from './workspace-root.ts'

export { controlEndpoints, managementEndpoints, sessionAnswerPolicy, sessionControlPolicy, sessionEventOwner } from './call-policy.ts'
export { PROVENANCE_FILE_NAME, ProvenanceLedger } from './provenance.ts'
export type { ProvenanceProduct, ProvenanceScope, ProvenanceTurn, WorkScan, WorkScanFailure } from './provenance.ts'
// The project layout is exported because the operator scripts are the third
// writer of it: they run outside this process, so the library — not a copy of
// its rules text — is what they call.
export {
  ensureProjectLayout, inspectProjectLayout, PROJECT_DIRECTORIES, PROJECT_RULES, PROJECT_RULES_FILE_NAME,
} from './project-layout.ts'
export type {
  ProjectEntryProblem, ProjectLayoutConflict, ProjectLayoutFailure, ProjectLayoutInspection,
  ProjectLayoutResult, ProjectLayoutState, ProjectLocation,
} from './project-layout.ts'
export {
  IDLE_BEFORE_TAKEOVER_MS, PROJECT_WRITE_TTL_MS,
} from './session-control.ts'
export type { ControlState, TakeOverOutcome } from './session-control.ts'
export { SESSION_TEMP_CONTRIBUTOR, SESSION_TEMP_KEY, sessionTempContributor, sessionTempPath } from './session-temp.ts'
export { SessionControl } from './session-control.ts'
export type { SessionControlDecision } from './session-control.ts'

export { TEAM_HANDOVER_PATH, TEAM_IDENTITY_PATH, TEAM_SIGN_IN_DOCUMENT_PATH } from './http-route.ts'
export type { TeamArchiveOutcome, TeamExportOutcome, TeamHandOverOutcome, TeamManifestOutcome } from './service.ts'
export { TEAM_IDENTITY_FILE_NAME } from './registry.ts'
export { TEAM_SIGN_IN_PAGE_PATH, signInPage } from './sign-in-page.ts'
export type { SignInReason } from './sign-in-page.ts'
export type { TeamMember, TeamSession } from './registry.ts'
export { TeamIdentity } from './service.ts'
export type { TeamSignInOutcome } from './service.ts'

/** Stable Cordis plugin name. */
export const name = 'team-identity'

/** Services required before team identity can resolve callers. */
export const inject = ['connection']

/**
 * How long a conversation's holder may be idle before another member may take it
 * over, in minutes.
 *
 * Long enough that a member reading a long run is not displaced mid-thought;
 * short enough that a member who closed the page does not hold a conversation
 * for the rest of the day.
 */
const DEFAULT_TAKEOVER_IDLE_MINUTES = 15

/** One member as declared by the operator. */
export interface TeamMemberConfig {
  /** Stable id recorded on every action this member performs. */
  readonly userId?: string | null
  /** Display name the member signs in with. */
  readonly name?: string | null
  /** Code only this member should know. */
  readonly signInCode?: string | null
  /** Shared code that admits any member who is not given a personal one. */
  readonly alternateSignInCode?: string | null
}

/** Team identity configuration. */
export interface Config {
  /** Members admitted to this deployment. An empty list admits nobody. */
  readonly members?: TeamMemberConfig[] | null
  /** Lifetime of one issued token in days. @default 30 */
  readonly tokenTtlDays?: number | null
  /** Maximum live tokens kept before the oldest expire. @default 200 */
  readonly tokenLimit?: number | null
  /** Harness home holding the registry; defaults to the resolved `$DSH_HOME`. */
  readonly homePath?: string | null
  /**
   * How long a conversation's holder may be idle before another member may take
   * it over, in minutes.
   *
   * Deliberately **not** an expiry: nothing moves control on its own. A member
   * away for longer than this is displaced only when somebody decides to take
   * the conversation, which is what makes the change visible rather than silent.
   * @default 15
   */
  readonly takeoverIdleMinutes?: number | null
  /**
   * Whether two conversations may write one project directory at the same time.
   *
   * Off by default: a deployment whose Sessions all share one directory would be
   * serialized as one project, which is almost certainly not what it meant. Turn
   * it on together with the project layout — a shared `input\`/`build\`/`work\`
   * per project and a private `temp\` per Session — where the only remaining
   * collision is two conversations writing the same deliverable.
   * @default false
   */
  readonly serializeProjectWrites?: boolean | null
  /**
   * Directory a Session's workspace must be created under.
   *
   * Omitted leaves workspace choice to the caller, which is right for a
   * loopback-only deployment serving the person at the console. A deployment that
   * serves browsers it does not control sets this, because the directory picker
   * bounds only what a browser may *choose*: a creation request names its own
   * `cwd`, and without this it could name anything on the host.
   */
  readonly workspaceRoot?: string | null
  /**
   * Whether every Session gets its own `DSH_SESSION_TEMP`.
   *
   * On, each model shell call receives the absolute path of
   * `<session workspace>\sessions\<session id>\temp`, created on first use, so a
   * Session can write scratch without inventing a directory — and without
   * putting it in the shared `work\`. Off by default: a deployment that does not
   * use the project layout would be handing out a directory nobody reads.
   * @default false
   */
  readonly sessionTempDirectory?: boolean | null
  /**
   * Whether creating a directory through the browser's picker also creates the
   * project layout inside it.
   *
   * Off by default: it writes to disk, and a deployment that has not decided
   * where its projects live should not have directories appear in them. The
   * layout is what makes `work\` meaningful and what carries the rules into the
   * model's context, so a team deployment turns this on together with
   * {@link Config.projectsRoot}.
   * @default false
   */
  readonly projectScaffold?: boolean | null
  /**
   * The container whose direct children are projects.
   *
   * A directory created here gets the layout; one created deeper does not,
   * because a project inside a project is a mistake rather than a feature.
   * Defaults to {@link Config.workspaceRoot}, which is where a deployment's
   * sessions already live; it must stay inside that root, and an invalid value
   * is reported at startup rather than silently ignored.
   */
  readonly projectsRoot?: string | null
}

/** Validate team identity configuration. */
export const Config: Schema<Config> = Schema.object({
  members: Schema.array(Schema.object({
    userId: Schema.string().required(),
    name: Schema.string().required(),
    signInCode: Schema.string(),
    alternateSignInCode: Schema.string(),
  })).default([]),
  tokenTtlDays: Schema.natural().min(1).default(30),
  tokenLimit: Schema.natural().min(1).default(200),
  takeoverIdleMinutes: Schema.natural().min(1).default(DEFAULT_TAKEOVER_IDLE_MINUTES),
  serializeProjectWrites: Schema.boolean().default(false),
  workspaceRoot: Schema.string(),
  sessionTempDirectory: Schema.boolean().default(false),
  projectScaffold: Schema.boolean().default(false),
  projectsRoot: Schema.string(),
})

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000

/**
 * Publish team identity as the Connection identity resolver and mount sign-in.
 *
 * Fails closed: with no declared members nobody can sign in, and the operator
 * sees that at startup rather than discovering it from a silent fallback to
 * anonymous access.
 * @param ctx - Host context carrying the Connection transport.
 * @param config - resolved membership and token policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Schema defaults make these present, but a hand-built test tree may omit any
  // of them, so each entry is validated rather than assumed.
  const declared = config.members ?? []
  const members: TeamMember[] = []
  for (const member of declared) {
    if (typeof member.userId !== 'string' || member.userId === ''
      || typeof member.name !== 'string' || member.name === '') {
      throw new Error('team-identity: every member needs a non-empty userId and name')
    }
    members.push({
      userId: member.userId,
      name: member.name,
      ...typeof member.signInCode !== 'string' || member.signInCode === ''
        ? {}
        : { signInCode: member.signInCode },
      ...typeof member.alternateSignInCode !== 'string' || member.alternateSignInCode === ''
        ? {}
        : { alternateSignInCode: member.alternateSignInCode },
    })
  }
  if (members.length === 0) {
    // Observable at boot, and safe: an empty roster admits nobody rather than everybody.
    console.warn(`team-identity: no members are configured, so nobody can sign in on ${hostname()}`)
  }
  // The project layout is registered here rather than under Connection: creating
  // a directory carries no transport, so a profile with a picker but no browser
  // carrier can still scaffold. Opt-in, because it writes.
  if (config.projectScaffold === true) {
    const projectsRoot = resolveProjectsRoot(config)
    if (projectsRoot === undefined) {
      console.warn('team-identity: projectScaffold is on but projectsRoot is unusable, so no project layout will be created')
    } else {
      ctx.effect(() => ctx.on('directory-picker/created', (target) => {
        // Only a direct child of the container is a project: a directory made
        // inside an existing project is just a directory, and scaffolding it
        // would nest one project inside another.
        if (dirname(canonicalize(target)) !== projectsRoot) return
        const result = ensureProjectLayout(target)
        if (result.state === 'refused' || result.state === 'partial') {
          const detail = result.failed.map(entry => `${entry.path} (${entry.reason})`).join(', ')
          ctx.logger.warn(`team-identity: project layout for ${target} ended as ${result.state}: ${detail}`)
        }
      }), 'team-identity: project layout')
    }
  }
  // Everything below needs the transport, so it runs once Connection exists. The
  // resolvers are registered outside the web effect so identity still resolves on
  // a headless profile that has no browser carrier at all.
  ctx.inject(['connection'], (connectionCtx) => {
    const identity = new TeamIdentity(
      connectionCtx,
      members,
      (config.tokenTtlDays ?? 30) * DAY_MILLISECONDS,
      config.tokenLimit ?? 200,
      config.homePath ?? undefined,
      undefined,
      (config.takeoverIdleMinutes ?? DEFAULT_TAKEOVER_IDLE_MINUTES) * 60_000,
      config.workspaceRoot ?? undefined,
      config.projectsRoot ?? config.workspaceRoot ?? undefined,
    )
    connectionCtx.effect(
      () => connectionCtx.connection.setIdentityResolver(identity),
      'team-identity: connection identity resolver',
    )
    // There is deliberately no expiry timer any more. Control used to lapse on a
    // clock, which quietly reassigned a conversation from a member who was still
    // reading it; now the idle window is only a permission, and a conversation
    // changes hands when somebody takes it over or its holder hands it on.
    // The project layout gives every Session a private scratch directory, and a
    // rule the Session cannot name a path for is not much of a rule: this is what
    // turns `sessions\<会话>\temp\` into `DSH_SESSION_TEMP`. Registered only when
    // the deployment asks for the layout, and only when the shell tools exist —
    // a profile without them has no shell environment to contribute to.
    if (config.sessionTempDirectory === true) {
      connectionCtx.inject(['shellEnv'], (shellCtx) => {
        shellCtx.effect(
          () => shellCtx.shellEnv.register(sessionTempContributor()),
          'team-identity: per-Session scratch directory',
        )
      })
    }
    connectionCtx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        // Both paths must be exact Fetch routes: the shared dispatcher resolves
        // those before the `/api` interceptor chain, which is what exempts sign-in
        // from the "must already be signed in" check. Registration order is
        // irrelevant — the dispatcher looks paths up in a map.
        //
        // The registry is reached through the Connection context this fiber was
        // already given, not through `webCtx.connection`: the two are the same
        // service, and the outer reference is the one already proven present.
        const disposeStatus = connectionCtx.connection.fetch.register({
          path: TEAM_IDENTITY_PATH,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: request => handleTeamIdentityHttp(identity, request),
        })
        const disposeDocument = connectionCtx.connection.fetch.register({
          path: TEAM_SIGN_IN_DOCUMENT_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: request => handleTeamIdentityHttp(identity, request),
        })
        // Moving control is a decision the member driving the conversation makes,
        // not something a business method should have to know about: it is a route
        // here, beside sign-in, with the caller resolved from their own cookie.
        // `GET` reads who drives it and whether it can be taken over; `POST`
        // hands it on, releases it, or takes it over.
        const disposeHandOver = connectionCtx.connection.fetch.register({
          path: TEAM_HANDOVER_PATH,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: request => handleTeamIdentityHttp(identity, request),
        })
        // Handing a produced file to the member's own machine. Every member may
        // read, which is what this is; only `work\` is reachable. A selection of
        // paths arrives as a form body, so the route takes POST as well: a
        // project with hundreds of files cannot name them in a query string.
        const disposeExport = connectionCtx.connection.fetch.register({
          path: TEAM_EXPORT_PATH,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: request => handleTeamIdentityHttp(identity, request),
        })
        // A signed-out browser is handed the sign-in page instead of the shell.
        // This runs on the index body only, so static assets are untouched.
        const disposeGate = webCtx.webServer.tapIndex(html => injectSignInGate(html))
        return async () => {
          disposeGate()
          await disposeExport()
          await disposeHandOver()
          await disposeDocument()
          await disposeStatus()
        }
      }, 'team-identity: sign-in, hand-over and export routes, and the index gate')
    })
    // The Remote transport is the only layer that knows both the caller and the
    // endpoint before a method runs, so the write-restriction decision is enforced
    // there. Gateway is read optionally because a profile may carry no Remote
    // surface at all, in which case there is nothing to restrict. This is a
    // sibling injection, not a nested one: nesting it under the web carrier would
    // silently skip the policy on a profile that has a gateway but no browser.
    connectionCtx.inject(['typertGateway'], (gatewayCtx) => {
      gatewayCtx.effect(() => {
        const disposePolicy = gatewayCtx.typertGateway.setCallPolicy(
          sessionControlPolicy(identity.control, userId => userId, {
            workspaceRoot: config.workspaceRoot ?? undefined,
            // A project directory is shared so members can see each other's work,
            // which is exactly why two conversations writing it is a collision.
            // The deployment asks for serialized writes, and this is what tells
            // the binding which conversations share a directory: the session's own
            // workspace, read from the Session rather than from the request.
            ...config.serializeProjectWrites === true
              ? { projectOf: (sessionId: string) => workspaceOf(connectionCtx, sessionId) }
              : {},
            // Every admitted prompt is one line in its project's ledger, which is
            // what lets a download answer which turn produced a file. Recording
            // happens here rather than in the business method because this is the
            // layer that knows the caller and the conversation together.
            recordPrompt: (sessionId: string, member: string) => {
              identity.recordPrompt(sessionId, member)
            },
          }),
        )
        // The same bindings answer a second question: whose approval or question
        // is this? Interaction requests must reach the member driving the
        // conversation, and a bystander answering for someone else is the failure
        // this prevents.
        const disposeOwners = gatewayCtx.typertGateway.setEventOwnerResolver(
          sessionEventOwner(identity.control),
        )
        // Routing the request is only half of it: the answer has to be admitted by
        // the same rule, or a member who lost the conversation could still settle
        // it through a delivery they are still sitting on.
        const disposeAnswers = gatewayCtx.typertGateway.setEventAnswerPolicy(
          sessionAnswerPolicy(identity.control),
        )
        // Inactivity is not absence: a member reading a long run or deciding what
        // to answer writes nothing, and an Agent blocked on their approval is
        // waiting for exactly them. Control therefore does not lapse while the
        // conversation still has an unanswered request.
        identity.control.watchBusy(sessionId => gatewayCtx.typertGateway.hasPendingRemoteEvents(sessionId))
        // The token table outlives configuration changes, so a member removed
        // while the deployment was running still holds an unexpired token and the
        // connection they already opened. Reads refuse them from now on; this is
        // what reaches the connection that will not read again. It runs here, not
        // at apply time, because the transport has to be mounted for its
        // `identity/revoked` listener to exist before the event is emitted.
        identity.reconcile()
        // Control moving is what makes a request's holder wrong, so the transport
        // withdraws the conversation's outstanding requests from the old
        // controller and offers them to the new one. Listening here rather than
        // inside the binding keeps the lease free of transport knowledge.
        const disposeMoves = gatewayCtx.on('identity/control-moved', (sessionId: string) => {
          gatewayCtx.typertGateway.reDeliverRemoteEvents(sessionId)
        })
        return async () => {
          disposeMoves()
          await disposeAnswers()
          await disposeOwners()
          await disposePolicy()
        }
      }, 'team-identity: session control policy, event owners, and re-delivery')
    })
  })
}

/**
 * Read one live Session's workspace directory.
 *
 * The project a write would touch is the Session's own workspace, so it is read
 * from the Session rather than from the request — a caller never gets to name the
 * directory it is being judged against. Resolved lazily: the Session store may
 * mount after this plugin does.
 * @param ctx - the Connection context this plugin was given.
 * @param sessionId - conversation whose workspace to read.
 * @returns the workspace directory, or undefined when the Session has none.
 */
function workspaceOf(ctx: Context, sessionId: string): string | undefined {
  const sessions = ctx.get('sessions') as
    | { get(id: string): { readonly header?: { readonly cwd?: string } } | undefined }
    | undefined
  const cwd = sessions?.get(sessionId)?.header?.cwd
  return cwd === undefined || cwd === '' ? undefined : cwd
}

/**
 * Resolve the container whose direct children are projects.
 *
 * Canonicalized once, because the check the listener makes is "is this the
 * container itself", and a purely lexical comparison is escaped by a junction
 * in any ancestor. A root outside the workspace is reported and disables the
 * feature: a deployment that misconfigured it should learn that at startup,
 * rather than from directories that quietly never got a layout.
 * @param config - resolved plugin configuration.
 * @returns the canonical projects container, or undefined when it is unusable.
 */
function resolveProjectsRoot(config: Config): string | undefined {
  const workspaceRoot = config.workspaceRoot
  const configured = config.projectsRoot ?? workspaceRoot
  if (configured === undefined || configured === null || configured === '') return undefined
  const root = canonicalize(configured)
  if (workspaceRoot !== undefined && workspaceRoot !== null && workspaceRoot !== ''
    && !isWithin(workspaceRoot, root)) {
    console.warn(`team-identity: projectsRoot "${configured}" is outside workspaceRoot "${workspaceRoot}", so it is ignored`)
    return undefined
  }
  return root
}

/**
 * Inject the gate into one index document.
 *
 * Placement is the point: the script lands in `<head>`, so it runs before the
 * shell's own scripts and can replace the document rather than covering a mounted
 * application. A document without a `<head>` is returned untouched — a transform
 * that cannot place its script must not corrupt the page.
 * @param html - the rendered index body.
 * @returns the body with the gate script inserted.
 */
function injectSignInGate(html: string): string {
  return html.replace(/<head(?:\s[^>]*)?>/i, open => `${open}${signInGateScript()}`)
}
