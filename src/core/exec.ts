import { execa } from 'execa'
import type { Profile } from '../schema/profile'
import { MbError } from './errors'
import { debug } from './log'

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
