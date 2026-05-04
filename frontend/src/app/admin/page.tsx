'use client'

import { useEffect, useMemo, useState } from 'react'
import Cookies from 'js-cookie'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useNotify } from '@/ui/notify/notify'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { apiGet, apiPost, ApiError } from '@/lib/api'
import './page.css'

const LS_ADMIN_PW = 'admin_panel_password'

type SubscriptionRow = {
	user_id: string
	status: string
	plan_code?: string | null
	trial_ends_at?: string | null
	current_period_end?: string | null
	cancel_at_period_end?: boolean | null
	updated_at?: string | null
} | null

type UserRow = {
	id: string
	phone: string
	full_name?: string | null
	gender?: string | null
	telegram?: string | null
	birthday?: string | null
	email?: string | null
	email_verified?: boolean | null
	is_blocked?: boolean | null
	is_admin?: boolean | null
	created_at?: string | null
	last_login?: string | null
	subscription?: SubscriptionRow
}

function fmtDate(s?: string | null) {
	if (!s) return '—'
	try {
		return new Date(s).toLocaleString()
	} catch {
		return String(s)
	}
}

function daysLeftByEnd(end?: string | null) {
	if (!end) return 0
	const ms = new Date(end).getTime() - Date.now()
	return Math.max(0, Math.ceil(ms / 86400000))
}

function calcTrialDaysLeft(sub: SubscriptionRow) {
	return daysLeftByEnd(sub?.trial_ends_at ?? null)
}

function calcPaidDaysLeft(sub: SubscriptionRow) {
	return daysLeftByEnd(sub?.current_period_end ?? null)
}

function calcAccessDaysLeft(sub: SubscriptionRow) {
	const t = sub?.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : 0
	const p = sub?.current_period_end ? new Date(sub.current_period_end).getTime() : 0
	const mx = Math.max(t, p)
	if (!mx) return 0
	const ms = mx - Date.now()
	return Math.max(0, Math.ceil(ms / 86400000))
}

type AccessStatus = 'active' | 'trial' | 'none'

type AccessBucket = 'any' | '0' | '1-7' | '8-30' | '31+'

type SortKey = 'created_at' | 'last_login' | 'access_days' | 'name'
type SortDir = 'asc' | 'desc'

type UserVm = UserRow & {
	sub: SubscriptionRow
	trialDaysLeft: number
	paidDaysLeft: number
	accessDaysLeft: number
	trialEndsAt: string | null
	paidEndsAt: string | null
	accessEndsAt: string
	accessStatus: AccessStatus
	nameKey: string
}

