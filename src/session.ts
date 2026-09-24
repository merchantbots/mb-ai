import { Entry } from '@napi-rs/keyring'
import { NeedsLogin, parseError } from './errors'

// ── Keychain ─────────────────────────────────────────────────────────────────
// Token lives in the OS keychain, keyed by backend host, so dev and prod tokens
// never mix and nothing lands on disk.
const SERVICE = 'mb-ai'

function entry(host: string): Entry {
  return new Entry(SERVICE, host)
}

export function getToken(host: string): string | null {
  try {
    return entry(host).getPassword()
  } catch {
    // keyring throws when the entry doesn't exist
    return null
  }
}

export function setToken(host: string, token: string): void {
  entry(host).setPassword(token)
}

export function clearToken(host: string): void {
  try {
    entry(host).deletePassword()
  } catch {
    // already absent
  }
}

// ── JWT (read-only) ──────────────────────────────────────────────────────────
// The login response has no `expires_at`; expiry lives in the JWT's `exp` claim.
// We only *read* the payload (the server verifies the signature) to decide when
// to re-login.
export interface JwtClaims {
  sub?: string
  role?: string
  exp?: number
  [k: string]: unknown
}

export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    return JSON.parse(json) as JwtClaims
  } catch {
    return null
  }
}

/** Expiry in ms since epoch, or null if it can't be read. */
export function expiresAt(token: string): number | null {
  const claims = decodeJwt(token)
  return typeof claims?.exp === 'number' ? claims.exp * 1000 : null
}

/** True if the token is expired (or within `skewMs` of it), or unreadable. */
export function isExpiredOrNear(token: string, skewMs = 5 * 60_000): boolean {
  const exp = expiresAt(token)
  if (exp == null) return true // unreadable → force a fresh login
  return Date.now() >= exp - skewMs
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export interface LoginResult {
  token: string
  role?: string
}

/**
 * POST /api/v1/auth/login — OAuth2 password form (x-www-form-urlencoded).
 * Stores the returned bearer under the backend's keychain slot.
 */
export async function login(
  backendUrl: string,
  host: string,
  email: string,
  password: string,
): Promise<LoginResult> {
  const body = new URLSearchParams({ username: email, password })
  const res = await fetch(`${backendUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw await parseError(res)
  const data = (await res.json()) as {
    access_token: string
    token_type: string
    role?: string
  }
  setToken(host, data.access_token)
  return { token: data.access_token, role: data.role }
}

export interface TokenStatus {
  /** The usable bearer, or null if there is none. */
  token: string | null
  /** Where it came from — the MB_AI_TOKEN env var wins over the keychain. */
  source: 'env' | 'keychain' | null
  /** Expiry in ms since epoch, or null if unreadable / absent. */
  expiresAt: number | null
}

/** The one place that answers "is there a token, from where, and until when". */
export function tokenStatus(host: string): TokenStatus {
  const envToken = process.env.MB_AI_TOKEN
  const token = envToken || getToken(host)
  if (!token) return { token: null, source: null, expiresAt: null }
  return { token, source: envToken ? 'env' : 'keychain', expiresAt: expiresAt(token) }
}

/** Return a usable token, or throw NeedsLogin (no refresh endpoint — re-login on expiry). */
export function getValidToken(host: string): string {
  const { token, source } = tokenStatus(host)
  if (!token) throw new NeedsLogin('Not logged in.', host)
  if (isExpiredOrNear(token)) {
    throw new NeedsLogin(
      source === 'env' ? 'MB_AI_TOKEN is expired.' : 'Session expired — please log in again.',
      host,
    )
  }
  return token
}

export function logout(host: string): void {
  clearToken(host)
}
