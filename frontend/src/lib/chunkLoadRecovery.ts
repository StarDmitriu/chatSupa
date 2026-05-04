/**
 * Ошибки загрузки JS/CSS чанков после деплоя: старый HTML ссылается на удалённые файлы.
 * Стратегия: ограниченный авто-reload с cache-bust + понятный текст пользователю.
 */

/** Текст для UI (дашборд, кабинет, глобальные error boundaries). */
export const CHUNK_LOAD_USER_MESSAGE =
	'После обновления приложения могла загрузиться старая версия страницы. Мы попробуем обновить страницу автоматически.'

export const MAX_CHUNK_AUTO_RELOADS = 2

/** Общий ключ sessionStorage для всех авто-reload (error boundaries + глобальный перехват script/link). */
export const CHUNK_RELOAD_SESSION_KEY = '__chunk_reload_attempts_unified'

export function isChunkLoadError(message?: string): boolean {
	if (typeof message !== 'string') return false
	return (
		message.includes('Failed to load chunk') ||
		message.includes('Loading chunk') ||
		message.includes('ChunkLoadError') ||
		message.includes('Loading CSS chunk') ||
		message.includes('Failed to fetch dynamically imported module') ||
		message.includes('Importing a module script failed') ||
		message.includes('error loading dynamically imported module') ||
		/from module \d+/.test(message) ||
		/module \d+/.test(message)
	)
}

/** Полная перезагрузка с параметром, чтобы обойти кэш HTML/чанков. */
export function reloadPageWithCacheBust(): void {
	const url = new URL(window.location.href)
	url.searchParams.set('__t', String(Date.now()))
	window.location.replace(url.toString())
}

/**
 * Планирует один авто-reload при ошибке чанка.
 * Счётчик в `sessionStorage` увеличивается **только в колбэке таймера** (перед reload).
 * Иначе в React 18 Strict Mode (dev) первый `setTimeout` снимается cleanup'ом, а старый `useRef`
 * блокировал второй запуск — перезагрузка никогда не выполнялась.
 *
 * @returns функция отмены (передать в `return` эффекта).
 */
export function scheduleChunkAutoReload(sessionKey: string, delayMs = 900): () => void {
	const id = window.setTimeout(() => {
		try {
			const raw = sessionStorage.getItem(sessionKey)
			const prev = raw === null || raw === '' ? 0 : Number(raw)
			const n = Number.isFinite(prev) && prev >= 0 ? prev : 0
			if (n >= MAX_CHUNK_AUTO_RELOADS) return
			sessionStorage.setItem(sessionKey, String(n + 1))
			reloadPageWithCacheBust()
		} catch {
			reloadPageWithCacheBust()
		}
	}, delayMs)
	return () => window.clearTimeout(id)
}
