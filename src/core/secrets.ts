import { Entry } from '@napi-rs/keyring'

// Token lives in the OS keychain, keyed by backend host, so dev and prod
// tokens never mix and nothing lands on disk.
const SERVICE = 'mb-ai'

function entry(host: string): Entry {
  return new Entry(SERVICE, host)
}

export function getToken(host: string): string | null {
  try {
    return entry(host).getPassword()
  } catch {
    // keyring throws when the entry doesn't exist
    return null
  }
}

export function setToken(host: string, token: string): void {
  entry(host).setPassword(token)
}

export function clearToken(host: string): void {
  try {
    entry(host).deletePassword()
  } catch {
    // already absent
  }
}
