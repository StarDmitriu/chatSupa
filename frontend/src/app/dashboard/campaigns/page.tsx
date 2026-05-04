'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Button, message, Tag, Segmented, Popover, Tooltip, TimePicker, Switch } from 'antd'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost } from '@/lib/api'
import { ChannelIcon } from '@/components/ChannelIcon'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'
import { readTimingStartMode, writeTimingStartMode } from '@/components/timingHubSession'
import { estimateCampaignFinishAt, formatCampaignFinishAt } from '@/lib/campaignFinishEstimate'
import { LS_KEY_CAMPAIGN_ADV, LS_KEY_CAMPAIGN_TIME_WINDOW, readLocalWaveSettings } from '@/lib/campaignWaveLocal'
import type { AdvSettings } from '@/lib/campaignCapacity'
import Cookies from 'js-cookie'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { useBackendSWR } from '@/lib/useBackendSWR'
import './page.css'

type ActiveAllResp =
	| {
			success: true
			wa: null | { campaignId: string }
			tg: null | { campaignId: string }
	  }
	| { success: false; message: string; error?: unknown }

type CampaignListItem = {
	id: string
	status: string
	channel: string
	created_at: string
}

type PauseStateResp =
	| { success: true; paused: boolean; reason?: string | null; campaignId?: string | null }
	| { success: false; message: string; error?: unknown }

type Job = {
	id: string
	status: 'pending' | 'processing' | 'sent' | 'failed' | 'skipped' | 'paused'
	scheduled_at: string
	sent_at: string | null
}

type ProgressOk = {
	success: true
	campaignId: string
	done: boolean
	jobs: Job[]
}

function readSavedWindow(): { timeFrom: string; timeTo: string } {
	const w = readLocalWaveSettings()
	return { timeFrom: w.timeFrom, timeTo: w.timeTo }
}

function readSavedAdvSettings(): AdvSettings {
	return readLocalWaveSettings().adv
}

function hmToDayjsValue(s: string) {
	const [hRaw, mRaw] = String(s || '').split(':')
	const h = Number(hRaw)
	const m = Number(mRaw)
	if (!Number.isFinite(h) || !Number.isFinite(m)) return null
	// antd TimePicker РѕР¶РёРґР°РµС‚ dayjs-РѕР±СЉРµРєС‚, РЅРѕ Сѓ РЅР°СЃ СѓР¶Рµ РµСЃС‚СЊ dayjs РІ Р·Р°РІРёСЃРёРјРѕСЃС‚Рё РїСЂРѕРµРєС‚Р° С‡РµСЂРµР· antd.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const dayjs = require('dayjs')
	return dayjs().hour(h).minute(m).second(0).millisecond(0)
}

