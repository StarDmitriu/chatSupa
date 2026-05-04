/**
 * Логирование клиентских ошибок: в консоль и на бэкенд для разбора падений на других устройствах.
 */

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

export type ClientErrorPayload = {
  message: string
  stack?: string
  digest?: string
  path?: string
  url?: string
  userAgent?: string
}

export function logClientError(payload: ClientErrorPayload) {
  const { message, stack, digest, path, url, userAgent } = payload
  const safePayload = {
    message: String(message ?? 'unknown'),
    stack: stack ?? undefined,
    digest: digest ?? undefined,
    path: path ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
    url: url ?? (typeof window !== 'undefined' ? window.location.href : undefined),
    userAgent: userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : undefined),
  }

  console.error('[client-error]', safePayload.message, safePayload)
  if (safePayload.stack) console.error(safePayload.stack)

  if (typeof fetch !== 'undefined') {
    fetch(`${BACKEND_URL}/log-client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(safePayload),
      keepalive: true,
    }).catch(() => {})
  }
}
