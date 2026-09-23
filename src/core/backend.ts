import { MbError } from './errors'

// TODO(open item): real production URL. Dev is http://localhost:8000 (pass via --backend-url).
export const DEFAULT_BACKEND = 'https://api.mb.example.com'

export interface Backend {
  /** Base URL, no trailing slash. All paths are under `${url}/api/v1/...`. */
  url: string
  /** Host (incl. port) — used to namespace on-disk state and the keychain slot. */
  host: string
}

/**
 * Resolve which backend to talk to. One knob, highest wins:
 *   --backend-url flag  >  MB_AI_BACKEND_URL  >  baked-in prod default.
 */
export function resolveBackend(flag?: string): Backend {
  const raw = (flag || process.env.MB_AI_BACKEND_URL || DEFAULT_BACKEND).trim()
  const url = raw.replace(/\/+$/, '')
  let host: string
  try {
    host = new URL(url).host
  } catch {
    throw new MbError(`Invalid backend URL: ${raw}`, 'BAD_BACKEND_URL', 2)
  }
  return { url, host }
}
