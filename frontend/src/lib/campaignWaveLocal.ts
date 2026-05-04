/**
 * Окно отправки и флаг повтора в localStorage (страница рассылок, планирование, сводка timing).
 */
import type { AdvSettings } from '@/lib/campaignCapacity'

export const LS_KEY_CAMPAIGN_TIME_WINDOW = 'campaigns_time_window_v2'
export const LS_KEY_CAMPAIGN_ADV = 'campaigns_adv_settings_v1'

export function safeParseJson(v: string | null): unknown {
	try {
		return v ? JSON.parse(v) : null
	} catch {
		return null
	}
}

export function normalizeTimeHm(s: unknown, fallback: string): string {
	const str = String(s || '').trim()
	const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(str)
	return m ? `${m[1]}:${m[2]}` : fallback
}

export function readLocalWaveSettings(): { timeFrom: string; timeTo: string; adv: AdvSettings } {
	if (typeof window === 'undefined') {
		return {
			timeFrom: '00:00',
			timeTo: '23:59',
			adv: { repeatEnabled: true },
		}
	}

	const savedWin = safeParseJson(localStorage.getItem(LS_KEY_CAMPAIGN_TIME_WINDOW)) as {
		timeFrom?: unknown
		timeTo?: unknown
	} | null
	const savedAdv = safeParseJson(localStorage.getItem(LS_KEY_CAMPAIGN_ADV)) as Record<string, unknown> | null

	const timeFrom = normalizeTimeHm(savedWin?.timeFrom, '00:00')
	const timeTo = normalizeTimeHm(savedWin?.timeTo, '23:59')

	const adv: AdvSettings = {
		repeatEnabled: savedAdv?.repeatEnabled === false ? false : true,
	}

	return { timeFrom, timeTo, adv }
}

/** Плоская форма для страницы /dashboard/campaigns/timing */
export type TimingPageLocalWave = {
	timeFrom: string
	timeTo: string
	repeatEnabled: boolean
}

export function waveSettingsToTimingPageShape(w: ReturnType<typeof readLocalWaveSettings>): TimingPageLocalWave {
	return {
		timeFrom: w.timeFrom,
		timeTo: w.timeTo,
		repeatEnabled: w.adv.repeatEnabled,
	}
}

/**
 * Раньше подставляли «рекомендованные паузы»; паузы теперь только в шаблонах — правим только повтор при необходимости.
 */
export function mergeAdvWithRecommendedPauses(
	prev: AdvSettings,
	_tgBetweenGroups: [number, number],
	_waBetweenGroups: [number, number],
	opts: { alsoDisableRepeatIfNotFit: boolean; forceDisableRepeat?: boolean; capFit: boolean },
): AdvSettings {
	const repeatEnabled =
		opts.forceDisableRepeat === true
			? false
			: opts.alsoDisableRepeatIfNotFit && !opts.capFit
				? false
				: prev.repeatEnabled
	return { repeatEnabled }
}
