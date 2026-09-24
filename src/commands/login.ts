import { input, password } from '@inquirer/prompts'
import { login } from '../core/auth'
import { resolveBackend } from '../core/backend'
import { NeedsLogin } from '../core/errors'
import { info, warn } from '../core/log'

/** Interactive login against a specific backend. Returns the fresh token. */
export async function doLogin(backendUrl: string, host: string): Promise<string> {
  // Only prompt when we actually can. Headless/CI (no TTY) must use MB_AI_TOKEN,
  // otherwise the auto-login path would hang waiting on a dead stdin.
  if (!process.stdin.isTTY) {
    throw new NeedsLogin(
      `Not logged in to ${host}, and there's no terminal to prompt.\n` +
        `  Headless/CI: set MB_AI_TOKEN=<jwt>. Otherwise run \`mb-ai login\` in an interactive shell.`,
      host,
    )
  }
  const email = await input({ message: 'MerchantBots email:' })
  const pass = await password({ message: 'Password:', mask: true })
  const { token, role } = await login(backendUrl, host, email, pass)
  info(`Logged in to ${host}${role ? ` as ${role}` : ''}.`)
  if (role && role !== 'platform') {
    warn(`Role "${role}" is not "platform" — the profile/MCP endpoints will refuse it.`)
  }
  return token
}

export async function loginCommand(opts: { backendUrl?: string }): Promise<void> {
  const { url, host } = resolveBackend(opts.backendUrl)
  await doLogin(url, host)
}
