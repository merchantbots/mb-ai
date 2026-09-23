// The login response has no `expires_at`; expiry lives in the JWT's `exp` claim.
// We only *read* the payload (the server verifies the signature) to decide when to re-login.

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
