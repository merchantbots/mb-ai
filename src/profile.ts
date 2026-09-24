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

// `skills` is a DUMMY placeholder in v1 (ignored).
export const ProfileSchema = z
  .object({
    profileVersion: z.number(),
    minLauncherVersion: z.string(),
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
