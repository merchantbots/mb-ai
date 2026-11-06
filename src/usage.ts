import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { backendDir, claudeConfigPath, rateLimitsPath, usageStatePath } from './config'
import { VERSION } from './version'
import { info, debug } from './log'
import { c, sym } from './ui'

// We report the signed-in Claude account's weekly rate-limit usage to the backend, which stores it
// as a time series and plots it per account. Best-effort telemetry: it only reads files, never
// throws into the launch, and never blocks a session. There is NO opt-out. How often it POSTs is
// set system-wide by the backend (`profile.usage.reportIntervalMs`), never by a local knob.
//
// Two sources:
// - Identity: Claude's global config (`~/.claude.json` → `oauthAccount`) — who is signed in.
// - Limits: the rate-limits file (`rateLimitsPath()`). The harness status line (served by the
//   backend in the profile's settings) receives Claude's live `rate_limits` on every render —
//   Claude refreshes them from the API's rate-limit headers on every reply — and writes
//   `{observedAt, accountUuid, rateLimits}` there when the launcher sets MB_AI_RATE_LIMITS_FILE.
//   A reading is only reported under the account it was stamped with.
//
// Why not `~/.claude.json → cachedUsageUtilization` (the 0.9.0 source)? Claude rewrites that cache
// only when someone opens the /usage screen, so it sat days to weeks stale while launchers kept
// re-reporting it (prod, 2026-11-06: freshest readings 7–25 days old). Claude has also dropped the
// 5-hour "session" window; the 7-day "weekly" window is the only one left, so it's all we send.

/** Fallback when the backend profile doesn't pin an interval — report at most once per account/2h. */
export const DEFAULT_REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000

/** How often a running session checks whether a report is due. */
const TICK_MS = 60_000
const REPORT_TIMEOUT_MS = 5_000
/** Short, so a slow backend never holds up the shell after claude exits. */
const EXIT_REPORT_TIMEOUT_MS = 2_000

export interface LimitWindow {
  /** % of the window used, 0–100, rounded. */
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
  // The account's latest live reading; absent until a session has recorded one for this account.
  limits?: {
    /** When Claude observed these numbers (ISO) — how fresh the sample is. */
    fetchedAt?: string
    sevenDay?: LimitWindow
    /** The status line's `rate_limits` object, passed through verbatim for fidelity. */
    utilization?: Record<string, unknown>
  }
}

/** Where and how often to report — fixed for one launch. */
export interface UsageReporting {
  backendUrl: string
  host: string
  token: string
  intervalMs: number
}

