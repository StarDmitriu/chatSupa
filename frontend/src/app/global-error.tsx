'use client'

import { useEffect } from 'react'
import {
  CHUNK_LOAD_USER_MESSAGE,
  CHUNK_RELOAD_SESSION_KEY,
  isChunkLoadError,
  reloadPageWithCacheBust,
  scheduleChunkAutoReload,
} from '@/lib/chunkLoadRecovery'
import { logClientError } from '@/lib/clientErrorLog'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const chunkError = isChunkLoadError(error?.message)
  useEffect(() => {
    logClientError({
      message: error?.message ?? 'Unknown error',
      stack: error?.stack,
      digest: error?.digest,
    })
  }, [error])

  const msg = chunkError ? CHUNK_LOAD_USER_MESSAGE : error?.message || 'Неизвестная ошибка'

  useEffect(() => {
    if (!chunkError) return
    return scheduleChunkAutoReload(CHUNK_RELOAD_SESSION_KEY, 900)
  }, [chunkError])

  return (
    <html lang="ru">
      <head>
        <title>Ошибка</title>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Произошла ошибка</h2>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 16, maxWidth: 520 }}>
          {msg}
        </p>
        {!chunkError ? (
          <p style={{ fontSize: 12, color: '#999', marginBottom: 24 }}>
            Ошибка записана в лог. Откройте консоль браузера (F12) для подробностей.
          </p>
        ) : (
          <p style={{ fontSize: 12, color: '#999', marginBottom: 24 }}>
            Если страница не обновится сама, нажмите кнопку ниже.
          </p>
        )}
        <button
          type="button"
          onClick={() => (chunkError ? reloadPageWithCacheBust() : reset())}
          style={{
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 600,
            border: '1px solid #ccc',
            borderRadius: 8,
            background: '#f5f5f5',
            cursor: 'pointer',
          }}
        >
          {chunkError ? 'Обновить страницу' : 'Попробовать снова'}
        </button>
      </body>
    </html>
  )
}
