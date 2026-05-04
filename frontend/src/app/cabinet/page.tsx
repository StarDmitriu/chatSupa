// frontend/src/app/cabinet/page.tsx
'use client'
import './page.css'
import './subscription/page.css'
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import Cookies from 'js-cookie'
import { WhatsappConnectBlock } from '@/components/WhatsappConnectBlock'
import { CampaignBlock } from '@/components/CampaignBlock'
import { TelegramQrConnect } from '@/components/TelegramQrConnect'
import { apiPost, ApiError } from '@/lib/api'
import { useNotify } from '@/ui/notify/notify'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { ChannelIcon } from '@/components/ChannelIcon'
import { PLAN_LABELS, PLAN_PRICES, isPlanCode } from '@/constants/channels'
import { AppBurgerButton } from '@/components/AppBurgerButton'
import { SUPPORT_TELEGRAM_URL } from '@/lib/supportContacts'

/** Номер для отображения при выходе из ЛК (вход по SMS на этот телефон). */
function formatLoginPhoneForDisplay(phone: string | null | undefined): string | null {
	const raw = String(phone || '').trim()
	if (!raw) return null
	const digits = raw.replace(/\D/g, '')
	if (!digits) return raw
	let d = digits
	if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1)
	if (d.length === 10) d = '7' + d
	if (d.length === 11 && d.startsWith('7')) {
		return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`
	}
	if (raw.startsWith('+')) return raw
	return `+${d}`
}

interface User {
	id: string
	phone: string
	full_name?: string | null
	gender?: string | null
	telegram?: string | null
	birthday?: string | null
	city?: string | null
	timezone?: string | null
	gsheet_url?: string | null
	referral_code?: string | null
}

/** Популярные часовые пояса (IANA) для выбора в кабинете */
const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
	{ value: 'Europe/Moscow', label: 'Москва (UTC+3)' },
	{ value: 'Europe/Samara', label: 'Самара (UTC+4)' },
	{ value: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+5)' },
	{ value: 'Asia/Omsk', label: 'Омск (UTC+6)' },
	{ value: 'Asia/Krasnoyarsk', label: 'Красноярск (UTC+7)' },
	{ value: 'Asia/Irkutsk', label: 'Иркутск (UTC+8)' },
	{ value: 'Asia/Yakutsk', label: 'Якутск (UTC+9)' },
	{ value: 'Asia/Vladivostok', label: 'Владивосток (UTC+10)' },
	{ value: 'Europe/Kaliningrad', label: 'Калининград (UTC+2)' },
	{ value: 'Europe/Minsk', label: 'Минск (UTC+3)' },
	{ value: 'Europe/Kyiv', label: 'Киев (UTC+2/+3)' },
	{ value: 'Asia/Almaty', label: 'Алматы (UTC+5/+6)' },
	{ value: 'Asia/Tbilisi', label: 'Тбилиси (UTC+4)' },
	{ value: 'Asia/Tashkent', label: 'Ташкент (UTC+5)' },
	{ value: 'Europe/London', label: 'Лондон (UTC+0/+1)' },
	{ value: 'Europe/Berlin', label: 'Берлин (UTC+1/+2)' },
	{ value: 'Europe/Paris', label: 'Париж (UTC+1/+2)' },
	{ value: 'UTC', label: 'UTC' },
]

export default function CabinetPage() {
	const router = useRouter()
	const [user, setUser] = useState<User | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [loadTimedOut, setLoadTimedOut] = useState(false)
	const [retryCount, setRetryCount] = useState(0)
	const [profileOpen, setProfileOpen] = useState(false)
	const [contentReady, setContentReady] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
	const notify = useNotify()
	const closeMenu = () => setMenuOpen(false)
	const loader = useGlobalLoader()

	// Плавное появление контента ЛК: двойной rAF чтобы первый кадр (opacity 0) отрисовался — меньше лагов/скачков
	useEffect(() => {
		if (!loading && user) {
			let id1: number | undefined
			const id2 = requestAnimationFrame(() => {
				id1 = requestAnimationFrame(() => setContentReady(true))
			})
			return () => {
				cancelAnimationFrame(id2)
				if (id1 !== undefined) cancelAnimationFrame(id1)
			}
		}
		setContentReady(false)
	}, [loading, user])

	const backendUrl =
		process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

	const AUTH_ME_TIMEOUT_MS = 20000
	const LOAD_GIVE_UP_MS = 25000

	// Если загрузка висит дольше LOAD_GIVE_UP_MS — показываем «Повторить», чтобы не застревать
	useEffect(() => {
		if (!loading) return
		const t = setTimeout(() => {
			setLoadTimedOut(true)
			setLoading(false)
		}, LOAD_GIVE_UP_MS)
		return () => clearTimeout(t)
	}, [loading, retryCount])

	useEffect(() => {
		setLoadTimedOut(false)
		loader?.hide?.()
		let cancelled = false
		const token = typeof document !== 'undefined' ? Cookies.get('token') : undefined
		if (!token) {
			setLoading(false)
			router.replace('/auth/phone?next=%2Fcabinet')
			return
		}

		const loadMe = async () => {
			setLoadError(null)
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), AUTH_ME_TIMEOUT_MS)
			try {
				const res = await fetch(`${backendUrl}/auth/me`, {
					headers: { Authorization: `Bearer ${token}` },
					cache: 'no-store',
					signal: controller.signal,
				})
				clearTimeout(timeoutId)
				if (!res.ok) {
					if (res.status >= 500) {
						loader?.hide?.()
						if (!cancelled) setLoadError('Сервер временно недоступен. Попробуйте позже.')
					} else {
						loader.hide()
						Cookies.remove('token')
						router.replace('/auth/phone?next=%2Fcabinet')
					}
					return
				}
				const data = await res.json().catch(() => null)
				if (!data?.success) {
					loader.hide()
					Cookies.remove('token')
					router.replace('/auth/phone?next=%2Fcabinet')
					return
				}
				if (!cancelled) setUser(data.user)
			} catch (e) {
				clearTimeout(timeoutId)
				console.error(e)
				if (!cancelled) {
					loader?.hide?.()
					if ((e as Error)?.name === 'AbortError') {
						setLoadError('Сервер не ответил вовремя. Проверьте интернет и попробуйте снова.')
					} else {
						setLoadError('Ошибка соединения. Проверьте интернет и попробуйте снова.')
					}
				}
			} finally {
				if (!cancelled) {
					loader?.hide?.()
					setLoading(false)
				}
			}
		}

		loadMe()
		return () => {
			cancelled = true
		}
	}, [router, backendUrl, retryCount])

	// Автоскролл к блоку TG или WA по хешу (#telegram / #whatsapp)
	useEffect(() => {
		if (!user || typeof window === 'undefined') return
		const hash = (window.location.hash || '').replace(/^#/, '').toLowerCase()
		if (hash !== 'telegram' && hash !== 'whatsapp') return
		const id = hash === 'telegram' ? 'cabinet-telegram' : 'cabinet-whatsapp'
		const t = setTimeout(() => {
			const el = document.getElementById(id)
			if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
		}, 100)
		return () => clearTimeout(t)
	}, [user])

	const goTemplates = () => router.push('/dashboard/templates')

	const [groupsCount, setGroupsCount] = useState<{ tg: number; wa: number } | null>(null)

	type TgAccountInfo = {
		success: boolean
		id?: number
		username?: string | null
		first_name?: string
		last_name?: string | null
		phone?: string | null
		is_premium?: boolean
	}
	type WaAccountInfo = {
		success: boolean
		connected?: boolean
		wa_id?: string
		jid?: string
	}
	const [tgAccountInfo, setTgAccountInfo] = useState<TgAccountInfo | null>(null)
	const [waAccountInfo, setWaAccountInfo] = useState<WaAccountInfo | null>(null)

	useEffect(() => {
		if (!user?.id) return
		const token = typeof document !== 'undefined' ? Cookies.get('token') : undefined
		if (!token) return
		let cancelled = false
		Promise.all([
			fetch(`${backendUrl}/telegram/groups/${user.id}/count`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }),
			fetch(`${backendUrl}/whatsapp/groups/${user.id}/count`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }),
		])
			.then(([tgRes, waRes]) => Promise.all([tgRes.json(), waRes.json()]))
			.then(([tgData, waData]) => {
				if (!cancelled && tgData?.success && waData?.success) {
					setGroupsCount({
						tg: tgData.selected ?? 0,
						wa: waData.selected ?? 0,
					})
				}
			})
			.catch(() => {})
		return () => { cancelled = true }
	}, [user?.id, backendUrl])

	// Данные подключённых аккаунтов Telegram и WhatsApp (id, ники, номера)
	useEffect(() => {
		if (!user?.id) return
		const token = typeof document !== 'undefined' ? Cookies.get('token') : undefined
		if (!token) return
		let cancelled = false
		const h = { Authorization: `Bearer ${token}` }
		Promise.all([
			fetch(`${backendUrl}/telegram/account-info/${user.id}`, { cache: 'no-store', headers: h }).then((r) => r.json()),
			fetch(`${backendUrl}/whatsapp/account-info/${user.id}`, { cache: 'no-store', headers: h }).then((r) => r.json()),
		]).then(([tgData, waData]) => {
			if (!cancelled) {
				if (tgData?.success) setTgAccountInfo(tgData)
				if (waData?.success) setWaAccountInfo(waData)
			}
		}).catch(() => {})
		return () => { cancelled = true }
	}, [user?.id, backendUrl])

	const performLogout = () => {
		Cookies.remove('token')
		setLogoutConfirmOpen(false)
		router.replace('/auth/phone?next=%2Fcabinet')
	}

	const openLogoutConfirm = () => {
		setLogoutConfirmOpen(true)
	}

	const closeLogoutConfirm = () => {
		setLogoutConfirmOpen(false)
	}

	useEffect(() => {
		if (!logoutConfirmOpen) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setLogoutConfirmOpen(false)
		}
		document.body.style.overflow = 'hidden'
		window.addEventListener('keydown', onKey)
		return () => {
			document.body.style.overflow = ''
			window.removeEventListener('keydown', onKey)
		}
	}, [logoutConfirmOpen])

	const openSupportTelegram = () => {
		window.open(SUPPORT_TELEGRAM_URL, '_blank', 'noopener,noreferrer')
	}

	const dash = () => {
		router.push('/dashboard/groups')
	}

	const [savingTz, setSavingTz] = useState(false)
	const handleTimezoneChange = async (tz: string) => {
		if (!user?.id) return
		setSavingTz(true)
		try {
			const data: any = await apiPost('/auth/update-profile', { timezone: tz || null })
			if (data?.success && data?.user) {
				setUser((u) => (u ? { ...u, timezone: data.user.timezone ?? tz } : u))
				notify('Часовой пояс сохранён', { type: 'success' })
			} else {
				notify(data?.message || 'Не удалось сохранить', { type: 'error' })
			}
		} catch (e) {
			console.error(e)
			notify('Ошибка сети', { type: 'error' })
		} finally {
			setSavingTz(false)
		}
	}

	// --- Подписка (данные из /subscriptions/me) ---
	const [subLoading, setSubLoading] = useState(true)
	const [subData, setSubData] = useState<any | null>(null)
	const [subBusy, setSubBusy] = useState(false)

	useEffect(() => {
		if (!user?.id) return
		const token = typeof document !== 'undefined' ? Cookies.get('token') : undefined
		if (!token) return
		let cancelled = false
		const load = async () => {
			try {
				setSubLoading(true)
			const res = await fetch(`${backendUrl}/subscriptions/me`, {
					headers: { Authorization: `Bearer ${token}` },
					cache: 'no-store',
				})
				const json: any = await res.json().catch(() => null)
				if (!cancelled) setSubData(json)
			} catch (e) {
				console.error(e)
			} finally {
				if (!cancelled) setSubLoading(false)
			}
		}
		load()
		return () => {
			cancelled = true
		}
	}, [user?.id, backendUrl])

	const startPayment = async (planCode: 'wa' | 'tg' | 'wa_tg') => {
		try {
			const res = await apiPost('/payments/prodamus/create', {
				plan_code: planCode,
			})
			if (!res?.success || !res?.payment_url) {
				notify(res?.message || 'Не удалось создать оплату', {
					type: 'error',
				})
				return
			}
			window.location.href = res.payment_url
		} catch (e) {
			console.error(e)
			const msg = e instanceof ApiError ? e.message : 'Ошибка сети. Проверьте подключение и попробуйте снова.'
			notify(msg, { type: 'error', title: 'Ошибка' })
		}
	}

	const startTrial = async () => {
		const token = typeof document !== 'undefined' ? Cookies.get('token') : undefined
		if (!token) return
		try {
			setSubBusy(true)
			const res = await fetch(`${backendUrl}/subscriptions/start-trial`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				notify(json?.message || 'Не удалось запустить пробный период', {
					type: 'error',
				})
				return
			}

			notify('Пробный период активирован', { type: 'success' })
			const me = await fetch(`${backendUrl}/subscriptions/me`, {
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
			})
			const subJson: any = await me.json().catch(() => null)
			setSubData(subJson)
		} catch (e) {
			console.error(e)
			notify('Ошибка сети. Проверьте подключение и попробуйте снова.', {
				type: 'error',
			})
		} finally {
			setSubBusy(false)
		}
	}

	const toggleAutoRenew = async (nextCancel: boolean) => {
		try {
			setSubBusy(true)
			const res = await apiPost('/subscriptions/cancel', {
				cancel: nextCancel,
			})
			if (!res?.success) {
				notify(res?.message || 'Не удалось обновить подписку', {
					type: 'error',
				})
				return
			}
			const token = typeof document !== 'undefined' ? Cookies.get('token') : undefined
			if (!token) return
			const me = await fetch(`${backendUrl}/subscriptions/me`, {
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				cache: 'no-store',
			})
			const subJson: any = await me.json().catch(() => null)
			setSubData(subJson)
		} catch (e) {
			console.error(e)
			const msg = e instanceof ApiError ? e.message : 'Ошибка сети. Проверьте подключение и попробуйте снова.'
			notify(msg, { type: 'error', title: 'Ошибка' })
		} finally {
			setSubBusy(false)
		}
	}

	if (loading) {
		return (
			<div className='cabinet cabinet--loading' style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
				<div style={{ textAlign: 'center' }}>
					<div className='cabinet-loading-spinner' style={{ width: 40, height: 40, border: '3px solid #eee', borderTopColor: '#333', borderRadius: '50%', margin: '0 auto 12px' }} />
					<p style={{ margin: 0, color: '#666' }}>Загрузка кабинета…</p>
				</div>
			</div>
		)
	}

	if (loadTimedOut) {
		return (
			<div className='cabinet cabinet--loading' style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
				<div style={{ textAlign: 'center', maxWidth: 360 }}>
					<p style={{ margin: 0, color: '#333' }}>Загрузка занимает больше времени, чем обычно.</p>
					<p style={{ margin: '8px 0 16px', fontSize: 14, color: '#666' }}>Проверьте интернет или попробуйте позже.</p>
					<button
						type='button'
						onClick={() => {
							setLoadTimedOut(false)
							setLoading(true)
							setRetryCount((c) => c + 1)
						}}
					>
						Повторить
					</button>
					<Link href='/' style={{ display: 'inline-block', marginLeft: 12 }}>
						На главную
					</Link>
				</div>
			</div>
		)
	}

	if (!user) {
		return (
			<div style={{ padding: 24, textAlign: 'center' }}>
				{loadError ? (
					<>
						<p style={{ marginBottom: 12 }}>{loadError}</p>
						<button
							type="button"
							onClick={() => {
								setLoadError(null)
								setLoading(true)
								setRetryCount((c) => c + 1)
							}}
						>
							Повторить
						</button>
					</>
				) : (
					'Пользователь не найден.'
				)}
			</div>
		)
	}

	// --- Подготовка данных подписки для отображения ---
	let subscriptionRows: ReactNode = null
	let subscriptionActions: ReactNode = null

	if (subLoading || !subData?.success) {
		subscriptionRows = <p>Загружаем данные подписки…</p>
	} else {
		const sub = subData.subscription || {}
		const status = subData.status || sub.status || 'none'
		const endsAt = subData.accessEndsAt ?? null
		const daysLeft =
			endsAt != null
				? Math.max(
						0,
						Math.floor(
							(new Date(endsAt).getTime() - Date.now()) /
								86400000,
						),
				  )
				: subData.accessDaysLeft ?? 0
		const planCode = String(sub.plan_code || 'wa_tg')
		const cancelAtPeriodEnd = !!sub.cancel_at_period_end
		const canStartTrial =
			!subData.isBlocked &&
			status !== 'active' &&
			status !== 'trial' &&
			daysLeft === 0

		const rusStatus =
			status === 'active'
				? 'Активна'
				: status === 'trial'
				? 'Пробный период'
				: 'Неактивна'
		const planLabel = isPlanCode(planCode) ? PLAN_LABELS[planCode] : 'Без тарифа'

		subscriptionRows = (
			<>
				<div className='subscription-data'>
					<strong>Текущий тариф</strong>
					<p className='subscription-data-text'>{planLabel}</p>
				</div>
				<div
					className={`subscription-data subscription-data--status-${
						status === 'active' ? 'active' : status === 'trial' ? 'trial' : 'inactive'
					}`}
				>
					<strong>Статус</strong>
					<p className='subscription-data-text'>{rusStatus}</p>
				</div>
				<div className='subscription-data'>
					<strong>Осталось дней</strong>
					<p className='subscription-data-text'>{daysLeft}</p>
				</div>
				<div className='subscription-data'>
					<strong>Действует до:</strong>
					<p className='subscription-data-text'>
						{endsAt ? new Date(endsAt).toLocaleString() : '-'}
					</p>
				</div>
			</>
		)

		if (!subData.isBlocked) {
			subscriptionActions = (
				<div className='subscription-actions'>
					<div className='subscription-actionsButtons'>
						{canStartTrial ? (
							<button
								className='subscription-btn subscription-btn--wa-tg'
								onClick={startTrial}
								disabled={subBusy}
							>
								<span className='subscription-btnLabel'>
									Начать пробный период на 3 дня
								</span>
							</button>
						) : null}
						<button
							className='subscription-btn subscription-btn--wa-tg'
							onClick={() => startPayment('wa_tg')}
							disabled={subBusy}
						>
							<span className='subscription-btnLabel'>
								<ChannelIcon type='wa' size={16} /> <ChannelIcon type='tg' size={16} /> Оплатить WhatsApp + Telegram — {PLAN_PRICES.wa_tg} руб. в месяц
							</span>
						</button>
						<button
							className='subscription-btn subscription-btn--wa'
							onClick={() => startPayment('wa')}
							disabled={subBusy}
						>
							<span className='subscription-btnLabel'>
								<ChannelIcon type='wa' size={16} /> Оплатить WhatsApp — {PLAN_PRICES.wa} руб. в месяц
							</span>
						</button>
						<button
							className='subscription-btn subscription-btn--tg'
							onClick={() => startPayment('tg')}
							disabled={subBusy}
						>
							<span className='subscription-btnLabel'>
								<ChannelIcon type='tg' size={16} /> Оплатить Telegram — {PLAN_PRICES.tg} руб. в месяц
							</span>
						</button>
					</div>

					{status === 'active' && (
						<button
							className='subscription-btn subscription-btn--cancel'
							onClick={() => toggleAutoRenew(!cancelAtPeriodEnd)}
							disabled={subBusy}
						>
							{cancelAtPeriodEnd
								? 'Подключить подписку'
								: 'Отменить подписку'}
						</button>
					)}
				</div>
			)
		}
	}

	// Доступ к запуску рассылок: при истёкшей оплате кнопки «Рассылки» / «Перейти в рассылки» показывают «Оплатите!» и скролл к подписке
	const canStartCampaigns = !subData
		? true
		: Boolean(
				subData.success &&
					!subData.isBlocked &&
					(subData.status === 'active' || subData.status === 'trial'),
			)
	const goCampaigns = () => {
		if (!canStartCampaigns) {
			notify('Оплатите! Продлите подписку для запуска рассылок.', { type: 'error' })
			document.getElementById('cabinet-subscription')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
			return
		}
		router.push('/dashboard/campaigns')
	}

	const loginPhoneLabel = formatLoginPhoneForDisplay(user?.phone)

	return (
		<div className={`cabinet ${contentReady ? 'cabinet--ready' : ''}`}>
			{logoutConfirmOpen ? (
				<div
					className='cabinet-logout-overlay'
					role='presentation'
					onClick={closeLogoutConfirm}
				>
					<div
						className='cabinet-logout-modal'
						role='dialog'
						aria-modal='true'
						aria-labelledby='cabinet-logout-title'
						onClick={(e) => e.stopPropagation()}
					>
						<h2 id='cabinet-logout-title' className='cabinet-logout-modal__title'>
							Выйти из личного кабинета?
						</h2>
						<p className='cabinet-logout-modal__text'>
							После выхода для повторного входа снова понадобится{' '}
							<strong>доступ к этому телефону</strong>: на него придёт SMS с кодом
							подтверждения (как при первом входе в сервис).
						</p>
						{loginPhoneLabel ? (
							<p className='cabinet-logout-modal__phone'>
								<span className='cabinet-logout-modal__phone-label'>
									Номер, привязанный к этому кабинету:
								</span>{' '}
								<span className='cabinet-logout-modal__phone-value'>{loginPhoneLabel}</span>
							</p>
						) : (
							<p className='cabinet-logout-modal__hint'>
								Номер в профиле сейчас не отображается — для входа используйте{' '}
								<strong>тот же телефон</strong>, который вы указывали при регистрации и входе по SMS.
							</p>
						)}
						<p className='cabinet-logout-modal__note'>
							Убедитесь, что SIM-карта с этим номером доступна, иначе войти снова не получится без
							обращения в поддержку.
						</p>
						<div className='cabinet-logout-modal__actions'>
							<button
								type='button'
								className='cabinet-logout-modal__btn cabinet-logout-modal__btn--cancel'
								onClick={closeLogoutConfirm}
							>
								Остаться
							</button>
							<button
								type='button'
								className='cabinet-logout-modal__btn cabinet-logout-modal__btn--confirm'
								onClick={performLogout}
							>
								Выйти
							</button>
						</div>
					</div>
				</div>
			) : null}
			{/* Вне шапки: у .cabinet-header есть transform (анимация), иначе fixed-меню ломается и уходит «под» контент */}
			<div className={`cabinet-mobile-menu ${menuOpen ? 'open' : ''}`}>
				<div className='cabinet-mobile-menu__backdrop' onClick={closeMenu} aria-hidden />
				<div className='cabinet-mobile-menu__panel'>
					<div className='cabinet-mobile-menu__top'>
						<Link href='/' className='cabinet-header__logo' onClick={closeMenu}>
							<Image
								src='/logo-heart.png'
								alt=''
								width={54}
								height={54}
								priority
								className='cabinet-header__logo-icon'
							/>
							<span className='cabinet-header__logo-chat'>Чат</span>
							<span className='cabinet-header__logo-accent'>Рассылка</span>
						</Link>
						<button
							type='button'
							className='cabinet-mobile-menu__close'
							onClick={closeMenu}
							aria-label='Закрыть меню'
						>
							✕
						</button>
					</div>
					<div className='cabinet-mobile-menu__links'>
						<button type='button' className='cabinet-mobile-menu__link' onClick={() => { goTemplates(); closeMenu(); }}>
							Шаблоны
						</button>
						<button type='button' className='cabinet-mobile-menu__link' onClick={() => { goCampaigns(); closeMenu(); }}>
							Рассылки
						</button>
						<button type='button' className='cabinet-mobile-menu__link' onClick={() => { openSupportTelegram(); closeMenu(); }}>
							Поддержка
						</button>
						<button
							type='button'
							className='cabinet-mobile-menu__link'
							onClick={() => {
								closeMenu()
								openLogoutConfirm()
							}}
						>
							Выйти
						</button>
					</div>
				</div>
			</div>

			<header className='cabinet-header'>
				<div className='cabinet-header__container'>
					<div className='cabinet-header__label'>Личный кабинет</div>
					<div className='cabinet-header__row'>
						<Link href='/' className='cabinet-header__logo'>
							<Image
								src='/logo-heart.png'
								alt=''
								width={54}
								height={54}
								priority
								className='cabinet-header__logo-icon'
							/>
							<span className='cabinet-header__logo-chat'>Чат</span>
							<span className='cabinet-header__logo-accent'>Рассылка</span>
						</Link>

						<nav className='cabinet-header__nav'>
							<button type='button' className='cabinet-header__pill ui-action-btn ui-header-btn' onClick={goTemplates}>
								Шаблоны
							</button>
							<button type='button' className='cabinet-header__pill ui-action-btn ui-header-btn' onClick={goCampaigns}>
								Рассылки
							</button>
							<button type='button' className='cabinet-header__pill ui-action-btn ui-header-btn' onClick={openSupportTelegram}>
								Поддержка
							</button>
							<button
								type='button'
								className='cabinet-header__pill cabinet-header__pill--logout ui-action-btn ui-header-btn'
								onClick={openLogoutConfirm}
							>
								Выйти
							</button>
						</nav>

						<AppBurgerButton
							open={menuOpen}
							onClick={() => setMenuOpen(v => !v)}
							className="cabinet-header__burger"
							ariaLabelOpen="Открыть меню"
							ariaLabelClose="Закрыть меню"
						/>
					</div>
				</div>
			</header>

			<div id='cabinet-telegram' className='cabinet-block'>
				<TelegramQrConnect userId={user.id} />
			</div>

			<div id='cabinet-whatsapp' className='cabinet-block'>
				<WhatsappConnectBlock userId={user.id} />
			</div>

			<div className='cabinet-block'>
				<CampaignBlock onGoToCampaigns={goCampaigns} />
			</div>

			<div id='cabinet-support' className='cabinet-block cabinet-block--support'>
				<div className='cabinet-support'>
					<h2 className='cabinet-support__title'>Поддержка</h2>
					<p className='cabinet-support__text'>Вопросы по сервису и рассылкам — чат в Telegram.</p>
					<div className='cabinet-support__actions'>
						<a
							href={SUPPORT_TELEGRAM_URL}
							target='_blank'
							rel='noopener noreferrer'
							className='cabinet-support__btn cabinet-support__btn--tg'
						>
							Написать в Telegram
						</a>
					</div>
				</div>
			</div>

			<div className='cabinet__wrap'>
				<div id='cabinet-subscription' className='cabinet-block cabinet-block--subscription'>
					<div className={`subscription__wrap ${subLoading ? 'subscription__wrap--loading' : ''}`}>
						<h2 className='subscription-title'>Моя подписка</h2>
						<p className='subscription-text'>
							Здесь вы можете продлить доступ, сменить тариф или отключить автосписание
						</p>
						<div className='subscription-cont'>
							{subscriptionRows}
						</div>
						{subscriptionActions}
						<p className='subscription-footer'>
							После окончания подписки доступ к сервису будет приостановлен
						</p>

						<div className='cabinet-timezone'>
							<strong className='cabinet-timezone__label'>Часовой пояс</strong>
							<select
								className='profile-timezone-select cabinet-timezone__select'
								value={user.timezone || 'Europe/Moscow'}
								onChange={(e) => handleTimezoneChange(e.target.value)}
								disabled={savingTz}
								aria-label='Часовой пояс'
							>
								{TIMEZONE_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
						</div>
					</div>
				</div>
			</div>

			<div className='cabinet-block cabinet-block--profile'>
				<div className='link'>
					<h2 className='link-title'>Реферальная ссылка</h2>
					
					{!user.referral_code ? (
						<p className='link-text'>Реферальный код ещё не создан.</p>
					) : (
						(() => {
							const link =
								typeof window !== 'undefined'
									? `${
											window.location.origin
										}/auth/register?ref=${encodeURIComponent(
											user.referral_code as string,
										)}`
									: ''
							
							const copyLink = async () => {
								try {
									await navigator.clipboard.writeText(link)
									notify('Ссылка скопирована', { type: 'success' })
								} catch {
									notify('Не удалось скопировать', { type: 'error' })
								}
							}

							const shareLink = async () => {
								if (typeof navigator !== 'undefined' && navigator.share) {
									try {
										await navigator.share({
											title: 'Регистрация в Чат-рассылке',
											text: 'Перейди по ссылке и зарегистрируйся — за твою оплату тарифа мне начислят +7 дней.',
											url: link,
										})
										notify('Ссылка отправлена', { type: 'success' })
									} catch (e: any) {
										if (e?.name !== 'AbortError') {
											await copyLink()
										}
									}
								} else {
									await copyLink()
								}
							}

							return (
								<>
									<p className='link-text'>
										Поделись ссылкой с другом. За каждую оплату <span className='link-text__accent'>по твоей ссылке</span> тебе добавят <strong className='link-text__highlight'>+7 дней</strong> к подписке.
									</p>

									<div className='link-row'>
										<input
											onClick={copyLink}
											className='link-input'
											value={link}
											readOnly
											aria-label='Реферальная ссылка'
										/>
										<button type='button' className='link-share-btn' onClick={shareLink} title='Поделиться'>
											<svg className='link-share-icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' aria-hidden>
												<path d='M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8' />
												<polyline points='16 6 12 2 8 6' />
												<line x1='12' y1='2' x2='12' y2='15' />
											</svg>
											Поделиться
										</button>
									</div>
								</>
							)
						})()
					)}

					<button
						type='button'
						className={`profile-toggle ${profileOpen ? 'profile-toggle--open' : ''}`}
						onClick={() => setProfileOpen(!profileOpen)}
						aria-expanded={profileOpen}
					>
						<span className='profile-toggle__label'>Немного обо мне</span>
						<span className='profile-toggle__icon' aria-hidden>▼</span>
					</button>
					<div className={`profile-content ${profileOpen ? 'profile-content--open' : ''}`}>
						<div className='profile'>
							<div className='profile-text'>
								<strong>Имя и фамилия</strong>
								<p>{user.full_name || 'Не указано'}</p>
							</div>
							<div className='profile-text'>
								<strong>Номер телефона</strong>
								<p>{user.phone}</p>
							</div>
							<div className='profile-text'>
								<strong>Пол</strong>{' '}
								<p>
									{user.gender === 'm'
										? 'Мужской'
										: user.gender === 'f'
											? 'Женский'
											: 'Не указан'}
								</p>
							</div>
							<div className='profile-text'>
								<strong>Ник в Telegram</strong>
								<p>{user.telegram || 'Не указан'}</p>
							</div>
							<div className='profile-text'>
								<strong>День рождения</strong>{' '}
								<p>{user.birthday ? user.birthday : 'Не указана'}</p>
							</div>
							<div className='profile-text'>
								<strong>Город</strong> <p>{user.city || 'Не указан'}</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
