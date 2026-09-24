import { resolveBackend } from '../config'
import { logout } from '../session'
import { info } from '../log'

export async function logoutCommand(opts: { backendUrl?: string }): Promise<void> {
  const { host } = resolveBackend(opts.backendUrl)
  logout(host)
  info(`Logged out of ${host}.`)
}
