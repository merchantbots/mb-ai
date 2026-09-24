import { execa } from 'execa'
import * as http from 'node:http'
import * as https from 'node:https'
import { resolveBackend } from '../config'
import { tokenStatus } from '../session'
import { fetchProfile } from '../profile'
import { VERSION } from '../version'

type ProbeResult = { status: number; location?: string } | { error: string }

// GET the URL WITHOUT following redirects, so we can surface 307/404 and any scheme
// downgrade in the Location header — the usual cause of "MCP endpoint not found".
function probe(rawUrl: string, timeoutMs = 8000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let u: URL
    try {
      u = new URL(rawUrl)
    } catch {
      resolve({ error: 'invalid URL' })
      return
    }
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.request(u, { method: 'GET' }, (res) => {
      res.resume() // drain so the socket can close
      resolve({ status: res.statusCode ?? 0, location: res.headers.location })
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve({ error: 'timeout' })
    })
    req.on('error', (e) => resolve({ error: e.message }))
    req.end()
  })
}

function verdict(requestedUrl: string, r: ProbeResult): string {
  if ('error' in r) return `✗ unreachable (${r.error})`
  const { status, location } = r
  if (status >= 200 && status < 300) return `✓ reachable (${status})`
  if (status === 401 || status === 403) return `✓ reachable (${status}, needs auth)`
  if (status >= 300 && status < 400) {
    const downgrade =
      !!location && new URL(requestedUrl).protocol === 'https:' && location.startsWith('http:')
    return `⚠ ${status} redirect → ${location ?? '?'}${downgrade ? '  (https→http downgrade)' : ''}`
  }
  if (status === 404) return '✗ 404 not found (nothing mounted at this URL)'
  return `⚠ HTTP ${status}`
}

// Fetch the profile the backend serves and probe each MCP server URL from it.
async function mcpLines(url: string, token: string | null): Promise<string[]> {
  const label = 'mcp'.padEnd(12)
  const cont = ''.padEnd(12)
  if (!token) return [`${label}(log in to check endpoints)`]
  let profile
  try {
    profile = await fetchProfile(url, token)
  } catch (e) {
    return [`${label}(couldn't fetch profile: ${e instanceof Error ? e.message : String(e)})`]
  }
  const entries = Object.entries(profile.mcpServers)
  if (entries.length === 0) return [`${label}(no MCP servers in profile)`]
  const width = Math.max(...entries.map(([name]) => name.length))
  const results = await Promise.all(
    entries.map(async ([name, server]) => `${name.padEnd(width)}  ${verdict(server.url, await probe(server.url))}`),
  )
  return results.map((line, i) => `${i === 0 ? label : cont}${line}`)
}

export async function doctorCommand(opts: { backendUrl?: string }): Promise<void> {
  const { url, host } = resolveBackend(opts.backendUrl)

  console.log(`mb-ai       ${VERSION}`)
  console.log(`backend     ${url}`)

  const { token, source, expiresAt } = tokenStatus(host)
  if (!token) {
    console.log('auth        not logged in  (run: mb-ai login)')
  } else {
    const days = expiresAt ? Math.round((expiresAt - Date.now()) / 86_400_000) : null
    const src = source === 'env' ? '  (MB_AI_TOKEN)' : ''
    console.log(`auth        logged in${days != null ? ` (~${days}d left)` : ''}${src}`)
  }

  let claudeLine = 'not found on PATH  (npm i -g @anthropic-ai/claude-code)'
  try {
    const { stdout } = await execa('claude', ['--version'])
    claudeLine = stdout.trim()
  } catch {
    // leave the not-found hint
  }
  console.log(`claude      ${claudeLine}`)

  for (const line of await mcpLines(url, token)) console.log(line)
}
