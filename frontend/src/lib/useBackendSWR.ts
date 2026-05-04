'use client'

import useSWR, { type SWRConfiguration, type SWRResponse } from 'swr'
import Cookies from 'js-cookie'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
const DEFAULT_TIMEOUT_MS = 20_000

async function backendFetcher(path: string): Promise<unknown> {
  const token = Cookies.get('token')
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const url = `${BACKEND_URL}/${path.startsWith('/') ? path.slice(1) : path}`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const json = await res.json().catch(() => ({}))
    if (res.status === 401) {
      Cookies.remove('token')
      if (typeof window !== 'undefined') window.location.href = '/auth/phone'
      throw new Error('Unauthorized')
    }
    if (!res.ok) {
      throw new Error((json?.message as string) || res.statusText || 'Ошибка запроса')
    }
    return json
  } catch (e) {
    clearTimeout(timeoutId)
    throw e
  }
}

/**
 * Единый data-fetching для GET-запросов к бэкенду с авторизацией и редиректом при 401.
 * key — путь без ведущего слэша, например 'auth/me' или 'campaigns/active'.
 */
export function useBackendSWR<T = unknown>(
  key: string | null,
  config?: SWRConfiguration,
): SWRResponse<T> {
  const fetcher = async (url: string): Promise<T> => {
    const data = await backendFetcher(url.startsWith('/') ? url.slice(1) : url)
    return data as T
  }
  return useSWR<T>(key ?? null, key ? fetcher : null, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
    ...config,
  })
}
