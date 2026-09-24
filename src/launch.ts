import { writeFileSync } from 'node:fs'
import { execa } from 'execa'
import { VERSION, INSTALL_COMMAND } from './version'
import { MbError } from './errors'
import { debug } from './log'
import { serversJsonPath, ensureDirs } from './config'
import type { Profile } from './profile'

// ── Version gate ─────────────────────────────────────────────────────────────
function parse(v: string): [number, number, number] {
  const core = v.trim().replace(/^v/, '').split('-')[0].split('+')[0]
  const [a, b, c] = core.split('.')
  return [Number(a) || 0, Number(b) || 0, Number(c) || 0]
}

/** True if `a` is a lower semver than `b` (compares major.minor.patch). */
export function semverLt(a: string, b: string): boolean {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true
    if (pa[i] > pb[i]) return false
  }
  return false
}

/**
 * Hard gate: refuse to run if the launcher is older than the backend's floor.
 * We do NOT self-update — the user is told exactly how and is responsible for it.
 */
export function assertLauncherVersion(minLauncherVersion: string): void {
  if (semverLt(VERSION, minLauncherVersion)) {
    throw new MbError(
      `mb-ai ${VERSION} is too old — this backend requires ${minLauncherVersion} or newer.\n` +
        `  Update to the latest, then re-run:\n` +
        `    ${INSTALL_COMMAND}`,
      'LAUNCHER_TOO_OLD',
      2,
    )
  }
}

// ── Materialize servers.json ─────────────────────────────────────────────────
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

// ── Exec claude ──────────────────────────────────────────────────────────────
/**
 * Build the `claude` argv from the profile.
 * Order matters: `--allowed-tools` is variadic+greedy, so it goes LAST.
 */
export function buildArgs(profile: Profile, serversPath: string): string[] {
  const args: string[] = []

  // system prompt: inline string (not secret)
  args.push('--system-prompt', profile.systemPrompt)

  // MCP: our file only, token already baked in
  args.push('--mcp-config', serversPath, '--strict-mcp-config')

  // backend-supplied flags (model, permission-mode, …)
  for (const [key, value] of Object.entries(profile.flags ?? {})) {
    if (value === null || value === undefined || value === false) continue
    if (value === true) {
      args.push(`--${key}`)
    } else {
      args.push(`--${key}`, String(value))
    }
  }

  // server-level grants, e.g. mcp__merchantbots — keep LAST (variadic)
  if (profile.allowedTools.length > 0) {
    args.push('--allowed-tools', ...profile.allowedTools)
  }

  return args
}

/** Spawn the real `claude`, inheriting the terminal. Returns its exit code. */
export async function execClaude(profile: Profile, serversPath: string): Promise<number> {
  const args = buildArgs(profile, serversPath)
  debug(`exec: claude ${args.map((a) => (a.includes(' ') ? '"…"' : a)).join(' ')}`)
  try {
    const res = await execa('claude', args, { stdio: 'inherit' })
    return res.exitCode ?? 0
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      throw new MbError(
        '`claude` was not found on PATH. Install Claude Code first: npm i -g @anthropic-ai/claude-code',
        'CLAUDE_NOT_FOUND',
        127,
      )
    }
    // claude ran but exited non-zero → mirror its exit code
    if (typeof e?.exitCode === 'number') return e.exitCode
    throw e
  }
}
