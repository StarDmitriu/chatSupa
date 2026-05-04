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
	// antd TimePicker ожидает dayjs-объект, но у нас уже есть dayjs в зависимости проекта через antd.
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

	// ✅ ВАЖНО: на первом рендере ставим ДЕФОЛТ (чтобы совпало с SSR)
	const [{ timeFrom, timeTo }, setTimeWindow] = useState({
		timeFrom: '00:00',
		timeTo: '23:59',
	})

	// ✅ флаг, что мы уже на клиенте (после mount)
	const [mounted, setMounted] = useState(false)

	const [adv, setAdv] = useState<AdvSettings>({ repeatEnabled: true })

	const loader = useGlobalLoader()
	const skipSaveTimeRef = useRef(false)
	const skipSaveAdvRef = useRef(false)

	// ✅ после mount читаем localStorage и применяем (один раз)
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

	// ✅ сохраняем любые изменения (только когда уже mounted)
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

	// ✅ синхронизируем настройки из правой панели (TimingHubDrawer)
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

	// “Во сколько закончится” для активных рассылок
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
				// 'done' обычно совпадает с логическим завершением, но на практике
				// при авто-остановке иногда удобнее ориентироваться ещё и на отсутствие
				// pending/processing задач.
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

			// Если воркер уже отметил рассылку как завершённую — подгружаем /campaigns/active,
			// чтобы iframe-прогресс автоматически исчез без refresh.
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
			
			// Считаем выбранные группы и шаблоны через count API (без пагинации)
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
			// Синхронизировано с TelegramQrConnect: "подключён" только когда qr/status реально connected.
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

	// Сразу снимаем полноэкранный loader, если перешли с другой страницы (шаблоны, аналитика)
	useEffect(() => {
		loader.hide()
	}, [loader])

	// Загружаем без полноэкранного loader — страница открывается сразу; active из SWR, остальное по запросу
	useEffect(() => {
		Promise.all([loadPauseState(), loadStats()]).catch(() => {})
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Авто-подтягивание статуса WA/TG: повтор через 2 и 5 с, если ещё null (например, первый запрос был медленный или после возврата из кабинета)
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

	// При возврате на вкладку — обновить статус подключений и паузы (чтобы «словились» после кабинета)
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
		// Внутри iframe не нужна повторная шапка дашборда.
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
			// Пробрасываем код ошибки, чтобы ниже можно было показать человеко‑читаемое сообщение.
			const code = String(data?.message || 'start_failed')
			throw new Error(code)
		}

		const cid = String(data.campaignId || '').trim()
		if (!cid) throw new Error('campaignId_empty')

		return { cid, alreadyRunning: !!data.alreadyRunning }
	}

	const startSelected = async () => {
		// Гарантируем, что стартовые параметры всегда совпадают с тем, что сейчас на экране:
		// синхронно пишем в localStorage, а затем читаем обратно.
		if (mounted) {
			try {
				localStorage.setItem(LS_KEY_CAMPAIGN_TIME_WINDOW, JSON.stringify({ timeFrom, timeTo }))
				localStorage.setItem(LS_KEY_CAMPAIGN_ADV, JSON.stringify(adv))
			} catch {
				// ignore
			}
		}

		// На случай очень быстрого клика после правок (drawer / ползунки) — перечитаем из localStorage.
		let payload = { timeFrom, timeTo, adv }
		try {
			payload = { ...readSavedWindow(), adv: readSavedAdvSettings() }
		} catch {
			// ignore
		}

		setLoading(true)
		loader.show('Запускаем рассылку…')
		try {
			if (startMode === 'wa') {
				const wa = await startOne('wa', payload)
				setWaCampaignId(wa.cid)
				message.success(wa.alreadyRunning ? 'WA уже запущена' : 'WA запущена')
				loadActive()
				loadPauseState()
				loadStats()
				return
			}

			if (startMode === 'tg') {
				const tg = await startOne('tg', payload)
				setTgCampaignId(tg.cid)
				message.success(tg.alreadyRunning ? 'TG уже запущена' : 'TG запущена')
				loadActive()
				loadPauseState()
				loadStats()
				return
			}

			const wa = await startOne('wa', payload)
			const tg = await startOne('tg', payload)

			setWaCampaignId(wa.cid)
			setTgCampaignId(tg.cid)

			message.success('Запущены WA + TG')
			loadActive()
			loadPauseState()
			loadStats()
		} catch (e: unknown) {
			console.error(e)
			const msg = e instanceof Error ? e.message : 'unknown'

			const mapErrorMessage = (code: string): string => {
				switch (code) {
					case 'no_groups':
						return 'Нет выбранных групп для рассылки. Зайдите в раздел групп WA/TG, отметьте нужные группы и попробуйте снова.'
					case 'no_templates':
						return 'Нет включённых шаблонов сообщений. Добавьте и включите хотя бы один шаблон в разделе «Шаблоны».'
					case 'no_targets_for_templates':
						return 'Для включённых шаблонов не выбраны группы-получатели. Откройте шаблоны, во вкладках WA и TG отметьте группы и попробуйте снова.'
					case 'template_between_groups_required':
						return 'У шаблона, который участвует в рассылке, не задан интервал «пауза между группами» для этого канала (WA или TG). Откройте шаблон в разделе «Шаблоны», выставьте ползунки паузы и сохраните. Если недавно добавляли шаблоны из таблицы — выполните SQL миграцию колонок пауз в Supabase.'
					case 'no_jobs':
						return 'Не удалось сформировать задачи рассылки. Проверьте, что есть включённые шаблоны и выбранные группы для WA/TG.'
					case 'supabase_campaign_insert_error':
						return 'Не удалось создать кампанию в базе. В Supabase → SQL Editor выполните скрипт backend/migrations/fix_campaigns_start_multi_supabase.sql (или обновлённый блок campaigns в backend/migrations/RUN_IN_SUPABASE.sql), затем снова нажмите «Запустить».'
					case 'whatsapp_not_connected':
					case 'wa_not_connected':
						return 'WhatsApp не подключён. Подключите WhatsApp в личном кабинете.'
					case 'telegram_not_connected':
					case 'tg_not_connected':
						return 'Telegram не подключён. Подключите Telegram в личном кабинете.'
					case 'waiting_reconnect':
						return 'Канал временно не в состоянии open/connected. Кампания поставлена в ожидание переподключения.'
					default:
						return `Ошибка старта: ${code}`
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
							Для запуска рассылки нужна активная подписка или пробный период.{' '}
							<Button
								type='link'
								size='small'
								style={{ padding: 0, height: 'auto' }}
								onClick={() => router.push('/cabinet/subscription')}
							>
								Оформить подписку или начать пробный период →
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
								Перейти к подключению →
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
				`${label}: перезапущено ${n} задач (${statuses.join('+')}).`,
			)
			loadActive()
		} catch (e: any) {
			console.error(e)
			message.error(`${label}: ${e?.message || 'Не удалось перезапустить задачи'}`)
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
			message.success(channel === 'wa' ? 'WA: рассылка продолжена' : 'TG: рассылка продолжена')
			loadActive()
			loadPauseState()
		} catch (e: any) {
			console.error(e)
			message.error(e?.message || 'Не удалось снять паузу')
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
			message.success('WA остановлена')
			// Сразу обнуляем finish/iframe-канал, чтобы не показывать "хвосты"
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
			message.success('TG остановлена')
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
						<h2 className='camp__sectionTitle'>Что будет отправлено</h2>
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
								Паузы между отправками — ползунки TG/WA в карточке шаблона. Сколько уйдёт в волне зависит от групп,
								отмеченных внутри каждого шаблона, а не от счётчиков TG/WA выше (это все выбранные группы канала).
								Точное число и время окончания — в «Прогресс рассылки» после запуска.
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
								<span style={{ opacity: 0.88 }}>Окно:</span>
								<Popover
									trigger='click'
									overlayClassName='camp__timeWindowPopover'
									content={
										<div className='camp__timeWindowPopContent'>
											<div className='camp__timeWindowPopRow'>
												<div className='camp__timeWindowPopLabel'>С</div>
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
												<div className='camp__timeWindowPopLabel'>До</div>
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
												Сохраняется в браузере. Для активной рассылки — стоп, затем запуск снова.
											</div>
										</div>
									}
								>
									<button type='button' className='camp__timeWindowBtn' aria-label='Изменить окно суток'>
										{mounted ? `${timeFrom}—${timeTo}` : '00:00—23:59'}
									</button>
								</Popover>
							</div>
							<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
								<Switch
									checked={adv.repeatEnabled}
									onChange={(v) => setAdv((a) => ({ ...a, repeatEnabled: v }))}
								/>
								<span style={{ opacity: 0.88 }} title='Следующая волна — на следующий календарный день в начале окна'>
									Ежедневно повторять рассылки
								</span>
							</div>
						</div>
						<div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10, opacity: 0.9 }}>
							<b>{templatesCount}</b> шабл. · TG <b>{tgConnected === false ? 0 : tgSelectedCount}</b> · WA{' '}
							<b>{waConnected === false ? 0 : waSelectedCount}</b>
						</div>
						{/* Прогресс доступен в «Действия» в блоке запуска */}
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
								warnContent = 'Включите хотя бы один шаблон (кнопка Шаблоны в шапке).'
							} else if (startMode === 'both') {
								if (waConnected === false && tgConnected === false) {
									warnContent = <>Подключите <Link href='/cabinet#whatsapp'>WhatsApp</Link> и <Link href='/cabinet#telegram'>Telegram</Link> в личном кабинете.</>
								} else if (waConnected === false) {
									warnContent = <>Подключите <Link href='/cabinet#whatsapp'>WhatsApp</Link> в личном кабинете.</>
								} else if (tgConnected === false) {
									warnContent = <>Подключите <Link href='/cabinet#telegram'>Telegram</Link> в личном кабинете.</>
								} else if (waSelectedCount === 0 && tgSelectedCount === 0) {
									warnContent = 'Для «TG + WA» нужны группы в обоих каналах — откройте Группы WA и Группы TG в шапке.'
								} else if (waSelectedCount === 0) {
									warnContent = 'Добавьте группы WA (кнопка в шапке) или переключитесь на «Только TG».'
								} else {
									warnContent = 'Добавьте группы TG (кнопка в шапке) или переключитесь на «Только WA».'
								}
							} else if (startMode === 'tg') {
								if (tgConnected === false) {
									warnContent = <>Подключите <Link href='/cabinet#telegram'>Telegram</Link> в личном кабинете.</>
								} else {
									warnContent = 'Выберите группы TG — кнопка «Группы TG» в шапке.'
								}
							} else {
								if (waConnected === false) {
									warnContent = <>Подключите <Link href='/cabinet#whatsapp'>WhatsApp</Link> в личном кабинете.</>
								} else {
									warnContent = 'Выберите группы WA — кнопка «Группы WA» в шапке.'
								}
							}
							return (
								<p className='camp__warnText'>
									⚠️ {warnContent}
								</p>
							)
						})()}
					</section>

					<section className='camp__one-section'>
						<h2 className='camp__sectionTitle'>Запуск</h2>
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
											{ label: <span className='camp__segmentedLabel'><ChannelIcon type='tg' size={14} /> Только TG</span>, value: 'tg' },
											{ label: <span className='camp__segmentedLabel'><ChannelIcon type='wa' size={14} /> Только WA</span>, value: 'wa' },
										]}
									/>
								</div>
							</div>
							<div className='camp__actionButtons camp__launchActions'>
							<Button type='primary' size='large' className='camp__launchPrimary' onClick={startSelected} loading={loading}>
								{noActiveCampaigns
									? 'Запустить'
									: startMode === 'tg'
										? 'Запустить TG'
										: startMode === 'wa'
											? 'Запустить WA'
											: 'Запустить TG + WA'}
							</Button>
							<Popover
									trigger='click'
									placement='bottomLeft'
									content={(
										<div style={{ display: 'grid', gap: 8, minWidth: 260 }}>
											<Button danger block disabled={!tgCampaignId} onClick={stopTg} loading={loading}>
												<ChannelIcon type='tg' size={16} /> Остановить TG
											</Button>
											{!tgCampaignId && (
												<div style={{ fontSize: 11, opacity: 0.78, marginTop: -2 }}>
													Остановить TG — только если TG-рассылка активна.
												</div>
											)}
											<Button danger block disabled={!waCampaignId} onClick={stopWa} loading={loading}>
												<ChannelIcon type='wa' size={16} /> Остановить WA
											</Button>
											{!waCampaignId && (
												<div style={{ fontSize: 11, opacity: 0.78, marginTop: -2 }}>
													Остановить WA — только если WA-рассылка активна.
												</div>
											)}
											<Button block disabled={!waCampaignId && !tgCampaignId} onClick={openProgress}>
												Прогресс рассылки →
											</Button>
											{!waCampaignId && !tgCampaignId && (
												<div style={{ fontSize: 11, opacity: 0.78, marginTop: -2 }}>
													Прогресс появится после запуска хотя бы одного канала.
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
														'WA быстрый перезапуск',
													)
												}
											>
												<ChannelIcon type='wa' size={16} /> Быстрый рестарт failed+pending (WA)
											</Button>
											<Button
												block
												disabled={!tgCampaignId}
												loading={loading}
												onClick={() =>
													void requeueOne(
														tgCampaignId,
														'failed_pending',
														'TG быстрый перезапуск',
													)
												}
											>
												<ChannelIcon type='tg' size={16} /> Быстрый рестарт failed+pending (TG)
											</Button>
										</div>
									)}
								>
									<Button size='large'>
										Действия
										{showActionsStatusBadge && (
											<Tooltip
												title={
													disabledActionsCount === 0
														? 'Все пункты меню доступны'
														: `${disabledActionsCount} из 3 недоступно (стоп / прогресс)`
												}
											>
												<Tag
													color={actionsBadgeColor}
													className={disabledActionsCount >= 2 ? 'camp__actionsBadgePulse' : undefined}
													style={{ marginInlineStart: 8, marginInlineEnd: 0, cursor: 'inherit' }}
												>
													{disabledActionsCount === 0 ? '●' : disabledActionsCount}
												</Tag>
											</Tooltip>
										)}
									</Button>
								</Popover>
							</div>
							{noActiveCampaigns ? (
								<div className='camp__statusRow camp__statusRow--compact'>
									<span className='camp__statusCompactMuted'>
										<ChannelIcon type='tg' size={16} /> TG · <ChannelIcon type='wa' size={16} /> WA — нет активных рассылок
									</span>
								</div>
							) : (
								<div className='camp__statusRow'>
									<div className='camp__statusItem'>
										<ChannelIcon type='tg' size={18} />
										TG:{' '}
										{tgCampaignId && !tgPaused ? (
											<Tag color='green'>запущена</Tag>
										) : tgCampaignId && tgPaused ? (
											<Tag color='orange'>на паузе</Tag>
										) : (
											<Tag>нет</Tag>
										)}
										{tgCampaignId && tgPaused && isPaywallReason(tgPauseReason) && (
											<Tag color='red'>
												нужна оплата{' '}
												<a
													href='/cabinet/subscription'
													style={{ color: 'inherit', textDecoration: 'underline' }}
												>
													перейти
												</a>
											</Tag>
										)}
										{tgCampaignId && tgPaused && (
											<Button type='link' size='small' onClick={() => resumeChannel('tg')} loading={loading}>
												Продолжить рассылку
											</Button>
										)}
										{tgCampaignId && <code className='camp__statusId'>{tgCampaignId}</code>}
										{tgFinishAt ? (
											<span style={{ marginLeft: 10, fontSize: 12, opacity: 0.8 }}>
												окончание: <b>{formatCampaignFinishAt(tgFinishAt)}</b>
											</span>
										) : null}
									</div>
									<div className='camp__statusItem'>
										<ChannelIcon type='wa' size={18} />
										WA:{' '}
										{waCampaignId && !waPaused ? (
											<Tag color='green'>запущена</Tag>
										) : waCampaignId && waPaused ? (
											<Tag color='orange'>на паузе</Tag>
										) : (
											<Tag>нет</Tag>
										)}
										{waCampaignId && waPaused && isPaywallReason(waPauseReason) && (
											<Tag color='red'>
												нужна оплата{' '}
												<a
													href='/cabinet/subscription'
													style={{ color: 'inherit', textDecoration: 'underline' }}
												>
													перейти
												</a>
											</Tag>
										)}
										{waCampaignId && waPaused && (
											<Button type='link' size='small' onClick={() => resumeChannel('wa')} loading={loading}>
												Продолжить рассылку
											</Button>
										)}
										{waCampaignId && <code className='camp__statusId'>{waCampaignId}</code>}
										{waFinishAt ? (
											<span style={{ marginLeft: 10, fontSize: 12, opacity: 0.8 }}>
												окончание: <b>{formatCampaignFinishAt(waFinishAt)}</b>
											</span>
										) : null}
									</div>
								</div>
							)}
						</div>
					</section>

					{/* 3) Прогресс рассылки (детали) — внизу в том же блоке */}
					{progressUrl ? (
						<section className='camp__one-section camp__one-section--progress'>
							<h2 className='camp__sectionTitle'>Прогресс рассылки</h2>
							<iframe src={progressUrl} className='camp__iframe' />
						</section>
					) : null}

				</div>
			</div>
		</div>
	)
}
