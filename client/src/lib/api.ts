const API_BASE = '/api'

/** Error carrying the server's machine-readable code, not just a message. */
export class ApiError extends Error {
  status: number
  code?: string
  retryAfterSeconds?: number
  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type AuthEvent = 'SESSION_REVOKED' | 'PASSWORD_CHANGE_REQUIRED'
const authListeners = new Set<(e: AuthEvent) => void>()

/** Subscribe to out-of-band auth transitions raised by any in-flight request. */
export function onAuthEvent(fn: (e: AuthEvent) => void): () => void {
  authListeners.add(fn)
  return () => authListeners.delete(fn)
}

function emitAuthEvent(e: AuthEvent) {
  for (const fn of authListeners) {
    try { fn(e) } catch { /* listener errors must not break the request */ }
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => ({} as any))
  const message = body.error || body.message || `HTTP ${res.status}`
  return new ApiError(message, res.status, body.code, body.retryAfterSeconds)
}

function handleAuthStatus(err: ApiError) {
  if (err.status === 401 && err.code === 'SESSION_REVOKED') {
    localStorage.removeItem('finbudget_token')
    emitAuthEvent('SESSION_REVOKED')
  } else if (err.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED') {
    emitAuthEvent('PASSWORD_CHANGE_REQUIRED')
  }
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('finbudget_token')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  })

  if (!res.ok) {
    const error = await toApiError(res)
    handleAuthStatus(error)
    throw error
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  get: <T>(endpoint: string) => request<T>(endpoint),
  post: <T>(endpoint: string, data?: unknown) =>
    request<T>(endpoint, { method: 'POST', body: JSON.stringify(data) }),
  put: <T>(endpoint: string, data?: unknown) =>
    request<T>(endpoint, { method: 'PUT', body: JSON.stringify(data) }),
  // DELETE carries a body for endpoints that take filters or an explicit
  // confirmation flag (see /transactions/bulk). The body is omitted entirely
  // when no data is passed, so ordinary deletes are unchanged.
  delete: <T>(endpoint: string, data?: unknown) =>
    request<T>(endpoint, {
      method: 'DELETE',
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
  upload: <T>(endpoint: string, formData: FormData) => {
    const token = localStorage.getItem('finbudget_token')
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers,
      body: formData,
    }).then(async res => {
      if (!res.ok) {
        const error = await toApiError(res)
        handleAuthStatus(error)
        throw error
      }
      return res.json() as Promise<T>
    })
  },
}
