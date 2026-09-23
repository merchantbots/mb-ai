import { readFileSync, writeFileSync } from 'node:fs'
import { profileCachePath, ensureDirs } from './paths'
import { ProfileSchema, type Profile } from '../schema/profile'
import { parseError } from './http'
import { debug } from './log'

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
