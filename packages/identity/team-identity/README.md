---
description: "Team membership, issued tokens, and the signed cookie that answers who is calling in a shared DSH deployment."
kind: "package-reference"
---

# @deepseek-ai/dsh-team-identity

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Sign members into a shared DSH deployment and give every admitted request a
server-resolved caller. Declare the roster in configuration; each member signs in
with a name and a code and receives a signed cookie bound to the request
authority. The package installs itself as the transport identity resolver, so
ownership, audit, and event targeting can all read the caller from the transport
instead of trusting a payload. Revoking a member stops their tokens immediately
and ends their open streams. Admission itself is unchanged: the DSH browser
cookie still gates every request first.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in the profile that serves your team, declare the members, and let them
sign in once through the browser page.

### When to choose it

Choose it whenever one DSH process serves more than one person and actions must
be attributable to a member. Without it the deployment keeps DSH's single-user
behaviour: every authenticated browser is the same caller, and nothing can be
recorded against a person. It does not replace the transport cookie, and it does
not authorize resources — team members can see each other's work by design.

### Minimal configuration

```yaml
- id: team-identity
  name: '@deepseek-ai/dsh-team-identity'
  config:
    members:
      - userId: u-alice
        name: 爱丽丝
        signInCode: <personal code>
```

| Field | Default | Meaning |
|---|---|---|
| `members` | `[]` | Members admitted; an empty roster admits nobody |
| `members[].userId` | `required` | Stable id recorded on every action |
| `members[].name` | `required` | Display name the member signs in with |
| `members[].signInCode` | `required` unless the shared code is set | Code only this member should know |
| `members[].alternateSignInCode` | unset | Shared code admitting members without a personal one |
| `tokenTtlDays` | `30` | Lifetime of one issued token |
| `tokenLimit` | `200` | Live tokens kept before the oldest expire |
| `homePath` | `$DSH_HOME` | Directory holding the registry document |

The plugin declares no `dsh.bundle.patch`, so it mounts as a `cordis.yml` row, not
through `dsh plugin add`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package owns three things the transport deliberately does not: the member
roster, the issued-token table, and the signed cookie carrying one token id.

**Two cookies, two jobs.** The DSH browser cookie answers whether a request came
from a legitimately opened page and belongs to the transport. This package's
cookie answers which member is calling. Both are `HttpOnly` and authority-bound,
so the browser RPC channel, raw uploads, and the WebSocket handshake all carry
them automatically.

**One member keeps one live session.** Signing in again ends that member's earlier
sessions, so a second sign-in replaces the first instead of adding to it. Both
cases land in the same rule: the same person on a second device, and someone else
holding their code, are answered by leaving the newest session as the only one. The
replaced session's open streams are closed with it, so a browser left open on the
older session stops receiving anything, and the conversations it was driving are
released rather than left claimed by a session that no longer exists.

**Sign-in is an exact route, not a shared endpoint.** `/api/team.identity` and`/api/team.identity.page` are registered through `ctx.connection.fetch.register`,
and the shared dispatcher resolves exact routes before the interceptor chain. That
is what makes them exempt from the "must already be signed in" check by
construction, instead of by a branch that could be mis-evaluated. The transport
fence still runs first, so the routes add to admission and never replace it.

**A signed-out browser gets the sign-in page instead of the shell.** The plugin
taps the index document and injects a small script into `<head>`, so it runs
before the shell's own scripts and can replace the document rather than covering a
mounted application. The page is plain server-rendered HTML with one inline
script: no client bundle, no build step, and no browser-side plugin. The gate is a
convenience for a signed-out member, not the security boundary — every `/api`
route re-checks the same cookie server-side.

**Synchronous resolution.** The registry is read once when the plugin activates,
so `resolve` can answer from headers alone on every request's hot path. Writes are
best-effort: an unwritable home still serves the current run.

**Revocation reaches connections.** `revoke` deletes the member's tokens and
emits `identity/revoked`; the Remote gateway listens and closes that member's
established WebSocket connections, which a per-stream check would never revisit.

**Writing has one controller per conversation.** Reading stays open — watching each
other's work is the point of a team deployment — while sending a prompt,
cancelling a turn, editing the queue, switching the model, renaming, and forking
belong to whoever claimed the conversation first. The decision is enforced in the
Remote transport, because that is the only layer that knows both the caller and
the endpoint before a method runs: the policy sees the server-resolved member, the
endpoint, and the decoded arguments. Control changes only through an explicit
handover, so an earlier controller's late action is refused rather than silently
winning.

**Interaction requests reach the member who can answer them.** A forwarded tool
approval or Agent question needs an answer from exactly one operator; delivering
it to every viewer would let a bystander answer for someone else. The same
controller binding answers that question — an Agent's identity is its Session id —
and the transport asks for the owner per interaction request. An unclaimed Agent
resolves to no owner, which leaves delivery exactly as it was rather than dropping
the request. Revoking a member also releases the conversations they were driving,
so a binding can never outlive the tokens that justified it.

