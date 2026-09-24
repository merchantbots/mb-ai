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
  ) {
    super(message, apiCode, 1)
    this.name = 'ApiError'
  }
}

// The API returns a unified error envelope on 4xx/5xx:
//   { code, type, message, statusCode, retryable, ... }
// except FastAPI's default auth rejection: { detail: "Not authenticated" }.
export async function parseError(res: Response): Promise<ApiError> {
  let body: any = null
  try {
    body = await res.json()
  } catch {
    // non-JSON body
  }
  const code: string =
    body?.code ?? (res.status === 401 ? 'AUTH_UNAUTHENTICATED' : `HTTP_${res.status}`)
  const message: string =
    body?.message ?? body?.detail ?? `Request failed (${res.status})`
  const retryable: boolean = body?.retryable ?? false
  return new ApiError(message, code, res.status, retryable)
}
