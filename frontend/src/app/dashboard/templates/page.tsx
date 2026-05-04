'use client'
//frontend/src/app/dashboard/templates/page.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import Cookies from 'js-cookie'
import { message, Popconfirm, Popover, Segmented, Switch, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost, getApiErrorMessage } from '@/lib/api'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { ChannelIcon } from '@/components/ChannelIcon'
import { MediaViewerModal } from '@/components/MediaViewerModal'
import { TemplatesSheetCard } from '@/components/TemplatesSheetCard'
import './page.css'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'
import { SERVER_BETWEEN_GROUPS_SEC } from '@/lib/campaignBetweenGroupsServerBase'
import { readTemplatePausePairFromApi } from '@/lib/templateBetweenGroupsRange'

type TemplateRow = {
	id: string
	sheet_row: number
	enabled: boolean
	order: number
	title: string | null
	text: string | null
	media_url: string | null
	send_media_as_file?: boolean | null
	wa_speed_factor?: number | null
	tg_speed_factor?: number | null
	wa_between_groups_sec_min?: number | null
	wa_between_groups_sec_max?: number | null
	tg_between_groups_sec_min?: number | null
	tg_between_groups_sec_max?: number | null
	wa_default_send_time?: string | null
	tg_default_send_time?: string | null
	updated_at: string
	created_at?: string | null
	stats?: {
		total: number
		sent: number
		failed: number
		firstSentAt: string | null
		lastSentAt: string | null
	} | null
	targets_count?: {
		wa: number
		tg: number
	} | null
	problematic_groups?: {
		total: number
		by_reason: {
			CHANNEL_INVALID: number
			CHAT_WRITE_FORBIDDEN: number
			USER_BANNED_IN_CHANNEL: number
			CHANNEL_PRIVATE: number
		}
		top_groups?: Array<{
			group_jid: string
			failed: number
			sent: number
			topReason: string
		}>
	} | null
}

type TemplatesTotals = {
	templatesTotal: number
	templatesWithGroupsSelected: number
	totalTargetsAssigned: number
	uniqueGroupsAll: number
	uniqueGroupsWa: number
	uniqueGroupsTg: number
	uniqueUndeliverableSelectedGroups: number
	uniqueUndeliverableSelectedGroupsWa: number
	problematicWaSummary?: {
		total: number
		topReasons: Array<{ reason: string; count: number }>
		topGroups: Array<{ group_jid: string; reason: string; count: number }>
	} | null
}

type CardSortKey = 'created_at' | 'updated_at'
type SortDir = 'asc' | 'desc'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
const LS_KEY_TEMPLATES_VIEW = 'templates_view_mode'

function isHHMM(v: unknown) {
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? '').trim())
}

function clampInt(n: unknown, lo: number, hi: number, def: number) {
	const x = Number(n)
	if (!Number.isFinite(x)) return def
	return Math.max(lo, Math.min(hi, Math.floor(x)))
}

function approxBetweenGroupsSeconds(baseMinSec: number, baseMaxSec: number, speedFactor: unknown) {
	// speedFactor: 100 = базово; 200 = в 2 раза быстрее (пауза /2); 50 = в 2 раза медленнее (пауза *2)
	const sf = clampInt(speedFactor, 10, 400, 100)
	const k = 100 / sf
	const minSec = Math.max(1, Math.round((Number(baseMinSec) || 0) * k))
	const maxSec = Math.max(1, Math.round((Number(baseMaxSec) || 0) * k))
	return { minSec: Math.min(minSec, maxSec), maxSec: Math.max(minSec, maxSec), sf }
}

function labelSpeed(baseMinSec: number, baseMaxSec: number, speedFactor: unknown, channelLabel: string) {
	const { minSec, maxSec, sf } = approxBetweenGroupsSeconds(baseMinSec, baseMaxSec, speedFactor)
	if (sf === 100) return `${channelLabel}: базово (${minSec}–${maxSec}с)`
	return `${channelLabel}: ${minSec}–${maxSec}с (×${(sf / 100).toFixed(2)})`
}

/** Короткая подпись паузы для компактной мобильной таблицы */
function labelSpeedCompact(baseMinSec: number, baseMaxSec: number, speedFactor: unknown) {
	const { minSec, maxSec, sf } = approxBetweenGroupsSeconds(baseMinSec, baseMaxSec, speedFactor)
	if (sf === 100) return `${minSec}–${maxSec}с`
	return `${minSec}–${maxSec}с ×${(sf / 100).toFixed(1)}`
}

function templateHasExplicitPauseSec(channel: 'wa' | 'tg', row: TemplateRow) {
	const minK = channel === 'wa' ? 'wa_between_groups_sec_min' : 'tg_between_groups_sec_min'
	const maxK = channel === 'wa' ? 'wa_between_groups_sec_max' : 'tg_between_groups_sec_max'
	return typeof row[minK] === 'number' && typeof row[maxK] === 'number'
}

/** Пауза между группами в таблице: явные сек из шаблона или старый режим (% от базы). */
function labelTemplateBetweenGroups(channel: 'wa' | 'tg', row: TemplateRow, mode: 'full' | 'compact') {
	const [lo, hi] = readTemplatePausePairFromApi(
		channel,
		row as Record<string, unknown>,
		channel === 'wa' ? row.wa_speed_factor : row.tg_speed_factor,
	)
	const explicit = templateHasExplicitPauseSec(channel, row)
	if (mode === 'compact') {
		if (explicit) return `${lo}–${hi}с`
		const [bLo, bHi] = channel === 'wa' ? SERVER_BETWEEN_GROUPS_SEC.wa : SERVER_BETWEEN_GROUPS_SEC.tg
		return labelSpeedCompact(bLo, bHi, channel === 'wa' ? row.wa_speed_factor : row.tg_speed_factor)
	}
	const prefix = channel === 'wa' ? 'WA пауза' : 'TG пауза'
	if (explicit) return `${prefix}: ${lo}–${hi} с (в шаблоне)`
	const [bLo, bHi] = channel === 'wa' ? SERVER_BETWEEN_GROUPS_SEC.wa : SERVER_BETWEEN_GROUPS_SEC.tg
	return labelSpeed(bLo, bHi, channel === 'wa' ? row.wa_speed_factor : row.tg_speed_factor, prefix)
}

