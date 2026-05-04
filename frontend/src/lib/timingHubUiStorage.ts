import type { CapacityMode } from '@/lib/campaignCapacity'

/** Сохраняется между закрытиями панели (вкладка браузера). */
export const SS_KEY_TIMING_HUB_UI = 'timing_hub_session_ui_v1'

export type TimingHubToolSection = 'plan' | 'advanced' | 'help'

export type StoredSmartGoal = 'oneWave' | 'fit' | 'eta'

/** `fixed` — число дней из ползунка (1–30); старые today/3d/7d/30d читаются при открытии панели. */
export type StoredPeriodPreset = 'today' | '3d' | '7d' | '30d' | 'custom' | 'fixed'

export type TimingHubSessionUi = {
	toolSection?: TimingHubToolSection
	smartGoal?: StoredSmartGoal
	/** Автоподбор пауз под мастер / цели */
	smartEnabled?: boolean
	periodPreset?: StoredPeriodPreset
	/** При `periodPreset === 'fixed'`: сколько дней в сетке (1–30). */
	fixedCalendarDays?: number
	calendarMode?: 'days' | 'list' | 'weeks'
	targetEtaMin?: number
	/** YYYY-MM-DD для custom периода */
	customRange?: [string, string]
}

export function readTimingHubSessionUi(): TimingHubSessionUi | null {
	if (typeof window === 'undefined') return null
	try {
		const raw = sessionStorage.getItem(SS_KEY_TIMING_HUB_UI)
		if (!raw) return null
		const v = JSON.parse(raw) as TimingHubSessionUi
		return v && typeof v === 'object' ? v : null
	} catch {
		return null
	}
}

export function writeTimingHubSessionUi(patch: Partial<TimingHubSessionUi>): void {
	if (typeof window === 'undefined') return
	try {
		const prev = readTimingHubSessionUi() ?? {}
		const next: TimingHubSessionUi = { ...prev, ...patch }
		if (next.periodPreset !== 'custom') {
			delete next.customRange
		}
		sessionStorage.setItem(SS_KEY_TIMING_HUB_UI, JSON.stringify(next))
	} catch {
		/* ignore */
	}
}

/** Режим оценки времени + тонкий коэф. — переживают F5. */
export const LS_KEY_TIMING_HUB_CAPACITY = 'timing_hub_capacity_v1'

export type TimingHubCapacityStored = {
	capacityMode: CapacityMode
	customBufferEnabled: boolean
	customBufferMultiplier: number
}

export function readTimingHubCapacity(): TimingHubCapacityStored | null {
	if (typeof window === 'undefined') return null
	try {
		const raw = localStorage.getItem(LS_KEY_TIMING_HUB_CAPACITY)
		if (!raw) return null
		const v = JSON.parse(raw) as TimingHubCapacityStored
		if (!v || typeof v !== 'object') return null
		if (v.capacityMode !== 'optimistic' && v.capacityMode !== 'safe') return null
		const mult = Number(v.customBufferMultiplier)
		if (!Number.isFinite(mult)) return null
		return {
			capacityMode: v.capacityMode,
			customBufferEnabled: Boolean(v.customBufferEnabled),
			customBufferMultiplier: Math.max(1, Math.min(1.7, mult)),
		}
	} catch {
		return null
	}
}

export function writeTimingHubCapacity(v: TimingHubCapacityStored): void {
	try {
		localStorage.setItem(LS_KEY_TIMING_HUB_CAPACITY, JSON.stringify(v))
	} catch {
		/* ignore */
	}
}

/** Снимок ключей localStorage для поддержки (без токенов). */
export const TIMING_HUB_SNAPSHOT_KEYS = [
	'campaigns_time_window_v2',
	'campaigns_adv_settings_v1',
	'campaigns_timing_start_mode_v1',
	'campaigns_day_overrides_v1',
	'timing_hub_advanced_collapsed_v1',
	LS_KEY_TIMING_HUB_CAPACITY,
	SS_KEY_TIMING_HUB_UI,
] as const

export function collectTimingHubLocalSnapshot(): Record<string, string | null> {
	const out: Record<string, string | null> = {}
	if (typeof window === 'undefined') return out
	for (const k of TIMING_HUB_SNAPSHOT_KEYS) {
		try {
			if (k === SS_KEY_TIMING_HUB_UI) {
				out[k] = sessionStorage.getItem(k)
			} else {
				out[k] = localStorage.getItem(k)
			}
		} catch {
			out[k] = null
		}
	}
	return out
}
