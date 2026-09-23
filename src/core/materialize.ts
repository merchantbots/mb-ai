import { writeFileSync } from 'node:fs'
import { serversJsonPath, ensureDirs } from './paths'
import type { Profile } from '../schema/profile'

const PLACEHOLDER = '${MB_TOKEN}'

/**
 * Substitute the real bearer into `mcpServers[*].headers` and write `servers.json`
 * at mode 600. The token only ever lands in this locked file — never argv or logs.
 * Returns the path to pass to `claude --mcp-config`.
 */
export function writeServersJson(host: string, profile: Profile, token: string): string {
  const servers: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(profile.mcpServers)) {
    const server: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
    const headers = server.headers as Record<string, string> | undefined
    if (headers) {
      const substituted: Record<string, string> = {}
      for (const [k, v] of Object.entries(headers)) {
        substituted[k] = v.split(PLACEHOLDER).join(token)
      }
      server.headers = substituted
    }
    servers[name] = server
  }

  ensureDirs(host)
  const path = serversJsonPath(host)
  writeFileSync(path, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
  return path
}
