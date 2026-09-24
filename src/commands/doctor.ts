import { execa } from 'execa'
import * as http from 'node:http'
import * as https from 'node:https'
import { resolveBackend } from '../config'
import { tokenStatus } from '../session'
import { fetchProfile, type Profile } from '../profile'
import { skillsStatus } from '../skills'
import { ApiError, backendReport } from '../errors'
import { semverLt } from '../launch'
import { VERSION } from '../version'
import { c, sym, label, indent } from '../ui'

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
  if ('error' in r) return `${sym.err} ${c.red('unreachable')} (${r.error})`
  const { status, location } = r
  if (status >= 200 && status < 300) return `${sym.ok} reachable (${status})`
  if (status === 401 || status === 403) return `${sym.ok} reachable (${status}, needs auth)`
  // MCP streamable-http endpoints reject a bare GET (they want POST / an SSE Accept) — still "up".
  if (status === 405 || status === 406) return `${sym.ok} reachable (${status}, MCP endpoint up)`
  if (status >= 300 && status < 400) {
    const downgrade =
      !!location && new URL(requestedUrl).protocol === 'https:' && location.startsWith('http:')
    return `${sym.warn} ${c.yellow(`${status} redirect`)} → ${location ?? '?'}${downgrade ? c.red('  (https→http downgrade)') : ''}`
  }
  if (status === 404) return `${sym.err} ${c.red('404 not found')} (nothing mounted at this URL)`
  return `${sym.warn} ${c.yellow(`HTTP ${status}`)}`
}

// Everything a launch would hand to `claude`, derived from the fetched profile — so `doctor`
// answers "what config do I actually run with?": version floor, model/flags, allowed tools, the
// resolved skills plugin dir, and each MCP server's URL + reachability.
async function configLines(profile: Profile, host: string): Promise<string[]> {
  const out: string[] = []

  const gated = semverLt(VERSION, profile.minLauncherVersion)
  out.push(
    `${label('profile')}v${profile.profileVersion}  ${c.dim('·')}  min launcher ${profile.minLauncherVersion}  ` +
      (gated ? `${sym.err} ${c.red(`this launcher (${VERSION}) is below the floor — launch is blocked`)}` : sym.ok),
  )

  const flags = profile.flags ?? {}
  if (flags.model != null && flags.model !== false) out.push(`${label('model')}${flags.model}`)
  if (flags['permission-mode'] != null && flags['permission-mode'] !== false)
    out.push(`${label('mode')}${flags['permission-mode']}  ${c.dim('(permission-mode)')}`)
  const rest = Object.entries(flags).filter(
    ([k, v]) => k !== 'model' && k !== 'permission-mode' && v !== null && v !== false,
  )
  if (rest.length)
    out.push(`${label('flags')}${rest.map(([k, v]) => (v === true ? `--${k}` : `${k}=${v}`)).join(', ')}`)

  out.push(`${label('prompt')}${profile.systemPrompt.length.toLocaleString()} ${c.dim('chars (inline --system-prompt)')}`)
  out.push(`${label('tools')}${profile.allowedTools.length ? profile.allowedTools.join(', ') : c.dim('(none)')}`)

  const skills = skillsStatus(host, profile)
  if (!skills) {
    out.push(`${label('skills')}${c.dim('(none in profile)')}`)
  } else {
    out.push(
      `${label('skills')}${skills.plugin} ${c.dim('@')} ${skills.commit.slice(0, 8)}  ` +
        (skills.cached ? c.green('(cached)') : c.yellow('(not cached — downloads on next run)')),
    )
    out.push(`${indent}${c.dim(skills.cached ? skills.pluginDir! : skills.dir)}`)
  }

  const servers = Object.entries(profile.mcpServers)
  if (servers.length === 0) {
    out.push(`${label('mcp')}${c.dim('(no MCP servers in profile)')}`)
  } else {
    const width = Math.max(...servers.map(([name]) => name.length))
    const probes = await Promise.all(
      servers.map(async ([name, s]) => ({ name, url: s.url, v: verdict(s.url, await probe(s.url)) })),
    )
    probes.forEach((p, i) => {
      out.push(`${i === 0 ? label('mcp') : indent}${p.name.padEnd(width)}  ${p.v}`)
      out.push(`${indent}${' '.repeat(width)}  ${c.dim(p.url)}`)
    })
  }

  return out
}

export async function doctorCommand(opts: { backendUrl?: string }): Promise<void> {
  const { url, host } = resolveBackend(opts.backendUrl)

  console.log(`${label('mb-ai')}${VERSION}`)
  console.log(`${label('backend')}${url}`)

  const { token, source, expiresAt } = tokenStatus(host)
  if (!token) {
    console.log(`${label('auth')}${c.yellow('not logged in')}  ${c.dim('(run: mb-ai login)')}`)
  } else {
    const days = expiresAt ? Math.round((expiresAt - Date.now()) / 86_400_000) : null
    const src = source === 'env' ? '  (MB_AI_TOKEN)' : ''
    console.log(`${label('auth')}${c.green('logged in')}${c.dim(`${days != null ? ` (~${days}d left)` : ''}${src}`)}`)
  }

  let claudeLine = `${c.yellow('not found on PATH')}  ${c.dim('(npm i -g @anthropic-ai/claude-code)')}`
  try {
    const { stdout } = await execa('claude', ['--version'])
    claudeLine = stdout.trim()
  } catch {
    // leave the not-found hint
  }
  console.log(`${label('claude')}${claudeLine}`)

  // Below the blank line: exactly what `mb-ai` would launch `claude` with, from the live profile.
  console.log('')
  if (!token) {
    console.log(`${label('config')}${c.dim('log in to preview the launch config')}`)
    return
  }
  try {
    const profile = await fetchProfile(url, token)
    for (const line of await configLines(profile, host)) console.log(line)
  } catch (e) {
    // Backend-side failure → show the full response for the user to share with the team.
    if (e instanceof ApiError && e.serverSide) {
      console.log(`${label('config')}the backend returned an error while building your profile:`)
      console.log(backendReport(e, 'preview your config'))
    } else {
      const msg = e instanceof ApiError ? e.detail() : e instanceof Error ? e.message : String(e)
      console.log(`${label('config')}couldn't fetch profile: ${msg}`)
    }
  }
}
