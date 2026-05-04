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

/** Р›РёРјРёС‚ СЃРёРјРІРѕР»РѕРІ РІ РѕРґРЅРѕРј СЃРѕРѕР±С‰РµРЅРёРё (Telegram Рё WhatsApp) */
const MAX_MESSAGE_CHARS = 4096

/** Р”Р»РёРЅРЅС‹Рµ С‚РµР»Р° (С‚РµРєСЃС‚ + РјРЅРѕРіРѕ РіСЂСѓРїРї) вЂ” СЃС‚Р°РЅРґР°СЂС‚РЅС‹Р№ 20s С‚Р°Р№РјР°СѓС‚ РґР°С‘С‚ Р»РѕР¶РЅСѓСЋ В«РѕС€РёР±РєСѓ СЃРµС‚РёВ». */
const TEMPLATE_SAVE_TIMEOUT_MS = 90_000

/** URL РєР°СЂС‚РёРЅРєРё СЌРјРѕРґР·Рё С‡РµСЂРµР· Twemoji CDN (РІСЃРµ СЃРјР°Р№Р»РёРєРё РєР°Рє РіСЂР°С„РёРєР°) */
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

/** РќРѕСЂРјР°Р»РёР·СѓРµС‚ Telegram chat id: -100123 Рё 123 СЃС‡РёС‚Р°СЋС‚СЃСЏ РѕРґРЅРѕР№ РіСЂСѓРїРїРѕР№, С…СЂР°РЅРёРј РІ РІРёРґРµ -100... */
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
	/** Р—Р°РіСЂСѓР·РєР° СЃРїРёСЃРєР° WA (loadWaGroupsSimple) вЂ” РґР»СЏ СЃС‚СЂРѕРєРё В«Р—Р°РіСЂСѓР¶Р°РµРјвЂ¦В» Р±РµР· РґС‹СЂ РІ РІС‘СЂСЃС‚РєРµ */
	const [loadingWaList, setLoadingWaList] = useState(false)
	const [waGroupsLoaded, setWaGroupsLoaded] = useState(false)
	
	// РЎРѕСЃС‚РѕСЏРЅРёСЏ РґР»СЏ РїР°РіРёРЅР°С†РёРё WA РіСЂСѓРїРї
	const [waTotalGroups, setWaTotalGroups] = useState(0)
	const [waHasMore, setWaHasMore] = useState(false)
	const [waLoadingMore, setWaLoadingMore] = useState(false)
	const [waLoadedCount, setWaLoadedCount] = useState(0)
	const [waAnimatedCount, setWaAnimatedCount] = useState(0) // РџР»Р°РІРЅРѕ СѓРІРµР»РёС‡РёРІР°СЋС‰РёР№СЃСЏ СЃС‡РµС‚С‡РёРє РґР»СЏ WA
	const waLastAutoLoadRef = useRef(0)
	const waAnimationFrameRef = useRef<number | null>(null)
	
	// РЎРѕСЃС‚РѕСЏРЅРёСЏ РґР»СЏ РїР°РіРёРЅР°С†РёРё TG РіСЂСѓРїРї
	const [tgTotalGroups, setTgTotalGroups] = useState(0)
	const [tgTotalRows, setTgTotalRows] = useState(0)
	const [tgHasMore, setTgHasMore] = useState(false)
	const [tgAnimatedCount, setTgAnimatedCount] = useState(0) // РџР»Р°РІРЅРѕ СѓРІРµР»РёС‡РёРІР°СЋС‰РёР№СЃСЏ СЃС‡РµС‚С‡РёРє РґР»СЏ TG
	const tgAnimationFrameRef = useRef<number | null>(null)
	const [tgDbStats, setTgDbStats] = useState<{ total: number; selected: number } | null>(null)

	const BATCH_SIZE = 50 // Р Р°Р·РјРµСЂ РїРѕСЂС†РёРё РґР»СЏ Р·Р°РіСЂСѓР·РєРё
	
	const [waConnected, setWaConnected] = useState<boolean | null>(null)
	const [tgConnected, setTgConnected] = useState<boolean | null>(null)
	/** РћР±С‰РёР№ РёРЅС‚РµСЂРІР°Р»: Р·РЅР°С‡РµРЅРёРµ РґР»СЏ РєРЅРѕРїРєРё В«РџСЂРёРјРµРЅРёС‚СЊ РєРѕ РІСЃРµРј РІС‹Р±СЂР°РЅРЅС‹РјВ» */
	const [bulkInterval, setBulkInterval] = useState<string | null>(null)
	const [applyingBulkInterval, setApplyingBulkInterval] = useState(false)

	// Override РёРЅС‚РµСЂРІР°Р»Р° РЅР° СѓСЂРѕРІРЅРµ (С€Р°Р±Р»РѕРЅ в†’ РіСЂСѓРїРїР°) РїРѕ РєР°РЅР°Р»Р°Рј
	const [tgTargetOverrides, setTgTargetOverrides] = useState<Record<string, string | null>>({})
	
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

	// РџСЂРѕСЃС‚РѕР№ Р·Р°РіСЂСѓР·С‡РёРє WA-РіСЂСѓРїРї Р±РµР· РїР°РіРёРЅР°С†РёРё, РєР°Рє РїСЂРё СЃРѕР·РґР°РЅРёРё С€Р°Р±Р»РѕРЅР°
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
				message.error('РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ WA РіСЂСѓРїРїС‹')
				setWaGroups([])
				setWaTotalGroups(0)
				setWaHasMore(false)
				return
			}

			// Р‘СЌРєРµРЅРґ РІРµСЂРЅСѓР» С‚РѕР»СЊРєРѕ РІС‹Р±СЂР°РЅРЅС‹Рµ (selectedOnly=true). РСЃРєР»СЋС‡Р°РµРј С‚РѕР»СЊРєРѕ announcement.
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

			// Р”РµРґСѓРїР»РёРєР°С†РёСЏ РїРѕ jid
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
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ WA РіСЂСѓРїРїС‹'))
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

	// Р¤СѓРЅРєС†РёСЏ РґР»СЏ РїР»Р°РІРЅРѕР№ Р°РЅРёРјР°С†РёРё СЃС‡РµС‚С‡РёРєР° WA
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

	// Р¤СѓРЅРєС†РёСЏ РґР»СЏ РїР»Р°РІРЅРѕР№ Р°РЅРёРјР°С†РёРё СЃС‡РµС‚С‡РёРєР° TG
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
			message.error('РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕР»СѓС‡РёС‚СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ')
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
					setWaAnimatedCount(0) // РЎР±СЂР°СЃС‹РІР°РµРј Р°РЅРёРјРёСЂРѕРІР°РЅРЅС‹Р№ СЃС‡РµС‚С‡РёРє
					waLastAutoLoadRef.current = 0
				} else {
					setTgGroups([])
					setTgTotalGroups(0)
					setTgTotalRows(0)
					setTgAnimatedCount(0) // РЎР±СЂР°СЃС‹РІР°РµРј Р°РЅРёРјРёСЂРѕРІР°РЅРЅС‹Р№ СЃС‡РµС‚С‡РёРє
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
				message.error(`РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ TG РіСЂСѓРїРїС‹ (${res.status}).`)
				setTgGroups([])
				setTgTotalGroups(0)
				setTgTotalRows(0)
				setTgHasMore(false)
				return
			}

			if (!json?.success) {
				message.error(
					ch === 'tg'
						? String(json?.userMessage || 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ TG РіСЂСѓРїРїС‹')
						: 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РіСЂСѓРїРїС‹',
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
				// РџРѕРєР°Р·С‹РІР°РµРј С‚РѕР»СЊРєРѕ РІС‹Р±СЂР°РЅРЅС‹Рµ Telegram РіСЂСѓРїРїС‹; РЅРѕСЂРјР°Р»РёР·СѓРµРј id (-100123 Рё 123 в†’ РѕРґРЅР° РіСЂСѓРїРїР°)
				const mapped = (json.groups || []).map((g: any) => ({
					jid: normalizeTgChatId(String(g.tg_chat_id)),
					title: g.title ?? null,
					participants_count: g.participants_count ?? null,
					is_restricted: false,
					updated_at: g.updated_at,
					send_time: g.send_time ?? null,
					avatar_url: g.avatar_url ?? null,
				}))
				// Р”РµРґСѓРїР»РёРєР°С†РёСЏ РїРѕ РЅРѕСЂРјР°Р»РёР·РѕРІР°РЅРЅРѕРјСѓ jid
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
				// Р”Р»СЏ WA РІ СЂРµРґР°РєС‚РѕСЂРµ С€Р°Р±Р»РѕРЅР° РјС‹ Р±РѕР»СЊС€Рµ РЅРµ РёСЃРїРѕР»СЊР·СѓРµРј РїР°РіРёРЅР°С†РёСЋ/selectedOnly.
				// Р’СЃСЏ Р·Р°РіСЂСѓР·РєР° WA-РіСЂСѓРїРї РІС‹РЅРµСЃРµРЅР° РІ РѕС‚РґРµР»СЊРЅСѓСЋ С„СѓРЅРєС†РёСЋ loadWaGroupsSimple.
			}
		} catch (e) {
			if (reqId !== groupsReqRef.current) return
			console.error(e)
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РіСЂСѓРїРїС‹'))
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

	// Р¤СѓРЅРєС†РёРё РґР»СЏ Р°РІС‚РѕР·Р°РіСЂСѓР·РєРё СЃР»РµРґСѓСЋС‰РёС… РїРѕСЂС†РёР№ (С‚РѕР»СЊРєРѕ РІС‹Р±СЂР°РЅРЅС‹Рµ РіСЂСѓРїРїС‹)
	const loadMoreWaGroups = () => {
		// Р”Р»СЏ WA Р±РѕР»СЊС€Рµ РЅРµ РёСЃРїРѕР»СЊР·СѓРµРј РґРѕРіСЂСѓР·РєСѓ РїРѕСЂС†РёСЏРјРё вЂ” РІСЃРµ РіСЂСѓРїРїС‹ Р·Р°РіСЂСѓР¶Р°РµРј РѕРґРЅРёРј Р·Р°РїСЂРѕСЃРѕРј.
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
			// РќРµ РѕР±РЅРѕРІР»СЏРµРј selectedGroupJids РЅР°РїСЂСЏРјСѓСЋ Р·РґРµСЃСЊ - РїСѓСЃС‚СЊ useEffect СЃРёРЅС…СЂРѕРЅРёР·РёСЂСѓРµС‚
			// Р­С‚Рѕ РіР°СЂР°РЅС‚РёСЂСѓРµС‚, С‡С‚Рѕ РјС‹ СѓС‡РёС‚С‹РІР°РµРј С‚РѕР»СЊРєРѕ С‚Рµ РіСЂСѓРїРїС‹, РєРѕС‚РѕСЂС‹Рµ СЂРµР°Р»СЊРЅРѕ РµСЃС‚СЊ РІ groups
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
					console.warn(`РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ РіСЂСѓРїРї (${t.ch}): ${msg}`)
					message.error(`РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ РіСЂСѓРїРїС‹ ${t.ch.toUpperCase()}: ${msg}`)
					return false
				}
			}

			return true
		} catch (e) {
			console.error(e)
			message.error(
				getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ РіСЂСѓРїРїС‹ РґР»СЏ С€Р°Р±Р»РѕРЅР°'),
			)
			return false
		}
	}

	function setTgTargetOverride(jid: string, next: string | null) {
		setTgTargetOverrides(prev => ({ ...prev, [jid]: next }))
	}


	const loadTemplate = async () => {
		if (!templateId) return
		setLoadingTpl(true)
		try {
			const json: any = await apiGet(`/templates/get/${templateId}`, {
				timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS,
			})
			if (!json?.success) {
				message.error(`РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё: ${json?.message || 'unknown'}`)
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
				
				// РЈСЃС‚Р°РЅР°РІР»РёРІР°РµРј РјРµРґРёР°
				if (tpl.media_url) {
					setMediaUrl(tpl.media_url)
				}
				
				// РџРѕРєР°Р·С‹РІР°РµРј РІ СЂРµРґР°РєС‚РѕСЂРµ СѓР¶Рµ РѕС‚С„РѕСЂРјР°С‚РёСЂРѕРІР°РЅРЅС‹Р№ С‚РµРєСЃС‚ (Р¶РёСЂРЅС‹Р№, РєСѓСЂСЃРёРІ, СЃРїРёСЃРєРё), Р° РЅРµ СЃС‹СЂС‹Рµ Р·РЅР°С‡РєРё.
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
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ С€Р°Р±Р»РѕРЅ'))
		} finally {
			setLoadingTpl(false)
			templateLoadFinishedRef.current = true
		}
	}

	// РЎСЂР°Р·Сѓ РїРѕРєР°Р·С‹РІР°РµРј СЃС‚СЂР°РЅРёС†Сѓ, РЅРµ Р±Р»РѕРєРёСЂСѓРµРј РїРѕР»РЅРѕСЌРєСЂР°РЅРЅС‹Рј loader вЂ” РґР°РЅРЅС‹Рµ РїРѕРґРіСЂСѓР·СЏС‚СЃСЏ РІ С„РѕРЅРµ
	useEffect(() => {
		loader.hide()
		fetchMe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// РЎР±СЂРѕСЃ ref РїСЂРё СЂР°Р·РјРѕРЅС‚РёСЂРѕРІР°РЅРёРё, С‡С‚РѕР±С‹ РїСЂРё РїРѕРІС‚РѕСЂРЅРѕРј РІС…РѕРґРµ loader РЅРµ Р·Р°РІРёСЃР°Р»
	useEffect(() => {
		return () => {
			templateLoadFinishedRef.current = false
		}
	}, [])

	// РћС‡РёСЃС‚РєР° Р°РЅРёРјР°С†РёРё РїСЂРё СЂР°Р·РјРѕРЅС‚РёСЂРѕРІР°РЅРёРё
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

	// Р—Р°РєСЂС‹С‚РёРµ СЌРјРѕРґР·Рё-РїРёРєРµСЂР° РїСЂРё РєР»РёРєРµ РІРЅРµ РµРіРѕ
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

	// Р РµР¶РёРј РІРєР»/РІС‹РєР» РєРЅРѕРїРѕРє С„РѕСЂРјР°С‚РёСЂРѕРІР°РЅРёСЏ РїРѕ С‚РµРєСѓС‰РµРјСѓ РІС‹РґРµР»РµРЅРёСЋ (bold/italic/underline)
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

	// Р¤СѓРЅРєС†РёРё С„РѕСЂРјР°С‚РёСЂРѕРІР°РЅРёСЏ С‚РµРєСЃС‚Р° РґР»СЏ contentEditable
	const formatText = (command: string, value?: string) => {
		const editor = editorRef.current
		if (!editor) return

		editor.focus()
		document.execCommand(command, false, value)

		// РЎРёРЅС…СЂРѕРЅРёР·РёСЂСѓРµРј С„РѕСЂРјСѓ Рё СЃРѕСЃС‚РѕСЏРЅРёРµ РєРЅРѕРїРѕРє (onMouseDown preventDefault СЃРѕС…СЂР°РЅСЏРµС‚ РІС‹РґРµР»РµРЅРёРµ РїСЂРё РєР»РёРєРµ)
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
			// РЎРѕСЃС‚РѕСЏРЅРёРµ РёРјРµРµС‚ СЃРјС‹СЃР» С‚РѕР»СЊРєРѕ РєРѕРіРґР° С„РѕРєСѓСЃ/РІС‹РґРµР»РµРЅРёРµ РІ СЂРµРґР°РєС‚РѕСЂРµ
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
					message.success('РўРµРєСЃС‚ СЃРєРѕРїРёСЂРѕРІР°РЅ')
				})
			} else {
				const text = editor.innerText || ''
				navigator.clipboard.writeText(text).then(() => {
					message.success('Р’РµСЃСЊ С‚РµРєСЃС‚ СЃРєРѕРїРёСЂРѕРІР°РЅ')
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
				message.error('РќРµ СѓРґР°Р»РѕСЃСЊ РІСЃС‚Р°РІРёС‚СЊ С‚РµРєСЃС‚')
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
					message.success('РўРµРєСЃС‚ РІС‹СЂРµР·Р°РЅ')
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

	// Р—Р°РіСЂСѓР·РєР° Telegram Premium СЃС‚Р°С‚СѓСЃР° (РїСЂРё 404/РѕС€РёР±РєРµ РёСЃРїРѕР»СЊР·СѓРµРј Р»РёРјРёС‚ 2GB)
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
		// WA: РІ СЂРµРґР°РєС‚РѕСЂРµ С€Р°Р±Р»РѕРЅР° РіСЂСѓР·РёРј РІСЃРµ РіСЂСѓРїРїС‹ С‡РµСЂРµР· РїСЂРѕСЃС‚РѕР№ Р·Р°РіСЂСѓР·С‡РёРє (РєР°Рє РїСЂРё СЃРѕР·РґР°РЅРёРё С€Р°Р±Р»РѕРЅР°),
		// Р° С„Р°РєС‚РёС‡РµСЃРєРёР№ РІС‹Р±РѕСЂ Р±РµСЂС‘Рј РёР· targets (waSelected).
		loadWaGroupsSimple(userId).then(() => {
			loadTargets(userId, 'wa')
		})
		setWaGroupsLoaded(true)
		// TG targets Р·Р°РіСЂСѓР¶Р°РµРј СЃСЂР°Р·Сѓ, РЅРѕ РѕРЅРё РїСЂРёРјРµРЅСЏС‚СЃСЏ С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ Р·Р°РіСЂСѓР·РєРё TG РіСЂСѓРїРї
		loadTargets(userId, 'tg')
		// Р—Р°РіСЂСѓР¶Р°РµРј Telegram Premium СЃС‚Р°С‚СѓСЃ РґР»СЏ РїСЂРѕРІРµСЂРєРё Р»РёРјРёС‚РѕРІ С„Р°Р№Р»РѕРІ
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

	// РЎС‚Р°С‚СѓСЃ РїРѕРґРєР»СЋС‡РµРЅРёСЏ WA/TG РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ В«РџРѕРґРєР»СЋС‡РёС‚СЊ TG/WAВ» РІ РІС‹Р±РѕСЂРµ РєР°РЅР°Р»Р°
	useEffect(() => {
		if (!userId || !token) return
		// 502/Bad Gateway РјРѕР¶РµС‚ РІРµСЂРЅСѓС‚СЊ HTML РІРјРµСЃС‚Рѕ JSON вЂ” РїРѕСЌС‚РѕРјСѓ json() РґРµР»Р°РµРј "safe",
		// С‡С‚РѕР±С‹ РЅРµ СЃС‹РїР°Р»РёСЃСЊ SyntaxError "Unexpected token '<'".
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

	// РџРµСЂРёРѕРґРёС‡РµСЃРєР°СЏ РїСЂРѕРІРµСЂРєР° Telegram Premium СЃС‚Р°С‚СѓСЃР° (РµСЃР»Рё РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РєСѓРїРёР» Premium)
	useEffect(() => {
		if (!userId || channel !== 'tg') return
		
		// Р—Р°РіСЂСѓР¶Р°РµРј СЃС‚Р°С‚СѓСЃ СЃСЂР°Р·Сѓ
		loadTgPremiumStatus(userId)
		
		// РџСЂРѕРІРµСЂСЏРµРј РєР°Р¶РґС‹Рµ 30 СЃРµРєСѓРЅРґ РЅР° СЃР»СѓС‡Р°Р№ РµСЃР»Рё РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РєСѓРїРёР» Premium
		const interval = setInterval(() => {
			loadTgPremiumStatus(userId)
		}, 30000) // 30 СЃРµРєСѓРЅРґ

		return () => clearInterval(interval)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId, channel])

	// TG РґР»СЏ С€Р°Р±Р»РѕРЅР° вЂ” СЃСЂР°Р·Сѓ РїСЂРё РѕС‚РєСЂС‹С‚РёРё СЃС‚СЂР°РЅРёС†С‹ (РѕРґРёРЅ Р·Р°РїСЂРѕСЃ РёР· Р‘Р”), С‡С‚РѕР±С‹ РЅРµ Р¶РґР°С‚СЊ РІРєР»Р°РґРєСѓ Telegram
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

	// РђРІС‚РѕРјР°С‚РёС‡РµСЃРєР°СЏ Р·Р°РіСЂСѓР·РєР° СЃР»РµРґСѓСЋС‰РёС… РїРѕСЂС†РёР№ WA РіСЂСѓРїРї
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

	// РЎРёРЅС…СЂРѕРЅРёР·РёСЂСѓРµРј selectedGroupJids СЃ waSelected/tgSelected. РҐСЂР°РЅРёРј РїРѕР»РЅС‹Р№ СЃРїРёСЃРѕРє
	// РІС‹Р±СЂР°РЅРЅС‹С… ID (РёР· API targets), Р° РЅРµ С‚РѕР»СЊРєРѕ В«РІРёРґРёРјС‹РµВ» РІ С‚РµРєСѓС‰РµР№ РїРѕСЂС†РёРё РіСЂСѓРїРї,
	// РёРЅР°С‡Рµ РїСЂРё РїРѕСЃС‚СЂР°РЅРёС‡РЅРѕР№ Р·Р°РіСЂСѓР·РєРµ РіСЂСѓРїРї РїРѕР»РѕРІРёРЅР° РіР°Р»РѕС‡РµРє СЃР»РµС‚Р°Р»Р°.
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

	// Р¤РёР»СЊС‚СЂ РїРѕ РЅР°Р·РІР°РЅРёСЋ РёР»Рё ID, Р·Р°С‚РµРј РІС‹Р±СЂР°РЅРЅС‹Рµ РЅР°РІРµСЂС…
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
				title: 'Р“СЂСѓРїРїР°',
				key: 'group',
				render: (_: any, row: GroupRow) => {
					const checked = selectedGroupJids.includes(row.jid)
					return (
						<div className='tedit-group-row-inner'>
							<div className='tedit-group-row-main'>
								<div
									className={`tedit-custom-checkbox ${checked ? 'checked' : ''}`}
									role="button"
									tabIndex={0}
									title={checked ? 'РЎРЅСЏС‚СЊ РІС‹РґРµР»РµРЅРёРµ' : 'Р’С‹Р±СЂР°С‚СЊ РіСЂСѓРїРїСѓ'}
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
										(row.title && row.title.trim()) || 'Р“СЂСѓРїРїР°'
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
								<div className='tedit-group-row-info'>
									<span className='tedit-group-row-title'>
										{row.title || 'Р±РµР· РЅР°Р·РІР°РЅРёСЏ'}
									</span>
									<span className='tedit-group-row-id'>
										ID: {row.jid}
									</span>
								</div>
								{checked && (
									<span className='tedit-group-row-badge'>вњ“ Р’С‹Р±СЂР°РЅРѕ</span>
								)}
							</div>
							{channel === 'tg' && (
								<div className='tedit-group-row-interval' onClick={(e) => e.stopPropagation()}>
									{(() => {
										const ov = tgTargetOverrides[row.jid] ?? null
										const tplDef = tgDefaultSendTime
										const eff = ov ?? (tplDef ? String(tplDef) : null) ?? (row.send_time ?? null)
										const title = eff ? `Р­С„С„РµРєС‚РёРІРЅРѕ: ${eff}` : 'Р­С„С„РµРєС‚РёРІРЅРѕ: Р°РІС‚Рѕ'
										return (
											<Select
												allowClear
												placeholder='РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ'
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
									title='РљРѕР»РёС‡РµСЃС‚РІРѕ СѓС‡Р°СЃС‚РЅРёРєРѕРІ РІ РіСЂСѓРїРїРµ'
								>
									{typeof row.participants_count === 'number'
										? `РЈС‡Р°СЃС‚РЅРёРєРѕРІ: ${row.participants_count}`
										: 'РЈС‡Р°СЃС‚РЅРёРєРѕРІ: вЂ”'}
								</span>
							)}
						</div>
					)
				},
			},
		]

		return cols
	}, [channel, selectedGroupJids, waAvatarMap, waAvatarLoading, tgTargetOverrides, tgDefaultSendTime])

	const uploadProps: UploadProps = useMemo(
		() => ({
			maxCount: 1,
			beforeUpload: async file => {
				if (!userId) {
					message.error('РќРµС‚ userId')
					return Upload.LIST_IGNORE
				}

				// РџСЂРѕРІРµСЂРєР° СЂР°Р·РјРµСЂР° С„Р°Р№Р»Р° СЃ СѓС‡РµС‚РѕРј Telegram Premium СЃС‚Р°С‚СѓСЃР°
				if (channel === 'tg' && tgPremiumStatus) {
					const maxSize = tgPremiumStatus.maxFileSize
					if (file.size > maxSize) {
						const maxSizeGB = (maxSize / (1024 * 1024 * 1024)).toFixed(1)
						const fileSizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(1)
						message.error(
							`Р Р°Р·РјРµСЂ С„Р°Р№Р»Р° (${fileSizeGB}GB) РїСЂРµРІС‹С€Р°РµС‚ Р»РёРјРёС‚ РґР»СЏ ${tgPremiumStatus.isPremium ? 'Telegram Premium' : 'РѕР±С‹С‡РЅРѕРіРѕ Р°РєРєР°СѓРЅС‚Р°'} (${maxSizeGB}GB)`
						)
						return Upload.LIST_IGNORE
					}
				} else if (channel === 'tg') {
					// Р•СЃР»Рё СЃС‚Р°С‚СѓСЃ РµС‰Рµ РЅРµ Р·Р°РіСЂСѓР¶РµРЅ, РёСЃРїРѕР»СЊР·СѓРµРј РєРѕРЅСЃРµСЂРІР°С‚РёРІРЅС‹Р№ Р»РёРјРёС‚
					const conservativeLimit = 2 * 1024 * 1024 * 1024 // 2GB
					if (file.size > conservativeLimit) {
						message.warning('РџСЂРѕРІРµСЂСЏРµРј Р»РёРјРёС‚С‹ Telegram... РџРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰Рµ СЂР°Р· С‡РµСЂРµР· СЃРµРєСѓРЅРґСѓ.')
						// РџС‹С‚Р°РµРјСЃСЏ Р·Р°РіСЂСѓР·РёС‚СЊ СЃС‚Р°С‚СѓСЃ СЃРёРЅС…СЂРѕРЅРЅРѕ
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
							`РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё С„Р°Р№Р»Р°: ${json?.message || 'unknown'}`
						)
						return Upload.LIST_IGNORE
					}

					const url = String(json.publicUrl || json.url || '')
					if (!url) {
						message.error('РќРµ РїСЂРёС€Р»Р° СЃСЃС‹Р»РєР° РЅР° С„Р°Р№Р» РѕС‚ СЃРµСЂРІРµСЂР°')
						return Upload.LIST_IGNORE
					}

					setMediaUrl(url)
					message.success('Р¤Р°Р№Р» Р·Р°РіСЂСѓР¶РµРЅ')
				} catch (e) {
					console.error(e)
					message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ С„Р°Р№Р»'))
				} finally {
					setUploading(false)
				}

				return Upload.LIST_IGNORE
			},
		}),
		[userId, token, channel, tgPremiumStatus]
	)

	const onSave = async (values: any) => {
		if (!userId) return message.error('РќРµС‚ userId')
		if (!templateId) return message.error('РќРµС‚ templateId')

		setSaving(true)
		loader.show('РЎРѕС…СЂР°РЅСЏРµРј С€Р°Р±Р»РѕРЅвЂ¦')
		try {
			// РЎРѕС…СЂР°РЅСЏРµРј С‚РµРєСѓС‰РёР№ РІС‹Р±РѕСЂ РіСЂСѓРїРї РґР»СЏ С‚РµРєСѓС‰РµРіРѕ РєР°РЅР°Р»Р°
			if (channel === 'wa') {
				setWaSelected(selectedGroupJids)
			} else {
				setTgSelected(selectedGroupJids)
			}

			// РљРѕРЅРІРµСЂС‚РёСЂСѓРµРј HTML РёР· contentEditable РІ Markdown РїРµСЂРµРґ СЃРѕС…СЂР°РЅРµРЅРёРµРј
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
				message.error(`РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ С€Р°Р±Р»РѕРЅР°: ${errText}`)
				return
			}
			if (json?.persistenceDegraded) {
				message.warning(
					'Р’ Supabase РЅРµС‚ РєРѕР»РѕРЅРѕРє РїР°СѓР· В«РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРёВ» РґР»СЏ С€Р°Р±Р»РѕРЅРѕРІ вЂ” Р·РЅР°С‡РµРЅРёСЏ РїРѕР»Р·СѓРЅРєРѕРІ РЅРµ Р·Р°РїРёСЃР°Р»РёСЃСЊ. Р’С‹РїРѕР»РЅРёС‚Рµ SQL: backend/migrations/add_message_templates_between_groups_sec_range.sql',
				)
			}

			// РђРІС‚РѕРјР°С‚РёС‡РµСЃРєРё СЃРѕС…СЂР°РЅСЏРµРј РіСЂСѓРїРїС‹ РґР»СЏ РѕР±РѕРёС… РєР°РЅР°Р»РѕРІ
			const saved = await saveTargetsForTemplate()
			if (!saved) {
				message.warning('РЁР°Р±Р»РѕРЅ СЃРѕС…СЂР°РЅРµРЅ, РЅРѕ РіСЂСѓРїРїС‹ РЅРµ РѕР±РЅРѕРІР»РµРЅС‹')
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
			if (changedSpeed) parts.push('ETA РїРµСЂРµСЃС‡РёС‚Р°РЅР° РїРѕ РїР°СѓР·Р°Рј В«РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРёВ» РІ С€Р°Р±Р»РѕРЅРµ')
			if (changedDefault) parts.push('РїСЂРµРґСѓРїСЂРµР¶РґРµРЅРёРµ РїСЂРѕ РёРЅС‚РµСЂРІР°Р» TG РІ drawer РѕР±РЅРѕРІРёС‚СЃСЏ (РґРµС„РѕР»С‚ РёР· С€Р°Р±Р»РѕРЅР°)')

			message.success(parts.length ? `РЁР°Р±Р»РѕРЅ СЃРѕС…СЂР°РЅРµРЅ вЂ” ${parts.join(' Рё ')}.` : 'РЁР°Р±Р»РѕРЅ СЃРѕС…СЂР°РЅРµРЅ')
			initialTemplateTimingRef.current = next

			if (typeof window !== 'undefined') window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
			router.push('/dashboard/templates')
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ С€Р°Р±Р»РѕРЅ'))
		} finally {
			setSaving(false)
			loader.hide()
		}
	}

	const onDelete = async () => {
		if (!userId) return message.error('РќРµС‚ userId')
		if (!templateId) return message.error('РќРµС‚ templateId')

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
				message.error(`РћС€РёР±РєР° СѓРґР°Р»РµРЅРёСЏ: ${json?.message || 'unknown'}`)
				return;			}
			message.success('РЁР°Р±Р»РѕРЅ СѓРґР°Р»РµРЅ')
			loader.show('РћР±РЅРѕРІР»СЏРµРј СЃРїРёСЃРѕРє С€Р°Р±Р»РѕРЅРѕРІвЂ¦')
			router.push('/dashboard/templates')
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ СѓРґР°Р»РёС‚СЊ С€Р°Р±Р»РѕРЅ'))
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className='tedit'>
			<div className='tedit__wrap'>
				<p className='tedit__intro'>
					РР·РјРµРЅРёС‚Рµ С‚РµРєСЃС‚ РёР»Рё РІС‹Р±СЂР°РЅРЅС‹Рµ РіСЂСѓРїРїС‹ (РІРєР»Р°РґРєРё WA/TG), Р·Р°С‚РµРј РЅР°Р¶РјРёС‚Рµ В«РЎРѕС…СЂР°РЅРёС‚СЊВ».
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
								<div className='tedit-field__label'>РќР°Р·РІР°РЅРёРµ С€Р°Р±Р»РѕРЅР°</div>
								<Form.Item name='title' style={{ marginBottom: 0 }}>
									<Input
										className='tedit-input'
										placeholder=''
										variant='borderless'
									/>
								</Form.Item>
								<div className='tedit-field__hint'>
									РќР°РїСЂРёРјРµСЂ: РћРїРёСЃР°РЅРёРµ РєРІР°СЂС‚РёСЂС‹, РђРєС†РёСЏ, РџРѕРґР±РѕСЂ РѕР±СЉРµРєС‚РѕРІ
								</div>
							</div>

							<div className='tedit-upload'>
								<div className='tedit-upload__label'>РџСЂРёРєСЂРµРїРёС‚Рµ РјРµРґРёР°С„Р°Р№Р»</div>

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
															alt='РљР°СЂС‚РёРЅРєР°'
															width={19}
															height={19}
														/>
													</span>
													<span>
														РџРµСЂРµС‚Р°С‰РёС‚Рµ С„Р°Р№Р» СЃСЋРґР°
														<br />
														РёР»Рё РЅР°Р¶РјРёС‚Рµ, С‡С‚РѕР±С‹ РІС‹Р±СЂР°С‚СЊ
													</span>
												</div>
											</Upload.Dragger>
										</div>

										<div className='tedit-upload__note'>
											<div className='tedit-upload__noteTitle'>Р’РЅРёРјР°РЅРёРµ!</div>
											<div className='tedit-upload__noteText'>
												РњРѕР¶РЅРѕ РґРѕР±Р°РІРёС‚СЊ С‚РѕР»СЊРєРѕ 1 С„Р°Р№Р» (РёР·РѕР±СЂР°Р¶РµРЅРёРµ, РІРёРґРµРѕ РёР»Рё Р°СѓРґРёРѕ)
												{channel === 'tg' && tgPremiumStatus && (
													<>
														<br />
														РњР°РєСЃРёРјР°Р»СЊРЅС‹Р№ СЂР°Р·РјРµСЂ: {tgPremiumStatus.isPremium ? '4GB' : '2GB'} 
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
											title='РћС‚РєСЂС‹С‚СЊ РІ РїРѕР»РЅРѕРј СЂР°Р·РјРµСЂРµ / Р·Р°РїСѓСЃС‚РёС‚СЊ'
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
														alt='РџСЂРµРІСЊСЋ С„Р°Р№Р»Р°'
													/>
												)}
											</div>
										</button>
										<div className='tedit-upload__previewHint'>РќР°Р¶РјРёС‚Рµ РЅР° РїСЂРµРІСЊСЋ РґР»СЏ РїРѕР»РЅРѕРіРѕ РїСЂРѕСЃРјРѕС‚СЂР° РёР»Рё Р·Р°РїСѓСЃРєР°</div>
										<div className='tedit-upload__actions'>
											<button
												type='button'
												className='tedit-pill'
												onClick={() => setMediaUrl(null)}
												disabled={uploading || saving}
											>
												РЈР±СЂР°С‚СЊ
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
													Р—Р°РјРµРЅРёС‚СЊ
												</button>
											</Upload>
										</div>
									</div>
								)}
							</div>

							<div className='tedit-field'>
								<div className='tedit-field__label'>РўРµРєСЃС‚ СЃРѕРѕР±С‰РµРЅРёСЏ</div>
								<div className='tedit-textarea-wrapper'>
									<div className='tedit-format-toolbar'>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.bold ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('bold')}
											title='Р–РёСЂРЅС‹Р№ (Ctrl+B)'
										>
											<span className='tedit-format-btn__char'>B</span>
										</button>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.italic ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('italic')}
											title='РљСѓСЂСЃРёРІ (Ctrl+I)'
										>
											<span className='tedit-format-btn__char tedit-format-btn__char--italic'>I</span>
										</button>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.underline ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('underline')}
											title='РџРѕРґС‡С‘СЂРєРЅСѓС‚С‹Р№ (Ctrl+U)'
										>
											<span className='tedit-format-btn__char tedit-format-btn__char--underline'>U</span>
										</button>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.strike ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('strikeThrough')}
											title='Р—Р°С‡С‘СЂРєРЅСѓС‚С‹Р№'
										>
											<span className='tedit-format-btn__char tedit-format-btn__char--strike'>S</span>
										</button>
										<div className='tedit-format-separator' />
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.unorderedList ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('insertUnorderedList')}
											title='РњР°СЂРєРёСЂРѕРІР°РЅРЅС‹Р№ СЃРїРёСЃРѕРє'
										>
											<span className='tedit-format-btn__char'>вЂў</span>
										</button>
										<button
											type='button'
											className={`tedit-format-btn ${formatActive.orderedList ? 'is-active' : ''}`}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => formatText('insertOrderedList')}
											title='РќСѓРјРµСЂРѕРІР°РЅРЅС‹Р№ СЃРїРёСЃРѕРє'
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
											title='РњРѕРЅРѕС€РёСЂРёРЅРЅС‹Р№ (РєРѕРґ)'
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
															new Error('РќСѓР¶РЅРѕ Р·Р°РїРѕР»РЅРёС‚СЊ title РёР»Рё text')
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
											data-placeholder='Р’РІРµРґРёС‚Рµ С‚РµРєСЃС‚...'
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
													message.warning(`Р›РёРјРёС‚ СЃРѕРѕР±С‰РµРЅРёСЏ вЂ” ${MAX_MESSAGE_CHARS} СЃРёРјРІРѕР»РѕРІ`)
													return
												}
												// Enter РІ РїСѓСЃС‚РѕР№ СЃС‚СЂРѕРєРµ (РІ С‚.С‡. РІР»РѕР¶РµРЅРЅС‹Р№ div): СЃРј. TemplateRichEditor + htmlToMarkdown (Р±Р»РѕРєРё РїРѕСЃР»Рµ Р¶РёСЂРЅРѕРіРѕ)
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
												// Р“РѕСЂСЏС‡РёРµ РєР»Р°РІРёС€Рё РґР»СЏ С„РѕСЂРјР°С‚РёСЂРѕРІР°РЅРёСЏ
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
													message.warning(`Р›РёРјРёС‚ СЃРѕРѕР±С‰РµРЅРёСЏ вЂ” ${MAX_MESSAGE_CHARS} СЃРёРјРІРѕР»РѕРІ, РІСЃС‚Р°РІР»РµРЅРѕ РґРѕ Р»РёРјРёС‚Р°`)
												}
												document.execCommand('insertText', false, text)
												handleEditorInput()
											}}
										/>
									</Form.Item>
									<div className='tedit-char-count'>
										<span className='tedit-char-count__nums'>
											РЎРёРјРІРѕР»РѕРІ: <strong>{editorCharCount}</strong> / {MAX_MESSAGE_CHARS}
										</span>
										{channel === 'tg' && tgPremiumStatus && (
											<span className='tedit-char-count__tg'>
												{tgPremiumStatus.isPremium ? (
													<> В· Telegram: <strong>Premium</strong> вњ“ (С„Р°Р№Р»С‹ РґРѕ 4 Р“Р‘)</>
												) : (
													<> В· Telegram: РѕР±С‹С‡РЅС‹Р№ Р°РєРєР°СѓРЅС‚ (С„Р°Р№Р»С‹ РґРѕ 2 Р“Р‘)</>
												)}
											</span>
										)}
									</div>
									<Popover
										content={
											<div className='tedit-emoji-picker' ref={emojiPickerRef}>
												<div className='tedit-emoji-grid'>
													{[
														'рџЂ', 'рџѓ', 'рџ„', 'рџЃ', 'рџ…', 'рџ‚', 'рџ¤Ј', 'рџЉ', 'рџ‡', 'рџ™‚', 'рџ™ѓ', 'рџ‰', 'рџЊ', 'рџЌ', 'рџҐ°', 'рџ', 'рџ—', 'рџ™', 'рџљ', 'рџ‹', 'рџ›', 'рџќ', 'рџњ', 'рџ¤Є', 'рџ¤Ё', 'рџ§ђ', 'рџ¤“', 'рџЋ', 'рџ¤©', 'рџҐі', 'рџЏ', 'рџ’', 'рџћ', 'рџ”', 'рџџ', 'рџ•', 'рџ™Ѓ', 'в№пёЏ', 'рџЈ', 'рџ–', 'рџ«', 'рџ©', 'рџҐє', 'рџў', 'рџ­', 'рџ¤', 'рџ ', 'рџЎ', 'рџ¤¬', 'рџ¤Ї', 'рџі', 'рџҐµ', 'рџҐ¶', 'рџ±', 'рџЁ', 'рџ°', 'рџҐ', 'рџ“', 'рџ¤—', 'рџ¤”', 'рџ¤­', 'рџ¤«', 'рџ¤Ґ', 'рџ¶', 'рџђ', 'рџ‘', 'рџ¬', 'рџ™„', 'рџЇ', 'рџ¦', 'рџ§', 'рџ®', 'рџІ', 'рџҐ±', 'рџґ', 'рџ¤¤', 'рџЄ', 'рџµ', 'рџ¤ђ', 'рџҐґ', 'рџ¤ў', 'рџ¤®', 'рџ¤§', 'рџ·', 'рџ¤’', 'рџ¤•', 'рџ¤‘', 'рџ¤ ', 'рџ€', 'рџ‘ї', 'рџ‘№', 'рџ‘є', 'рџ¤Ў', 'рџ’©', 'рџ‘»', 'рџ’Ђ', 'в пёЏ', 'рџ‘Ѕ', 'рџ‘ѕ', 'рџ¤–', 'рџЋѓ',
														'рџ‘Ќ', 'рџ‘Ћ', 'рџ‘Њ', 'вњЊпёЏ', 'рџ¤ћ', 'рџ¤џ', 'рџ¤', 'рџ¤™', 'рџ‘€', 'рџ‘‰', 'рџ‘†', 'рџ‘‡', 'вќпёЏ', 'рџ‘Џ', 'рџ™Њ', 'рџ‘ђ', 'рџ¤І', 'рџ¤ќ', 'рџ™Џ', 'вњЌпёЏ', 'рџ’Є', 'рџ¦µ', 'рџ¦¶', 'рџ‘‚', 'рџ‘ѓ', 'рџ§ ', 'рџ¦·', 'рџ¦ґ', 'рџ‘Ђ', 'рџ‘ЃпёЏ', 'рџ‘…', 'рџ‘„', 'рџ’‹',
														'рџ’', 'рџ’ќ', 'рџ’–', 'рџ’—', 'рџ’“', 'рџ’ћ', 'рџ’•', 'рџ’џ', 'вќЈпёЏ', 'рџ’”', 'вќ¤пёЏ', 'рџ§Ў', 'рџ’›', 'рџ’љ', 'рџ’™', 'рџ’њ', 'рџ–¤', 'рџ¤Ќ', 'рџ¤Ћ', 'рџ’Ї', 'рџ’ў', 'рџ’Ґ', 'рџ’«', 'рџ’¦', 'рџ’Ё', 'рџ•іпёЏ', 'рџ’Ј', 'рџ’¬', 'рџ‘ЃпёЏвЂЌрџ—ЁпёЏ', 'рџ—ЁпёЏ', 'рџ—ЇпёЏ', 'рџ’­', 'рџ’¤',
														'вњ€пёЏ', 'рџ“±', 'рџ“ў', 'рџ”ђ', 'рџЊђ', 'вљЎ', 'рџљЂ', 'рџ“Ћ', 'рџ“ё', 'рџ”Ќ', 'рџ“ќ', 'вљ™пёЏ', 'вњ…', 'вќЊ', 'вљ пёЏ', 'в„№пёЏ', 'рџ”ґ', 'рџџ ', 'рџџЎ', 'рџџў', 'рџ”µ', 'рџџЈ', 'вљ«', 'вљЄ', 'рџџ¤',
														'рџ”Ґ', 'в­ђ', 'рџЊџ', 'вњЁ', 'рџЋ‰', 'рџЋЉ', 'рџЋ€', 'рџЋЃ', 'рџЏ†', 'рџҐ‡', 'рџҐ€', 'рџҐ‰', 'рџЋ–пёЏ', 'рџЏ…', 'рџЋ—пёЏ', 'рџЋ«', 'рџЋџпёЏ', 'рџЋЄ', 'рџЋ­', 'рџЋЁ', 'рџЋ¬', 'рџЋ¤', 'рџЋ§', 'рџЋј', 'рџЋ№', 'рџҐЃ', 'рџЋ·', 'рџЋє', 'рџЋё', 'рџЋ»', 'рџЋІ', 'рџЋЇ', 'рџЋі', 'рџЋ®', 'рџ•№пёЏ', 'рџЋ°', 'рџ§©',
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
											title='Р”РѕР±Р°РІРёС‚СЊ СЌРјРѕРґР·Рё'
										>
											рџЂ
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
												<b>B</b> Р–РёСЂРЅС‹Р№
											</button>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={() => formatText('italic')}
											>
												<i>I</i> РљСѓСЂСЃРёРІ
											</button>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={() => formatText('underline')}
											>
												<u>U</u> РџРѕРґС‡РµСЂРєРЅСѓС‚С‹Р№
											</button>
											<div className='tedit-context-menu-separator' />
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={copyText}
											>
												рџ“‹ РљРѕРїРёСЂРѕРІР°С‚СЊ
											</button>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={cutText}
											>
												вњ‚пёЏ Р’С‹СЂРµР·Р°С‚СЊ
											</button>
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={pasteText}
											>
												рџ“„ Р’СЃС‚Р°РІРёС‚СЊ
											</button>
											<div className='tedit-context-menu-separator' />
											<button
												type='button'
												className='tedit-context-menu-item'
												onClick={selectAll}
											>
												Р’С‹РґРµР»РёС‚СЊ РІСЃРµ
											</button>
										</div>
									)}
								</div>
								<div className='tedit-field__hint'>
									Р’РІРµРґРёС‚Рµ С‚РµРєСЃС‚ СЃРѕРѕР±С‰РµРЅРёСЏ. РџРѕРґРґРµСЂР¶РёРІР°РµС‚СЃСЏ С„РѕСЂРјР°С‚РёСЂРѕРІР°РЅРёРµ Рё СЌРјРѕРґР·Рё
								</div>
							</div>

							{/* Р’РєР»СЋС‡РµРЅРёРµ + РїРѕСЂСЏРґРѕРє (СЂСЏРґРѕРј) */}
							<div className='tedit-mini'>
								<div className='tedit-mini__item'>
									<div>
										<div className='tedit-mini__label'>Р’РєР»СЋС‡С‘РЅ</div>
										<div className='tedit-mini__hint'>Р•СЃР»Рё РІС‹РєР»СЋС‡РёС‚СЊ вЂ” СЌС‚РѕС‚ С€Р°Р±Р»РѕРЅ РЅРµ Р±СѓРґРµС‚ СѓС‡Р°СЃС‚РІРѕРІР°С‚СЊ РІ СЂР°СЃСЃС‹Р»РєР°С….</div>
									</div>
									<Form.Item name='enabled' valuePropName='checked' style={{ marginBottom: 0 }}>
										<Switch />
									</Form.Item>
								</div>

								<div className='tedit-mini__item' style={{ display: 'none' }}>
									<div>
										<div className='tedit-mini__label'>РџРѕСЂСЏРґРѕРє РѕС‚РїСЂР°РІРєРё</div>
										<div className='tedit-mini__hint'>Р§РµРј РјРµРЅСЊС€Рµ С‡РёСЃР»Рѕ, С‚РµРј СЂР°РЅСЊС€Рµ РѕС‚РїСЂР°РІР»СЏРµС‚СЃСЏ СЌС‚РѕС‚ С€Р°Р±Р»РѕРЅ (1 вЂ” СЃР°РјС‹Р№ РїРµСЂРІС‹Р№).</div>
									</div>
									<Form.Item name='order' style={{ marginBottom: 0 }}>
										<InputNumber min={1} />
									</Form.Item>
								</div>
							</div>

							{/* РњРµРґРёР° РєР°Рє С„Р°Р№Р» (СЃСЂР°Р·Сѓ РїРѕРґ Р·Р°РіСЂСѓР·С‡РёРєРѕРј) */}
							<div className='tedit-mini'>
								<div className='tedit-mini__item'>
									<div>
										<div className='tedit-mini__label'>РћС‚РїСЂР°РІР»СЏС‚СЊ РјРµРґРёР° РєР°Рє С„Р°Р№Р»</div>
										<div className='tedit-mini__hint'>Р’РєР»СЋС‡РµРЅРѕ вЂ” РјРµРґРёР° РїСЂРёРґС‘С‚ РєР°Рє РґРѕРєСѓРјРµРЅС‚. Р’С‹РєР»СЋС‡РµРЅРѕ вЂ” РїРѕРєР°Р·С‹РІР°РµС‚СЃСЏ РїСЂСЏРјРѕ РІ С‡Р°С‚Рµ (РїСЂРµРІСЊСЋ/РїР»РµРµСЂ).</div>
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
												<ChannelIcon type='wa' size={14} /> РџР°СѓР·Р° РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРё WhatsApp (СЌС‚РѕС‚ С€Р°Р±Р»РѕРЅ)
											</div>
											<div className='tedit-mini__hint'>
												Р—РґРµСЃСЊ РІС‹ Р·Р°РґР°С‘С‚Рµ РґР»СЏ С€Р°Р±Р»РѕРЅР° РјРёРЅРёРјСѓРј Рё РјР°РєСЃРёРјСѓРј СЃРµРєСѓРЅРґ РїР°СѓР·С‹ РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРё РІ РІРѕР»РЅРµ WhatsApp: РїСЂРё СЂР°СЃСЃС‹Р»РєРµ Р±РµСЂС‘С‚СЃСЏ{' '}
												<b>СЃР»СѓС‡Р°Р№РЅРѕРµ</b> С‡РёСЃР»Рѕ СЃРµРєСѓРЅРґ РјРµР¶РґСѓ РІС‹Р±СЂР°РЅРЅС‹РјРё В«РѕС‚В» Рё В«РґРѕВ». РџРѕР»Р·СѓРЅРєРё РЅР°СЃС‚СЂР°РёРІР°СЋС‚СЃСЏ РІ РїСЂРµРґРµР»Р°С… 5вЂ“600 СЃ.
											</div>
										</div>
										<Tag className='tedit-pauseBetweenGroups__tag'>
											{(() => {
												const [lo, hi] = clampTemplatePauseSecPair(
													Number(waPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[0]),
													Number(waPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[1]),
												)
												return `${lo}вЂ“${hi} СЃ`
											})()}
										</Tag>
									</div>
									<Slider
										range
										className='tedit-speed-slider'
										min={5}
										max={600}
										step={5}
										tooltip={{ formatter: (v) => `${v} СЃРµРє` }}
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
												<ChannelIcon type='tg' size={14} /> РџР°СѓР·Р° РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРё Telegram (СЌС‚РѕС‚ С€Р°Р±Р»РѕРЅ)
											</div>
											<div className='tedit-mini__hint'>
												РўРѕ Р¶Рµ РґР»СЏ Telegram: РїРѕР»Р·СѓРЅРєРё Р·Р°РґР°СЋС‚ РґРёР°РїР°Р·РѕРЅ СЃРµРєСѓРЅРґ РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРё (СЃР»СѓС‡Р°Р№РЅР°СЏ РїР°СѓР·Р° РІРЅСѓС‚СЂРё В«РѕС‚В»вЂ“В«РґРѕВ»). РџРѕР»Р·СѓРЅРєРё: 5вЂ“600 СЃ.
											</div>
										</div>
										<Tag className='tedit-pauseBetweenGroups__tag'>
											{(() => {
												const [lo, hi] = clampTemplatePauseSecPair(
													Number(tgPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[0]),
													Number(tgPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[1]),
												)
												return `${lo}вЂ“${hi} СЃ`
											})()}
										</Tag>
									</div>
									<Slider
										range
										className='tedit-speed-slider'
										min={5}
										max={600}
										step={5}
										tooltip={{ formatter: (v) => `${v} СЃРµРє` }}
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
										<div className='tedit-mini__label'>Р”РµС„РѕР»С‚РЅС‹Р№ РёРЅС‚РµСЂРІР°Р» Telegram</div>
										<div className='tedit-mini__hint'>Р•СЃР»Рё Сѓ TG-РіСЂСѓРїРїС‹ РЅРµ Р·Р°РґР°РЅ СЃРІРѕР№ РёРЅС‚РµСЂРІР°Р» (override), РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ СЌС‚РѕС‚ РёРЅС‚РµСЂРІР°Р» С€Р°Р±Р»РѕРЅР°. Р•СЃР»Рё override Р·Р°РґР°РЅ вЂ” РѕРЅ РІР°Р¶РЅРµРµ.</div>
									</div>
									<Form.Item name='tg_default_send_time' style={{ marginBottom: 0 }}>
										<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
											<Select
												allowClear
												placeholder='РРЅС‚РµСЂРІР°Р»'
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
									РљСѓРґР° РѕС‚РїСЂР°РІР»СЏС‚СЊ СЌС‚РѕС‚ С€Р°Р±Р»РѕРЅ
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
															? 'РџРѕРґРєР»СЋС‡РёС‚СЊ TG'
															: `Telegram${loadingGroups ? ' В· Р·Р°РіСЂСѓР·РєР°' : ''}`}
													</span>
													{tgConnected !== false && (
														<span className='tedit-channelTab__meta'>
															{loadingGroups ? (
																<span className='tedit-channelTab__load' aria-hidden='true' />
															) : null}
															<span>
																{loadingGroups
																	? `${tgAnimatedCount}/${tgTotalGroups > 0 ? tgTotalGroups : 'вЂ¦'}`
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
															? 'РџРѕРґРєР»СЋС‡РёС‚СЊ WA'
															: `WhatsApp${loadingWaList || waLoadingMore ? ' В· Р·Р°РіСЂСѓР·РєР°' : ''}`}
													</span>
													{waConnected !== false && (
														<span className='tedit-channelTab__meta'>
															{loadingWaList || waLoadingMore ? (
																<span className='tedit-channelTab__load' aria-hidden='true' />
															) : null}
															<span>{loadingWaList || waLoadingMore ? 'вЂ¦' : `${waGroups.length}`}</span>
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
												TG: РґР»СЏ С€Р°Р±Р»РѕРЅР° <b>{tgSelected.length}</b>
												{' В· '}
												РІ С‚Р°Р±Р»РёС†Рµ <b>{tgGroups.length}</b> {pluralRuGroups(tgGroups.length)}
											</span>
										</span>
										{!tgHasMore && tgTotalRows > tgTotalGroups ? (
											<div className='tedit-targets__countHint'>
												Р’ Р±Р°Р·Рµ РґР»СЏ РІС‹Р±СЂР°РЅРЅС‹С… РіСЂСѓРїРї TG Р·Р°РїРёСЃР°РЅРѕ <b>{tgTotalRows}</b> СЃС‚СЂРѕРє, Р° СЂР°Р·РЅС‹С…
												С‡Р°С‚РѕРІ <b>{tgTotalGroups}</b> вЂ” Р»РёС€РЅРёРµ СЃС‚СЂРѕРєРё РґСѓР±Р»РёСЂСѓСЋС‚ РѕРґРёРЅ Рё С‚РѕС‚ Р¶Рµ С‡Р°С‚
												(РѕР±С‹С‡РЅРѕ РїРѕСЃР»Рµ РїРѕРІС‚РѕСЂРЅС‹С… СЃРёРЅРєРѕРІ). Р“РѕС‚РѕРІР°СЏ С‡РёСЃС‚РєР°: С„Р°Р№Р»{' '}
												<b>backend/migrations/fix_duplicate_groups.sql</b> (Рї. 3вЂ“4 Рё СѓРЅРёРєР°Р»СЊРЅС‹Р№ РёРЅРґРµРєСЃ
												РґР»СЏ TG).
											</div>
										) : null}
									</div>
									<span className='tedit-targets__countItem'>
										<ChannelIcon type='wa' size={14} />
										<span>
											WA: РґР»СЏ С€Р°Р±Р»РѕРЅР° <b>{waSelected.length}</b>
											{' В· '}
											РІ С‚Р°Р±Р»РёС†Рµ <b>{waGroups.length}</b> {pluralRuGroups(waGroups.length)}
										</span>
									</span>
									<p className='tedit-targets__legend'>
										В«Р”Р»СЏ С€Р°Р±Р»РѕРЅР°В» вЂ” С‡Р°С‚С‹, РѕС‚РјРµС‡РµРЅРЅС‹Рµ РґР»СЏ СЌС‚РѕРіРѕ С€Р°Р±Р»РѕРЅР° РІ С‚Р°Р±Р»РёС†Рµ РЅРёР¶Рµ (РїРѕРєР° РЅРµ
										РѕС‚РјРµС‚РёР»Рё вЂ” 0). В«Р’ С‚Р°Р±Р»РёС†РµВ» вЂ” РіСЂСѓРїРїС‹ СЃ РІРєР»СЋС‡С‘РЅРЅРѕР№ СЂР°СЃСЃС‹Р»РєРѕР№ РёР· В«Р“СЂСѓРїРїС‹ TG / WAВ»;
										TG РїРѕРґРіСЂСѓР¶Р°РµС‚СЃСЏ РёР· Р±Р°Р·С‹ РѕРґРЅРёРј Р·Р°РїСЂРѕСЃРѕРј РїСЂРё РѕС‚РєСЂС‹С‚РёРё СЃС‚СЂР°РЅРёС†С‹ СЂРµРґР°РєС‚РёСЂРѕРІР°РЅРёСЏ.
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
											Р—Р°РіСЂСѓР¶Р°РµРј WhatsApp-РіСЂСѓРїРїС‹вЂ¦
										</span>
									) : (
										<span className='tedit-targets__meta-idle'>
											Р’ СЃРїРёСЃРєРµ <b>{waGroups.length}</b> {pluralRuGroups(waGroups.length)}
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
												? `Р—Р°РіСЂСѓР¶Р°РµРј С‡Р°С‚С‹: ${tgAnimatedCount} РёР· ${tgTotalGroups}${
														tgTotalRows > tgTotalGroups
															? ` (РІ Р‘Р” ${tgTotalRows} СЃС‚СЂРѕРє вЂ” РµСЃС‚СЊ РґСѓР±Р»Рё РїРѕ С‡Р°С‚Сѓ)`
															: ''
													}вЂ¦`
												: 'Р—Р°РіСЂСѓР¶Р°РµРј Telegram-РіСЂСѓРїРїС‹вЂ¦'}
										</span>
									) : (
										<>
											<span className='tedit-targets__meta-idle'>
												Р’ СЃРїРёСЃРєРµ <b>{tgGroups.length}</b> {pluralRuGroups(tgGroups.length)}
												{tgDbStats && tgDbStats.total > 0 && (
													<>
														{' '}
														В· РІ В«
														<Link href='/dashboard/groups/telegram' className='tedit-link'>
															Р“СЂСѓРїРїС‹ TG
														</Link>
														В»: РІСЃРµРіРѕ <b>{tgDbStats.total}</b>, СЃ СЂР°СЃСЃС‹Р»РєРѕР№{' '}
														<b>{tgDbStats.selected}</b>
													</>
												)}
											</span>
											{tgDbStats &&
												tgDbStats.selected < tgDbStats.total &&
												!loadingGroups && (
													<div className='tedit-targets__meta-hint'>
														РЎ СЂР°СЃСЃС‹Р»РєРѕР№ СЃРµР№С‡Р°СЃ С‚РѕР»СЊРєРѕ <b>{tgDbStats.selected}</b> РёР·{' '}
														<b>{tgDbStats.total}</b> РіСЂСѓРїРї. РћСЃС‚Р°Р»СЊРЅС‹Рµ Р·РґРµСЃСЊ РЅРµ РїРѕСЏРІСЏС‚СЃСЏ, РїРѕРєР° РЅРµ
														РІРєР»СЋС‡РёС‚Рµ РёС… РІ В«Р“СЂСѓРїРїС‹ TGВ».
													</div>
												)}
											{tgDbStats &&
												tgDbStats.selected > 0 &&
												!tgHasMore &&
												!loadingGroups &&
												tgGroups.length < tgDbStats.selected && (
													<div className='tedit-targets__meta-hint tedit-targets__meta-hint--warn'>
														Р’ С‚Р°Р±Р»РёС†Рµ <b>{tgGroups.length}</b>, Р° СЃ СЂР°СЃСЃС‹Р»РєРѕР№ РІ Р±Р°Р·Рµ{' '}
														<b>{tgDbStats.selected}</b> вЂ” РїСЂРѕРІРµСЂСЊС‚Рµ РѕС‚РІРµС‚ API РёР»Рё РѕР±РЅРѕРІРёС‚Рµ СЃС‚СЂР°РЅРёС†Сѓ.
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
										Telegram РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ. РџРѕРґРєР»СЋС‡РёС‚Рµ РІ РєР°Р±РёРЅРµС‚Рµ, С‡С‚РѕР±С‹ РІС‹Р±РёСЂР°С‚СЊ РіСЂСѓРїРїС‹ РґР»СЏ СЌС‚РѕРіРѕ С€Р°Р±Р»РѕРЅР°.{' '}
										<button
											type='button'
											className='tedit-link'
											onClick={() => { loader.show('Р’ РєР°Р±РёРЅРµС‚вЂ¦'); router.push('/cabinet#telegram') }}
										>
											РџРѕРґРєР»СЋС‡РёС‚СЊ TG
										</button>
									</div>
								)}
								{channel === 'wa' && waConnected === false && (
									<div className='tedit-warning-message tedit-warning-message--connect'>
										<ChannelIcon type='wa' size={20} variant='failed' />{' '}
										WhatsApp РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ. РџРѕРґРєР»СЋС‡РёС‚Рµ РІ РєР°Р±РёРЅРµС‚Рµ, С‡С‚РѕР±С‹ РІС‹Р±РёСЂР°С‚СЊ РіСЂСѓРїРїС‹ РґР»СЏ СЌС‚РѕРіРѕ С€Р°Р±Р»РѕРЅР°.{' '}
										<button
											type='button'
											className='tedit-link'
											onClick={() => { loader.show('Р’ РєР°Р±РёРЅРµС‚вЂ¦'); router.push('/cabinet#whatsapp') }}
										>
											РџРѕРґРєР»СЋС‡РёС‚СЊ WA
										</button>
									</div>
								)}
								{channel === 'wa' && waConnected !== false && waGroupsLoaded && waGroups.length === 0 && (
									<div className='tedit-warning-message tedit-warning-message--empty'>
										РќРµС‚ РІС‹Р±СЂР°РЅРЅС‹С… WhatsApp РіСЂСѓРїРї. Р’С‹Р±РµСЂРёС‚Рµ РіСЂСѓРїРїС‹ РЅР° СЃС‚СЂР°РЅРёС†Рµ{' '}
										<Link href='/dashboard/groups' className='tedit-link'>РЈРїСЂР°РІР»РµРЅРёРµ РіСЂСѓРїРїР°РјРё</Link> (РІРєР»Р°РґРєР° WhatsApp), Р·Р°С‚РµРј РІРѕР·РІСЂР°С‰Р°Р№С‚РµСЃСЊ СЃСЋРґР°.
									</div>
								)}
								{groups.length > 0 && selectedGroupJids.length === 0 && (channel === 'tg' ? tgConnected !== false : waConnected !== false) && (
									<div className='tedit-warning-message'>
										Р”Р»СЏ РєР°РЅР°Р»Р° <b>{channel.toUpperCase()}</b> РЅРµ РІС‹Р±СЂР°РЅС‹ РіСЂСѓРїРїС‹.
										<br />
										Р Р°СЃСЃС‹Р»РєР° РїРѕ СЌС‚РѕРјСѓ РєР°РЅР°Р»Сѓ РЅРµ Р·Р°РїСѓСЃС‚РёС‚СЃСЏ, РїРѕРєР° РІС‹ РЅРµ РѕС‚РјРµС‚РёС‚Рµ
										РіСЂСѓРїРїС‹ Рё РЅРµ РЅР°Р¶РјС‘С‚Рµ В«РЎРѕС…СЂР°РЅРёС‚СЊ РіСЂСѓРїРїС‹ ({channel.toUpperCase()})В».
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
									Р’С‹Р±СЂР°С‚СЊ РІСЃРµ
								</button>

								<button
									type='button'
									className='tedit-pill'
									onClick={() => {
										// РЎРЅРёРјР°РµРј РІС‹РґРµР»РµРЅРёРµ СЃРѕ РІСЃРµС… РіСЂСѓРїРї (РЅРµ СѓРґР°Р»СЏРµРј РіСЂСѓРїРїС‹ РёР· СЃРїРёСЃРєР°)
										setSelectedGroupJids([])
										if (channel === 'wa') setWaSelected([])
										else setTgSelected([])
									}}
									disabled={!selectedGroupJids.length}
									title='РЎРЅСЏС‚СЊ РІС‹РґРµР»РµРЅРёРµ СЃРѕ РІСЃРµС… РіСЂСѓРїРї'
								>
									РЎРЅСЏС‚СЊ РІС‹РґРµР»РµРЅРёРµ
								</button>

								{channel === 'tg' && selectedGroupJids.length > 0 && (
									<div className='tedit-targets__bulk-interval'>
										<Select
											placeholder='РРЅС‚РµСЂРІР°Р» РґР»СЏ РІСЃРµС…'
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
												message.success(`РРЅС‚РµСЂРІР°Р» РїСЂРёРјРµРЅС‘РЅ Рє ${selectedGroupJids.length} РіСЂСѓРїРїР°Рј (СЃРѕС…СЂР°РЅРёС‚СЃСЏ РїСЂРё СЃРѕС…СЂР°РЅРµРЅРёРё С€Р°Р±Р»РѕРЅР°)`)
											}}
										>
											{applyingBulkInterval ? 'РџСЂРёРјРµРЅСЏРµРјвЂ¦' : 'РџСЂРёРјРµРЅРёС‚СЊ РєРѕ РІСЃРµРј'}
										</button>
									</div>
								)}
							</div>

							<div className='tedit-targets__filter'>
								<Input
									placeholder='Р¤РёР»СЊС‚СЂ РїРѕ РЅР°Р·РІР°РЅРёСЋ РёР»Рё ID РіСЂСѓРїРїС‹'
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
													// РќРµ РїРµСЂРµРєР»СЋС‡Р°РµРј РІС‹Р±РѕСЂ, РµСЃР»Рё РєР»РёРє Р±С‹Р» РЅР° Select РёР»Рё С‡РµРєР±РѕРєСЃРµ
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
								Р’С‹Р±РѕСЂ СЃРѕС…СЂР°РЅРёС‚СЃСЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РїСЂРё СЃРѕС…СЂР°РЅРµРЅРёРё С€Р°Р±Р»РѕРЅР°.
							</div>
						</div>
					</div>

					<div className='tedit-actions'>
						<button
							className='tedit-btn tedit-btn--primary'
							type='submit'
							disabled={saving || uploading || loadingMe || loadingTpl}
						>
							{saving ? 'РЎРѕС…СЂР°РЅСЏРµРј...' : 'РЎРѕС…СЂР°РЅРёС‚СЊ С€Р°Р±Р»РѕРЅ'}
						</button>
					</div>

					{loadingTpl ? (
						<div style={{ marginTop: 10, opacity: 0.75, textAlign: 'center' }}>
							Р—Р°РіСЂСѓР·РєР°...
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
