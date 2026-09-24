import { execa } from 'execa'
import { resolveBackend } from '../config'
import { tokenStatus } from '../session'
import { VERSION } from '../version'

export async function doctorCommand(opts: { backendUrl?: string }): Promise<void> {
  const { url, host } = resolveBackend(opts.backendUrl)

  console.log(`mb-ai       ${VERSION}`)
  console.log(`backend     ${url}`)

  const { token, source, expiresAt } = tokenStatus(host)
  if (!token) {
    console.log('auth        not logged in  (run: mb-ai login)')
  } else {
    const days = expiresAt ? Math.round((expiresAt - Date.now()) / 86_400_000) : null
    const src = source === 'env' ? '  (MB_AI_TOKEN)' : ''
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