**Control moving re-delivers what that conversation was waiting on.** A request
that arrived while one member was driving must not be settled by them after someone
else takes over — they may have been replaced precisely because they are no longer
there. Every transfer tells the transport to withdraw that conversation's
outstanding requests, tell the previous holder to stop waiting, and offer them
again to whoever owns it now. An unowned request is left where it is: withdrawing
it into nowhere would strand the Agent forever.

**Every tenure has its own lease number.** Comparing the caller against the
current controller is not enough: a member who hands off, watches someone else
take over, and then takes control back would match "is the controller" for an
answer they produced during their *first* tenure. The lease number makes that
answer stale, so each acquisition mints a new one. An answer quotes the lease
**and** its delivery number **and**, when the caller declared one, its page
instance — all three, because each closes a different hole: the lease stops a past
tenure, the delivery number stops a replayed answer, and the page instance stops
another tab of the same member.

A lease also ends on its own, which covers the most common case of all: the
controller went home. An accepted write renews it, so an active controller never
loses the conversation mid-work, and an expired lease lets the next writer claim
it rather than locking everyone out. Expiry is swept on a timer as well as noticed
lazily, because a controller who closed the page never writes again — without the
sweep their conversation would stay claimed, and the request it was waiting on
would stay addressed to someone who is gone.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, roster validation, resolver, routes, and the index gate |
| [`src/service.ts`](src/service.ts) | `TeamIdentity`: subject resolution, sign-in, cookie header, revocation |
| [`src/registry.ts`](src/registry.ts) | Durable roster, token table, signing secret, expiry and cap policy |
| [`src/cookie.ts`](src/cookie.ts) | Authority-bound signed cookie codec |
| [`src/call-policy.ts`](src/call-policy.ts) | Which member may write to which conversation, asked by the Remote transport |
| [`src/session-control.ts`](src/session-control.ts) | Controller bindings and the explicit handover |
| [`src/http-route.ts`](src/http-route.ts) | Status, sign-in, and sign-in-document responses |
| [`src/paths.ts`](src/paths.ts) | The Fetch paths both the routes and the page need, kept apart to avoid an import cycle |
| [`src/sign-in-page.ts`](src/sign-in-page.ts) | The page markup, its inline script, and the index-injection gate |
| [`tests/identity.spec.ts`](tests/identity.spec.ts) | Sign-in, cookie binding, revocation, and registry durability |
| [`tests/mount.spec.ts`](tests/mount.spec.ts) | The plugin's real contribution through a Connection host |
| [`tests/sign-in.spec.ts`](tests/sign-in.spec.ts) | The page, the document, and gate placement |
| [`tests/session-control.spec.ts`](tests/session-control.spec.ts) | Controller binding and the call policy |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-client-connection](../../client/connection/README.md) — owns the transport fence and the identity-resolver seam this package installs into.
- [identity group map](../README.md) — the sibling packages and group scope.
- [dsh-home-paths](../../util/home-paths/README.md) — owns `$DSH_HOME` resolution for the registry document.
- [dsh-api-gateway](../../api/gateway/README.md) — closes a revoked member's established Remote streams.
- [dsh-web-app](../../bundle/web-app/README.md) — the profile that serves the browser UI a member signs in through.

-----

<a id="model-experience"></a>
## Model Experience

None, as team identity answers transport questions about who is calling and registers nothing model-facing: no tool, no prompt section, and no member name, code, or token ever reaches the model.

#### KV Cache effect

None; identity is resolved per request at the transport and is injected into no conversation, so the token stream and the model-visible prefix are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Sign-in works today, but three boundaries are deliberate rather than unfinished.

- **Sign-in lives in configuration.** Rotating a member's code requires an operator edit; there is no self-service enrolment.
- **One page at a time.** The cookie carries no client-instance id yet, so the conversation-control step cannot distinguish two tabs of the same member.
- **Signing in is not authorizing.** Distinguishing a human confirmation from an agent action needs the separate human-confirmation credential the report-side contract requires; a team cookie alone cannot express it.
- **Codes are compared in constant time but distributed out of band.** Delivering a code to the right person remains an operator responsibility.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The registry document holds only a per-home signing secret and the token table, so
losing it signs members out without losing their ability to sign in again. A
corrupt file is read as an empty registry rather than overwriting what is there;
the next mutation writes a valid document.

`lookup` drops expired tokens when it meets one, so the table does not grow without
bound even when nobody signs in again, and `issue` caps the table at `tokenLimit`
by keeping the tokens that expire last.

A member entry with an empty `userId` or name fails the plugin loudly rather than
admitting a member nobody can address.

</details>
