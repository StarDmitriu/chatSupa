'use client'

import { useEffect } from 'react'
import { logClientError } from '@/lib/clientErrorLog'

export default function GroupsError({
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
      path: '/dashboard/groups',
    })
  }, [error])

  return (
    <div
      style={{
        minHeight: '50vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        textAlign: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>Ошибка на странице групп WhatsApp</h2>
      <p style={{ fontSize: 14, color: '#666', marginBottom: 16, maxWidth: 480 }}>
        {error?.message || 'Неизвестная ошибка.'}
      </p>
      <button
        type="button"
        onClick={() => reset()}
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
        Обновить страницу
      </button>
    </div>
  )
}
