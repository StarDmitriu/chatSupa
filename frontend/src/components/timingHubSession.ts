import type { StartMode } from '@/lib/campaignCapacity'

/** Кабинет → dashboard: открыть планирование и (опционально) тур */
export const TIMING_HUB_POST_NAV_KEY = 'timingHub_postNavigate'
export const TIMING_HUB_DEFERRED_TOUR_KEY = 'timingHub_deferredTour'

/** Канал прогноза = режим «Запуск» на /dashboard/campaigns (TG+WA / только TG / только WA). */
export const LS_KEY_TIMING_START_MODE = 'campaigns_timing_start_mode_v1'

export function readTimingStartMode(): StartMode {
	if (typeof window === 'undefined') return 'both'
	try {
		const v = localStorage.getItem(LS_KEY_TIMING_START_MODE)
		if (v === 'wa' || v === 'tg' || v === 'both') return v
	} catch {
		/* ignore */
	}
	return 'both'
}

export function writeTimingStartMode(mode: StartMode): void {
	try {
		localStorage.setItem(LS_KEY_TIMING_START_MODE, mode)
	} catch {
		/* ignore */
	}
}
