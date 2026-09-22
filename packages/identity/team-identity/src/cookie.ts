/**
 * Team cookie codec: the signed, authority-bound envelope that carries one team
 * token id between the browser and the Host.
 *
 * Unlike the DSH browser cookie this one carries user identity, so it is signed
 * with the registry's per-home secret and validated against the live token table
 * on every request. The payload holds only the revocation key — never the
 * member's name or code — so a stolen cookie can be killed by revoking its token.
 *
 * @module @deepseek-ai/dsh-team-identity/cookie
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const COOKIE_PREFIX = 'dsh-team-'
const COOKIE_PAYLOAD_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

/** Cookie payload signed into one team cookie. */
export interface TeamCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  /** Request authority this cookie is valid for. */
  readonly authority: string
  /** Revocation key of the issued token. */
  readonly tokenId: string
  readonly issuedAt: number
  readonly expiresAt: number
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

/**
 * Canonical request authority, from the Host header.
 * @param headers - request headers.
 * @returns the authority, or undefined when the request has no usable Host.
 */
export function requestAuthority(
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>,
): string | undefined {
  const host = headers instanceof Headers ? headers.get('host') : headers['host']
  if (typeof host !== 'string') return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

/**
 * Cookie name for one authority.
 * @param authority - canonical `host` or `host:port`.
 * @returns the exact cookie name this deployment writes and reads.
 */
export function teamCookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

function signature(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

/**
 * Encode one team cookie value.
 * @param payload - fields to sign.
 * @param secret - per-home signing secret.
 * @returns the `v1.<body>.<signature>` wire value.
 */
export function encodeTeamCookie(payload: TeamCookiePayload, secret: string): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

/**
 * Verify one team cookie value.
 * @param value - wire value read from the request.
 * @param secret - per-home signing secret.
 * @returns the payload, or undefined when the value is malformed or not signed by this home.
 */
export function decodeTeamCookie(value: string, secret: string): TeamCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof decoded !== 'object' || decoded === null) return undefined
  const record = decoded as Partial<TeamCookiePayload>
  if (record.version !== COOKIE_PAYLOAD_VERSION
    || typeof record.authority !== 'string'
    || typeof record.tokenId !== 'string'
    || typeof record.issuedAt !== 'number'
    || typeof record.expiresAt !== 'number') return undefined
  return record as TeamCookiePayload
}

/**
 * Serialize the fixed team-cookie attributes.
 * @param name - cookie name for the request authority.
 * @param value - encoded cookie value.
 * @param expiresAt - absolute expiry in unix milliseconds.
 * @returns the `Set-Cookie` value.
 */
export function teamCookie(name: string, value: string, expiresAt: number): string {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
}

/**
 * Read one exact cookie value without implementing general Cookie decoding.
 * @param headerValue - raw `Cookie` header.
 * @param name - exact cookie name.
 * @returns the value, or undefined when the request does not carry it.
 */
export function readCookie(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}
