'use client'
import './WhatsappConnectBlock.css'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Cookies from 'js-cookie'
import { message } from 'antd'
import { QRCodeCanvas } from 'qrcode.react'
import { WhatsappLinkingSteps } from './WhatsappLinkingSteps'
import { ChannelIcon } from '@/components/ChannelIcon'
import { useNotify } from '@/ui/notify/notify'

const QR_MAX_SIZE = 220
const QR_MIN_SIZE = 160

type WhatsappStatus =
	| 'not_connected'
	| 'connecting'
	| 'pending_qr'
	| 'connected'
	| 'temporary_network_issue'
	| 'error'

interface StatusResponse {
	success: boolean
	status?: {
		status: WhatsappStatus
		qr?: string
		lastError?: string
		stateSinceAt?: string | null
		stateDurationSec?: number | null
		disconnectSinceAt?: string | null
		disconnectDurationSec?: number | null
		retryAttempt?: number
		retryMax?: number
		nextRetryAt?: string | null
		networkIssue?: boolean
		wsReachability?: 'unknown' | 'ok' | 'degraded' | 'down'
		wsLastCheckAt?: string | null
		wsRttMs?: number | null
		wsError?: string | null
	}
	message?: string
}

export function WhatsappConnectBlock({ userId }: { userId: string }) {
	const backendUrl =
		process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
	const notify = useNotify()

	const getAuthHeaders = (): Record<string, string> => {
		const token = typeof document !== 'undefined' ? Cookies.get('token') : ''
		return token ? { Authorization: `Bearer ${token}` } : {}
	}

	const [status, setStatus] = useState<WhatsappStatus>('not_connected')
	const [qr, setQr] = useState<string | null>(null)
	const [errorText, setErrorText] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [disconnecting, setDisconnecting] = useState(false)
	const [qrSize, setQrSize] = useState(QR_MAX_SIZE)
	const qrWrapRef = useRef<HTMLDivElement>(null)
	const [accountInfo, setAccountInfo] = useState<{
		wa_id?: string
		jid?: string
		connected?: boolean
	} | null>(null)
	const [accountAvatar, setAccountAvatar] = useState<string | null>(null)
	const prevStatusRef = useRef<WhatsappStatus>('not_connected')
	const syncTriggeredRef = useRef(false)
	const [campaignsPaused, setCampaignsPaused] = useState<boolean | null>(null)
	const [pauseLoading, setPauseLoading] = useState(false)
	const [initialCheckDone, setInitialCheckDone] = useState(false)
	const [syncInProgress, setSyncInProgress] = useState(false)
	const [retryAttempt, setRetryAttempt] = useState<number | null>(null)
	const [retryMax, setRetryMax] = useState<number | null>(null)
	const [nextRetryAt, setNextRetryAt] = useState<string | null>(null)
	const [stateSinceAt, setStateSinceAt] = useState<string | null>(null)
	const [stateDurationSec, setStateDurationSec] = useState<number | null>(null)
	const [disconnectSinceAt, setDisconnectSinceAt] = useState<string | null>(null)
	const [disconnectDurationSec, setDisconnectDurationSec] = useState<number | null>(null)
	const [retryNowMs, setRetryNowMs] = useState<number>(() => Date.now())
	const [networkIssue, setNetworkIssue] = useState(false)
	const [wsReachability, setWsReachability] = useState<'unknown' | 'ok' | 'degraded' | 'down'>('unknown')
	const [wsLastCheckAt, setWsLastCheckAt] = useState<string | null>(null)
	const [wsRttMs, setWsRttMs] = useState<number | null>(null)
	const [wsError, setWsError] = useState<string | null>(null)
	const [waActiveCampaignId, setWaActiveCampaignId] = useState<string | null>(null)
	const [globalIncident, setGlobalIncident] = useState<{ globalIssue: boolean; message: string | null } | null>(null)
	const [showAdvancedDiag, setShowAdvancedDiag] = useState(false)
	const [waRates5m, setWaRates5m] = useState<{
		sent: number
		failed: number
		failedExhausted: number
		updatedAt: string
	} | null>(null)
	const notConnectedStreakRef = useRef(0)
	const pollErrorStreakRef = useRef(0)
	const lastRatesFetchRef = useRef(0)

	// Плавная анимация изменения высоты блока (QR/ошибка/аккаунт/connected).
	const yellowOuterRef = useRef<HTMLDivElement | null>(null)
	const yellowInnerRef = useRef<HTMLDivElement | null>(null)
	const [yellowHeight, setYellowHeight] = useState(0)

	const measureYellowHeight = () => {
		const inner = yellowInnerRef.current
		if (!inner) return
		const next = inner.scrollHeight
		setYellowHeight(next)
	}

	const loadAccountAvatar = async () => {
		try {
			const res = await fetch(
				`${backendUrl}/whatsapp/account-avatar/${userId}?_=${Date.now()}`,
				{ cache: 'no-store', headers: { Pragma: 'no-cache', ...getAuthHeaders() } },
			)
			const data = await res.json().catch(() => ({}))
			if (data?.success && data?.url) {
				setAccountAvatar(data.url)
			} else {
				setAccountAvatar(null)
			}
		} catch {
			setAccountAvatar(null)
		}
	}


	// чтобы не плодить интервалы и не ловить "залипание"
	const pollRef = useRef<number | null>(null)

	// Адаптивный размер QR: не вылезает за контейнер на мобильных
	useLayoutEffect(() => {
		const el = qrWrapRef.current
		if (!el) return
		const update = () => {
			const w = el.clientWidth
			if (w > 0) {
				const size = Math.max(QR_MIN_SIZE, Math.min(QR_MAX_SIZE, w - 16))
				setQrSize(size)
			}
		}
		update()
		const ro = new ResizeObserver(update)
		ro.observe(el)
		return () => ro.disconnect()
	}, [status, qr])

	// Изменения статуса/контента -> измеряем и анимируем высоту контейнера.
	useLayoutEffect(() => {
		measureYellowHeight()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		status,
		qr,
		qrSize,
		errorText,
		initialCheckDone,
		accountAvatar,
		accountInfo?.wa_id,
		accountInfo?.jid,
		campaignsPaused,
		pauseLoading,
		disconnecting,
		syncInProgress,
	])

	const stopPolling = () => {
		if (pollRef.current) {
			window.clearInterval(pollRef.current)
			pollRef.current = null
		}
	}

	const applyStatus = (payload?: StatusResponse['status']) => {
		if (!payload) return
		const nextStatus = payload.status
		const hasQr = typeof payload.qr === 'string' && payload.qr.length > 0
		const hasHardError = !!(payload.lastError && String(payload.lastError).trim())

		// Не скрываем реальные разрывы соединения: статус должен обновляться сразу,
		// иначе UI выглядит "подключенным", когда канал уже упал.
		if (nextStatus !== 'not_connected') {
			notConnectedStreakRef.current = 0
		}

		setStatus(nextStatus)
		setRetryAttempt(
			typeof payload.retryAttempt === 'number' ? payload.retryAttempt : null,
		)
		setRetryMax(typeof payload.retryMax === 'number' ? payload.retryMax : null)
		setNextRetryAt(typeof payload.nextRetryAt === 'string' ? payload.nextRetryAt : null)
		setStateSinceAt(typeof payload.stateSinceAt === 'string' ? payload.stateSinceAt : null)
		setStateDurationSec(
			typeof payload.stateDurationSec === 'number' ? payload.stateDurationSec : null,
		)
		setDisconnectSinceAt(
			typeof payload.disconnectSinceAt === 'string' ? payload.disconnectSinceAt : null,
		)
		setDisconnectDurationSec(
			typeof payload.disconnectDurationSec === 'number'
				? payload.disconnectDurationSec
				: null,
		)
		setNetworkIssue(!!payload.networkIssue)
		setWsReachability(payload.wsReachability ?? 'unknown')
		setWsLastCheckAt(typeof payload.wsLastCheckAt === 'string' ? payload.wsLastCheckAt : null)
		setWsRttMs(typeof payload.wsRttMs === 'number' ? payload.wsRttMs : null)
		setWsError(typeof payload.wsError === 'string' ? payload.wsError : null)
		// Пока ждём QR, бэкенд может отдать pending_qr без поля qr в части ответов — не затираем последний код.
		setQr((prev) => {
			if (payload.qr) {
				// Тот же payload на каждом поллинге — не дёргаем canvas без нужды.
				return payload.qr === prev ? prev : payload.qr
			}
			if (nextStatus === 'pending_qr') return prev
			return null
		})

		if (nextStatus === 'temporary_network_issue') {
			setErrorText(
				payload.lastError ??
					'Соединение с WhatsApp потеряно, выполняется автоматическое переподключение.',
			)
		} else {
			setErrorText(payload.lastError ?? null)
		}

		// Поллинг не останавливаем: статус должен обновляться сам (в т.ч. после падений соединения).
		// Иначе UI "замирает" в connected/error и требует ручного refresh.
		if (payload.status === 'connected' || payload.status === 'error') {
			setLoading(false)
		}
		if (payload.status === 'not_connected') {
			setLoading(false)
		}

		// если увидели QR — тоже можно убрать "loading"
		if (payload.status === 'pending_qr' && payload.qr) {
			setLoading(false)
		}
	}

	const getNextRetryInSec = () => {
		if (!nextRetryAt) return null
		const ts = new Date(nextRetryAt).getTime()
		if (!Number.isFinite(ts)) return null
		const left = Math.ceil((ts - retryNowMs) / 1000)
		return left > 0 ? left : 0
	}

	// Для реального "секундного" отсчета ETA до следующего автоповтора.
	useEffect(() => {
		if (!nextRetryAt || status !== 'temporary_network_issue') return
		const timer = window.setInterval(() => setRetryNowMs(Date.now()), 1000)
		return () => window.clearInterval(timer)
	}, [nextRetryAt, status])

	const loadStatus = async () => {
		try {
			// ?_= предотвращает кэширование (важно для Safari/Mac)
			const res = await fetch(`${backendUrl}/whatsapp/status/${userId}?_=${Date.now()}`, {
				cache: 'no-store',
				headers: { Pragma: 'no-cache', ...getAuthHeaders() },
			})
			const data: StatusResponse | null = await res.json().catch(() => null)
			if (!res.ok || !data?.success) {
				pollErrorStreakRef.current += 1
				if (pollErrorStreakRef.current >= 3) {
					setErrorText('Временная нестабильность сети. Продолжаем проверку статуса…')
				}
				return
			}
			pollErrorStreakRef.current = 0
			if (errorText === 'Временная нестабильность сети. Продолжаем проверку статуса…') {
				setErrorText(null)
			}
			applyStatus(data.status)
			void fetch(`${backendUrl}/whatsapp/network-incident?_=${Date.now()}`, {
				cache: 'no-store',
				headers: { Pragma: 'no-cache', ...getAuthHeaders() },
			})
				.then((r) => r.json().catch(() => ({})))
				.then((d) => {
					if (d?.success === true) {
						setGlobalIncident({
							globalIssue: d.globalIssue === true,
							message: typeof d.message === 'string' ? d.message : null,
						})
					}
				})
				.catch(() => {})
			if (Date.now() - lastRatesFetchRef.current > 10_000) {
				lastRatesFetchRef.current = Date.now()
				void loadWaRates5m()
			}
		} catch (e) {
			// Не пугаем пользователя из-за одиночного сбоя запроса статуса.
			pollErrorStreakRef.current += 1
			if (pollErrorStreakRef.current >= 3) {
				setErrorText('Временная нестабильность сети. Продолжаем проверку статуса…')
			}
		}
	}

	const loadWaRates5m = async () => {
		try {
			let campaignId = waActiveCampaignId
			if (!campaignId) {
				const activeRes = await fetch(`${backendUrl}/campaigns/active/wa?_=${Date.now()}`, {
					cache: 'no-store',
					headers: { Pragma: 'no-cache', ...getAuthHeaders() },
				})
				const activeData = await activeRes.json().catch(() => ({}))
				const nextId = String(activeData?.active?.campaignId || '').trim()
				campaignId = nextId || null
				setWaActiveCampaignId(campaignId)
			}
			if (!campaignId) {
				setWaRates5m(null)
				return
			}
			const ratesRes = await fetch(
				`${backendUrl}/campaigns/${campaignId}/recent-outcomes?windowMin=5&_=${Date.now()}`,
				{
					cache: 'no-store',
					headers: { Pragma: 'no-cache', ...getAuthHeaders() },
				},
			)
			const ratesData = await ratesRes.json().catch(() => ({}))
			if (!ratesData?.success) return
			setWaRates5m({
				sent: Number(ratesData?.counts?.sent || 0),
				failed: Number(ratesData?.counts?.failed || 0),
				failedExhausted: Number(ratesData?.counts?.failedExhausted || 0),
				updatedAt: String(ratesData?.at || new Date().toISOString()),
			})
		} catch {
			// диагностика best-effort
		}
	}

	const loadAccountInfo = async () => {
		try {
			const res = await fetch(
				`${backendUrl}/whatsapp/account-info/${userId}?_=${Date.now()}`,
				{ cache: 'no-store', headers: { Pragma: 'no-cache', ...getAuthHeaders() } },
			)
			const data = await res.json().catch(() => ({}))
			if (!data?.success) return

			if (data.connected || data.wa_id || data.jid) {
				setAccountInfo({
					wa_id: data.wa_id,
					jid: data.jid,
					connected: data.connected,
				})
			} else {
				setAccountInfo(null)
			}
		} catch {
			// не критично для работы, можно игнорировать
		}
	}

	const switchedToNormalRef = useRef(false)
	const startPolling = (fastFirst = false) => {
		if (pollRef.current) return

		let pollCount = 0
		const fastInterval = 400
		const normalInterval = 1200
		// Дольше держим частый поллинг: QR + восстановление сессии на медленных клиентах/сетях.
		const fastPolls = 55 // ~22 с @ 400ms

		const tick = () => {
			loadStatus()
			pollCount += 1
			if (fastFirst && !switchedToNormalRef.current && pollCount >= fastPolls && pollRef.current) {
				switchedToNormalRef.current = true
				window.clearInterval(pollRef.current)
				pollRef.current = window.setInterval(tick, normalInterval)
			}
		}

		switchedToNormalRef.current = false
		pollRef.current = window.setInterval(
			tick,
			fastFirst ? fastInterval : normalInterval,
		)
	}

	const startConnect = async () => {
		setLoading(true)
		setErrorText(null)
		setQr(null)
		setStatus('connecting')

		try {
			const res = await fetch(`${backendUrl}/whatsapp/start`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getAuthHeaders(),
				},
				body: JSON.stringify({ userId }),
			})

			const data = await res.json().catch(() => ({}))
			// неважно что вернул start — дальше мы гарантированно обновим статус
		} catch (e) {
			setErrorText('Не удалось запустить подключение. Проверьте бэкенд.')
			setLoading(false)
			return;		}

		// Сразу запрашиваем статус и включаем частый поллинг, чтобы QR успел появиться (особенно Safari/Mac)
		await loadStatus()
		startPolling(true)
	}

	const disconnect = async (): Promise<boolean> => {
		if (disconnecting) return false
		setDisconnecting(true)
		setErrorText(null)
		try {
			const res = await fetch(`${backendUrl}/whatsapp/disconnect`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getAuthHeaders(),
				},
				body: JSON.stringify({
					userId,
					source: 'cabinet_whatsapp_connect_block',
				}),
			})
			const data = await res.json().catch(() => ({}))
			if (!res.ok || !data?.success) {
				setErrorText(
					data?.message
						? `Не удалось отключить WhatsApp: ${data.message}`
						: 'Не удалось отключить WhatsApp. Попробуйте ещё раз.',
				)
				return false
			}
			// Полный сброс: стопаем сокет, очищаем authDir на бэке и локальное состояние на фронте.
			stopPolling()
			setStatus('not_connected')
			setQr(null)
			setAccountInfo(null)
			setAccountAvatar(null)
			return true
		} catch (e) {
			setErrorText('Ошибка сети при отключении WhatsApp')
			return false
		} finally {
			setDisconnecting(false)
			setLoading(false)
		}
	}

	const softReset = async (): Promise<boolean> => {
		if (disconnecting) return false
		setDisconnecting(true)
		try {
			const res = await fetch(`${backendUrl}/whatsapp/reset`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getAuthHeaders(),
				},
				body: JSON.stringify({ userId }),
			})
			const data = await res.json().catch(() => ({}))
			if (!res.ok || !data?.success) return false

			stopPolling()
			setStatus('not_connected')
			setQr(null)
			setAccountInfo(null)
			setAccountAvatar(null)
			return true
		} catch {
			return false
		} finally {
			setDisconnecting(false)
			setLoading(false)
		}
	}

	// при открытии страницы — подгружаем статус и account-info вместе, чтобы не мигали 4 шага QR
	// при восстановлении сессии (пока не пришли wa_id/jid из creds).
	useEffect(() => {
		setInitialCheckDone(false)

		void Promise.all([loadStatus(), loadAccountInfo(), loadWaRates5m()])
			.then(() => {
				setInitialCheckDone(true)
				setTimeout(() => {
					loadStatus().then(() => startPolling(true))
				}, 200)
			})
			.catch(() => {
				setInitialCheckDone(true)
			})

		return () => stopPolling()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId])

	const loadPauseState = useCallback(() => {
		Promise.all([
			fetch(`${backendUrl}/campaigns/pause-state/wa`, {
				cache: 'no-store',
				headers: getAuthHeaders(),
			}).then((r) => r.json().catch(() => ({}))),
			fetch(`${backendUrl}/campaigns/active/wa?_=${Date.now()}`, {
				cache: 'no-store',
				headers: { Pragma: 'no-cache', ...getAuthHeaders() },
			}).then((r) => r.json().catch(() => ({}))),
		])
			.then(([pauseData, activeData]) => {
				if (pauseData?.success === true) setCampaignsPaused(!!pauseData.paused)
				const activeId = String(activeData?.active?.campaignId || '').trim()
				setWaActiveCampaignId(activeId || null)
			})
			.catch(() => {})
	}, [backendUrl])

	// Пока WA подключен, подтягиваем pause-state периодически, чтобы кнопка
	// "Пауза/Возобновить" не зависала в старом состоянии.
	useEffect(() => {
		if (status !== 'connected' && status !== 'temporary_network_issue' && status !== 'connecting') return
		loadPauseState()
		const timer = window.setInterval(loadPauseState, 5000)
		return () => window.clearInterval(timer)
	}, [status, loadPauseState])

	const togglePause = async () => {
		if (pauseLoading || campaignsPaused === null) return
		setPauseLoading(true)
		try {
			const res = await fetch(`${backendUrl}/campaigns/set-pause`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getAuthHeaders(),
				},
				body: JSON.stringify({ channel: 'wa', paused: !campaignsPaused }),
			})
			const data = await res.json().catch(() => ({}))
			if (data?.success === true) {
				setCampaignsPaused(!!data.paused)
			} else if (data?.message === 'subscription_expired' || data?.message === 'trial_expired' || data?.message === 'no_subscription') {
				message.error('Подписка истекла. Продлите подписку, чтобы возобновить рассылки.')
			} else if (data?.message) {
				message.error(data.message)
			}
		} finally {
			setPauseLoading(false)
		}
	}

	// Как только WhatsApp переходит в состояние connected,
	// обновляем данные аккаунта, аватар и один раз в фоне запускаем синхронизацию групп
	// (только при переходе из pending_qr/connecting, чтобы не дергать sync при каждом открытии ЛК).
	useEffect(() => {
		if (status === 'connected') {
		loadAccountInfo().catch(() => {})
		loadAccountAvatar().catch(() => {})

		const token = typeof document !== 'undefined' ? Cookies.get('token') : ''
		loadPauseState()

			const justConnected =
				prevStatusRef.current === 'pending_qr' || prevStatusRef.current === 'connecting'
			if (justConnected && !syncTriggeredRef.current) {
				syncTriggeredRef.current = true
				setSyncInProgress(true)
				notify('Синхронизация групп запущена', { type: 'info' })
				fetch(`${backendUrl}/whatsapp/sync-groups`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...getAuthHeaders(),
					},
					body: JSON.stringify({ userId }),
				})
					.then(async (res) => {
						const data = (await res.json().catch(() => ({} as { success?: boolean }))) as {
							success?: boolean
						}
						if (data?.success && typeof localStorage !== 'undefined') {
							try {
								localStorage.setItem(`wa_groups_last_sync_${userId}`, String(Date.now()))
							} catch {}
							notify('Синхронизация завершена', { type: 'success' })
						} else {
							notify('Синхронизация завершена с ошибкой', { type: 'error' })
						}
					})
					.catch(() => {
						notify('Синхронизация завершена с ошибкой', { type: 'error' })
					})
					.finally(() => setSyncInProgress(false))
			}
		}
		if (status === 'not_connected') {
			setAccountInfo(null)
			setAccountAvatar(null)
			syncTriggeredRef.current = false
			setSyncInProgress(false)
		}
		prevStatusRef.current = status
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status])

	// При переподключении / QR повторно — creds уже есть, подтягиваем номер/JID и аватар для UI.
	useEffect(() => {
		if (
			status === 'temporary_network_issue' ||
			status === 'connecting' ||
			status === 'pending_qr'
		) {
			void loadAccountInfo()
			void loadAccountAvatar()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status])

	// ----- UI -----
	const hasWaSessionHint = !!(accountInfo?.wa_id || accountInfo?.jid)
	// Временный обрыв 408 бывает только при уже сохранённой сессии — не показываем онбординг из 4 шагов.
	// «connecting» при первом входе без creds остаётся с полной инструкцией до появления wa_id/jid.
	const isReconnectUi =
		status === 'temporary_network_issue' ||
		(hasWaSessionHint && status === 'connecting')
	// Не показывать онбординг из 4 шагов, если сессия уже была (есть creds), а сейчас только QR / переподключение.
	const skipWhatsappLinkingSteps =
		isReconnectUi || (hasWaSessionHint && status === 'pending_qr')
	const showDisconnectWhileReconnecting =
		status === 'connected' ||
		isReconnectUi ||
		(hasWaSessionHint && (status === 'error' || status === 'pending_qr'))

	let rusStatus = ''
	if (status === 'pending_qr') rusStatus = 'Ожидание QR-кода'
	else if (status === 'connecting') rusStatus = 'Подключаем…'
	else if (status === 'connected') rusStatus = 'Готов к работе'
	else if (status === 'temporary_network_issue') rusStatus = 'Соединение потеряно, переподключаемся…'
	else if (status === 'error') rusStatus = 'Ошибка'
	else rusStatus = 'Не подключено'

	const effectiveRusStatus = initialCheckDone ? rusStatus : 'Проверяем подключение…'
	const wsProbeLabel =
		wsReachability === 'down'
			? 'down'
			: wsReachability === 'degraded'
				? 'degraded'
				: wsReachability === 'ok'
					? 'ok'
					: 'unknown'
	// Зонд — только HEAD к https://web.whatsapp.com/, не тот же канал, что WebSocket чата Baileys.
	const wsProbeText =
		wsReachability === 'down'
			? 'нет ответа от web.whatsapp.com (лёгкая проверка), идёт автовосстановление'
			: wsReachability === 'degraded'
				? 'ответ от web.whatsapp.com медленный, возможны обрывы сокета чата'
				: wsReachability === 'ok'
					? 'маршрут до web.whatsapp.com доступен (не равно «сокет чата уже поднят»)'
					: 'проверяем доступность web.whatsapp.com'

	const isConflictError =
		(errorText || '').toLowerCase().includes('конфликт') ||
		(errorText || '').toLowerCase().includes('связанн') ||
		(errorText || '').toLowerCase().includes('connection replaced')

	let yellowContent: React.ReactNode = null
			/*<p style={{ marginTop: 8, marginBottom: 0 }}>
					Теперь сервис может отправлять сообщения от вашего имени.
				</p>*/
	if (status === 'connected') {
		yellowContent = null
	} else if (status === 'pending_qr') {
		if (!initialCheckDone) yellowContent = null
		else
		yellowContent = (
			<div className='wa-center'>
				<p className='wa-lead'>
					Отсканируйте QR‑код в WhatsApp.
				</p>
				{qr ? (
					<div ref={qrWrapRef} className="wa-qr-wrap" aria-hidden="true">
						<QRCodeCanvas value={qr} size={qrSize} />
					</div>
				) : (
					<div className="wa-qr-placeholder" aria-live="polite">
						Генерируем QR-код… Не закрывайте страницу.
					</div>
				)}
			</div>
		)
	} else if (status === 'connecting') {
		if (!initialCheckDone) yellowContent = null
		else
		yellowContent = hasWaSessionHint ? (
			<div className='wa-center'>
				<strong>Восстанавливаем сессию WhatsApp…</strong>
				<div className='wa-subhint'>
					Сессия уже была привязана — QR-код обычно не нужен. Не закрывайте страницу.
				</div>
			</div>
		) : (
			<div className='wa-center'>
				<strong>Запускаем подключение…</strong>
				<div className='wa-subhint'>Через несколько секунд появится QR‑код — не закрывайте страницу.</div>
			</div>
		)
	} else if (status === 'error') {
		if (!initialCheckDone) yellowContent = null
		else
		yellowContent = (
			<div className='wa-center'>
				<div>Не удалось подключиться. Попробуйте ещё раз.</div>
				<button className='wa-actionBtn' onClick={startConnect} disabled={loading || disconnecting}>
					{loading ? 'Запуск…' : 'Сканировать QR‑код ещё раз'}
				</button>
			</div>
		)
	} else if (status === 'temporary_network_issue') {
		if (!initialCheckDone) yellowContent = null
		else
			{
			const leftSec = getNextRetryInSec()
			const attemptText =
				typeof retryAttempt === 'number' && typeof retryMax === 'number'
					? ` Попытка восстановления ${Math.max(1, retryAttempt)} из ${Math.max(1, retryMax)}.`
					: ''
			const reconnectHint =
				globalIncident?.globalIssue
					? 'Сейчас это общая проблема связи с WhatsApp. Мы уже переподключаемся автоматически.'
					: 'Соединение с WhatsApp потеряно. Восстановление выполняется автоматически.'
			yellowContent = (
				<div className='wa-center'>
					<strong>
						<span className='syncInline'>
							<span className='syncInline__spinner' aria-hidden />
							Переподключаемся…
						</span>
					</strong>
					<div className='wa-subhint'>
						{reconnectHint}
						{attemptText}
						{leftSec !== null ? ` Следующая проверка через ${leftSec} сек.` : ''}
					</div>
				</div>
			)
			}
	} else {
		// not_connected
		yellowContent = initialCheckDone ? (
			<div className='wa-center'>
				<div>Сканируйте QR‑код, чтобы подключить аккаунт.</div>
				<button className='wa-actionBtn' onClick={startConnect} disabled={loading || disconnecting}>
					{loading ? 'Запуск…' : 'Сканировать QR‑код'}
				</button>
			</div>
		) : null
	}

	const formatWaNumber = (waId?: string) => {
		const raw = (waId || '').trim()
		if (!raw) return '—'
		const base = raw.split(':')[0]
		return base.startsWith('+') ? base : `+${base}`
	}
	const formatDuration = (sec: number | null) => {
		if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—'
		const h = Math.floor(sec / 3600)
		const m = Math.floor((sec % 3600) / 60)
		const s = sec % 60
		if (h > 0) return `${h}ч ${m}м ${s}с`
		if (m > 0) return `${m}м ${s}с`
		return `${s}с`
	}

	return (
		<div className={`wa ${status === 'connected' ? 'wa--connected' : 'wa--disconnected'}`}>
			{initialCheckDone ? (
				status === 'connected' ? (
					<p className='wa-text wa-text--connected'>
						Канал активен. Можно отключить в любой момент.
					</p>
				) : skipWhatsappLinkingSteps ? (
					<p className='wa-text'>
						{status === 'pending_qr' && hasWaSessionHint ? (
							<>
								Аккаунт уже привязывали — отсканируйте новый QR-код ниже. Пошаговая инструкция из четырёх
								пунктов для первого подключения сейчас не нужна.
							</>
						) : (
							<>
								Чтобы сервис мог отправлять рассылки от вашего имени, восстанавливаем связь с уже
								привязанным WhatsApp-аккаунтом (ниже). Это не новое подключение — шаги со сканированием
								QR в этом случае не нужны.
							</>
						)}
					</p>
				) : (
					<>
						<p className='wa-text'>
							Чтобы сервис мог отправлять рассылки от вашего имени, подключите ваш
							WhatsApp-аккаунт через QR-код.
						</p>
						<div className='instruction'>
							<WhatsappLinkingSteps />
						</div>
					</>
				)
			) : null}

			<div
				className='yellowContent-cont'
				ref={yellowOuterRef}
				style={{ height: yellowHeight }}
			>
				<div
					className='yellowContent-inner'
					ref={yellowInnerRef}
				>
					<div className='yellowContent'>
					<div className='chanHead'>
						<div className='chanHead__left'>
							<span className='chanHead__logo' aria-hidden>
								<ChannelIcon type='wa' size={28} />
							</span>
							<div className='chanHead__texts'>
								<h2 className='chanHead__title'>WhatsApp</h2>
								<p className='chanHead__subtitle'>
									{syncInProgress ? (
										<span className='syncInline'>
											<span className='syncInline__spinner' aria-hidden />
											Синхронизируем группы…
										</span>
									) : (
										effectiveRusStatus
									)}
								</p>
								{(status === 'temporary_network_issue' || status === 'connecting') && (
									<div className='wa-diag'>
										<span className='wa-diag__badge is-down'>
											{globalIncident?.globalIssue ? 'Общая проблема сети' : 'Идёт восстановление'}
										</span>
										<span className='wa-diag__text'>
											{globalIncident?.globalIssue
												? (globalIncident.message || 'Есть общий сбой связи с WhatsApp, переподключение уже выполняется автоматически.')
												: 'Связь с WhatsApp временно нестабильна, переподключение выполняется автоматически.'}
										</span>
									</div>
								)}
								{(status === 'temporary_network_issue' || status === 'connecting' || status === 'not_connected' || status === 'error') && (
									<div className='wa-diag'>
										<span className='wa-diag__badge is-down'>
											Разрыв: {formatDuration(disconnectDurationSec ?? stateDurationSec)}
										</span>
										<span className='wa-diag__text'>
											{disconnectSinceAt || stateSinceAt
												? `с ${new Date(disconnectSinceAt ?? stateSinceAt!).toLocaleTimeString('ru-RU')}`
												: 'время начала разрыва уточняется'}
											{typeof retryAttempt === 'number' && typeof retryMax === 'number'
												? ` · попытка ${Math.max(1, retryAttempt)}/${Math.max(1, retryMax)}`
												: ''}
											{waActiveCampaignId
												? campaignsPaused === true
													? ' · рассылка: на паузе'
													: campaignsPaused === false
														? ' · активная рассылка есть: новые попытки отправки переносятся автоматически до восстановления связи'
														: ' · активная рассылка: состояние уточняется'
												: ' · активной рассылки сейчас нет'}
										</span>
									</div>
								)}
								{(networkIssue || globalIncident?.globalIssue || status === 'temporary_network_issue') && (
									<button
										type='button'
										className='wa-moreBtn'
										onClick={() => setShowAdvancedDiag((v) => !v)}
									>
										{showAdvancedDiag ? 'Скрыть детали' : 'Подробнее'}
									</button>
								)}
								{showAdvancedDiag && networkIssue && !globalIncident?.globalIssue && (
									<div className='wa-diag'>
										<span className={`wa-diag__badge is-${wsProbeLabel}`}>
											До web.whatsapp.com: {wsProbeLabel}
										</span>
										<span className='wa-diag__text'>
											{wsProbeText}
											{typeof wsRttMs === 'number' ? `, RTT ${wsRttMs}ms` : ''}
											{wsLastCheckAt
												? `, check ${new Date(wsLastCheckAt).toLocaleTimeString('ru-RU')}`
												: ''}
										</span>
									</div>
								)}
								{showAdvancedDiag && waRates5m && (
									<div className='wa-diag'>
										<span className='wa-diag__badge is-ok'>
											sent_per_5m: {waRates5m.sent}
										</span>
										<span className='wa-diag__text'>
											failed_per_5m: {waRates5m.failed}
											{waRates5m.failedExhausted > 0
												? ` (wa_exhausted: ${waRates5m.failedExhausted})`
												: ''}
											{waRates5m.updatedAt
												? `, update ${new Date(waRates5m.updatedAt).toLocaleTimeString('ru-RU')}`
												: ''}
										</span>
									</div>
								)}
							</div>
						</div>
						{showDisconnectWhileReconnecting ? (
							<div className='chanHead__actions'>
								{status === 'connected' && campaignsPaused !== null && (
									<button
										type='button'
										className={`wa-actionBtn ${campaignsPaused ? 'wa-actionBtn--play' : 'wa-actionBtn--pause'}`}
										onClick={togglePause}
										disabled={pauseLoading}
										title={campaignsPaused ? 'Продолжить рассылки' : 'Приостановить рассылки WhatsApp'}
									>
										{pauseLoading
											? '…'
											: campaignsPaused
												? '▶ Продолжить рассылки'
												: '⏸ Приостановить рассылки'}
									</button>
								)}
								<button
									className='wa-actionBtn'
									onClick={disconnect}
									disabled={disconnecting}
									title={
										isReconnectUi || (hasWaSessionHint && status === 'pending_qr')
											? 'Полностью отвязать WhatsApp и очистить сессию'
											: undefined
									}
								>
									{disconnecting ? 'Отключаем…' : 'Отключить'}
								</button>
							</div>
						) : null}
					</div>
					{errorText ? (
						<div className='wa-error'>
							<div>{errorText}</div>
							{isConflictError && (
								<div className='wa-errorActions'>
									<div className='wa-subhint' style={{ marginTop: 0 }}>
										Если QR не появляется после «Сканировать QR‑код», очистите локальную сессию.
									</div>
									<button
										className='wa-actionBtn wa-actionBtn--danger'
										onClick={softReset}
										disabled={loading || disconnecting}
									>
										{disconnecting ? 'Очищаем…' : 'Очистить сессию'}
									</button>
								</div>
							)}
						</div>
					) : null}
					{yellowContent}
					{(status === 'connected' ||
						isReconnectUi ||
						(hasWaSessionHint && status === 'pending_qr')) &&
						(hasWaSessionHint ? (
							<div className='wa-account'>
								<div className='wa-account__row'>
									<div
										className={`wa-account__avatar${accountAvatar ? '' : ' wa-account__avatar--neutral'}`}
										aria-hidden
									>
										{accountAvatar ? (
											<img
												src={accountAvatar}
												alt=''
												className='wa-account__avatarImg'
												onError={() => setAccountAvatar(null)}
											/>
										) : null}
									</div>
									<div className='wa-account__info'>
										<div className='wa-accountTitle'>
											{isReconnectUi
												? 'Восстанавливаем сессию для аккаунта'
												: status === 'pending_qr' && hasWaSessionHint
													? 'Аккаунт, к которому привязываем заново'
													: 'Подключённый аккаунт'}
										</div>
										{accountInfo!.wa_id && (
											<div className='wa-accountLine'>
												<span>Номер:</span> <span>{formatWaNumber(accountInfo!.wa_id)}</span>
											</div>
										)}
										{accountInfo!.jid && (
											<div className='wa-accountLine'>
												<span>JID:</span> <span><code>{accountInfo!.jid}</code></span>
											</div>
										)}
									</div>
								</div>
							</div>
						) : isReconnectUi ? (
							<div className='wa-account'>
								<div className='wa-account__row'>
									<div
										className='wa-account__avatar wa-account__avatar--neutral'
										aria-hidden
									/>
									<div className='wa-account__info'>
										<div className='wa-accountTitle'>Восстанавливаем сессию для аккаунта</div>
										<div className='wa-accountLine wa-subhint' style={{ marginTop: 4 }}>
											Загружаем номер привязанного аккаунта…
										</div>
									</div>
								</div>
							</div>
						) : null)}
					</div>
				</div>
			</div>
		</div>
	)
}
