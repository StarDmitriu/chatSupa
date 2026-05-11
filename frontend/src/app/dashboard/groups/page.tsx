'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import Cookies from 'js-cookie'
import Link from 'next/link'
import { Button, Table, message, Space, Input, Select, Popover, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useRouter } from 'next/navigation'
import './page.css'
import styles from './groups.module.css'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { ChannelIcon } from '@/components/ChannelIcon'
import { errorMeaning } from '@/lib/campaignErrors'
import { fetchGroupDeliverySummary, type GroupDeliverySummary } from '@/lib/groupDeliverySummary'
const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
const SUMMARY_FRESH_MS = 30_000

type MeResponse =
	| {
			success: true
			user: { id: string; phone: string; full_name?: string | null }
	  }
	| { success: false; message: string }

type GroupRow = {
	wa_group_id: string
	subject: string | null
	participants_count: number | null
	is_announcement: boolean | null
	is_restricted: boolean | null
	updated_at: string
	is_selected?: boolean | null
	send_time?: string | null
	last_send_error?: string | null
	last_send_error_at?: string | null
}

type GroupsResponse =
	| { success: true; groups: GroupRow[]; total?: number; hasMore?: boolean }
	| { success: false; message: string }

function reasonDescription(reason: string): string {
	const r = String(reason || '').toUpperCase()
	if (r === 'CHANNEL_INVALID') return 'Группа недоступна по текущим данным Telegram. Обычно помогает синхронизация, иногда группа удалена или изменена.'
	if (r === 'CHAT_WRITE_FORBIDDEN') return 'В эту группу сейчас нельзя писать: нет прав или отправка ограничена настройками группы.'
	if (r === 'USER_BANNED_IN_CHANNEL') return 'Ваш аккаунт ограничен в этой группе/канале: Telegram не разрешает отправку.'
	if (r === 'CHANNEL_PRIVATE') return 'Группа/канал приватные или доступ закрыт для вашего аккаунта.'
	if (r === 'PEER_ID_INVALID') return 'Telegram не распознаёт адрес группы: часто это устаревшая ссылка на чат.'
	if (r === 'WA_NOT_CONNECTED' || r === 'ETIMEDOUT') return 'Связь с WhatsApp была нестабильна. Сообщение не отправилось в этот момент и было отложено.'
	return 'Системе не удалось отправить сообщение в группу. Проверьте подключение канала, права и актуальность группы.'
}

