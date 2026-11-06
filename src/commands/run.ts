import { resolveBackend } from '../config'
import { getValidToken } from '../session'
import { fetchProfile } from '../profile'
import { writeServersJson, execClaude, assertLauncherVersion } from '../launch'
import { ensureSkills } from '../skills'
import { reportUsage, startUsageReporter, DEFAULT_REPORT_INTERVAL_MS } from '../usage'
import { NeedsLogin, ApiError, MbError } from '../errors'
import { info, warn, debug } from '../log'
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
  let profile
  try {
    profile = await fetchProfile(url, token)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      warn('Token rejected by the backend — logging in again.')
      token = await doLogin(url, host)
      profile = await fetchProfile(url, token)
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

  debug(`profile v${profile.profileVersion}, ${Object.keys(profile.mcpServers).length} MCP server(s)`)

  // 3. hard version gate — refuse (no self-update) if the launcher is below the floor
  assertLauncherVersion(profile.minLauncherVersion)

  // 4. materialize servers.json (token baked in, mode 600) — prompt stays inline
  const serversPath = writeServersJson(host, profile, token)

  // 5. sync the skills plugin bundle (cached by commit; re-downloads only when it changes)
  const pluginDirs = await ensureSkills(host, profile, token)

  // 6. report the signed-in Claude account's usage — now, while the session runs, and once more
  //    when claude exits (always on; interval set by the backend profile; best-effort — never
  //    blocks or fails the launch)
  const reporting = {
    backendUrl: url,
    host,
    token,
    intervalMs: profile.usage?.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS,
  }
  await reportUsage(reporting)
  const stopReporting = startUsageReporter(reporting)

  // 7. hand off to claude, then send the session's final reading
  const code = await execClaude(profile, serversPath, pluginDirs)
  await stopReporting()
  process.exit(code)
}
