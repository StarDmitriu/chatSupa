import Cookies from 'js-cookie'

const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

const DEFAULT_TIMEOUT_MS = 20_000

function fetchWithTimeout(
	url: string,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
	return fetch(url, {
		...fetchInit,
		signal: controller.signal,
	}).finally(() => clearTimeout(timeoutId))
}

function isNetworkError(err: unknown): boolean {
	const e = err as { code?: string; name?: string }
	return (
		e?.code === 'ETIMEDOUT' ||
		e?.code === 'ECONNRESET' ||
		e?.code === 'ECONNREFUSED' ||
		e?.name === 'AbortError'
	)
}

/** Текст ошибки из тела ответа Nest (message строка или массив от class-validator). */
function messageFromErrorJson(json: Record<string, unknown>, fallback: string): string {
	const m = json?.message
	if (typeof m === 'string' && m.trim()) return m.trim()
	if (Array.isArray(m) && m.length) return m.map((x) => String(x)).join(' ')
	return fallback
}

export class ApiError extends Error {
	constructor(
		message: string,
		public code: string,
		public status?: number,
	) {
		super(message)
		this.name = 'ApiError'
	}
}

/** Сообщение для UI из catch: ApiError, Error или запасной текст. */
export function getApiErrorMessage(e: unknown, fallback: string): string {
	if (e instanceof ApiError) {
		const t = e.message?.trim()
		return t || fallback
	}
	if (e instanceof Error && e.message?.trim()) return e.message.trim()
	return fallback
}

export async function apiPost(
	path: string,
	body?: unknown,
	opts?: { timeoutMs?: number; headers?: Record<string, string> },
) {
	const token = Cookies.get('token')
	try {
		const res = await fetchWithTimeout(`${BACKEND_URL}${path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(opts?.headers ?? {}),
			},
			body: JSON.stringify(body ?? {}),
			timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		})
		const json = await res.json().catch(() => ({}))
		if (!res.ok) {
			if (res.status === 401) {
				Cookies.remove('token')
				if (typeof window !== 'undefined') window.location.href = '/auth/phone'
			}
			throw new ApiError(
				messageFromErrorJson(json as Record<string, unknown>, res.statusText || 'Ошибка запроса'),
				'HTTP',
				res.status,
			)
		}
		return json
	} catch (err) {
		if (err instanceof ApiError) throw err
		if (isNetworkError(err)) {
			throw new ApiError(
				'Таймаут или нет связи с сервером. Попробуйте позже.',
				(err as NodeJS.ErrnoException).code ?? 'NETWORK',
			)
		}
		throw err
	}
}

export async function apiPostForm(
	path: string,
	form: FormData,
	opts?: { timeoutMs?: number; headers?: Record<string, string> },
) {
	const token = Cookies.get('token')
	try {
		const res = await fetchWithTimeout(`${BACKEND_URL}${path}`, {
			method: 'POST',
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(opts?.headers ?? {}),
			},
			body: form,
			timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		})
		const json = await res.json().catch(() => ({}))
		if (!res.ok) {
			if (res.status === 401) {
				Cookies.remove('token')
				if (typeof window !== 'undefined') window.location.href = '/auth/phone'
			}
			throw new ApiError(
				messageFromErrorJson(json as Record<string, unknown>, res.statusText || 'Ошибка запроса'),
				'HTTP',
				res.status,
			)
		}
		return json
	} catch (err) {
		if (err instanceof ApiError) throw err
		if (isNetworkError(err)) {
			throw new ApiError(
				'Таймаут или нет связи с сервером. Попробуйте позже.',
				(err as NodeJS.ErrnoException).code ?? 'NETWORK',
			)
		}
		throw err
	}
}

export async function apiGet(path: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }) {
	const token = Cookies.get('token')
	try {
		const res = await fetchWithTimeout(`${BACKEND_URL}${path}`, {
			method: 'GET',
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(opts?.headers ?? {}),
			},
			cache: 'no-store',
			timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		})
		const json = await res.json().catch(() => ({}))
		if (!res.ok) {
			if (res.status === 401) {
				Cookies.remove('token')
				if (typeof window !== 'undefined') window.location.href = '/auth/phone'
			}
			throw new ApiError(
				messageFromErrorJson(json as Record<string, unknown>, res.statusText || 'Ошибка запроса'),
				'HTTP',
				res.status,
			)
		}
		return json
	} catch (err) {
		if (err instanceof ApiError) throw err
		if (isNetworkError(err)) {
			throw new ApiError(
				'Таймаут или нет связи с сервером. Попробуйте позже.',
				(err as NodeJS.ErrnoException).code ?? 'NETWORK',
			)
		}
		throw err
	}
}

/** Скачать файл (GET, ответ — бинарный; для бэкапа CSV) */
export async function apiDownload(
	path: string,
	opts?: { timeoutMs?: number },
): Promise<{ blob: Blob; filename: string }> {
	const token = Cookies.get('token')
	const res = await fetchWithTimeout(`${BACKEND_URL}${path}`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		cache: 'no-store',
		timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})
	if (res.status === 401) {
		Cookies.remove('token')
		if (typeof window !== 'undefined') window.location.href = '/auth/phone'
		throw new ApiError('Требуется авторизация', 'HTTP', 401)
	}
	if (!res.ok) {
		const json = await res.json().catch(() => ({}))
		throw new ApiError(
			messageFromErrorJson(json as Record<string, unknown>, res.statusText || 'Ошибка загрузки'),
			'HTTP',
			res.status,
		)
	}
	const blob = await res.blob()
	const disp = res.headers.get('Content-Disposition')
	const filename = disp?.match(/filename="?([^";]+)"?/)?.[1]?.trim() || 'download.csv'
	return { blob, filename }
}
