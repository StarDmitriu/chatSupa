'use client'

import { DownOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import {
	Button,
	ConfigProvider,
	Drawer,
	Dropdown,
	Segmented,
	Slider,
	Skeleton,
	Space,
	Spin,
	Tooltip,
	Tour,
	message,
} from 'antd'
import type { TourProps } from 'antd'
import Cookies from 'js-cookie'
import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'

import type { AdvSettings, CapacityMode, StartMode } from '@/lib/campaignCapacity'
import type { TimingHubTab } from '@/components/TimingHubContext'
import { computeCapacity } from '@/lib/campaignCapacity'
import { scaleAdvBetweenGroups } from '@/lib/timingHubAdvScale'
import { mergeBothChannelCapacity } from '@/lib/timingHubBothChannelCapacity'
import { computeCapacityForAdvCandidate } from '@/lib/timingHubCapacityForAdv'
import {
	LS_KEY_CAMPAIGN_ADV,
	LS_KEY_CAMPAIGN_TIME_WINDOW,
	readLocalWaveSettings,
	safeParseJson,
	mergeAdvWithRecommendedPauses,
} from '@/lib/campaignWaveLocal'
import {
	collectTimingHubLocalSnapshot,
	readTimingHubCapacity,
	readTimingHubSessionUi,
	writeTimingHubCapacity,
	writeTimingHubSessionUi,
	type TimingHubToolSection as StoredToolSection,
} from '@/lib/timingHubUiStorage'
import { scheduleTimingApplyFeedback } from '@/lib/timingHubApplyFeedback'
import { formatEtaGoalLabel } from '@/lib/timingHubFormat'
import {
	equivalentSpeedFactorFromPauseMidpoint,
	readTemplatePausePairFromApi,
} from '@/lib/templateBetweenGroupsRange'
import { ETA_GOAL_MAX_MIN, ETA_GOAL_MIN_MIN } from '@/lib/timingHubMasterConstants'
import { buildCalendarDayRows, buildCalendarWeekCards, computeDayLoadPercent } from '@/lib/timingHubCalendarLayout'
import { buildClientVolumeBreakdown } from '@/lib/timingHubClientVolume'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'
import { buildPeriodPlan } from '@/lib/timingHubPeriodPlanCompute'
import { buildPlanningPeriodSummary } from '@/lib/timingHubPlanningSummaryCompute'
import { computeDayNeedsQuickFix, computeNeedsPlanningFix } from '@/lib/timingHubPlanningFix'
import type { TimingHubSendTimeWarning } from '@/lib/timingHubPlanTypes'
import { buildRhythmOneLiner } from '@/lib/timingHubRhythm'
import { buildRiskReasonForDay } from '@/lib/timingHubRiskReasonForDay'
import { buildSendTimeWarning } from '@/lib/timingHubSendTimeWarning'
import { buildSmartAutonudgeKey } from '@/lib/timingHubSmartAutonudgeKey'
import { computeWaveForecast } from '@/lib/timingHubWaveForecastCompute'
import { TimingHubPeriodCalendarControl } from '@/components/timingHub/TimingHubPeriodCalendarControl'
import { computeSelectedPeriodDays } from '@/lib/timingHubSelectedPeriodDays'
import { buildPeriodPlanPeriodFields } from '@/lib/timingHubPeriodPlanBuildInputs'

const TimingHubItogCardLazy = dynamic(
	() => import('@/components/timingHub/TimingHubItogCard').then((m) => m.TimingHubItogCard),
	{ ssr: false, loading: () => <Skeleton active paragraph={{ rows: 4 }} style={{ marginTop: 12 }} /> },
)
const TimingHubLoadCalendarLazy = dynamic(
	() => import('@/components/timingHub/TimingHubLoadCalendar').then((m) => m.TimingHubLoadCalendar),
	{ ssr: false, loading: () => <Skeleton active paragraph={{ rows: 3 }} style={{ marginTop: 10 }} /> },
)
const TimingHubAdvancedTabLazy = dynamic(
	() => import('@/components/timingHub/TimingHubAdvancedTab').then((m) => m.TimingHubAdvancedTab),
	{ ssr: false, loading: () => <Skeleton active paragraph={{ rows: 6 }} /> },
)
import {
	TIMING_HUB_DEFERRED_TOUR_KEY,
	readTimingStartMode,
	writeTimingStartMode,
} from '@/components/timingHubSession'
import { useTimingHub } from '@/components/TimingHubContext'
import { SEND_INTERVAL_OPTIONS } from '@/constants/sendIntervals'

import './CampaignTimingHubDrawer.css'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
const LS_KEY_DAY_OVERRIDES = 'campaigns_day_overrides_v1'
/** Один раз показать краткий тур; сбрасывается кнопкой «Обзор» в заголовке. */
const LS_KEY_TIMING_HUB_TOUR = 'timing_hub_intro_tour_v1'
/** Блок «Расширенные настройки» свёрнут: '1' — скрыт контент, иначе развёрнут. */
const LS_KEY_TIMING_HUB_ADV_COLLAPSED = 'timing_hub_advanced_collapsed_v1'

const TOUR_SCROLL_INTO_VIEW: ScrollIntoViewOptions = { block: 'center', behavior: 'smooth' }

/** Якоря прокрутки при открытии drawer с разными вкладками (`openDrawer`). */
const TIMING_HUB_TAB_SCROLL: Record<TimingHubTab, string> = {
	settings: 'timing-hub-section-settings',
	scheme: 'timing-hub-section-settings',
	calc: 'timing-hub-section-advanced',
}

/** Три блока одной панели (навигация + deep-link из `openDrawer`). */
type TimingHubToolSection = StoredToolSection

function timingHubTabToSection(tab: TimingHubTab): TimingHubToolSection {
	if (tab === 'calc') return 'advanced'
	if (tab === 'scheme') return 'plan'
	return 'plan'
}

/** Единый контейнер для выпадашек/календаря внутри drawer (не обрезается overflow). */
function timingHubGetPopupContainer(node: HTMLElement) {
	return (node.closest('.ant-drawer-body') as HTMLElement) || document.body
}

type TargetsSummary = {
	channel: 'wa' | 'tg'
	templatesTotalEnabled: number
	totalSelectedGroups: number
	templatesWithAnyTargetsIntersect: number
	templatesWithAnySendTimeOverrideIntersect: number
	groupsCoveredByAnyTargets: number
	groupsWithSendTimeOverride: number
	groupsFixedOverride: number
	groupsIntervalOverride: number
	jobsFromTargets: number
	avgTargetsPerTemplate: number
}

type TimingHubGroupDetail = {
	id: string
	name: string
	sendTime: string
}

type TimingHubTemplateDetail = {
	id: string
	title: string
	waSpeedFactor: number
	tgSpeedFactor: number
	tgDefaultSendTime: string
}

type CountsState = {
	userId: string
	loading: boolean
	waSelected: number
	tgSelected: number
	tplEnabled: number
	waSpeedFactors: number[]
	tgSpeedFactors: number[]
	tgTplHasDefaultSendTime: boolean
	waTargetsSummary: TargetsSummary | null
	tgTargetsSummary: TargetsSummary | null
	sendTimeMeta: {
		wa: { fixed: number; interval: number; none: number; sample: number }
		tg: { fixed: number; interval: number; none: number; sample: number }
	}
	waGroupDetails: TimingHubGroupDetail[]
	tgGroupDetails: TimingHubGroupDetail[]
	templateDetails: TimingHubTemplateDetail[]
}

export function TimingHubDrawer() {
	const { open, closeDrawer, refreshNonce, requestedTab, lastOpenOptions, clearOpenOptions, openSequence } =
		useTimingHub()
	const pathname = usePathname()
	const onCampaignsPage = pathname?.startsWith('/dashboard/campaigns') ?? false
	const onTemplatesPage = pathname?.startsWith('/dashboard/templates') ?? false
	const onWaGroupsPage = pathname === '/dashboard/groups' || pathname === '/dashboard/groups/'
	const onTgGroupsPage = pathname?.startsWith('/dashboard/groups/telegram') ?? false

	const [drawerViewportNarrow, setDrawerViewportNarrow] = useState(false)
	useEffect(() => {
		if (typeof window === 'undefined') return
		const mq = window.matchMedia('(max-width: 576px)')
		const upd = () => setDrawerViewportNarrow(mq.matches)
		upd()
		mq.addEventListener('change', upd)
		return () => mq.removeEventListener('change', upd)
	}, [])

	// Внутренние вкладки (Настройки/Калькулятор/Где что менять) объединены в одну сводку.
	const [capacityMode, setCapacityMode] = useState<CapacityMode>(() => {
		if (typeof window === 'undefined') return 'safe'
		return readTimingHubCapacity()?.capacityMode ?? 'safe'
	})
	const [customBufferEnabled, setCustomBufferEnabled] = useState(() => {
		if (typeof window === 'undefined') return false
		return readTimingHubCapacity()?.customBufferEnabled ?? false
	})
	const [customBufferMultiplier, setCustomBufferMultiplier] = useState<number>(() => {
		if (typeof window === 'undefined') return 1.35
		return readTimingHubCapacity()?.customBufferMultiplier ?? 1.35
	})
	const [startMode, setStartMode] = useState<StartMode>('both')
	const [wave, setWave] = useState<{ timeFrom: string; timeTo: string; adv: AdvSettings } | null>(null)
	const skipCountsOnWaveChangeRef = useRef(false)
	const [counts, setCounts] = useState<CountsState>({
		userId: '',
		loading: false,
		waSelected: 0,
		tgSelected: 0,
		tplEnabled: 0,
		waSpeedFactors: [],
		tgSpeedFactors: [],
		tgTplHasDefaultSendTime: false,
		waTargetsSummary: null,
		tgTargetsSummary: null,
		sendTimeMeta: {
			wa: { fixed: 0, interval: 0, none: 0, sample: 0 },
			tg: { fixed: 0, interval: 0, none: 0, sample: 0 },
		},
		waGroupDetails: [],
		tgGroupDetails: [],
		templateDetails: [],
	})

	const [advancedCollapsed, setAdvancedCollapsed] = useState(false)
	const [showManualAdvanced, setShowManualAdvanced] = useState(() => {
		if (typeof window === 'undefined') return false
		return readTimingHubSessionUi()?.toolSection === 'advanced'
	})
	const [toolSection, setToolSection] = useState<TimingHubToolSection>(() => {
		if (typeof window === 'undefined') return 'plan'
		const t = readTimingHubSessionUi()?.toolSection
		if (t === 'advanced') return 'advanced'
		return 'plan'
	})
	const tourPlanRef = useRef<HTMLDivElement>(null)
	const tourItogRef = useRef<HTMLDivElement>(null)
	const tourAdvancedRef = useRef<HTMLDivElement>(null)
	const [tourOpen, setTourOpen] = useState(false)

	const openTimingHubTour = useCallback(() => setTourOpen(true), [])
	const dismissTimingHubTour = useCallback(() => {
		setTourOpen(false)
		try {
			localStorage.setItem(LS_KEY_TIMING_HUB_TOUR, '1')
		} catch {
			/* ignore */
		}
	}, [])

	const resetTimingHubTourFlag = useCallback(() => {
		try {
			localStorage.removeItem(LS_KEY_TIMING_HUB_TOUR)
		} catch {
			/* ignore */
		}
		message.success('Авто-тур сброшен: при следующем открытии панели (вкладка «сводка») он покажется снова')
	}, [])

	const tourSteps = useMemo<TourProps['steps']>(
		() => [
			{
				title: 'Период и сводка',
				description:
					'Период (сколько дней в календаре) и сводка запуска. Для ручных правок откройте «Окно и паузы».',
				target: () => tourPlanRef.current ?? document.body,
				scrollIntoViewOptions: TOUR_SCROLL_INTO_VIEW,
			},
			{
				title: 'Итог по запуску',
				description:
					'Объём, ритм, оценка риска; при необходимости — «Выбрать действие».',
				target: () => tourItogRef.current ?? document.body,
				scrollIntoViewOptions: TOUR_SCROLL_INTO_VIEW,
			},
			{
				title: 'Окно и паузы',
				description:
					'Вкладка «Окно и паузы»: окно суток и ручные паузы/повтор волны. Кнопки «Готово» и «Сброс к автоподбору» — внизу.',
				target: () => tourAdvancedRef.current ?? document.body,
				scrollIntoViewOptions: TOUR_SCROLL_INTO_VIEW,
			},
		],
		[],
	)

	/** Скрытый сброс: в консоли `window.dispatchEvent(new Event('timingHub:resetTour'))` */
	useEffect(() => {
		const onResetTour = () => resetTimingHubTourFlag()
		window.addEventListener('timingHub:resetTour', onResetTour)
		return () => window.removeEventListener('timingHub:resetTour', onResetTour)
	}, [resetTimingHubTourFlag])

	const loadCounts = useCallback(async () => {
		const token = Cookies.get('token') || ''
		if (!token) return

		setCounts((p) => ({ ...p, loading: true }))
		try {
			const meRes = await fetch(`${BACKEND_URL}/auth/me`, {
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
			})
			const meJson: any = await meRes.json().catch(() => null)
			if (!meJson?.success) return
			const userId = String(meJson.user?.id || '')
			if (!userId) return

			const [
				waRes,
				tgRes,
				tplRes,
				waSampleRes,
				tgSampleRes,
				waTargetsSummaryRes,
				tgTargetsSummaryRes,
			] = await Promise.all([
				fetch(`${BACKEND_URL}/whatsapp/groups/${userId}/count`, {
					cache: 'no-store',
					headers: { Authorization: `Bearer ${token}` },
				}).then((r) => r.json().catch(() => null)),
				fetch(`${BACKEND_URL}/telegram/groups/${userId}/count`, {
					cache: 'no-store',
					headers: { Authorization: `Bearer ${token}` },
				}).then((r) => r.json().catch(() => null)),
				fetch(`${BACKEND_URL}/templates/list/${userId}`, {
					cache: 'no-store',
					headers: { Authorization: `Bearer ${token}` },
				}).then((r) => r.json().catch(() => null)),
				fetch(
					`${BACKEND_URL}/whatsapp/groups/${userId}?${new URLSearchParams({
						selectedOnly: 'true',
						limit: '1000',
						offset: '0',
					}).toString()}`,
					{
						cache: 'no-store',
						headers: { Authorization: `Bearer ${token}` },
					},
				).then((r) => r.json().catch(() => null)),
				fetch(
					`${BACKEND_URL}/telegram/groups/${userId}?${new URLSearchParams({
						selectedOnly: 'true',
						limit: '1000',
						offset: '0',
					}).toString()}`,
					{
						cache: 'no-store',
						headers: { Authorization: `Bearer ${token}` },
					},
				).then((r) => r.json().catch(() => null)),
				fetch(`${BACKEND_URL}/templates/targets/summary/${userId}/wa`, {
					cache: 'no-store',
					headers: { Authorization: `Bearer ${token}` },
				}).then((r) => r.json().catch(() => null)),
				fetch(`${BACKEND_URL}/templates/targets/summary/${userId}/tg`, {
					cache: 'no-store',
					headers: { Authorization: `Bearer ${token}` },
				}).then((r) => r.json().catch(() => null)),
			])

			const waSelected = waRes?.success ? Number(waRes.selected || 0) : 0
			const tgSelected = tgRes?.success ? Number(tgRes.selected || 0) : 0

			const templates = Array.isArray(tplRes?.templates) ? tplRes.templates : []
			const enabledTemplates = templates.filter((t: any) => t && t.enabled !== false)
			const tplEnabled = enabledTemplates.length

			const isNonEmpty = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''
			const tgTplHasDefaultSendTime = enabledTemplates.some((t: any) => isNonEmpty(t?.tg_default_send_time))

			const templateSpeedForHub = (channel: 'wa' | 'tg', t: Record<string, unknown>) => {
				const minK = channel === 'wa' ? 'wa_between_groups_sec_min' : 'tg_between_groups_sec_min'
				const maxK = channel === 'wa' ? 'wa_between_groups_sec_max' : 'tg_between_groups_sec_max'
				const hasExplicitPair =
					typeof t[minK] === 'number' &&
					typeof t[maxK] === 'number' &&
					Number.isFinite(t[minK]) &&
					Number.isFinite(t[maxK])
				const [lo, hi] = readTemplatePausePairFromApi(
					channel,
					t,
					channel === 'wa' ? t.wa_speed_factor : t.tg_speed_factor,
				)
				if (hasExplicitPair) {
					return equivalentSpeedFactorFromPauseMidpoint(channel, (lo + hi) / 2)
				}
				const sf = Number(channel === 'wa' ? t.wa_speed_factor : t.tg_speed_factor)
				return Number.isFinite(sf) && sf > 0 ? sf : 100
			}

			const waSpeedFactors = enabledTemplates.map((t: any) => templateSpeedForHub('wa', t as Record<string, unknown>))
			const tgSpeedFactors = enabledTemplates.map((t: any) => templateSpeedForHub('tg', t as Record<string, unknown>))

			const isFixed = (s: any) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim())
			const intervalValues = new Set(SEND_INTERVAL_OPTIONS.map((o) => o.value))
			const classify = (s: any) => {
				const str = String(s || '').trim()
				if (!str) return 'none' as const
				if (isFixed(str)) return 'fixed' as const
				if (intervalValues.has(str)) return 'interval' as const
				return 'none' as const
			}

			const waSample = Array.isArray(waSampleRes?.groups) ? waSampleRes.groups : []
			const tgSample = Array.isArray(tgSampleRes?.groups) ? tgSampleRes.groups : []
			const waGroupDetails: TimingHubGroupDetail[] = waSample.map((g: any) => ({
				id: String(g?.wa_group_id ?? g?.id ?? ''),
				name: String(g?.subject ?? g?.name ?? 'без названия'),
				sendTime: String(g?.send_time ?? '').trim() || '—',
			}))
			const tgGroupDetails: TimingHubGroupDetail[] = tgSample.map((g: any) => ({
				id: String(g?.tg_chat_id ?? g?.id ?? ''),
				name: String(g?.title ?? g?.name ?? 'без названия'),
				sendTime: String(g?.send_time ?? '').trim() || '—',
			}))
			const templateDetails: TimingHubTemplateDetail[] = enabledTemplates.map((t: any) => ({
				id: String(t?.id ?? t?.template_id ?? ''),
				title: String(t?.title ?? t?.name ?? 'без названия'),
				waSpeedFactor: templateSpeedForHub('wa', t as Record<string, unknown>),
				tgSpeedFactor: templateSpeedForHub('tg', t as Record<string, unknown>),
				tgDefaultSendTime: String(t?.tg_default_send_time ?? '').trim() || '—',
			}))

			const waFixed = waSample.filter((g: any) => classify(g.send_time) === 'fixed').length
			const waInterval = waSample.filter((g: any) => classify(g.send_time) === 'interval').length
			const waNone = waSample.filter((g: any) => classify(g.send_time) === 'none').length

			const tgFixed = tgSample.filter((g: any) => classify(g.send_time) === 'fixed').length
			const tgInterval = tgSample.filter((g: any) => classify(g.send_time) === 'interval').length
			const tgNone = tgSample.filter((g: any) => classify(g.send_time) === 'none').length

			const waTargetsSummary: TargetsSummary | null =
				waTargetsSummaryRes?.success && waTargetsSummaryRes?.channel === 'wa'
					? waTargetsSummaryRes
					: null
			const tgTargetsSummary: TargetsSummary | null =
				tgTargetsSummaryRes?.success && tgTargetsSummaryRes?.channel === 'tg'
					? tgTargetsSummaryRes
					: null

			setCounts({
				userId,
				loading: false,
				waSelected,
				tgSelected,
				tplEnabled,
				waSpeedFactors,
				tgSpeedFactors,
				tgTplHasDefaultSendTime,
				waTargetsSummary,
				tgTargetsSummary,
				sendTimeMeta: {
					wa: { fixed: waFixed, interval: waInterval, none: waNone, sample: waSample.length },
					tg: { fixed: tgFixed, interval: tgInterval, none: tgNone, sample: tgSample.length },
				},
				waGroupDetails,
				tgGroupDetails,
				templateDetails,
			})
		} catch (e) {
			console.error(e)
			setCounts((p) => ({ ...p, loading: false }))
		}
	}, [])

	const refreshWave = useCallback(() => {
		try {
			setWave(readLocalWaveSettings())
		} catch {
			// ignore
		}
	}, [])

	const persistWave = useCallback(
		(next: { timeFrom: string; timeTo: string; adv: AdvSettings }) => {
			skipCountsOnWaveChangeRef.current = true
			try {
				localStorage.setItem(
					LS_KEY_CAMPAIGN_TIME_WINDOW,
					JSON.stringify({ timeFrom: next.timeFrom, timeTo: next.timeTo }),
				)
				localStorage.setItem(LS_KEY_CAMPAIGN_ADV, JSON.stringify(next.adv))
				setWave(next)
				window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
			} catch {
				// ignore
			}
		},
		[],
	)

	useEffect(() => {
		if (!open) return
		void Promise.resolve().then(() => {
			refreshWave()
			void loadCounts()
		})
	}, [open, refreshNonce, refreshWave, loadCounts])

	/** Восстановить свёрнутость блока «Расширенные настройки» из localStorage (один раз при монтировании). */
	useEffect(() => {
		if (typeof window === 'undefined') return
		try {
			setAdvancedCollapsed(localStorage.getItem(LS_KEY_TIMING_HUB_ADV_COLLAPSED) === '1')
		} catch {
			/* ignore */
		}
	}, [])

	const persistAdvancedCollapsed = useCallback((collapsed: boolean) => {
		try {
			localStorage.setItem(LS_KEY_TIMING_HUB_ADV_COLLAPSED, collapsed ? '1' : '0')
		} catch {
			/* ignore */
		}
	}, [])

	const expandAdvancedSettings = useCallback(() => {
		setAdvancedCollapsed(false)
		persistAdvancedCollapsed(false)
	}, [persistAdvancedCollapsed])

	const toggleAdvancedCollapsed = useCallback(() => {
		setAdvancedCollapsed((c) => {
			const next = !c
			persistAdvancedCollapsed(next)
			return next
		})
	}, [persistAdvancedCollapsed])

	/** Переключение вкладок панели (прогноз / окно и паузы). */
	const scrollToToolSection = useCallback((section: TimingHubToolSection) => {
		if (section === 'advanced') setShowManualAdvanced(true)
		setToolSection(section)
		if (section === 'advanced') {
			setAdvancedCollapsed(false)
			persistAdvancedCollapsed(false)
		}
		window.setTimeout(() => {
			const root = document.querySelector('.timing-hub-drawer .ant-drawer-body') as HTMLElement | null
			if (root) root.scrollTop = 0
		}, 0)
	}, [persistAdvancedCollapsed])

	/** Вкладка из `openDrawer`: выбрать раздел панели. */
	useEffect(() => {
		if (!open) return
		const section = timingHubTabToSection(requestedTab)
		if (section === 'advanced') setShowManualAdvanced(true)
		setToolSection(section)
		if (requestedTab === 'calc') {
			setAdvancedCollapsed(false)
			persistAdvancedCollapsed(false)
		}
		const scrollId = TIMING_HUB_TAB_SCROLL[requestedTab]
		const t = window.setTimeout(() => {
			document.getElementById(scrollId)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
			const root = document.querySelector('.timing-hub-drawer .ant-drawer-body') as HTMLElement | null
			if (root) root.scrollTop = 0
		}, 40)
		return () => window.clearTimeout(t)
	}, [open, requestedTab, persistAdvancedCollapsed])

	useEffect(() => {
		if (!open) setTourOpen(false)
	}, [open])

	useEffect(() => {
		writeTimingHubCapacity({ capacityMode, customBufferEnabled, customBufferMultiplier })
	}, [capacityMode, customBufferEnabled, customBufferMultiplier])

	/**
	 * Авто-тур только при открытии со «сводкой» (settings), чтобы не пересекаться со скроллом к
	 * «Диагностика» / «Расширенные» при openDrawer('scheme' | 'calc'). Повтор — кнопка «Обзор».
	 */
	useEffect(() => {
		if (!open || requestedTab !== 'settings' || counts.loading || !wave) return
		try {
			if (localStorage.getItem(LS_KEY_TIMING_HUB_TOUR) === '1') return
		} catch {
			return
		}
		let cancelled = false
		const t = window.setTimeout(() => {
			if (!cancelled) setTourOpen(true)
		}, 550)
		return () => {
			cancelled = true
			window.clearTimeout(t)
		}
	}, [open, requestedTab, counts.loading, wave])

	/** После перехода из кабинета «Показать тур планирования» — открыть тур, когда данные готовы. */
	useEffect(() => {
		if (!open || counts.loading || !wave) return
		if (typeof window === 'undefined') return
		if (sessionStorage.getItem(TIMING_HUB_DEFERRED_TOUR_KEY) !== '1') return
		sessionStorage.removeItem(TIMING_HUB_DEFERRED_TOUR_KEY)
		const t = window.setTimeout(() => setTourOpen(true), 450)
		return () => window.clearTimeout(t)
	}, [open, counts.loading, wave])

	/** Канал прогноза синхронизирован с /dashboard/campaigns (localStorage). */
	useEffect(() => {
		setStartMode(readTimingStartMode())
	}, [])

	// Обновления: шаблоны сохранены / интервалы изменились (в этой же вкладке)
	useEffect(() => {
		const onChanged = (_evt: Event) => {
			setStartMode(readTimingStartMode())
			if (!open) return
			refreshWave()
			if (skipCountsOnWaveChangeRef.current) {
				skipCountsOnWaveChangeRef.current = false
				return
			}
			void loadCounts()
		}
		window.addEventListener(TIMING_HUB_CHANGED_EVENT, onChanged)
		window.addEventListener('storage', onChanged)
		return () => {
			window.removeEventListener(TIMING_HUB_CHANGED_EVENT, onChanged)
			window.removeEventListener('storage', onChanged)
		}
	}, [open, refreshWave, loadCounts])

	const cap = useMemo(() => {
		if (!wave) return null

		const waTemplatesForJobs =
			counts.waTargetsSummary?.templatesWithAnyTargetsIntersect ?? counts.tplEnabled
		const tgTemplatesForJobs =
			counts.tgTargetsSummary?.templatesWithAnyTargetsIntersect ?? counts.tplEnabled

		// jobsFromTargets (т.е. сколько jobs реально создастся backend-ом из template targets)
		// превращаем в “effective selected groups count”, чтобы computeCapacity мог посчитать totalSec.
		const waJobsFromTargets =
			counts.waTargetsSummary?.jobsFromTargets ?? counts.waSelected * counts.tplEnabled
		const tgJobsFromTargets =
			counts.tgTargetsSummary?.jobsFromTargets ?? counts.tgSelected * counts.tplEnabled

		const waSelectedEff =
			waTemplatesForJobs > 0 ? waJobsFromTargets / waTemplatesForJobs : 0
		const tgSelectedEff =
			tgTemplatesForJobs > 0 ? tgJobsFromTargets / tgTemplatesForJobs : 0

		const bufferMultiplier = customBufferEnabled ? customBufferMultiplier : undefined

		const common = {
			adv: wave.adv,
			timeFrom: wave.timeFrom,
			timeTo: wave.timeTo,
			capacityMode,
			bufferMultiplier,
			waSpeedFactors: counts.waSpeedFactors,
			tgSpeedFactors: counts.tgSpeedFactors,
			// В “правильном” прогнозе каналы не смешиваются — если startMode=both, склеиваем вручную ниже.
			parallelChannels: true,
		}

		if (startMode === 'wa') {
			return computeCapacity({
				...common,
				templatesCount: waTemplatesForJobs,
				waSelectedCount: waSelectedEff,
				tgSelectedCount: 0,
				startMode: 'wa',
			})
		}

		if (startMode === 'tg') {
			return computeCapacity({
				...common,
				templatesCount: tgTemplatesForJobs,
				waSelectedCount: 0,
				tgSelectedCount: tgSelectedEff,
				startMode: 'tg',
			})
		}

		// startMode === 'both': считаем два канала отдельно и “склеиваем” по времени (волна = max(TG, WA)),
		// а по объёму — суммируем jobs.
		const capWa = computeCapacity({
			...common,
			templatesCount: waTemplatesForJobs,
			waSelectedCount: waSelectedEff,
			tgSelectedCount: 0,
			startMode: 'wa',
		})
		const capTg = computeCapacity({
			...common,
			templatesCount: tgTemplatesForJobs,
			waSelectedCount: 0,
			tgSelectedCount: tgSelectedEff,
			startMode: 'tg',
		})

		return mergeBothChannelCapacity(capWa, capTg)
	}, [
		wave,
		counts,
		startMode,
		capacityMode,
		customBufferEnabled,
		customBufferMultiplier,
	])

	const sendTimeWarning = useMemo<TimingHubSendTimeWarning | null>(
		() =>
			buildSendTimeWarning({
				sendTimeMeta: counts.sendTimeMeta,
				tgTplHasDefaultSendTime: counts.tgTplHasDefaultSendTime,
				waTargetsSummary: counts.waTargetsSummary,
				tgTargetsSummary: counts.tgTargetsSummary,
				startMode,
			}),
		[
			counts.sendTimeMeta,
			counts.tgTplHasDefaultSendTime,
			counts.waTargetsSummary,
			counts.tgTargetsSummary,
			startMode,
		],
	)

	const waActiveTemplates = counts.waTargetsSummary?.templatesWithAnyTargetsIntersect ?? counts.tplEnabled
	const tgActiveTemplates = counts.tgTargetsSummary?.templatesWithAnyTargetsIntersect ?? counts.tplEnabled

	const tgGroupsForJobs = counts.tgTargetsSummary?.groupsCoveredByAnyTargets ?? counts.tgSelected
	const waGroupsForJobs = counts.waTargetsSummary?.groupsCoveredByAnyTargets ?? counts.waSelected

	/** Как думает клиент: сколько групп × сколько шаблонов → сколько «сообщений» в волне (jobs). */
	const clientVolumeBreakdown = useMemo(
		() =>
			cap
				? buildClientVolumeBreakdown({
						cap,
						startMode,
						tgGroupsForJobs,
						waGroupsForJobs,
						tgActiveTemplates,
						waActiveTemplates,
						hasTargetsWa: (counts.waTargetsSummary?.templatesWithAnyTargetsIntersect ?? 0) > 0,
						hasTargetsTg: (counts.tgTargetsSummary?.templatesWithAnyTargetsIntersect ?? 0) > 0,
					})
				: null,
		[
			cap,
			startMode,
			tgGroupsForJobs,
			waGroupsForJobs,
			tgActiveTemplates,
			waActiveTemplates,
			counts.waTargetsSummary?.templatesWithAnyTargetsIntersect,
			counts.tgTargetsSummary?.templatesWithAnyTargetsIntersect,
		],
	)

	/** Одна строка: окно суток + повтор (как «каждый час / каждый день» задаётся здесь + в группах). */
	const rhythmOneLiner = useMemo(() => buildRhythmOneLiner(wave), [wave])

	const waveForecast = useMemo(() => {
		if (!cap || !wave) return null
		return computeWaveForecast(cap, wave)
	}, [cap, wave])

	const seriesEndCard = waveForecast?.waveCards?.length
		? waveForecast.waveCards[waveForecast.waveCards.length - 1]
		: null

	const applyRecommendedPauses = useCallback(
		(opts: { alsoDisableRepeatIfNotFit: boolean; forceDisableRepeat?: boolean }) => {
			if (!cap || !wave) return
			const next = mergeAdvWithRecommendedPauses(
				wave.adv,
				cap.tgRecommendedRange,
				cap.waRecommendedRange,
				{
					alsoDisableRepeatIfNotFit: opts.alsoDisableRepeatIfNotFit,
					forceDisableRepeat: opts.forceDisableRepeat,
					capFit: cap.fit,
				},
			) satisfies AdvSettings
			try {
				skipCountsOnWaveChangeRef.current = true
				localStorage.setItem(LS_KEY_CAMPAIGN_ADV, JSON.stringify(next))
				setWave({ ...wave, adv: next })
				window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
				message.success('Настройки сохранены (в этом браузере)')
			} catch {
				message.error('Не удалось сохранить паузы в браузере')
			}
		},
		[cap, wave],
	)

	type SmartGoal = 'oneWave' | 'fit' | 'eta'
	const [smartEnabled, setSmartEnabled] = useState(() => {
		if (typeof window === 'undefined') return true
		const v = readTimingHubSessionUi()?.smartEnabled
		return typeof v === 'boolean' ? v : true
	})
	const [smartGoal, setSmartGoal] = useState<SmartGoal>(() => {
		if (typeof window === 'undefined') return 'eta'
		const g = readTimingHubSessionUi()?.smartGoal
		return g === 'oneWave' || g === 'fit' || g === 'eta' ? g : 'eta'
	})
	const [fixedCalendarDays, setFixedCalendarDays] = useState(() => {
		if (typeof window === 'undefined') return 7
		const ui = readTimingHubSessionUi()
		if (ui?.periodPreset === 'custom' && ui.customRange?.[0] && ui.customRange[1]) {
			const a = dayjs(ui.customRange[0])
			const b = dayjs(ui.customRange[1])
			if (a.isValid() && b.isValid()) {
				const n = b.startOf('day').diff(a.startOf('day'), 'day') + 1
				return Math.max(1, Math.min(30, n))
			}
		}
		const fd = ui?.fixedCalendarDays
		if (typeof fd === 'number' && Number.isFinite(fd)) {
			return Math.max(1, Math.min(30, Math.round(fd)))
		}
		const legacy = ui?.periodPreset
		if (legacy === 'today') return 1
		if (legacy === '3d') return 3
		if (legacy === '7d') return 7
		if (legacy === '30d') return 30
		return 7
	})
	const [calendarMode, setCalendarMode] = useState<'days' | 'list' | 'weeks'>(() => {
		if (typeof window === 'undefined') return 'days'
		const m = readTimingHubSessionUi()?.calendarMode
		return m === 'list' || m === 'weeks' || m === 'days' ? m : 'days'
	})
	const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null)
	const [dayOverrides, setDayOverrides] = useState<Record<string, { action: string; updatedAt: number }>>({})
	const [targetEtaMin, setTargetEtaMin] = useState<number>(() => {
		if (typeof window === 'undefined') return 30
		const n = readTimingHubSessionUi()?.targetEtaMin
		return typeof n === 'number' && Number.isFinite(n)
			? Math.max(ETA_GOAL_MIN_MIN, Math.min(ETA_GOAL_MAX_MIN, Math.round(n)))
			: 30
	})
	const didInitTargetRef = useRef(false)
	const smartApplyingRef = useRef(false)
	const smartAppliedKeyRef = useRef<string>('')
	const suppressNextSmartAutonudgeRef = useRef(false)

	/** Сохранение UI панели между закрытиями (вкладка). */
	useEffect(() => {
		if (!open) return
		writeTimingHubSessionUi({
			toolSection,
			smartGoal,
			smartEnabled,
			periodPreset: 'fixed',
			fixedCalendarDays,
			calendarMode,
			targetEtaMin,
		})
	}, [open, toolSection, smartGoal, smartEnabled, fixedCalendarDays, calendarMode, targetEtaMin])

	useEffect(() => {
		try {
			const raw = safeParseJson(localStorage.getItem(LS_KEY_DAY_OVERRIDES))
			if (raw && typeof raw === 'object') {
				setDayOverrides(raw as Record<string, { action: string; updatedAt: number }>)
			}
		} catch {}
	}, [])

	const selectedPeriodDays = useMemo(
		() =>
			computeSelectedPeriodDays({
				periodPreset: 'fixed',
				fixedCalendarDays,
				customPeriodRange: null,
			}),
		[fixedCalendarDays],
	)

	const periodPlan = useMemo(() => {
		if (!cap || !wave) return null
		const periodFields = buildPeriodPlanPeriodFields({
			periodPreset: 'fixed',
			customPeriodRange: null,
		})
		return buildPeriodPlan({
			cap,
			wave,
			selectedPeriodDays,
			smartGoal,
			sendTimeWarningHasDetailLines: Boolean(sendTimeWarning?.lines?.length),
			periodPreset: periodFields.periodPreset,
			customPeriodRange: periodFields.customPeriodRange,
			now: dayjs(),
		})
	}, [cap, wave, selectedPeriodDays, smartGoal, sendTimeWarning])

	/** Единая сводка: волны в окне / за период + объём сообщений календаря (те же строки, что в «Итоге»). */
	const planningPeriodSummary = useMemo(
		() =>
			cap
				? buildPlanningPeriodSummary({
						cap,
						waveForecast,
						periodPlan,
						smartGoal,
						targetEtaMin,
						smartEnabled,
					})
				: null,
		[cap, waveForecast, periodPlan, smartGoal, targetEtaMin, smartEnabled],
	)

	const needsPlanningFix = useMemo(
		() => (cap ? computeNeedsPlanningFix({ cap, sendTimeWarning, periodPlan }) : false),
		[cap, sendTimeWarning, periodPlan],
	)

	/** Быстрые действия по дню — только при риске; при норме показываем ссылку на расширенные настройки. */
	const dayNeedsQuickFix = useCallback(
		(loadPct: number) =>
			cap ? computeDayNeedsQuickFix({ cap, periodPlan, needsPlanningFix, loadPct }) : false,
		[cap, periodPlan, needsPlanningFix],
	)

	const calcCapForAdv = useCallback(
		(advCandidate: AdvSettings) => {
			if (!wave) return null
			return computeCapacityForAdvCandidate({
				adv: advCandidate,
				timeFrom: wave.timeFrom,
				timeTo: wave.timeTo,
				startMode,
				capacityMode,
				bufferMultiplier: customBufferEnabled ? customBufferMultiplier : undefined,
				counts,
			})
		},
		[counts, startMode, capacityMode, wave, customBufferEnabled, customBufferMultiplier],
	)

	const calendarDayRows = useMemo(
		() => (periodPlan ? buildCalendarDayRows(periodPlan) : []),
		[periodPlan],
	)

	const calendarWeekCards = useMemo(
		() => (periodPlan && cap ? buildCalendarWeekCards(periodPlan, cap) : []),
		[periodPlan, cap],
	)

	/** При смене периода/плана — выбрать первый день с объёмом, чтобы сразу видеть «сколько уйдёт». */
	useEffect(() => {
		if (!periodPlan) return
		const keys = new Set(periodPlan.dayCards.map((d) => d.dateKey))
		if (selectedDayKey && keys.has(selectedDayKey)) return
		const first =
			periodPlan.dayCards.find((d) => d.jobsMax > 0) ?? periodPlan.dayCards[0] ?? null
		setSelectedDayKey(first?.dateKey ?? null)
	}, [periodPlan, selectedDayKey])

	const getLoadColor = (load: number) => {
		if (load <= 50) return 'rgba(82,196,26,0.16)'
		if (load <= 85) return 'rgba(250,173,20,0.18)'
		if (load <= 100) return 'rgba(250,140,22,0.2)'
		return 'rgba(255,77,79,0.2)'
	}

	const getDayStatus = (jobs: number, load: number): 'ok' | 'risk' | 'empty' => {
		if (jobs <= 0) return 'empty'
		if (periodPlan && !periodPlan.canFitGoal) return 'risk'
		return load > 100 ? 'risk' : 'ok'
	}

	const dayLoadPercent = useCallback(
		(day: { jobsMax: number; wavesMax: number }) => (cap ? computeDayLoadPercent(cap, day) : 0),
		[cap],
	)

	const selectedDay = useMemo(() => {
		if (!periodPlan || !selectedDayKey) return null
		return periodPlan.dayCards.find((d) => d.dateKey === selectedDayKey) ?? null
	}, [periodPlan, selectedDayKey])

	const riskReasonForDay = useCallback(
		(day: { jobsMax: number; wavesMax: number }, load: number) =>
			buildRiskReasonForDay({
				day,
				load,
				cap,
				periodPlan,
				repeatEnabled: Boolean(wave?.adv.repeatEnabled),
				repeatMinMinutes: 24 * 60,
				repeatScheduleKind: 'next_day',
			}),
		[cap, periodPlan, wave],
	)

	const applyAction = (action: 'reducePauses' | 'disableRepeat' | 'shiftWindow', dateKey: string) => {
		if (!wave || !dateKey) return
		let nextWave = wave
		if (action === 'reducePauses') {
			applyRecommendedPauses({ alsoDisableRepeatIfNotFit: false })
		} else if (action === 'disableRepeat') {
			const adv = { ...wave.adv, repeatEnabled: false }
			persistWave({ ...wave, adv })
			nextWave = { ...wave, adv }
		} else if (action === 'shiftWindow') {
			const shifted = { ...wave, timeFrom: '08:00', timeTo: '23:59' }
			persistWave(shifted)
			nextWave = shifted
		}
		const now = Date.now()
		const next = { ...dayOverrides }
		next[dateKey] = { action, updatedAt: now }
		setDayOverrides(next)
		try {
			localStorage.setItem(LS_KEY_DAY_OVERRIDES, JSON.stringify(next))
		} catch {}
		setWave(nextWave)
		window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
		message.success('Изменения применены')
	}

	const clearDayOverrides = useCallback(() => {
		setDayOverrides({})
		try {
			localStorage.removeItem(LS_KEY_DAY_OVERRIDES)
		} catch {
			/* ignore */
		}
		message.success('Метки «правка» в календаре сброшены')
	}, [])

	const copyPlanningSnapshot = useCallback(async () => {
		try {
			const snap = collectTimingHubLocalSnapshot()
			const text = JSON.stringify(
				{ note: 'Снимок настроек планирования (без токенов)', ...snap },
				null,
				2,
			)
			await navigator.clipboard.writeText(text)
			message.success('Снимок скопирован в буфер обмена')
		} catch {
			message.error('Не удалось скопировать')
		}
	}, [])

	const applySmartToFit = useCallback((opts: { forceNoRepeat: boolean }) => {
		if (!cap || !wave) return

		const loScale = 0.15
		const hiScale = 1

		const baseAdv = wave.adv
		const advNoRepeatBase = { ...baseAdv, repeatEnabled: false } satisfies AdvSettings

		// Если уже успеваем.
		if (cap.fit) {
			if (!opts.forceNoRepeat) return
			// Для «1 волна за период» обязательно выключаем repeat, даже если паузы уже подходят.
			if (!wave.adv.repeatEnabled) return
			persistWave({ ...wave, adv: advNoRepeatBase })
			message.success('Повтор волны выключен: одна волна за выбранный период')
			return
		}

		if (opts.forceNoRepeat) {
			// Ищем паузы для «влезть в окно» ровно с repeatEnabled=false.
			const capLoNoRepeat = calcCapForAdv(scaleAdvBetweenGroups(advNoRepeatBase, loScale))
			if (!capLoNoRepeat || !capLoNoRepeat.fit) {
				const nextAdv = scaleAdvBetweenGroups(advNoRepeatBase, loScale)
				persistWave({ ...wave, adv: nextAdv })
				message.warning('Одна волна за период: даже минимальные паузы могут не помочь.')
				return
			}

			let lo = loScale
			let hi = hiScale
			for (let i = 0; i < 22; i++) {
				const mid = (lo + hi) / 2
				const midCap = calcCapForAdv(scaleAdvBetweenGroups(advNoRepeatBase, mid))
				if (!midCap) break
				if (midCap.fit) lo = mid
				else hi = mid
			}

			const bestAdv = scaleAdvBetweenGroups(advNoRepeatBase, lo)
			persistWave({ ...wave, adv: bestAdv })
			message.success('Подобрал паузы: одна волна за период')
			return
		}

		// «Обычный» режим: можно оставить repeat включенным, если влезает.
		// Важно: дальше все вычисления (бинпоиск) должны идти с одинаковым repeatEnabled.
		const capLoWithRepeat = calcCapForAdv(scaleAdvBetweenGroups(baseAdv, loScale))
		let searchAdv = baseAdv
		if (!capLoWithRepeat || !capLoWithRepeat.fit) {
			const capLoNoRepeat = calcCapForAdv(scaleAdvBetweenGroups(advNoRepeatBase, loScale))
			if (!capLoNoRepeat || !capLoNoRepeat.fit) {
				const nextAdv = scaleAdvBetweenGroups(advNoRepeatBase, loScale)
				persistWave({ ...wave, adv: nextAdv })
				message.warning('Даже на самых быстрых паузах есть риск не успеть — оставляю без повтора.')
				return
			}
			searchAdv = advNoRepeatBase
		}

		// Ищем максимальный scale, который всё ещё влезает в окно.
		let lo = loScale
		let hi = hiScale
		for (let i = 0; i < 22; i++) {
			const mid = (lo + hi) / 2
			const midCap = calcCapForAdv(scaleAdvBetweenGroups(searchAdv, mid))
			if (!midCap) break
			if (midCap.fit) lo = mid
			else hi = mid
		}

		const bestAdv = scaleAdvBetweenGroups(searchAdv, lo)
		persistWave({ ...wave, adv: bestAdv })
		message.success('Подобрал паузы так, чтобы волна влезла в окно.')
	}, [cap, wave, calcCapForAdv, persistWave])

	/** Подбор пауз под целевую длительность волны (секунды), общий для «Длит. волны» и ползунка в часах. */
	const applySmartToTargetSeconds = useCallback(
		(rawTargetSec: number) => {
			if (!cap || !wave) return
			const targetSec = Math.max(
				ETA_GOAL_MIN_MIN * 60,
				Math.min(ETA_GOAL_MAX_MIN * 60, Math.floor(rawTargetSec)),
			)

			const baseAdv = wave.adv
			const loScale = 0.15
			const hiScaleStart = 5

			const capLo = calcCapForAdv(scaleAdvBetweenGroups(baseAdv, loScale))
			const capHiStart = calcCapForAdv(scaleAdvBetweenGroups(baseAdv, hiScaleStart))
			if (!capLo || !capHiStart) return

			// Если целевое время быстрее возможного — ставим минимальные паузы.
			if (capLo.totalSec >= targetSec) {
				const nextAdv = scaleAdvBetweenGroups(baseAdv, loScale)
				persistWave({ ...wave, adv: nextAdv })
				scheduleTimingApplyFeedback('info', 'Цель слишком быстрая — применяю минимальные паузы.')
				return
			}

			// Если целевое время медленнее возможного — расширяем верхнюю границу scale.
			let hiScale = hiScaleStart
			let capHi = capHiStart
			let guard = 0
			while (capHi.totalSec < targetSec && hiScale < 220 && guard < 48) {
				guard++
				hiScale *= 1.35
				const nextCap = calcCapForAdv(scaleAdvBetweenGroups(baseAdv, hiScale))
				if (!nextCap) break
				capHi = nextCap
			}

			if (capHi.totalSec < targetSec) {
				const nextAdv = scaleAdvBetweenGroups(baseAdv, hiScale)
				persistWave({ ...wave, adv: nextAdv })
				scheduleTimingApplyFeedback(
					'info',
					'Цель слишком «медленная» для модели пауз — применяю максимально допустимые паузы.',
				)
				return
			}

			// Бинарный поиск по scale: totalSec растёт с scale.
			let lo = loScale
			let hi = hiScale
			for (let i = 0; i < 28; i++) {
				const mid = (lo + hi) / 2
				const midCap = calcCapForAdv(scaleAdvBetweenGroups(baseAdv, mid))
				if (!midCap) break
				if (midCap.totalSec < targetSec) lo = mid
				else hi = mid
			}

			const advLo = scaleAdvBetweenGroups(baseAdv, lo)
			const advHi = scaleAdvBetweenGroups(baseAdv, hi)
			const capAdvLo = calcCapForAdv(advLo)
			const capAdvHi = calcCapForAdv(advHi)
			if (!capAdvLo || !capAdvHi) return

			const pickAdv =
				Math.abs(capAdvLo.totalSec - targetSec) <= Math.abs(capAdvHi.totalSec - targetSec) ? advLo : advHi
			persistWave({ ...wave, adv: pickAdv })

			const finalCap = calcCapForAdv(pickAdv)
			if (finalCap?.fit)
				scheduleTimingApplyFeedback('success', 'Подобрал паузы под целевую длительность волны.')
			else
				scheduleTimingApplyFeedback(
					'warning',
					'Подобрал паузы под целевую длительность волны, но окно может не хватить.',
				)
		},
		[cap, wave, calcCapForAdv, persistWave],
	)

	const applySmartToEta = useCallback(() => {
		const targetMin = Math.max(
			ETA_GOAL_MIN_MIN,
			Math.min(ETA_GOAL_MAX_MIN, Math.floor(targetEtaMin || ETA_GOAL_MIN_MIN)),
		)
		applySmartToTargetSeconds(targetMin * 60)
	}, [targetEtaMin, applySmartToTargetSeconds])

	useEffect(() => {
		if (!open || !smartEnabled) return
		if (!wave || !cap) return
		if (counts.loading) return

		// Имитируем "запрос пользователя": применяем автоподстройку только когда изменились
		// цель/окно/режимы/набор скоростей/числа групп (но НЕ когда мы сами изменили паузы).
		const key = buildSmartAutonudgeKey({
			smartGoal,
			targetEtaMin,
			timeFrom: wave.timeFrom,
			timeTo: wave.timeTo,
			startMode,
			capacityMode,
			customBufferEnabled,
			customBufferMultiplier,
			tplEnabled: counts.tplEnabled,
			waSelected: counts.waSelected,
			tgSelected: counts.tgSelected,
			waSpeedFactors: counts.waSpeedFactors,
			tgSpeedFactors: counts.tgSpeedFactors,
		})

		if (suppressNextSmartAutonudgeRef.current) {
			suppressNextSmartAutonudgeRef.current = false
			smartAppliedKeyRef.current = key
			return
		}

		if (key === smartAppliedKeyRef.current) return
		smartAppliedKeyRef.current = key

		if (smartApplyingRef.current) return
		smartApplyingRef.current = true
		try {
			if (smartGoal === 'fit') applySmartToFit({ forceNoRepeat: false })
			else if (smartGoal === 'oneWave') applySmartToFit({ forceNoRepeat: true })
			else applySmartToEta()
		} finally {
			setTimeout(() => {
				smartApplyingRef.current = false
			}, 0)
		}
	}, [
		open,
		smartEnabled,
		smartGoal,
		targetEtaMin,
		wave,
		cap,
		counts.loading,
		counts.tplEnabled,
		counts.waSelected,
		counts.tgSelected,
		counts.waSpeedFactors,
		counts.tgSpeedFactors,
		startMode,
		capacityMode,
		customBufferEnabled,
		customBufferMultiplier,
		applySmartToFit,
		applySmartToEta,
	])

	useEffect(() => {
		if (!open) {
			didInitTargetRef.current = false
			smartAppliedKeyRef.current = ''
			suppressNextSmartAutonudgeRef.current = false
			return
		}
		if (smartGoal !== 'eta') return
		if (!cap) return
		if (didInitTargetRef.current) return
		setTargetEtaMin(
			Math.max(ETA_GOAL_MIN_MIN, Math.min(ETA_GOAL_MAX_MIN, Math.round(cap.totalSec / 60))),
		)
		didInitTargetRef.current = true
	}, [open, smartGoal, cap])

	const onTourStepChange = useCallback((current: number) => {
		if (current === 0 || current === 1) {
			setToolSection('plan')
		}
		if (current === 2) {
			setToolSection('advanced')
			setAdvancedCollapsed(false)
			persistAdvancedCollapsed(false)
		}
	}, [persistAdvancedCollapsed])

	/** Один источник для aria-label статуса (без дубля «По оценке…» + «Успеете» визуально). */
	const planningStatusText = useMemo(() => {
		if (!cap) return 'Статус планирования: нет данных'
		if (periodPlan) {
			if (cap.totalJobs <= 0) return 'Нет объёма: группы и шаблоны'
			return periodPlan.canFitGoal ? 'По оценке: успеете' : 'По оценке: риск не успеть'
		}
		return cap.fit ? 'По оценке: успеете' : 'По оценке: риск не успеть'
	}, [cap, periodPlan])

	/** Цель «Длит. волны» при выключенном автоподборе: фактическая длительность почти никогда не совпадёт со слайдером. */
	const etaTargetMismatch = useMemo(() => {
		if (smartGoal !== 'eta' || !cap || cap.totalJobs <= 0) return false
		if (smartEnabled) return false
		const targetSec = Math.max(ETA_GOAL_MIN_MIN * 60, Math.min(ETA_GOAL_MAX_MIN * 60, Math.floor(targetEtaMin) * 60))
		return Math.abs(cap.totalSec - targetSec) > 120
	}, [smartGoal, cap, smartEnabled, targetEtaMin])

	/** Длительность суточного окна (от «с» до «до») — для подсказки во вкладке «Окно и паузы». */
	const sendWindowDurationLabel = useMemo(() => {
		if (!wave) return null
		const from = dayjs(wave.timeFrom, 'HH:mm')
		const to = dayjs(wave.timeTo, 'HH:mm')
		let diff = to.diff(from, 'minute')
		if (diff < 0) diff += 24 * 60
		if (diff <= 0) return null
		const h = Math.floor(diff / 60)
		const m = diff % 60
		if (h <= 0) return `${m} мин`
		return m > 0 ? `${h} ч ${m} мин` : `${h} ч`
	}, [wave])

	/** Краткое предупреждение только при несоответствии окну. */
	const waveHorizonSummary = useMemo(() => {
		if (!cap) return null
		const winSec = cap.winSec
		const goalSec = Math.max(
			ETA_GOAL_MIN_MIN * 60,
			Math.min(ETA_GOAL_MAX_MIN * 60, Math.floor(targetEtaMin) * 60),
		)

		let line: string | null = null
		if (!cap.fit) {
			line = 'Не влезает в суточное окно — откройте «Окно и паузы».'
		} else if (cap.totalSec > winSec) {
			line = 'Волна длиннее окна — расклад по дням в календаре.'
		} else if (goalSec > winSec) {
			line = 'Цель длиннее окна — смотрите календарь.'
		}
		return line ? { line } : null
	}, [cap, targetEtaMin])

	const drawerTitle = useMemo(
		() => (
			<div className='timing-hub-drawer__titleRow timing-hub-drawer__titleRow--withActions'>
				<div className='timing-hub-drawer__titleText'>
					<p id='timing-hub-drawer-title' className='timing-hub-drawer__titleMain'>
						Планирование
					</p>
				</div>
				<Space.Compact className='timing-hub-drawer__titleTourCompact'>
					<Button
						type='text'
						className='timing-hub-drawer__titleTourBtn'
						size='small'
						icon={<QuestionCircleOutlined />}
						aria-label='Краткий обзор панели'
						disabled={counts.loading || !wave}
						onClick={openTimingHubTour}
					>
						Обзор
					</Button>
					<Dropdown
						trigger={['click']}
						getPopupContainer={(n) => n.closest('.ant-drawer-header') ?? document.body}
						menu={{
							items: [
								{
									key: 'reset',
									label: 'Сбросить авто-тур',
									onClick: () => resetTimingHubTourFlag(),
								},
							],
						}}
					>
						<Button
							type='text'
							className='timing-hub-drawer__titleTourBtn timing-hub-drawer__titleTourBtn--caret'
							size='small'
							icon={<DownOutlined />}
							aria-label='Меню: сброс авто-тура'
							disabled={counts.loading || !wave}
						/>
					</Dropdown>
				</Space.Compact>
			</div>
		),
		[openTimingHubTour, resetTimingHubTourFlag, counts.loading, wave],
	)

	return (
		<Drawer
			title={drawerTitle}
			placement='right'
			width={drawerViewportNarrow ? '100%' : 'min(520px, 100vw)'}
			open={open}
			onClose={closeDrawer}
			keyboard
			rootClassName='timing-hub-drawer'
			styles={{ body: { paddingTop: 0 } }}
			aria-labelledby='timing-hub-drawer-title'
			data-testid='timing-hub-drawer'
		>
			<ConfigProvider getPopupContainer={(node) => timingHubGetPopupContainer(node as HTMLElement)}>
			{open ? (
				<div className='timing-hub-toolNav' role='navigation' aria-label='Разделы планирования'>
					<Segmented
						block
						size='small'
						value={toolSection}
						onChange={(v) => scrollToToolSection(v as TimingHubToolSection)}
						options={
							showManualAdvanced
								? [{ label: 'Прогноз', value: 'plan' }, { label: 'Окно и паузы', value: 'advanced' }]
								: [{ label: 'Прогноз', value: 'plan' }]
						}
					/>
				</div>
			) : null}
			{/* Настройки (окно + паузы) */}
			<div id='timing-hub-section-settings' style={{ width: '100%', marginTop: 14, borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 12 }}>
				{/* Интегрированная сводка прямо в настройку волны */}
				{counts.loading || !wave || !cap ? (
					<div
						className='timing-hub-plan__skeletonWrap'
						style={{ padding: '10px 0 0' }}
						aria-busy='true'
						aria-label='Загрузка планирования'
						role='status'
					>
						<div
							style={{
								padding: '14px 14px 16px',
								borderRadius: 14,
								background: 'rgba(255,255,255,0.5)',
								border: '1px solid rgba(0,0,0,0.08)',
								marginBottom: 12,
							}}
						>
							<Skeleton active title={{ width: '48%' }} paragraph={{ rows: 5 }} />
						</div>
						<div
							style={{
								padding: '14px 14px 16px',
								borderRadius: 14,
								background: 'rgba(255,255,255,0.62)',
								border: '1px solid rgba(0,0,0,0.09)',
								marginBottom: 12,
							}}
						>
							<Skeleton active title={{ width: '42%' }} paragraph={{ rows: 6 }} />
						</div>
						<Skeleton active title={{ width: '36%' }} paragraph={{ rows: 4 }} />
					</div>
				) : (
					<>
						{toolSection === 'plan' && (
						<>
						<div className='timing-hub-plan__card' ref={tourPlanRef}>
							<TimingHubPeriodCalendarControl
								fixedCalendarDays={fixedCalendarDays}
								onFixedCalendarDaysChange={setFixedCalendarDays}
							/>

							<div className='timing-hub-plan__master' style={{ marginTop: 10, padding: 12 }}>
								<div style={{ fontSize: 12.5, lineHeight: 1.45, opacity: 0.92 }}>
									<b>Группы:</b> TG {counts.tgSelected} · WA {counts.waSelected} · <b>Шаблоны:</b> {counts.tplEnabled}
									<br />
									<b>Объём волны:</b> {cap.totalJobs} сообщ. · <b>Оценка:</b> {cap.etaHuman}
								</div>
								<Space wrap size={[8, 8]} style={{ marginTop: 10 }}>
									<Button size='small' type='primary' onClick={() => scrollToToolSection('advanced')}>
										Открыть «Окно и паузы»
									</Button>
									<Button
										size='small'
										type='link'
										onClick={() => {
											setShowManualAdvanced(true)
											scrollToToolSection('advanced')
										}}
									>
										Ручная настройка
									</Button>
								</Space>
							</div>

							<TimingHubItogCardLazy
								tourItogRef={tourItogRef}
								cap={cap}
								periodPlan={periodPlan}
								waveForecast={waveForecast}
								seriesEndCard={seriesEndCard}
								planningStatusText={planningStatusText}
								clientVolumeBreakdown={clientVolumeBreakdown}
								rhythmOneLiner={rhythmOneLiner}
								smartGoal={smartGoal}
								targetEtaMin={targetEtaMin}
								smartEnabled={smartEnabled}
								etaTargetMismatch={etaTargetMismatch}
								planningPeriodSummary={planningPeriodSummary}
								startMode={startMode}
								customBufferEnabled={customBufferEnabled}
								customBufferMultiplier={customBufferMultiplier}
								capacityMode={capacityMode}
								counts={{
									waTargetsSummary: counts.waTargetsSummary,
									tgTargetsSummary: counts.tgTargetsSummary,
								}}
								sendTimeWarning={sendTimeWarning}
								needsPlanningFix={needsPlanningFix}
								onPlanningFixFull={() => {
									setSmartEnabled(true)
									smartAppliedKeyRef.current = ''
									didInitTargetRef.current = false
									if (smartGoal === 'oneWave') {
										applyRecommendedPauses({ alsoDisableRepeatIfNotFit: true, forceDisableRepeat: true })
									} else if (!cap.fit) {
										applyRecommendedPauses({ alsoDisableRepeatIfNotFit: true })
									} else {
										applyRecommendedPauses({ alsoDisableRepeatIfNotFit: false })
									}
								}}
								onPlanningFixPauses={() => {
									setSmartEnabled(false)
									applyRecommendedPauses({
										alsoDisableRepeatIfNotFit: false,
										forceDisableRepeat: smartGoal === 'oneWave',
									})
								}}
							/>
							{periodPlan ? (
								<TimingHubLoadCalendarLazy
									periodPlan={periodPlan}
									planningPeriodSummary={planningPeriodSummary}
									smartGoal={smartGoal}
									calendarMode={calendarMode}
									onCalendarModeChange={setCalendarMode}
									calendarDayRows={calendarDayRows}
									calendarWeekCards={calendarWeekCards}
									dayLoadPercent={dayLoadPercent}
									getDayStatus={getDayStatus}
									getLoadColor={getLoadColor}
									selectedDayKey={selectedDayKey}
									onSelectDayKey={setSelectedDayKey}
									dayOverrides={dayOverrides}
									onClearDayOverrides={clearDayOverrides}
									selectedDay={selectedDay}
									dayNeedsQuickFix={dayNeedsQuickFix}
									riskReasonForDay={riskReasonForDay}
									onApplyDayAction={applyAction}
									waveTimeFrom={wave.timeFrom}
									waveTimeTo={wave.timeTo}
									cap={cap}
									onScrollToAdvanced={() => scrollToToolSection('advanced')}
								/>
							) : null}
						</div>
						</>
						)}

						{toolSection === 'advanced' && wave && cap ? (
							<TimingHubAdvancedTabLazy
								tourAdvancedRef={tourAdvancedRef}
								wave={wave}
								smartEnabled={smartEnabled}
								cap={cap}
								targetEtaMin={targetEtaMin}
								waveHorizonSummary={waveHorizonSummary}
								sendWindowDurationLabel={sendWindowDurationLabel}
								capacityMode={capacityMode}
								customBufferEnabled={customBufferEnabled}
								customBufferMultiplier={customBufferMultiplier}
								onCapacitySegmentChange={(next) => {
									if (next === 'custom') {
										setCustomBufferEnabled(true)
										return
									}
									setCustomBufferEnabled(false)
									setCapacityMode(next as CapacityMode)
									setCustomBufferMultiplier(next === 'safe' ? 1.35 : 1.0)
								}}
								onCustomBufferMultiplierChange={setCustomBufferMultiplier}
								persistWave={persistWave}
								onScrollToPlan={() => scrollToToolSection('plan')}
								onResetToAutoDefaults={() => {
									setSmartEnabled(true)
									smartAppliedKeyRef.current = ''
									didInitTargetRef.current = false
									setCustomBufferEnabled(false)
									setCapacityMode('safe')
									setCustomBufferMultiplier(1.35)
									message.info('Включён автоподбор и запас «С запасом» (1.35). Настройте цель на вкладке «Прогноз».')
									scrollToToolSection('plan')
								}}
								onSettingsAcknowledged={() => {
									window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
									message.success('Настройки учтены')
								}}
							/>
						) : null}

						
					</>
				)}
			</div>

			<Tour
				open={tourOpen}
				onClose={dismissTimingHubTour}
				onFinish={dismissTimingHubTour}
				onChange={onTourStepChange}
				steps={tourSteps}
				gap={{ offset: 6, radius: 10 }}
				actionsRender={(originNode) => (
					<div className='timing-hub-tour__actions'>
						<Button type='link' size='small' onClick={dismissTimingHubTour}>
							Пропустить тур
						</Button>
						<div className='timing-hub-tour__actionsMain'>{originNode}</div>
					</div>
				)}
			/>
			</ConfigProvider>
		</Drawer>
	)
}

