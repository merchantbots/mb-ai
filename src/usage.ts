import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { backendDir, claudeConfigPath, usageStatePath } from './config'
import { VERSION } from './version'
import { info, debug } from './log'
import { c, sym } from './ui'

// We report the *logged-in Claude account's* rate-limit usage to the backend so it can be stored as
// a time series (one row per sample) and plotted per email. Best-effort telemetry: it reads Claude
// Code's own on-disk state, never writes to it, and never throws into the launch — a broken read,
// a changed file shape, or a down backend must not stop a session. There is NO opt-out: usage
// tracking runs on every launch. How often it actually POSTs is set system-wide by the backend
// (`profile.usage.reportIntervalMs`), never by a local knob.
//
// Source: `~/.claude.json` → `oauthAccount` + `cachedUsageUtilization`. `oauthAccount` is the
// signed-in email/org; `cachedUsageUtilization` is the server's rate-limit view for THAT account —
// the 5-hour ("session") and 7-day ("weekly") utilization %, their reset times, and a per-surface
// breakdown. Claude refetches it on its own cadence (a few times a day, not every launch), so a
// sample is whatever Claude last saw. On an account switch the key is cleared to `null` — limits
// are simply omitted until the new account refetches.

/** Fallback when the backend profile doesn't pin an interval — report at most once per account/2h. */
export const DEFAULT_REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000

export interface LimitWindow {
  utilization: number | null
  resetsAt: string | null
}

export interface UsageSnapshot {
  machineId?: string
  // Identity — from oauthAccount. This is the "per email" key everything hangs off.
  email?: string
  accountUuid?: string
  organizationUuid?: string
  organizationName?: string
  organizationRole?: string
  rateLimitTier?: string
  // Rate-limit utilization for THIS account (from cachedUsageUtilization), or absent if unseen.
  limits?: {
    /** When Claude Code last fetched this from the server (ISO), i.e. how fresh the sample is. */
    fetchedAt?: string
    fiveHour?: LimitWindow
    sevenDay?: LimitWindow
    /** The full `utilization` object, passed through verbatim for fidelity (per-model, spend, …). */
    utilization?: Record<string, unknown>
  }
}

// ── Tiny defensive readers (Anthropic owns these shapes; a change must never throw) ───────────
function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)
const msToIso = (x: unknown): string | undefined =>
  typeof x === 'number' ? new Date(x).toISOString() : undefined

function limitWindow(w: any): LimitWindow | undefined {
  if (!w || typeof w !== 'object') return undefined
  return {
    utilization: typeof w.utilization === 'number' ? w.utilization : null,
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
  }
}

/**
 * Read Claude Code's local state into a normalized snapshot — pure, no network. Returns null when
 * nobody is signed into Claude (no account to attribute) or `~/.claude.json` can't be read.
 */
export function readLocalUsage(): UsageSnapshot | null {
  const cfg = readJson(claudeConfigPath())
  if (!cfg || typeof cfg !== 'object') return null

  const oauth = cfg.oauthAccount ?? {}
  const email = str(oauth.emailAddress)
  const accountUuid = str(oauth.accountUuid)
  if (!email && !accountUuid) return null // not logged into Claude → nothing to report

  const snap: UsageSnapshot = {
    machineId: str(cfg.machineID),
    email,
    accountUuid,
    organizationUuid: str(oauth.organizationUuid),
    organizationName: str(oauth.organizationName),
    organizationRole: str(oauth.organizationRole),
    rateLimitTier: str(oauth.organizationRateLimitTier),
  }

  // Only trust the cached limits if they belong to the signed-in account. On a switch Claude clears
  // this key to null and later repopulates it for the new account, so in practice it always matches
  // — this just guards against ever reporting one account's limits under another.
  const cu = cfg.cachedUsageUtilization
  const belongs =
    cu && typeof cu === 'object' && (!str(cu.accountUuid) || str(cu.accountUuid) === accountUuid)
  if (belongs) {
    const util = cu.utilization
    snap.limits = {
      fetchedAt: msToIso(cu.fetchedAtMs),
      fiveHour: limitWindow(util?.five_hour),
      sevenDay: limitWindow(util?.seven_day),
      utilization: util && typeof util === 'object' ? util : undefined,
    }
  }

  return snap
}

/** A one-line, dimmed summary for the terminal — shows the current account and its limit usage. */
export function summarize(snap: UsageSnapshot): string {
  const who = snap.email ?? snap.accountUuid ?? 'unknown account'
  const bits: string[] = []
  const f = snap.limits?.fiveHour?.utilization
  const w = snap.limits?.sevenDay?.utilization
  if (typeof f === 'number') bits.push(`session ${f}%`)
  if (typeof w === 'number') bits.push(`weekly ${w}%`)
  const tail = bits.length ? `  ${bits.join(' · ')}` : ''
  return `${sym.bullet} ${c.dim(`usage · ${who}${tail}`)}`
}

// ── Throttle state (per account, per backend) ─────────────────────────────────────────────────
function dueForReport(host: string, key: string, intervalMs: number): boolean {
  const last = readJson(usageStatePath(host))?.[key]?.lastReportedAt
  if (typeof last !== 'number') return true
  return Date.now() - last >= intervalMs
}

/** Record an *attempt* (success or failure) so we try at most once per interval — the respectful read. */
function markReported(host: string, key: string): void {
  try {
    mkdirSync(backendDir(host), { recursive: true })
    const state = readJson(usageStatePath(host)) ?? {}
    state[key] = { lastReportedAt: Date.now() }
    writeFileSync(usageStatePath(host), JSON.stringify(state))
  } catch {
    // Can't persist the throttle → worst case we report again next launch. Not worth failing over.
  }
}

async function postUsage(backendUrl: string, token: string, snap: UsageSnapshot): Promise<void> {
  const body = JSON.stringify({ reportedAt: new Date().toISOString(), launcherVersion: VERSION, ...snap })
  const res = await fetch(`${backendUrl}/api/v1/mb-harness/usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/**
 * Show the signed-in account's usage and (throttled) report it to the backend. Never throws and
 * never blocks a launch. The local one-line summary prints every launch; the POST happens at most
 * once per account per `intervalMs` — which the backend sets system-wide via
 * `profile.usage.reportIntervalMs` (falling back to DEFAULT_REPORT_INTERVAL_MS when unset).
 */
export async function reportUsage(
  backendUrl: string,
  host: string,
  token: string,
  intervalMs: number = DEFAULT_REPORT_INTERVAL_MS,
): Promise<void> {
  try {
    const snap = readLocalUsage()
    if (!snap) return
    info(summarize(snap)) // always surface the current snapshot locally (cheap, no network)

    const key = snap.accountUuid || snap.email!
    if (!dueForReport(host, key, intervalMs)) {
      debug('usage: within throttle window — not reporting')
      return
    }
    // Record the attempt up front: at most one POST per interval even if it hangs or fails.
    markReported(host, key)
    await postUsage(backendUrl, token, snap)
    debug('usage: reported')
  } catch (e) {
    debug(`usage: skipped (${e instanceof Error ? e.message : String(e)})`)
  }
}
