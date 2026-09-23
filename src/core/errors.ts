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
