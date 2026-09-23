import { z } from 'zod'

const McpServer = z
  .object({
    type: z.string(),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  })
  .passthrough()

// GET /api/v1/harness/profile body. `skills` is a DUMMY placeholder in v1 (ignored).
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
