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
	// speedFactor: 100 = Р±Р°Р·РѕРІРѕ; 200 = РІ 2 СЂР°Р·Р° Р±С‹СЃС‚СЂРµРµ (РїР°СѓР·Р° /2); 50 = РІ 2 СЂР°Р·Р° РјРµРґР»РµРЅРЅРµРµ (РїР°СѓР·Р° *2)
	const sf = clampInt(speedFactor, 10, 400, 100)
	const k = 100 / sf
	const minSec = Math.max(1, Math.round((Number(baseMinSec) || 0) * k))
	const maxSec = Math.max(1, Math.round((Number(baseMaxSec) || 0) * k))
	return { minSec: Math.min(minSec, maxSec), maxSec: Math.max(minSec, maxSec), sf }
}

function labelSpeed(baseMinSec: number, baseMaxSec: number, speedFactor: unknown, channelLabel: string) {
	const { minSec, maxSec, sf } = approxBetweenGroupsSeconds(baseMinSec, baseMaxSec, speedFactor)
	if (sf === 100) return `${channelLabel}: Р±Р°Р·РѕРІРѕ (${minSec}вЂ“${maxSec}СЃ)`
	return `${channelLabel}: ${minSec}вЂ“${maxSec}СЃ (Г—${(sf / 100).toFixed(2)})`
}

/** РљРѕСЂРѕС‚РєР°СЏ РїРѕРґРїРёСЃСЊ РїР°СѓР·С‹ РґР»СЏ РєРѕРјРїР°РєС‚РЅРѕР№ РјРѕР±РёР»СЊРЅРѕР№ С‚Р°Р±Р»РёС†С‹ */
function labelSpeedCompact(baseMinSec: number, baseMaxSec: number, speedFactor: unknown) {
	const { minSec, maxSec, sf } = approxBetweenGroupsSeconds(baseMinSec, baseMaxSec, speedFactor)
	if (sf === 100) return `${minSec}вЂ“${maxSec}СЃ`
	return `${minSec}вЂ“${maxSec}СЃ Г—${(sf / 100).toFixed(1)}`
}

function templateHasExplicitPauseSec(channel: 'wa' | 'tg', row: TemplateRow) {
	const minK = channel === 'wa' ? 'wa_between_groups_sec_min' : 'tg_between_groups_sec_min'
	const maxK = channel === 'wa' ? 'wa_between_groups_sec_max' : 'tg_between_groups_sec_max'
	return typeof row[minK] === 'number' && typeof row[maxK] === 'number'
}

/** РџР°СѓР·Р° РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРё РІ С‚Р°Р±Р»РёС†Рµ: СЏРІРЅС‹Рµ СЃРµРє РёР· С€Р°Р±Р»РѕРЅР° РёР»Рё СЃС‚Р°СЂС‹Р№ СЂРµР¶РёРј (% РѕС‚ Р±Р°Р·С‹). */
function labelTemplateBetweenGroups(channel: 'wa' | 'tg', row: TemplateRow, mode: 'full' | 'compact') {
	const [lo, hi] = readTemplatePausePairFromApi(
		channel,
		row as Record<string, unknown>,
		channel === 'wa' ? row.wa_speed_factor : row.tg_speed_factor,
	)
	const explicit = templateHasExplicitPauseSec(channel, row)
	if (mode === 'compact') {
		if (explicit) return `${lo}вЂ“${hi}СЃ`
		const [bLo, bHi] = channel === 'wa' ? SERVER_BETWEEN_GROUPS_SEC.wa : SERVER_BETWEEN_GROUPS_SEC.tg
		return labelSpeedCompact(bLo, bHi, channel === 'wa' ? row.wa_speed_factor : row.tg_speed_factor)
	}
	const prefix = channel === 'wa' ? 'WA РїР°СѓР·Р°' : 'TG РїР°СѓР·Р°'
	if (explicit) return `${prefix}: ${lo}вЂ“${hi} СЃ (РІ С€Р°Р±Р»РѕРЅРµ)`
	const [bLo, bHi] = channel === 'wa' ? SERVER_BETWEEN_GROUPS_SEC.wa : SERVER_BETWEEN_GROUPS_SEC.tg
	return labelSpeed(bLo, bHi, channel === 'wa' ? row.wa_speed_factor : row.tg_speed_factor, prefix)
}