function labelTgDefault(v: unknown): string {
	const s = String(v ?? '').trim()
	if (!s) return 'Авто'
	if (isHHMM(s)) {
		const [hh, mm] = s.split(':').map(x => Number(x))
		const minutes = (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0)
		if (!minutes) return 'Авто'
		return `Интервал ${minutes} мин`
	}
	return s
}

function TgReasonLegendHint() {
	return (
		<Popover
			trigger="hover"
			placement="top"
			content={
				<div style={{ maxWidth: 360, fontSize: 12, lineHeight: 1.45 }}>
					<div><b>Расшифровка причин TG</b></div>
					<div><b>INV</b> — канал/группа недоступны по текущим данным Telegram (часто помогает синхронизация).</div>
					<div><b>WRT</b> — нет прав отправки в группу (ограничения/роль).</div>
					<div><b>BAN</b> — аккаунт ограничен/заблокирован в этой группе.</div>
					<div><b>PRIV</b> — приватный канал/группа, у аккаунта нет доступа.</div>
				</div>
			}
		>
			<button type="button" className="tpl-btn" style={{ padding: '0 8px', minHeight: 22 }}>i</button>
		</Popover>
	)
}

function waReasonHuman(reason: string): string {
	const r = String(reason || '').toLowerCase()
	if (r === 'wa_not_connected') return 'Нет активного подключения WhatsApp'
	if (r === 'media_upload_failed') return 'Не удалось загрузить медиа в WhatsApp'
	if (r.includes('timeout')) return 'Истекло время ожидания ответа WhatsApp'
	if (r.includes('rate') || r.includes('overlimit')) return 'Ограничение скорости отправки со стороны WhatsApp'
	return reason || 'Неизвестная причина'
}

function renderWaProblemPopover(totals: TemplatesTotals, router: ReturnType<typeof useRouter>) {
	const s = totals.problematicWaSummary
	const topReasons = s?.topReasons || []
	const topGroups = s?.topGroups || []
	return (
		<div style={{ minWidth: 320, maxWidth: 460, fontSize: 12, lineHeight: 1.45 }}>
			<div><b>Проблемных WA групп (уник.): {Number(s?.total ?? 0)}</b></div>
			<div style={{ marginTop: 6 }}>
				<b>Топ причин</b>
				{topReasons.length ? (
					<div style={{ marginTop: 4 }}>
						{topReasons.map((r) => (
							<div key={r.reason}>{waReasonHuman(r.reason)} · {r.count}</div>
						))}
					</div>
				) : <div style={{ opacity: 0.75 }}>—</div>}
			</div>
			<div style={{ marginTop: 6 }}>
				<b>Top группы (до 5)</b>
				{topGroups.length ? (
					<div style={{ marginTop: 4 }}>
						{topGroups.map((g) => (
							<div key={`${g.group_jid}:${g.reason}`}>
								<code>{g.group_jid}</code> · {waReasonHuman(g.reason)}
							</div>
						))}
					</div>
				) : <div style={{ opacity: 0.75 }}>—</div>}
			</div>
			<div style={{ marginTop: 8 }}>
				<button type="button" className="tpl-btn" onClick={() => router.push('/dashboard/groups')}>
					Открыть группы WA
				</button>
			</div>
		</div>
	)
}

function renderTemplateProblemPopover(row: TemplateRow, router: ReturnType<typeof useRouter>) {
	const p = row.problematic_groups
	const top = p?.top_groups || []
	return (
		<div style={{ minWidth: 320, maxWidth: 440, fontSize: 12, lineHeight: 1.45 }}>
			<div><b>Проблемных TG групп: {Number(p?.total ?? 0)}</b></div>
			<div>
				Топ причин: INV {Number(p?.by_reason?.CHANNEL_INVALID ?? 0)}, WRT {Number(p?.by_reason?.CHAT_WRITE_FORBIDDEN ?? 0)}, BAN {Number(p?.by_reason?.USER_BANNED_IN_CHANNEL ?? 0)}, PRIV {Number(p?.by_reason?.CHANNEL_PRIVATE ?? 0)}
			</div>
			<div style={{ marginTop: 6 }}>
				<b>Top группы (до 5)</b>
				{top.length ? (
					<div style={{ marginTop: 4 }}>
						{top.map((g) => (
							<div key={g.group_jid}>
								<code>{g.group_jid}</code> · failed {g.failed} · sent {g.sent} · {g.topReason}
							</div>
						))}
					</div>
				) : (
					<div style={{ opacity: 0.75 }}>—</div>
				)}
			</div>
			<div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
				<button type="button" className="tpl-btn" onClick={() => router.push(`/dashboard/templates/${row.id}`)}>
					Открыть шаблон
				</button>
				<button type="button" className="tpl-btn" onClick={() => router.push('/dashboard/groups/telegram')}>
					Открыть группы TG
				</button>
			</div>
		</div>
	)
}

function dispatchTimingHubChanged() {
	if (typeof window === 'undefined') return
	window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
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

/** Конвертация разметки шаблона в HTML для отображения в превью (жирный, курсив, списки). */
function markdownToHtml(md: string): string {
	if (!md?.trim()) return ''
	let html = md
		.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/\*(.+?)\*/g, '<strong>$1</strong>')
		.replace(/_(.+?)_/g, '<em>$1</em>')
		.replace(/~~(.+?)~~/g, '<s>$1</s>')
		.replace(/~(.+?)~/g, '<u>$1</u>')
		.replace(/`(.+?)`/g, '<code>$1</code>')
	const lines = html.split('\n')
	const out: string[] = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		if (line.match(/^\d+\. (.+)$/)) {
			const items: string[] = []
			while (i < lines.length && lines[i].match(/^\d+\. (.+)$/)) {
				items.push('<li>' + lines[i].replace(/^\d+\. (.+)$/, '$1') + '</li>')
				i++
			}
			out.push('<ol>' + items.join('') + '</ol>')
			continue
		}
		if (line.match(/^- (.+)$/)) {
			const items: string[] = []
			while (i < lines.length && lines[i].match(/^- (.+)$/)) {
				items.push('<li>' + lines[i].replace(/^- (.+)$/, '$1') + '</li>')
				i++
			}
			out.push('<ul>' + items.join('') + '</ul>')
			continue
		}
		out.push(line)
		i++
	}
	return out.join('<br>')
}

