import { resolveBackend } from '../core/backend'
import { getValidToken } from '../core/auth'
import { fetchProfile } from '../core/profile'
import { writeServersJson } from '../core/materialize'
import { execClaude } from '../core/exec'
import { NeedsLogin, ApiError, MbError } from '../core/errors'
import { info, warn, debug } from '../core/log'
import { doLogin } from './login'

/** The default flow: resolve backend → ensure auth → profile → materialize → exec claude. */
export async function run(opts: { backendUrl?: string }): Promise<void> {
  const { url, host } = resolveBackend(opts.backendUrl)
  info(`mb-ai · ${host}`)

  // 1. ensure a usable token (no refresh endpoint → re-login on expiry)
  let token: string
  try {
    token = getValidToken(host)
  } catch (e) {
    if (e instanceof NeedsLogin) {
      warn(e.message)
      token = await doLogin(url, host)
    } else {
      throw e
    }
  }

  // 2. fetch profile; on a 401 re-login once and retry
  let result
  try {
    result = await fetchProfile(url, host, token)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      warn('Token rejected by the backend — logging in again.')
      token = await doLogin(url, host)
      result = await fetchProfile(url, host, token)
    } else if (e instanceof ApiError && e.status === 403) {
      throw new MbError(
        `This account can't use mb-ai (${e.apiCode}). A platform-role user is required.`,
        e.apiCode,
        1,
      )
    } else {
      throw e
    }
  }

  const { profile, fromCache, stale } = result
  if (stale) warn('Backend unreachable — using the last cached profile.')
  debug(`profile v${profile.profileVersion}${fromCache ? ' (cache)' : ''}, ${Object.keys(profile.mcpServers).length} MCP server(s)`)

  // 3. materialize servers.json (token baked in, mode 600) — prompt stays inline
  const serversPath = writeServersJson(host, profile, token)

  // 4. hand off to claude
  const code = await execClaude(profile, serversPath)
  process.exit(code)
}