function labelTgDefault(v: unknown): string {
	const s = String(v ?? '').trim()
	if (!s) return 'РђРІС‚Рѕ'
	if (isHHMM(s)) {
		const [hh, mm] = s.split(':').map(x => Number(x))
		const minutes = (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0)
		if (!minutes) return 'РђРІС‚Рѕ'
		return `РРЅС‚РµСЂРІР°Р» ${minutes} РјРёРЅ`
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
					<div><b>Р Р°СЃС€РёС„СЂРѕРІРєР° РїСЂРёС‡РёРЅ TG</b></div>
					<div><b>INV</b> вЂ” РєР°РЅР°Р»/РіСЂСѓРїРїР° РЅРµРґРѕСЃС‚СѓРїРЅС‹ РїРѕ С‚РµРєСѓС‰РёРј РґР°РЅРЅС‹Рј Telegram (С‡Р°СЃС‚Рѕ РїРѕРјРѕРіР°РµС‚ СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёСЏ).</div>
					<div><b>WRT</b> вЂ” РЅРµС‚ РїСЂР°РІ РѕС‚РїСЂР°РІРєРё РІ РіСЂСѓРїРїСѓ (РѕРіСЂР°РЅРёС‡РµРЅРёСЏ/СЂРѕР»СЊ).</div>
					<div><b>BAN</b> вЂ” Р°РєРєР°СѓРЅС‚ РѕРіСЂР°РЅРёС‡РµРЅ/Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ РІ СЌС‚РѕР№ РіСЂСѓРїРїРµ.</div>
					<div><b>PRIV</b> вЂ” РїСЂРёРІР°С‚РЅС‹Р№ РєР°РЅР°Р»/РіСЂСѓРїРїР°, Сѓ Р°РєРєР°СѓРЅС‚Р° РЅРµС‚ РґРѕСЃС‚СѓРїР°.</div>
				</div>
			}
		>
			<button type="button" className="tpl-btn" style={{ padding: '0 8px', minHeight: 22 }}>i</button>
		</Popover>
	)
}

function waReasonHuman(reason: string): string {
	const r = String(reason || '').toLowerCase()
	if (r === 'wa_not_connected') return 'РќРµС‚ Р°РєС‚РёРІРЅРѕРіРѕ РїРѕРґРєР»СЋС‡РµРЅРёСЏ WhatsApp'
	if (r === 'media_upload_failed') return 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РјРµРґРёР° РІ WhatsApp'
	if (r.includes('timeout')) return 'РСЃС‚РµРєР»Рѕ РІСЂРµРјСЏ РѕР¶РёРґР°РЅРёСЏ РѕС‚РІРµС‚Р° WhatsApp'
	if (r.includes('rate') || r.includes('overlimit')) return 'РћРіСЂР°РЅРёС‡РµРЅРёРµ СЃРєРѕСЂРѕСЃС‚Рё РѕС‚РїСЂР°РІРєРё СЃРѕ СЃС‚РѕСЂРѕРЅС‹ WhatsApp'
	return reason || 'РќРµРёР·РІРµСЃС‚РЅР°СЏ РїСЂРёС‡РёРЅР°'
}