export default function CampaignsHomePage() {
	const router = useRouter()
	const [loading, setLoading] = useState(false)

	const [waCampaignId, setWaCampaignId] = useState<string>('')
	const [tgCampaignId, setTgCampaignId] = useState<string>('')
	const [waPaused, setWaPaused] = useState(false)
	const [tgPaused, setTgPaused] = useState(false)
	const [waPauseReason, setWaPauseReason] = useState<string | null>(null)
	const [tgPauseReason, setTgPauseReason] = useState<string | null>(null)
	const [waSelectedCount, setWaSelectedCount] = useState(0)
	const [tgSelectedCount, setTgSelectedCount] = useState(0)
	const [waConnected, setWaConnected] = useState<boolean | null>(null)
	const [tgConnected, setTgConnected] = useState<boolean | null>(null)
	const [templatesCount, setTemplatesCount] = useState(0)
	const [loadingStats, setLoadingStats] = useState(false)

	const [startMode, setStartMode] = useState<'both' | 'wa' | 'tg'>('both')
	const [waFinishAt, setWaFinishAt] = useState<number | null>(null)
	const [tgFinishAt, setTgFinishAt] = useState<number | null>(null)

	// вњ… Р’РђР–РќРћ: РЅР° РїРµСЂРІРѕРј СЂРµРЅРґРµСЂРµ СЃС‚Р°РІРёРј Р”Р•Р¤РћР›Рў (С‡С‚РѕР±С‹ СЃРѕРІРїР°Р»Рѕ СЃ SSR)
	const [{ timeFrom, timeTo }, setTimeWindow] = useState({
		timeFrom: '00:00',
		timeTo: '23:59',
	})

	// вњ… С„Р»Р°Рі, С‡С‚Рѕ РјС‹ СѓР¶Рµ РЅР° РєР»РёРµРЅС‚Рµ (РїРѕСЃР»Рµ mount)
	const [mounted, setMounted] = useState(false)

	const [adv, setAdv] = useState<AdvSettings>({ repeatEnabled: true })

	const loader = useGlobalLoader()
	const skipSaveTimeRef = useRef(false)
	const skipSaveAdvRef = useRef(false)

	// вњ… РїРѕСЃР»Рµ mount С‡РёС‚Р°РµРј localStorage Рё РїСЂРёРјРµРЅСЏРµРј (РѕРґРёРЅ СЂР°Р·)
	useEffect(() => {
		setMounted(true)
		try {
			const saved = readSavedWindow()
			setTimeWindow(saved)
		} catch {
			// ignore
		}

		try {
			const a = readSavedAdvSettings()
			setAdv(a)
		} catch {
			// ignore
		}

		setStartMode(readTimingStartMode())
	}, [])

	// вњ… СЃРѕС…СЂР°РЅСЏРµРј Р»СЋР±С‹Рµ РёР·РјРµРЅРµРЅРёСЏ (С‚РѕР»СЊРєРѕ РєРѕРіРґР° СѓР¶Рµ mounted)
	useEffect(() => {
		if (!mounted) return
		if (skipSaveTimeRef.current) {
			skipSaveTimeRef.current = false
			return
		}
		try {
			localStorage.setItem(LS_KEY_CAMPAIGN_TIME_WINDOW, JSON.stringify({ timeFrom, timeTo }))
			window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
		} catch {
			// ignore
		}
	}, [mounted, timeFrom, timeTo])

	useEffect(() => {
		if (!mounted) return
		if (skipSaveAdvRef.current) {
			skipSaveAdvRef.current = false
			return
		}
		try {
			localStorage.setItem(LS_KEY_CAMPAIGN_ADV, JSON.stringify(adv))
			window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
		} catch {
			// ignore
		}
	}, [mounted, adv])

	// вњ… СЃРёРЅС…СЂРѕРЅРёР·РёСЂСѓРµРј РЅР°СЃС‚СЂРѕР№РєРё РёР· РїСЂР°РІРѕР№ РїР°РЅРµР»Рё (TimingHubDrawer)
	useEffect(() => {
		if (!mounted) return

		const onChanged = (_evt: Event) => {
			void _evt
			try {
				skipSaveTimeRef.current = true
				const saved = readSavedWindow()
				setTimeWindow(saved)
			} catch {
				// ignore
			}

			try {
				skipSaveAdvRef.current = true
				const a = readSavedAdvSettings()
				setAdv(a)
			} catch {
				// ignore
			}
		}

		const onStartModeSync = () => setStartMode(readTimingStartMode())
		window.addEventListener(TIMING_HUB_CHANGED_EVENT, onChanged)
		window.addEventListener(TIMING_HUB_CHANGED_EVENT, onStartModeSync)
		window.addEventListener('storage', onStartModeSync)
		return () => {
			window.removeEventListener(TIMING_HUB_CHANGED_EVENT, onChanged)
			window.removeEventListener(TIMING_HUB_CHANGED_EVENT, onStartModeSync)
			window.removeEventListener('storage', onStartModeSync)
		}
	}, [mounted])

	const { data: activeData, mutate: mutateActive } = useBackendSWR<ActiveAllResp>('campaigns/active')

	useEffect(() => {
		if (activeData?.success) {
			setWaCampaignId(activeData.wa?.campaignId || '')
			setTgCampaignId(activeData.tg?.campaignId || '')
		}
	}, [activeData])

	// вЂњР’Рѕ СЃРєРѕР»СЊРєРѕ Р·Р°РєРѕРЅС‡РёС‚СЃСЏвЂќ РґР»СЏ Р°РєС‚РёРІРЅС‹С… СЂР°СЃСЃС‹Р»РѕРє
	useEffect(() => {
		let cancelled = false
		let t: number | null = null

		const loadFinish = async () => {
			try {
				const waId = String(waCampaignId || '').trim()
				const tgId = String(tgCampaignId || '').trim()

				const [waProg, tgProg] = await Promise.all([
					waId ? (apiGet(`/campaigns/${waId}/progress`) as Promise<any>) : Promise.resolve(null),
					tgId ? (apiGet(`/campaigns/${tgId}/progress`) as Promise<any>) : Promise.resolve(null),
				])

				if (cancelled) return

			let didRefreshActive = false

				if (waProg?.success) {
					const p = waProg as ProgressOk
					setWaFinishAt(estimateCampaignFinishAt(p.jobs, !!p.done))
				// 'done' РѕР±С‹С‡РЅРѕ СЃРѕРІРїР°РґР°РµС‚ СЃ Р»РѕРіРёС‡РµСЃРєРёРј Р·Р°РІРµСЂС€РµРЅРёРµРј, РЅРѕ РЅР° РїСЂР°РєС‚РёРєРµ
				// РїСЂРё Р°РІС‚Рѕ-РѕСЃС‚Р°РЅРѕРІРєРµ РёРЅРѕРіРґР° СѓРґРѕР±РЅРµРµ РѕСЂРёРµРЅС‚РёСЂРѕРІР°С‚СЊСЃСЏ РµС‰С‘ Рё РЅР° РѕС‚СЃСѓС‚СЃС‚РІРёРµ
				// pending/processing Р·Р°РґР°С‡.
				if (
					p.done ||
					(p.jobs?.length ?? 0) > 0 &&
						!p.jobs.some((j) => j.status === 'pending' || j.status === 'processing')
				) {
					didRefreshActive = true
				}
				} else {
					setWaFinishAt(null)
				}
				if (tgProg?.success) {
					const p = tgProg as ProgressOk
					setTgFinishAt(estimateCampaignFinishAt(p.jobs, !!p.done))
				if (
					p.done ||
					(p.jobs?.length ?? 0) > 0 &&
						!p.jobs.some((j) => j.status === 'pending' || j.status === 'processing')
				) {
					didRefreshActive = true
				}
				} else {
					setTgFinishAt(null)
				}

			// Р•СЃР»Рё РІРѕСЂРєРµСЂ СѓР¶Рµ РѕС‚РјРµС‚РёР» СЂР°СЃСЃС‹Р»РєСѓ РєР°Рє Р·Р°РІРµСЂС€С‘РЅРЅСѓСЋ вЂ” РїРѕРґРіСЂСѓР¶Р°РµРј /campaigns/active,
			// С‡С‚РѕР±С‹ iframe-РїСЂРѕРіСЂРµСЃСЃ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РёСЃС‡РµР· Р±РµР· refresh.
			if (didRefreshActive) loadActive()
			} catch {
				// ignore
			}
		}

		void loadFinish()
		t = window.setInterval(loadFinish, 5000)
		return () => {
			cancelled = true
			if (t) window.clearInterval(t)
		}
	}, [waCampaignId, tgCampaignId])

	const loadActive = () => mutateActive()

	const loadPauseState = async () => {
		try {
			const [wa, tg] = await Promise.all([
				apiGet(`/campaigns/pause-state/wa`) as Promise<PauseStateResp>,
				apiGet(`/campaigns/pause-state/tg`) as Promise<PauseStateResp>,
			])

			if (wa?.success) {
				setWaPaused(!!wa.paused)
				setWaPauseReason(wa.reason ? String(wa.reason) : null)
			}
			if (tg?.success) {
				setTgPaused(!!tg.paused)
				setTgPauseReason(tg.reason ? String(tg.reason) : null)
			}
		} catch (e) {
			console.warn('pause-state load failed', e)
		}
	}

	const loadStats = async () => {
		setLoadingStats(true)
		try {
			const token = Cookies.get('token') || ''
			const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
			
			const meRes = await fetch(`${backendUrl}/auth/me`, {
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
			})
			const meData = await meRes.json()
			if (!meData?.success || !meData?.user?.id) return
			
			const userId = meData.user.id
			
			// РЎС‡РёС‚Р°РµРј РІС‹Р±СЂР°РЅРЅС‹Рµ РіСЂСѓРїРїС‹ Рё С€Р°Р±Р»РѕРЅС‹ С‡РµСЂРµР· count API (Р±РµР· РїР°РіРёРЅР°С†РёРё)
			const [waCountRes, tgCountRes, templatesRes, waInfoRes, tgQrRes] = await Promise.all([
				fetch(`${backendUrl}/whatsapp/groups/${userId}/count`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }),
				fetch(`${backendUrl}/telegram/groups/${userId}/count`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }),
				fetch(`${backendUrl}/templates/list/${userId}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }),
				fetch(`${backendUrl}/whatsapp/account-info/${userId}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }),
				fetch(`${backendUrl}/telegram/qr/status/${userId}?_=${Date.now()}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }),
			])
			
			const waCountData = await waCountRes.json()
			const tgCountData = await tgCountRes.json()
			const templatesData = await templatesRes.json()
			const waInfoData = await waInfoRes.json()
			const tgQrData = await tgQrRes.json()
			
			if (waCountData?.success && typeof waCountData.selected === 'number') {
				setWaSelectedCount(waCountData.selected)
			}
			if (tgCountData?.success && typeof tgCountData.selected === 'number') {
				setTgSelectedCount(tgCountData.selected)
			}
			setWaConnected(waInfoData?.success ? (waInfoData.connected === true) : false)
			// РЎРёРЅС…СЂРѕРЅРёР·РёСЂРѕРІР°РЅРѕ СЃ TelegramQrConnect: "РїРѕРґРєР»СЋС‡С‘РЅ" С‚РѕР»СЊРєРѕ РєРѕРіРґР° qr/status СЂРµР°Р»СЊРЅРѕ connected.
			setTgConnected(tgQrData?.success && tgQrData?.status === 'connected')
			if (templatesData?.success) {
				const rows = (templatesData.templates || []) as { enabled?: boolean }[]
				const enabledList = rows.filter((t) => t && t.enabled !== false)
				setTemplatesCount(enabledList.length)
			}
		} catch (e) {
			console.error(e)
		} finally {
			setLoadingStats(false)
		}
	}

	// РЎСЂР°Р·Сѓ СЃРЅРёРјР°РµРј РїРѕР»РЅРѕСЌРєСЂР°РЅРЅС‹Р№ loader, РµСЃР»Рё РїРµСЂРµС€Р»Рё СЃ РґСЂСѓРіРѕР№ СЃС‚СЂР°РЅРёС†С‹ (С€Р°Р±Р»РѕРЅС‹, Р°РЅР°Р»РёС‚РёРєР°)
	useEffect(() => {
		loader.hide()
	}, [loader])

	// Р—Р°РіСЂСѓР¶Р°РµРј Р±РµР· РїРѕР»РЅРѕСЌРєСЂР°РЅРЅРѕРіРѕ loader вЂ” СЃС‚СЂР°РЅРёС†Р° РѕС‚РєСЂС‹РІР°РµС‚СЃСЏ СЃСЂР°Р·Сѓ; active РёР· SWR, РѕСЃС‚Р°Р»СЊРЅРѕРµ РїРѕ Р·Р°РїСЂРѕСЃСѓ
	useEffect(() => {
		Promise.all([loadPauseState(), loadStats()]).catch(() => {})
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// РђРІС‚Рѕ-РїРѕРґС‚СЏРіРёРІР°РЅРёРµ СЃС‚Р°С‚СѓСЃР° WA/TG: РїРѕРІС‚РѕСЂ С‡РµСЂРµР· 2 Рё 5 СЃ, РµСЃР»Рё РµС‰С‘ null (РЅР°РїСЂРёРјРµСЂ, РїРµСЂРІС‹Р№ Р·Р°РїСЂРѕСЃ Р±С‹Р» РјРµРґР»РµРЅРЅС‹Р№ РёР»Рё РїРѕСЃР»Рµ РІРѕР·РІСЂР°С‚Р° РёР· РєР°Р±РёРЅРµС‚Р°)
	useEffect(() => {
		const t1 = setTimeout(() => {
			if (waConnected === null || tgConnected === null) loadStats()
		}, 2000)
		const t2 = setTimeout(() => {
			if (waConnected === null || tgConnected === null) loadStats()
		}, 5000)
		return () => {
			clearTimeout(t1)
			clearTimeout(t2)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [waConnected, tgConnected])

	// РџСЂРё РІРѕР·РІСЂР°С‚Рµ РЅР° РІРєР»Р°РґРєСѓ вЂ” РѕР±РЅРѕРІРёС‚СЊ СЃС‚Р°С‚СѓСЃ РїРѕРґРєР»СЋС‡РµРЅРёР№ Рё РїР°СѓР·С‹ (С‡С‚РѕР±С‹ В«СЃР»РѕРІРёР»РёСЃСЊВ» РїРѕСЃР»Рµ РєР°Р±РёРЅРµС‚Р°)
	useEffect(() => {
		const onFocus = () => {
			loadPauseState()
			loadStats()
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
	}, [])

	const isPaywallReason = (code: string | null) =>
		code === 'no_subscription' ||
		code === 'trial_expired' ||
		code === 'subscription_expired' ||
		code === 'plan_not_allowed' ||
		code === 'no_access'

	const progressUrl = useMemo(() => {
		const qs = new URLSearchParams()
		if (waCampaignId) qs.set('wa', waCampaignId)
		if (tgCampaignId) qs.set('tg', tgCampaignId)
		const q = qs.toString()
		if (!q) return ''
		// Р’РЅСѓС‚СЂРё iframe РЅРµ РЅСѓР¶РЅР° РїРѕРІС‚РѕСЂРЅР°СЏ С€Р°РїРєР° РґР°С€Р±РѕСЂРґР°.
		qs.set('embed', '1')
		return `/dashboard/campaign?${qs.toString()}`
	}, [waCampaignId, tgCampaignId])

	type StartMultiResponse = {
		success?: boolean
		message?: string
		campaignId?: string
		alreadyRunning?: boolean
	}

	const startOne = async (
		channel: 'wa' | 'tg',
		payload: { timeFrom: string; timeTo: string; adv: AdvSettings },
	) => {
		const repOn = !!payload.adv.repeatEnabled
		const data = (await apiPost('/campaigns/start-multi', {
			timeFrom: payload.timeFrom,
			timeTo: payload.timeTo,
			repeatEnabled: repOn,
			repeatScheduleKind: repOn ? 'next_day' : undefined,
			betweenGroupsScaleTemplate: true,
			channel,
		})) as StartMultiResponse

		if (!data || !data.success) {
			// РџСЂРѕР±СЂР°СЃС‹РІР°РµРј РєРѕРґ РѕС€РёР±РєРё, С‡С‚РѕР±С‹ РЅРёР¶Рµ РјРѕР¶РЅРѕ Р±С‹Р»Рѕ РїРѕРєР°Р·Р°С‚СЊ С‡РµР»РѕРІРµРєРѕвЂ‘С‡РёС‚Р°РµРјРѕРµ СЃРѕРѕР±С‰РµРЅРёРµ.
			const code = String(data?.message || 'start_failed')
			throw new Error(code)
		}

		const cid = String(data.campaignId || '').trim()
		if (!cid) throw new Error('campaignId_empty')

		return { cid, alreadyRunning: !!data.alreadyRunning }
	}

	const startSelected = async () => {
		// Р“Р°СЂР°РЅС‚РёСЂСѓРµРј, С‡С‚Рѕ СЃС‚Р°СЂС‚РѕРІС‹Рµ РїР°СЂР°РјРµС‚СЂС‹ РІСЃРµРіРґР° СЃРѕРІРїР°РґР°СЋС‚ СЃ С‚РµРј, С‡С‚Рѕ СЃРµР№С‡Р°СЃ РЅР° СЌРєСЂР°РЅРµ:
		// СЃРёРЅС…СЂРѕРЅРЅРѕ РїРёС€РµРј РІ localStorage, Р° Р·Р°С‚РµРј С‡РёС‚Р°РµРј РѕР±СЂР°С‚РЅРѕ.
		if (mounted) {
			try {
				localStorage.setItem(LS_KEY_CAMPAIGN_TIME_WINDOW, JSON.stringify({ timeFrom, timeTo }))
				localStorage.setItem(LS_KEY_CAMPAIGN_ADV, JSON.stringify(adv))
			} catch {
				// ignore
			}
		}

		// РќР° СЃР»СѓС‡Р°Р№ РѕС‡РµРЅСЊ Р±С‹СЃС‚СЂРѕРіРѕ РєР»РёРєР° РїРѕСЃР»Рµ РїСЂР°РІРѕРє (drawer / РїРѕР»Р·СѓРЅРєРё) вЂ” РїРµСЂРµС‡РёС‚Р°РµРј РёР· localStorage.
		let payload = { timeFrom, timeTo, adv }
		try {
			payload = { ...readSavedWindow(), adv: readSavedAdvSettings() }
		} catch {
			// ignore
		}

		setLoading(true)
		loader.show('Р—Р°РїСѓСЃРєР°РµРј СЂР°СЃСЃС‹Р»РєСѓвЂ¦')
		try {
			if (startMode === 'wa') {
				const wa = await startOne('wa', payload)
				setWaCampaignId(wa.cid)
				message.success(wa.alreadyRunning ? 'WA СѓР¶Рµ Р·Р°РїСѓС‰РµРЅР°' : 'WA Р·Р°РїСѓС‰РµРЅР°')
				loadActive()
				loadPauseState()
				loadStats()
				return
			}

			if (startMode === 'tg') {
				const tg = await startOne('tg', payload)
				setTgCampaignId(tg.cid)
				message.success(tg.alreadyRunning ? 'TG СѓР¶Рµ Р·Р°РїСѓС‰РµРЅР°' : 'TG Р·Р°РїСѓС‰РµРЅР°')
				loadActive()
				loadPauseState()
				loadStats()
				return
			}

			const wa = await startOne('wa', payload)
			const tg = await startOne('tg', payload)

			setWaCampaignId(wa.cid)
			setTgCampaignId(tg.cid)

			message.success('Р—Р°РїСѓС‰РµРЅС‹ WA + TG')
			loadActive()
			loadPauseState()
			loadStats()
		} catch (e: unknown) {
			console.error(e)
			const msg = e instanceof Error ? e.message : 'unknown'

			const mapErrorMessage = (code: string): string => {
				switch (code) {
					case 'no_groups':
						return 'РќРµС‚ РІС‹Р±СЂР°РЅРЅС‹С… РіСЂСѓРїРї РґР»СЏ СЂР°СЃСЃС‹Р»РєРё. Р—Р°Р№РґРёС‚Рµ РІ СЂР°Р·РґРµР» РіСЂСѓРїРї WA/TG, РѕС‚РјРµС‚СЊС‚Рµ РЅСѓР¶РЅС‹Рµ РіСЂСѓРїРїС‹ Рё РїРѕРїСЂРѕР±СѓР№С‚Рµ СЃРЅРѕРІР°.'
					case 'no_templates':
						return 'РќРµС‚ РІРєР»СЋС‡С‘РЅРЅС‹С… С€Р°Р±Р»РѕРЅРѕРІ СЃРѕРѕР±С‰РµРЅРёР№. Р”РѕР±Р°РІСЊС‚Рµ Рё РІРєР»СЋС‡РёС‚Рµ С…РѕС‚СЏ Р±С‹ РѕРґРёРЅ С€Р°Р±Р»РѕРЅ РІ СЂР°Р·РґРµР»Рµ В«РЁР°Р±Р»РѕРЅС‹В».'
					case 'no_targets_for_templates':
						return 'Р”Р»СЏ РІРєР»СЋС‡С‘РЅРЅС‹С… С€Р°Р±Р»РѕРЅРѕРІ РЅРµ РІС‹Р±СЂР°РЅС‹ РіСЂСѓРїРїС‹-РїРѕР»СѓС‡Р°С‚РµР»Рё. РћС‚РєСЂРѕР№С‚Рµ С€Р°Р±Р»РѕРЅС‹, РІРѕ РІРєР»Р°РґРєР°С… WA Рё TG РѕС‚РјРµС‚СЊС‚Рµ РіСЂСѓРїРїС‹ Рё РїРѕРїСЂРѕР±СѓР№С‚Рµ СЃРЅРѕРІР°.'
					case 'template_between_groups_required':
						return 'РЈ С€Р°Р±Р»РѕРЅР°, РєРѕС‚РѕСЂС‹Р№ СѓС‡Р°СЃС‚РІСѓРµС‚ РІ СЂР°СЃСЃС‹Р»РєРµ, РЅРµ Р·Р°РґР°РЅ РёРЅС‚РµСЂРІР°Р» В«РїР°СѓР·Р° РјРµР¶РґСѓ РіСЂСѓРїРїР°РјРёВ» РґР»СЏ СЌС‚РѕРіРѕ РєР°РЅР°Р»Р° (WA РёР»Рё TG). РћС‚РєСЂРѕР№С‚Рµ С€Р°Р±Р»РѕРЅ РІ СЂР°Р·РґРµР»Рµ В«РЁР°Р±Р»РѕРЅС‹В», РІС‹СЃС‚Р°РІСЊС‚Рµ РїРѕР»Р·СѓРЅРєРё РїР°СѓР·С‹ Рё СЃРѕС…СЂР°РЅРёС‚Рµ. Р•СЃР»Рё РЅРµРґР°РІРЅРѕ РґРѕР±Р°РІР»СЏР»Рё С€Р°Р±Р»РѕРЅС‹ РёР· С‚Р°Р±Р»РёС†С‹ вЂ” РІС‹РїРѕР»РЅРёС‚Рµ SQL РјРёРіСЂР°С†РёСЋ РєРѕР»РѕРЅРѕРє РїР°СѓР· РІ Supabase.'
					case 'no_jobs':
						return 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃС„РѕСЂРјРёСЂРѕРІР°С‚СЊ Р·Р°РґР°С‡Рё СЂР°СЃСЃС‹Р»РєРё. РџСЂРѕРІРµСЂСЊС‚Рµ, С‡С‚Рѕ РµСЃС‚СЊ РІРєР»СЋС‡С‘РЅРЅС‹Рµ С€Р°Р±Р»РѕРЅС‹ Рё РІС‹Р±СЂР°РЅРЅС‹Рµ РіСЂСѓРїРїС‹ РґР»СЏ WA/TG.'
					case 'supabase_campaign_insert_error':
						return 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕР·РґР°С‚СЊ РєР°РјРїР°РЅРёСЋ РІ Р±Р°Р·Рµ. Р’ Supabase в†’ SQL Editor РІС‹РїРѕР»РЅРёС‚Рµ СЃРєСЂРёРїС‚ backend/migrations/fix_campaigns_start_multi_supabase.sql (РёР»Рё РѕР±РЅРѕРІР»С‘РЅРЅС‹Р№ Р±Р»РѕРє campaigns РІ backend/migrations/RUN_IN_SUPABASE.sql), Р·Р°С‚РµРј СЃРЅРѕРІР° РЅР°Р¶РјРёС‚Рµ В«Р—Р°РїСѓСЃС‚РёС‚СЊВ».'
					case 'whatsapp_not_connected':
					case 'wa_not_connected':
						return 'WhatsApp РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ. РџРѕРґРєР»СЋС‡РёС‚Рµ WhatsApp РІ Р»РёС‡РЅРѕРј РєР°Р±РёРЅРµС‚Рµ.'
					case 'telegram_not_connected':
					case 'tg_not_connected':
						return 'Telegram РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ. РџРѕРґРєР»СЋС‡РёС‚Рµ Telegram РІ Р»РёС‡РЅРѕРј РєР°Р±РёРЅРµС‚Рµ.'
					case 'waiting_reconnect':
						return 'РљР°РЅР°Р» РІСЂРµРјРµРЅРЅРѕ РЅРµ РІ СЃРѕСЃС‚РѕСЏРЅРёРё open/connected. РљР°РјРїР°РЅРёСЏ РїРѕСЃС‚Р°РІР»РµРЅР° РІ РѕР¶РёРґР°РЅРёРµ РїРµСЂРµРїРѕРґРєР»СЋС‡РµРЅРёСЏ.'
					default:
						return `РћС€РёР±РєР° СЃС‚Р°СЂС‚Р°: ${code}`
				}
			}
			if (
				msg === 'no_subscription' ||
				msg === 'no_access' ||
				msg === 'trial_expired' ||
				msg === 'subscription_expired' ||
				msg === 'plan_not_allowed'
			) {
				message.error({
					content: (
						<span>
							Р”Р»СЏ Р·Р°РїСѓСЃРєР° СЂР°СЃСЃС‹Р»РєРё РЅСѓР¶РЅР° Р°РєС‚РёРІРЅР°СЏ РїРѕРґРїРёСЃРєР° РёР»Рё РїСЂРѕР±РЅС‹Р№ РїРµСЂРёРѕРґ.{' '}
							<Button
								type='link'
								size='small'
								style={{ padding: 0, height: 'auto' }}
								onClick={() => router.push('/cabinet/subscription')}
							>
								РћС„РѕСЂРјРёС‚СЊ РїРѕРґРїРёСЃРєСѓ РёР»Рё РЅР°С‡Р°С‚СЊ РїСЂРѕР±РЅС‹Р№ РїРµСЂРёРѕРґ в†’
							</Button>
						</span>
					),
					duration: 8,
				})
			} else if (
				msg === 'whatsapp_not_connected' ||
				msg === 'wa_not_connected' ||
				msg === 'telegram_not_connected' ||
				msg === 'tg_not_connected'
			) {
				const isWa = msg === 'whatsapp_not_connected' || msg === 'wa_not_connected'
				message.error({
					content: (
						<span>
							{mapErrorMessage(msg)}{' '}
							<Button
								type='link'
								size='small'
								style={{ padding: 0, height: 'auto' }}
								onClick={() => router.push(isWa ? '/cabinet#whatsapp' : '/cabinet#telegram')}
							>
								РџРµСЂРµР№С‚Рё Рє РїРѕРґРєР»СЋС‡РµРЅРёСЋ в†’
							</Button>
						</span>
					),
					duration: 8,
				})
			} else {
				message.error(mapErrorMessage(msg))
			}
		} finally {
			setLoading(false)
			loader.hide()
		}
	}

	const stopOne = async (cid: string) => {
		const json: any = await apiPost(`/campaigns/${cid}/stop`)
		if (!json?.success) throw new Error(json?.message || 'stop_failed')
	}

	const requeueOne = async (
		cid: string,
		mode: 'failed_pending' | 'pending_only',
		label: string,
	) => {
		setLoading(true)
		try {
			const statuses =
				mode === 'failed_pending' ? ['failed', 'pending'] : ['pending']
			const json: any = await apiPost(`/campaigns/${cid}/requeue`, {
				forceNow: true,
				statuses,
			})
			if (!json?.success) throw new Error(json?.message || 'requeue_failed')
			const n = Number(json?.enqueued ?? 0)
			message.success(
				`${label}: РїРµСЂРµР·Р°РїСѓС‰РµРЅРѕ ${n} Р·Р°РґР°С‡ (${statuses.join('+')}).`,
			)
			loadActive()
		} catch (e: any) {
			console.error(e)
			message.error(`${label}: ${e?.message || 'РќРµ СѓРґР°Р»РѕСЃСЊ РїРµСЂРµР·Р°РїСѓСЃС‚РёС‚СЊ Р·Р°РґР°С‡Рё'}`)
		} finally {
			setLoading(false)
			loader.hide()
		}
	}

	const resumeChannel = async (channel: 'wa' | 'tg') => {
		setLoading(true)
		try {
			const json: any = await apiPost('/campaigns/set-pause', { channel, paused: false })
			if (!json?.success) throw new Error(json?.message || 'set_pause_failed')
			message.success(channel === 'wa' ? 'WA: СЂР°СЃСЃС‹Р»РєР° РїСЂРѕРґРѕР»Р¶РµРЅР°' : 'TG: СЂР°СЃСЃС‹Р»РєР° РїСЂРѕРґРѕР»Р¶РµРЅР°')
			loadActive()
			loadPauseState()
		} catch (e: any) {
			console.error(e)
			message.error(e?.message || 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРЅСЏС‚СЊ РїР°СѓР·Сѓ')
		} finally {
			setLoading(false)
			loader.hide()
		}
	}

	const stopWa = async () => {
		if (!waCampaignId) return
		setLoading(true)
		try {
			await stopOne(waCampaignId)
			message.success('WA РѕСЃС‚Р°РЅРѕРІР»РµРЅР°')
			// РЎСЂР°Р·Сѓ РѕР±РЅСѓР»СЏРµРј finish/iframe-РєР°РЅР°Р», С‡С‚РѕР±С‹ РЅРµ РїРѕРєР°Р·С‹РІР°С‚СЊ "С…РІРѕСЃС‚С‹"
			setWaFinishAt(null)
			setWaCampaignId('')
			await loadActive()
			await loadPauseState()
		} catch (e: any) {
			console.error(e)
			message.error(`WA stop: ${e?.message || 'unknown'}`)
		} finally {
			setLoading(false)
			loader.hide()
		}
	}

	const stopTg = async () => {
		if (!tgCampaignId) return
		setLoading(true)
		try {
			await stopOne(tgCampaignId)
			message.success('TG РѕСЃС‚Р°РЅРѕРІР»РµРЅР°')
			setTgFinishAt(null)
			setTgCampaignId('')
			await loadActive()
			await loadPauseState()
		} catch (e: any) {
			console.error(e)
			message.error(`TG stop: ${e?.message || 'unknown'}`)
		} finally {
			setLoading(false)
		}
	}

	const openProgress = () => {
		const qs = new URLSearchParams()
		if (waCampaignId) qs.set('wa', waCampaignId)
		if (tgCampaignId) qs.set('tg', tgCampaignId)
		router.push(`/dashboard/campaign?${qs.toString()}`)
	}

	const noActiveCampaigns = !tgCampaignId && !waCampaignId

	const disabledActionsCount =
		(tgCampaignId ? 0 : 1) +
		(waCampaignId ? 0 : 1) +
		(waCampaignId || tgCampaignId ? 0 : 1)
	const actionsBadgeColor = disabledActionsCount === 0 ? 'green' : disabledActionsCount === 1 ? 'orange' : 'red'
	const showActionsStatusBadge = !noActiveCampaigns

	return (
		<div className='camp'>
			<div className='camp__wrap'>
				<div className='camp__one'>
					<section className='camp__one-section camp__one-section--summary'>
						<h2 className='camp__sectionTitle'>Р§С‚Рѕ Р±СѓРґРµС‚ РѕС‚РїСЂР°РІР»РµРЅРѕ</h2>
						<div
							style={{
								marginBottom: 12,
								padding: '10px 12px',
								borderRadius: 10,
								border: '1px solid rgba(255,255,255,0.22)',
								background: 'rgba(255,255,255,0.06)',
							}}
						>
							<div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.9 }}>
								РџР°СѓР·С‹ РјРµР¶РґСѓ РѕС‚РїСЂР°РІРєР°РјРё вЂ” РїРѕР»Р·СѓРЅРєРё TG/WA РІ РєР°СЂС‚РѕС‡РєРµ С€Р°Р±Р»РѕРЅР°. РЎРєРѕР»СЊРєРѕ СѓР№РґС‘С‚ РІ РІРѕР»РЅРµ Р·Р°РІРёСЃРёС‚ РѕС‚ РіСЂСѓРїРї,
								РѕС‚РјРµС‡РµРЅРЅС‹С… РІРЅСѓС‚СЂРё РєР°Р¶РґРѕРіРѕ С€Р°Р±Р»РѕРЅР°, Р° РЅРµ РѕС‚ СЃС‡С‘С‚С‡РёРєРѕРІ TG/WA РІС‹С€Рµ (СЌС‚Рѕ РІСЃРµ РІС‹Р±СЂР°РЅРЅС‹Рµ РіСЂСѓРїРїС‹ РєР°РЅР°Р»Р°).
								РўРѕС‡РЅРѕРµ С‡РёСЃР»Рѕ Рё РІСЂРµРјСЏ РѕРєРѕРЅС‡Р°РЅРёСЏ вЂ” РІ В«РџСЂРѕРіСЂРµСЃСЃ СЂР°СЃСЃС‹Р»РєРёВ» РїРѕСЃР»Рµ Р·Р°РїСѓСЃРєР°.
							</div>
						</div>
						<div
							style={{
								display: 'flex',
								flexWrap: 'wrap',
								alignItems: 'center',
								gap: 16,
								marginBottom: 12,
								fontSize: 14,
							}}
						>
							<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
								<span style={{ opacity: 0.88 }}>РћРєРЅРѕ:</span>
								<Popover
									trigger='click'
									overlayClassName='camp__timeWindowPopover'
									content={
										<div className='camp__timeWindowPopContent'>
											<div className='camp__timeWindowPopRow'>
												<div className='camp__timeWindowPopLabel'>РЎ</div>
												<TimePicker
													format='HH:mm'
													minuteStep={1}
													value={mounted ? (hmToDayjsValue(timeFrom) as any) : null}
													onChange={(v) => {
														if (!v) return
														const hh = String((v as any).hour()).padStart(2, '0')
														const mm = String((v as any).minute()).padStart(2, '0')
														setTimeWindow((prev) => ({ ...prev, timeFrom: `${hh}:${mm}` }))
													}}
												/>
											</div>
											<div className='camp__timeWindowPopRow'>
												<div className='camp__timeWindowPopLabel'>Р”Рѕ</div>
												<TimePicker
													format='HH:mm'
													minuteStep={1}
													value={mounted ? (hmToDayjsValue(timeTo) as any) : null}
													onChange={(v) => {
														if (!v) return
														const hh = String((v as any).hour()).padStart(2, '0')
														const mm = String((v as any).minute()).padStart(2, '0')
														setTimeWindow((prev) => ({ ...prev, timeTo: `${hh}:${mm}` }))
													}}
												/>
											</div>
											<div className='camp__timeWindowPopHint'>
												РЎРѕС…СЂР°РЅСЏРµС‚СЃСЏ РІ Р±СЂР°СѓР·РµСЂРµ. Р”Р»СЏ Р°РєС‚РёРІРЅРѕР№ СЂР°СЃСЃС‹Р»РєРё вЂ” СЃС‚РѕРї, Р·Р°С‚РµРј Р·Р°РїСѓСЃРє СЃРЅРѕРІР°.
											</div>
										</div>
									}
								>
									<button type='button' className='camp__timeWindowBtn' aria-label='РР·РјРµРЅРёС‚СЊ РѕРєРЅРѕ СЃСѓС‚РѕРє'>
										{mounted ? `${timeFrom}вЂ”${timeTo}` : '00:00вЂ”23:59'}
									</button>
								</Popover>
							</div>
							<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
								<Switch
									checked={adv.repeatEnabled}
									onChange={(v) => setAdv((a) => ({ ...a, repeatEnabled: v }))}
								/>
								<span style={{ opacity: 0.88 }} title='РЎР»РµРґСѓСЋС‰Р°СЏ РІРѕР»РЅР° вЂ” РЅР° СЃР»РµРґСѓСЋС‰РёР№ РєР°Р»РµРЅРґР°СЂРЅС‹Р№ РґРµРЅСЊ РІ РЅР°С‡Р°Р»Рµ РѕРєРЅР°'>
									Р•Р¶РµРґРЅРµРІРЅРѕ РїРѕРІС‚РѕСЂСЏС‚СЊ СЂР°СЃСЃС‹Р»РєРё
								</span>
							</div>
						</div>
						<div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10, opacity: 0.9 }}>
							<b>{templatesCount}</b> С€Р°Р±Р». В· TG <b>{tgConnected === false ? 0 : tgSelectedCount}</b> В· WA{' '}
							<b>{waConnected === false ? 0 : waSelectedCount}</b>
						</div>
						{/* РџСЂРѕРіСЂРµСЃСЃ РґРѕСЃС‚СѓРїРµРЅ РІ В«Р”РµР№СЃС‚РІРёСЏВ» РІ Р±Р»РѕРєРµ Р·Р°РїСѓСЃРєР° */}
						{(() => {
							const ready =
								templatesCount > 0 &&
								(startMode === 'tg'
									? (tgConnected !== false && tgSelectedCount > 0)
									: startMode === 'wa'
										? (waConnected !== false && waSelectedCount > 0)
										: (tgConnected !== false && tgSelectedCount > 0) && (waConnected !== false && waSelectedCount > 0))
							if (ready) return null
							let warnContent: ReactNode = ''
							if (templatesCount === 0) {
								warnContent = 'Р’РєР»СЋС‡РёС‚Рµ С…РѕС‚СЏ Р±С‹ РѕРґРёРЅ С€Р°Р±Р»РѕРЅ (РєРЅРѕРїРєР° РЁР°Р±Р»РѕРЅС‹ РІ С€Р°РїРєРµ).'
							} else if (startMode === 'both') {
								if (waConnected === false && tgConnected === false) {
									warnContent = <>РџРѕРґРєР»СЋС‡РёС‚Рµ <Link href='/cabinet#whatsapp'>WhatsApp</Link> Рё <Link href='/cabinet#telegram'>Telegram</Link> РІ Р»РёС‡РЅРѕРј РєР°Р±РёРЅРµС‚Рµ.</>
								} else if (waConnected === false) {
									warnContent = <>РџРѕРґРєР»СЋС‡РёС‚Рµ <Link href='/cabinet#whatsapp'>WhatsApp</Link> РІ Р»РёС‡РЅРѕРј РєР°Р±РёРЅРµС‚Рµ.</>
								} else if (tgConnected === false) {
									warnContent = <>РџРѕРґРєР»СЋС‡РёС‚Рµ <Link href='/cabinet#telegram'>Telegram</Link> РІ Р»РёС‡РЅРѕРј РєР°Р±РёРЅРµС‚Рµ.</>
								} else if (waSelectedCount === 0 && tgSelectedCount === 0) {
									warnContent = 'Р”Р»СЏ В«TG + WAВ» РЅСѓР¶РЅС‹ РіСЂСѓРїРїС‹ РІ РѕР±РѕРёС… РєР°РЅР°Р»Р°С… вЂ” РѕС‚РєСЂРѕР№С‚Рµ Р“СЂСѓРїРїС‹ WA Рё Р“СЂСѓРїРїС‹ TG РІ С€Р°РїРєРµ.'
								} else if (waSelectedCount === 0) {
									warnContent = 'Р”РѕР±Р°РІСЊС‚Рµ РіСЂСѓРїРїС‹ WA (РєРЅРѕРїРєР° РІ С€Р°РїРєРµ) РёР»Рё РїРµСЂРµРєР»СЋС‡РёС‚РµСЃСЊ РЅР° В«РўРѕР»СЊРєРѕ TGВ».'
								} else {
									warnContent = 'Р”РѕР±Р°РІСЊС‚Рµ РіСЂСѓРїРїС‹ TG (РєРЅРѕРїРєР° РІ С€Р°РїРєРµ) РёР»Рё РїРµСЂРµРєР»СЋС‡РёС‚РµСЃСЊ РЅР° В«РўРѕР»СЊРєРѕ WAВ».'
								}
							} else if (startMode === 'tg') {
								if (tgConnected === false) {
									warnContent = <>РџРѕРґРєР»СЋС‡РёС‚Рµ <Link href='/cabinet#telegram'>Telegram</Link> РІ Р»РёС‡РЅРѕРј РєР°Р±РёРЅРµС‚Рµ.</>
								} else {
									warnContent = 'Р’С‹Р±РµСЂРёС‚Рµ РіСЂСѓРїРїС‹ TG вЂ” РєРЅРѕРїРєР° В«Р“СЂСѓРїРїС‹ TGВ» РІ С€Р°РїРєРµ.'
								}
							} else {
								if (waConnected === false) {
									warnContent = <>РџРѕРґРєР»СЋС‡РёС‚Рµ <Link href='/cabinet#whatsapp'>WhatsApp</Link> РІ Р»РёС‡РЅРѕРј РєР°Р±РёРЅРµС‚Рµ.</>
								} else {
									warnContent = 'Р’С‹Р±РµСЂРёС‚Рµ РіСЂСѓРїРїС‹ WA вЂ” РєРЅРѕРїРєР° В«Р“СЂСѓРїРїС‹ WAВ» РІ С€Р°РїРєРµ.'
								}
							}
							return (
								<p className='camp__warnText'>
									вљ пёЏ {warnContent}
								</p>
							)
						})()}
					</section>

					<section className='camp__one-section'>
						<h2 className='camp__sectionTitle'>Р—Р°РїСѓСЃРє</h2>
						<div className='camp__cardInner camp__cardInner--actions'>
							<div className='camp__launchToolbar'>
								<div className='camp__launchToolbarChannels'>
									<Segmented
										className='campaigns-segmented'
										value={startMode}
										onChange={(v) => {
											const m = v as 'both' | 'wa' | 'tg'
											setStartMode(m)
											writeTimingStartMode(m)
											window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
										}}
										options={[
											{ label: <span className='camp__segmentedLabel'><ChannelIcon type='tg' size={14} /><ChannelIcon type='wa' size={14} /> TG + WA</span>, value: 'both' },
											{ label: <span className='camp__segmentedLabel'><ChannelIcon type='tg' size={14} /> РўРѕР»СЊРєРѕ TG</span>, value: 'tg' },
											{ label: <span className='camp__segmentedLabel'><ChannelIcon type='wa' size={14} /> РўРѕР»СЊРєРѕ WA</span>, value: 'wa' },
										]}
									/>
								</div>
							</div>
							<div className='camp__actionButtons camp__launchActions'>
							<Button type='primary' size='large' className='camp__launchPrimary' onClick={startSelected} loading={loading}>
								{noActiveCampaigns
									? 'Р—Р°РїСѓСЃС‚РёС‚СЊ'
									: startMode === 'tg'
										? 'Р—Р°РїСѓСЃС‚РёС‚СЊ TG'
										: startMode === 'wa'
											? 'Р—Р°РїСѓСЃС‚РёС‚СЊ WA'
											: 'Р—Р°РїСѓСЃС‚РёС‚СЊ TG + WA'}
							</Button>
							<Popover
									trigger='click'
									placement='bottomLeft'
									content={(
										<div style={{ display: 'grid', gap: 8, minWidth: 260 }}>
											<Button danger block disabled={!tgCampaignId} onClick={stopTg} loading={loading}>
												<ChannelIcon type='tg' size={16} /> РћСЃС‚Р°РЅРѕРІРёС‚СЊ TG
											</Button>
											{!tgCampaignId && (
												<div style={{ fontSize: 11, opacity: 0.78, marginTop: -2 }}>
													РћСЃС‚Р°РЅРѕРІРёС‚СЊ TG вЂ” С‚РѕР»СЊРєРѕ РµСЃР»Рё TG-СЂР°СЃСЃС‹Р»РєР° Р°РєС‚РёРІРЅР°.
												</div>
											)}
											<Button danger block disabled={!waCampaignId} onClick={stopWa} loading={loading}>
												<ChannelIcon type='wa' size={16} /> РћСЃС‚Р°РЅРѕРІРёС‚СЊ WA
											</Button>
											{!waCampaignId && (
												<div style={{ fontSize: 11, opacity: 0.78, marginTop: -2 }}>
													РћСЃС‚Р°РЅРѕРІРёС‚СЊ WA вЂ” С‚РѕР»СЊРєРѕ РµСЃР»Рё WA-СЂР°СЃСЃС‹Р»РєР° Р°РєС‚РёРІРЅР°.
												</div>
											)}
											<Button block disabled={!waCampaignId && !tgCampaignId} onClick={openProgress}>
												РџСЂРѕРіСЂРµСЃСЃ СЂР°СЃСЃС‹Р»РєРё в†’
											</Button>
											{!waCampaignId && !tgCampaignId && (
												<div style={{ fontSize: 11, opacity: 0.78, marginTop: -2 }}>
													РџСЂРѕРіСЂРµСЃСЃ РїРѕСЏРІРёС‚СЃСЏ РїРѕСЃР»Рµ Р·Р°РїСѓСЃРєР° С…РѕС‚СЏ Р±С‹ РѕРґРЅРѕРіРѕ РєР°РЅР°Р»Р°.
												</div>
											)}
											<Button
												block
												disabled={!waCampaignId}
												loading={loading}
												onClick={() =>
													void requeueOne(
														waCampaignId,
														'failed_pending',
														'WA Р±С‹СЃС‚СЂС‹Р№ РїРµСЂРµР·Р°РїСѓСЃРє',
													)
												}
											>
												<ChannelIcon type='wa' size={16} /> Р‘С‹СЃС‚СЂС‹Р№ СЂРµСЃС‚Р°СЂС‚ failed+pending (WA)
											</Button>
											<Button
												block
												disabled={!tgCampaignId}
												loading={loading}
												onClick={() =>
													void requeueOne(
														tgCampaignId,
														'failed_pending',
														'TG Р±С‹СЃС‚СЂС‹Р№ РїРµСЂРµР·Р°РїСѓСЃРє',
													)
												}
											>
												<ChannelIcon type='tg' size={16} /> Р‘С‹СЃС‚СЂС‹Р№ СЂРµСЃС‚Р°СЂС‚ failed+pending (TG)
											</Button>
										</div>
									)}
								>
									<Button size='large'>
										Р”РµР№СЃС‚РІРёСЏ
										{showActionsStatusBadge && (
											<Tooltip
												title={
													disabledActionsCount === 0
														? 'Р’СЃРµ РїСѓРЅРєС‚С‹ РјРµРЅСЋ РґРѕСЃС‚СѓРїРЅС‹'
														: `${disabledActionsCount} РёР· 3 РЅРµРґРѕСЃС‚СѓРїРЅРѕ (СЃС‚РѕРї / РїСЂРѕРіСЂРµСЃСЃ)`
												}
											>
												<Tag
													color={actionsBadgeColor}
													className={disabledActionsCount >= 2 ? 'camp__actionsBadgePulse' : undefined}
													style={{ marginInlineStart: 8, marginInlineEnd: 0, cursor: 'inherit' }}
												>
													{disabledActionsCount === 0 ? 'в—Џ' : disabledActionsCount}
												</Tag>
											</Tooltip>
										)}
									</Button>
								</Popover>
							</div>
							{noActiveCampaigns ? (
								<div className='camp__statusRow camp__statusRow--compact'>
									<span className='camp__statusCompactMuted'>
										<ChannelIcon type='tg' size={16} /> TG В· <ChannelIcon type='wa' size={16} /> WA вЂ” РЅРµС‚ Р°РєС‚РёРІРЅС‹С… СЂР°СЃСЃС‹Р»РѕРє
									</span>
								</div>
							) : (
								<div className='camp__statusRow'>
									<div className='camp__statusItem'>
										<ChannelIcon type='tg' size={18} />
										TG:{' '}
										{tgCampaignId && !tgPaused ? (
											<Tag color='green'>Р·Р°РїСѓС‰РµРЅР°</Tag>
										) : tgCampaignId && tgPaused ? (
											<Tag color='orange'>РЅР° РїР°СѓР·Рµ</Tag>
										) : (
											<Tag>РЅРµС‚</Tag>
										)}
										{tgCampaignId && tgPaused && isPaywallReason(tgPauseReason) && (
											<Tag color='red'>
												РЅСѓР¶РЅР° РѕРїР»Р°С‚Р°{' '}
												<a
													href='/cabinet/subscription'
													style={{ color: 'inherit', textDecoration: 'underline' }}
												>
													РїРµСЂРµР№С‚Рё
												</a>
											</Tag>
										)}
										{tgCampaignId && tgPaused && (
											<Button type='link' size='small' onClick={() => resumeChannel('tg')} loading={loading}>
												РџСЂРѕРґРѕР»Р¶РёС‚СЊ СЂР°СЃСЃС‹Р»РєСѓ
											</Button>
										)}
										{tgCampaignId && <code className='camp__statusId'>{tgCampaignId}</code>}
										{tgFinishAt ? (
											<span style={{ marginLeft: 10, fontSize: 12, opacity: 0.8 }}>
												РѕРєРѕРЅС‡Р°РЅРёРµ: <b>{formatCampaignFinishAt(tgFinishAt)}</b>
											</span>
										) : null}
									</div>
									<div className='camp__statusItem'>
										<ChannelIcon type='wa' size={18} />
										WA:{' '}
										{waCampaignId && !waPaused ? (
											<Tag color='green'>Р·Р°РїСѓС‰РµРЅР°</Tag>
										) : waCampaignId && waPaused ? (
											<Tag color='orange'>РЅР° РїР°СѓР·Рµ</Tag>
										) : (
											<Tag>РЅРµС‚</Tag>
										)}
										{waCampaignId && waPaused && isPaywallReason(waPauseReason) && (
											<Tag color='red'>
												РЅСѓР¶РЅР° РѕРїР»Р°С‚Р°{' '}
												<a
													href='/cabinet/subscription'
													style={{ color: 'inherit', textDecoration: 'underline' }}
												>
													РїРµСЂРµР№С‚Рё
												</a>
											</Tag>
										)}
										{waCampaignId && waPaused && (
											<Button type='link' size='small' onClick={() => resumeChannel('wa')} loading={loading}>
												РџСЂРѕРґРѕР»Р¶РёС‚СЊ СЂР°СЃСЃС‹Р»РєСѓ
											</Button>
										)}
										{waCampaignId && <code className='camp__statusId'>{waCampaignId}</code>}
										{waFinishAt ? (
											<span style={{ marginLeft: 10, fontSize: 12, opacity: 0.8 }}>
												РѕРєРѕРЅС‡Р°РЅРёРµ: <b>{formatCampaignFinishAt(waFinishAt)}</b>
											</span>
										) : null}
									</div>
								</div>
							)}
						</div>
					</section>

					{/* 3) РџСЂРѕРіСЂРµСЃСЃ СЂР°СЃСЃС‹Р»РєРё (РґРµС‚Р°Р»Рё) вЂ” РІРЅРёР·Сѓ РІ С‚РѕРј Р¶Рµ Р±Р»РѕРєРµ */}
					{progressUrl ? (
						<section className='camp__one-section camp__one-section--progress'>
							<h2 className='camp__sectionTitle'>РџСЂРѕРіСЂРµСЃСЃ СЂР°СЃСЃС‹Р»РєРё</h2>
							<iframe src={progressUrl} className='camp__iframe' />
						</section>
					) : null}

					{/* РСЃС‚РѕСЂРёСЏ Рё СЃРІРѕРґРєРё вЂ” РІ РСЃС‚РѕСЂРёРё */}
				</div>
			</div>
		</div>
	)
}
