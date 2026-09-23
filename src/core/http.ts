import { ApiError } from './errors'

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
