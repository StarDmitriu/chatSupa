'use client'

import { useEffect, useRef } from 'react'
import {
	CHUNK_RELOAD_SESSION_KEY,
	isChunkLoadError,
	scheduleChunkAutoReload,
} from '@/lib/chunkLoadRecovery'

function isNextStaticAssetUrl(url: string): boolean {
	try {
		const u = new URL(url, window.location.origin)
		return (
			u.pathname.startsWith('/_next/static/') ||
			u.pathname.startsWith('/_next/image')
		)
	} catch {
		return false
	}
}

/**
 * Перехватывает ошибки загрузки script/link для `/_next/static/*` (404/500 в сети).
 * React error boundary не всегда получает такие сбои до гидрации.
 */
export function ChunkLoadRecoveryClient() {
	const scheduledRef = useRef(false)

	useEffect(() => {
		const schedule = () => {
			if (scheduledRef.current) return
			scheduledRef.current = true
			// Короткая задержка: при несовпадении чанков после деплоя нужна полная перезагрузка HTML.
			scheduleChunkAutoReload(CHUNK_RELOAD_SESSION_KEY, 450)
		}

		const onResourceError = (e: Event) => {
			const t = e.target
			if (!t) return
			const url =
				t instanceof HTMLScriptElement
					? t.src
					: t instanceof HTMLLinkElement
						? t.href
						: ''
			if (
				url &&
				isNextStaticAssetUrl(url) &&
				!scheduledRef.current
			) {
				schedule()
			}
		}

		// Иногда `ChunkLoadError` улетает как unhandled promise rejection (а не как Event на script/link),
		// поэтому ловим и это, чтобы автоматом перезагружать страницу.
		const onUnhandledRejection = (e: PromiseRejectionEvent) => {
			const reason = e.reason
			const msg =
				typeof (reason as any)?.message === 'string'
					? (reason as any).message
					: typeof reason === 'string'
						? reason
						: ''
			if (msg && isChunkLoadError(msg)) {
				schedule()
			}
		}

		// ChunkLoadError иногда приходит как ErrorEvent на window (без target=script).
		const onErrorEvent = (e: ErrorEvent) => {
			const fromErr = typeof e.error?.message === 'string' ? e.error.message : ''
			const fromMsg = typeof e.message === 'string' ? e.message : ''
			const combined = `${fromErr}\n${fromMsg}`.trim()
			if (combined && isChunkLoadError(combined)) {
				schedule()
			}
		}

		window.addEventListener('error', onResourceError, true)
		window.addEventListener('error', onErrorEvent)
		window.addEventListener('unhandledrejection', onUnhandledRejection)
		return () => {
			window.removeEventListener('error', onResourceError, true)
			window.removeEventListener('error', onErrorEvent)
			window.removeEventListener('unhandledrejection', onUnhandledRejection)
		}
	}, [])

	return null
}
