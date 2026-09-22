/**
 * Durable team-account registry: who belongs to this deployment, and which
 * issued team tokens are still usable.
 *
 * The registry is a single JSON document inside the harness home. It holds no
 * password material: membership is claimed with a name plus a sign-in code that
 * the operator distributed, and revocation is simply removal from the token
 * table. Losing the file loses the signed-in sessions, not the ability to sign
 * in again.
 *
 * @module @deepseek-ai/dsh-team-identity/registry
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Default file inside the harness home storing the registry. */
export const TEAM_IDENTITY_FILE_NAME = 'team-identity.json'

const FORMAT_VERSION = 1

/** One team member the operator has admitted. */
export interface TeamMember {
  /** Surrogate id recorded on every action; stable for the member's lifetime. */
  readonly userId: string
  /** Display name the member signs in with. */
  readonly name: string
  /** Fine-grained sign-in code the operator gave this member. */
  readonly signInCode?: string
  /** Shared sign-in code this member may also claim. */
  readonly alternateSignInCode?: string
}

/** One issued team token. */
export interface TeamTokenRecord {
  /** Revocation key carried by the signed cookie. */
  readonly tokenId: string
  /** Member this token was issued to. */
  readonly userId: string
  /** Unix milliseconds when the token stops being accepted. */
  readonly expiresAt: number
}

/** On-disk registry document. */
export interface TeamRegistryFile {
  readonly version: number
  /** Per-home signing secret, minted on first use. */
  readonly secret: string
  readonly tokens: readonly TeamTokenRecord[]
}

/** A signed-in team session resolved from a token. */
export interface TeamSession {
  readonly userId: string
  readonly tokenId: string
  readonly expiresAt: number
}

/** Outcome of one sign-in attempt. */
export type TeamSignInResult =
  | { readonly ok: true; readonly session: TeamSession }
  | { readonly ok: false; readonly reason: 'name' | 'code' }

/** Read the registry synchronously; an absent or unusable file starts empty. */
function loadRegistry(file: string): TeamRegistryFile {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return fresh()
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return fresh()
    const record = parsed as Partial<TeamRegistryFile>
    if (record.version !== FORMAT_VERSION || typeof record.secret !== 'string' || record.secret === '') {
      return fresh()
    }
    const tokens = Array.isArray(record.tokens) ? record.tokens : []
    return {
      version: FORMAT_VERSION,
      secret: record.secret,
      tokens: tokens.filter(isTokenRecord),
    }
  } catch {
    return fresh()
  }
}

function isTokenRecord(value: unknown): value is TeamTokenRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<TeamTokenRecord>
  return typeof record.tokenId === 'string'
    && typeof record.userId === 'string'
    && typeof record.expiresAt === 'number'
}

function fresh(): TeamRegistryFile {
  return { version: FORMAT_VERSION, secret: randomBytes(32).toString('base64url'), tokens: [] }
}

/** Compare two secrets without leaking their common prefix length. */
function secretMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength
    && actualBytes.byteLength > 0
    && timingSafeEqual(actualBytes, expectedBytes)
}

/** Told when the token document could not be written; defaults to a process warning. */
export type PersistFailureReporter = (error: unknown) => void

/** Report a failed write the way the rest of this plugin reports boot-level facts. */
function warnPersistFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.warn(`team-identity: could not write the token registry: ${detail}`)
}

/**
 * Team accounts, their issued tokens, and the per-home signing secret.
 *
 * The registry is loaded once when the plugin activates and written after every
 * mutation, so a restart keeps members signed in until their tokens expire or an
 * operator revokes them.
 *
 * A write that fails is reported rather than swallowed: revocation is one of the
 * mutations, and a revocation that only reached memory would come back on the
 * next load while this process kept behaving as if it had stuck.
 */
export class TeamRegistry {
  private file: TeamRegistryFile

  /**
   * @param path - absolute path of the registry document inside the harness home.
   * @param members - operator-declared membership list.
   * @param limit - maximum number of simultaneously live tokens before the oldest expire.
   * @param onPersistFailure - told when a write fails; defaults to a process warning.
   */
  private constructor(
    private readonly path: string,
    private readonly members: readonly TeamMember[],
    private readonly limit: number,
    private readonly onPersistFailure: PersistFailureReporter = warnPersistFailure,
  ) {
    this.file = loadRegistry(path)
  }

