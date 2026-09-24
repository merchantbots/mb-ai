// Typed errors → friendly messages + exit codes. index.ts catches MbError.

export class MbError extends Error {
  constructor(
    message: string,
    public code = 'MB_ERROR',
    public exitCode = 1,
  ) {
    super(message)
    this.name = 'MbError'
  }
}

/** No usable token for this backend (missing or expired — there is no refresh). */
export class NeedsLogin extends MbError {
  constructor(message = 'Not logged in.', public host?: string) {
    super(message, 'NEEDS_LOGIN', 3)
    this.name = 'NeedsLogin'
  }
}

/** A backend responded with the unified error envelope (or a FastAPI default). */
export class ApiError extends MbError {
  constructor(
    message: string,
    public apiCode: string,
    public status: number,
    public retryable = false,
    /** `x-trace-id` (or the envelope's traceId) — the handle the backend team greps by. */
    public traceId?: string,
    /** The exact response body, verbatim — surfaced for the user to hand to the tech team. */
    public raw?: string,
  ) {
    super(message, apiCode, 1)
    this.name = 'ApiError'
  }

  /** One-line, user-facing: "<message> (HTTP <status>[, <code>][, trace <id>])". */
  detail(): string {
    const bits = [`HTTP ${this.status}`]
    if (this.apiCode && this.apiCode !== this.message) bits.push(this.apiCode)
    if (this.traceId) bits.push(`trace ${this.traceId}`)
    return `${this.message} (${bits.join(', ')})`
  }

  /** True for backend-side failures (5xx) — not something the user can fix locally. */
  get serverSide(): boolean {
    return this.status >= 500
  }
}

/**
 * A copy-pasteable failure report for the user to hand to the tech team: the one-line summary,
 * a plain-language "this is on the backend" note, and the backend's raw response body (which
 * carries the trace id and the server-side detail). Pretty-prints the body when it's JSON.
 */
export function backendReport(e: ApiError, action = 'continue'): string {
  const line = (label?: string) =>
    label ? `── ${label} ` + '─'.repeat(Math.max(4, 58 - label.length)) : '─'.repeat(62)
  const raw = e.raw?.trim()
  let body = raw || '(the backend sent no response body)'
  if (raw) {
    try {
      body = JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      // not JSON — share it verbatim
    }
  }
  return [
    ``,
    `✗ The backend returned an error, so mb-ai can't ${action}.`,
    `  ${e.detail()}`,
    ``,
    `  This is a problem on the backend, not on your machine. Please copy the block`,
    `  below and send it to the MerchantBots tech team so they can debug it:`,
    ``,
    line('backend response'),
    body,
    line(),
  ].join('\n')
}

// The API returns a unified error envelope on 4xx/5xx:
//   { code, type, message, statusCode, retryable, ... }
// except FastAPI's default auth rejection: { detail: "Not authenticated" }.
export async function parseError(res: Response): Promise<ApiError> {
  // Read the body as text first so we can keep it verbatim (parseError callers may surface it).
  const raw = await res.text().catch(() => '')
  let body: any = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    // non-JSON body — keep `raw` for the report, leave `body` null
  }
  const code: string =
    body?.code ?? (res.status === 401 ? 'AUTH_UNAUTHENTICATED' : `HTTP_${res.status}`)
  const message: string =
    body?.message ?? body?.detail ?? `Request failed (${res.status})`
  const retryable: boolean = body?.retryable ?? false
  // The unified envelope carries the trace id in the body; nginx/proxies may also add a header.
  const traceId = body?.traceId ?? body?.trace_id ?? res.headers.get('x-trace-id') ?? undefined
  return new ApiError(message, code, res.status, retryable, traceId, raw || undefined)
}
