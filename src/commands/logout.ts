import { resolveBackend } from '../core/backend'
import { logout } from '../core/auth'
import { info } from '../core/log'

export async function logoutCommand(opts: { backendUrl?: string }): Promise<void> {
  const { host } = resolveBackend(opts.backendUrl)
  logout(host)
  info(`Logged out of ${host}.`)
}
