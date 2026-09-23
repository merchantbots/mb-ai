import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

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

export function profileCachePath(host: string): string {
  return join(cacheDir(host), 'profile.json')
}

export function serversJsonPath(host: string): string {
  return join(cacheDir(host), 'servers.json')
}

export function ensureDirs(host: string): void {
  mkdirSync(cacheDir(host), { recursive: true })
}
