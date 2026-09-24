import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { profileCachePath, ensureDirs } from './config'
import { parseError } from './errors'
import { debug } from './log'

// ── Schema (GET /api/v1/harness/profile body) ────────────────────────────────
const McpServer = z
  .object({
    type: z.string(),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  })
  .passthrough()

// `skills` is a DUMMY placeholder in v1 (ignored).
export const ProfileSchema = z
  .object({
    profileVersion: z.number(),
    minLauncherVersion: z.string(),
    ttlSeconds: z.number(),
    systemPrompt: z.string(),
    mcpServers: z.record(McpServer),
    allowedTools: z.array(z.string()),
    skills: z.unknown().optional(),
    flags: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .passthrough()

export type Profile = z.infer<typeof ProfileSchema>

// ── Fetch + ETag cache ───────────────────────────────────────────────────────
interface CacheEntry {
  etag: string | null
  ttlSeconds: number
  fetchedAt: number
  body: string // the raw response bytes (so the ETag stays valid)
}

function readCache(host: string): CacheEntry | null {
  try {
    return JSON.parse(readFileSync(profileCachePath(host), 'utf8')) as CacheEntry
  } catch {
    return null
  }
}

function writeCache(host: string, entry: CacheEntry): void {
  ensureDirs(host)
  writeFileSync(profileCachePath(host), JSON.stringify(entry), { mode: 0o600 })
}

export interface ProfileResult {
  profile: Profile
  etag: string | null
  fromCache: boolean
  /** True when we fell back to a cached copy because the backend was unreachable. */
  stale?: boolean
}

/**
 * GET /api/v1/harness/profile with ETag caching.
 *  - 200 → validate, cache, return
 *  - 304 → return the cached profile
 *  - network error → last-known-good cache (stale) or rethrow
 *  - 401/403 → throw ApiError (caller decides: re-login+retry / not retryable)
 */
export async function fetchProfile(
  backendUrl: string,
  host: string,
  token: string,
): Promise<ProfileResult> {
  const cached = readCache(host)
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (cached?.etag) headers['If-None-Match'] = cached.etag

  let res: Response
  try {
    res = await fetch(`${backendUrl}/api/v1/harness/profile`, { headers })
  } catch (e) {
    if (cached) {
      debug(`profile fetch failed (${String(e)}) — using cached copy`)
      return { profile: ProfileSchema.parse(JSON.parse(cached.body)), etag: cached.etag, fromCache: true, stale: true }
    }
    throw e
  }

  if (res.status === 304 && cached) {
    return { profile: ProfileSchema.parse(JSON.parse(cached.body)), etag: cached.etag, fromCache: true }
  }
  if (!res.ok) throw await parseError(res)

  const body = await res.text()
  const etag = res.headers.get('etag')
  const profile = ProfileSchema.parse(JSON.parse(body))
  writeCache(host, { etag, ttlSeconds: profile.ttlSeconds, fetchedAt: Date.now(), body })
  return { profile, etag, fromCache: false }
}