export default function AdminPage() {
	const router = useRouter()
	const token = typeof document !== 'undefined' ? (Cookies.get('token') || '') : ''

	const [loading, setLoading] = useState(true)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [err, setErr] = useState<string | null>(null)
	const [users, setUsers] = useState<UserRow[]>([])
	const [q, setQ] = useState('')
	const [statusFilter, setStatusFilter] = useState<AccessStatus | 'all'>('all')
	const [blockedFilter, setBlockedFilter] = useState<'all' | 'blocked' | 'not_blocked'>('all')
	const [adminFilter, setAdminFilter] = useState<'all' | 'admin' | 'not_admin'>('all')
	const [planFilter, setPlanFilter] = useState<string>('all')
	const [accessBucket, setAccessBucket] = useState<AccessBucket>('any')
	const [sortKey, setSortKey] = useState<SortKey>('created_at')
	const [sortDir, setSortDir] = useState<SortDir>('desc')

	const [pwOpen, setPwOpen] = useState(false)
	const [pwInput, setPwInput] = useState('')
	const [passwordVerified, setPasswordVerified] = useState(false)
	const [adminPw, setAdminPw] = useState<string>(() => {
		if (typeof window === 'undefined') return ''
		return String(window.localStorage.getItem(LS_ADMIN_PW) || '')
	})

	const notify = useNotify()
	const loader = useGlobalLoader()

	const adminHeaders = useMemo(() => {
		const v = String(adminPw || '').trim()
		return v
			? ({ 'X-Admin-Password': v } as Record<string, string>)
			: ({} as Record<string, string>)
	}, [adminPw])

	const savePw = () => {
		const v = String(pwInput || '').trim()
		setAdminPw(v)
		try {
			window.localStorage.setItem(LS_ADMIN_PW, v)
		} catch {}
		setPwOpen(false)
		setPwInput('')
		// Перезагрузка данных с новым паролем произойдёт по эффекту (adminHeaders изменился)
	}

	const clearPw = () => {
		setAdminPw('')
		setPasswordVerified(false)
		try {
			window.localStorage.removeItem(LS_ADMIN_PW)
		} catch {}
	}

	/** Войти по паролю с экрана-шлюза (проверка и переход к данным) */
	const gateSubmit = () => {
		const v = String(pwInput || '').trim()
		if (!v) return
		setAdminPw(v)
		try {
			window.localStorage.setItem(LS_ADMIN_PW, v)
		} catch {}
		setPwInput('')
		setErr(null)
		// Эффект загрузки сработает из-за смены adminHeaders
	}

	useEffect(() => {
		loader.hide()
		if (!token) {
			router.push('/auth/phone')
			return;		}

		const load = async () => {
			setLoading(true)
			setErr(null)
			try {
				const json = await apiGet('/admin/users', { headers: adminHeaders })
				if (!json?.success) throw new Error(String(json?.message || 'Не удалось загрузить'))
				setUsers((json.users || []) as UserRow[])
				setPasswordVerified(true)
			} catch (e) {
				const msg = e instanceof ApiError ? e.message : (e as Error)?.message
				if (msg && String(msg).includes('admin_password')) {
					setPasswordVerified(false)
					setAdminPw('')
					try {
						window.localStorage.removeItem(LS_ADMIN_PW)
					} catch {}
					setErr('Неверный пароль или пароль не задан на сервере.')
				} else {
					setErr(msg || 'Ошибка сети')
				}
				setUsers([])
			} finally {
				setLoading(false)
			}
		}

		load()
	}, [router, token, loader, adminHeaders])

	const vms = useMemo<UserVm[]>(() => {
		return (users || []).map((u) => {
			const sub = u.subscription ?? null
			const trialDaysLeft = calcTrialDaysLeft(sub)
			const paidDaysLeft = calcPaidDaysLeft(sub)
			const accessDaysLeft = calcAccessDaysLeft(sub)

			const trialEndsAt = sub?.trial_ends_at ?? null
			const paidEndsAt = sub?.current_period_end ?? null

			const accessStatus: AccessStatus =
				paidDaysLeft > 0 ? 'active' : trialDaysLeft > 0 ? 'trial' : 'none'

			const accessEndsAt =
				trialEndsAt || paidEndsAt
					? fmtDate(
						new Date(
							Math.max(
								trialEndsAt ? new Date(trialEndsAt).getTime() : 0,
								paidEndsAt ? new Date(paidEndsAt).getTime() : 0,
							),
						).toISOString(),
					)
					: '—'

			const nameKey = `${String(u.full_name || '')} ${String(u.phone || '')}`.trim().toLowerCase()

			return {
				...u,
				sub,
				trialDaysLeft,
				paidDaysLeft,
				accessDaysLeft,
				trialEndsAt,
				paidEndsAt,
				accessEndsAt,
				accessStatus,
				nameKey,
			}
		})
	}, [users])

	const planOptions = useMemo(() => {
		const set = new Set<string>()
		for (const u of vms) {
			const p = String(u.sub?.plan_code || '').trim()
			if (p) set.add(p)
		}
		return Array.from(set).sort((a, b) => a.localeCompare(b))
	}, [vms])

	// Для поиска по телефону: оставляем только цифры, чтобы "900" находил "+7 900 123-45-67"
	const phoneDigits = (v: string) => String(v ?? '').replace(/\D/g, '')

	const filtered = useMemo(() => {
		const s = q.trim().toLowerCase()
		const sDigits = phoneDigits(q)
		const passSearch = (u: UserVm) => {
			if (!s) return true
			const matchPhone = sDigits.length >= 2 && (phoneDigits(u.phone || '').includes(sDigits) || String(u.phone || '').toLowerCase().includes(s))
			return (
				matchPhone ||
				String(u.full_name || '').toLowerCase().includes(s) ||
				String(u.email || '').toLowerCase().includes(s) ||
				String(u.telegram || '').toLowerCase().includes(s) ||
				String(u.id || '').toLowerCase().includes(s)
			)
		}

		const passFilters = (u: UserVm) => {
			if (statusFilter !== 'all' && u.accessStatus !== statusFilter) return false
			if (blockedFilter === 'blocked' && !u.is_blocked) return false
			if (blockedFilter === 'not_blocked' && u.is_blocked) return false
			if (adminFilter === 'admin' && !u.is_admin) return false
			if (adminFilter === 'not_admin' && u.is_admin) return false
			if (planFilter !== 'all') {
				const p = String(u.sub?.plan_code || '').trim() || '—'
				if (p !== planFilter) return false
			}
			if (accessBucket !== 'any') {
				const d = u.accessDaysLeft
				if (accessBucket === '0' && d !== 0) return false
				if (accessBucket === '1-7' && !(d >= 1 && d <= 7)) return false
				if (accessBucket === '8-30' && !(d >= 8 && d <= 30)) return false
				if (accessBucket === '31+' && !(d >= 31)) return false
			}
			return true
		}

		const sorted = [...vms].filter(passSearch).filter(passFilters)

		const dir = sortDir === 'asc' ? 1 : -1
		sorted.sort((a, b) => {
			if (sortKey === 'created_at') {
				return dir * ((new Date(a.created_at || 0).getTime() || 0) - (new Date(b.created_at || 0).getTime() || 0))
			}
			if (sortKey === 'last_login') {
				return dir * ((new Date(a.last_login || 0).getTime() || 0) - (new Date(b.last_login || 0).getTime() || 0))
			}
			if (sortKey === 'access_days') {
				return dir * (a.accessDaysLeft - b.accessDaysLeft)
			}
			// name
			return dir * a.nameKey.localeCompare(b.nameKey)
		})

		return sorted
	}, [vms, q, statusFilter, blockedFilter, adminFilter, planFilter, accessBucket, sortKey, sortDir])

	const reload = async () => {
		if (!token) return
		setLoading(true)
		setErr(null)
		try {
			const json = await apiGet('/admin/users', { headers: adminHeaders })
			if (!json?.success) throw new Error(String(json?.message || 'Не удалось загрузить'))
			setUsers((json.users || []) as UserRow[])
			setPasswordVerified(true)
		} catch (e) {
			const msg = e instanceof ApiError ? e.message : (e as Error)?.message
			if (msg && String(msg).includes('admin_password')) {
				setPasswordVerified(false)
				setAdminPw('')
				try {
					window.localStorage.removeItem(LS_ADMIN_PW)
				} catch {}
				setErr('Нужен пароль админки')
				setPwOpen(true)
			} else {
				setErr(msg || 'Ошибка сети')
			}
			setUsers([])
		} finally {
			setLoading(false)
		}
	}

	const post = async (url: string, body: unknown) => {
		if (!token) throw new Error('no_token')
		const json = await apiPost(url, body ?? {}, { headers: adminHeaders })
		if (!json?.success) throw new Error(String(json?.message || 'request_failed'))
		return json as unknown
	}

	const toggleBlock = async (u: UserRow) => {
		setBusyId(u.id)
		try {
			await post(`/admin/users/${u.id}/block`, {
				blocked: !u.is_blocked,
			})
			await reload()
		} catch (e) {
			notify((e as Error)?.message || 'Не удалось изменить блокировку', {
				type: 'error',
				title: 'Ошибка',
			})
		} finally {
			setBusyId(null)
		}
	}

	const giveTrial = async (u: UserRow, days: number) => {
		setBusyId(u.id)
		try {
			await post(`/admin/users/${u.id}/grant-trial`, { days })
			await reload()
		} catch (e) {
			notify((e as Error)?.message || 'Не удалось выдать trial', {
				type: 'error',
				title: 'Ошибка',
			})
		} finally {
			setBusyId(null)
		}
	}

	const extendPaid = async (u: UserRow, days: number) => {
		setBusyId(u.id)
		try {
			await post(`/admin/users/${u.id}/grant-access`, { days })
			await reload()
		} catch (e) {
			notify((e as Error)?.message || 'Не удалось продлить подписку', {
				type: 'error',
				title: 'Ошибка',
			})
		} finally {
			setBusyId(null)
		}
	}

  const reduceTrial = async (u: UserRow, days: number) => {
		setBusyId(u.id)
		try {
			await post(`/admin/users/${u.id}/reduce-trial`, { days })
			await reload()
		} catch (e) {
			notify((e as Error)?.message || 'Не удалось уменьшить trial', {
				type: 'error',
				title: 'Ошибка',
			})
		} finally {
			setBusyId(null)
		}
	}

	const reducePaid = async (u: UserRow, days: number) => {
		setBusyId(u.id)
		try {
			await post(`/admin/users/${u.id}/reduce-access`, { days })
			await reload()
		} catch (e) {
			notify((e as Error)?.message || 'Не удалось уменьшить подписку', {
				type: 'error',
				title: 'Ошибка',
			})
		} finally {
			setBusyId(null)
		}
	}



	// Экран-шлюз: показываем только форму пароля, данные не отображаем
	if (!passwordVerified) {
		return (
			<div className='adm'>
				<div className='adm__gate'>
					<Link href='/' className='adm__gate-logo'>
						<Image
							src='/logo-heart.png'
							alt=''
							width={54}
							height={54}
							priority
							className='tpl-header__logo-icon'
						/>
						<span className='tpl-header__logo-chat'>Чат</span>
						<span className='tpl-header__logo-accent'>Рассылка</span>
					</Link>
					<h1 className='adm__gate-title'>Пароль админки</h1>
					<p className='adm__gate-hint'>
						Пароль задаётся на сервере в переменной <code>ADMIN_PANEL_PASSWORD</code> (backend .env).
						Без верного пароля запросы к админ-панели запрещены.
					</p>
					<form
						className='adm__gate-form'
						onSubmit={(e) => { e.preventDefault(); gateSubmit() }}
					>
						<input
							className='adm__modalInput adm__gate-input'
							value={pwInput}
							onChange={(e) => setPwInput(e.target.value)}
							placeholder='Введите пароль…'
							type='password'
							autoFocus
							autoComplete='current-password'
						/>
						{err ? (
							<p className='adm__gate-err'>{err}</p>
						) : null}
						<button
							type='submit'
							className='adm__btn adm__btn--primary'
							disabled={!pwInput.trim() || loading}
						>
							{loading ? 'Проверка…' : 'Войти'}
						</button>
					</form>
					<button
						type='button'
						className='adm__btn adm__gate-back'
						onClick={() => router.push('/cabinet')}
					>
						Назад в кабинет
					</button>
				</div>
			</div>
		)
	}

	return (
		<div className='adm'>
			<header className='tpl-header'>
				<div className='tpl-header__container'>
					<div className='tpl-header__label'>Админ-панель</div>
					<div className='tpl-header__row'>
						<Link href='/' className='tpl-header__logo'>
							<Image
								src='/logo-heart.png'
								alt=''
								width={54}
								height={54}
								priority
								className='tpl-header__logo-icon'
							/>
							<span className='tpl-header__logo-chat'>Чат</span>
							<span className='tpl-header__logo-accent'>Рассылка</span>
						</Link>
						<nav className='tpl-header__nav'>
							<Link
								href='/admin/campaign-diagnostics'
								className='tpl-header__pill ui-action-btn ui-header-btn'
							>
								Диагностика кампаний
							</Link>
							<button
								type='button'
								className='tpl-header__pill ui-action-btn ui-header-btn'
								onClick={() => { setPwInput(adminPw); setPwOpen(true) }}
							>
								{adminPw ? 'Пароль: задан' : 'Пароль: не задан'}
							</button>
							<button
								type='button'
								className='tpl-header__pill ui-action-btn ui-header-btn'
								onClick={reload}
								disabled={loading}
							>
								{loading ? 'Обновляем…' : 'Обновить'}
							</button>
							<button
								type='button'
								className='tpl-header__pill ui-action-btn ui-header-btn'
								onClick={() => router.push('/cabinet')}
							>
								Назад в кабинет
							</button>
						</nav>
					</div>
				</div>
			</header>

			<div className='adm__wrap'>
				{pwOpen && (
					<div className='adm__modalOverlay' role='dialog' aria-modal='true'>
						<div className='adm__modal'>
							<div className='adm__modalTitle'>Пароль админки</div>
							<div className='adm__modalHint'>
								Если на сервере включена защита, без пароля запросы к `/admin/*` будут запрещены.
							</div>
							<input
								className='adm__modalInput'
								value={pwInput}
								onChange={(e) => setPwInput(e.target.value)}
								placeholder='Введите пароль…'
								type='password'
								autoFocus
							/>
							<div className='adm__modalActions'>
								<button type='button' className='adm__btn' onClick={() => { clearPw(); setPwOpen(false) }}>
									Сбросить
								</button>
								<button type='button' className='adm__btn' onClick={() => setPwOpen(false)}>
									Отмена
								</button>
								<button type='button' className='adm__btn adm__btn--primary' onClick={savePw}>
									Сохранить
								</button>
							</div>
						</div>
					</div>
				)}

				{err && (
					<div className='adm__error'>
						<p className='adm__error-msg'>{err}</p>
						<div className='adm__error-actions'>
							<button type='button' className='adm__btn' onClick={() => router.push('/cabinet')}>
								Назад в кабинет
							</button>
							<button type='button' className='adm__btn' onClick={reload}>
								Повторить
							</button>
						</div>
					</div>
				)}

				{!err && (
					<>
						<div className='adm__toolbar'>
							<input
								className='adm__search'
								value={q}
								onChange={e => setQ(e.target.value)}
								placeholder='Поиск: телефон, имя, email, telegram, id...'
							/>

							<div className='adm__filters'>
								<select className='adm__select' value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
									<option value='all'>Статус: все</option>
									<option value='active'>active</option>
									<option value='trial'>trial</option>
									<option value='none'>none</option>
								</select>
								<select className='adm__select' value={blockedFilter} onChange={(e) => setBlockedFilter(e.target.value as any)}>
									<option value='all'>Блок: все</option>
									<option value='blocked'>blocked</option>
									<option value='not_blocked'>не blocked</option>
								</select>
								<select className='adm__select' value={adminFilter} onChange={(e) => setAdminFilter(e.target.value as any)}>
									<option value='all'>Роль: все</option>
									<option value='admin'>admin</option>
									<option value='not_admin'>не admin</option>
								</select>
								<select className='adm__select' value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}>
									<option value='all'>План: все</option>
									{planOptions.map((p) => (
										<option key={p} value={p}>{p}</option>
									))}
								</select>
								<select className='adm__select' value={accessBucket} onChange={(e) => setAccessBucket(e.target.value as any)}>
									<option value='any'>Доступ: любой</option>
									<option value='0'>0 дн.</option>
									<option value='1-7'>1–7 дн.</option>
									<option value='8-30'>8–30 дн.</option>
									<option value='31+'>31+ дн.</option>
								</select>
								<select className='adm__select' value={`${sortKey}:${sortDir}`} onChange={(e) => {
									const [k, d] = String(e.target.value).split(':')
									setSortKey(k as SortKey)
									setSortDir(d as SortDir)
								}}>
									<option value='created_at:desc'>Создан ↓</option>
									<option value='created_at:asc'>Создан ↑</option>
									<option value='last_login:desc'>Вход ↓</option>
									<option value='last_login:asc'>Вход ↑</option>
									<option value='access_days:desc'>Доступ ↓</option>
									<option value='access_days:asc'>Доступ ↑</option>
									<option value='name:asc'>Имя A→Я</option>
									<option value='name:desc'>Имя Я→A</option>
								</select>
							</div>
						</div>

						<div className='adm__card'>
							<div style={{ overflowX: 'auto' }}>
								{loading ? (
									<div className='adm__empty'>Загрузка пользователей…</div>
								) : (
									<table className='adm__table'>
										<thead>
											<tr>
												<th>Пользователь</th>
												<th>Контакты</th>
												<th>Подписка</th>
												<th>Даты</th>
												<th>Действия</th>
											</tr>
										</thead>
										<tbody>
						{filtered.map(u => {
							const isBusy = busyId === u.id

							return (
								<tr key={u.id}>
									<td>
										<div className='adm__cell-user'>{u.full_name || '—'}</div>
										<div className='adm__cell-meta'>
											{u.phone}
											{u.is_admin ? ' · admin' : ''}
											{u.is_blocked ? ' · BLOCKED' : ''}
										</div>
										<div className='adm__cell-id'>id: {u.id}</div>
									</td>

									<td>
										<div className='adm__cell-row'><span className='adm__cell-label'>Email</span> {u.email || '—'}{' '}{u.email_verified ? '✓' : ''}</div>
										<div className='adm__cell-row'><span className='adm__cell-label'>TG</span> {u.telegram || '—'}</div>
										<div className='adm__cell-row'><span className='adm__cell-label'>Пол</span> {u.gender === 'm' ? 'м' : u.gender === 'f' ? 'ж' : '—'}</div>
										<div className='adm__cell-row'><span className='adm__cell-label'>ДР</span> {u.birthday || '—'}</div>
									</td>

									<td>
										<div className='adm__cell-row'><span className='adm__cell-label'>Статус</span> {u.accessStatus}</div>
										<div className='adm__cell-row'><span className='adm__cell-label'>Trial</span> {u.trialDaysLeft} дн. до {u.trialEndsAt ? fmtDate(u.trialEndsAt) : '—'}</div>
										<div className='adm__cell-row'><span className='adm__cell-label'>Paid</span> {u.paidDaysLeft} дн. до {u.paidEndsAt ? fmtDate(u.paidEndsAt) : '—'}</div>
										<div className='adm__cell-row'><span className='adm__cell-label'>Доступ</span> {u.accessDaysLeft} дн. до {u.accessEndsAt}</div>
									</td>

									<td>
										<div className='adm__cell-row'><span className='adm__cell-label'>Создан</span> {fmtDate(u.created_at)}</div>
										<div className='adm__cell-row'><span className='adm__cell-label'>Вход</span> {fmtDate(u.last_login)}</div>
									</td>

									<td>
										<div className='adm__actions'>
											<button
												type='button'
												className='adm__btn'
												onClick={() => toggleBlock(u)}
												disabled={isBusy}
											>
												{u.is_blocked ? 'Разблок' : 'Блок'}
											</button>

											<details className='adm__dd'>
												<summary className='adm__btn' aria-label='Действия trial' onClick={(e) => { if (isBusy) e.preventDefault() }}>
													Trial
												</summary>
												<div className='adm__ddPanel'>
													<button type='button' className='adm__btn' onClick={() => giveTrial(u, 3)} disabled={isBusy}>+3д</button>
													<button type='button' className='adm__btn' onClick={() => giveTrial(u, 7)} disabled={isBusy}>+7д</button>
													<button type='button' className='adm__btn' onClick={() => giveTrial(u, 14)} disabled={isBusy}>+14д</button>
													<button type='button' className='adm__btn' onClick={() => reduceTrial(u, 1)} disabled={isBusy}>-1д</button>
													<button type='button' className='adm__btn' onClick={() => reduceTrial(u, 3)} disabled={isBusy}>-3д</button>
												</div>
											</details>

											<details className='adm__dd'>
												<summary className='adm__btn' aria-label='Действия доступа' onClick={(e) => { if (isBusy) e.preventDefault() }}>
													Доступ
												</summary>
												<div className='adm__ddPanel'>
													<button type='button' className='adm__btn' onClick={() => extendPaid(u, 30)} disabled={isBusy}>+30д</button>
													<button type='button' className='adm__btn' onClick={() => reducePaid(u, 1)} disabled={isBusy}>-1д</button>
													<button type='button' className='adm__btn' onClick={() => reducePaid(u, 7)} disabled={isBusy}>-7д</button>
												</div>
											</details>
										</div>
										{isBusy ? <div className='adm__cell-meta' style={{ marginTop: 4 }}>Обновляем…</div> : null}
									</td>
								</tr>
							)
						})}

						{filtered.length === 0 ? (
							<tr>
								<td colSpan={5} className='adm__empty'>
									Ничего не найдено
								</td>
							</tr>
						) : null}
					</tbody>
									</table>
								)}
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	)
}