  /**
   * Load one registry from disk, creating its secret when the home has none.
   * @param path - absolute path of the registry document.
   * @param members - operator-declared membership list.
   * @param tokenLimit - maximum live tokens kept; the oldest are dropped first.
   * @param onPersistFailure - told when a write fails; defaults to a process warning.
   * @returns the loaded registry.
   */
  static open(
    path: string,
    members: readonly TeamMember[],
    tokenLimit: number,
    onPersistFailure?: PersistFailureReporter,
  ): TeamRegistry {
    return new TeamRegistry(path, members, tokenLimit, onPersistFailure)
  }

  /** Signing secret for team cookies on this harness home. */
  get secret(): string {
    return this.file.secret
  }

  /** Members this deployment admits, in declaration order. */
  listMembers(): readonly TeamMember[] {
    return this.members
  }

  /**
   * Resolve one member from the name and sign-in code the page submitted.
   * @param name - display name exactly as declared.
   * @param code - fine-grained or shared sign-in code.
   * @returns the matching member, or undefined when either value is wrong.
   */
  matchMember(name: string, code: string): TeamMember | undefined {
    return this.members.find(member =>
      member.name === name
      && ((member.signInCode !== undefined && secretMatches(code, member.signInCode))
        || (member.alternateSignInCode !== undefined && secretMatches(code, member.alternateSignInCode))))
  }

  /**
   * Mint one token for a member and persist it.
   * @param userId - member the token is issued to.
   * @param ttlMs - token lifetime in milliseconds.
   * @returns the new session, already persisted.
   */
  issue(userId: string, ttlMs: number): TeamSession {
    const session: TeamSession = {
      userId,
      tokenId: randomUUID(),
      expiresAt: Date.now() + ttlMs,
    }
    const tokens = [...dropExpired(this.file.tokens), {
      tokenId: session.tokenId,
      userId,
      expiresAt: session.expiresAt,
    }]
    this.persist({ ...this.file, tokens: capTokens(tokens, this.limit) })
    return session
  }

  /**
   * Resolve one live token.
   * @param tokenId - revocation key read from the signed cookie.
   * @returns the matching session, or undefined when unknown, revoked, or expired.
   */
  lookup(tokenId: string): TeamSession | undefined {
    const record = this.file.tokens.find(candidate => candidate.tokenId === tokenId)
    if (record === undefined) return undefined
    if (record.expiresAt <= Date.now()) {
      this.persist({ ...this.file, tokens: dropExpired(this.file.tokens) })
      return undefined
    }
    return { userId: record.userId, tokenId: record.tokenId, expiresAt: record.expiresAt }
  }

  /**
   * Revoke every token of one member, which is what disabling an account means.
   * @param userId - member whose tokens must stop working.
   * @returns how many tokens were revoked.
   */
  revoke(userId: string): number {
    const kept = this.file.tokens.filter(record => record.userId !== userId)
    const revoked = this.file.tokens.length - kept.length
    if (revoked > 0) this.persist({ ...this.file, tokens: kept })
    return revoked
  }

  /**
   * Every member the token table still holds a token for.
   *
   * The table outlives the roster: a member removed from configuration keeps the
   * tokens they were issued, which is why a caller re-checks membership on every
   * read and why boot reconciles the two.
   * @returns the distinct member ids with at least one recorded token.
   */
  tokenUserIds(): readonly string[] {
    return [...new Set(this.file.tokens.map(record => record.userId))]
  }

  private persist(next: TeamRegistryFile): void {
    this.file = next
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (error: unknown) {
      // Best-effort durability: an unwritable home still serves this run, and the
      // operator can repair the home without losing live sessions. Reported, not
      // swallowed — the caller has to be able to learn that a revocation did not
      // reach the disk.
      this.onPersistFailure(error)
    }
  }
}

/** Drop tokens whose lifetime has already ended. */
function dropExpired(tokens: readonly TeamTokenRecord[]): readonly TeamTokenRecord[] {
  const now = Date.now()
  return tokens.filter(record => record.expiresAt > now)
}

/** Keep the newest tokens: the oldest are the least likely to still be open. */
function capTokens(tokens: readonly TeamTokenRecord[], limit: number): readonly TeamTokenRecord[] {
  if (tokens.length <= limit) return tokens
  return [...tokens]
    .sort((left, right) => right.expiresAt - left.expiresAt)
    .slice(0, limit)
}
