import { VERSION, PACKAGE_NAME } from '../version'
import { MbError } from './errors'

function parse(v: string): [number, number, number] {
  const core = v.trim().replace(/^v/, '').split('-')[0].split('+')[0]
  const [a, b, c] = core.split('.')
  return [Number(a) || 0, Number(b) || 0, Number(c) || 0]
}

/** True if `a` is a lower semver than `b` (compares major.minor.patch). */
export function semverLt(a: string, b: string): boolean {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true
    if (pa[i] > pb[i]) return false
  }
  return false
}

/**
 * Hard gate: refuse to run if the launcher is older than the backend's floor.
 * We do NOT self-update — the user is told exactly how and is responsible for it.
 */
export function assertLauncherVersion(minLauncherVersion: string): void {
  if (semverLt(VERSION, minLauncherVersion)) {
    throw new MbError(
      `mb-ai ${VERSION} is too old — this backend requires ${minLauncherVersion} or newer.\n` +
        `  Please update, then re-run:\n` +
        `    npm update -g ${PACKAGE_NAME}\n` +
        `  (or reinstall the latest: npm install -g ${PACKAGE_NAME}@latest)`,
      'LAUNCHER_TOO_OLD',
      2,
    )
  }
}