function renderWaProblemPopover(totals: TemplatesTotals, router: ReturnType<typeof useRouter>) {
	const s = totals.problematicWaSummary
	const topReasons = s?.topReasons || []
	const topGroups = s?.topGroups || []
	return (
		<div style={{ minWidth: 320, maxWidth: 460, fontSize: 12, lineHeight: 1.45 }}>
			<div><b>РџСЂРѕР±Р»РµРјРЅС‹С… WA РіСЂСѓРїРї (СѓРЅРёРє.): {Number(s?.total ?? 0)}</b></div>
			<div style={{ marginTop: 6 }}>
				<b>РўРѕРї РїСЂРёС‡РёРЅ</b>
				{topReasons.length ? (
					<div style={{ marginTop: 4 }}>
						{topReasons.map((r) => (
							<div key={r.reason}>{waReasonHuman(r.reason)} В· {r.count}</div>
						))}
					</div>
				) : <div style={{ opacity: 0.75 }}>вЂ”</div>}
			</div>
			<div style={{ marginTop: 6 }}>
				<b>Top РіСЂСѓРїРїС‹ (РґРѕ 5)</b>
				{topGroups.length ? (
					<div style={{ marginTop: 4 }}>
						{topGroups.map((g) => (
							<div key={`${g.group_jid}:${g.reason}`}>
								<code>{g.group_jid}</code> В· {waReasonHuman(g.reason)}
							</div>
						))}
					</div>
				) : <div style={{ opacity: 0.75 }}>вЂ”</div>}
			</div>
			<div style={{ marginTop: 8 }}>
				<button type="button" className="tpl-btn" onClick={() => router.push('/dashboard/groups')}>
					РћС‚РєСЂС‹С‚СЊ РіСЂСѓРїРїС‹ WA
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
			<div><b>РџСЂРѕР±Р»РµРјРЅС‹С… TG РіСЂСѓРїРї: {Number(p?.total ?? 0)}</b></div>
			<div>
				РўРѕРї РїСЂРёС‡РёРЅ: INV {Number(p?.by_reason?.CHANNEL_INVALID ?? 0)}, WRT {Number(p?.by_reason?.CHAT_WRITE_FORBIDDEN ?? 0)}, BAN {Number(p?.by_reason?.USER_BANNED_IN_CHANNEL ?? 0)}, PRIV {Number(p?.by_reason?.CHANNEL_PRIVATE ?? 0)}
			</div>
			<div style={{ marginTop: 6 }}>
				<b>Top РіСЂСѓРїРїС‹ (РґРѕ 5)</b>
				{top.length ? (
					<div style={{ marginTop: 4 }}>
						{top.map((g) => (
							<div key={g.group_jid}>
								<code>{g.group_jid}</code> В· failed {g.failed} В· sent {g.sent} В· {g.topReason}
							</div>
						))}
					</div>
				) : (
					<div style={{ opacity: 0.75 }}>вЂ”</div>
				)}
			</div>
			<div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
				<button type="button" className="tpl-btn" onClick={() => router.push(`/dashboard/templates/${row.id}`)}>
					РћС‚РєСЂС‹С‚СЊ С€Р°Р±Р»РѕРЅ
				</button>
				<button type="button" className="tpl-btn" onClick={() => router.push('/dashboard/groups/telegram')}>
					РћС‚РєСЂС‹С‚СЊ РіСЂСѓРїРїС‹ TG
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

/** РљРѕРЅРІРµСЂС‚Р°С†РёСЏ СЂР°Р·РјРµС‚РєРё С€Р°Р±Р»РѕРЅР° РІ HTML РґР»СЏ РѕС‚РѕР±СЂР°Р¶РµРЅРёСЏ РІ РїСЂРµРІСЊСЋ (Р¶РёСЂРЅС‹Р№, РєСѓСЂСЃРёРІ, СЃРїРёСЃРєРё). */
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
	// loading = true РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ, С‡С‚РѕР±С‹ РїСЂРё РїРµСЂРІРѕРј СЂРµРЅРґРµСЂРµ РЅРµ РїРёСЃР°С‚СЊ В«РџРѕРєР° РЅРµС‚ С€Р°Р±Р»РѕРЅРѕРІВ»
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

	// Р—Р°РєСЂС‹С‚РёРµ РєРѕРЅС‚РµРєСЃС‚РЅРѕРіРѕ РјРµРЅСЋ РїРѕ РєР»РёРєСѓ СЃРЅР°СЂСѓР¶Рё РёР»Рё Escape
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
			setViewMode('cards')
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
				message.error('РќРµРІРµСЂРЅС‹Р№ РѕС‚РІРµС‚ СЃРµСЂРІРµСЂР°')
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
			message.error('РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕР»СѓС‡РёС‚СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ')
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
					? `РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё С€Р°Р±Р»РѕРЅРѕРІ: ${json?.message || 'supabase_select_error'} (${details})`
					: `РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё С€Р°Р±Р»РѕРЅРѕРІ: ${json?.message || 'unknown'}`
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
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ С€Р°Р±Р»РѕРЅС‹'))
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

	// РџР»Р°РІРЅРѕРµ РїРѕСЏРІР»РµРЅРёРµ РєРѕРЅС‚РµРЅС‚Р° СЃС‚СЂР°РЅРёС†С‹ (РєР°Рє РІ Р›Рљ): РґРІРѕР№РЅРѕР№ rAF, С‡С‚РѕР±С‹ РїРµСЂРІС‹Р№ РєР°РґСЂ СѓСЃРїРµР» РѕС‚СЂРёСЃРѕРІР°С‚СЊСЃСЏ.
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
			// Р’ РєР°СЂС‚РѕС‡РєР°С… СѓРїСЂР°РІР»СЏРµРј СЃРѕСЂС‚РёСЂРѕРІРєРѕР№ СЃРµР»РµРєС‚РѕСЂРѕРј.
			if (viewMode === 'cards') {
				const aVal = getTs(a, cardSortKey)
				const bVal = getTs(b, cardSortKey)
				if (aVal !== bVal) {
					return cardSortDir === 'asc' ? aVal - bVal : bVal - aVal
				}
				return (a.order ?? 0) - (b.order ?? 0)
			}

			// Р’ С‚Р°Р±Р»РёС†Рµ РѕСЃС‚Р°РІР»СЏРµРј РїСЂРµР¶РЅРµРµ РїРѕРІРµРґРµРЅРёРµ: СЃРѕСЂС‚РёСЂРѕРІРєР° РїРѕ created_at desc.
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
				message.error(`РќРµ СѓРґР°Р»РѕСЃСЊ РёР·РјРµРЅРёС‚СЊ СЃС‚Р°С‚СѓСЃ: ${res?.message || 'unknown'}`)
				return
			}
			message.success(nextEnabled ? 'РЁР°Р±Р»РѕРЅ РІРєР»СЋС‡С‘РЅ' : 'РЁР°Р±Р»РѕРЅ РІС‹РєР»СЋС‡РµРЅ')
			dispatchTimingHubChanged()
		} catch (e) {
			console.error(e)
			setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: prevEnabled } : r)))
			message.error(getApiErrorMessage(e, 'РќРµ СѓРґР°Р»РѕСЃСЊ РёР·РјРµРЅРёС‚СЊ СЃС‚Р°С‚СѓСЃ С€Р°Р±Р»РѕРЅР°'))
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
					title="РћС‚РєСЂС‹С‚СЊ РјРµРґРёР°"
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
				title="РћС‚РєСЂС‹С‚СЊ РјРµРґРёР°"
			>
				{isVideoUrl(row.media_url) ? (
					<video src={row.media_url} className="tpl-table__mediaThumb" muted playsInline />
				) : (
					<img src={row.media_url} className="tpl-table__mediaThumb" alt="РњРµРґРёР° С€Р°Р±Р»РѕРЅР°" />
				)}
			</button>
		)
	}

	const columns: ColumnsType<TemplateRow> = useMemo(() => {
		const cols: ColumnsType<TemplateRow> = [
			{
				title: 'РЎС‚Р°С‚СѓСЃ',
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
				title: 'РќР°Р·РІР°РЅРёРµ',
				key: 'title',
				render: (_: any, row: TemplateRow) => (
					<div className="tpl-table__titleCell">
						<div style={{ minWidth: 220 }}>
							<div style={{ fontWeight: 800, fontSize: 13, lineHeight: 1.25 }}>
								{row.title?.trim() ? row.title : 'РЁР°Р±Р»РѕРЅ'}
							</div>
							<div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
								{row.media_url ? <Tag>РјРµРґРёР°</Tag> : null}
								{row.send_media_as_file ? <Tag>РјРµРґРёР°: РєР°Рє С„Р°Р№Р»</Tag> : null}
							</div>
						</div>
						{renderTableMediaThumb(row)}
					</div>
				),
			},
			{
				title: 'РќР°СЃС‚СЂРѕР№РєРё',
				key: 'settings',
				render: (_: any, row: TemplateRow) => {
					const waLabel = labelTemplateBetweenGroups('wa', row, 'full')
					const tgLabel = labelTemplateBetweenGroups('tg', row, 'full')
					const tgDef = labelTgDefault(row.tg_default_send_time)
					return (
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
							<Tag><ChannelIcon type="wa" size={12} /> {waLabel}</Tag>
							<Tag><ChannelIcon type="tg" size={12} /> {tgLabel}</Tag>
							<Tag><ChannelIcon type="tg" size={12} /> TG РёРЅС‚РµСЂРІР°Р»: {tgDef}</Tag>
							<Tag><ChannelIcon type="wa" size={12} /> WA РіСЂСѓРїРї: {Number(row.targets_count?.wa ?? 0)}</Tag>
							<Tag><ChannelIcon type="tg" size={12} /> TG РіСЂСѓРїРї: {Number(row.targets_count?.tg ?? 0)}</Tag>
							<Tag color={Number(row.problematic_groups?.total ?? 0) > 0 ? 'error' : undefined}>
								<ChannelIcon type="tg" size={12} /> РџСЂРѕР±Р»РµРјРЅС‹С… TG: {Number(row.problematic_groups?.total ?? 0)}
							</Tag>
							<Popover content={renderTemplateProblemPopover(row, router)} trigger="click" placement="rightTop">
								<button type="button" className="tpl-btn" style={{ padding: '0 8px', minHeight: 22 }}>i</button>
							</Popover>
						</div>
					)
				},
			},
			{
				title: 'РЎРѕР·РґР°РЅ',
				key: 'created_at',
				width: 140,
				defaultSortOrder: 'descend',
				sorter: (a: TemplateRow, b: TemplateRow) =>
					(new Date(a.created_at || 0).getTime() || 0) - (new Date(b.created_at || 0).getTime() || 0),
				sortDirections: ['descend', 'ascend'],
				render: (_: any, row: TemplateRow) => (
					<div style={{ fontSize: 12, opacity: 0.85 }}>
						{row.created_at ? new Date(row.created_at).toLocaleString() : 'вЂ”'}
					</div>
				),
			},
			{
				title: 'РћР±РЅРѕРІР»С‘РЅ',
				key: 'updated_at',
				width: 140,
				sorter: (a: TemplateRow, b: TemplateRow) =>
					(new Date(a.updated_at || 0).getTime() || 0) - (new Date(b.updated_at || 0).getTime() || 0),
				sortDirections: ['descend', 'ascend'],
				render: (_: any, row: TemplateRow) => (
					<div style={{ fontSize: 12, opacity: 0.85 }}>
						{row.updated_at ? new Date(row.updated_at).toLocaleString() : 'вЂ”'}
					</div>
				),
			},
			{
				title: 'РЎС‚Р°С‚РёСЃС‚РёРєР°',
				key: 'stats',
				width: 160,
				render: (_: any, row: TemplateRow) => {
					if (!row.stats) return <span style={{ opacity: 0.7, fontSize: 12 }}>вЂ”</span>
					const byReason = row.problematic_groups?.by_reason
					return (
						<div style={{ fontSize: 12, lineHeight: 1.3 }}>
							<div>РѕС‚РїСЂР°РІР»РµРЅРѕ: <b>{row.stats.sent}</b></div>
							<div>Р·Р°РґР°РЅРёР№: <b>{row.stats.total}</b></div>
							<div>РїСЂРѕР±Р»РµРјРЅС‹С… TG: <b>{Number(row.problematic_groups?.total ?? 0)}</b></div>
							{byReason ? (
								<div style={{ opacity: 0.85 }}>
									РїСЂРёС‡РёРЅС‹: INV {byReason.CHANNEL_INVALID} / WRT {byReason.CHAT_WRITE_FORBIDDEN} / BAN {byReason.USER_BANNED_IN_CHANNEL} / PRIV {byReason.CHANNEL_PRIVATE}
									<span style={{ marginLeft: 6 }}><TgReasonLegendHint /></span>
								</div>
							) : null}
						</div>
					)
				},
			},
			{
				title: 'Р”РµР№СЃС‚РІРёСЏ',
				key: 'actions',
				width: 220,
				render: (_: any, row: TemplateRow) => (
					<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
						<button
							type="button"
							className="tpl-btn"
							onClick={() => {
								loader.show('РћС‚РєСЂС‹РІР°РµРј С€Р°Р±Р»РѕРЅвЂ¦')
								router.push(`/dashboard/templates/${row.id}`)
							}}
						>
							Р РµРґР°РєС‚РёСЂРѕРІР°С‚СЊ
						</button>
						<Popconfirm
							title="РЈРґР°Р»РёС‚СЊ С€Р°Р±Р»РѕРЅ?"
							description="РџРѕСЃР»Рµ СѓРґР°Р»РµРЅРёСЏ РІРѕСЃСЃС‚Р°РЅРѕРІРёС‚СЊ РЅРµР»СЊР·СЏ."
							okText="РЈРґР°Р»РёС‚СЊ"
							cancelText="РћС‚РјРµРЅР°"
							onConfirm={async () => {
								const res: any = await apiPost('/templates/delete', { templateId: row.id })
								if (!res?.success) {
									message.error(`РћС€РёР±РєР° СѓРґР°Р»РµРЅРёСЏ: ${res?.message || 'unknown'}`)
									return
								}
								message.success('РЁР°Р±Р»РѕРЅ СѓРґР°Р»С‘РЅ')
								dispatchTimingHubChanged()
								load()
							}}
						>
							<button type="button" className="tpl-btn tpl-btn--danger">
								РЈРґР°Р»РёС‚СЊ
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
				title: 'РЁР°Р±Р»РѕРЅ',
				key: 'template',
				render: (_: any, row: TemplateRow) => {
					const waShort = labelTemplateBetweenGroups('wa', row, 'compact')
					const tgShort = labelTemplateBetweenGroups('tg', row, 'compact')
					const tgDefShort = labelTgDefault(row.tg_default_send_time)
					const speedsTitle = `WA ${waShort}, TG ${tgShort}${tgDefShort && tgDefShort !== 'РђРІС‚Рѕ' ? `, РёРЅС‚РµСЂРІР°Р»: ${tgDefShort}` : ''}`
					return (
						<div className="tpl-table__mobileTemplate">
							<div className="tpl-table__mobileTemplateMain">
								<div className="tpl-table__mobileTemplateTitle" title={row.title?.trim() || 'РЁР°Р±Р»РѕРЅ'}>
									{row.title?.trim() ? row.title : 'РЁР°Р±Р»РѕРЅ'}
								</div>
								<div className="tpl-table__mobileTemplateMeta">
									{row.media_url ? <span className="tpl-table__mobileChip">РјРµРґРёР°</span> : null}
									{row.send_media_as_file ? <span className="tpl-table__mobileChip">С„Р°Р№Р»</span> : null}
								</div>
								<div className="tpl-table__mobileTemplateSpeeds" title={speedsTitle}>
									<span className="tpl-table__mobileSpeed"><ChannelIcon type="wa" size={10} /> {waShort}</span>
									<span className="tpl-table__mobileSpeedSep">В·</span>
									<span className="tpl-table__mobileSpeed"><ChannelIcon type="tg" size={10} /> {tgShort}</span>
								</div>
								<div className="tpl-table__mobileTemplateSpeeds" title="РљРѕР»РёС‡РµСЃС‚РІРѕ РІС‹Р±СЂР°РЅРЅС‹С… РіСЂСѓРїРї РїРѕ РєР°РЅР°Р»Р°Рј">
									<span className="tpl-table__mobileSpeed"><ChannelIcon type="wa" size={10} /> РіСЂ: {Number(row.targets_count?.wa ?? 0)}</span>
									<span className="tpl-table__mobileSpeedSep">В·</span>
									<span className="tpl-table__mobileSpeed"><ChannelIcon type="tg" size={10} /> РіСЂ: {Number(row.targets_count?.tg ?? 0)}</span>
								</div>
							</div>
							{renderTableMediaThumb(row)}
						</div>
					)
				},
			},
			{
				title: 'РЎС‚Р°С‚СѓСЃ',
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
				title: 'Р”РµР№СЃС‚РІРёСЏ',
				key: 'actions',
				width: 128,
				align: 'right',
				render: (_: any, row: TemplateRow) => (
					<div className="tpl-table__mobileActions">
						<button
							type="button"
							className="tpl-btn tpl-table__mobileActionBtn"
							onClick={() => {
								loader.show('РћС‚РєСЂС‹РІР°РµРј С€Р°Р±Р»РѕРЅвЂ¦')
								router.push(`/dashboard/templates/${row.id}`)
							}}
						>
							РћС‚РєСЂС‹С‚СЊ
						</button>
						<Popconfirm
							title="РЈРґР°Р»РёС‚СЊ С€Р°Р±Р»РѕРЅ?"
							description="РџРѕСЃР»Рµ СѓРґР°Р»РµРЅРёСЏ РІРѕСЃСЃС‚Р°РЅРѕРІРёС‚СЊ РЅРµР»СЊР·СЏ."
							okText="РЈРґР°Р»РёС‚СЊ"
							cancelText="РћС‚РјРµРЅР°"
							onConfirm={async () => {
								const res: any = await apiPost('/templates/delete', { templateId: row.id })
								if (!res?.success) {
									message.error(`РћС€РёР±РєР° СѓРґР°Р»РµРЅРёСЏ: ${res?.message || 'unknown'}`)
									return
								}
								message.success('РЁР°Р±Р»РѕРЅ СѓРґР°Р»С‘РЅ')
								dispatchTimingHubChanged()
								load()
							}}
						>
							<button type="button" className="tpl-btn tpl-btn--danger tpl-table__mobileActionBtn">
								РЈРґР°Р»РёС‚СЊ
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
							placeholder='РџРѕРёСЃРє РїРѕ РЅР°Р·РІР°РЅРёСЋ Рё С‚РµРєСЃС‚СѓвЂ¦'
							value={search}
							onChange={e => setSearch(e.target.value)}
						/>
					</div>
				</div>

				<div className='tpl__content'>
					<div className='tpl__left'>
						<div className='tpl-card' style={{ marginBottom: 12 }}>
							<div className='tpl-card__badges'>
								<span className='tpl-badge neutral'>РЁР°Р±Р»РѕРЅРѕРІ РІСЃРµРіРѕ: {totals.templatesTotal}</span>
								<span className='tpl-badge neutral'>РЁР°Р±Р»РѕРЅРѕРІ СЃ РіСЂСѓРїРїР°РјРё: {totals.templatesWithGroupsSelected}</span>
							</div>
						</div>
						{filtered.length === 0 ? (
							<div className='tpl-empty'>
								<div className='tpl-empty__title'>
									{loading
										? 'Р—Р°РіСЂСѓР¶Р°СЋ С€Р°Р±Р»РѕРЅС‹вЂ¦'
										: search.trim()
										? 'РќРёС‡РµРіРѕ РЅРµ РЅР°С€Р»РѕСЃСЊ'
										: 'РџРѕРєР° РЅРµС‚ С€Р°Р±Р»РѕРЅРѕРІ'}
								</div>
								<div className='tpl-empty__text'>
									{loading
										? 'РС‰Сѓ РІР°С€Рё С€Р°Р±Р»РѕРЅС‹, СЌС‚Рѕ РјРѕР¶РµС‚ Р·Р°РЅСЏС‚СЊ РЅРµСЃРєРѕР»СЊРєРѕ СЃРµРєСѓРЅРґ.'
										: search.trim()
										? 'РџРѕРїСЂРѕР±СѓР№С‚Рµ РёР·РјРµРЅРёС‚СЊ С‚РµРєСЃС‚ РїРѕРёСЃРєР° РёР»Рё СЃРЅСЏС‚СЊ С„РёР»СЊС‚СЂ СЃС‚Р°С‚СѓСЃР°.'
										: 'РќР°Р¶РјРёС‚Рµ В«РЎРѕР·РґР°С‚СЊ С€Р°Р±Р»РѕРЅВ», С‡С‚РѕР±С‹ РґРѕР±Р°РІРёС‚СЊ РїРµСЂРІС‹Р№.'}
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
															<span className='tpl-card__label'>РќР°Р·РІР°РЅРёРµ</span>
															<span className='tpl-card__label'>РўРµРєСЃС‚ СЃРѕРѕР±С‰РµРЅРёСЏ</span>
														</div>
														<div className='tpl-card__contentRow'>
															<div className='tpl-card__title'>
																{row.title?.trim() ? row.title : 'РЁР°Р±Р»РѕРЅ'}
															</div>
															<div
																className='tpl-card__textBox'
																dangerouslySetInnerHTML={{
																	__html: row.text?.trim()
																		? markdownToHtml(row.text)
																		: 'РўРµРєСЃС‚ С€Р°Р±Р»РѕРЅР°',
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
																title='РћС‚РєСЂС‹С‚СЊ РІ РїРѕР»РЅРѕРј СЂР°Р·РјРµСЂРµ / Р·Р°РїСѓСЃС‚РёС‚СЊ'
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
																		alt='РџСЂРµРІСЊСЋ РјРµРґРёР°'
																	/>
																)}
															</button>
														</div>
													) : null}
												</div>

												<div className='tpl-card__actions'>
													<div className='tpl-card__buttonsRow'>
														<button
															className='tpl-btn tpl-btn--wide'
															onClick={() => {
																loader.show('РћС‚РєСЂС‹РІР°РµРј С€Р°Р±Р»РѕРЅвЂ¦')
																router.push(`/dashboard/templates/${row.id}`)
															}}
														>
															Р РµРґР°РєС‚РёСЂРѕРІР°С‚СЊ
														</button>

														<Popconfirm
															title='РЈРґР°Р»РёС‚СЊ С€Р°Р±Р»РѕРЅ?'
															description='РџРѕСЃР»Рµ СѓРґР°Р»РµРЅРёСЏ РІРѕСЃСЃС‚Р°РЅРѕРІРёС‚СЊ РЅРµР»СЊР·СЏ.'
															okText='РЈРґР°Р»РёС‚СЊ'
															cancelText='РћС‚РјРµРЅР°'
															onConfirm={async () => {
																const res: any = await apiPost('/templates/delete', {
																	templateId: row.id,
																})
																if (!res?.success) {
																	message.error(
																		`РћС€РёР±РєР° СѓРґР°Р»РµРЅРёСЏ: ${res?.message || 'unknown'}`
																	)
																	return
																}
																message.success('РЁР°Р±Р»РѕРЅ СѓРґР°Р»РµРЅ')
																dispatchTimingHubChanged()
																load()
															}}
														>
															<button className='tpl-btn tpl-btn--wide tpl-btn--danger'>
																РЈРґР°Р»РёС‚СЊ
															</button>
														</Popconfirm>
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
			{/* РљРѕРЅС‚РµРєСЃС‚РЅРѕРµ РјРµРЅСЋ РїРѕ РџРљРњ РЅР° РєР°СЂС‚РѕС‡РєРµ */}
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
						<div className='tpl-context-menu__section-title'>РЁР°Р±Р»РѕРЅ</div>
						<button
							type='button'
							className='tpl-context-menu__item'
							onClick={() => {
								setContextMenu(null)
								loader.show('РћС‚РєСЂС‹РІР°РµРј С€Р°Р±Р»РѕРЅвЂ¦')
								router.push(`/dashboard/templates/${contextMenu.row.id}`)
							}}
						>
							<span className='tpl-context-menu__icon'>вњЏпёЏ</span>
							РР·РјРµРЅРёС‚СЊ С€Р°Р±Р»РѕРЅ
						</button>
						<button
							type='button'
							className='tpl-context-menu__item'
							onClick={() => {
								setContextMenu(null)
								window.open(`/dashboard/templates/${contextMenu.row.id}`, '_blank', 'noopener,noreferrer')
							}}
						>
							<span className='tpl-context-menu__icon'>в†—</span>
							РћС‚РєСЂС‹С‚СЊ РІ РЅРѕРІРѕР№ РІРєР»Р°РґРєРµ
						</button>
					</div>
					<div className='tpl-context-menu__separator' />
					<div className='tpl-context-menu__section'>
						<div className='tpl-context-menu__section-title'>Р Р°СЃСЃС‹Р»РєРё</div>
						<button
							type='button'
							className='tpl-context-menu__item'
							onClick={() => {
								setContextMenu(null)
								loader.show('Рљ СЂР°СЃСЃС‹Р»РєР°РјвЂ¦')
								router.push('/dashboard/campaigns')
							}}
						>
							<span className='tpl-context-menu__icon'>рџ“¤</span>
							Рљ СЂР°СЃСЃС‹Р»РєР°Рј
						</button>
					</div>
					<div className='tpl-context-menu__separator' />
					<Popconfirm
						title='РЈРґР°Р»РёС‚СЊ С€Р°Р±Р»РѕРЅ?'
						description='РџРѕСЃР»Рµ СѓРґР°Р»РµРЅРёСЏ РІРѕСЃСЃС‚Р°РЅРѕРІРёС‚СЊ РЅРµР»СЊР·СЏ.'
						okText='РЈРґР°Р»РёС‚СЊ'
						cancelText='РћС‚РјРµРЅР°'
						onConfirm={async () => {
							const templateId = deleteTargetRef.current
							deleteTargetRef.current = null
							setContextMenu(null)
							if (!templateId) return message.error('РќРµС‚ templateId')
							const res: any = await apiPost('/templates/delete', {
								templateId,
							})
							if (!res?.success) {
								message.error(`РћС€РёР±РєР° СѓРґР°Р»РµРЅРёСЏ: ${res?.message || 'unknown'}`)
								return
							}
							message.success('РЁР°Р±Р»РѕРЅ СѓРґР°Р»С‘РЅ')
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
							<span className='tpl-context-menu__icon'>рџ—‘</span>
							РЈРґР°Р»РёС‚СЊ С€Р°Р±Р»РѕРЅ
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
