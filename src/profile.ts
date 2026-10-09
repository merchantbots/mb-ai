import { z } from 'zod'
import { parseError } from './errors'

// ── Schema (GET /api/v1/mb-harness/profile body) ─────────────────────────────
const McpServer = z
  .object({
    type: z.string(),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  })
  .passthrough()

// The skills plugin bundle. `commit` is the content id (cache key); `downloadUrl` serves the
// archive. All fields are optional so older/placeholder profiles parse — the launcher only syncs
// when both `commit` and `downloadUrl` are present (see src/skills.ts).
const Skills = z
  .object({
    plugin: z.string().optional(),
    commit: z.string().optional(),
    downloadUrl: z.string().optional(),
  })
  .passthrough()

// Usage-reporting config, set system-wide by the backend. `reportIntervalMs` is the throttle: the
// launcher POSTs an account's usage at most once per this window (defaults to 2h when unset).
const Usage = z
  .object({
    reportIntervalMs: z.number().optional(),
  })
  .passthrough()

export const ProfileSchema = z
  .object({
    profileVersion: z.number(),
    minLauncherVersion: z.string(),
    systemPrompt: z.string(),
    mcpServers: z.record(McpServer),
    allowedTools: z.array(z.string()),
    skills: Skills.optional(),
    usage: Usage.optional(),
    flags: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .passthrough()

export type Profile = z.infer<typeof ProfileSchema>

// ── Fetch ────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/mb-harness/profile — always a live fetch (no client-side caching).
 *  - 200 → validate + return
 *  - 401/403 → throw ApiError (caller decides: re-login+retry / not retryable)
 */
export async function fetchProfile(backendUrl: string, token: string): Promise<Profile> {
  const res = await fetch(`${backendUrl}/api/v1/mb-harness/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw await parseError(res)
  return ProfileSchema.parse(await res.json())
}
