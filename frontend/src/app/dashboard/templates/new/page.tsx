'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Cookies from 'js-cookie'
import {
	Form,
	Input,
	InputNumber,
	Switch,
	message,
	Upload,
	Table,
	Segmented,
	Select,
	Slider,
	TimePicker,
	Tag,
} from 'antd'
import type { UploadProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { UploadOutlined } from '@ant-design/icons'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { apiPost, getApiErrorMessage } from '@/lib/api'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { SEND_INTERVAL_OPTIONS } from '@/constants/sendIntervals'
import { ChannelIcon } from '@/components/ChannelIcon'
import { MediaViewerModal } from '@/components/MediaViewerModal'
import './page.css'
import { TemplateRichEditor } from '@/components/TemplateRichEditor'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'
import {
	clampPausePairFromFormValues,
	clampTemplatePauseSecPair,
	TEMPLATE_FORM_DEFAULT_PAUSE,
} from '@/lib/templateBetweenGroupsRange'
import { pluralRuGroups } from '@/lib/pluralRu'
import Image from 'next/image'
import dayjs from 'dayjs'


const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

/** Р›РёРјРёС‚ СЃРёРјРІРѕР»РѕРІ РІ РѕРґРЅРѕРј СЃРѕРѕР±С‰РµРЅРёРё (Telegram Рё WhatsApp) */
const MAX_MESSAGE_CHARS = 4096

const TEMPLATE_SAVE_TIMEOUT_MS = 90_000

function isVideoUrl(url: string | null) {
	if (!url) return false
	const clean = url.split('?')[0] || ''
	// webm РЅРµ РІРєР»СЋС‡Р°РµРј: РіРѕР»РѕСЃРѕРІС‹Рµ РёРґСѓС‚ РєР°Рє .webm, РїРѕРєР°Р·С‹РІР°РµРј РёС… РєР°Рє Р°СѓРґРёРѕ
	return /\.(mp4|mov|m4v)$/i.test(clean)
}

function isAudioUrl(url: string | null) {
	if (!url) return false
	const clean = url.split('?')[0] || ''
	// .webm вЂ” С‡Р°СЃС‚Рѕ РіРѕР»РѕСЃРѕРІС‹Рµ; РїРѕРєР°Р·С‹РІР°РµРј РєР°Рє Р°СѓРґРёРѕ (Р±РµР· РѕРєРЅР° РІРёРґРµРѕ)
	return /\.(mp3|ogg|wav|m4a|webm)$/i.test(clean)
}

function isHHMM(v: any) {
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim())
}

