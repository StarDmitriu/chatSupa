'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import {
  CHUNK_LOAD_USER_MESSAGE,
  CHUNK_RELOAD_SESSION_KEY,
  isChunkLoadError,
  reloadPageWithCacheBust,
  scheduleChunkAutoReload,
} from '@/lib/chunkLoadRecovery'
import { logClientError } from '@/lib/clientErrorLog'

export default function CabinetError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    logClientError({
      message: error?.message ?? 'Unknown error',
      stack: error?.stack,
      digest: error?.digest,
      path: '/cabinet',
    })
  }, [error])

  const chunkError = isChunkLoadError(error?.message)
  useEffect(() => {
    if (!chunkError) return
    return scheduleChunkAutoReload(CHUNK_RELOAD_SESSION_KEY, 900)
  }, [chunkError])

  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        textAlign: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>
        Произошла ошибка в кабинете
      </h2>
      <p style={{ fontSize: 14, color: '#666', marginBottom: 16, maxWidth: 480 }}>
        {chunkError ? CHUNK_LOAD_USER_MESSAGE : error?.message || 'Неизвестная ошибка. Подробности записаны в лог.'}
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          type="button"
          onClick={chunkError ? reloadPageWithCacheBust : reset}
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
        <Link
          href="/cabinet"
          style={{
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 600,
            border: '1px solid #ccc',
            borderRadius: 8,
            background: '#f5f5f5',
            cursor: 'pointer',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          В кабинет
        </Link>
      </div>
    </div>
  )
}
