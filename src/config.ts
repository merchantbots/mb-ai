import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { MbError } from './errors'

// ── Backend ──────────────────────────────────────────────────────────────────
// Production default. For local dev, pass --backend-url http://localhost:8000
// (or set MB_AI_BACKEND_URL).
export const DEFAULT_BACKEND = 'https://api.merchantbots.com'

export interface Backend {
  /** Base URL, no trailing slash. All paths are under `${url}/api/v1/...`. */
  url: string
  /** Host (incl. port) — used to namespace on-disk state and the keychain slot. */
  host: string
}

/**
 * Resolve which backend to talk to. One knob, highest wins:
 *   --backend-url flag  >  MB_AI_BACKEND_URL  >  baked-in prod default.
 */
export function resolveBackend(flag?: string): Backend {
  const raw = (flag || process.env.MB_AI_BACKEND_URL || DEFAULT_BACKEND).trim()
  const url = raw.replace(/\/+$/, '')
  let host: string
  try {
    host = new URL(url).host
  } catch {
    throw new MbError(`Invalid backend URL: ${raw}`, 'BAD_BACKEND_URL', 2)
  }
  return { url, host }
}

// ── Paths ────────────────────────────────────────────────────────────────────
// State lives under ~/.mb-ai, namespaced by backend host so dev and prod never mix.
export const ROOT = join(homedir(), '.mb-ai')

/** Backend host → filesystem-safe segment (e.g. "localhost:8000" → "localhost_8000"). */
function seg(host: string): string {
  return host.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function backendDir(host: string): string {
  return join(ROOT, 'backends', seg(host))
}

export function cacheDir(host: string): string {
  return join(backendDir(host), 'cache')
}

export function serversJsonPath(host: string): string {
  return join(cacheDir(host), 'servers.json')
}

/** Where the backend's skills plugin bundle is cached (content-addressed by commit). */
export function skillsDir(host: string): string {
  return join(backendDir(host), 'skills')
}

/** Per-backend throttle state for usage reporting (last-reported timestamp per account). */
export function usageStatePath(host: string): string {
  return join(backendDir(host), 'usage-state.json')
}

export function ensureDirs(host: string): void {
  mkdirSync(cacheDir(host), { recursive: true })
}

// ── Claude Code's own on-disk file ─────────────────────────────────────────────
// We read (never write) `~/.claude.json` to learn the logged-in account and its rate-limit usage.
// The path is overridable by env — handy for diagnostics and required by the smoke test, which
// must never touch the real file.

/** `~/.claude.json` — carries `oauthAccount` (the signed-in email) and `cachedUsageUtilization`. */
export function claudeConfigPath(): string {
  return process.env.MB_AI_CLAUDE_CONFIG || join(homedir(), '.claude.json')
}