type UiGroupRow = {
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

export default function TemplateCreatePage() {
	const router = useRouter()
	const [userId, setUserId] = useState('')
	const [saving, setSaving] = useState(false)
	const [uploading, setUploading] = useState(false)
	const [mediaViewerUrl, setMediaViewerUrl] = useState<string | null>(null)
	const [mediaUrl, setMediaUrl] = useState<string | null>(null)
	/** 'audio' = РіРѕР»РѕСЃРѕРІРѕРµ/Р°СѓРґРёРѕ, 'video' = РІРёРґРµРѕ, 'image' = РєР°СЂС‚РёРЅРєР°; РґР»СЏ РїСЂРµРІСЊСЋ Р±РµР· РѕРєРЅР° РІРёРґРµРѕ Сѓ Р°СѓРґРёРѕ */
	const [mediaKind, setMediaKind] = useState<'audio' | 'video' | 'image' | null>(null)
	const [form] = Form.useForm()

	const tgDefaultSendTime = Form.useWatch('tg_default_send_time', form)
	const waPauseLo = Form.useWatch('wa_between_groups_sec_min', form)
	const waPauseHi = Form.useWatch('wa_between_groups_sec_max', form)
	const tgPauseLo = Form.useWatch('tg_between_groups_sec_min', form)
	const tgPauseHi = Form.useWatch('tg_between_groups_sec_max', form)

	// вњ… channel + groups
	const [channel, setChannel] = useState<'wa' | 'tg'>('tg')
	const [waGroups, setWaGroups] = useState<UiGroupRow[]>([])
	const [tgGroups, setTgGroups] = useState<UiGroupRow[]>([])

	// вњ… selections per channel
	const [waSelected, setWaSelected] = useState<string[]>([])
	const [tgSelected, setTgSelected] = useState<string[]>([])
	const [waConnected, setWaConnected] = useState<boolean | null>(null)
	const [tgConnected, setTgConnected] = useState<boolean | null>(null)
	const [savingTargets, setSavingTargets] = useState(false)
	const [textValue, setTextValue] = useState('')
	const [waAvatarMap, setWaAvatarMap] = useState<Record<string, string | null>>({})
	const [waAvatarLoading, setWaAvatarLoading] = useState<Record<string, boolean>>({})
	const [bulkInterval, setBulkInterval] = useState<string | null>(null)
	const [applyingBulkInterval, setApplyingBulkInterval] = useState(false)
	const [groupFilterQuery, setGroupFilterQuery] = useState('')

	// Override РёРЅС‚РµСЂРІР°Р»Р° TG РЅР° СѓСЂРѕРІРЅРµ (С€Р°Р±Р»РѕРЅ в†’ РіСЂСѓРїРїР°)
	const [tgTargetOverrides, setTgTargetOverrides] = useState<Record<string, string | null>>({})

	const [loadingWaGroups, setLoadingWaGroups] = useState(false)
	const [loadingTgGroups, setLoadingTgGroups] = useState(false)
	const [tgTotalGroups, setTgTotalGroups] = useState(0)
	/** РЎС‚СЂРѕРє РІ telegram_groups (РїР°РіРёРЅР°С†РёСЏ); РµСЃР»Рё Р±РѕР»СЊС€Рµ tgTotalGroups вЂ” РІ Р‘Р” РµСЃС‚СЊ РґСѓР±Р»Рё РїРѕ tg_chat_id */
	const [tgTotalRows, setTgTotalRows] = useState(0)
	const [tgHasMore, setTgHasMore] = useState(false)
	const [waAnimatedCount, setWaAnimatedCount] = useState(0)
	const [tgAnimatedCount, setTgAnimatedCount] = useState(0)
	const waAnimationFrameRef = useRef<number | null>(null)
	const tgAnimationFrameRef = useRef<number | null>(null)
	/** РЎРІРѕРґРєР° РёР· /telegram/groups/:id/count: РІСЃРµРіРѕ С‡Р°С‚РѕРІ vs СЃ СЂР°СЃСЃС‹Р»РєРѕР№ (РєР°Рє РЅР° СЃС‚СЂР°РЅРёС†Рµ В«Р“СЂСѓРїРїС‹ TGВ») */
	const [tgDbStats, setTgDbStats] = useState<{ total: number; selected: number } | null>(null)

	const loader = useGlobalLoader()

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

	const fetchMe = async () => {
		if (!token) {
			router.push('/auth/phone')
			return;		}

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
		}
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

	const warmupWaAvatars = (rows: UiGroupRow[], limit = 18) => {
		const toLoad = rows
			.slice(0, limit)
			.map(row => String(row.jid || '').trim())
			.filter(Boolean)

		for (const jid of toLoad) {
			if (waAvatarMap[jid] === undefined && !waAvatarLoading[jid]) {
				void ensureWaAvatar(jid)
			}
		}
	}

	function animateWaCount(from: number, to: number) {
		if (waAnimationFrameRef.current !== null) cancelAnimationFrame(waAnimationFrameRef.current)
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
			if (progress < 1) waAnimationFrameRef.current = requestAnimationFrame(animate)
			else {
				setWaAnimatedCount(to)
				waAnimationFrameRef.current = null
			}
		}
		waAnimationFrameRef.current = requestAnimationFrame(animate)
	}

	function animateTgCount(from: number, to: number) {
		if (tgAnimationFrameRef.current !== null) cancelAnimationFrame(tgAnimationFrameRef.current)
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
			if (progress < 1) tgAnimationFrameRef.current = requestAnimationFrame(animate)
			else {
				setTgAnimatedCount(to)
				tgAnimationFrameRef.current = null
			}
		}
		tgAnimationFrameRef.current = requestAnimationFrame(animate)
	}

	const loadWaGroups = async (uid: string) => {
		setLoadingWaGroups(true)
		setWaAnimatedCount(0)
		try {
			const res = await fetch(`${BACKEND_URL}/whatsapp/groups/${uid}?selectedOnly=true`, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const raw = await res.json().catch(() => null)
			if (!raw) {
				message.error('РќРµС‚ РѕС‚РІРµС‚Р° РѕС‚ СЃРµСЂРІРµСЂР° РїСЂРё Р·Р°РіСЂСѓР·РєРµ WA РіСЂСѓРїРї')
				setWaGroups([])
				return
			}
			if (!raw.success) {
				message.error(raw.message || 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ WA РіСЂСѓРїРїС‹')
				setWaGroups([])
				return
			}

			// Р‘СЌРєРµРЅРґ СѓР¶Рµ РІРµСЂРЅСѓР» С‚РѕР»СЊРєРѕ РІС‹Р±СЂР°РЅРЅС‹Рµ (selectedOnly=true). РСЃРєР»СЋС‡Р°РµРј С‚РѕР»СЊРєРѕ announcement.
			const usable = (raw.groups || []).filter((g: any) => !g.is_announcement)

			const mapped: UiGroupRow[] = usable.map((g: any) => ({
				jid: String(g.wa_group_id),
				title: g.subject ?? null,
				participants_count: g.participants_count ?? null,
				is_restricted: g.is_restricted ?? false,
				updated_at: g.updated_at,
				send_time: g.send_time ?? null,
				avatar_url: null,
			}))

			const unique = mapped.filter(
				(row, index, self) =>
					index === self.findIndex(g => g.jid === row.jid),
			)

			setWaGroups(unique)
			animateWaCount(0, unique.length)
			warmupWaAvatars(unique)
			if (unique.length === 0) {
				message.info('РќРµС‚ РІС‹Р±СЂР°РЅРЅС‹С… WA РіСЂСѓРїРї. Р’С‹Р±РµСЂРёС‚Рµ РіСЂСѓРїРїС‹ РЅР° СЃС‚СЂР°РЅРёС†Рµ В«РЈРїСЂР°РІР»РµРЅРёРµ РіСЂСѓРїРїР°РјРёВ» (WhatsApp).')
			}
		} catch (e) {
			console.error(e)
			message.error(
				getApiErrorMessage(
					e,
					'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ WA РіСЂСѓРїРїС‹. РџСЂРѕРІРµСЂСЊС‚Рµ РїРѕРґРєР»СЋС‡РµРЅРёРµ Рё РѕР±РЅРѕРІРёС‚Рµ СЃС‚СЂР°РЅРёС†Сѓ.',
				),
			)
			setWaGroups([])
		} finally {
			setLoadingWaGroups(false)
		}
	}

	/** РћРґРёРЅ Р·Р°РїСЂРѕСЃ РёР· Р‘Р”: РІСЃРµ РІС‹Р±СЂР°РЅРЅС‹Рµ TG РґР»СЏ С€Р°Р±Р»РѕРЅР° (Р±РµР· РїРѕСЂС†РёР№ Рё РєСѓСЂСЃРѕСЂРѕРІ). */
	const loadTgGroups = async (uid: string) => {
		setLoadingTgGroups(true)
		setTgAnimatedCount(0)
		setTgTotalGroups(0)
		setTgTotalRows(0)
		setTgHasMore(false)
		try {
			const params = new URLSearchParams({
				selectedOnly: 'true',
				template: '1',
			})
			const res = await fetch(`${BACKEND_URL}/telegram/groups/${uid}?${params}`, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const json: any = await res.json().catch(() => null)
			if (!res.ok) {
				message.error(
					`РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ TG РіСЂСѓРїРїС‹ (${res.status}). РџРѕРІС‚РѕСЂРёС‚Рµ РїРѕР·Р¶Рµ РёР»Рё РѕР±РЅРѕРІРёС‚Рµ СЃС‚СЂР°РЅРёС†Сѓ.`,
				)
				setTgGroups([])
				setTgTotalGroups(0)
				setTgTotalRows(0)
				setTgHasMore(false)
				return
			}
			if (!json?.success) {
				message.error(json?.userMessage || 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ TG РіСЂСѓРїРїС‹')
				setTgGroups([])
				setTgTotalGroups(0)
				setTgTotalRows(0)
				setTgHasMore(false)
				return
			}

			const mapped: UiGroupRow[] = (json.groups || []).map((g: any) => ({
				jid: normalizeTgChatId(String(g.tg_chat_id)),
				title: g.title ?? null,
				participants_count: g.participants_count ?? null,
				is_restricted: false,
				updated_at: g.updated_at,
				send_time: g.send_time ?? null,
				avatar_url: g.avatar_url ?? null,
			}))

			const unique = mapped.filter(
				(row, index, self) =>
					index === self.findIndex(g => g.jid === row.jid),
			)

			setTgGroups(unique)
			animateTgCount(0, unique.length)
			const chatTotal = Number(json.total || 0)
			setTgTotalGroups(chatTotal)
			setTgTotalRows(Number(json.totalRows ?? json.total ?? 0) || chatTotal)
			setTgHasMore(Boolean(json.hasMore))
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ TG РіСЂСѓРїРїС‹'))
			setTgGroups([])
			setTgTotalGroups(0)
			setTgTotalRows(0)
			setTgHasMore(false)
		} finally {
			setLoadingTgGroups(false)
		}
	}

	useEffect(() => {
		loader.hide()
		fetchMe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// WA Рё TG РіСЂСѓРїРїС‹ Р·Р°РіСЂСѓР¶Р°РµРј РїСЂРё РїРѕСЏРІР»РµРЅРёРё userId. TG вЂ” РѕРґРЅРёРј Р·Р°РїСЂРѕСЃРѕРј РёР· Р‘Р” (template=1), Р±РµР· С„РѕРЅРѕРІРѕР№ РґРѕРіСЂСѓР·РєРё РїРѕСЂС†РёСЏРјРё.
	useEffect(() => {
		if (!userId) return
		loadWaGroups(userId)
		loadTgGroups(userId)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId])


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

	useEffect(() => {
		if (channel !== 'wa' || waGroups.length === 0) return
		warmupWaAvatars(waGroups)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [channel, waGroups.length])

	// РЎС‚Р°С‚СѓСЃ РїРѕРґРєР»СЋС‡РµРЅРёСЏ WA/TG РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ В«РџРѕРґРєР»СЋС‡РёС‚СЊ TG/WAВ» РІ РІС‹Р±РѕСЂРµ РєР°РЅР°Р»Р°
	useEffect(() => {
		if (!userId || !token) return
		Promise.all([
			fetch(`${BACKEND_URL}/whatsapp/account-info/${userId}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
			fetch(`${BACKEND_URL}/telegram/qr/status/${userId}?_=${Date.now()}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
		]).then(([waData, tgData]) => {
			setWaConnected(waData?.success ? (waData.connected === true) : false)
			setTgConnected(
				tgData?.success && tgData?.status === 'connected',
			)
		}).catch(() => {})
	}, [userId, token])

	const uploadProps: UploadProps = useMemo(
		() => ({
			maxCount: 1,
			beforeUpload: async file => {
				if (!userId) {
					message.error('РќРµС‚ userId')
					return Upload.LIST_IGNORE
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
					const type = (file.type || '').toLowerCase()
					setMediaKind(type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : 'image')
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
		[userId, token]
	)

	const groupColumns: ColumnsType<UiGroupRow> = useMemo(() => {
		const cols: ColumnsType<UiGroupRow> = [
			{
				title: 'Р“СЂСѓРїРїР°',
				key: 'group',
				render: (_: any, row: UiGroupRow) => {
					const nameForAvatar = (row.title || 'Р“СЂСѓРїРїР°').trim() || 'Р“СЂСѓРїРїР°'

					// РўРµРєСѓС‰РµРµ СЃРѕСЃС‚РѕСЏРЅРёРµ РІС‹Р±РѕСЂР° РґР»СЏ СЌС‚РѕР№ СЃС‚СЂРѕРєРё
					const selectedList = channel === 'wa' ? waSelected : tgSelected
					const checked = selectedList.includes(row.jid)

					// Р”Р»СЏ WA РїРѕРґРіСЂСѓР¶Р°РµРј Р°РІР°С‚Р°СЂ С‡РµСЂРµР· API Рё РєСЌС€ РїРѕ jid
					let avatarUrl = row.avatar_url || null
					if (channel === 'wa') {
						avatarUrl = normalizeWaAvatarUrl(row.jid, avatarUrl)
						const hasCachedAvatar = Object.prototype.hasOwnProperty.call(waAvatarMap, row.jid)
						if (!hasCachedAvatar && !waAvatarLoading[row.jid]) {
							void ensureWaAvatar(row.jid)
						}
						avatarUrl = hasCachedAvatar ? waAvatarMap[row.jid] ?? null : avatarUrl
					}

					const toggleSelected = () => {
						const list = channel === 'wa' ? waSelected : tgSelected
						const isSelected = list.includes(row.jid)
						const next = isSelected
							? list.filter(k => k !== row.jid)
							: [...list, row.jid]
						if (channel === 'wa') setWaSelected(next)
						else setTgSelected(next)
					}

					return (
						<div className="tedit-group-row-inner">
							<div className="tedit-group-row-main">
								<div
									className={`tedit-custom-checkbox ${checked ? 'checked' : ''}`}
									role="button"
									tabIndex={0}
									title={checked ? 'РЎРЅСЏС‚СЊ РІС‹РґРµР»РµРЅРёРµ' : 'Р’С‹Р±СЂР°С‚СЊ РіСЂСѓРїРїСѓ'}
									onClick={(e) => {
										e.stopPropagation()
										toggleSelected()
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											e.stopPropagation()
											toggleSelected()
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

								{avatarUrl ? (
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
								)}
								<div className="tedit-group-row-info">
									<span className="tedit-group-row-title">
										{row.title || 'Р±РµР· РЅР°Р·РІР°РЅРёСЏ'}
									</span>
									<span className="tedit-group-row-id">
										ID: {row.jid}
									</span>
								</div>
							</div>
							{channel === 'tg' && (
								<div className="tedit-group-row-interval" onClick={(e) => e.stopPropagation()}>
									{(() => {
										const ov = tgTargetOverrides[row.jid] ?? null
										const tplDef = tgDefaultSendTime
										const eff = ov ?? (tplDef ? String(tplDef) : null) ?? (row.send_time ?? null)
										const title = eff ? `Р­С„С„РµРєС‚РёРІРЅРѕ: ${eff}` : 'Р­С„С„РµРєС‚РёРІРЅРѕ: Р°РІС‚Рѕ'
										return (
											<Select
												allowClear
												placeholder="РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ"
												size="small"
												className="tedit-group-interval-select"
												value={tgTargetOverrides[row.jid] ?? undefined}
												options={SEND_INTERVAL_OPTIONS}
												disabled={!checked}
												title={title}
												onChange={v => setTgTargetOverride(row.jid, v ?? null)}
											/>
										)
									})()}
								</div>
							)}
							{channel === 'wa' && (
								<span
									className="tedit-group-row-count"
									title="РљРѕР»РёС‡РµСЃС‚РІРѕ СѓС‡Р°СЃС‚РЅРёРєРѕРІ РІ РіСЂСѓРїРїРµ"
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
	}, [channel, waAvatarMap, waAvatarLoading, waSelected, tgSelected, tgTargetOverrides, tgDefaultSendTime])

	const currentGroups = channel === 'wa' ? waGroups : tgGroups
	const currentSelected = channel === 'wa' ? waSelected : tgSelected
	const currentGroupsLoading = channel === 'wa' ? loadingWaGroups : loadingTgGroups
	// Р¤РёР»СЊС‚СЂ РїРѕ РЅР°Р·РІР°РЅРёСЋ РёР»Рё ID, Р·Р°С‚РµРј РІС‹Р±СЂР°РЅРЅС‹Рµ РЅР°РІРµСЂС…
	const currentGroupsSorted = useMemo(() => {
		const q = groupFilterQuery.trim().toLowerCase()
		const filtered = q
			? currentGroups.filter(
					(g) =>
						(g.title ?? '').toLowerCase().includes(q) ||
						String(g.jid ?? '').toLowerCase().includes(q),
				)
			: [...currentGroups]
		return filtered.sort((a, b) => {
			const aIn = currentSelected.includes(a.jid)
			const bIn = currentSelected.includes(b.jid)
			if (aIn && !bIn) return -1
			if (!aIn && bIn) return 1
			return 0
		})
	}, [currentGroups, currentSelected, groupFilterQuery])
	const setCurrentSelected = (keys: string[]) => {
		if (channel === 'wa') setWaSelected(keys)
		else setTgSelected(keys)
	}

	function setTgTargetOverride(jid: string, next: string | null) {
		setTgTargetOverrides(prev => ({ ...prev, [jid]: next }))
	}


	const saveTargetsForTemplate = async (templateId: string) => {
		setSavingTargets(true)
		try {
			// вњ… СЃРѕС…СЂР°РЅСЏРµРј targets РѕС‚РґРµР»СЊРЅРѕ РїРѕ РєР°РЅР°Р»Р°Рј
			const tasks: Array<{ ch: 'wa' | 'tg'; keys: string[] }> = [
				{ ch: 'wa', keys: waSelected },
				// TG: РЅР° РІСЃСЏРєРёР№ СЃР»СѓС‡Р°Р№ РЅРѕСЂРјР°Р»РёР·СѓРµРј id РїРµСЂРµРґ СЃРѕС…СЂР°РЅРµРЅРёРµРј
				{ ch: 'tg', keys: tgSelected.map(normalizeTgChatId) },
			]

			for (const t of tasks) {
				const overrides =
					t.ch === 'wa'
						? ({} as Record<string, string | null>)
						: t.keys.reduce((acc, jid) => {
								acc[jid] = tgTargetOverrides[jid] ?? null
								return acc
							}, {} as Record<string, string | null>)

				// eslint-disable-next-line no-await-in-loop
				const json: any = await apiPost(
					'/templates/targets/set',
					{
						userId,
						templateId,
						groupJids: t.keys,
						channel: t.ch,
						overrides,
					},
					{ timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS },
				)

				if (!json?.success) {
					message.error(
						`РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ РіСЂСѓРїРї (${t.ch.toUpperCase()}): ${
							json?.message || 'unknown'
						}`
					)
					return false
				}
			}

			return true
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ РіСЂСѓРїРїС‹ РґР»СЏ С€Р°Р±Р»РѕРЅР°'))
			return false
		} finally {
			setSavingTargets(false)
		}
	}

	const onFinish = async (values: any) => {
		if (!userId) return message.error('РќРµС‚ userId')

		setSaving(true)
		loader.show('РЎРѕС…СЂР°РЅСЏРµРј С€Р°Р±Р»РѕРЅвЂ¦')
		try {
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

			const json: any = await apiPost('/templates/create', payload, {
				timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS,
			})
			if (!json?.success) {
				message.error(`РћС€РёР±РєР° СЃРѕР·РґР°РЅРёСЏ: ${json?.message || 'unknown'}`)
				return
			}
			if (json?.persistenceDegraded) {
				message.warning(
					'Р’ Supabase РЅРµС‚ РєРѕР»РѕРЅРѕРє РїР°СѓР· РґР»СЏ С€Р°Р±Р»РѕРЅРѕРІ вЂ” РїРѕР»Р·СѓРЅРєРё РЅРµ СЃРѕС…СЂР°РЅРёР»РёСЃСЊ. Р’С‹РїРѕР»РЅРёС‚Рµ SQL: backend/migrations/add_message_templates_between_groups_sec_range.sql',
				)
			}

			const templateId = String(json.templateId || '')
			if (!templateId) {
				message.error('templateId РЅРµ РїСЂРёС€С‘Р»')
				return
			}

			// вњ… СЃСЂР°Р·Сѓ СЃРѕС…СЂР°РЅСЏРµРј РІС‹Р±СЂР°РЅРЅС‹Рµ РіСЂСѓРїРїС‹ (Рё WA Рё TG)
			const ok = await saveTargetsForTemplate(templateId)
			if (!ok) return

			const parts: string[] = []
			parts.push('РїР°СѓР·С‹ РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРё Р·Р°РґР°РЅС‹ РґРёР°РїР°Р·РѕРЅРѕРј РІ С€Р°Р±Р»РѕРЅРµ')
			if (values.tg_default_send_time != null) {
				parts.push('РІ drawer РѕР±РЅРѕРІРёС‚СЃСЏ РїСЂРµРґСѓРїСЂРµР¶РґРµРЅРёРµ РїСЂРѕ РёРЅС‚РµСЂРІР°Р» TG (РґРµС„РѕР»С‚ РёР· С€Р°Р±Р»РѕРЅР°)')
			}
			message.success(
				parts.length
					? `РЁР°Р±Р»РѕРЅ СЃРѕР·РґР°РЅ Рё РіСЂСѓРїРїС‹ СЃРѕС…СЂР°РЅРµРЅС‹ (WA/TG) вЂ” ${parts.join(' Рё ')}.`
					: 'РЁР°Р±Р»РѕРЅ СЃРѕР·РґР°РЅ Рё РіСЂСѓРїРїС‹ СЃРѕС…СЂР°РЅРµРЅС‹ (WA/TG)',
			)
			if (typeof window !== 'undefined') window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
			router.push(`/dashboard/templates/`)
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕР·РґР°С‚СЊ С€Р°Р±Р»РѕРЅ'))
		} finally {
			setSaving(false)
			loader.hide()
		}
	}

	return (
		<div className='tedit'>
			<div className='tedit__wrap'>
				<p className='tedit__intro'>
					Р—Р°РїРѕР»РЅРёС‚Рµ РЅР°Р·РІР°РЅРёРµ Рё С‚РµРєСЃС‚, РІС‹Р±РµСЂРёС‚Рµ РіСЂСѓРїРїС‹ (РІРєР»Р°РґРєРё WA/TG). Р“СЂСѓРїРїС‹ СЃРѕС…СЂР°РЅСЏС‚СЃСЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РїСЂРё СЃРѕР·РґР°РЅРёРё С€Р°Р±Р»РѕРЅР°.
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
					onFinish={onFinish}
				>
					{/* РќР°Р·РІР°РЅРёРµ */}
					<div className="tedit-cont">
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
							{/* РўРµРєСЃС‚ */}
							<div className='tedit-field'>
								<div className='tedit-field__label'>РўРµРєСЃС‚ СЃРѕРѕР±С‰РµРЅРёСЏ</div>
								<Form.Item
									name='text'
									style={{ marginBottom: 0 }}
									rules={[
										{
											validator: async (_, value) => {
												const title = form.getFieldValue('title')
												const text = String(value || '').trim()
												if (!String(title || '').trim() && !text) {
													return Promise.reject(
														new Error('РќСѓР¶РЅРѕ Р·Р°РїРѕР»РЅРёС‚СЊ title РёР»Рё text'),
													)
												}
												return Promise.resolve()
											},
										},
									]}
								>
									<TemplateRichEditor
										value={textValue}
										maxChars={MAX_MESSAGE_CHARS}
										onChange={next => {
											setTextValue(next)
											form.setFieldsValue({ text: next })
										}}
									/>
								</Form.Item>
								<div className='tedit-field__hint'>
									РњР°РєСЃ. {MAX_MESSAGE_CHARS} СЃРёРјРІРѕР»РѕРІ (Р»РёРјРёС‚ Telegram Рё WhatsApp). РџРѕРґРґРµСЂР¶РёРІР°РµС‚СЃСЏ С„РѕСЂРјР°С‚РёСЂРѕРІР°РЅРёРµ Рё СЌРјРѕРґР·Рё.
								</div>
							</div>
							{/* Р—Р°РіСЂСѓР·РєР° */}
							<div className='tedit-upload'>
								<div className='tedit-upload__label'>РџСЂРёРєСЂРµРїРёС‚Рµ РёР·РѕР±СЂР°Р¶РµРЅРёРµ</div>

								<div className='tedit-upload__row'>
									<div className='tedit-upload__drop'>
										<Upload.Dragger
											{...uploadProps}
											showUploadList={false}
											disabled={!userId || uploading}
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
											<br />
											РЎРѕРІРµС‚СѓРµРј СЃРґРµР»Р°С‚СЊ РєРѕР»Р»Р°Р¶ РёР· С„РѕС‚Рѕ
										</div>

										{mediaUrl ? (
											<div className='tedit-upload__current'>
												<button
													type='button'
													className='tedit-upload__previewBtn'
													onClick={() => setMediaViewerUrl(mediaUrl)}
													title='РћС‚РєСЂС‹С‚СЊ РІ РїРѕР»РЅРѕРј СЂР°Р·РјРµСЂРµ / Р·Р°РїСѓСЃС‚РёС‚СЊ'
												>
													<div className='tedit-upload__preview'>
														{mediaKind === 'audio' || (!mediaKind && isAudioUrl(mediaUrl)) ? (
															<audio
																src={mediaUrl}
																className='tedit-upload__previewAudio'
																controls
																onClick={e => e.stopPropagation()}
															/>
														) : mediaKind === 'video' || (!mediaKind && isVideoUrl(mediaUrl)) ? (
															<video
																src={mediaUrl}
																className='tedit-upload__previewMedia'
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
												<button
													type='button'
													className='tedit-linkbtn'
													onClick={() => { setMediaUrl(null); setMediaKind(null) }}
												>
													РЈР±СЂР°С‚СЊ
												</button>
											</div>
										) : null}
									</div>
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
						{/* Р“СЂСѓРїРїС‹ */}
						<div className='tedit-targets'>
							<div className='tedit-targets__head'>
								<div className='tedit-targets__title'>
									РљСѓРґР° РѕС‚РїСЂР°РІР»СЏС‚СЊ СЌС‚РѕС‚ С€Р°Р±Р»РѕРЅ
								</div>

								<Segmented
									value={channel}
									onChange={v => setChannel(v as any)}
									size='large'
									options={[
										{
											label: (
												<span className='tedit-channelTab'>
													<span className='tedit-channelTab__icon tedit-channelTab__icon--tg'>
														<ChannelIcon type='tg' size={16} variant={tgConnected === false ? 'failed' : 'default'} />
													</span>
													<span className='tedit-channelTab__text'>
														{tgConnected === false
															? 'РџРѕРґРєР»СЋС‡РёС‚СЊ TG'
															: `Telegram${loadingTgGroups ? ' В· Р·Р°РіСЂСѓР·РєР°' : ''}`}
													</span>
													{tgConnected !== false && (
														<span className='tedit-channelTab__meta'>
															{loadingTgGroups ? (
																<span className='tedit-channelTab__load' aria-hidden='true' />
															) : null}
															<span>
																{loadingTgGroups
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
													<span className='tedit-channelTab__icon tedit-channelTab__icon--wa'>
														<ChannelIcon type='wa' size={16} variant={waConnected === false ? 'failed' : 'default'} />
													</span>
													<span className='tedit-channelTab__text'>
														{waConnected === false
															? 'РџРѕРґРєР»СЋС‡РёС‚СЊ WA'
															: `WhatsApp${loadingWaGroups ? ' В· Р·Р°РіСЂСѓР·РєР°' : ''}`}
													</span>
													{waConnected !== false && (
														<span className='tedit-channelTab__meta'>
															{loadingWaGroups ? (
																<span className='tedit-channelTab__load' aria-hidden='true' />
															) : null}
															<span>{loadingWaGroups ? 'вЂ¦' : `${waGroups.length}`}</span>
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
										TG РїРѕРґРіСЂСѓР¶Р°РµС‚СЃСЏ РёР· Р±Р°Р·С‹ РѕРґРЅРёРј Р·Р°РїСЂРѕСЃРѕРј РїСЂРё РѕС‚РєСЂС‹С‚РёРё СЃС‚СЂР°РЅРёС†С‹.
									</p>
								</div>
							</div>

							{channel === 'wa' && waConnected !== false && (
								<div
									className='tedit-targets__meta'
									style={{ '--channel-color': '#25D366' } as React.CSSProperties}
								>
									{loadingWaGroups ? (
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
									{loadingTgGroups ? (
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
												!loadingTgGroups && (
													<div className='tedit-targets__meta-hint'>
														РЎ СЂР°СЃСЃС‹Р»РєРѕР№ СЃРµР№С‡Р°СЃ С‚РѕР»СЊРєРѕ <b>{tgDbStats.selected}</b> РёР·{' '}
														<b>{tgDbStats.total}</b> РіСЂСѓРїРї. РћСЃС‚Р°Р»СЊРЅС‹Рµ Р·РґРµСЃСЊ РЅРµ РїРѕСЏРІСЏС‚СЃСЏ, РїРѕРєР° РЅРµ
														РІРєР»СЋС‡РёС‚Рµ РёС… РІ В«Р“СЂСѓРїРїС‹ TGВ».
													</div>
												)}
											{tgDbStats &&
												tgDbStats.selected > 0 &&
												!tgHasMore &&
												!loadingTgGroups &&
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
										Telegram РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ. РџРѕРґРєР»СЋС‡РёС‚Рµ РІ РєР°Р±РёРЅРµС‚Рµ, С‡С‚РѕР±С‹ РІС‹Р±РёСЂР°С‚СЊ РіСЂСѓРїРїС‹.{' '}
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
										WhatsApp РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ. РџРѕРґРєР»СЋС‡РёС‚Рµ РІ РєР°Р±РёРЅРµС‚Рµ, С‡С‚РѕР±С‹ РІС‹Р±РёСЂР°С‚СЊ РіСЂСѓРїРїС‹.{' '}
										<button
											type='button'
											className='tedit-link'
											onClick={() => { loader.show('Р’ РєР°Р±РёРЅРµС‚вЂ¦'); router.push('/cabinet#whatsapp') }}
										>
											РџРѕРґРєР»СЋС‡РёС‚СЊ WA
										</button>
									</div>
								)}
								{channel === 'wa' && waConnected !== false && !loadingWaGroups && waGroups.length === 0 && (
									<div className='tedit-warning-message tedit-warning-message--empty'>
										РќРµС‚ РІС‹Р±СЂР°РЅРЅС‹С… WhatsApp РіСЂСѓРїРї. Р’С‹Р±РµСЂРёС‚Рµ РіСЂСѓРїРїС‹ РЅР° СЃС‚СЂР°РЅРёС†Рµ{' '}
										<Link href='/dashboard/groups' className='tedit-link'>РЈРїСЂР°РІР»РµРЅРёРµ РіСЂСѓРїРїР°РјРё</Link> (РІРєР»Р°РґРєР° WhatsApp), Р·Р°С‚РµРј РІРѕР·РІСЂР°С‰Р°Р№С‚РµСЃСЊ СЃСЋРґР°.
									</div>
								)}
							</div>

							<div className='tedit-targets__buttons'>
								<button
									type='button'
									className='tedit-pill'
									onClick={() =>
										setCurrentSelected(currentGroups.map(g => g.jid))
									}
									disabled={
										!currentGroups.length ||
										(channel === 'tg' && loadingTgGroups)
									}
								>
									Р’С‹Р±СЂР°С‚СЊ РІСЃРµ
								</button>

								<button
									type='button'
									className='tedit-pill'
									onClick={() => setCurrentSelected([])}
									disabled={!currentSelected.length}
								>
									РЎРЅСЏС‚СЊ РІСЃРµ
								</button>

								{channel === 'tg' && currentSelected.length > 0 && (
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
												if (!bulkInterval || !currentSelected.length) return
												setApplyingBulkInterval(true)
												setTgTargetOverrides(prev => {
													const next = { ...prev }
													for (const jid of currentSelected) next[jid] = bulkInterval
													return next
												})
												setApplyingBulkInterval(false)
												message.success(`РРЅС‚РµСЂРІР°Р» РїСЂРёРјРµРЅС‘РЅ Рє ${currentSelected.length} РіСЂСѓРїРїР°Рј (СЃРѕС…СЂР°РЅРёС‚СЃСЏ РїСЂРё СЃРѕР·РґР°РЅРёРё С€Р°Р±Р»РѕРЅР°)`)
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
											dataSource={currentGroupsSorted}
											pagination={false}
											size='small'
											loading={currentGroupsLoading}
											onRow={record => ({
												onClick: (e: any) => {
													// РќРµ РїРµСЂРµРєР»СЋС‡Р°РµРј РІС‹Р±РѕСЂ, РµСЃР»Рё РєР»РёРє Р±С‹Р» РЅР° Select РёР»Рё РєР°СЃС‚РѕРјРЅРѕРј С‡РµРєР±РѕРєСЃРµ
													if (e?.target?.closest?.('.ant-select') || e?.target?.closest?.('.tedit-custom-checkbox')) return
													const jid = record.jid
													const isSelected = currentSelected.includes(jid)
													const next = isSelected
														? currentSelected.filter(k => k !== jid)
														: [...currentSelected, jid]
													setCurrentSelected(next)
												},
												className: currentSelected.includes(record.jid)
													? 'tedit-table-row rowSelected'
													: 'tedit-table-row',
											})}
										/>
									</div>
								</div>
							</div>

							<div className='tedit-targets__hint'>
								Р’С‹Р±РѕСЂ СЃРѕС…СЂР°РЅРёС‚СЃСЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РїСЂРё СЃРѕР·РґР°РЅРёРё С€Р°Р±Р»РѕРЅР°.
							</div>
						</div>
					</div>
					
					{/* РљРЅРѕРїРєРё */}
					<div className='tedit-actions'>
						<button
							className='tedit-btn tedit-btn--primary'
							type='submit'
							disabled={saving || uploading || savingTargets}
						>
							{saving ? 'РЎРѕС…СЂР°РЅСЏРµРјвЂ¦' : 'РЎРѕС…СЂР°РЅРёС‚СЊ С€Р°Р±Р»РѕРЅ'}
						</button>

						<button
							className='tedit-btn'
							type='button'
							onClick={() => {
								loader.show('Рљ СЃРїРёСЃРєСѓ С€Р°Р±Р»РѕРЅРѕРІвЂ¦')
								router.push('/dashboard/templates')
							}}
							disabled={saving}
						>
							РќР°Р·Р°Рґ
						</button>
					</div>
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
