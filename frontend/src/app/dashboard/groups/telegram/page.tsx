//frontend/src/app/dashboard/telegram-groups/page.tsx
'use client'
import { useEffect, useState, useRef, useMemo } from 'react'
import Cookies from 'js-cookie'
import Link from 'next/link'
import { Button, Table, message, Space, Select, Input, Popover, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import styles from './telegram-groups.module.css'
import { useRouter } from 'next/navigation'

/** Аватар TG-группы с fallback при ошибке загрузки */
function TgAvatar({ avatarUrl, name }: { avatarUrl: string | null | undefined; name: string }) {
	const [failed, setFailed] = useState(false)
	const showImg = avatarUrl && !failed
	const initial = (name || 'Г').trim().charAt(0).toUpperCase()
	return (
		<div className={styles.avatar}>
			{showImg ? (
				<img
					className={styles.avatarImg}
					src={avatarUrl!}
					alt={name}
					onError={() => setFailed(true)}
				/>
			) : (
				<div className={styles.avatarFallback}>{initial}</div>
			)}
		</div>
	)
}
import './page.css'
import { SEND_INTERVAL_OPTIONS } from '@/constants/sendIntervals'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { ChannelIcon } from '@/components/ChannelIcon'
import { errorMeaning } from '@/lib/campaignErrors'
import { fetchGroupDeliverySummary, type GroupDeliverySummary } from '@/lib/groupDeliverySummary'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'

const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
const SUMMARY_FRESH_MS = 30_000

type MeResponse =
	| { success: true; user: { id: string } }
	| { success: false; message: string }

type TgGroupRow = {
	tg_chat_id: string
	title: string | null
	participants_count: number | null
	updated_at: string
	is_selected?: boolean | null
	send_time?: string | null
	avatar_url?: string | null
	views_count?: number | null
	forwards_count?: number | null
	replies_count?: number | null
	last_send_error?: string | null
	last_send_error_at?: string | null
}

function reasonDescription(reason: string): string {
	const r = String(reason || '').toUpperCase()
	if (r === 'CHANNEL_INVALID') return 'Группа недоступна по текущим данным Telegram. Часто помогает синхронизация групп.'
	if (r === 'CHAT_WRITE_FORBIDDEN') return 'В эту группу нельзя отправлять сообщения: нет прав или запрещена отправка.'
	if (r === 'USER_BANNED_IN_CHANNEL') return 'Ваш аккаунт ограничен в этой группе/канале и не может писать.'
	if (r === 'CHANNEL_PRIVATE') return 'Группа/канал приватные, у аккаунта нет доступа к отправке.'
	if (r === 'PEER_ID_INVALID') return 'Адрес группы устарел или неверен, Telegram не может её распознать.'
	return 'Сообщение не ушло в эту группу. Проверьте доступ, права и актуальность группы.'
}

export default function TelegramGroupsPage() {
	const [userId, setUserId] = useState('')
	const [loadingMe, setLoadingMe] = useState(false)
	const [loadingGroups, setLoadingGroups] = useState(false)
	const [syncing, setSyncing] = useState(false)
	const [bulkSelecting, setBulkSelecting] = useState(false)
	const [savingMap, setSavingMap] = useState<Record<string, boolean>>({})
	const [savingTimeMap, setSavingTimeMap] = useState<Record<string, boolean>>(
		{}
	)
	const [groups, setGroups] = useState<TgGroupRow[]>([])
	const [q, setQ] = useState('')
	const [totalGroups, setTotalGroups] = useState(0)
	/** Строк в БД (при дублях tg_chat_id > totalGroups) */
	const [totalRowsInDb, setTotalRowsInDb] = useState(0)
	const [selectedCount, setSelectedCount] = useState(0)
	const [loadingMore, setLoadingMore] = useState(false)
	const [hasMore, setHasMore] = useState(false)
	const [animatedCount, setAnimatedCount] = useState(0) // Плавно увеличивающийся счетчик для отображения
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	/** Keyset-пагинация (без OFFSET — иначе таймаут БД на больших смещениях). */
	const tgDbCursorRef = useRef<{ updated_at: string; tg_chat_id: string } | null>(null)
	/** Fallback, если бэкенд без RPC keyset и шлёт только nextOffset. */
	const tgDbNextOffsetRef = useRef(0)
	const [tgPagerEpoch, setTgPagerEpoch] = useState(0)
	const animationFrameRef = useRef<number | null>(null)
	const loadingMeStartedRef = useRef(false)
	const loadingGroupsStartedRef = useRef(false)
	const router = useRouter()
	const loader = useGlobalLoader()
	const BATCH_SIZE = 50 // Загружаем по 50 групп за раз для более быстрой загрузки
	const [lastSyncAt, setLastSyncAt] = useState<number | null>(null)
	const [tgConnected, setTgConnected] = useState<boolean | null>(null)
	const [groupDeliverySummary, setGroupDeliverySummary] = useState<Record<string, GroupDeliverySummary>>({})
	const [summaryMeta, setSummaryMeta] = useState<{ cacheHit: boolean; fetchedAtMs: number | null }>({
		cacheHit: false,
		fetchedAtMs: null,
	})
	const [openInfoJid, setOpenInfoJid] = useState<string | null>(null)
	const closeInfoLockRef = useRef<string | null>(null)
	const [summaryLoadingByJid, setSummaryLoadingByJid] = useState<Record<string, boolean>>({})
	const [tgPhoneFilter, setTgPhoneFilter] = useState<string>('')
	const [tgPhones, setTgPhones] = useState<string[]>([])
	const LAST_SYNC_KEY = 'tg_groups_last_sync'

	const token = typeof document !== 'undefined' ? (Cookies.get('token') || '') : ''

	const fetchTgAccountInfo = async (uid: string): Promise<boolean> => {
		try {
			const res = await fetch(`${BACKEND_URL}/telegram/qr/status/${uid}?_=${Date.now()}`, {
				cache: 'no-store',
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			})
			const data: { success?: boolean; status?: string } = await res.json().catch(() => ({}))
			return !!(data?.success && data?.status === 'connected')
		} catch {
			return false
		}
	}

	const fetchMe = async () => {
		setLoadingMe(true)
		try {
			const res = await fetch(`${BACKEND_URL}/auth/me`, {
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
			})
			const data: MeResponse | null = await res.json().catch(() => null)
			if (data == null) {
				message.error('Неверный ответ сервера при получении профиля')
				return
			}
			if (!data.success)
				return message.error(data.message || 'Не удалось получить /auth/me')
			setUserId(data.user.id)
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при получении /auth/me')
		} finally {
			setLoadingMe(false)
		}
	}

	const fetchTgPhones = async (uid: string) => {
		if (!uid) return
		try {
			const res = await fetch(`${BACKEND_URL}/telegram/groups/${uid}/phones`, {
				cache: 'no-store',
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			})
			const json: { success?: boolean; phones?: string[] } = await res.json().catch(() => ({}))
			if (json?.success && Array.isArray(json.phones)) {
				setTgPhones(json.phones)
			} else {
				setTgPhones([])
			}
		} catch {
			setTgPhones([])
		}
	}

	const fetchGroups = async (uid: string, reset = true, tgPhone?: string) => {
		if (!uid) return
		if (reset) {
			tgDbCursorRef.current = null
			tgDbNextOffsetRef.current = 0
			setLoadingGroups(true)
			setGroups([])
			setTotalRowsInDb(0)
			setAnimatedCount(0) // Сбрасываем анимированный счетчик
		} else {
			setLoadingMore(true)
		}

		let bumpPager = false
		try {
			const params = new URLSearchParams({ limit: String(BATCH_SIZE) })
			if (!reset && tgDbCursorRef.current) {
				params.set('cursorUpdatedAt', tgDbCursorRef.current.updated_at)
				params.set('cursorTgChatId', tgDbCursorRef.current.tg_chat_id)
			} else if (!reset && tgDbNextOffsetRef.current > 0) {
				params.set('offset', String(tgDbNextOffsetRef.current))
			}
			if (tgPhone?.trim()) params.set('tgPhone', tgPhone.trim())
			const url = `${BACKEND_URL}/telegram/groups/${uid}?${params.toString()}`

			const res = await fetch(url, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const rawText = await res.text().catch(() => '')
			let data: {
				success?: boolean
				groups?: TgGroupRow[]
				total?: number
				totalRows?: number
				hasMore?: boolean
				nextOffset?: number
				nextCursor?: { updated_at?: string; tg_chat_id?: string }
			} | null = null
			try {
				data = rawText ? JSON.parse(rawText) : null
			} catch {
				data = null
			}
			if (!res.ok) {
				const hint =
					res.status === 502 || res.status === 504
						? ' Шлюз или БД не успели ответить (таймаут). Повторите через минуту или уменьшите нагрузку.'
						: ''
				message.error(
					`Не удалось загрузить группы Telegram (${res.status}).${hint}`,
				)
				return
			}
			if (data?.success) {
				const raw = data.groups
				const next = Array.isArray(raw) ? raw : []
				const total = data.total ?? 0
				const rowsTotal = Number(data.totalRows ?? data.total ?? total) || total
				const hasMoreData = data.hasMore ?? false

				// Дедупликация: убираем группы с одинаковым tg_chat_id
				const uniqueNext = next.filter((group: TgGroupRow, index: number, self: TgGroupRow[]) =>
					index === self.findIndex((g: TgGroupRow) => g.tg_chat_id === group.tg_chat_id)
				)

				const nc = data.nextCursor
				if (
					nc?.updated_at &&
					nc.tg_chat_id != null &&
					String(nc.tg_chat_id).trim() !== ''
				) {
					tgDbCursorRef.current = {
						updated_at: String(nc.updated_at),
						tg_chat_id: String(nc.tg_chat_id),
					}
					tgDbNextOffsetRef.current = 0
				} else {
					tgDbCursorRef.current = null
					const nextOff = Number(data.nextOffset)
					if (Number.isFinite(nextOff)) {
						tgDbNextOffsetRef.current = nextOff
					} else {
						tgDbNextOffsetRef.current = 0
					}
				}
				bumpPager = hasMoreData

				if (reset) {
					setGroups(uniqueNext)
					// Начинаем плавную анимацию счетчика до реального количества
					animateCount(0, uniqueNext.length)
				} else {
					// При добавлении новых групп проверяем, что их еще нет в списке
					setGroups(prev => {
						const p = prev ?? []
						const existingIds = new Set(p.map(g => g.tg_chat_id))
						const newGroups = uniqueNext.filter((g: TgGroupRow) => !existingIds.has(g.tg_chat_id))
						const newTotal = p.length + newGroups.length
						animateCount(p.length, newTotal)
						return [...p, ...newGroups]
					})
				}
				
				setTotalGroups(total)
				setTotalRowsInDb(rowsTotal)
				setHasMore(hasMoreData)
				return uniqueNext.length
			}
			else message.error('Не удалось загрузить группы Telegram из БД')
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при загрузке TG групп')
		} finally {
			setLoadingGroups(false)
			setLoadingMore(false)
			if (bumpPager) setTgPagerEpoch(e => e + 1)
		}
	}

	type TgGroupsCountResponse = {
		success?: boolean
		selected?: number
		total?: number
	}

	const fetchSelectedCount = async (uid: string) => {
		if (!uid) return
		try {
			const res = await fetch(`${BACKEND_URL}/telegram/groups/${uid}/count`, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const data: TgGroupsCountResponse | null = await res.json().catch(() => null)
			if (!data?.success) return
			setSelectedCount(Number(data.selected ?? 0))
			if (Number(data.total ?? 0) > 0) {
				setTotalGroups(Number(data.total ?? 0))
			}
		} catch (e) {
			console.error(e)
		}
	}

	const loadMoreGroups = () => {
		if (!userId || loadingMore || !hasMore || loadingGroups) return
		fetchGroups(userId, false, tgPhoneFilter || undefined)
	}

	// Функция для плавной анимации счетчика
	const animateCount = (from: number, to: number) => {
		// Останавливаем предыдущую анимацию если есть
		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current)
		}

		if (from === to) {
			setAnimatedCount(to)
			return
		}

		const startTime = Date.now()
		const duration = Math.min(800, Math.abs(to - from) * 15) // Динамическая длительность: ~15ms на группу, максимум 800ms
		const startValue = from

		const animate = () => {
			const elapsed = Date.now() - startTime
			const progress = Math.min(elapsed / duration, 1)
			
			// Используем easing функцию для плавности (ease-out)
			const eased = 1 - Math.pow(1 - progress, 3)
			const current = Math.floor(startValue + (to - startValue) * eased)
			
			setAnimatedCount(current)

			if (progress < 1) {
				animationFrameRef.current = requestAnimationFrame(animate)
			} else {
				setAnimatedCount(to)
				animationFrameRef.current = null
			}
		}

		animationFrameRef.current = requestAnimationFrame(animate)
	}

	// Автодогрузка порций; tgPagerEpoch — чтобы продолжать, если порция не добавила новых уникальных чатов (дубликаты в БД)
	useEffect(() => {
		if (!userId || loadingMore || loadingGroups || !hasMore) return

		const timer = setTimeout(() => {
			if (hasMore && !loadingMore && !loadingGroups) {
				loadMoreGroups()
			}
		}, 200)
		return () => clearTimeout(timer)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hasMore, loadingMore, loadingGroups, userId, tgPagerEpoch])

	// Очистка анимации при размонтировании
	useEffect(() => {
		return () => {
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current)
			}
		}
	}, [])

	const syncGroups = async () => {
		if (!userId) return message.warning('Нет userId — перелогиньтесь')
		setSyncing(true)
		try {
			const res = await fetch(`${BACKEND_URL}/telegram/sync-groups`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({ userId }),
			})
			const raw = await res.text().catch(() => '')
			let data: any = null
			try {
				data = raw ? JSON.parse(raw) : null
			} catch {
				data = null
			}
			if (!res.ok) {
				message.error(
					`Синхронизация не удалась (${res.status}). Повторите позже — при 502/504 сервер или БД перегружены.`,
					8,
				)
				return
			}
			if (!data?.success) {
				const msg: unknown = data?.message
				if (msg === 'telegram_not_connected') {
					message.error(
						'Telegram не подключён. Сейчас откроем страницу подключения.'
					)
					loader.show('Подключение Telegram…')
					router.push('/cabinet#telegram')
				} else if (msg === 'telegram_timeout') {
					message.error(
						'Telegram временно не отвечает. Попробуйте ещё раз через 10–20 секунд.',
					)
				} else if (msg === 'supabase_upsert_error') {
					const text =
						data?.userMessage ||
						'Не удалось сохранить список групп в базу. Попробуйте ещё раз; если ошибка повторяется — обратитесь в поддержку.'
					message.error(text, 8)
				} else {
					const um = data?.userMessage
					message.error(
						(typeof um === 'string' && um) ||
							`Ошибка синка TG групп: ${msg || 'неизвестная ошибка'}`,
						8
					)
				}
				return
			}
			message.success(`TG группы обновлены: ${data.count}`)
			const now = Date.now()
			setLastSyncAt(now)
			if (typeof localStorage !== 'undefined') {
				try {
					localStorage.setItem(`${LAST_SYNC_KEY}_${userId}`, String(now))
				} catch {}
			}
			await fetchTgPhones(userId)
			await fetchGroups(userId, true, tgPhoneFilter || undefined) // Перезагружаем с начала
			await fetchSelectedCount(userId)
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при /telegram/sync-groups')
		} finally {
			setSyncing(false)
		}
	}

	const setSelected = async (tgChatId: string, next: boolean) => {
		if (!userId) return

		setGroups(prev => (prev ?? []).map(g =>
			g.tg_chat_id === tgChatId ? { ...g, is_selected: next } : g
		))
		setSelectedCount(prev => Math.max(0, prev + (next ? 1 : -1)))
		setSavingMap(prev => ({ ...prev, [tgChatId]: true }))

		try {
			const res = await fetch(`${BACKEND_URL}/telegram/groups/select`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userId,
					tg_chat_id: tgChatId,
					is_selected: next,
				}),
			})
			const json: { success?: boolean; message?: string } | null = await res.json().catch(() => null)
			if (!json?.success) {
				message.error(
					`Не удалось сохранить выбор TG группы: ${json?.message || 'unknown'}`
				)
				setGroups(prev => (prev ?? []).map(g =>
					g.tg_chat_id === tgChatId ? { ...g, is_selected: !next } : g
				))
				setSelectedCount(prev => Math.max(0, prev + (next ? -1 : 1)))
			}
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при сохранении выбора TG группы')
			setGroups(prev => (prev ?? []).map(g =>
				g.tg_chat_id === tgChatId ? { ...g, is_selected: !next } : g
			))
			setSelectedCount(prev => Math.max(0, prev + (next ? -1 : 1)))
		} finally {
			setSavingMap(prev => ({ ...prev, [tgChatId]: false }))
		}
	}

	const setSendTime = async (tgChatId: string, next: string | null) => {
		if (!userId) return

		setGroups(prev => (prev ?? []).map(g =>
			g.tg_chat_id === tgChatId ? { ...g, send_time: next } : g
		))
		setSavingTimeMap(prev => ({ ...prev, [tgChatId]: true }))

		try {
			const res = await fetch(`${BACKEND_URL}/telegram/groups/time`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userId,
					tg_chat_id: tgChatId,
					send_time: next,
				}),
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				message.error(
					`Не удалось сохранить интервал группы: ${json?.message || 'unknown'}`
				)
			} else {
				window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
			}
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при сохранении интервала группы')
		} finally {
			setSavingTimeMap(prev => ({ ...prev, [tgChatId]: false }))
		}
	}

	const selectAll = async (val: boolean) => {
		const list = Array.isArray(groups) ? groups : []
		setGroups(prev => (prev ?? []).map(g => ({ ...g, is_selected: val })))
		setSelectedCount(val ? totalGroups || list.length : 0)
		setBulkSelecting(true)
		try {
			const res = await fetch(`${BACKEND_URL}/telegram/groups/select-all`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userId,
					is_selected: val,
				}),
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				message.error(
					`Не удалось ${val ? 'выбрать' : 'снять'} все TG группы: ${json?.message || 'unknown'}`
				)
				setGroups(prev => (prev ?? []).map(g => ({ ...g, is_selected: !val })))
				await fetchSelectedCount(userId)
				return
			}
			setSelectedCount(Number(json.selected || 0))
			message.success(val ? 'Все TG группы выбраны' : 'Выбор TG групп снят')
		} catch (e) {
			console.error(e)
			message.error(`Ошибка сети при ${val ? 'выборе' : 'снятии'} всех TG групп`)
			setGroups(prev => (prev ?? []).map(g => ({ ...g, is_selected: !val })))
			await fetchSelectedCount(userId)
		} finally {
			setBulkSelecting(false)
		}
	}

	useEffect(() => {
		loader.hide()
		if (!token) return message.warning('Нет токена. Войдите в аккаунт.')
		loadingMeStartedRef.current = true
		fetchMe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token])

	useEffect(() => {
		if (!userId) return
		if (typeof localStorage !== 'undefined') {
			try {
				const raw = localStorage.getItem(`${LAST_SYNC_KEY}_${userId}`)
				if (raw) setLastSyncAt(parseInt(raw, 10) || null)
			} catch {}
		}
		loadingGroupsStartedRef.current = true
		void (async () => {
			const connected = await fetchTgAccountInfo(userId)
			setTgConnected(connected)
			await fetchTgPhones(userId)
			if (!connected) return
			const count = await fetchGroups(userId, true, tgPhoneFilter || undefined)
			await fetchSelectedCount(userId)
			if (!count && !tgPhoneFilter) {
				await syncGroups()
				await fetchGroups(userId, true, tgPhoneFilter || undefined)
				await fetchSelectedCount(userId)
			}
		})()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId])

	const loadGroupSummary = async (tgChatId: string, force = false) => {
		if (!token) return
		const hasLocal = !!groupDeliverySummary[tgChatId]
		if (
			!force &&
			hasLocal &&
			summaryMeta.fetchedAtMs &&
			Date.now() - summaryMeta.fetchedAtMs < SUMMARY_FRESH_MS
		) {
			return
		}
		setSummaryLoadingByJid(prev => ({ ...prev, [tgChatId]: true }))
		try {
			const res = await fetchGroupDeliverySummary({
				backendUrl: BACKEND_URL,
				token,
				channel: 'tg',
				groupJids: [tgChatId],
				lookbackDays: 14,
				includeTemplatesIncluded: true,
				bypassCache: force,
			})
			setGroupDeliverySummary(prev => ({ ...prev, ...res.summaries }))
			setSummaryMeta({ cacheHit: res.meta.cacheHit, fetchedAtMs: res.meta.fetchedAtMs })
		} finally {
			setSummaryLoadingByJid(prev => ({ ...prev, [tgChatId]: false }))
		}
	}

	useEffect(() => {
		if (!userId || tgConnected !== true) return
		fetchGroups(userId, true, tgPhoneFilter || undefined)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tgPhoneFilter])

	// При возврате на вкладку — обновить статус TG (чтобы «словился» после кабинета)
	useEffect(() => {
		const onFocus = () => {
			if (userId) {
				fetchTgAccountInfo(userId).then(setTgConnected)
			}
		}
		const onVisibility = () => {
			if (document.visibilityState === 'visible') onFocus()
		}
		document.addEventListener('visibilitychange', onVisibility)
		window.addEventListener('focus', onFocus)
		return () => {
			document.removeEventListener('visibilitychange', onVisibility)
			window.removeEventListener('focus', onFocus)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId])

	const columns: ColumnsType<TgGroupRow> = [
		{
			title: 'Группа',
			key: 'group',
			render: (_: any, row: TgGroupRow) => {
				const checked = row.is_selected !== false
				const busy = !!savingMap[row.tg_chat_id]
				const name = row.title || 'без названия'
				const initial = name.trim().charAt(0).toUpperCase()
				const summary = groupDeliverySummary[row.tg_chat_id]
				const meta = summaryMeta
				const infoContent = (
					<div style={{ minWidth: 230, fontSize: 12, lineHeight: 1.4 }}>
						<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
							<div><b>Сводка отправок (14 дней)</b></div>
							<button
								type='button'
								className={styles.infoCloseBtn}
								onMouseDown={(e) => {
									e.preventDefault()
									e.stopPropagation()
								}}
								onClick={(e) => {
									e.preventDefault()
									e.stopPropagation()
									closeInfoLockRef.current = row.tg_chat_id
									setOpenInfoJid(null)
								}}
							>
								×
							</button>
						</div>
						<div style={{ opacity: 0.75 }}>
							{meta.fetchedAtMs
								? meta.cacheHit
									? `Из кэша · ${Math.max(0, Math.floor((Date.now() - meta.fetchedAtMs) / 1000))}с назад`
									: 'Обновлено только что'
								: '—'}
						</div>
						<div>Включена в шаблонов: <b>{summary?.templatesIncluded ?? 0}</b></div>
						<div>Отправлено: <b>{summary?.sent ?? 0}</b></div>
						<div>Ошибок: <b>{summary?.failed ?? 0}</b></div>
						<div>Успешность: <b>{summary?.successRate ?? 0}%</b></div>
						<div>Последняя отправка: {summary?.lastSentAt ? new Date(summary.lastSentAt).toLocaleString() : '—'}</div>
						<div>Последняя ошибка: {summary?.lastFailedAt ? new Date(summary.lastFailedAt).toLocaleString() : '—'}</div>
						<div>
							Причины:{' '}
							{summary?.topReasons?.length ? (
								<div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
									{summary.topReasons.map(r => (
										<div key={r.reason} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
											<span>{r.reason} ({r.count})</span>
											<Tooltip title={reasonDescription(r.reason)}>
												<button type='button' className={styles.reasonInfoBtn}>i</button>
											</Tooltip>
										</div>
									))}
								</div>
							) : '—'}
						</div>
						<div style={{ marginTop: 6 }}>
							<button
								type='button'
								className={styles.infoRefreshBtn}
								onMouseDown={(e) => e.stopPropagation()}
								onClick={(e) => {
									e.stopPropagation()
									void loadGroupSummary(row.tg_chat_id, true)
								}}
							>
								{summaryLoadingByJid[row.tg_chat_id] ? '…' : 'Обновить'}
							</button>
						</div>
					</div>
				)

				return (
					<div className={styles.rowContent}>
						<div className={styles.rowLeft}>
							<div className={`${styles.customCheckbox} ${checked ? styles.checked : ''} ${busy ? styles.busy : ''}`}>
								{checked && (
									<svg className={styles.checkIcon} viewBox="0 0 20 20" fill="none">
										<path
											d="M16.7071 5.29289C17.0976 5.68342 17.0976 6.31658 16.7071 6.70711L8.70711 14.7071C8.31658 15.0976 7.68342 15.0976 7.29289 14.7071L3.29289 10.7071C2.90237 10.3166 2.90237 9.68342 3.29289 9.29289C3.68342 8.90237 4.31658 8.90237 4.70711 9.29289L8 12.5858L15.2929 5.29289C15.6834 4.90237 16.3166 4.90237 16.7071 5.29289Z"
											fill="currentColor"
										/>
									</svg>
								)}
							</div>
							<TgAvatar avatarUrl={row.avatar_url} name={name} />
							<Popover
								content={infoContent}
								trigger='click'
								placement='rightTop'
								open={openInfoJid === row.tg_chat_id}
								onOpenChange={(open) => {
									if (open) {
										if (closeInfoLockRef.current === row.tg_chat_id) {
											closeInfoLockRef.current = null
											return
										}
										setOpenInfoJid(row.tg_chat_id)
										void loadGroupSummary(row.tg_chat_id, false)
									} else if (openInfoJid === row.tg_chat_id) {
										closeInfoLockRef.current = null
										setOpenInfoJid(null)
									}
								}}
							>
								<button
									type='button'
									className={styles.infoBtn}
									onMouseDown={(e) => e.stopPropagation()}
									onClick={(e) => e.stopPropagation()}
								>
									i
								</button>
							</Popover>
							<div className={styles.rowTitleBlock}>
								<div className={styles.rowTitle}>{name}</div>
								{row.last_send_error ? (
									<span className={styles.rowRestriction} title={row.last_send_error}>
										⚠ {errorMeaning(row.last_send_error)}
									</span>
								) : null}
								<span className={styles.rowIdUnder} title={row.tg_chat_id}>
									{row.tg_chat_id}
								</span>
							</div>
						</div>

						<div className={styles.intervalWrap}>
							{(row.views_count != null || row.forwards_count != null || row.replies_count != null) && (
								<span className={styles.rowStats} title='Просмотры · Пересылки · Ответы'>
									{row.views_count != null && <span>👁 {row.views_count}</span>}
									{row.forwards_count != null && <span>↗ {row.forwards_count}</span>}
									{row.replies_count != null && <span>💬 {row.replies_count}</span>}
								</span>
							)}
							<Select
								allowClear
								placeholder='Интервал'
								size='small'
								className={styles.intervalSelect}
								value={row.send_time ?? ''}
								options={[{ value: '', label: 'Без интервала' }, ...SEND_INTERVAL_OPTIONS]}
								disabled={!!savingTimeMap[row.tg_chat_id]}
								onChange={(v) => {
									// antd может отдавать '' или undefined при очистке
									const next = v == null || v === '' ? null : String(v)
									setSendTime(row.tg_chat_id, next)
								}}
								onMouseDown={(e) => e.stopPropagation()}
								onClick={(e) => e.stopPropagation()}
							/>
							<button
								type='button'
								className={`${styles.selectToggleBtn} ${checked ? styles.selectToggleBtnActive : ''}`}
								disabled={busy}
								onMouseDown={(e) => e.stopPropagation()}
								onClick={(e) => {
									e.stopPropagation()
									setSelected(row.tg_chat_id, !checked)
								}}
							>
								{checked ? '✓ Выбрано' : 'Выбрать'}
							</button>
						</div>
					</div>
				)
			},
		},
	]

	const safeGroups = Array.isArray(groups) ? groups : []
	const total = totalGroups || safeGroups.length
	const selected = selectedCount

	// Фильтрация и дедупликация
	const filtered = useMemo(() => {
		const list = safeGroups
		const s = q.trim().toLowerCase()
		let result = list
		
		// Фильтрация по поисковому запросу
		if (s) {
			result = list.filter(g =>
				(g?.title || '').toLowerCase().includes(s)
			)
		}
		
		// Дедупликация по tg_chat_id на случай дубликатов в данных
		const seen = new Set<string>()
		const deduped = result.filter(g => {
			const id = g?.tg_chat_id
			if (!id) return false
			if (seen.has(id)) {
				console.warn(`Дубликат группы обнаружен: ${id} - "${g?.title}"`)
				return false
			}
			seen.add(id)
			return true
		})
		// Выбранные группы сразу наверх списка
		return [...deduped].sort((a, b) => {
			const aSel = a?.is_selected !== false
			const bSel = b?.is_selected !== false
			if (aSel && !bSel) return -1
			if (!aSel && bSel) return 1
			return 0
		})
	}, [safeGroups, q])

	return (
		<div className='grp'>
			<div className={`${styles.page} grp__content`}>
				<div className={styles.container}>
				{userId && tgConnected === false && (
					<div className={styles.notConnectedBlock}>
						Telegram не подключён. Подключите его в{' '}
						<Link href='/cabinet#telegram'>личном кабинете</Link>.
					</div>
				)}
				<div className={`${styles.panel} grp-panel`}>
					<div className={styles.panelTop}>
						<div className={styles.panelActions}>
							<Space wrap>
								<Button
									className={styles.actionBtn}
									type='primary'
									onClick={syncGroups}
									disabled={!userId || syncing || tgConnected === false}
									title={tgConnected === false ? 'Сначала подключите Telegram в личном кабинете' : 'Синхронизировать список групп Telegram'}
								>
									{syncing ? 'Синхронизируем…' : 'Синхронизация'}
								</Button>
								{tgPhones.length > 1 && (
									<div className={styles.phoneFilterWrap}>
										<span className={styles.phoneFilterLabel}>Номер TG:</span>
										<Select
											value={tgPhoneFilter || undefined}
											onChange={(v) => setTgPhoneFilter(v ?? '')}
											placeholder="Все номера"
											allowClear
											style={{ minWidth: 180 }}
											options={[
												{ value: '', label: 'Все номера' },
												...tgPhones.map((p) => ({ value: p, label: p })),
											]}
										/>
									</div>
								)}
								<Button
									className={styles.actionBtn}
									onClick={() => selectAll(true)}
									disabled={!safeGroups.length || !userId || bulkSelecting}
								>
									{bulkSelecting ? 'Применяем…' : 'Выбрать все'}
								</Button>
								<Button
									className={styles.actionBtn}
									onClick={() => selectAll(false)}
									disabled={!safeGroups.length || !userId || bulkSelecting}
								>
									Снять все
								</Button>
							</Space>
						</div>
						{tgPhones.length > 1 && tgConnected === true && (
							<div className={styles.groupsHint}>
								Сохранённые группы не удаляются при отключении номера. Можно подключать несколько Telegram по очереди и выбирать номер в фильтре «Номер TG».
							</div>
						)}
						<div className={styles.panelSearch}>
							<div className={styles.searchLabel}>Найти группу</div>
							<div className={styles.searchWrap}>
								<Input
									className={styles.searchInput}
									value={q}
									onChange={e => setQ(e.target.value)}
									placeholder='Поиск групп по названию...'
									allowClear
								/>
								<svg className={styles.searchIcon} viewBox='0 0 24 24' fill='none'>
									<path
										d='M10.5 18.5a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z'
										stroke='currentColor'
										strokeWidth='2'
									/>
									<path
										d='M16.5 16.5 21 21'
										stroke='currentColor'
										strokeWidth='2'
										strokeLinecap='round'
									/>
								</svg>
							</div>
						</div>
						<div className={styles.counters}>
							<div className={styles.counterRow}>
								<b>Всего групп:</b> {total}
								{total > 0 && (
									<span className={styles.counterMeta}>
										{(loadingGroups || loadingMore) && (
											<span className={styles.loadingSpinner} aria-hidden />
										)}
										<span className={styles.counterText}>Загружено: {animatedCount} из {total}</span>
										{hasMore && !loadingMore && !loadingGroups && safeGroups.length < total && (
											<span className={styles.counterSub}>· загружаем ещё</span>
										)}
									</span>
								)}
							</div>
							{totalRowsInDb > totalGroups && totalGroups > 0 && (
								<div className={styles.counterRow} style={{ color: '#888', fontSize: 12 }}>
									В таблице <b>{totalRowsInDb}</b> строк при <b>{totalGroups}</b> уникальных чатах — есть дубликаты
									по <code>tg_chat_id</code>. Скрипт: <b>backend/migrations/fix_duplicate_groups.sql</b>
								</div>
							)}
							<div className={styles.counterRow}>
								<b>Выбрано групп:</b> {selected}
							</div>
							{lastSyncAt && (
								<div className={styles.counterRow} style={{ color: '#666', fontSize: 12 }}>
									<b>Последняя синхронизация:</b>{' '}
									{new Date(lastSyncAt).toLocaleString('ru-RU', {
										day: '2-digit',
										month: '2-digit',
										year: 'numeric',
										hour: '2-digit',
										minute: '2-digit',
									})}
								</div>
							)}
							{q.trim() && (
								<div className={styles.counterRow}>
									<b>Найдено:</b> {filtered.length}
								</div>
							)}
						</div>
					</div>
					<div 
						className={styles.scrollContainer}
						ref={scrollContainerRef}
						onScroll={(e) => {
							// Дополнительная загрузка при прокрутке вниз (на случай если автозагрузка не успела)
							const container = e.currentTarget
							const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight
							if (scrollBottom < 500 && hasMore && !loadingMore && !loadingGroups) {
								loadMoreGroups()
							}
						}}
					>
						<div className={styles.table}>
							<Table
								rowKey='tg_chat_id'
								columns={columns}
								dataSource={filtered}
								loading={loadingMe || loadingGroups}
								pagination={false}
								locale={{
									emptyText: userId && tgConnected === false
										? 'Подключите Telegram в личном кабинете.'
										: 'Нет групп',
								}}
								onRow={(record) => {
									if (!record?.tg_chat_id) return {}
									const r = record as TgGroupRow
									return {
										className: `${styles.tableRow} ${r.is_selected !== false ? styles.rowSelected : ''}`,
									}
								}}
							/>
						</div>
					</div>
				</div>
				</div>
			</div>
		</div>
	)
}