export default function GroupsPage() {
	const router = useRouter()
	const loader = useGlobalLoader()

	const [userId, setUserId] = useState<string>('')
	const [loadingMe, setLoadingMe] = useState(false)
	const [loadingGroups, setLoadingGroups] = useState(false)
	const [syncing, setSyncing] = useState(false)
	const [savingMap, setSavingMap] = useState<Record<string, boolean>>({})
	const [groups, setGroups] = useState<GroupRow[]>([])
	const [avatarMap, setAvatarMap] = useState<Record<string, string | null>>({})
	const [avatarLoading, setAvatarLoading] = useState<Record<string, boolean>>({})
	const [q, setQ] = useState('')
	const [totalGroups, setTotalGroups] = useState(0)
	const [loadingMore, setLoadingMore] = useState(false)
	const [hasMore, setHasMore] = useState(false)
	const [loadedCount, setLoadedCount] = useState(0) // Счетчик загруженных групп для правильного offset
	const [animatedCount, setAnimatedCount] = useState(0) // Плавно увеличивающийся счетчик для отображения
	const [syncInfo, setSyncInfo] = useState<string | null>(null)
	const [lastSyncAt, setLastSyncAt] = useState<number | null>(null)
	const [waPhoneFilter, setWaPhoneFilter] = useState<string>('')
	const [phones, setPhones] = useState<string[]>([])
	const [waConnected, setWaConnected] = useState<boolean | null>(null)
	const [groupDeliverySummary, setGroupDeliverySummary] = useState<Record<string, GroupDeliverySummary>>({})
	const [summaryMeta, setSummaryMeta] = useState<{ cacheHit: boolean; fetchedAtMs: number | null }>({
		cacheHit: false,
		fetchedAtMs: null,
	})
	const [openInfoJid, setOpenInfoJid] = useState<string | null>(null)
	const closeInfoLockRef = useRef<string | null>(null)
	const [summaryLoadingByJid, setSummaryLoadingByJid] = useState<Record<string, boolean>>({})
	const LAST_SYNC_KEY = 'wa_groups_last_sync'
	const WA_FILTER_KEY = 'wa_groups_phone_filter'
	const WA_FILTER_ALL = '__ALL__'
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	const animationFrameRef = useRef<number | null>(null)
	const loadingMeStartedRef = useRef(false)
	const loadingGroupsStartedRef = useRef(false)
	const defaultWaFilterUserIdRef = useRef<string | null>(null)
	const BATCH_SIZE = 50 // Загружаем по 50 групп за раз для более быстрой загрузки
	const NAMES_REFRESH_INTERVAL_MS = 10000
	const REFRESH_NAMES_MAX_LIMIT = 150 // Не запрашивать больше при фоновом обновлении названий — снижает нагрузку
	const AVATAR_FETCH_CONCURRENCY = 6 // Ограничение параллельных запросов аватарок (щадим WhatsApp API)
	const AVATAR_WARMUP_VISIBLE = 16 // Аватарок в первую очередь при появлении списка
	const FETCH_ME_TIMEOUT_MS = 12000
	const FETCH_GROUPS_TIMEOUT_MS = 18000
	const REFRESH_NAMES_TIMEOUT_MS = 18000
	const AVATAR_FETCH_TIMEOUT_MS = 8000
	const avatarQueueRef = useRef<string[]>([])
	const avatarQueuedSetRef = useRef(new Set<string>())
	const avatarInFlightCountRef = useRef(0)
	const avatarMapRef = useRef<Record<string, string | null>>({})
	const avatarLoadingRef = useRef<Record<string, boolean>>({})
	const namesRefreshTimerRef = useRef<number | null>(null)

	// Не вызывать Cookies на сервере (SSR) — document отсутствует
	const token =
		typeof document !== 'undefined' ? (Cookies.get('token') || '') : ''

	const isPlaceholderSubject = (subject: string | null | undefined) => {
		if (!subject) return true
		const s = subject.trim()
		if (!s) return true
		return s.startsWith('Без названия (') && s.endsWith(')')
	}

	useEffect(() => {
		avatarMapRef.current = avatarMap
	}, [avatarMap])

	useEffect(() => {
		avatarLoadingRef.current = avatarLoading
	}, [avatarLoading])

	const fetchWithTimeout = (
		url: string,
		opts: RequestInit & { timeoutMs?: number } = {},
	): Promise<Response> => {
		const { timeoutMs = 15000, ...rest } = opts
		const ctrl = new AbortController()
		const t = setTimeout(() => ctrl.abort(), timeoutMs)
		return fetch(url, { ...rest, signal: ctrl.signal }).finally(() => clearTimeout(t))
	}

	const fetchGroupAvatar = async (waGroupId: string): Promise<string | null> => {
		if (!userId) return null
		const gid = String(waGroupId || '').trim()
		if (!gid) return null

		try {
			const url = `${BACKEND_URL}/whatsapp/group-avatar/${userId}?wa_group_id=${encodeURIComponent(gid)}`
			const res = await fetchWithTimeout(url, {
				cache: 'no-store',
				timeoutMs: AVATAR_FETCH_TIMEOUT_MS,
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) return null
			const u = String(json.url || '').trim()
			return u ? u : null
		} catch {
			return null
		}
	}

	const runAvatarQueue = () => {
		if (!userId) return
		while (
			avatarInFlightCountRef.current < AVATAR_FETCH_CONCURRENCY &&
			avatarQueueRef.current.length > 0
		) {
			const gid = avatarQueueRef.current.shift()
			if (!gid) continue
			avatarQueuedSetRef.current.delete(gid)
			if (avatarMapRef.current[gid] !== undefined) continue
			if (avatarLoadingRef.current[gid]) continue

			avatarInFlightCountRef.current += 1
			setAvatarLoading(prev => ({ ...prev, [gid]: true }))

			void fetchGroupAvatar(gid)
				.then(url => {
					setAvatarMap(prev => ({ ...prev, [gid]: url }))
				})
				.finally(() => {
					avatarInFlightCountRef.current = Math.max(
						0,
						avatarInFlightCountRef.current - 1,
					)
					setAvatarLoading(prev => ({ ...prev, [gid]: false }))
					runAvatarQueue()
				})
		}
	}

	const ensureAvatar = (waGroupId: string) => {
		if (!userId) return
		const gid = String(waGroupId || '').trim()
		if (!gid) return
		if (avatarMapRef.current[gid] !== undefined) return
		if (avatarLoadingRef.current[gid]) return
		if (avatarQueuedSetRef.current.has(gid)) return

		avatarQueuedSetRef.current.add(gid)
		avatarQueueRef.current.push(gid)
		runAvatarQueue()
	}

	const GroupAvatar = ({ waGroupId, name }: { waGroupId: string; name: string }) => {
		const ref = useRef<HTMLDivElement>(null)
		const [isVisible, setIsVisible] = useState(false)

		useEffect(() => {
			const el = ref.current
			if (!el || isVisible) return

			const root = scrollContainerRef.current || null
			const obs = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) {
							setIsVisible(true)
							obs.disconnect()
							return
						}
					}
				},
				{ root, rootMargin: '160px 0px', threshold: 0.01 },
			)
			obs.observe(el)
			return () => obs.disconnect()
		}, [isVisible])

		useEffect(() => {
			if (!isVisible) return
			if (!userId) return
			if (avatarMap[waGroupId] !== undefined) return
			if (avatarLoading[waGroupId]) return
			ensureAvatar(waGroupId)
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [isVisible, waGroupId, userId, avatarMap[waGroupId], avatarLoading[waGroupId]])

		const url = avatarMap[waGroupId]
		const letter = (name || 'Г').trim().slice(0, 1).toUpperCase()

		return (
			<div ref={ref} className={styles.avatar} aria-hidden='true'>
				{url ? (
					<img
						className={styles.avatarImg}
						src={url}
						alt=''
						onError={() => setAvatarMap(prev => ({ ...prev, [waGroupId]: null }))}
					/>
				) : (
					<span className={styles.avatarFallback}>{letter}</span>
				)}
			</div>
		)
	}

	const fetchMe = async () => {
		setLoadingMe(true)
		try {
			const res = await fetchWithTimeout(`${BACKEND_URL}/auth/me`, {
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
				timeoutMs: FETCH_ME_TIMEOUT_MS,
			})
			let data: MeResponse
			try {
				data = await res.json()
			} catch {
				message.error('Неверный ответ сервера при получении профиля')
				return
			}
			if (!data.success) {
				message.error(data.message || 'Не удалось получить /auth/me')
				return
			}
			if (!res.ok) {
				message.error('Ошибка сервера при получении профиля')
				return
			}
			setUserId(data.user.id)
		} catch (e: unknown) {
			const isAbort = e instanceof Error && e.name === 'AbortError'
			console.error('[Groups] fetchMe error', e)
			message.error(
				isAbort
					? 'Таймаут загрузки профиля. Проверьте сеть и попробуйте снова.'
					: 'Ошибка сети при получении /auth/me',
			)
		} finally {
			setLoadingMe(false)
		}
	}

	type WaAccountInfo = { connected: boolean; wa_id?: string }
	const fetchWaAccountInfo = async (uid: string): Promise<WaAccountInfo> => {
		try {
			const res = await fetchWithTimeout(
				`${BACKEND_URL}/whatsapp/account-info/${uid}`,
				{ cache: 'no-store', timeoutMs: 8000, headers: token ? { Authorization: `Bearer ${token}` } : {} }
			)
			const data: { success?: boolean; connected?: boolean; wa_id?: string } = await res.json().catch(() => ({}))
			const connected = !!(data?.success && data.connected === true)
			const wa_id = typeof data?.wa_id === 'string' && data.wa_id.trim() ? data.wa_id.trim() : undefined
			return { connected, wa_id }
		} catch {
			return { connected: false }
		}
	}

	const fetchPhones = async (uid: string) => {
		if (!uid) return
		try {
			const res = await fetchWithTimeout(
				`${BACKEND_URL}/whatsapp/groups/${uid}/phones`,
				{ cache: 'no-store', timeoutMs: 8000, headers: token ? { Authorization: `Bearer ${token}` } : {} }
			)
			const json: { success?: boolean; phones?: string[] } = await res.json().catch(() => ({}))
			if (json?.success && Array.isArray(json.phones)) {
				setPhones(json.phones)
			} else {
				setPhones([])
			}
		} catch {
			setPhones([])
		}
	}

	const fetchGroups = async (uid: string, reset = true, waPhone?: string) => {
		if (!uid) return
		if (reset) {
			setLoadingGroups(true)
			setGroups([])
			setLoadedCount(0)
			setAnimatedCount(0) // Сбрасываем анимированный счетчик
			lastAutoLoadRef.current = 0 // Сбрасываем счетчик при новой загрузке
		} else {
			setLoadingMore(true)
		}

		try {
			const offset = reset ? 0 : loadedCount
			const params = new URLSearchParams({ limit: String(BATCH_SIZE), offset: String(offset) })
			if (waPhone && waPhone.trim()) params.set('waPhone', waPhone.trim())
			const url = `${BACKEND_URL}/whatsapp/groups/${uid}?${params.toString()}`

			const res = await fetchWithTimeout(url, {
				cache: 'no-store',
				timeoutMs: FETCH_GROUPS_TIMEOUT_MS,
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			let data: GroupsResponse
			try {
				data = await res.json()
			} catch {
				message.error('Неверный ответ сервера при загрузке групп')
				return
			}
			if (data.success) {
				const raw = data.groups
				const next = Array.isArray(raw) ? raw : []
				const total = data.total ?? 0
				const hasMoreData = data.hasMore ?? false

				// Дедупликация: убираем группы с одинаковым wa_group_id
				const uniqueNext = next.filter((group: GroupRow, index: number, self: GroupRow[]) =>
					index === self.findIndex((g: GroupRow) => g.wa_group_id === group.wa_group_id)
				)

				if (reset) {
					setGroups(uniqueNext)
					setLoadedCount(uniqueNext.length)
					animateCount(0, uniqueNext.length)
					// Ставим аватарки в очередь с небольшой задержкой, чтобы таблица успела отрисоваться
					uniqueNext.slice(0, AVATAR_WARMUP_VISIBLE).forEach((g: GroupRow) => {
						const gid = g?.wa_group_id
						if (gid && !avatarQueuedSetRef.current.has(gid)) {
							avatarQueuedSetRef.current.add(gid)
							avatarQueueRef.current.push(gid)
						}
					})
					setTimeout(() => runAvatarQueue(), 80)
				} else {
					setGroups(prev => {
						const p = prev ?? []
						const existingIds = new Set(p.map(g => g.wa_group_id))
						const newGroups = uniqueNext.filter((g: GroupRow) => !existingIds.has(g.wa_group_id))
						const newTotal = p.length + newGroups.length
						setLoadedCount(newTotal)
						animateCount(p.length, newTotal)
						newGroups.slice(0, AVATAR_WARMUP_VISIBLE).forEach((g: GroupRow) => {
							const gid = g?.wa_group_id
							if (gid && !avatarQueuedSetRef.current.has(gid)) {
								avatarQueuedSetRef.current.add(gid)
								avatarQueueRef.current.push(gid)
							}
						})
						setTimeout(() => runAvatarQueue(), 80)
						return [...p, ...newGroups]
					})
				}

				setTotalGroups(total)
				setHasMore(hasMoreData)
				return uniqueNext.length
			}
			const msg = (data as any).message
			message.error(msg ? `Группы: ${msg}` : 'Не удалось загрузить группы из БД')
		} catch (e: unknown) {
			const isAbort = e instanceof Error && e.name === 'AbortError'
			console.error('[Groups] fetchGroups error', e)
			message.error(
				isAbort
					? 'Таймаут загрузки групп. Проверьте сеть и попробуйте снова.'
					: 'Ошибка сети при загрузке групп. Проверьте подключение.',
			)
		} finally {
			setLoadingGroups(false)
			setLoadingMore(false)
		}
	}

	const refreshGroupNames = async () => {
		if (!userId) return
		const list = Array.isArray(groups) ? groups : []
		if (!list.length) return

		try {
			const limit = Math.min(
				Math.max(loadedCount || list.length || BATCH_SIZE, BATCH_SIZE),
				REFRESH_NAMES_MAX_LIMIT,
			)
			const params = new URLSearchParams({ limit: String(limit), offset: '0' })
			if (waPhoneFilter?.trim()) params.set('waPhone', waPhoneFilter.trim())
			const url = `${BACKEND_URL}/whatsapp/groups/${userId}?${params.toString()}`

			const res = await fetchWithTimeout(url, {
				cache: 'no-store',
				timeoutMs: REFRESH_NAMES_TIMEOUT_MS,
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})

			let data: GroupsResponse
			try {
				data = await res.json()
			} catch {
				return
			}
			if (!('success' in data) || !data.success) return

			const raw = data.groups
			const fresh = Array.isArray(raw) ? raw : []
			if (!fresh.length) return

			const placeholdersBefore = list.filter(g =>
				isPlaceholderSubject(g.subject)
			).length

			const freshMap = new Map(fresh.map((g: GroupRow) => [g.wa_group_id, g]))
			let updatedNames = 0

			const merged = list.map((old: GroupRow) => {
				const newer = freshMap.get(old.wa_group_id)
				if (!newer) return old

				const oldSubj = (old?.subject || '').trim()
				const newSubj = (newer?.subject || '').trim()
				const oldIsPlaceholder = isPlaceholderSubject(old.subject)
				const newIsReal = !!newSubj && !isPlaceholderSubject(newer.subject)

				if (oldIsPlaceholder && newIsReal && newSubj !== oldSubj) {
					updatedNames += 1
				}

				return { ...old, ...newer }
			})

			if (updatedNames > 0) {
				setGroups(merged)
				message.success(`Названия обновлены у групп: ${updatedNames}`)
				const dynamicLines: string[] = []
				dynamicLines.push(
					`• Названия дополнительно обновлены у групп: ${updatedNames}.`,
				)
				dynamicLines.push(
					'• Точный остаток без названия не пересчитываем по частично загруженному списку, чтобы не показывать ложные скачки.',
				)
				setSyncInfo(dynamicLines.join('\n'))
			}
		} catch (e: unknown) {
			if (e instanceof Error && e.name !== 'AbortError') {
				console.error('[Groups] refreshGroupNames error', e)
			}
		}
	}

	const loadMoreGroups = () => {
		if (!userId || loadingMore || !hasMore || loadingGroups) return
		fetchGroups(userId, false, waPhoneFilter || undefined)
	}

	const stopNamesAutoRefresh = () => {
		if (namesRefreshTimerRef.current !== null) {
			window.clearInterval(namesRefreshTimerRef.current)
			namesRefreshTimerRef.current = null
		}
	}

	const startNamesAutoRefresh = () => {
		if (namesRefreshTimerRef.current !== null) return
		namesRefreshTimerRef.current = window.setInterval(() => {
			void refreshGroupNames()
		}, NAMES_REFRESH_INTERVAL_MS)
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

	// Автоматическая загрузка следующих порций параллельно с отображением первой
	// Используем ref для отслеживания последней загруженной порции, чтобы избежать дубликатов
	const lastAutoLoadRef = useRef(0)
	
	useEffect(() => {
		if (!userId || loadingMore || loadingGroups || !hasMore || groups.length === 0) return
		
		// Если загружена первая порция и есть еще группы - начинаем загрузку следующей
		// Проверяем, что количество групп изменилось с последней автозагрузки
		if (groups.length > 0 && groups.length < totalGroups && hasMore && groups.length !== lastAutoLoadRef.current) {
			lastAutoLoadRef.current = groups.length
			const timer = setTimeout(() => {
				if (hasMore && !loadingMore && !loadingGroups) {
					loadMoreGroups()
				}
			}, 100)
			return () => clearTimeout(timer)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hasMore, groups.length, totalGroups, userId])

	// Очистка анимации при размонтировании
	useEffect(() => {
		return () => {
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current)
			}
			stopNamesAutoRefresh()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	useEffect(() => {
		if (!userId) {
			stopNamesAutoRefresh()
			return
		}

		// Не дёргаем автообновление, пока сама загрузка/синк в прогрессе
		if (loadingGroups || loadingMore || syncing) {
			return
		}

		const hasPlaceholders = Array.isArray(groups) && groups.some(g => isPlaceholderSubject(g.subject))
		if (hasPlaceholders) {
			startNamesAutoRefresh()
		} else {
			stopNamesAutoRefresh()
		}
	}, [groups, userId, loadingGroups, loadingMore, syncing])

	const syncGroups = async () => {
		if (!userId) return message.warning('Нет userId — перелогиньтесь')
		setSyncing(true)
		setSyncInfo('Синхронизируем группы и подтягиваем названия…')
		try {
			const res = await fetch(`${BACKEND_URL}/whatsapp/sync-groups`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({ userId }),
			})
			const data: any = await res.json().catch(() => null)
			if (!data?.success) {
				if (data.message === 'whatsapp_not_connected') {
					message.error(
						'WhatsApp не подключён. Сейчас откроем страницу подключения.'
					)
					loader?.show?.('Подключение WhatsApp…')
					router?.push?.('/cabinet#whatsapp')
				} else if (data.message === 'whatsapp_session_busy') {
					const busyText =
						'WhatsApp сейчас занят активной отправкой. Список групп уже доступен из базы, повторите синхронизацию позже.'
					message.warning(busyText)
					setSyncInfo(busyText)
					await fetchGroups(userId, true, waPhoneFilter || undefined)
					await fetchPhones(userId)
				} else {
					message.error(`Ошибка синка групп: ${data.message || 'unknown'}`)
				}
				if (data.message !== 'whatsapp_session_busy') setSyncInfo(null)
				return;
			}

			const {
				count,
				apiEntries,
				repairedSubject,
				remainingMissingSubject,
			} = data

			const lines: string[] = []

			const totalLineBase = `• Групп в базе: ${count ?? 0}`
			if (typeof apiEntries === 'number') {
				lines.push(`${totalLineBase} (в WhatsApp найдено: ${apiEntries})`)
			} else {
				lines.push(totalLineBase)
			}

			// Блок про названия: показываем смысл, а не только число.
			if (typeof remainingMissingSubject === 'number' && remainingMissingSubject > 0) {
				lines.push(`• Без названия осталось: ${remainingMissingSubject}. Фоновая обработка продолжит попытки, если WhatsApp вернёт имя.`)
				if (typeof repairedSubject === 'number') {
					lines.push(`• Названия обновлены: ${repairedSubject}`)
				}
			} else if (typeof remainingMissingSubject === 'number' && remainingMissingSubject === 0) {
				if (typeof repairedSubject === 'number') {
					lines.push(
						repairedSubject > 0 ? `• Названия обновлены: ${repairedSubject}` : '• Названия есть у всех групп (исправлять нечего).',
					)
				} else {
					lines.push('• Названия есть у всех групп.')
				}
			} else if (typeof repairedSubject === 'number') {
				lines.push(`• Названия обновлены: ${repairedSubject}`)
			}

			lines.push('• Счётчики участников сейчас не обновляются (мы не считаем их в этом режиме).')

			const human = lines.join('\n')

			message.success(human)
			setSyncInfo(human)
			const now = Date.now()
			setLastSyncAt(now)
			if (typeof localStorage !== 'undefined') {
				try {
					localStorage.setItem(`${LAST_SYNC_KEY}_${userId}`, String(now))
				} catch {}
			}
			await fetchGroups(userId, true, waPhoneFilter || undefined) // Перезагружаем с начала
			await fetchPhones(userId)
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при /whatsapp/sync-groups')
			setSyncInfo('Сбой при синхронизации групп. Попробуйте ещё раз.')
			// Всё равно подтягиваем то, что есть в БД
			if (userId) await fetchGroups(userId, true, waPhoneFilter || undefined)
		} finally {
			setSyncing(false)
		}
	}

	const setSelected = async (waGroupId: string, next: boolean) => {
		if (!userId) return

		setGroups(prev =>
			prev.map(g =>
				g.wa_group_id === waGroupId ? { ...g, is_selected: next } : g
			)
		)
		setSavingMap(prev => ({ ...prev, [waGroupId]: true }))

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 секунд таймаут

			const res = await fetch(`${BACKEND_URL}/whatsapp/groups/select`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({
					userId,
					wa_group_id: waGroupId,
					is_selected: next,
				}),
				signal: controller.signal,
			})
			clearTimeout(timeoutId)

			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: ${res.statusText}`)
			}

			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				message.error(
					`Не удалось сохранить выбор группы: ${json?.message || 'unknown'}`
				)
				setGroups(prev =>
					prev.map(g =>
						g.wa_group_id === waGroupId ? { ...g, is_selected: !next } : g
					)
				)
			}
		} catch (e: any) {
			console.error('Error saving group selection:', e)
			if (e.name === 'AbortError') {
				message.error('Таймаут запроса. Попробуйте ещё раз.')
			} else {
				message.error('Ошибка сети при сохранении выбора группы')
			}
			setGroups(prev =>
				prev.map(g =>
					g.wa_group_id === waGroupId ? { ...g, is_selected: !next } : g
				)
			)
		} finally {
			setSavingMap(prev => ({ ...prev, [waGroupId]: false }))
		}
	}

	const setSelectedBatch = async (waGroupIds: string[], isSelected: boolean) => {
		if (!userId || !waGroupIds.length) return

		// Оптимистично обновляем UI
		setGroups(prev =>
			prev.map(g =>
				waGroupIds.includes(g.wa_group_id) ? { ...g, is_selected: isSelected } : g
			)
		)

		// Устанавливаем состояние загрузки для всех групп
		const savingMapUpdate: Record<string, boolean> = {}
		waGroupIds.forEach(id => { savingMapUpdate[id] = true })
		setSavingMap(prev => ({ ...prev, ...savingMapUpdate }))

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 секунд для батча

			const res = await fetch(`${BACKEND_URL}/whatsapp/groups/select-batch`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({
					userId,
					wa_group_ids: waGroupIds,
					is_selected: isSelected,
				}),
				signal: controller.signal,
			})
			clearTimeout(timeoutId)

			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: ${res.statusText}`)
			}

			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				message.error(
					`Не удалось сохранить выбор групп: ${json?.message || 'unknown'}`
				)
				// Откатываем изменения
				setGroups(prev =>
					prev.map(g =>
						waGroupIds.includes(g.wa_group_id) ? { ...g, is_selected: !isSelected } : g
					)
				)
			} else {
				message.success(`Обновлено групп: ${json.updated || waGroupIds.length}`)
			}
		} catch (e: any) {
			console.error('Error saving batch group selection:', e)
			if (e.name === 'AbortError') {
				message.error('Таймаут запроса. Попробуйте ещё раз.')
			} else {
				message.error('Ошибка сети при сохранении выбора групп')
			}
			// Откатываем изменения
			setGroups(prev =>
				prev.map(g =>
					waGroupIds.includes(g.wa_group_id) ? { ...g, is_selected: !isSelected } : g
				)
			)
		} finally {
			// Снимаем состояние загрузки
			const savingMapUpdate: Record<string, boolean> = {}
			waGroupIds.forEach(id => { savingMapUpdate[id] = false })
			setSavingMap(prev => {
				const next = { ...prev }
				waGroupIds.forEach(id => { delete next[id] })
				return next
			})
		}
	}

	const selectAll = async (val: boolean) => {
		const list = Array.isArray(groups) ? groups : []
		const toChange = list.filter(
			g => !g.is_announcement && (g.is_selected !== val)
		)
		if (!toChange.length) return

		const ids = toChange.map(g => g.wa_group_id)

		// Используем батч запрос вместо последовательных
		await setSelectedBatch(ids, val)
	}

	useEffect(() => {
		loader?.hide?.()
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
			const accountInfo = await fetchWaAccountInfo(userId)
			setWaConnected(accountInfo.connected)
			if (!accountInfo.connected) return
			const currentPhoneE164 = accountInfo.wa_id
				? (accountInfo.wa_id.startsWith('+') ? accountInfo.wa_id : `+${accountInfo.wa_id}`)
				: ''
			// По умолчанию фильтр = текущий номер (только при первой загрузке для этого userId), чтобы не показывать группы со старых телефонов
			const isFirstLoadForUser = defaultWaFilterUserIdRef.current !== userId
			let firstLoadFilter = waPhoneFilter?.trim() || ''
			if (isFirstLoadForUser) {
				let savedFilter = ''
				if (typeof localStorage !== 'undefined') {
					try {
						const rawSaved = localStorage.getItem(`${WA_FILTER_KEY}_${userId}`)
						if (rawSaved === WA_FILTER_ALL) {
							savedFilter = ''
						} else if (rawSaved && rawSaved.trim()) {
							savedFilter = rawSaved.trim()
						}
					} catch {}
				}

				firstLoadFilter = savedFilter || currentPhoneE164 || ''
				setWaPhoneFilter(firstLoadFilter)
				defaultWaFilterUserIdRef.current = userId
			}
			await fetchPhones(userId)
			const effectiveFilter = isFirstLoadForUser
				? (firstLoadFilter || undefined)
				: (waPhoneFilter?.trim() || undefined)
			const count = await fetchGroups(userId, true, effectiveFilter)
			// Синхронизируем, когда групп нет и смотрим текущий номер или «все номера»
			const viewingCurrentOrAll = !effectiveFilter || effectiveFilter === currentPhoneE164
			if (!count && viewingCurrentOrAll) {
				await syncGroups()
				await fetchGroups(userId, true, effectiveFilter)
			}
		})()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId, waPhoneFilter])

	const loadGroupSummary = async (waGroupId: string, force = false) => {
		if (!token) return
		const hasLocal = !!groupDeliverySummary[waGroupId]
		if (
			!force &&
			hasLocal &&
			summaryMeta.fetchedAtMs &&
			Date.now() - summaryMeta.fetchedAtMs < SUMMARY_FRESH_MS
		) {
			return
		}
		setSummaryLoadingByJid(prev => ({ ...prev, [waGroupId]: true }))
		try {
			const res = await fetchGroupDeliverySummary({
				backendUrl: BACKEND_URL,
				token,
				channel: 'wa',
				groupJids: [waGroupId],
				lookbackDays: 14,
				includeTemplatesIncluded: true,
				bypassCache: force,
			})
			setGroupDeliverySummary(prev => ({ ...prev, ...res.summaries }))
			setSummaryMeta({ cacheHit: res.meta.cacheHit, fetchedAtMs: res.meta.fetchedAtMs })
		} finally {
			setSummaryLoadingByJid(prev => ({ ...prev, [waGroupId]: false }))
		}
	}

	useEffect(() => {
		if (!userId) return
		if (typeof localStorage === 'undefined') return
		try {
			const value = waPhoneFilter?.trim() || WA_FILTER_ALL
			localStorage.setItem(`${WA_FILTER_KEY}_${userId}`, value)
		} catch {}
	}, [userId, waPhoneFilter])

	// При возврате на вкладку — обновить статус WA (чтобы «словился» после кабинета)
	useEffect(() => {
		const onFocus = () => {
			if (userId) {
				fetchWaAccountInfo(userId).then((info) => setWaConnected(info.connected))
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

	const filtered = useMemo(() => {
		const list = Array.isArray(groups) ? groups : []
		const s = q.trim().toLowerCase()
		let result = list

		if (s) {
			result = list.filter(g => {
				const subj = (g?.subject || '').toLowerCase()
				const id = (g?.wa_group_id || '').toLowerCase()
				return subj.includes(s) || id.includes(s)
			})
		}

		const seen = new Set<string>()
		const deduped = result.filter(g => {
			const id = g?.wa_group_id
			if (!id || seen.has(id)) return false
			seen.add(id)
			return true
		})
		return [...deduped].sort((a, b) => {
			const aSel = a?.is_selected !== false && !a?.is_announcement
			const bSel = b?.is_selected !== false && !b?.is_announcement
			if (aSel && !bSel) return -1
			if (!aSel && bSel) return 1
			const aPlaceholder = isPlaceholderSubject(a?.subject)
			const bPlaceholder = isPlaceholderSubject(b?.subject)
			if (aPlaceholder && !bPlaceholder) return 1
			if (!aPlaceholder && bPlaceholder) return -1
			return 0
		})
	}, [groups, q])

	const safeGroups = Array.isArray(groups) ? groups : []
	const total = totalGroups || safeGroups.length
	// Считаем только не-announcement группы как выбранные
	const selectedCount = safeGroups.filter(g => g.is_selected !== false && !g.is_announcement).length

	const columns: ColumnsType<GroupRow> = [
		{
			title: 'Группа',
			key: 'group',
			render: (_: any, row: GroupRow) => {
				if (!row?.wa_group_id) return null
				const checked = row.is_selected !== false
				const busy = !!savingMap[row.wa_group_id]
				const title = row.subject && row.subject.trim() ? row.subject.trim() : row.wa_group_id
				const nameForAvatar = row.subject && row.subject.trim() ? row.subject.trim() : 'Группа'
				const summary = groupDeliverySummary[row.wa_group_id]
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
									closeInfoLockRef.current = row.wa_group_id
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
									void loadGroupSummary(row.wa_group_id, true)
								}}
							>
								{summaryLoadingByJid[row.wa_group_id] ? '…' : 'Обновить'}
							</button>
						</div>
					</div>
				)
				return (
					<div className={styles.rowContent}>
						<div className={styles.rowLeft}>
							{row.is_announcement ? (
								<div
									className={`${styles.customCheckbox} ${styles.announcementBox}`}
									title='Группа только для объявлений: рассылка в неё недоступна'
								>
									<span className={styles.announcementIcon}>✕</span>
								</div>
							) : (
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
							)}
							<GroupAvatar waGroupId={row.wa_group_id} name={nameForAvatar} />
							<Popover
								content={infoContent}
								trigger='click'
								placement='rightTop'
								open={openInfoJid === row.wa_group_id}
								onOpenChange={(open) => {
									if (open) {
										if (closeInfoLockRef.current === row.wa_group_id) {
											closeInfoLockRef.current = null
											return
										}
										setOpenInfoJid(row.wa_group_id)
										void loadGroupSummary(row.wa_group_id, false)
									} else if (openInfoJid === row.wa_group_id) {
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
								<div className={styles.rowTitle}>{title}</div>
								{row.last_send_error && !(waConnected === true && row.last_send_error === 'wa_not_connected') ? (
									<span className={styles.rowRestriction} title={String(row.last_send_error)}>
										⚠ {errorMeaning(row.last_send_error)}
									</span>
								) : null}
								<span className={styles.rowIdUnder} title={row.wa_group_id}>
									{row.wa_group_id}
								</span>
							</div>
						</div>
						<div className={styles.rowRight}>
							{row.is_announcement ? (
								<button type='button' className={styles.selectToggleBtn} disabled>
									Недоступно
								</button>
							) : (
								<button
									type='button'
									className={`${styles.selectToggleBtn} ${checked ? styles.selectToggleBtnActive : ''}`}
									disabled={busy}
									onMouseDown={(e) => e.stopPropagation()}
									onClick={(e) => {
										e.stopPropagation()
										setSelected(row.wa_group_id, !checked)
									}}
								>
									{checked ? '✓ Выбрано' : 'Выбрать'}
								</button>
							)}
						</div>
					</div>
				)
			},
		},
	]

	return (
		<div className='grp'>
			<div className={`${styles.page} grp__content`}>
				<div className={styles.container}>
				{userId && waConnected === false && (
					<div className={styles.notConnectedBlock}>
						WhatsApp не подключён. Подключите его в{' '}
						<Link href='/cabinet#whatsapp'>личном кабинете</Link>.
					</div>
				)}
				<div className={`${styles.panel} grp-panel`}>
					<div className={styles.panelTop}>
						<div className={styles.panelActions}>
							<Space wrap>
								{phones.length > 1 && (
									<div className={styles.phoneFilterWrap}>
										<span className={styles.phoneFilterLabel}>Номер WA:</span>
										<Select
											value={waPhoneFilter || undefined}
											onChange={(v) => setWaPhoneFilter(v ?? '')}
											placeholder="Все номера"
											allowClear
											style={{ minWidth: 180 }}
											options={[
												{ value: '', label: 'Все номера' },
												...phones.map((p) => ({ value: p, label: p })),
											]}
										/>
									</div>
								)}
								<Button
									className={styles.actionBtn}
									type='primary'
									onClick={syncGroups}
									disabled={!userId || syncing || waConnected === false}
									title={waConnected === false ? 'Сначала подключите WhatsApp в личном кабинете' : 'Синхронизировать список групп с WhatsApp'}
								>
									{syncing ? 'Синхронизируем…' : 'Синхронизация'}
								</Button>
								<Button
									className={styles.actionBtn}
									onClick={() => selectAll(true)}
									disabled={!userId || !safeGroups.length}
								>
									Выбрать все
								</Button>
								<Button
									className={styles.actionBtn}
									onClick={() => selectAll(false)}
									disabled={!userId || !safeGroups.length}
								>
									Снять все
								</Button>
							</Space>
						</div>
						{phones.length > 1 && waConnected === true && (
							<div className={styles.groupsHint}>
								Сохранённые группы не удаляются при отключении номера. Можно подключать несколько WhatsApp по очереди и выбирать номер в фильтре «Номер WA».
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
								<b>Группы:</b>{' '}
								{total > 0 ? (
									<>
										<span className={styles.counterText}>
											{animatedCount}/{total}
										</span>
										<span className={styles.counterMeta}>
											{(loadingGroups || loadingMore) && (
												<span className={styles.loadingSpinner} aria-hidden />
											)}
											{hasMore &&
												!loadingMore &&
												!loadingGroups &&
												safeGroups.length < total && (
													<span className={styles.counterSub}>
														· загружаем ещё
													</span>
												)}
											{!syncing &&
												safeGroups.some(g => isPlaceholderSubject(g.subject)) && (
													<span
														className={styles.counterSub}
														title='Названия без имени обновляются по таймеру'
													>
														· названия обновляются в фоне
													</span>
												)}
										</span>
									</>
								) : (
									<span className={styles.counterText}>0</span>
								)}
							</div>
							<div className={styles.counterRow}>
								<b>Выбрано:</b> {selectedCount}
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
							{total === 0 && !loadingGroups && userId && waConnected !== false && (
								<div
									className={styles.counterRow}
									style={{ color: '#666', fontSize: 13 }}
								>
									Нажмите «Синхронизация», чтобы обновить список с
									WhatsApp.
								</div>
							)}
							{syncInfo && (
								<div
									className={styles.counterRow}
									style={{ fontSize: 12, color: '#666' }}
								>
									<b>Статус синхронизации:</b>
									{syncing ? ' идёт…' : null}
									<div>
										{syncInfo.split('\n').map((line, idx) => (
											<div key={idx}>{line}</div>
										))}
									</div>
								</div>
							)}
							{q.trim() && (
								<div className={styles.counterRow}>
									<b>Найдено по фильтру:</b> {filtered.length}
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
								rowKey='wa_group_id'
								columns={columns}
								dataSource={filtered}
								loading={loadingMe || loadingGroups}
								pagination={false}
								locale={{
									emptyText: (
										<div className={styles.tableEmptyText}>
											{!userId
												? 'Загрузка…'
												: waConnected === false
													? 'Подключите WhatsApp в личном кабинете.'
													: loadingGroups
														? 'Загружаем группы…'
														: 'Нет групп. Нажмите «Синхронизация» для обновления списка с WhatsApp.'}
										</div>
									),
								}}
								onRow={(record) => {
									if (!record?.wa_group_id) return {}
									const r = record as GroupRow
									return {
										className: `${styles.tableRow} ${r.is_selected !== false ? styles.rowSelected : ''} ${r.is_announcement ? styles.rowDisabled : ''}`,
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