// ── Tiny defensive readers (Claude and the status line own these shapes; a change must never throw)
function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)
function msToIso(ms: unknown): string | undefined {
  if (typeof ms !== 'number') return undefined
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** One status-line window (`used_percentage`, `resets_at` in epoch seconds) → the report shape. */
function limitWindow(w: any): LimitWindow | undefined {
  if (!w || typeof w !== 'object') return undefined
  return {
    utilization: typeof w.used_percentage === 'number' ? Math.round(w.used_percentage) : null,
    resetsAt: typeof w.resets_at === 'number' ? (msToIso(w.resets_at * 1000) ?? null) : null,
  }
}

/** The recorded live reading, if it belongs to `accountUuid` (never another account's numbers). */
function liveLimits(accountUuid: string | undefined): UsageSnapshot['limits'] {
  const live = readJson(rateLimitsPath())
  if (!accountUuid || !live || typeof live !== 'object' || live.accountUuid !== accountUuid) return
  const rateLimits = live.rateLimits
  if (!rateLimits || typeof rateLimits !== 'object') return
  return {
    fetchedAt: msToIso(live.observedAt),
    sevenDay: limitWindow(rateLimits.seven_day),
    utilization: rateLimits,
  }
}

/**
 * Read the signed-in account and its latest live reading — pure, no network. Returns null when
 * nobody is signed into Claude (no account to attribute) or Claude's config can't be read.
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
  const limits = liveLimits(accountUuid)
  if (limits) snap.limits = limits
  return snap
}

/** True while the reading's week is still running — after the reset its % no longer applies. */
export function isCurrentWeek(week: LimitWindow | undefined): week is LimitWindow & { utilization: number } {
  if (typeof week?.utilization !== 'number') return false
  return !week.resetsAt || Date.parse(week.resetsAt) > Date.now()
}

/** A one-line, dimmed summary for the terminal — the current account and its weekly usage. */
export function summarize(snap: UsageSnapshot): string {
  const who = snap.email ?? snap.accountUuid ?? 'unknown account'
  const week = snap.limits?.sevenDay
  const tail = isCurrentWeek(week) ? `  weekly ${week.utilization}%` : ''
  return `${sym.bullet} ${c.dim(`usage · ${who}${tail}`)}`
}

// ── Throttle state (per account, per backend) ─────────────────────────────────────────────────
interface ReportState {
  lastReportedAt?: number
  /** `observedAt` of the newest reading we've sent — the exit report only sends a newer one. */
  lastObservedAt?: number
}

function readState(host: string): Record<string, ReportState> {
  const state = readJson(usageStatePath(host))
  return state && typeof state === 'object' ? state : {}
}

/** Record an *attempt* (success or failure) so we try at most once per interval — the respectful read. */
function recordReport(host: string, key: string, observedAt: number | undefined): void {
  try {
    mkdirSync(backendDir(host), { recursive: true })
    const state = readState(host)
    state[key] = { lastReportedAt: Date.now(), lastObservedAt: observedAt ?? state[key]?.lastObservedAt }
    writeFileSync(usageStatePath(host), JSON.stringify(state))
  } catch {
    // Can't persist the throttle → worst case we report again next time. Not worth failing over.
  }
}

async function postUsage(r: UsageReporting, snap: UsageSnapshot, timeoutMs: number): Promise<void> {
  const body = JSON.stringify({ reportedAt: new Date().toISOString(), launcherVersion: VERSION, ...snap })
  const res = await fetch(`${r.backendUrl}/api/v1/mb-harness/usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

type Trigger = 'launch' | 'tick' | 'exit'

/**
 * POST the snapshot if this trigger calls for it, and say whether it did.
 * - launch / tick: at most once per interval per account (this is also the "last seen" heartbeat).
 * - exit: only when Claude has a newer reading than the last one we sent — the session's final
 *   state — whatever the interval.
 * Throws on a failed POST; callers swallow it.
 */
async function reportIfDue(r: UsageReporting, snap: UsageSnapshot, trigger: Trigger): Promise<boolean> {
  const key = snap.accountUuid || snap.email!
  const last = readState(r.host)[key] ?? {}
  const observedAt = snap.limits?.fetchedAt ? Date.parse(snap.limits.fetchedAt) : undefined
  const due =
    trigger === 'exit'
      ? observedAt !== undefined && observedAt > (last.lastObservedAt ?? 0)
      : Date.now() - (last.lastReportedAt ?? 0) >= r.intervalMs
  if (!due) return false
  // Record the attempt up front: at most one POST per interval even if it hangs or fails.
  recordReport(r.host, key, observedAt)
  await postUsage(r, snap, trigger === 'exit' ? EXIT_REPORT_TIMEOUT_MS : REPORT_TIMEOUT_MS)
  return true
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Launch: show the signed-in account's usage and report it if due. Never throws, never blocks a
 * launch. The one-line summary prints every launch (local read, no network).
 */
export async function reportUsage(r: UsageReporting): Promise<void> {
  try {
    const snap = readLocalUsage()
    if (!snap) return
    info(summarize(snap))
    const reported = await reportIfDue(r, snap, 'launch')
    debug(reported ? 'usage: reported' : 'usage: within throttle window — not reporting')
  } catch (e) {
    debug(`usage: skipped (${errMessage(e)})`)
  }
}

/**
 * While claude runs: check once a minute and report when the interval has passed. Silent — claude
 * owns the terminal. Returns `stop`, which ends the checks and sends the session's final reading
 * (the exit report). Never throws.
 */
export function startUsageReporter(r: UsageReporting): () => Promise<void> {
  const reportFromDisk = async (trigger: Trigger, log: (msg: string) => void) => {
    try {
      const snap = readLocalUsage()
      if (snap && (await reportIfDue(r, snap, trigger))) log(`usage: reported (${trigger})`)
    } catch (e) {
      log(`usage: skipped (${errMessage(e)})`)
    }
  }
  const silent = () => {}

  // Chain ticks so a slow POST never overlaps the next one (or the exit report).
  let inFlight = Promise.resolve()
  const timer = setInterval(() => {
    inFlight = inFlight.then(() => reportFromDisk('tick', silent))
  }, TICK_MS)
  timer.unref() // never keep the launcher alive on our account

  return async () => {
    clearInterval(timer)
    await inFlight
    await reportFromDisk('exit', debug)
  }
}
