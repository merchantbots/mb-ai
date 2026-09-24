import { resolveBackend } from '../config'
import { getValidToken } from '../session'
import { fetchProfile } from '../profile'

/**
 * Print the raw harness profile the backend returns — a diagnostic for seeing exactly what
 * drives the launch: system prompt, mcpServers URLs, allowed tools, flags, and the version
 * floor. The mcpServers headers carry the `${MB_TOKEN}` placeholder (not the real token), so
 * the output is safe to share.
 */
export async function profileCommand(opts: { backendUrl?: string }): Promise<void> {
  const { url, host } = resolveBackend(opts.backendUrl)
  const token = getValidToken(host)
  const profile = await fetchProfile(url, token)
  console.log(JSON.stringify(profile, null, 2))
}
