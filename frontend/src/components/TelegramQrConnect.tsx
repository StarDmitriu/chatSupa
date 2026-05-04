'use client'
import './TelegramConnectBlock.css'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Cookies from 'js-cookie'
import { message } from 'antd'
import { QRCodeCanvas } from 'qrcode.react'
import { ChannelIcon } from '@/components/ChannelIcon'
import { useNotify } from '@/ui/notify/notify'

const QR_MAX_SIZE = 220
const QR_MIN_SIZE = 160

type TgQrStatus =
	| 'not_connected'
	| 'pending_qr'
	| 'awaiting_password'
	| 'connected'
	| 'error'

type QrStatusResp = {
	success: boolean
	status: TgQrStatus
	qr?: string | null
	expiresAt?: number | null
	lastError?: string | null
}

export function TelegramQrConnect({ userId }: { userId: string }) {
	const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
	const notify = useNotify()

	const getAuthHeaders = (): Record<string, string> => {
		const token = typeof document !== 'undefined' ? Cookies.get('token') : ''
		return token ? { Authorization: `Bearer ${token}` } : {}
	}

	const [status, setStatus] = useState<TgQrStatus>('not_connected')
	const [qr, setQr] = useState<string | null>(null)
	const [expiresAt, setExpiresAt] = useState<number | null>(null)
	const [errorText, setErrorText] = useState<string | null>(null)
	const [accountInfo, setAccountInfo] = useState<{
		id?: number
		username?: string | null
		first_name?: string
		last_name?: string | null
		phone?: string | null
		is_premium?: boolean
	} | null>(null)
	const [accountAvatar, setAccountAvatar] = useState<string | null>(null)
	const prevStatusRef = useRef<TgQrStatus>('not_connected')
	const syncTriggeredRef = useRef(false)
	const [campaignsPaused, setCampaignsPaused] = useState<boolean | null>(null)
	const loadPauseState = useCallback(() => {
		fetch(`${backendUrl}/campaigns/pause-state/tg`, {
			cache: 'no-store',
			headers: getAuthHeaders(),
		})
			.then((r) => r.json().catch(() => ({})))
			.then((d) => { if (d?.success === true) setCampaignsPaused(!!d.paused) })
			.catch(() => {})
	}, [backendUrl])

	useEffect(() => {
		if (status !== 'connected') return
		loadPauseState()
		const timer = window.setInterval(loadPauseState, 5000)
		return () => window.clearInterval(timer)
	}, [status, loadPauseState])

	const [pauseLoading, setPauseLoading] = useState(false)
	const [syncInProgress, setSyncInProgress] = useState(false)

	// Плавная анимация изменения высоты карточки (QR/ошибка/connected-блок).
	const yellowOuterRef = useRef<HTMLDivElement | null>(null)
	const yellowInnerRef = useRef<HTMLDivElement | null>(null)
	const [yellowHeight, setYellowHeight] = useState(0)

	const [password, setPassword] = useState('')
	const [loading, setLoading] = useState(false)
	const [qrSize, setQrSize] = useState(QR_MAX_SIZE)
	const qrWrapRef = useRef<HTMLDivElement>(null)

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

	const measureYellowHeight = () => {
		const inner = yellowInnerRef.current
		if (!inner) return
		setYellowHeight(inner.scrollHeight)
	}

	// Изменения статуса/контента -> измеряем и анимируем высоту контейнера.
	useLayoutEffect(() => {
		measureYellowHeight()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		status,
		qr,
		expiresAt,
		errorText,
		accountAvatar,
		accountInfo?.id,
		accountInfo?.username,
		syncInProgress,
		campaignsPaused,
		pauseLoading,
		loading,
		password,
	])

	const stopPolling = () => {
		if (pollRef.current) {
			window.clearInterval(pollRef.current)
			pollRef.current = null
		}
	}

	const switchedToNormalRef = useRef(false)
	const startPolling = (fastFirst = false) => {
		if (pollRef.current) return

		let pollCount = 0
		const fastInterval = 400
		const normalInterval = 1000
		const fastPolls = 20

		const tick = () => {
			loadStatus().catch(() => {})
			pollCount += 1
			if (fastFirst && !switchedToNormalRef.current && pollCount >= fastPolls && pollRef.current) {
				switchedToNormalRef.current = true
				window.clearInterval(pollRef.current)
				pollRef.current = window.setInterval(tick, normalInterval)
			}
		}

		switchedToNormalRef.current = false
		pollRef.current = window.setInterval(tick, fastFirst ? fastInterval : normalInterval)
	}

	const loadStatus = async () => {
		const res = await fetch(`${backendUrl}/telegram/qr/status/${userId}?_=${Date.now()}`, {
			cache: 'no-store',
			headers: { Pragma: 'no-cache', ...getAuthHeaders() },
		})
		const data: QrStatusResp = await res.json()

		if (!data?.success) return

		setStatus(data.status)
		setQr(data.qr ?? null)
		setExpiresAt(data.expiresAt ?? null)

		// lastError может быть "qr_expired_refreshing" или "2fa_required" и т.п.
		const le = data.lastError ?? null
		if (le === 'qr_expired_refreshing') {
			setErrorText('QR-код истёк — обновляем…')
		} else if (le === '2fa_required') {
			setErrorText(null) // это не ошибка, это шаг
		} else if (le === 'invalid_2fa_password') {
			setErrorText('Неверный облачный пароль')
		} else {
			setErrorText(le)
		}

		// стопаем поллинг только на connected/error
		if (data.status === 'connected' || data.status === 'error') {
			stopPolling()
			setLoading(false)
		}

		// если мы показываем QR — тоже снимаем loading
		if (data.status === 'pending_qr' && data.qr) {
			setLoading(false)
		}

		// если ждём пароль — снимаем loading, пусть вводят
		if (data.status === 'awaiting_password') {
			setLoading(false)
		}
	}

	const loadAccountInfo = async () => {
		try {
			const res = await fetch(
				`${backendUrl}/telegram/account-info/${userId}?_=${Date.now()}`,
				{ cache: 'no-store', headers: { Pragma: 'no-cache', ...getAuthHeaders() } },
			)
			const data = await res.json().catch(() => ({}))
			if (!data?.success) return

			const hasRealAccount = data.id != null || !!data.username

			// Если есть реальный аккаунт Telegram (id/username) — считаем, что подключено.
			if (hasRealAccount) {
				setAccountInfo({
					id: data.id,
					username: data.username ?? null,
					first_name: data.first_name,
					last_name: data.last_name ?? null,
					phone: data.phone ?? null,
					is_premium: data.is_premium ?? false,
				})
				setStatus('connected')
				return
			}

			// Если есть только номер телефона (фоллбэк из БД), показываем его,
			// но не меняем статус: считаем, что Telegram ещё не подключён.
			if (data.phone) {
				setAccountInfo({
					id: undefined,
					username: null,
					first_name: data.first_name,
					last_name: data.last_name ?? null,
					phone: data.phone ?? null,
					is_premium: false,
				})
				return
			}

			setAccountInfo(null)
		} catch {
			// тихо игнорируем, это вспомогательная информация
		}
	}

	const start = async () => {
		setLoading(true)
		setErrorText(null)
		setQr(null)
		setPassword('')

		try {
			await fetch(`${backendUrl}/telegram/qr/start`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getAuthHeaders(),
				},
				body: JSON.stringify({ userId }),
			})
		} catch {
			setErrorText('Не удалось запустить QR-подключение Telegram')
			setLoading(false)
			return;		}

		await loadStatus().catch(() => {})
		startPolling(true)
	}

	const confirmPassword = async () => {
		const pass = password.trim()
		if (!pass) return

		setLoading(true)
		setErrorText(null)

		try {
			const res = await fetch(`${backendUrl}/telegram/qr/confirm-password`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getAuthHeaders(),
				},
				body: JSON.stringify({ userId, password: pass }),
			})
			const data = await res.json().catch(() => ({}))

			if (!data?.success) {
				// бэк может вернуть message=invalid_2fa_password или текст ошибки
				if (data?.message === 'invalid_2fa_password') {
					setErrorText('Неверный облачный пароль')
				} else {
					setErrorText(data?.message || 'Не удалось подтвердить облачный пароль')
				}
				setLoading(false)
				return;			}

			setPassword('')
			await loadStatus().catch(() => {})
			startPolling()
		} catch {
			setErrorText('Ошибка сети при вводе облачного пароля')
		} finally {
			setLoading(false)
		}
	}

	const disconnect = async () => {
		setLoading(true)
		try {
			await fetch(`${backendUrl}/telegram/qr/disconnect`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getAuthHeaders(),
				},
				body: JSON.stringify({ userId }),
			})
		} catch {}
		await loadStatus().catch(() => {})
		setLoading(false)
	}

	const abort = async () => {
		setLoading(true)
		try {
			await fetch(`${backendUrl}/telegram/qr/abort`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getAuthHeaders(),
				},
				body: JSON.stringify({ userId }),
			})
		} catch {}
		await loadStatus().catch(() => {})
		setLoading(false)
	}

	/** Сбросить незавершённую попытку и начать заново */
	const abortAndRestart = async () => {
		setLoading(true)
		setErrorText(null)
		await abort()
		await start()
	}

	useEffect(() => {
		loadStatus()
			.then(() => startPolling())
			.catch(() => {})
		loadAccountInfo().catch(() => {})
		return () => stopPolling()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId])

	const loadAccountAvatar = async () => {
		try {
			const res = await fetch(
				`${backendUrl}/telegram/account-avatar/${userId}?_=${Date.now()}`,
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

	// Как только статус Telegram меняется на connected,
	// подтягиваем данные аккаунта, аватар и один раз в фоне синхронизируем группы
	// (только при переходе из pending_qr/awaiting_password, без лишних вызовов при каждом открытии ЛК).
	useEffect(() => {
		if (status === 'connected') {
			loadAccountInfo().catch(() => {})
			loadAccountAvatar().catch(() => {})

			loadPauseState()

			const justConnected =
				prevStatusRef.current === 'pending_qr' || prevStatusRef.current === 'awaiting_password'
			if (justConnected && !syncTriggeredRef.current) {
				syncTriggeredRef.current = true
				setSyncInProgress(true)
				notify('Синхронизация групп запущена', { type: 'info' })
				fetch(`${backendUrl}/telegram/sync-groups`, {
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
								localStorage.setItem(`tg_groups_last_sync_${userId}`, String(Date.now()))
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

	const hintExpires =
		expiresAt && status === 'pending_qr'
			? `QR истечёт через ${Math.max(
					1,
					Math.ceil((expiresAt - Date.now()) / 1000),
				)} сек.`
			: null

	let rusStatus = ''
	if (status === 'pending_qr') {
		rusStatus = 'Ожидание QR-кода'
	} else if (status === 'connected') {
		// чтобы не дублировать слово «Подключено» в нескольких местах,
		// здесь показываем более «смысловой» статус
		rusStatus = 'Готов к работе'
	} else if (status === 'not_connected') {
		rusStatus = 'Не подключен'
	} else if (status === 'awaiting_password') {
		// здесь показываем более короткий статус, а подробная подсказка ниже
		rusStatus = 'Ожидается ввод облачного пароля'
	}

	const formatTgPhone = (raw?: string | null) => {
		const s = (raw || '').trim()
		if (!s) return '—'
		return s.startsWith('+') ? s : `+${s}`
	}

	return (
			<div className={`tg ${status === 'connected' ? 'tg--connected' : 'tg--disconnected'}`}>
				<div className='yellowContent-cont' ref={yellowOuterRef} style={{ height: yellowHeight }}>
					<div className='yellowContent-inner' ref={yellowInnerRef}>
						<div className='yellowContent'>
						<div className='chanHead'>
							<div className='chanHead__left'>
								<span className='chanHead__logo' aria-hidden>
									<ChannelIcon type='tg' size={28} />
								</span>
								<div className='chanHead__texts'>
									<h2 className='chanHead__title'>Telegram</h2>
									<p className='chanHead__subtitle'>
										{syncInProgress ? (
											<span className='syncInline'>
												<span className='syncInline__spinner' aria-hidden />
												Синхронизируем группы…
											</span>
										) : (
											rusStatus
										)}
									</p>
								</div>
							</div>
							{status === 'connected' && (
								<div className='chanHead__actions'>
									{campaignsPaused !== null && (
										<button
											type='button'
											className={`tg-actionBtn ${campaignsPaused ? 'tg-actionBtn--play' : 'tg-actionBtn--pause'}`}
											onClick={async () => {
												if (pauseLoading || campaignsPaused === null) return
												setPauseLoading(true)
												const token = typeof document !== 'undefined' ? Cookies.get('token') : ''
												try {
													const res = await fetch(`${backendUrl}/campaigns/set-pause`, {
														method: 'POST',
														headers: {
															'Content-Type': 'application/json',
															...(token ? { Authorization: `Bearer ${token}` } : {}),
														},
														body: JSON.stringify({ channel: 'tg', paused: !campaignsPaused }),
													})
													const data = await res.json().catch(() => ({}))
													if (data?.success === true) setCampaignsPaused(!!data.paused)
													else if (data?.message === 'subscription_expired' || data?.message === 'trial_expired' || data?.message === 'no_subscription') message.error('Подписка истекла. Продлите подписку, чтобы возобновить рассылки.')
													else if (data?.message) message.error(data.message)
												} finally {
													setPauseLoading(false)
												}
											}}
											disabled={pauseLoading}
											title={campaignsPaused ? 'Продолжить рассылки' : 'Приостановить рассылки Telegram'}
										>
											{pauseLoading
												? '…'
												: campaignsPaused
													? '▶ Продолжить рассылки'
													: '⏸ Приостановить рассылки'}
										</button>
									)}
									<button
										className='tg-actionBtn'
										onClick={disconnect}
										disabled={loading}
									>
										Отключить
									</button>
								</div>
							)}
						</div>
						{errorText ? (
							<div className='tg-error'>{errorText}</div>
						) : null}

						{status === 'awaiting_password' ? (
							<div style={{ textAlign: 'center' }}>
								<p style={{ marginBottom: 4 }}>
									Введите облачный пароль Telegram (вы задавали его в Настройках → Конфиденциальность):
								</p>
								<p style={{ marginBottom: 8, fontSize: 12, opacity: 0.85 }}>
									Это отдельный постоянный пароль для входа в облако Telegram, не одноразовый код из приложения.
								</p>
								<input
									type='password'
									value={password}
									onChange={e => setPassword(e.target.value)}
									onKeyDown={e => {
										if (e.key === 'Enter' && password.trim().length >= 2 && !loading) {
											e.preventDefault()
											confirmPassword()
										}
									}}
									placeholder='Облачный пароль'
									style={{ padding: '10px 12px', width: 260, maxWidth: '90%' }}
								/>
								<div
									style={{
										marginTop: 10,
										display: 'flex',
										gap: 10,
										justifyContent: 'center',
										flexWrap: 'wrap',
									}}
								>
									<button
										onClick={confirmPassword}
										disabled={loading || password.trim().length < 2}
										style={{ padding: '10px 14px' }}
									>
										{loading ? 'Проверяем…' : 'Подтвердить'}
									</button>
									<button
										onClick={abortAndRestart}
										disabled={loading}
										style={{ padding: '10px 14px' }}
										title='Сбросить попытку и сгенерировать новый QR'
									>
										Начать заново
									</button>
									<button
										onClick={abort}
										disabled={loading}
										style={{ padding: '10px 14px', opacity: 0.85 }}
										title='Отменить подключение'
									>
										Отменить
									</button>
								</div>
							</div>
						) : status === 'pending_qr' ? (
							<div style={{ textAlign: 'center' }}>
								<p>
									Отсканируйте QR-код в Telegram:
									<br />
									Настройки → Устройства → Подключить устройство
								</p>

								{qr ? (
									<div ref={qrWrapRef} className="tg-qr-wrap" aria-hidden="true">
										<QRCodeCanvas value={qr} size={qrSize} />
									</div>
								) : (
									<div className="tg-qr-placeholder" aria-live="polite">
										Генерируем QR-код… Не закрывайте страницу.
									</div>
								)}

								<div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
									{hintExpires ??
										'Если QR обновится — он обновится автоматически.'}
								</div>

								<button
									onClick={start}
									disabled={loading}
									style={{ marginTop: 12 }}
								>
									{loading ? 'Обновляем…' : 'Обновить QR вручную'}
								</button>
							</div>
						) : status !== 'connected' ? (
							<div style={{ textAlign: 'center' }}>
								<button
									onClick={start}
									disabled={loading}
									style={{ padding: '10px 16px' }}
								>
									{loading ? 'Запуск…' : 'Подключить Telegram по QR'}
								</button>
								<div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
									Откройте Telegram на телефоне → Настройки → Устройства →
									Подключить устройство
								</div>
							</div>
						) : (
							accountInfo &&
							(accountInfo.id != null ||
								accountInfo.username ||
								accountInfo.first_name ||
								accountInfo.phone) && (
								<div className='tg-account'>
									<div className='tg-account__row'>
										{accountAvatar ? (
											<div className='tg-account__avatar'>
												<img
													src={accountAvatar}
													alt=''
													onError={() => setAccountAvatar(null)}
												/>
											</div>
										) : (
											<div
												className='tg-account__logo'
												aria-hidden
												title='Фото профиля в Telegram не загружено или недоступно'
											>
												<ChannelIcon type='tg' size={26} />
											</div>
										)}
										<div className='tg-account__info'>
											<div className='tg-accountTitle'>
												Подключённый аккаунт
												{accountInfo.is_premium && (
													<span className='tg-account__premium' title='Telegram Premium'>★</span>
												)}
											</div>
											{accountInfo.id != null && (
												<div className='tg-accountLine'><span>ID:</span> <span>{accountInfo.id}</span></div>
											)}
											{accountInfo.username && (
												<div className='tg-accountLine'><span>Ник:</span> <span>@{accountInfo.username}</span></div>
											)}
											{(accountInfo.first_name || accountInfo.last_name) && (
												<div className='tg-accountLine'>
													<span>Имя:</span>{' '}
													<span>{[accountInfo.first_name, accountInfo.last_name].filter(Boolean).join(' ')}</span>
												</div>
											)}
											{accountInfo.phone && (
												<div className='tg-accountLine'>
													<span>Телефон:</span> <span>{formatTgPhone(accountInfo.phone)}</span>
												</div>
											)}
										</div>
									</div>
								</div>
							)
						)}
					</div>
					</div>
				</div>
			</div>
	)
}
