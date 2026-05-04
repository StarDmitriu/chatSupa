import { SERVER_BETWEEN_GROUPS_SEC } from '@/lib/campaignBetweenGroupsServerBase'

/** Совпадает с templates.service / campaigns.worker clamp */
export const TEMPLATE_SPEED_FACTOR_MIN = 10
export const TEMPLATE_SPEED_FACTOR_MAX = 400

function clampInt(n: unknown, lo: number, hi: number, def: number): number {
	const x = Number(n)
	if (!Number.isFinite(x)) return def
	return Math.max(lo, Math.min(hi, Math.floor(x)))
}

/** Коэффициент % для UI и сохранения (как на бэкенде). */
export function clampTemplateSpeedFactor(v: unknown, def = 100): number {
	return clampInt(v, TEMPLATE_SPEED_FACTOR_MIN, TEMPLATE_SPEED_FACTOR_MAX, def)
}

/**
 * speedFactor: 100 = базово; 200 ≈ в 2 раза быстрее; 50 ≈ в 2 раза медленнее.
 * Формула как на сервере: round(base * (100 / sf)).
 */
export function approxBetweenGroupsSeconds(
	baseMinSec: number,
	baseMaxSec: number,
	speedFactor: unknown,
): { minSec: number; maxSec: number } {
	const sf = clampTemplateSpeedFactor(speedFactor, 100)
	const k = 100 / sf
	const minSec = Math.max(1, Math.round((Number(baseMinSec) || 0) * k))
	const maxSec = Math.max(1, Math.round((Number(baseMaxSec) || 0) * k))
	return { minSec: Math.min(minSec, maxSec), maxSec: Math.max(minSec, maxSec) }
}

export function formatApproxPauseTag(channel: 'tg' | 'wa', speedFactor: unknown): string {
	const [lo, hi] = channel === 'tg' ? SERVER_BETWEEN_GROUPS_SEC.tg : SERVER_BETWEEN_GROUPS_SEC.wa
	const { minSec, maxSec } = approxBetweenGroupsSeconds(lo, hi, speedFactor)
	const sf = clampTemplateSpeedFactor(speedFactor, 100)
	return `~${minSec}–${maxSec} с · ${sf}%`
}

/** Разреженные подписи для длинного диапазона 10–400. */
export function mkTemplateSpeedSliderMarks(channel: 'tg' | 'wa'): Record<number, string> {
	const [bMin, bMax] = channel === 'tg' ? SERVER_BETWEEN_GROUPS_SEC.tg : SERVER_BETWEEN_GROUPS_SEC.wa
	return {
		[TEMPLATE_SPEED_FACTOR_MIN]: 'медленнее',
		100: `${bMin}–${bMax} с`,
		[TEMPLATE_SPEED_FACTOR_MAX]: 'быстрее',
	}
}
