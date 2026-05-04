'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Cookies from 'js-cookie'
import {
	Button,
	Form,
	Input,
	InputNumber,
	Switch,
	Dropdown,
	Modal,
	message,
	Upload,
	Popconfirm,
	Popover,
	Tooltip,
	Segmented,
	Select,
	Table,
	Slider,
	TimePicker,
	Tag,
} from 'antd'
import type { UploadProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { apiGet, apiPost, getApiErrorMessage } from '@/lib/api'
import { fetchGroupDeliverySummary, type GroupDeliverySummary } from '@/lib/groupDeliverySummary'
import { htmlToMarkdown, markdownToHtml } from '@/lib/templateEditorMarkdown'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { SEND_INTERVAL_OPTIONS } from '@/constants/sendIntervals'
import { ChannelIcon } from '@/components/ChannelIcon'
import { MediaViewerModal } from '@/components/MediaViewerModal'
import Image from 'next/image'
import dayjs from 'dayjs'
import './page.css'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'
import {
	clampPausePairFromFormValues,
	clampTemplatePauseSecPair,
	readTemplatePausePairFromApi,
	TEMPLATE_FORM_DEFAULT_PAUSE,
} from '@/lib/templateBetweenGroupsRange'
import { pluralRuGroups } from '@/lib/pluralRu'

const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
const SUMMARY_FRESH_MS = 30_000

/** Лимит символов в одном сообщении (Telegram и WhatsApp) */
const MAX_MESSAGE_CHARS = 4096

/** Длинные тела (текст + много групп) — стандартный 20s таймаут даёт ложную «ошибку сети». */
const TEMPLATE_SAVE_TIMEOUT_MS = 90_000

/** URL картинки эмодзи через Twemoji CDN (все смайлики как графика) */
function getTwemojiUrl(emoji: string): string {
	try {
		const codePoints = [...emoji].map(c => (c.codePointAt(0) ?? 0).toString(16)).filter(Boolean).join('-')
		if (!codePoints) return ''
		return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/${codePoints}.png`
	} catch {
		return ''
	}
}

function isVideoUrl(url: string | null) {
	if (!url) return false
	const clean = url.split('?')[0] || ''
	return /\.(mp4|mov|m4v)$/i.test(clean)
}

function isAudioUrl(url: string | null) {
	if (!url) return false
	const clean = url.split('?')[0] || ''
	return /\.(mp3|ogg|wav|m4a|webm)$/i.test(clean)
}

function isHHMM(v: any) {
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim())
}

function reasonDescription(reason: string): string {
	const r = String(reason || '').toUpperCase()
	if (r === 'CHANNEL_INVALID') return 'Группа недоступна по текущим данным Telegram. Часто помогает синхронизация.'
	if (r === 'CHAT_WRITE_FORBIDDEN') return 'Нет прав на отправку в эту группу или отправка ограничена.'
	if (r === 'USER_BANNED_IN_CHANNEL') return 'Ваш аккаунт ограничен в этой группе/канале.'
	if (r === 'CHANNEL_PRIVATE') return 'Группа/канал приватные и недоступны для отправки.'
	if (r === 'PEER_ID_INVALID') return 'Ссылка на группу устарела или неверна.'
	if (r === 'WA_NOT_CONNECTED' || r === 'ETIMEDOUT') return 'В момент отправки была проблема со связью WhatsApp.'
	return 'Сообщение не отправилось в эту группу. Проверьте доступ и состояние канала.'
}

type TemplateRow = {
	id: string
	enabled: boolean
	order: number
	title: string | null
	text: string | null
	media_url: string | null
}

type GroupRow = {
	jid: string
	title: string | null
	participants_count: number | null
	is_restricted?: boolean | null
	updated_at: string
	send_time?: string | null
	avatar_url?: string | null
}

/** Нормализует Telegram chat id: -100123 и 123 считаются одной группой, храним в виде -100... */
function normalizeTgChatId(jid: string): string {
	const s = String(jid).trim()
	if (s.startsWith('-100')) return s
	const num = parseInt(s, 10)
	if (!Number.isNaN(num) && num > 0 && num < 1e13) return '-100' + s
	return s
}

export default function TemplateEditPage() {
	const router = useRouter()
	const params = useParams()
	const templateId = String((params as any)?.templateId || '')

	const [userId, setUserId] = useState('')
	const [loadingMe, setLoadingMe] = useState(false)
	const [loadingTpl, setLoadingTpl] = useState(false)
	const [saving, setSaving] = useState(false)
	const [uploading, setUploading] = useState(false)
	const [mediaViewerUrl, setMediaViewerUrl] = useState<string | null>(null)

	const [mediaUrl, setMediaUrl] = useState<string | null>(null)
	const [tgPremiumStatus, setTgPremiumStatus] = useState<{ isPremium: boolean; maxFileSize: number } | null>(null)
	const [editorCharCount, setEditorCharCount] = useState(0)
	const [showEmojiPicker, setShowEmojiPicker] = useState(false)
	const [showContextMenu, setShowContextMenu] = useState(false)
	const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
	const [formatActive, setFormatActive] = useState({
		bold: false,
		italic: false,
		underline: false,
		strike: false,
		unorderedList: false,
		orderedList: false,
	})
	const textAreaRef = useRef<any>(null)
	const editorRef = useRef<HTMLDivElement>(null)
	const emojiPickerRef = useRef<HTMLDivElement>(null)
	const contextMenuRef = useRef<HTMLDivElement>(null)
	const [form] = Form.useForm()

	const tgDefaultSendTime = Form.useWatch('tg_default_send_time', form)
	const waPauseLo = Form.useWatch('wa_between_groups_sec_min', form)
	const waPauseHi = Form.useWatch('wa_between_groups_sec_max', form)
	const tgPauseLo = Form.useWatch('tg_between_groups_sec_min', form)
	const tgPauseHi = Form.useWatch('tg_between_groups_sec_max', form)

	const initialTemplateTimingRef = useRef<{
		wa_between_groups_sec_min: number
		wa_between_groups_sec_max: number
		tg_between_groups_sec_min: number
		tg_between_groups_sec_max: number
		tg_default_send_time: string | null
	} | null>(null)

	const [channel, setChannel] = useState<'wa' | 'tg'>('tg')
	const [groups, setGroups] = useState<GroupRow[]>([])
	const [groupFilterQuery, setGroupFilterQuery] = useState('')
	const [selectedGroupJids, setSelectedGroupJids] = useState<string[]>([])
	const [waSelected, setWaSelected] = useState<string[]>([])
	const [tgSelected, setTgSelected] = useState<string[]>([])
	const [waGroups, setWaGroups] = useState<GroupRow[]>([])
	const [tgGroups, setTgGroups] = useState<GroupRow[]>([])
	const [waAvatarMap, setWaAvatarMap] = useState<Record<string, string | null>>({})
	const [waAvatarLoading, setWaAvatarLoading] = useState<Record<string, boolean>>({})
	const [loadingGroups, setLoadingGroups] = useState(false)
	/** Загрузка списка WA (loadWaGroupsSimple) — для строки «Загружаем…» без дыр в вёрстке */
	const [loadingWaList, setLoadingWaList] = useState(false)
	const [waGroupsLoaded, setWaGroupsLoaded] = useState(false)
	
	// Состояния для пагинации WA групп
	const [waTotalGroups, setWaTotalGroups] = useState(0)
	const [waHasMore, setWaHasMore] = useState(false)
	const [waLoadingMore, setWaLoadingMore] = useState(false)
	const [waLoadedCount, setWaLoadedCount] = useState(0)
	const [waAnimatedCount, setWaAnimatedCount] = useState(0) // Плавно увеличивающийся счетчик для WA
	const waLastAutoLoadRef = useRef(0)
	const waAnimationFrameRef = useRef<number | null>(null)
	
	// Состояния для пагинации TG групп
	const [tgTotalGroups, setTgTotalGroups] = useState(0)
	const [tgTotalRows, setTgTotalRows] = useState(0)
	const [tgHasMore, setTgHasMore] = useState(false)
	const [tgAnimatedCount, setTgAnimatedCount] = useState(0) // Плавно увеличивающийся счетчик для TG
	const tgAnimationFrameRef = useRef<number | null>(null)
	const [tgDbStats, setTgDbStats] = useState<{ total: number; selected: number } | null>(null)

	const BATCH_SIZE = 50 // Размер порции для загрузки
	
	const [waConnected, setWaConnected] = useState<boolean | null>(null)
	const [tgConnected, setTgConnected] = useState<boolean | null>(null)
	/** Общий интервал: значение для кнопки «Применить ко всем выбранным» */
	const [bulkInterval, setBulkInterval] = useState<string | null>(null)
	const [applyingBulkInterval, setApplyingBulkInterval] = useState(false)

	// Override интервала на уровне (шаблон → группа) по каналам
	const [tgTargetOverrides, setTgTargetOverrides] = useState<Record<string, string | null>>({})
	const [groupDeliverySummary, setGroupDeliverySummary] = useState<{
		wa: Record<string, GroupDeliverySummary>
		tg: Record<string, GroupDeliverySummary>
	}>({ wa: {}, tg: {} })
	const [summaryMeta, setSummaryMeta] = useState<{ wa: { cacheHit: boolean; fetchedAtMs: number | null }; tg: { cacheHit: boolean; fetchedAtMs: number | null } }>({
		wa: { cacheHit: false, fetchedAtMs: null },
		tg: { cacheHit: false, fetchedAtMs: null },
	})
	const [openInfoKey, setOpenInfoKey] = useState<string | null>(null)
	const closeInfoLockRef = useRef<string | null>(null)
	
	const loader = useGlobalLoader()
	const templateLoadFinishedRef = useRef(false)
	const groupsReqRef = useRef(0)
	const targetsReqRef = useRef<{ wa: number; tg: number }>({ wa: 0, tg: 0 })

	const token = typeof document !== 'undefined' ? (Cookies.get('token') || '') : ''

	const buildWaAvatarProxyUrl = (waGroupId: string): string | null => {
		if (!userId) return null
		const gid = String(waGroupId || '').trim()
		if (!gid) return null
		return `${BACKEND_URL}/whatsapp/group-avatar-content/${encodeURIComponent(userId)}?wa_group_id=${encodeURIComponent(gid)}`
	}

	const normalizeWaAvatarUrl = (waGroupId: string, rawUrl: string | null | undefined): string | null => {
		const trimmed = String(rawUrl || '').trim()
		if (!trimmed) return null
		if (/^https?:\/\/pps\.whatsapp\.net\//i.test(trimmed)) {
			return buildWaAvatarProxyUrl(waGroupId) || trimmed
		}
		return trimmed
	}

	const fetchWaGroupAvatar = async (waGroupId: string): Promise<string | null> => {
		if (!userId) return null
		const gid = String(waGroupId || '').trim()
		if (!gid) return null

		try {
			const url = `${BACKEND_URL}/whatsapp/group-avatar/${userId}?wa_group_id=${encodeURIComponent(
				gid,
			)}`
			const res = await fetch(url, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) return null
			const u = String(json.url || '').trim()
			return u || null
		} catch {
			return null
		}
	}

	// Простой загрузчик WA-групп без пагинации, как при создании шаблона
	const loadWaGroupsSimple = async (uid: string) => {
		setLoadingWaList(true)
		try {
			const res = await fetch(`${BACKEND_URL}/whatsapp/groups/${uid}?selectedOnly=true`, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				message.error('Не удалось загрузить WA группы')
				setWaGroups([])
				setWaTotalGroups(0)
				setWaHasMore(false)
				return
			}

			// Бэкенд вернул только выбранные (selectedOnly=true). Исключаем только announcement.
			const usable = (json.groups || []).filter((g: any) => !g.is_announcement)

			const mapped: GroupRow[] = usable.map((g: any) => ({
				jid: String(g.wa_group_id),
				title: g.subject ?? null,
				participants_count: g.participants_count ?? null,
				is_restricted: g.is_restricted ?? false,
				updated_at: g.updated_at,
				send_time: g.send_time ?? null,
				avatar_url: null,
			}))

			// Дедупликация по jid
			const unique = mapped.filter(
				(row, index, self) =>
					index === self.findIndex(g => g.jid === row.jid),
			)

			setWaGroups(unique)
			setWaLoadedCount(unique.length)
			setWaTotalGroups(unique.length)
			setWaHasMore(false)
			animateWaCount(0, unique.length)
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось загрузить WA группы'))
			setWaGroups([])
			setWaTotalGroups(0)
			setWaHasMore(false)
		} finally {
			setLoadingWaList(false)
		}
	}

	const ensureWaAvatar = async (waGroupId: string) => {
		const gid = String(waGroupId || '').trim()
		if (!gid) return
		if (waAvatarMap[gid] !== undefined) return
		if (waAvatarLoading[gid]) return

		setWaAvatarLoading(prev => ({ ...prev, [gid]: true }))
		const url = await fetchWaGroupAvatar(gid)
		setWaAvatarMap(prev => ({ ...prev, [gid]: url }))
		setWaAvatarLoading(prev => ({ ...prev, [gid]: false }))
	}

	// Функция для плавной анимации счетчика WA
	const animateWaCount = (from: number, to: number) => {
		if (waAnimationFrameRef.current !== null) {
			cancelAnimationFrame(waAnimationFrameRef.current)
		}
		if (from === to) {
			setWaAnimatedCount(to)
			return
		}
		const startTime = Date.now()
		const duration = Math.min(800, Math.abs(to - from) * 15)
		const startValue = from
		const animate = () => {
			const elapsed = Date.now() - startTime
			const progress = Math.min(elapsed / duration, 1)
			const eased = 1 - Math.pow(1 - progress, 3)
			const current = Math.floor(startValue + (to - startValue) * eased)
			setWaAnimatedCount(current)
			if (progress < 1) {
				waAnimationFrameRef.current = requestAnimationFrame(animate)
			} else {
				setWaAnimatedCount(to)
				waAnimationFrameRef.current = null
			}
		}
		waAnimationFrameRef.current = requestAnimationFrame(animate)
	}

	// Функция для плавной анимации счетчика TG
	const animateTgCount = (from: number, to: number) => {
		if (tgAnimationFrameRef.current !== null) {
			cancelAnimationFrame(tgAnimationFrameRef.current)
		}
		if (from === to) {
			setTgAnimatedCount(to)
			return
		}
		const startTime = Date.now()
		const duration = Math.min(800, Math.abs(to - from) * 15)
		const startValue = from
		const animate = () => {
			const elapsed = Date.now() - startTime
			const progress = Math.min(elapsed / duration, 1)
			const eased = 1 - Math.pow(1 - progress, 3)
			const current = Math.floor(startValue + (to - startValue) * eased)
			setTgAnimatedCount(current)
			if (progress < 1) {
				tgAnimationFrameRef.current = requestAnimationFrame(animate)
			} else {
				setTgAnimatedCount(to)
				tgAnimationFrameRef.current = null
			}
		}
		tgAnimationFrameRef.current = requestAnimationFrame(animate)
	}

	const fetchMe = async () => {
		if (!token) {
			router.push('/auth/phone')
			return;		}
		setLoadingMe(true)
		try {
			const res = await fetch(`${BACKEND_URL}/auth/me`, {
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				Cookies.remove('token')
				router.push('/auth/phone')
				return;			}
			setUserId(String(json.user.id))
		} catch (e) {
			console.error(e)
			message.error('Не удалось получить пользователя')
		} finally {
			setLoadingMe(false)
		}
	}

	const loadGroups = async (uid: string, ch: 'wa' | 'tg', reset = true, selectedOnly = true): Promise<void> => {
		const reqId = ++groupsReqRef.current
		if (ch === 'tg' && !reset) {
			if (reqId === groupsReqRef.current) setLoadingGroups(false)
			return
		}
			if (reset) {
				if (ch === 'tg') setLoadingGroups(true)
				if (ch === 'wa') {
					setWaGroups([])
					setWaLoadedCount(0)
					setWaAnimatedCount(0) // Сбрасываем анимированный счетчик
					waLastAutoLoadRef.current = 0
				} else {
					setTgGroups([])
					setTgTotalGroups(0)
					setTgTotalRows(0)
					setTgAnimatedCount(0) // Сбрасываем анимированный счетчик
				}
			} else {
				if (ch === 'wa') setWaLoadingMore(true)
			}

		const waOffset = reset ? 0 : waLoadedCount
		const selectedParam = selectedOnly ? '&selectedOnly=true' : ''
		let url: string
		if (ch === 'tg') {
			const params = new URLSearchParams({
				selectedOnly: 'true',
				template: '1',
			})
			url = `${BACKEND_URL}/telegram/groups/${uid}?${params}`
		} else {
			url = `${BACKEND_URL}/whatsapp/groups/${uid}?limit=${BATCH_SIZE}&offset=${waOffset}${selectedParam}`
		}

		try {
			const res = await fetch(url, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const json: any = await res.json().catch(() => null)
			if (reqId !== groupsReqRef.current) return

			if (ch === 'tg' && !res.ok) {
				message.error(`Не удалось загрузить TG группы (${res.status}).`)
				setTgGroups([])
				setTgTotalGroups(0)
				setTgTotalRows(0)
				setTgHasMore(false)
				return
			}

			if (!json?.success) {
				message.error(
					ch === 'tg'
						? String(json?.userMessage || 'Не удалось загрузить TG группы')
						: 'Не удалось загрузить группы',
				)
				if (ch === 'wa') {
					setWaGroups([])
					setWaTotalGroups(0)
					setWaHasMore(false)
				} else {
					setTgGroups([])
					setTgTotalGroups(0)
					setTgTotalRows(0)
					setTgHasMore(false)
				}
				return
			}

			const total = json.total ?? 0
			const hasMoreData = json.hasMore ?? false

			if (ch === 'tg') {
				// Показываем только выбранные Telegram группы; нормализуем id (-100123 и 123 → одна группа)
				const mapped = (json.groups || []).map((g: any) => ({
					jid: normalizeTgChatId(String(g.tg_chat_id)),
					title: g.title ?? null,
					participants_count: g.participants_count ?? null,
					is_restricted: false,
					updated_at: g.updated_at,
					send_time: g.send_time ?? null,
					avatar_url: g.avatar_url ?? null,
				}))
				// Дедупликация по нормализованному jid
				const uniqueMapped = mapped.filter((group: GroupRow, index: number, self: GroupRow[]) =>
					index === self.findIndex((g: GroupRow) => g.jid === group.jid)
				)

				setTgGroups(uniqueMapped)
				animateTgCount(0, uniqueMapped.length)

				setTgTotalGroups(total)
				setTgTotalRows(Number(json.totalRows ?? json.total ?? total) || total)
				setTgHasMore(hasMoreData)
				if (channel === 'tg') {
					setGroups(uniqueMapped)
				}
			} else {
				// Для WA в редакторе шаблона мы больше не используем пагинацию/selectedOnly.
				// Вся загрузка WA-групп вынесена в отдельную функцию loadWaGroupsSimple.
			}
		} catch (e) {
			if (reqId !== groupsReqRef.current) return
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось загрузить группы'))
			if (ch === 'wa') {
				setWaGroups([])
				setWaTotalGroups(0)
				setWaHasMore(false)
			} else {
				setTgGroups([])
				setTgTotalGroups(0)
				setTgTotalRows(0)
				setTgHasMore(false)
			}
		} finally {
			if (reqId === groupsReqRef.current) {
				setLoadingGroups(false)
				if (ch === 'wa') setWaLoadingMore(false)
			}
		}
	}

	// Функции для автозагрузки следующих порций (только выбранные группы)
	const loadMoreWaGroups = () => {
		// Для WA больше не используем догрузку порциями — все группы загружаем одним запросом.
		return
	}

	const loadTargets = async (uid: string, ch: 'wa' | 'tg') => {
		const reqId = ++targetsReqRef.current[ch]
		try {
			const json: any = await apiGet(
				`/templates/targets/${uid}/${templateId}/${ch}`
			)
			if (reqId !== targetsReqRef.current[ch]) return
			if (!json?.success) {
				if (ch === 'wa') setWaSelected([])
				else setTgSelected([])
				return;			}
			const raw = (json.groupJids || []).map((x: any) => String(x))
			const jids = ch === 'tg' ? raw.map(normalizeTgChatId) : raw
			if (ch === 'wa') setWaSelected(jids)
			else setTgSelected(jids)

			const ovRaw: Record<string, any> = json.overrides && typeof json.overrides === 'object' ? json.overrides : {}
			if (ch === 'tg') {
				const next: Record<string, string | null> = {}
				for (const [k, v] of Object.entries(ovRaw)) {
					const jid = normalizeTgChatId(String(k || ''))
					if (!jid) continue
					next[jid] = v == null ? null : String(v)
				}
				setTgTargetOverrides(next)
			}
			// Не обновляем selectedGroupJids напрямую здесь - пусть useEffect синхронизирует
			// Это гарантирует, что мы учитываем только те группы, которые реально есть в groups
		} catch (e) {
			if (reqId !== targetsReqRef.current[ch]) return
			console.error(e)
			if (ch === 'wa') setWaSelected([])
			else setTgSelected([])
		}
	}

			const saveTargetsForTemplate = async () => {
		if (!userId || !templateId) return false
		try {
			const tasks: Array<{ ch: 'wa' | 'tg'; keys: string[]; overrides: Record<string, string | null> }> = [
				{
					ch: 'wa',
					keys: waSelected,
					overrides: {},
				},
				{
					ch: 'tg',
					keys: tgSelected.map(normalizeTgChatId),
					overrides: tgSelected.map(normalizeTgChatId).reduce((acc, jid) => {
						acc[jid] = tgTargetOverrides[jid] ?? null
						return acc
					}, {} as Record<string, string | null>),
				},
			]

			for (const t of tasks) {
				// eslint-disable-next-line no-await-in-loop
				const json: any = await apiPost(
					'/templates/targets/set',
					{
						userId,
						templateId,
						groupJids: t.keys,
						channel: t.ch,
						overrides: t.overrides,
					},
					{ timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS },
				)

				if (!json?.success) {
					const msg = String(json?.message || 'unknown')
					console.warn(`Ошибка сохранения групп (${t.ch}): ${msg}`)
					message.error(`Не удалось сохранить группы ${t.ch.toUpperCase()}: ${msg}`)
					return false
				}
			}

			return true
		} catch (e) {
			console.error(e)
			message.error(
				getApiErrorMessage(e, 'Не удалось сохранить группы для шаблона'),
			)
			return false
		}
	}

	function setTgTargetOverride(jid: string, next: string | null) {
		setTgTargetOverrides(prev => ({ ...prev, [jid]: next }))
	}

	const refreshOneGroupSummary = async (ch: 'wa' | 'tg', jid: string, force = false) => {
		if (!token) return
		const hasLocal = !!(ch === 'wa' ? groupDeliverySummary.wa[jid] : groupDeliverySummary.tg[jid])
		const meta = ch === 'wa' ? summaryMeta.wa : summaryMeta.tg
		if (
			!force &&
			hasLocal &&
			meta.fetchedAtMs &&
			Date.now() - meta.fetchedAtMs < SUMMARY_FRESH_MS
		) {
			return
		}
		const res = await fetchGroupDeliverySummary({
			backendUrl: BACKEND_URL,
			token,
			channel: ch,
			groupJids: [jid],
			lookbackDays: 14,
			includeTemplatesIncluded: true,
			bypassCache: force,
		})
		setGroupDeliverySummary(prev => ({
			...prev,
			[ch]: { ...prev[ch], ...res.summaries },
		}))
		setSummaryMeta(prev => ({
			...prev,
			[ch]: { cacheHit: res.meta.cacheHit, fetchedAtMs: res.meta.fetchedAtMs },
		}))
	}

	const loadTemplate = async () => {
		if (!templateId) return
		setLoadingTpl(true)
		try {
			const json: any = await apiGet(`/templates/get/${templateId}`, {
				timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS,
			})
			if (!json?.success) {
				message.error(`Ошибка загрузки: ${json?.message || 'unknown'}`)
				return
			}
			const tpl = json.template
			if (tpl) {
				const [waLo, waHi] = readTemplatePausePairFromApi('wa', tpl as Record<string, unknown>, tpl.wa_speed_factor)
				const [tgLo, tgHi] = readTemplatePausePairFromApi('tg', tpl as Record<string, unknown>, tpl.tg_speed_factor)
				form.setFieldsValue({
					title: tpl.title || '',
					text: tpl.text || '',
					enabled: tpl.enabled !== false,
					order: tpl.order || 1,
					send_media_as_file: tpl.send_media_as_file === true,
					wa_speed_factor: 100,
					tg_speed_factor: 100,
					wa_between_groups_sec_min: waLo,
					wa_between_groups_sec_max: waHi,
					tg_between_groups_sec_min: tgLo,
					tg_between_groups_sec_max: tgHi,
					tg_default_send_time: tpl.tg_default_send_time ?? null,
				})

				initialTemplateTimingRef.current = {
					wa_between_groups_sec_min: waLo,
					wa_between_groups_sec_max: waHi,
					tg_between_groups_sec_min: tgLo,
					tg_between_groups_sec_max: tgHi,
					tg_default_send_time: tpl.tg_default_send_time ?? null,
				}
				
				// Устанавливаем медиа
				if (tpl.media_url) {
					setMediaUrl(tpl.media_url)
				}
				
				// Показываем в редакторе уже отформатированный текст (жирный, курсив, списки), а не сырые значки.
				const plainText = String(tpl.text ?? '')
				setTimeout(() => {
					if (editorRef.current) {
						if (!plainText.trim()) {
							editorRef.current.innerHTML = '<br>'
							setEditorCharCount(0)
						} else {
							editorRef.current.innerHTML = markdownToHtml(plainText)
							setEditorCharCount((editorRef.current.innerText || '').length)
						}
					}
				}, 0)
			}
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось загрузить шаблон'))
		} finally {
			setLoadingTpl(false)
			templateLoadFinishedRef.current = true
		}
	}

	// Сразу показываем страницу, не блокируем полноэкранным loader — данные подгрузятся в фоне
	useEffect(() => {
		loader.hide()
		fetchMe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Сброс ref при размонтировании, чтобы при повторном входе loader не зависал
	useEffect(() => {
		return () => {
			templateLoadFinishedRef.current = false
		}
	}, [])

	// Очистка анимации при размонтировании
	useEffect(() => {
		return () => {
			if (waAnimationFrameRef.current !== null) {
				cancelAnimationFrame(waAnimationFrameRef.current)
			}
			if (tgAnimationFrameRef.current !== null) {
				cancelAnimationFrame(tgAnimationFrameRef.current)
			}
		}
	}, [])

	// Закрытие эмодзи-пикера при клике вне его
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				emojiPickerRef.current &&
				!emojiPickerRef.current.contains(event.target as Node) &&
				!(event.target as HTMLElement)?.closest('.tedit-emoji-btn')
			) {
				setShowEmojiPicker(false)
			}
			if (
				contextMenuRef.current &&
				!contextMenuRef.current.contains(event.target as Node)
			) {
				setShowContextMenu(false)
			}
		}

		if (showEmojiPicker || showContextMenu) {
			document.addEventListener('mousedown', handleClickOutside)
		}

		return () => {
			document.removeEventListener('mousedown', handleClickOutside)
		}
	}, [showEmojiPicker, showContextMenu])

	// Режим вкл/выкл кнопок форматирования по текущему выделению (bold/italic/underline)
	useEffect(() => {
		const onSelectionChange = () => {
			const editor = editorRef.current
			const sel = window.getSelection()
			if (editor && sel && editor.contains(sel.anchorNode)) {
				updateFormatActive()
			}
		}
		document.addEventListener('selectionchange', onSelectionChange)
		return () => document.removeEventListener('selectionchange', onSelectionChange)
	}, [])

	// Функции форматирования текста для contentEditable
	const formatText = (command: string, value?: string) => {
		const editor = editorRef.current
		if (!editor) return

		editor.focus()
		document.execCommand(command, false, value)

		// Синхронизируем форму и состояние кнопок (onMouseDown preventDefault сохраняет выделение при клике)
		const html = editor.innerHTML
		const markdown = htmlToMarkdown(html)
		form.setFieldsValue({ text: markdown })
		handleEditorInput()
	}

	const handleEditorInput = () => {
		const editor = editorRef.current
		if (!editor) return
		const text = editor.innerText || ''
		setEditorCharCount(text.length)
		const html = editor.innerHTML
		const markdown = htmlToMarkdown(html)
		form.setFieldsValue({ text: markdown })
		updateFormatActive()
	}

	const updateFormatActive = () => {
		try {
			const editor = editorRef.current
			if (!editor || !document.contains(editor)) return
			// Состояние имеет смысл только когда фокус/выделение в редакторе
			if (!editor.contains(document.activeElement) && document.activeElement !== editor) return
			setFormatActive({
				bold: document.queryCommandState('bold'),
				italic: document.queryCommandState('italic'),
				strike: document.queryCommandState('strikeThrough'),
				underline: document.queryCommandState('underline'),
				unorderedList: document.queryCommandState('insertUnorderedList'),
				orderedList: document.queryCommandState('insertOrderedList'),
			})
		} catch {
			// ignore when editor not focused
		}
	}

	const handleContextMenu = (e: React.MouseEvent) => {
		e.preventDefault()
		setContextMenuPos({ x: e.clientX, y: e.clientY })
		setShowContextMenu(true)
	}

	const copyText = () => {
		const editor = editorRef.current
		if (editor) {
			const selection = window.getSelection()
			if (selection && selection.toString()) {
				navigator.clipboard.writeText(selection.toString()).then(() => {
					message.success('Текст скопирован')
				})
			} else {
				const text = editor.innerText || ''
				navigator.clipboard.writeText(text).then(() => {
					message.success('Весь текст скопирован')
				})
			}
		}
		setShowContextMenu(false)
	}

	const pasteText = async () => {
		const editor = editorRef.current
		if (editor) {
			try {
				const text = await navigator.clipboard.readText()
				editor.focus()
				document.execCommand('insertText', false, text)
				handleEditorInput()
			} catch (e) {
				message.error('Не удалось вставить текст')
			}
		}
		setShowContextMenu(false)
	}

	const cutText = () => {
		const editor = editorRef.current
		if (editor) {
			const selection = window.getSelection()
			if (selection && selection.toString()) {
				navigator.clipboard.writeText(selection.toString()).then(() => {
					document.execCommand('delete')
					handleEditorInput()
					message.success('Текст вырезан')
				})
			}
		}
		setShowContextMenu(false)
	}

	const selectAll = () => {
		const editor = editorRef.current
		if (editor) {
			const range = document.createRange()
			range.selectNodeContents(editor)
			const selection = window.getSelection()
			selection?.removeAllRanges()
			selection?.addRange(range)
		}
		setShowContextMenu(false)
	}

	useEffect(() => {
		if (templateId) loadTemplate()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [templateId])

	// Загрузка Telegram Premium статуса (при 404/ошибке используем лимит 2GB)
	const loadTgPremiumStatus = async (uid: string) => {
		const fallback = () => setTgPremiumStatus({ isPremium: false, maxFileSize: 2 * 1024 * 1024 * 1024 })
		try {
			const res = await fetch(`${BACKEND_URL}/telegram/premium-status/${uid}`, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			if (!res.ok) {
				fallback()
				return
			}
			const json = await res.json().catch(() => null)
			if (json?.success) {
				setTgPremiumStatus({
					isPremium: json.isPremium || false,
					maxFileSize: json.maxFileSize || 2 * 1024 * 1024 * 1024,
				})
			} else {
				fallback()
			}
		} catch {
			fallback()
		}
	}

	useEffect(() => {
		if (!userId || !templateId) return
		// WA: в редакторе шаблона грузим все группы через простой загрузчик (как при создании шаблона),
		// а фактический выбор берём из targets (waSelected).
		loadWaGroupsSimple(userId).then(() => {
			loadTargets(userId, 'wa')
		})
		setWaGroupsLoaded(true)
		// TG targets загружаем сразу, но они применятся только после загрузки TG групп
		loadTargets(userId, 'tg')
		// Загружаем Telegram Premium статус для проверки лимитов файлов
		loadTgPremiumStatus(userId)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId, templateId])


	useEffect(() => {
		if (!userId || !token) return
		let cancelled = false
		;(async () => {
			try {
				const res = await fetch(`${BACKEND_URL}/telegram/groups/${userId}/count`, {
					cache: 'no-store',
					headers: { Authorization: `Bearer ${token}` },
				})
				const data: { success?: boolean; total?: number; selected?: number } | null = await res
					.json()
					.catch(() => null)
				if (cancelled || !data?.success) return
				setTgDbStats({
					total: Number(data.total ?? 0),
					selected: Number(data.selected ?? 0),
				})
			} catch {
				/* ignore */
			}
		})()
		return () => {
			cancelled = true
		}
	}, [userId, token])

	// Статус подключения WA/TG для отображения «Подключить TG/WA» в выборе канала
	useEffect(() => {
		if (!userId || !token) return
		// 502/Bad Gateway может вернуть HTML вместо JSON — поэтому json() делаем "safe",
		// чтобы не сыпались SyntaxError "Unexpected token '<'".
		const safeJson = async (r: Response): Promise<any | null> => {
			try {
				if (!r.ok) return null
				return await r.json().catch(() => null)
			} catch {
				return null
			}
		}

		Promise.all([
			fetch(`${BACKEND_URL}/whatsapp/account-info/${userId}`, {
				cache: 'no-store',
				headers: { Authorization: `Bearer ${token}` },
			}).then((r) => safeJson(r)),
			fetch(`${BACKEND_URL}/telegram/qr/status/${userId}?_=${Date.now()}`, {
				cache: 'no-store',
				headers: { Authorization: `Bearer ${token}` },
			}).then((r) => safeJson(r)),
		]).then(([waData, tgData]) => {
			setWaConnected(waData?.success ? waData.connected === true : false)
			setTgConnected(
				tgData?.success && tgData?.status === 'connected',
			)
		}).catch(() => {})
	}, [userId, token])

	// Периодическая проверка Telegram Premium статуса (если пользователь купил Premium)
	useEffect(() => {
		if (!userId || channel !== 'tg') return
		
		// Загружаем статус сразу
		loadTgPremiumStatus(userId)
		
		// Проверяем каждые 30 секунд на случай если пользователь купил Premium
		const interval = setInterval(() => {
			loadTgPremiumStatus(userId)
		}, 30000) // 30 секунд

		return () => clearInterval(interval)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId, channel])

	// TG для шаблона — сразу при открытии страницы (один запрос из БД), чтобы не ждать вкладку Telegram
	useEffect(() => {
		if (!userId || !templateId) return
		let cancelled = false
		;(async () => {
			await loadGroups(userId, 'tg', true, true)
			if (cancelled) return
			await loadTargets(userId, 'tg')
		})()
		return () => {
			cancelled = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId, templateId])

	// Автоматическая загрузка следующих порций WA групп
	useEffect(() => {
		if (!userId || waLoadingMore || loadingGroups || !waHasMore || waGroups.length === 0) return
		
		if (waGroups.length > 0 && waGroups.length < waTotalGroups && waHasMore && waGroups.length !== waLastAutoLoadRef.current) {
			waLastAutoLoadRef.current = waGroups.length
			const timer = setTimeout(() => {
				if (waHasMore && !waLoadingMore && !loadingGroups) {
					loadMoreWaGroups()
				}
			}, 200)
			return () => clearTimeout(timer)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [waHasMore, waGroups.length, waTotalGroups, userId])

	// Синхронизируем selectedGroupJids с waSelected/tgSelected. Храним полный список
	// выбранных ID (из API targets), а не только «видимые» в текущей порции групп,
	// иначе при постраничной загрузке групп половина галочек слетала.
	useEffect(() => {
		if (channel === 'wa') {
			setGroups(waGroups)
			setSelectedGroupJids(prev => {
				if (prev.length === waSelected.length && waSelected.every(id => prev.includes(id)))
					return prev
				return waSelected
			})
		} else {
			setGroups(tgGroups)
			setSelectedGroupJids(prev => {
				if (prev.length === tgSelected.length && tgSelected.every(id => prev.includes(id)))
					return prev
				return tgSelected
			})
		}
	}, [channel, waGroups, tgGroups, waSelected, tgSelected])

	// Фильтр по названию или ID, затем выбранные наверх
	const sortedGroups = useMemo(() => {
		const q = groupFilterQuery.trim().toLowerCase()
		const filtered = q
			? groups.filter(
					(g) =>
						(g.title ?? '').toLowerCase().includes(q) ||
						String(g.jid ?? '').toLowerCase().includes(q),
				)
			: [...groups]
		return filtered.sort((a, b) => {
			const aIn = selectedGroupJids.includes(a.jid)
			const bIn = selectedGroupJids.includes(b.jid)
			if (aIn && !bIn) return -1
			if (!aIn && bIn) return 1
			return 0
		})
	}, [groups, selectedGroupJids, groupFilterQuery])

	const groupColumns: ColumnsType<GroupRow> = useMemo(() => {
		const cols: ColumnsType<GroupRow> = [
			{
				title: 'Группа',
				key: 'group',
				render: (_: any, row: GroupRow) => {
					const checked = selectedGroupJids.includes(row.jid)
					const summary = (channel === 'wa' ? groupDeliverySummary.wa : groupDeliverySummary.tg)[row.jid]
					const meta = channel === 'wa' ? summaryMeta.wa : summaryMeta.tg
					const infoContent = (
						<div style={{ minWidth: 230, fontSize: 12, lineHeight: 1.4 }}>
							<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
								<div><b>Сводка отправок (14 дней)</b></div>
								<button
									type='button'
									className='tedit-info-close'
									onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
									onClick={(e) => {
										e.preventDefault()
										e.stopPropagation()
										closeInfoLockRef.current = `${channel}:${row.jid}`
										setOpenInfoKey(null)
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
													<button type='button' className='tedit-reason-info'>i</button>
												</Tooltip>
											</div>
										))}
									</div>
								) : '—'}
							</div>
							<div style={{ marginTop: 6 }}>
								<button
									type='button'
									className='tedit-info-refresh'
									onMouseDown={(e) => e.stopPropagation()}
									onClick={(e) => { e.stopPropagation(); void refreshOneGroupSummary(channel, row.jid, true) }}
								>
									Обновить
								</button>
							</div>
						</div>
					)
					return (
						<div className='tedit-group-row-inner'>
							<div className='tedit-group-row-main'>
								<div
									className={`tedit-custom-checkbox ${checked ? 'checked' : ''}`}
									role="button"
									tabIndex={0}
									title={checked ? 'Снять выделение' : 'Выбрать группу'}
									onClick={(e) => {
										e.stopPropagation()
										const jid = row.jid
										const isSelected = selectedGroupJids.includes(jid)
										const newKeys = isSelected
											? selectedGroupJids.filter(k => k !== jid)
											: [...selectedGroupJids, jid]
										setSelectedGroupJids(newKeys)
										if (channel === 'wa') setWaSelected(newKeys)
										else setTgSelected(newKeys)
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											e.stopPropagation()
											const jid = row.jid
											const isSelected = selectedGroupJids.includes(jid)
											const newKeys = isSelected
												? selectedGroupJids.filter(k => k !== jid)
												: [...selectedGroupJids, jid]
											setSelectedGroupJids(newKeys)
											if (channel === 'wa') setWaSelected(newKeys)
											else setTgSelected(newKeys)
										}
									}}
								>
									{checked && (
										<svg className="tedit-check-icon" viewBox="0 0 20 20" fill="none">
											<path
												d="M16.7071 5.29289C17.0976 5.68342 17.0976 6.31658 16.7071 6.70711L8.70711 14.7071C8.31658 15.0976 7.68342 15.0976 7.29289 14.7071L3.29289 10.7071C2.90237 10.3166 2.90237 9.68342 3.29289 9.29289C3.68342 8.90237 4.31658 8.90237 4.70711 9.29289L8 12.5858L15.2929 5.29289C15.6834 4.90237 16.3166 4.90237 16.7071 5.29289Z"
												fill="currentColor"
											/>
										</svg>
									)}
								</div>
								{(() => {
									const nameForAvatar =
										(row.title && row.title.trim()) || 'Группа'
									let avatarUrl = row.avatar_url || null
									if (channel === 'wa') {
										avatarUrl = normalizeWaAvatarUrl(row.jid, avatarUrl)
										const hasCachedAvatar = Object.prototype.hasOwnProperty.call(waAvatarMap, row.jid)
										if (!hasCachedAvatar && !waAvatarLoading[row.jid]) {
											void ensureWaAvatar(row.jid)
										}
										avatarUrl = hasCachedAvatar ? waAvatarMap[row.jid] ?? null : avatarUrl
									}
									return avatarUrl ? (
										<div className="tedit-group-avatar-wrap">
											<img
												src={avatarUrl}
												alt=""
												className="tedit-group-avatar"
												onError={() => setWaAvatarMap(prev => ({ ...prev, [row.jid]: null }))}
											/>
										</div>
									) : (
										<div className="tedit-group-avatar tedit-group-avatar--placeholder">
											{nameForAvatar.slice(0, 1).toUpperCase()}
										</div>
									)
								})()}
								<Popover
									content={infoContent}
									trigger='click'
									placement='rightTop'
									open={openInfoKey === `${channel}:${row.jid}`}
									onOpenChange={(open) => {
										if (open) {
											if (closeInfoLockRef.current === `${channel}:${row.jid}`) {
												closeInfoLockRef.current = null
												return
											}
											setOpenInfoKey(`${channel}:${row.jid}`)
											void refreshOneGroupSummary(channel, row.jid)
										} else if (openInfoKey === `${channel}:${row.jid}`) {
											closeInfoLockRef.current = null
											setOpenInfoKey(null)
										}
									}}
								>
									<button
										type='button'
										className='tedit-info-icon'
										onMouseDown={(e) => e.stopPropagation()}
										onClick={(e) => e.stopPropagation()}
									>
										i
									</button>
								</Popover>
								<div className='tedit-group-row-info'>
									<span className='tedit-group-row-title'>
										{row.title || 'без названия'}
									</span>
									<span className='tedit-group-row-id'>
										ID: {row.jid}
									</span>
								</div>
								{checked && (
									<span className='tedit-group-row-badge'>✓ Выбрано</span>
								)}
							</div>
							{channel === 'tg' && (
								<div className='tedit-group-row-interval' onClick={(e) => e.stopPropagation()}>
									{(() => {
										const ov = tgTargetOverrides[row.jid] ?? null
										const tplDef = tgDefaultSendTime
										const eff = ov ?? (tplDef ? String(tplDef) : null) ?? (row.send_time ?? null)
										const title = eff ? `Эффективно: ${eff}` : 'Эффективно: авто'
										return (
											<Select
												allowClear
												placeholder='По умолчанию'
												size='small'
												className='tedit-group-interval-select'
												value={tgTargetOverrides[row.jid] ?? undefined}
												options={SEND_INTERVAL_OPTIONS}
												disabled={!checked}
												title={title}
												onChange={v => setTgTargetOverride(row.jid, v ?? null)}
												onClick={(e: any) => e.stopPropagation()}
												onMouseDown={(e: any) => e.stopPropagation()}
											/>
										)
									})()}
								</div>
							)}
							{channel === 'wa' && (
								<span
									className='tedit-group-row-count'
									title='Количество участников в группе'
								>
									{typeof row.participants_count === 'number'
										? `Участников: ${row.participants_count}`
										: 'Участников: —'}
								</span>
							)}
						</div>
					)
				},
			},
		]

		return cols
	}, [channel, selectedGroupJids, waAvatarMap, waAvatarLoading, tgTargetOverrides, tgDefaultSendTime, groupDeliverySummary])

	const uploadProps: UploadProps = useMemo(
		() => ({
			maxCount: 1,
			beforeUpload: async file => {
				if (!userId) {
					message.error('Нет userId')
					return Upload.LIST_IGNORE
				}

				// Проверка размера файла с учетом Telegram Premium статуса
				if (channel === 'tg' && tgPremiumStatus) {
					const maxSize = tgPremiumStatus.maxFileSize
					if (file.size > maxSize) {
						const maxSizeGB = (maxSize / (1024 * 1024 * 1024)).toFixed(1)
						const fileSizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(1)
						message.error(
							`Размер файла (${fileSizeGB}GB) превышает лимит для ${tgPremiumStatus.isPremium ? 'Telegram Premium' : 'обычного аккаунта'} (${maxSizeGB}GB)`
						)
						return Upload.LIST_IGNORE
					}
				} else if (channel === 'tg') {
					// Если статус еще не загружен, используем консервативный лимит
					const conservativeLimit = 2 * 1024 * 1024 * 1024 // 2GB
					if (file.size > conservativeLimit) {
						message.warning('Проверяем лимиты Telegram... Попробуйте еще раз через секунду.')
						// Пытаемся загрузить статус синхронно
						await loadTgPremiumStatus(userId)
						return Upload.LIST_IGNORE
					}
				}

				setUploading(true)
				try {
					const fd = new FormData()
					fd.append('userId', userId)
					fd.append('file', file)

					const res = await fetch(`${BACKEND_URL}/templates/upload-media`, {
						method: 'POST',
						headers: {
							...(token ? { Authorization: `Bearer ${token}` } : {}),
						},
						body: fd,
					})

					const json: any = await res.json().catch(() => null)
					if (!json?.success) {
						message.error(
							`Ошибка загрузки файла: ${json?.message || 'unknown'}`
						)
						return Upload.LIST_IGNORE
					}

					const url = String(json.publicUrl || json.url || '')
					if (!url) {
						message.error('Не пришла ссылка на файл от сервера')
						return Upload.LIST_IGNORE
					}

					setMediaUrl(url)
					message.success('Файл загружен')
				} catch (e) {
					console.error(e)
					message.error(getApiErrorMessage(e, 'Не удалось загрузить файл'))
				} finally {
					setUploading(false)
				}

				return Upload.LIST_IGNORE
			},
		}),
		[userId, token, channel, tgPremiumStatus]
	)

	const onSave = async (values: any) => {
		if (!userId) return message.error('Нет userId')
		if (!templateId) return message.error('Нет templateId')

		setSaving(true)
		loader.show('Сохраняем шаблон…')
		try {
			// Сохраняем текущий выбор групп для текущего канала
			if (channel === 'wa') {
				setWaSelected(selectedGroupJids)
			} else {
				setTgSelected(selectedGroupJids)
			}

			// Конвертируем HTML из contentEditable в Markdown перед сохранением
			const editor = editorRef.current
			if (editor) {
				const html = editor.innerHTML
				const markdown = htmlToMarkdown(html)
				values.text = markdown
			}

			const merged = { ...form.getFieldsValue(true), ...values }
			const [wLo, wHi] = clampPausePairFromFormValues(
				'wa',
				merged.wa_between_groups_sec_min,
				merged.wa_between_groups_sec_max,
			)
			const [tLo, tHi] = clampPausePairFromFormValues(
				'tg',
				merged.tg_between_groups_sec_min,
				merged.tg_between_groups_sec_max,
			)
			const payload = {
				templateId,
				title: values.title,
				text: values.text,
				media_url: mediaUrl ?? undefined,
				enabled: values.enabled ?? true,
				order: values.order ?? 1,
				send_media_as_file: values.send_media_as_file === true,
				wa_speed_factor: 100,
				tg_speed_factor: 100,
				wa_between_groups_sec_min: wLo,
				wa_between_groups_sec_max: wHi,
				tg_between_groups_sec_min: tLo,
				tg_between_groups_sec_max: tHi,
				tg_default_send_time: values.tg_default_send_time || undefined,
			}

			const json: any = await apiPost('/templates/update', payload, {
				timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS,
			})
			if (!json?.success) {
				const errText = json?.error || json?.message || 'unknown'
				message.error(`Ошибка сохранения шаблона: ${errText}`)
				return
			}
			if (json?.persistenceDegraded) {
				message.warning(
					'В Supabase нет колонок пауз «между группами» для шаблонов — значения ползунков не записались. Выполните SQL: backend/migrations/add_message_templates_between_groups_sec_range.sql',
				)
			}

			// Автоматически сохраняем группы для обоих каналов
			const saved = await saveTargetsForTemplate()
			if (!saved) {
				message.warning('Шаблон сохранен, но группы не обновлены')
			}

			const prev = initialTemplateTimingRef.current
			const next = {
				wa_between_groups_sec_min: wLo,
				wa_between_groups_sec_max: wHi,
				tg_between_groups_sec_min: tLo,
				tg_between_groups_sec_max: tHi,
				tg_default_send_time: values.tg_default_send_time ?? null,
			}
			const changedSpeed =
				!!prev &&
				(prev.wa_between_groups_sec_min !== next.wa_between_groups_sec_min ||
					prev.wa_between_groups_sec_max !== next.wa_between_groups_sec_max ||
					prev.tg_between_groups_sec_min !== next.tg_between_groups_sec_min ||
					prev.tg_between_groups_sec_max !== next.tg_between_groups_sec_max)
			const changedDefault =
				!!prev && prev.tg_default_send_time !== next.tg_default_send_time

			const parts: string[] = []
			if (changedSpeed) parts.push('ETA пересчитана по паузам «между группами» в шаблоне')
			if (changedDefault) parts.push('предупреждение про интервал TG в drawer обновится (дефолт из шаблона)')

			message.success(parts.length ? `Шаблон сохранен — ${parts.join(' и ')}.` : 'Шаблон сохранен')
			initialTemplateTimingRef.current = next

			if (typeof window !== 'undefined') window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
			router.push('/dashboard/templates')
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось сохранить шаблон'))
		} finally {
			setSaving(false)
			loader.hide()
		}
	}

	const onDelete = async () => {
		if (!userId) return message.error('Нет userId')
		if (!templateId) return message.error('Нет templateId')

		setSaving(true)
		try {
			const json: any = await apiPost(
				'/templates/delete',
				{
					templateId,
				},
				{ timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS },
			)
			if (!json?.success) {
				message.error(`Ошибка удаления: ${json?.message || 'unknown'}`)
				return;			}
			message.success('Шаблон удален')
			loader.show('Обновляем список шаблонов…')
			router.push('/dashboard/templates')
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось удалить шаблон'))
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className='tedit'>
			<div className='tedit__wrap'>
				<p className='tedit__intro'>
					Измените текст или выбранные группы (вкладки WA/TG), затем нажмите «Сохранить».
				</p>

				<div className='tedit__card'>
					<Form
						className='tedit__form'
						form={form}
						layout='vertical'
						initialValues={{
							enabled: true,
							order: 1,
							send_media_as_file: false,
							wa_speed_factor: 100,
							tg_speed_factor: 100,
							wa_between_groups_sec_min: TEMPLATE_FORM_DEFAULT_PAUSE.wa[0],
							wa_between_groups_sec_max: TEMPLATE_FORM_DEFAULT_PAUSE.wa[1],
							tg_between_groups_sec_min: TEMPLATE_FORM_DEFAULT_PAUSE.tg[0],
							tg_between_groups_sec_max: TEMPLATE_FORM_DEFAULT_PAUSE.tg[1],
							tg_default_send_time: null,
						}}
						onFinish={onSave}
					>
						<div className='tedit-cont'>
						<div className='tedit-cont-one'>
							<div className='tedit-field'>
								<div className='tedit-field__label'>Название шаблона</div>
								<Form.Item name='title' style={{ marginBottom: 0 }}>
									<Input
										className='tedit-input'
										placeholder=''
										variant='borderless'
									/>
								</Form.Item>
								<div className='tedit-field__hint'>
									Например: Описание квартиры, Акция, Подбор объектов
								</div>
							</div>

							<div className='tedit-upload'>
								<div className='tedit-upload__label'>Прикрепите медиафайл</div>

								{!mediaUrl ? (
									<div className='tedit-upload__row'>
										<div className='tedit-upload__drop'>
											<Upload.Dragger
												{...uploadProps}
												showUploadList={false}
												disabled={!userId || uploading || saving}
											>
												<div className='tedit-upload__btn'>
													<span className='tedit-upload__icon'>
														<Image
															src='/iconFoto.png'
															alt='Картинка'
															width={19}
															height={19}
														/>
													</span>
													<span>
														Перетащите файл сюда
														<br />
														или нажмите, чтобы выбрать
													</span>
												</div>
											</Upload.Dragger>
										</div>

										<div className='tedit-upload__note'>
											<div className='tedit-upload__noteTitle'>Внимание!</div>
											<div className='tedit-upload__noteText'>
												Можно добавить только 1 файл (изображение, видео или аудио)
												{channel === 'tg' && tgPremiumStatus && (
													<>
														<br />
														Максимальный размер: {tgPremiumStatus.isPremium ? '4GB' : '2GB'} 
														{tgPremiumStatus.isPremium && ' (Telegram Premium)'}
													</>
												)}
											</div>
										</div>
									</div>
								) : (
									<div className='tedit-upload__current-wrapper'>
										<button
											type='button'
											className='tedit-upload__previewBtn'
											onClick={() => setMediaViewerUrl(mediaUrl)}
											title='Открыть в полном размере / запустить'
										>
											<div className='tedit-upload__preview'>
												{isVideoUrl(mediaUrl) ? (
													<video
														src={mediaUrl}
														className='tedit-upload__previewMedia'
														controls
														onClick={e => e.stopPropagation()}
													/>
												) : isAudioUrl(mediaUrl) ? (
													<audio
														src={mediaUrl}
														className='tedit-upload__previewAudio'
														controls
														onClick={e => e.stopPropagation()}
													/>
												) : (
													<img
														src={mediaUrl}
														className='tedit-upload__previewImg'
														alt='Превью файла'
													/>
												)}
											</div>
										</button>
										<div className='tedit-upload__previewHint'>Нажмите на превью для полного просмотра или запуска</div>
										<div className='tedit-upload__actions'>
											<button
												type='button'
												className='tedit-pill'
												onClick={() => setMediaUrl(null)}
												disabled={uploading || saving}
											>
												Убрать
											</button>
											<Upload
												{...uploadProps}
												showUploadList={false}
												disabled={!userId || uploading || saving}
											>
												<button
													type='button'
													className='tedit-pill'
													disabled={uploading || saving}
												>
													Заменить
												</button>
											</Upload>
										</div>
									</div>
								)}
							</div>

							<div className='tedit-field'>
								<div className='tedit-field__label'>Текст сообщения</div>
								<div className='tedit-textarea-wrapper'>
									<div className='tedit-format-toolbar'>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.bold ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('bold')}
											title='Жирный (Ctrl+B)'
										>
											<span className='tedit-format-btn__char'>B</span>
										</button>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.italic ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('italic')}
											title='Курсив (Ctrl+I)'
										>
											<span className='tedit-format-btn__char tedit-format-btn__char--italic'>I</span>
										</button>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.underline ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('underline')}
											title='Подчёркнутый (Ctrl+U)'
										>
											<span className='tedit-format-btn__char tedit-format-btn__char--underline'>U</span>
										</button>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.strike ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('strikeThrough')}
											title='Зачёркнутый'
										>
											<span className='tedit-format-btn__char tedit-format-btn__char--strike'>S</span>
										</button>
										<div className='tedit-format-separator' />
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.unorderedList ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('insertUnorderedList')}
											title='Маркированный список'
										>
											<span className='tedit-format-btn__char'>•</span>
										</button>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.orderedList ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('insertOrderedList')}
											title='Нумерованный список'
										>
											<span className='tedit-format-btn__char'>1.</span>
										</button>
										<div className='tedit-format-separator' />
										<button
											type='button'
											className='tedit-format-btn'
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => {
												const editor = editorRef.current
												if (editor) {
													editor.focus()
													const selection = window.getSelection()
													if (selection && selection.toString()) {
														const range = selection.getRangeAt(0)
														const selectedText = selection.toString()
														const codeNode = document.createElement('code')
														codeNode.textContent = selectedText
														range.deleteContents()
														range.insertNode(codeNode)
														selection.removeAllRanges()
														const newRange = document.createRange()
														newRange.selectNodeContents(codeNode)
														selection.addRange(newRange)
														handleEditorInput()
													} else {
														document.execCommand('insertText', false, '``')
														const range = selection?.getRangeAt(0)
														if (range) {
															range.setStart(range.startContainer, range.startOffset - 1)
															range.setEnd(range.startContainer, range.startOffset - 1)
															selection?.removeAllRanges()
															selection?.addRange(range)
														}
														handleEditorInput()
													}
												}
												handleEditorInput()
											}}
											title='Моноширинный (код)'
										>
											<span className='tedit-format-btn__char tedit-format-btn__char--code'>{'</>'}</span>
										</button>
									</div>
									<Form.Item
										name='text'
										style={{ marginBottom: 0 }}
										rules={[
											{
												validator: async (_, value) => {
													const title = form.getFieldValue('title')
													const editor = editorRef.current
													const editorText = editor?.innerText || ''
													if (
														!String(title || '').trim() &&
														!String(editorText || '').trim()
													) {
														return Promise.reject(
															new Error('Нужно заполнить title или text')
														)
													}
													return Promise.resolve()
												},
											},
										]}
									>
										<div
											ref={editorRef}
											contentEditable
											className='tedit-textarea-editor'
											data-placeholder='Введите текст...'
											onInput={handleEditorInput}
											onFocus={updateFormatActive}
											onContextMenu={handleContextMenu}
											onKeyDown={(e) => {
												const editor = editorRef.current
												const len = (editor?.innerText || '').length
												const isAdding = !['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.key) &&
													!(e.ctrlKey || e.metaKey) && e.key.length === 1
												if (isAdding && len >= MAX_MESSAGE_CHARS) {
													e.preventDefault()
													message.warning(`Лимит сообщения — ${MAX_MESSAGE_CHARS} символов`)
													return
												}
												// Enter в пустой строке (в т.ч. вложенный div): см. TemplateRichEditor + htmlToMarkdown (блоки после жирного)
												if (e.key === 'Enter' && editor) {
													const sel = window.getSelection()
													if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
														const block = (sel.anchorNode as HTMLElement)?.closest?.('div, p')
														if (block && block !== editor && editor.contains(block)) {
															const onlyBr =
																block.childNodes.length === 1 &&
																block.firstChild?.nodeType === Node.ELEMENT_NODE &&
																(block.firstChild as HTMLElement).tagName?.toLowerCase() === 'br'
															const empty = !block.textContent?.trim()
															if (onlyBr || empty) {
																e.preventDefault()
																document.execCommand('insertParagraph', false)
																handleEditorInput()
																return
															}
														}
													}
												}
												// Горячие клавиши для форматирования
												if (e.ctrlKey || e.metaKey) {
													if (e.key === 'b') {
														e.preventDefault()
														formatText('bold')
													} else if (e.key === 'i') {
														e.preventDefault()
														formatText('italic')
													} else if (e.key === 'u') {
														e.preventDefault()
														formatText('underline')
													}
												}
											}}
											onPaste={(e) => {
												e.preventDefault()
												const editor = editorRef.current
												const currentLen = (editor?.innerText || '').length
												let text = e.clipboardData.getData('text/plain')
												if (currentLen + text.length > MAX_MESSAGE_CHARS) {
													text = text.slice(0, MAX_MESSAGE_CHARS - currentLen)
													message.warning(`Лимит сообщения — ${MAX_MESSAGE_CHARS} символов, вставлено до лимита`)
												}
												document.execCommand('insertText', false, text)
												handleEditorInput()
											}}
										/>
									</Form.Item>
									<div className='tedit-char-count'>
										<span className='tedit-char-count__nums'>
											Символов: <strong>{editorCharCount}</strong> / {MAX_MESSAGE_CHARS}
										</span>
										{channel === 'tg' && tgPremiumStatus && (
											<span className='tedit-char-count__tg'>
												{tgPremiumStatus.isPremium ? (
													<> · Telegram: <strong>Premium</strong> ✓ (файлы до 4 ГБ)</>
												) : (
													<> · Telegram: обычный аккаунт (файлы до 2 ГБ)</>
												)}
											</span>
										)}
									</div>
									<Popover
										content={
											<div className='tedit-emoji-picker' ref={emojiPickerRef}>
												<div className='tedit-emoji-grid'>
													{[
														'😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃',
														'👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💪', '🦵', '🦶', '👂', '👃', '🧠', '🦷', '🦴', '👀', '👁️', '👅', '👄', '💋',
														'💘', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❣️', '💔', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💣', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤',
														'✈️', '📱', '📢', '🔐', '🌐', '⚡', '🚀', '📎', '📸', '🔍', '📝', '⚙️', '✅', '❌', '⚠️', 'ℹ️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤',
														'🔥', '⭐', '🌟', '✨', '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '🥈', '🥉', '🎖️', '🏅', '🎗️', '🎫', '🎟️', '🎪', '🎭', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🎻', '🎲', '🎯', '🎳', '🎮', '🕹️', '🎰', '🧩',
													].map((emoji) => {
														const imgUrl = getTwemojiUrl(emoji)
														return (
															<button
																key={emoji}
																type='button'
																className='tedit-emoji-item'
																onClick={() => {
																	const editor = editorRef.current
																	if (editor) {
																		editor.focus()
																		document.execCommand('insertText', false, emoji)
																		handleEditorInput()
																	}
																	setShowEmojiPicker(false)
																}}
																title={emoji}
															>
																{imgUrl ? (
																	<img src={imgUrl} alt={emoji} className='tedit-emoji-img' draggable={false} />
																) : (
																	<span className='tedit-emoji-char'>{emoji}</span>
																)}
															</button>
														)
													})}
												</div>
											</div>
										}
										trigger='click'
										open={showEmojiPicker}
										onOpenChange={setShowEmojiPicker}
										placement='topRight'
									>
										<button
											type='button'
											className='tedit-emoji-btn'
											title='Добавить эмодзи'
										>
											😀
										</button>
									</Popover>
									{showContextMenu && (
										<div
											className='tedit-context-menu'
											ref={contextMenuRef}
											style={{
												position: 'fixed',
												left: `${contextMenuPos.x}px`,
												top: `${contextMenuPos.y}px`,
											}}
										>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={() => formatText('bold')}
											>
												<b>B</b> Жирный
											</button>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={() => formatText('italic')}
											>
												<i>I</i> Курсив
											</button>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={() => formatText('underline')}
											>
												<u>U</u> Подчеркнутый
											</button>
											<div className='tedit-context-menu-separator' />
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={copyText}
											>
												📋 Копировать
											</button>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={cutText}
											>
												✂️ Вырезать
											</button>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={pasteText}
											>
												📄 Вставить
											</button>
											<div className='tedit-context-menu-separator' />
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={selectAll}
											>
												Выделить все
											</button>
										</div>
									)}
								</div>
								<div className='tedit-field__hint'>
									Введите текст сообщения. Поддерживается форматирование и эмодзи
								</div>
							</div>

							{/* Включение + порядок (рядом) */}
							<div className='tedit-mini'>
								<div className='tedit-mini__item'>
									<div>
										<div className='tedit-mini__label'>Включён</div>
										<div className='tedit-mini__hint'>Если выключить — этот шаблон не будет участвовать в рассылках.</div>
									</div>
									<Form.Item name='enabled' valuePropName='checked' style={{ marginBottom: 0 }}>
										<Switch />
									</Form.Item>
								</div>

								<div className='tedit-mini__item' style={{ display: 'none' }}>
									<div>
										<div className='tedit-mini__label'>Порядок отправки</div>
										<div className='tedit-mini__hint'>Чем меньше число, тем раньше отправляется этот шаблон (1 — самый первый).</div>
									</div>
									<Form.Item name='order' style={{ marginBottom: 0 }}>
										<InputNumber min={1} />
									</Form.Item>
								</div>
							</div>

							{/* Медиа как файл (сразу под загрузчиком) */}
							<div className='tedit-mini'>
								<div className='tedit-mini__item'>
									<div>
										<div className='tedit-mini__label'>Отправлять медиа как файл</div>
										<div className='tedit-mini__hint'>Включено — медиа придёт как документ. Выключено — показывается прямо в чате (превью/плеер).</div>
									</div>
									<Form.Item name='send_media_as_file' valuePropName='checked' style={{ marginBottom: 0 }}>
										<Switch />
									</Form.Item>
								</div>
							</div>

							<div className='tedit-mini'>
								<Form.Item name='wa_speed_factor' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='tg_speed_factor' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='wa_between_groups_sec_min' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='wa_between_groups_sec_max' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='tg_between_groups_sec_min' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='tg_between_groups_sec_max' hidden>
									<input type='hidden' />
								</Form.Item>
								<div className='tedit-mini__item tedit-mini__item--pauseBlock'>
									<div className='tedit-pauseBetweenGroups__head'>
										<div>
											<div className='tedit-mini__label'>
												<ChannelIcon type='wa' size={14} /> Пауза между группами WhatsApp (этот шаблон)
											</div>
											<div className='tedit-mini__hint'>
												Здесь вы задаёте для шаблона минимум и максимум секунд паузы между группами в волне WhatsApp: при рассылке берётся{' '}
												<b>случайное</b> число секунд между выбранными «от» и «до». Ползунки настраиваются в пределах 5–600 с.
											</div>
										</div>
										<Tag className='tedit-pauseBetweenGroups__tag'>
											{(() => {
												const [lo, hi] = clampTemplatePauseSecPair(
													Number(waPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[0]),
													Number(waPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[1]),
												)
												return `${lo}–${hi} с`
											})()}
										</Tag>
									</div>
									<Slider
										range
										className='tedit-speed-slider'
										min={5}
										max={600}
										step={5}
										tooltip={{ formatter: (v) => `${v} сек` }}
										value={clampTemplatePauseSecPair(
											Number(waPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[0]),
											Number(waPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[1]),
										)}
										onChange={(v) => {
											const [x, y] = v as [number, number]
											const [lo, hi] = clampTemplatePauseSecPair(x, y)
											form.setFieldsValue({
												wa_between_groups_sec_min: lo,
												wa_between_groups_sec_max: hi,
												wa_speed_factor: 100,
											})
										}}
									/>
								</div>

								<div className='tedit-mini__item tedit-mini__item--pauseBlock'>
									<div className='tedit-pauseBetweenGroups__head'>
										<div>
											<div className='tedit-mini__label'>
												<ChannelIcon type='tg' size={14} /> Пауза между группами Telegram (этот шаблон)
											</div>
											<div className='tedit-mini__hint'>
												То же для Telegram: ползунки задают диапазон секунд между группами (случайная пауза внутри «от»–«до»). Ползунки: 5–600 с.
											</div>
										</div>
										<Tag className='tedit-pauseBetweenGroups__tag'>
											{(() => {
												const [lo, hi] = clampTemplatePauseSecPair(
													Number(tgPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[0]),
													Number(tgPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[1]),
												)
												return `${lo}–${hi} с`
											})()}
										</Tag>
									</div>
									<Slider
										range
										className='tedit-speed-slider'
										min={5}
										max={600}
										step={5}
										tooltip={{ formatter: (v) => `${v} сек` }}
										value={clampTemplatePauseSecPair(
											Number(tgPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[0]),
											Number(tgPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[1]),
										)}
										onChange={(v) => {
											const [x, y] = v as [number, number]
											const [lo, hi] = clampTemplatePauseSecPair(x, y)
											form.setFieldsValue({
												tg_between_groups_sec_min: lo,
												tg_between_groups_sec_max: hi,
												tg_speed_factor: 100,
											})
										}}
									/>
								</div>

								<div className='tedit-mini__item'>
									<div>
										<div className='tedit-mini__label'>Дефолтный интервал Telegram</div>
										<div className='tedit-mini__hint'>Если у TG-группы не задан свой интервал (override), используется этот интервал шаблона. Если override задан — он важнее.</div>
									</div>
									<Form.Item name='tg_default_send_time' style={{ marginBottom: 0 }}>
										<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
											<Select
												allowClear
												placeholder='Интервал'
												size='small'
												style={{ width: 170 }}
												options={SEND_INTERVAL_OPTIONS}
												value={isHHMM(tgDefaultSendTime) ? undefined : (tgDefaultSendTime ?? undefined)}
												onChange={(v) => form.setFieldValue('tg_default_send_time', v ?? null)}
											/>
											<TimePicker
												allowClear
												format='HH:mm'
												minuteStep={1}
												size='small'
												style={{ width: 110 }}
												placeholder='HH:mm'
												value={isHHMM(tgDefaultSendTime) ? dayjs(String(tgDefaultSendTime), 'HH:mm') : null}
												onChange={(v) => form.setFieldValue('tg_default_send_time', v ? v.format('HH:mm') : null)}
											/>
										</div>
									</Form.Item>
								</div>
							</div>
						</div>

						<div className='tedit-targets'>
							<div className='tedit-targets__head'>
								<div className='tedit-targets__title'>
									Куда отправлять этот шаблон
								</div>

								<Segmented
									value={channel}
									onChange={v => setChannel(v as any)}
									size="large"
									options={[
										{
											label: (
												<span className='tedit-channelTab'>
													<span className={`tedit-channelTab__icon tedit-channelTab__icon--tg`}>
														<ChannelIcon type='tg' size={16} variant={tgConnected === false ? 'failed' : 'default'} />
													</span>
													<span className='tedit-channelTab__text'>
														{tgConnected === false
															? 'Подключить TG'
															: `Telegram${loadingGroups ? ' · загрузка' : ''}`}
													</span>
													{tgConnected !== false && (
														<span className='tedit-channelTab__meta'>
															{loadingGroups ? (
																<span className='tedit-channelTab__load' aria-hidden='true' />
															) : null}
															<span>
																{loadingGroups
																	? `${tgAnimatedCount}/${tgTotalGroups > 0 ? tgTotalGroups : '…'}`
																	: `${tgGroups.length}`}
															</span>
														</span>
													)}
												</span>
											),
											value: 'tg',
										},
										{
											label: (
												<span className='tedit-channelTab'>
													<span className={`tedit-channelTab__icon tedit-channelTab__icon--wa`}>
														<ChannelIcon type='wa' size={16} variant={waConnected === false ? 'failed' : 'default'} />
													</span>
													<span className='tedit-channelTab__text'>
														{waConnected === false
															? 'Подключить WA'
															: `WhatsApp${loadingWaList || waLoadingMore ? ' · загрузка' : ''}`}
													</span>
													{waConnected !== false && (
														<span className='tedit-channelTab__meta'>
															{loadingWaList || waLoadingMore ? (
																<span className='tedit-channelTab__load' aria-hidden='true' />
															) : null}
															<span>{loadingWaList || waLoadingMore ? '…' : `${waGroups.length}`}</span>
														</span>
													)}
												</span>
											),
											value: 'wa',
										},
									]}
								/>
								<div className='tedit-targets__counts'>
									<div className='tedit-targets__countBlock'>
										<span className='tedit-targets__countItem'>
											<ChannelIcon type='tg' size={14} />
											<span>
												TG: для шаблона <b>{tgSelected.length}</b>
												{' · '}
												в таблице <b>{tgGroups.length}</b> {pluralRuGroups(tgGroups.length)}
											</span>
										</span>
										{!tgHasMore && tgTotalRows > tgTotalGroups ? (
											<div className='tedit-targets__countHint'>
												В базе для выбранных групп TG записано <b>{tgTotalRows}</b> строк, а разных
												чатов <b>{tgTotalGroups}</b> — лишние строки дублируют один и тот же чат
												(обычно после повторных синков). Готовая чистка: файл{' '}
												<b>backend/migrations/fix_duplicate_groups.sql</b> (п. 3–4 и уникальный индекс
												для TG).
											</div>
										) : null}
									</div>
									<span className='tedit-targets__countItem'>
										<ChannelIcon type='wa' size={14} />
										<span>
											WA: для шаблона <b>{waSelected.length}</b>
											{' · '}
											в таблице <b>{waGroups.length}</b> {pluralRuGroups(waGroups.length)}
										</span>
									</span>
									<p className='tedit-targets__legend'>
										«Для шаблона» — чаты, отмеченные для этого шаблона в таблице ниже (пока не
										отметили — 0). «В таблице» — группы с включённой рассылкой из «Группы TG / WA»;
										TG подгружается из базы одним запросом при открытии страницы редактирования.
									</p>
								</div>
							</div>

							{channel === 'wa' && waConnected !== false && (
								<div
									className='tedit-targets__meta'
									style={{ '--channel-color': '#25D366' } as React.CSSProperties}
								>
									{loadingWaList || waLoadingMore ? (
										<span className='tedit-targets__meta-loading'>
											<span className='tedit-spinner' />
											Загружаем WhatsApp-группы…
										</span>
									) : (
										<span className='tedit-targets__meta-idle'>
											В списке <b>{waGroups.length}</b> {pluralRuGroups(waGroups.length)}
										</span>
									)}
								</div>
							)}
							{channel === 'tg' && tgConnected !== false && (
								<div
									className='tedit-targets__meta'
									style={{ '--channel-color': '#29A9EB' } as React.CSSProperties}
								>
									{loadingGroups ? (
										<span className='tedit-targets__meta-loading'>
											<span className='tedit-spinner' />
											{tgTotalGroups > 0
												? `Загружаем чаты: ${tgAnimatedCount} из ${tgTotalGroups}${
														tgTotalRows > tgTotalGroups
															? ` (в БД ${tgTotalRows} строк — есть дубли по чату)`
															: ''
													}…`
												: 'Загружаем Telegram-группы…'}
										</span>
									) : (
										<>
											<span className='tedit-targets__meta-idle'>
												В списке <b>{tgGroups.length}</b> {pluralRuGroups(tgGroups.length)}
												{tgDbStats && tgDbStats.total > 0 && (
													<>
														{' '}
														· в «
														<Link href='/dashboard/groups/telegram' className='tedit-link'>
															Группы TG
														</Link>
														»: всего <b>{tgDbStats.total}</b>, с рассылкой{' '}
														<b>{tgDbStats.selected}</b>
													</>
												)}
											</span>
											{tgDbStats &&
												tgDbStats.selected < tgDbStats.total &&
												!loadingGroups && (
													<div className='tedit-targets__meta-hint'>
														С рассылкой сейчас только <b>{tgDbStats.selected}</b> из{' '}
														<b>{tgDbStats.total}</b> групп. Остальные здесь не появятся, пока не
														включите их в «Группы TG».
													</div>
												)}
											{tgDbStats &&
												tgDbStats.selected > 0 &&
												!tgHasMore &&
												!loadingGroups &&
												tgGroups.length < tgDbStats.selected && (
													<div className='tedit-targets__meta-hint tedit-targets__meta-hint--warn'>
														В таблице <b>{tgGroups.length}</b>, а с рассылкой в базе{' '}
														<b>{tgDbStats.selected}</b> — проверьте ответ API или обновите страницу.
													</div>
												)}
										</>
									)}
								</div>
							)}

							<div className='tedit-warning-placeholder'>
								{channel === 'tg' && tgConnected === false && (
									<div className='tedit-warning-message tedit-warning-message--connect'>
										<ChannelIcon type='tg' size={20} variant='failed' />{' '}
										Telegram не подключён. Подключите в кабинете, чтобы выбирать группы для этого шаблона.{' '}
										<button
											type='button'
											className='tedit-link'
											onClick={() => { loader.show('В кабинет…'); router.push('/cabinet#telegram') }}
										>
											Подключить TG
										</button>
									</div>
								)}
								{channel === 'wa' && waConnected === false && (
									<div className='tedit-warning-message tedit-warning-message--connect'>
										<ChannelIcon type='wa' size={20} variant='failed' />{' '}
										WhatsApp не подключён. Подключите в кабинете, чтобы выбирать группы для этого шаблона.{' '}
										<button
											type='button'
											className='tedit-link'
											onClick={() => { loader.show('В кабинет…'); router.push('/cabinet#whatsapp') }}
										>
											Подключить WA
										</button>
									</div>
								)}
								{channel === 'wa' && waConnected !== false && waGroupsLoaded && waGroups.length === 0 && (
									<div className='tedit-warning-message tedit-warning-message--empty'>
										Нет выбранных WhatsApp групп. Выберите группы на странице{' '}
										<Link href='/dashboard/groups' className='tedit-link'>Управление группами</Link> (вкладка WhatsApp), затем возвращайтесь сюда.
									</div>
								)}
								{groups.length > 0 && selectedGroupJids.length === 0 && (channel === 'tg' ? tgConnected !== false : waConnected !== false) && (
									<div className='tedit-warning-message'>
										Для канала <b>{channel.toUpperCase()}</b> не выбраны группы.
										<br />
										Рассылка по этому каналу не запустится, пока вы не отметите
										группы и не нажмёте «Сохранить группы ({channel.toUpperCase()})».
									</div>
								)}
							</div>

							<div className='tedit-targets__buttons'>
								<button
									type='button'
									className='tedit-pill'
									onClick={() => {
										const all = groups.map(g => g.jid)
										setSelectedGroupJids(all)
										if (channel === 'wa') setWaSelected(all)
										else setTgSelected(all)
									}}
									disabled={!groups.length}
								>
									Выбрать все
								</button>

								<button
									type='button'
									className='tedit-pill'
									onClick={() => {
										// Снимаем выделение со всех групп (не удаляем группы из списка)
										setSelectedGroupJids([])
										if (channel === 'wa') setWaSelected([])
										else setTgSelected([])
									}}
									disabled={!selectedGroupJids.length}
									title='Снять выделение со всех групп'
								>
									Снять выделение
								</button>

								{channel === 'tg' && selectedGroupJids.length > 0 && (
									<div className='tedit-targets__bulk-interval'>
										<Select
											placeholder='Интервал для всех'
											allowClear
											className='tedit-bulk-interval-select'
											value={bulkInterval ?? undefined}
											onChange={v => setBulkInterval(v ?? null)}
											options={SEND_INTERVAL_OPTIONS}
											style={{ minWidth: 160 }}
										/>
										<button
											type='button'
											className='tedit-pill tedit-pill--primary'
											disabled={!bulkInterval || applyingBulkInterval}
											onClick={() => {
												if (!bulkInterval || !selectedGroupJids.length) return
												setApplyingBulkInterval(true)
												setTgTargetOverrides(prev => {
													const next = { ...prev }
													for (const jid of selectedGroupJids) next[jid] = bulkInterval
													return next
												})
												setApplyingBulkInterval(false)
												message.success(`Интервал применён к ${selectedGroupJids.length} группам (сохранится при сохранении шаблона)`)
											}}
										>
											{applyingBulkInterval ? 'Применяем…' : 'Применить ко всем'}
										</button>
									</div>
								)}
							</div>

							<div className='tedit-targets__filter'>
								<Input
									placeholder='Фильтр по названию или ID группы'
									value={groupFilterQuery}
									onChange={(e) => setGroupFilterQuery(e.target.value)}
									allowClear
									className='tedit-filter-input'
								/>
							</div>

							<div className='tedit-table-panel'>
								<div className='tedit-scroll-container'>
									<div className='tedit-table'>
										<Table
											rowKey='jid'
											columns={groupColumns}
											dataSource={sortedGroups}
											pagination={false}
											size='small'
											loading={
												loadingMe ||
												loadingTpl ||
												(channel === 'tg' ? loadingGroups : (loadingWaList || waLoadingMore))
											}
											onRow={(record) => ({
												onClick: (e: any) => {
													// Не переключаем выбор, если клик был на Select или чекбоксе
													if (e?.target?.closest?.('.ant-select') || e?.target?.closest?.('.tedit-custom-checkbox')) return
													const jid = record.jid
													const isSelected = selectedGroupJids.includes(jid)
													const newKeys = isSelected
														? selectedGroupJids.filter(k => k !== jid)
														: [...selectedGroupJids, jid]
													setSelectedGroupJids(newKeys)
													if (channel === 'wa') setWaSelected(newKeys)
													else setTgSelected(newKeys)
												},
												className: `tedit-table-row ${selectedGroupJids.includes(record.jid) ? 'rowSelected' : ''}`,
											})}
										/>
									</div>
								</div>
							</div>

							<div className='tedit-targets__hint'>
								Выбор сохранится автоматически при сохранении шаблона.
							</div>
						</div>
					</div>

					<div className='tedit-actions'>
						<button
							className='tedit-btn tedit-btn--primary'
							type='submit'
							disabled={saving || uploading || loadingMe || loadingTpl}
						>
							{saving ? 'Сохраняем...' : 'Сохранить шаблон'}
						</button>
					</div>

					{loadingTpl ? (
						<div style={{ marginTop: 10, opacity: 0.75, textAlign: 'center' }}>
							Загрузка...
						</div>
					) : null}
					</Form>
				</div>
			</div>
			<MediaViewerModal
				open={!!mediaViewerUrl}
				url={mediaViewerUrl}
				onClose={() => setMediaViewerUrl(null)}
			/>
		</div>
	)
}