export default function TemplatesPage() {
	const router = useRouter()
	const [userId, setUserId] = useState('')
	const [gsheetUrl, setGsheetUrl] = useState<string | null>(null)
	// loading = true по умолчанию, чтобы при первом рендере не писать «Пока нет шаблонов»
	const [loading, setLoading] = useState(true)
	const [contentReady, setContentReady] = useState(false)
	const [rows, setRows] = useState<TemplateRow[]>([])
	const [totals, setTotals] = useState<TemplatesTotals>({
		templatesTotal: 0,
		templatesWithGroupsSelected: 0,
		totalTargetsAssigned: 0,
		uniqueGroupsAll: 0,
		uniqueGroupsWa: 0,
		uniqueGroupsTg: 0,
		uniqueUndeliverableSelectedGroups: 0,
		uniqueUndeliverableSelectedGroupsWa: 0,
		problematicWaSummary: null,
	})
	const [toggleBusyId, setToggleBusyId] = useState<string | null>(null)
	const [search, setSearch] = useState('')
	const [mediaViewerUrl, setMediaViewerUrl] = useState<string | null>(null)
	const [statusFilter, setStatusFilter] = useState<'all' | 'on' | 'off'>('all')
	const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards')
	const [cardSortKey, setCardSortKey] = useState<CardSortKey>('created_at')
	const [cardSortDir, setCardSortDir] = useState<SortDir>('desc')
	const [isMobileTable, setIsMobileTable] = useState(false)

	const [waSelectedCount, setWaSelectedCount] = useState(0)
	const [tgSelectedCount, setTgSelectedCount] = useState(0)
	const [waConnected, setWaConnected] = useState<boolean | null>(null)
	const [tgConnected, setTgConnected] = useState<boolean | null>(null)
	const [backupDownloading, setBackupDownloading] = useState(false)
	const [backupImporting, setBackupImporting] = useState(false)
	const [backupSyncing, setBackupSyncing] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [tgAwaitingPassword, setTgAwaitingPassword] = useState(false)
	const [loadingGroups, setLoadingGroups] = useState(false)
	const [contextMenu, setContextMenu] = useState<{ row: TemplateRow; x: number; y: number } | null>(null)
	const contextMenuRef = useRef<HTMLDivElement>(null)
	const deleteTargetRef = useRef<string | null>(null)
	const loader = useGlobalLoader()
	const token = typeof document !== 'undefined' ? (Cookies.get('token') || '') : ''

	// Закрытие контекстного меню по клику снаружи или Escape
	useEffect(() => {
		if (!contextMenu) return
		const close = () => setContextMenu(null)
		const onDocClick = (e: MouseEvent) => {
			if (contextMenuRef.current?.contains(e.target as Node)) return
			close()
		}
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
		document.addEventListener('click', onDocClick, true)
		document.addEventListener('contextmenu', close, true)
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('click', onDocClick, true)
			document.removeEventListener('contextmenu', close, true)
			document.removeEventListener('keydown', onKey)
		}
	}, [contextMenu])

	useEffect(() => {
		try {
			const v = String(localStorage.getItem(LS_KEY_TEMPLATES_VIEW) || '').trim()
			if (v === 'table' || v === 'cards') setViewMode(v)
		} catch {
			// ignore
		}
	}, [])

	useEffect(() => {
		if (typeof window === 'undefined') return
		const media = window.matchMedia('(max-width: 768px)')
		const apply = () => setIsMobileTable(media.matches)
		apply()
		media.addEventListener('change', apply)
		return () => media.removeEventListener('change', apply)
	}, [])

	const fetchMe = async () => {
		if (!token) {
			router.push('/auth/phone')
			return;		}
		try {
			const res = await fetch(`${BACKEND_URL}/auth/me`, {
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
			})
			let json: any
			try {
				json = await res.json()
			} catch {
				message.error('Неверный ответ сервера')
				return
			}
			if (!json?.success) {
				Cookies.remove('token')
				router.push('/auth/phone')
				return
			}
			setUserId(String(json.user.id))
			setGsheetUrl((json.user.gsheet_url ?? null) as string | null)
		} catch (e) {
			console.error(e)
			message.error('Не удалось получить пользователя')
		}
	}

	const load = async (uid?: string) => {
		const id = uid ?? userId
		if (!id) return
		setLoading(true)
		try {
			const json: any = await apiGet(`/templates/list/${id}`)
			if (!json?.success) {
				const details = json?.details ?? json?.error?.message ?? json?.error?.code ?? ''
				const msg = details
					? `Ошибка загрузки шаблонов: ${json?.message || 'supabase_select_error'} (${details})`
					: `Ошибка загрузки шаблонов: ${json?.message || 'unknown'}`
				message.error(msg)
				return
			}
			setRows(json.templates || [])
			setTotals({
				templatesTotal: Number(json?.totals?.templatesTotal ?? (json.templates || []).length ?? 0),
				templatesWithGroupsSelected: Number(json?.totals?.templatesWithGroupsSelected ?? 0),
				totalTargetsAssigned: Number(json?.totals?.totalTargetsAssigned ?? 0),
				uniqueGroupsAll: Number(json?.totals?.uniqueGroupsAll ?? 0),
				uniqueGroupsWa: Number(json?.totals?.uniqueGroupsWa ?? 0),
				uniqueGroupsTg: Number(json?.totals?.uniqueGroupsTg ?? 0),
				uniqueUndeliverableSelectedGroups: Number(json?.totals?.uniqueUndeliverableSelectedGroups ?? 0),
				uniqueUndeliverableSelectedGroupsWa: Number(json?.totals?.uniqueUndeliverableSelectedGroupsWa ?? 0),
				problematicWaSummary: json?.totals?.problematicWaSummary ?? null,
			})
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось загрузить шаблоны'))
		} finally {
			setLoading(false)
		}
	}

	const fetchGroupsCount = async (uid: string) => {
		if (!uid) return
		setLoadingGroups(true)
		setTgAwaitingPassword(false)
		try {
			const [waRes, tgRes, waInfoRes, tgInfoRes, tgQrRes] = await Promise.all([
				fetch(`${BACKEND_URL}/whatsapp/groups/${uid}/count`, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} }),
				fetch(`${BACKEND_URL}/telegram/groups/${uid}/count`, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} }),
				fetch(`${BACKEND_URL}/whatsapp/account-info/${uid}`, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} }),
				fetch(`${BACKEND_URL}/telegram/account-info/${uid}`, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} }),
				fetch(`${BACKEND_URL}/telegram/qr/status/${uid}`, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} }),
			])
			const waData: any = await waRes.json().catch(() => null)
			const tgData: any = await tgRes.json().catch(() => null)
			const waInfoData: any = await waInfoRes.json().catch(() => null)
			const tgInfoData: any = await tgInfoRes.json().catch(() => null)
			const tgQrData: any = await tgQrRes.json().catch(() => null)
			if (waData?.success) setWaSelectedCount(waData.selected || 0)
			if (tgData?.success) setTgSelectedCount(tgData.selected || 0)
			setWaConnected(waInfoData?.success ? (waInfoData.connected === true) : false)
			setTgConnected(tgQrData?.success && tgQrData?.status === 'connected')
			setTgAwaitingPassword(tgQrData?.success && tgQrData?.status === 'awaiting_password')
		} catch (e) {
			console.error('Error fetching groups count:', e)
		} finally {
			setLoadingGroups(false)
		}
	}

	useEffect(() => {
		loader.hide()
		fetchMe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Плавное появление контента страницы (как в ЛК): двойной rAF, чтобы первый кадр успел отрисоваться.
	useEffect(() => {
		if (!loading && userId) {
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
	}, [loading, userId])

	useEffect(() => {
		if (userId) {
			load(userId)
			fetchGroupsCount(userId)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId])

	const sorted = useMemo(() => {
		const getTs = (row: TemplateRow, key: CardSortKey): number => {
			const raw = key === 'created_at' ? row.created_at : row.updated_at
			const t = new Date(raw || 0).getTime()
			return Number.isFinite(t) ? t : 0
		}

		return [...rows].sort((a, b) => {
			// В карточках управляем сортировкой селектором.
			if (viewMode === 'cards') {
				const aVal = getTs(a, cardSortKey)
				const bVal = getTs(b, cardSortKey)
				if (aVal !== bVal) {
					return cardSortDir === 'asc' ? aVal - bVal : bVal - aVal
				}
				return (a.order ?? 0) - (b.order ?? 0)
			}

			// В таблице оставляем прежнее поведение: сортировка по created_at desc.
			const aCreated = getTs(a, 'created_at')
			const bCreated = getTs(b, 'created_at')
			if (aCreated !== bCreated) return bCreated - aCreated
			return (a.order ?? 0) - (b.order ?? 0)
		})
	}, [rows, viewMode, cardSortKey, cardSortDir])

	const filtered = useMemo(() => {
		const term = search.trim().toLowerCase()
		return sorted.filter(row => {
			if (statusFilter === 'on' && !row.enabled) return false
			if (statusFilter === 'off' && row.enabled) return false

			if (!term) return true

			const title = (row.title || '').toLowerCase()
			const text = (row.text || '').toLowerCase()
			return title.includes(term) || text.includes(term)
		})
	}, [sorted, search, statusFilter])

	const toggleTemplateEnabled = async (row: TemplateRow, nextEnabled: boolean) => {
		if (toggleBusyId) return
		setToggleBusyId(row.id)
		const prevEnabled = row.enabled
		setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: nextEnabled } : r)))
		try {
			const res: any = await apiPost(
				'/templates/update',
				{
					templateId: row.id,
					enabled: nextEnabled,
				},
				{ timeoutMs: 60_000 },
			)
			if (!res?.success) {
				setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: prevEnabled } : r)))
				message.error(`Не удалось изменить статус: ${res?.message || 'unknown'}`)
				return
			}
			message.success(nextEnabled ? 'Шаблон включён' : 'Шаблон выключен')
			dispatchTimingHubChanged()
		} catch (e) {
			console.error(e)
			setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: prevEnabled } : r)))
			message.error(getApiErrorMessage(e, 'Не удалось изменить статус шаблона'))
		} finally {
			setToggleBusyId(null)
		}
	}

	const restoreBusy = backupImporting || backupSyncing || loading

	const renderTableMediaThumb = (row: TemplateRow) => {
		if (!row.media_url) return null
		if (isAudioUrl(row.media_url)) {
			return (
				<button
					type="button"
					className="tpl-table__mediaBtn"
					onClick={() => setMediaViewerUrl(row.media_url!)}
					title="Открыть медиа"
				>
					<span className="tpl-table__mediaAudio">AUDIO</span>
				</button>
			)
		}
		return (
			<button
				type="button"
				className="tpl-table__mediaBtn"
				onClick={() => setMediaViewerUrl(row.media_url!)}
				title="Открыть медиа"
			>
				{isVideoUrl(row.media_url) ? (
					<video src={row.media_url} className="tpl-table__mediaThumb" muted playsInline />
				) : (
					<img src={row.media_url} className="tpl-table__mediaThumb" alt="Медиа шаблона" />
				)}
			</button>
		)
	}

	const columns: ColumnsType<TemplateRow> = useMemo(() => {
		const cols: ColumnsType<TemplateRow> = [
			{
				title: 'Статус',
				key: 'enabled',
				width: 92,
				render: (_: any, row: TemplateRow) => (
					<Switch
						checked={!!row.enabled}
						checkedChildren="ON"
						unCheckedChildren="OFF"
						disabled={toggleBusyId === row.id}
						onChange={(checked) => toggleTemplateEnabled(row, checked)}
					/>
				),
			},
			{
				title: 'Название',
				key: 'title',
				render: (_: any, row: TemplateRow) => (
					<div className="tpl-table__titleCell">
						<div style={{ minWidth: 220 }}>
							<div style={{ fontWeight: 800, fontSize: 13, lineHeight: 1.25 }}>
								{row.title?.trim() ? row.title : 'Шаблон'}
							</div>
							<div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
								{row.media_url ? <Tag>медиа</Tag> : null}
								{row.send_media_as_file ? <Tag>медиа: как файл</Tag> : null}
							</div>
						</div>
						{renderTableMediaThumb(row)}
					</div>
				),
			},
			{
				title: 'Настройки',
				key: 'settings',
				render: (_: any, row: TemplateRow) => {
					const waLabel = labelTemplateBetweenGroups('wa', row, 'full')
					const tgLabel = labelTemplateBetweenGroups('tg', row, 'full')
					const tgDef = labelTgDefault(row.tg_default_send_time)
					return (
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
							<Tag><ChannelIcon type="wa" size={12} /> {waLabel}</Tag>
							<Tag><ChannelIcon type="tg" size={12} /> {tgLabel}</Tag>
							<Tag><ChannelIcon type="tg" size={12} /> TG интервал: {tgDef}</Tag>
							<Tag><ChannelIcon type="wa" size={12} /> WA групп: {Number(row.targets_count?.wa ?? 0)}</Tag>
							<Tag><ChannelIcon type="tg" size={12} /> TG групп: {Number(row.targets_count?.tg ?? 0)}</Tag>
							<Tag color={Number(row.problematic_groups?.total ?? 0) > 0 ? 'error' : undefined}>
								<ChannelIcon type="tg" size={12} /> Проблемных TG: {Number(row.problematic_groups?.total ?? 0)}
							</Tag>
							<Popover content={renderTemplateProblemPopover(row, router)} trigger="click" placement="rightTop">
								<button type="button" className="tpl-btn" style={{ padding: '0 8px', minHeight: 22 }}>i</button>
							</Popover>
						</div>
					)
				},
			},
			{
				title: 'Создан',
				key: 'created_at',
				width: 140,
				defaultSortOrder: 'descend',
				sorter: (a: TemplateRow, b: TemplateRow) =>
					(new Date(a.created_at || 0).getTime() || 0) - (new Date(b.created_at || 0).getTime() || 0),
				sortDirections: ['descend', 'ascend'],
				render: (_: any, row: TemplateRow) => (
					<div style={{ fontSize: 12, opacity: 0.85 }}>
						{row.created_at ? new Date(row.created_at).toLocaleString() : '—'}
					</div>
				),
			},
			{
				title: 'Обновлён',
				key: 'updated_at',
				width: 140,
				sorter: (a: TemplateRow, b: TemplateRow) =>
					(new Date(a.updated_at || 0).getTime() || 0) - (new Date(b.updated_at || 0).getTime() || 0),
				sortDirections: ['descend', 'ascend'],
				render: (_: any, row: TemplateRow) => (
					<div style={{ fontSize: 12, opacity: 0.85 }}>
						{row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'}
					</div>
				),
			},
			{
				title: 'Статистика',
				key: 'stats',
				width: 160,
				render: (_: any, row: TemplateRow) => {
					if (!row.stats) return <span style={{ opacity: 0.7, fontSize: 12 }}>—</span>
					const byReason = row.problematic_groups?.by_reason
					return (
						<div style={{ fontSize: 12, lineHeight: 1.3 }}>
							<div>отправлено: <b>{row.stats.sent}</b></div>
							<div>заданий: <b>{row.stats.total}</b></div>
							<div>проблемных TG: <b>{Number(row.problematic_groups?.total ?? 0)}</b></div>
							{byReason ? (
								<div style={{ opacity: 0.85 }}>
									причины: INV {byReason.CHANNEL_INVALID} / WRT {byReason.CHAT_WRITE_FORBIDDEN} / BAN {byReason.USER_BANNED_IN_CHANNEL} / PRIV {byReason.CHANNEL_PRIVATE}
									<span style={{ marginLeft: 6 }}><TgReasonLegendHint /></span>
								</div>
							) : null}
						</div>
					)
				},
			},
			{
				title: 'Действия',
				key: 'actions',
				width: 220,
				render: (_: any, row: TemplateRow) => (
					<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
						<button
							type="button"
							className="tpl-btn"
							onClick={() => {
								loader.show('Открываем шаблон…')
								router.push(`/dashboard/templates/${row.id}`)
							}}
						>
							Редактировать
						</button>
						<Popconfirm
							title="Удалить шаблон?"
							description="После удаления восстановить нельзя."
							okText="Удалить"
							cancelText="Отмена"
							onConfirm={async () => {
								const res: any = await apiPost('/templates/delete', { templateId: row.id })
								if (!res?.success) {
									message.error(`Ошибка удаления: ${res?.message || 'unknown'}`)
									return
								}
								message.success('Шаблон удалён')
								dispatchTimingHubChanged()
								load()
							}}
						>
							<button type="button" className="tpl-btn tpl-btn--danger">
								Удалить
							</button>
						</Popconfirm>
					</div>
				),
			},
		]
		return cols
	}, [toggleBusyId, loader, router, load])

	const mobileColumns: ColumnsType<TemplateRow> = useMemo(() => {
		return [
			{
				title: 'Шаблон',
				key: 'template',
				render: (_: any, row: TemplateRow) => {
					const waShort = labelTemplateBetweenGroups('wa', row, 'compact')
					const tgShort = labelTemplateBetweenGroups('tg', row, 'compact')
					const tgDefShort = labelTgDefault(row.tg_default_send_time)
					const speedsTitle = `WA ${waShort}, TG ${tgShort}${tgDefShort && tgDefShort !== 'Авто' ? `, интервал: ${tgDefShort}` : ''}`
					return (
						<div className="tpl-table__mobileTemplate">
							<div className="tpl-table__mobileTemplateMain">
								<div className="tpl-table__mobileTemplateTitle" title={row.title?.trim() || 'Шаблон'}>
									{row.title?.trim() ? row.title : 'Шаблон'}
								</div>
								<div className="tpl-table__mobileTemplateMeta">
									{row.media_url ? <span className="tpl-table__mobileChip">медиа</span> : null}
									{row.send_media_as_file ? <span className="tpl-table__mobileChip">файл</span> : null}
								</div>
								<div className="tpl-table__mobileTemplateSpeeds" title={speedsTitle}>
									<span className="tpl-table__mobileSpeed"><ChannelIcon type="wa" size={10} /> {waShort}</span>
									<span className="tpl-table__mobileSpeedSep">·</span>
									<span className="tpl-table__mobileSpeed"><ChannelIcon type="tg" size={10} /> {tgShort}</span>
								</div>
								<div className="tpl-table__mobileTemplateSpeeds" title="Количество выбранных групп по каналам">
									<span className="tpl-table__mobileSpeed"><ChannelIcon type="wa" size={10} /> гр: {Number(row.targets_count?.wa ?? 0)}</span>
									<span className="tpl-table__mobileSpeedSep">·</span>
									<span className="tpl-table__mobileSpeed"><ChannelIcon type="tg" size={10} /> гр: {Number(row.targets_count?.tg ?? 0)}</span>
								</div>
							</div>
							{renderTableMediaThumb(row)}
						</div>
					)
				},
			},
			{
				title: 'Статус',
				key: 'enabled',
				width: 72,
				align: 'center',
				render: (_: any, row: TemplateRow) => (
					<Switch
						size="small"
						checked={!!row.enabled}
						checkedChildren="ON"
						unCheckedChildren="OFF"
						disabled={toggleBusyId === row.id}
						onChange={(checked) => toggleTemplateEnabled(row, checked)}
					/>
				),
			},
			{
				title: 'Действия',
				key: 'actions',
				width: 128,
				align: 'right',
				render: (_: any, row: TemplateRow) => (
					<div className="tpl-table__mobileActions">
						<button
							type="button"
							className="tpl-btn tpl-table__mobileActionBtn"
							onClick={() => {
								loader.show('Открываем шаблон…')
								router.push(`/dashboard/templates/${row.id}`)
							}}
						>
							Открыть
						</button>
						<Popconfirm
							title="Удалить шаблон?"
							description="После удаления восстановить нельзя."
							okText="Удалить"
							cancelText="Отмена"
							onConfirm={async () => {
								const res: any = await apiPost('/templates/delete', { templateId: row.id })
								if (!res?.success) {
									message.error(`Ошибка удаления: ${res?.message || 'unknown'}`)
									return
								}
								message.success('Шаблон удалён')
								dispatchTimingHubChanged()
								load()
							}}
						>
							<button type="button" className="tpl-btn tpl-btn--danger tpl-table__mobileActionBtn">
								Удалить
							</button>
						</Popconfirm>
					</div>
				),
			},
		]
	}, [toggleBusyId, loader, router, load])

	return (
		<div className={`tpl ${contentReady ? 'tpl--ready' : ''}`}>
			<div className='tpl__wrap'>
				<div className='tpl__topbar'>
					<div className='tpl__filters'>
						<input
							className='tpl-filterInput'
							type='text'
							placeholder='Поиск по названию и тексту…'
							value={search}
							onChange={e => setSearch(e.target.value)}
						/>
						<Segmented
							size="small"
							value={viewMode}
							options={[
								{ label: 'Карточки', value: 'cards' },
								{ label: 'Таблица', value: 'table' },
							]}
							onChange={(v) => {
								const next = (v as any) === 'table' ? 'table' : 'cards'
								setViewMode(next)
								try {
									localStorage.setItem(LS_KEY_TEMPLATES_VIEW, next)
								} catch {
									// ignore
								}
							}}
						/>

						{viewMode === 'cards' && (
							<select
								className="tpl-sortSelect"
								value={`${cardSortKey}:${cardSortDir}`}
								onChange={(e) => {
									const [k, d] = String(e.target.value).split(':') as [CardSortKey, SortDir]
									setCardSortKey(k)
									setCardSortDir(d)
								}}
							>
								<option value="created_at:desc">Создан ↓</option>
								<option value="created_at:asc">Создан ↑</option>
								<option value="updated_at:desc">Обновлён ↓</option>
								<option value="updated_at:asc">Обновлён ↑</option>
							</select>
						)}
						<div className='tpl-filterStatus'>
							<button
								type='button'
								className={`tpl-filterChip ${
									statusFilter === 'all' ? 'tpl-filterChip--active' : ''
								}`}
								onClick={() => setStatusFilter('all')}
							>
								Все
							</button>
							<button
								type='button'
								className={`tpl-filterChip ${
									statusFilter === 'on' ? 'tpl-filterChip--active' : ''
								}`}
								onClick={() => setStatusFilter('on')}
							>
								Включены
							</button>
							<button
								type='button'
								className={`tpl-filterChip ${
									statusFilter === 'off' ? 'tpl-filterChip--active' : ''
								}`}
								onClick={() => setStatusFilter('off')}
							>
								Выключены
							</button>
						</div>
					</div>
				</div>

				<div className='tpl__content'>
					<div className='tpl__left'>
						<div className='tpl-card' style={{ marginBottom: 12 }}>
							<div className='tpl-card__badges'>
								<span className='tpl-badge neutral'>Шаблонов всего: {totals.templatesTotal}</span>
								<span className='tpl-badge neutral'>Шаблонов с группами: {totals.templatesWithGroupsSelected}</span>
								<span className='tpl-badge neutral'>Связок шаблон↔группа: {totals.totalTargetsAssigned}</span>
								<span className='tpl-badge neutral'>Уникальных групп всего: {totals.uniqueGroupsAll}</span>
								<span className='tpl-badge neutral'><ChannelIcon type="wa" size={12} /> уникальных WA: {totals.uniqueGroupsWa}</span>
								<span className='tpl-badge neutral'><ChannelIcon type="tg" size={12} /> уникальных TG: {totals.uniqueGroupsTg}</span>
								<span className='tpl-badge neutral' title='Сейчас метрика проблемных групп считается только для Telegram'>
									<ChannelIcon type="tg" size={12} /> Проблемных TG (уник.): {totals.uniqueUndeliverableSelectedGroups}
								</span>
								<span className='tpl-badge neutral' title='Активные WA-группы с ошибкой доставки в последних данных группы'>
									<ChannelIcon type="wa" size={12} /> Проблемных WA (уник.): {totals.uniqueUndeliverableSelectedGroupsWa}
								</span>
								<Popover content={renderWaProblemPopover(totals, router)} trigger="click" placement="rightTop">
									<button type="button" className="tpl-btn" style={{ padding: '0 8px', minHeight: 22 }}>i</button>
								</Popover>
							</div>
						</div>
						{filtered.length === 0 ? (
							<div className='tpl-empty'>
								<div className='tpl-empty__title'>
									{loading
										? 'Загружаю шаблоны…'
										: search.trim()
										? 'Ничего не нашлось'
										: 'Пока нет шаблонов'}
								</div>
								<div className='tpl-empty__text'>
									{loading
										? 'Ищу ваши шаблоны, это может занять несколько секунд.'
										: search.trim()
										? 'Попробуйте изменить текст поиска или снять фильтр статуса.'
										: 'Нажмите «Создать шаблон», чтобы добавить первый.'}
								</div>
							</div>
						) : (
							viewMode === 'table' ? (
								<div className={`tpl-table${isMobileTable ? ' tpl-table--mobile' : ''}`}>
									<Table
										rowKey="id"
										columns={isMobileTable ? mobileColumns : columns}
										dataSource={filtered}
										pagination={{ pageSize: 20, showSizeChanger: true }}
										size="small"
										scroll={isMobileTable ? undefined : { x: 980 }}
										tableLayout={isMobileTable ? 'fixed' : undefined}
									/>
								</div>
							) : (
								<div className='tpl__list'>
									{filtered.map((row, idx) => (
										<div
											className='tpl-row'
											key={row.id}
											style={
												contentReady
													? ({ ['--tpl-stagger' as any]: `${Math.min(18, idx) * 45}ms` } as any)
													: undefined
											}
										>
											<div
												className='tpl-card'
												onContextMenu={(e) => {
													e.preventDefault()
													setContextMenu({ row, x: e.clientX, y: e.clientY })
												}}
											>
												<div className='tpl-card__row'>
													<div className='tpl-card__section tpl-card__section--grow'>
														<div className='tpl-card__labelRow'>
															<span className='tpl-card__label'>Название</span>
															<span className='tpl-card__label'>Текст сообщения</span>
														</div>
														<div className='tpl-card__contentRow'>
															<div className='tpl-card__title'>
																{row.title?.trim() ? row.title : 'Шаблон'}
															</div>
															<div
																className='tpl-card__textBox'
																dangerouslySetInnerHTML={{
																	__html: row.text?.trim()
																		? markdownToHtml(row.text)
																		: 'Текст шаблона',
																}}
															/>
														</div>
													</div>
													{row.media_url ? (
														<div className='tpl-card__media'>
															<button
																type='button'
																className='tpl-card__mediaBtn'
																onClick={() => setMediaViewerUrl(row.media_url!)}
																title='Открыть в полном размере / запустить'
															>
																{isVideoUrl(row.media_url) ? (
																	<video
																		src={row.media_url}
																		className='tpl-card__mediaThumb'
																		muted
																		playsInline
																	/>
																) : isAudioUrl(row.media_url) ? (
																	<div className='tpl-card__mediaThumb tpl-card__mediaThumb--audio'>
																		<audio src={row.media_url} controls className='tpl-card__audio' />
																	</div>
																) : (
																	<img
																		src={row.media_url}
																		className='tpl-card__mediaThumb'
																		alt='Превью медиа'
																	/>
																)}
															</button>
														</div>
													) : null}
												</div>
												<div className='tpl-card__badges'>
													<Switch
														checked={!!row.enabled}
														checkedChildren='ON'
														unCheckedChildren='OFF'
														disabled={toggleBusyId === row.id}
														onChange={(checked) => toggleTemplateEnabled(row, checked)}
													/>
													{row.send_media_as_file ? (
														<span className='tpl-badge neutral'>Медиа: как файл</span>
													) : null}
													{row.wa_speed_factor != null ? (
														<span className='tpl-badge neutral'>WA скорость: {row.wa_speed_factor}%</span>
													) : null}
													{row.tg_speed_factor != null ? (
														<span className='tpl-badge neutral'>TG скорость: {row.tg_speed_factor}%</span>
													) : null}
													{row.tg_default_send_time ? (
														<span className='tpl-badge neutral'>TG: {labelTgDefault(row.tg_default_send_time)}</span>
													) : null}
													<span className='tpl-badge neutral'>
														<ChannelIcon type="wa" size={12} /> WA групп: {Number(row.targets_count?.wa ?? 0)}
													</span>
													<span className='tpl-badge neutral'>
														<ChannelIcon type="tg" size={12} /> TG групп: {Number(row.targets_count?.tg ?? 0)}
													</span>
													<span className={`tpl-badge ${Number(row.problematic_groups?.total ?? 0) > 0 ? '' : 'neutral'}`}>
														<ChannelIcon type="tg" size={12} /> Проблемных TG: {Number(row.problematic_groups?.total ?? 0)}
													</span>
													<Popover content={renderTemplateProblemPopover(row, router)} trigger="click" placement="rightTop">
														<button type="button" className="tpl-btn" style={{ padding: '0 8px', minHeight: 22 }}>i</button>
													</Popover>
													{row.problematic_groups?.by_reason ? (
														<span className='tpl-badge neutral' style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
															Причины TG: INV {row.problematic_groups.by_reason.CHANNEL_INVALID}, WRT {row.problematic_groups.by_reason.CHAT_WRITE_FORBIDDEN}, BAN {row.problematic_groups.by_reason.USER_BANNED_IN_CHANNEL}, PRIV {row.problematic_groups.by_reason.CHANNEL_PRIVATE}
															<TgReasonLegendHint />
														</span>
													) : null}
													<span className='tpl-badge neutral'>
														Создан:{' '}
														{row.created_at
															? new Date(row.created_at).toLocaleString()
															: '-'}
													</span>
													<span className='tpl-badge neutral'>
														Обновлён:{' '}
														{row.updated_at
															? new Date(row.updated_at).toLocaleString()
															: '-'}
													</span>
													{row.stats ? (
														<>
															<span className='tpl-badge neutral'>
																Отправлено сообщений: {row.stats.sent}
															</span>
															<span className='tpl-badge neutral'>
																Всего заданий: {row.stats.total}
															</span>
														</>
													) : null}
													<button
														type='button'
														className='tpl-anal-btn'
														onClick={() => {
															loader.show('Открываем историю…')
															router.push('/dashboard/analytics')
														}}
													>
														История
													</button>
												</div>

												<div className='tpl-card__actions'>
													<div className='tpl-card__buttonsRow'>
														<button
															className='tpl-btn tpl-btn--wide'
															onClick={() => {
																loader.show('Открываем шаблон…')
																router.push(`/dashboard/templates/${row.id}`)
															}}
														>
															Редактировать
														</button>

														<Popconfirm
															title='Удалить шаблон?'
															description='После удаления восстановить нельзя.'
															okText='Удалить'
															cancelText='Отмена'
															onConfirm={async () => {
																const res: any = await apiPost('/templates/delete', {
																	templateId: row.id,
																})
																if (!res?.success) {
																	message.error(
																		`Ошибка удаления: ${res?.message || 'unknown'}`
																	)
																	return
																}
																message.success('Шаблон удален')
																dispatchTimingHubChanged()
																load()
															}}
														>
															<button className='tpl-btn tpl-btn--wide tpl-btn--danger'>
																Удалить
															</button>
														</Popconfirm>
													</div>

													<div className='tpl-card__hintsRow'>
														<span>Редактируйте шаблон и настройки отправки. Удаляйте, если шаблон больше не нужен.</span>
													</div>
												</div>
											</div>
										</div>
									))}
								</div>
							)
						)}
					</div>
				</div>

				{userId ? (
					<div className='tpl__backup'>
						<TemplatesSheetCard
							userId={userId}
							gsheetUrl={gsheetUrl}
							onCreated={(url) => setGsheetUrl(url)}
							onGsheetUrlSaved={(url) => setGsheetUrl(url)}
							onTemplatesChanged={() => {
								dispatchTimingHubChanged()
								load(userId)
							}}
						/>
					</div>
				) : null}
			</div>
			{/* Контекстное меню по ПКМ на карточке */}
			{contextMenu && (
				<div
					ref={contextMenuRef}
					className='tpl-context-menu'
					style={{
						position: 'fixed',
						left: contextMenu.x,
						top: contextMenu.y,
						zIndex: 2000,
					}}
					onClick={(e) => e.stopPropagation()}
				>
					<div className='tpl-context-menu__section'>
						<div className='tpl-context-menu__section-title'>Шаблон</div>
						<button
							type='button'
							className='tpl-context-menu__item'
							onClick={() => {
								setContextMenu(null)
								loader.show('Открываем шаблон…')
								router.push(`/dashboard/templates/${contextMenu.row.id}`)
							}}
						>
							<span className='tpl-context-menu__icon'>✏️</span>
							Изменить шаблон
						</button>
						<button
							type='button'
							className='tpl-context-menu__item'
							onClick={() => {
								setContextMenu(null)
								window.open(`/dashboard/templates/${contextMenu.row.id}`, '_blank', 'noopener,noreferrer')
							}}
						>
							<span className='tpl-context-menu__icon'>↗</span>
							Открыть в новой вкладке
						</button>
					</div>
					<div className='tpl-context-menu__separator' />
					<div className='tpl-context-menu__section'>
						<div className='tpl-context-menu__section-title'>Рассылки</div>
						<button
							type='button'
							className='tpl-context-menu__item'
							onClick={() => {
								setContextMenu(null)
								loader.show('Открываем историю…')
								router.push('/dashboard/analytics')
							}}
						>
							<span className='tpl-context-menu__icon'>📊</span>
							История
						</button>
						<button
							type='button'
							className='tpl-context-menu__item'
							onClick={() => {
								setContextMenu(null)
								loader.show('К рассылкам…')
								router.push('/dashboard/campaigns')
							}}
						>
							<span className='tpl-context-menu__icon'>📤</span>
							К рассылкам
						</button>
					</div>
					<div className='tpl-context-menu__separator' />
					<Popconfirm
						title='Удалить шаблон?'
						description='После удаления восстановить нельзя.'
						okText='Удалить'
						cancelText='Отмена'
						onConfirm={async () => {
							const templateId = deleteTargetRef.current
							deleteTargetRef.current = null
							setContextMenu(null)
							if (!templateId) return message.error('Нет templateId')
							const res: any = await apiPost('/templates/delete', {
								templateId,
							})
							if (!res?.success) {
								message.error(`Ошибка удаления: ${res?.message || 'unknown'}`)
								return
							}
							message.success('Шаблон удалён')
							dispatchTimingHubChanged()
							load()
						}}
					>
						<button
							type='button'
							className='tpl-context-menu__item tpl-context-menu__item--danger'
							onClick={() => {
								if (contextMenu) deleteTargetRef.current = contextMenu.row.id
								setContextMenu(null)
							}}
						>
							<span className='tpl-context-menu__icon'>🗑</span>
							Удалить шаблон
						</button>
					</Popconfirm>
				</div>
			)}

			<MediaViewerModal
				open={!!mediaViewerUrl}
				url={mediaViewerUrl}
				onClose={() => setMediaViewerUrl(null)}
			/>
		</div>
	)
}
