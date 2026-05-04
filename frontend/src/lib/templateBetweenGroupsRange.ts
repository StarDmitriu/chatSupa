import { SERVER_BETWEEN_GROUPS_SEC } from '@/lib/campaignBetweenGroupsServerBase'
import { clampTemplateSpeedFactor } from '@/lib/templateSpeedFactorUi'

const PAUSE_SEC_LO = 5
const PAUSE_SEC_HI = 600

/** Два ползунка «от–до» для шаблона: одна пара на канал. */
export function clampTemplatePauseSecPair(lo: number, hi: number): [number, number] {
	const a = Math.max(PAUSE_SEC_LO, Math.min(PAUSE_SEC_HI, Math.floor(lo)))
	const b = Math.max(PAUSE_SEC_LO, Math.min(PAUSE_SEC_HI, Math.floor(hi)))
	return a <= b ? [a, b] : [b, a]
}

/** Для submit формы: при NaN/undefined (скрытые поля не попали в onFinish) — база сервера по каналу. */
export function clampPausePairFromFormValues(
	channel: 'wa' | 'tg',
	lo: unknown,
	hi: unknown,
): [number, number] {
	const [dLo, dHi] =
		channel === 'tg' ? SERVER_BETWEEN_GROUPS_SEC.tg : SERVER_BETWEEN_GROUPS_SEC.wa
	const a = Number(lo)
	const b = Number(hi)
	if (!Number.isFinite(a) || !Number.isFinite(b)) {
		return clampTemplatePauseSecPair(dLo, dHi)
	}
	return clampTemplatePauseSecPair(a, b)
}

/** Для старых шаблонов без явного диапазона — из % и базы сервера. */
export function derivePauseSecPairFromLegacySpeed(
	channel: 'tg' | 'wa',
	speedFactor: unknown,
): [number, number] {
	const [baseLo, baseHi] =
		channel === 'tg' ? SERVER_BETWEEN_GROUPS_SEC.tg : SERVER_BETWEEN_GROUPS_SEC.wa
	const sf = clampTemplateSpeedFactor(speedFactor, 100)
	const k = 100 / sf
	return clampTemplatePauseSecPair(Math.round(baseLo * k), Math.round(baseHi * k))
}

export function readTemplatePausePairFromApi(
	channel: 'tg' | 'wa',
	row: Record<string, unknown>,
	speedFallback: unknown,
): [number, number] {
	const minK = channel === 'tg' ? 'tg_between_groups_sec_min' : 'wa_between_groups_sec_min'
	const maxK = channel === 'tg' ? 'tg_between_groups_sec_max' : 'wa_between_groups_sec_max'
	const lo = row[minK]
	const hi = row[maxK]
	if (typeof lo === 'number' && typeof hi === 'number' && Number.isFinite(lo) && Number.isFinite(hi)) {
		return clampTemplatePauseSecPair(lo, hi)
	}
	return derivePauseSecPairFromLegacySpeed(channel, speedFallback)
}

/**
 * Паузы «от–до» для нового шаблона и fallback ползунков (ещё нет полей в БД, скорость 100 %).
 * Совпадает с readTemplatePausePairFromApi без явных wa_/tg_between_groups_sec_*.
 */
export const TEMPLATE_FORM_DEFAULT_PAUSE = {
	wa: readTemplatePausePairFromApi('wa', {}, 100),
	tg: readTemplatePausePairFromApi('tg', {}, 100),
} as const

/** Синтетический speed % для единых формул вместо явного диапазона (планирование). */
export function equivalentSpeedFactorFromPauseMidpoint(channel: 'tg' | 'wa', midSec: number): number {
	const [baseLo, baseHi] =
		channel === 'tg' ? SERVER_BETWEEN_GROUPS_SEC.tg : SERVER_BETWEEN_GROUPS_SEC.wa
	const baseMid = (baseLo + baseHi) / 2
	const m = Math.max(1, midSec)
	const raw = (100 * baseMid) / m
	return Math.max(10, Math.min(400, Math.round(raw)))
}
