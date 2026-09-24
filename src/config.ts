import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { MbError } from './errors'

// ── Backend ──────────────────────────────────────────────────────────────────
// TODO(open item): real production URL. Dev is http://localhost:8000 (pass via --backend-url).
export const DEFAULT_BACKEND = 'https://api.mb.example.com'

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

export function ensureDirs(host: string): void {
  mkdirSync(cacheDir(host), { recursive: true })
}
