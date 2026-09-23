import { execa } from 'execa'
import { resolveBackend } from '../core/backend'
import { getToken } from '../core/secrets'
import { expiresAt } from '../core/jwt'
import { VERSION } from '../version'

export async function doctorCommand(opts: { backendUrl?: string }): Promise<void> {
  const { url, host } = resolveBackend(opts.backendUrl)

  console.log(`mb-ai       ${VERSION}`)
  console.log(`backend     ${url}`)

  const envToken = process.env.MB_AI_TOKEN
  const token = envToken || getToken(host)
  const src = envToken ? '  (MB_AI_TOKEN)' : ''
  if (!token) {
    console.log('auth        not logged in  (run: mb-ai login)')
  } else {
    const exp = expiresAt(token)
    const days = exp ? Math.round((exp - Date.now()) / 86_400_000) : null
    console.log(`auth        logged in${days != null ? ` (~${days}d left)` : ''}${src}`)
  }

  let claudeLine = 'not found on PATH  (npm i -g @anthropic-ai/claude-code)'
  try {
    const { stdout } = await execa('claude', ['--version'])
    claudeLine = stdout.trim()
  } catch {
    // leave the not-found hint
  }
  console.log(`claude      ${claudeLine}`)
}
