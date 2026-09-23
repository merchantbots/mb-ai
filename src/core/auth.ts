import { getToken, setToken, clearToken } from './secrets'
import { isExpiredOrNear } from './jwt'
import { parseError } from './http'
import { NeedsLogin } from './errors'

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

/** Return a usable token, or throw NeedsLogin (no refresh endpoint — re-login on expiry). */
export function getValidToken(host: string): string {
  // Headless/CI escape hatch: an explicit MB_AI_TOKEN wins over the keychain.
  const envToken = process.env.MB_AI_TOKEN
  const token = envToken || getToken(host)
  if (!token) throw new NeedsLogin('Not logged in.', host)
  if (isExpiredOrNear(token)) {
    throw new NeedsLogin(
      envToken ? 'MB_AI_TOKEN is expired.' : 'Session expired — please log in again.',
      host,
    )
  }
  return token
}

export function logout(host: string): void {
  clearToken(host)
}
