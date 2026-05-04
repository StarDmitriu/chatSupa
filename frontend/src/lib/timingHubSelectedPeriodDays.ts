import type { Dayjs } from 'dayjs'

/**
 * Чистый расчёт числа дней в календарной сетке.
 * Важно: поведение совпадает с тем, что было внутри `TimingHubDrawer`.
 */
export function computeSelectedPeriodDays(p: {
	periodPreset: 'fixed' | 'custom'
	fixedCalendarDays: number
	customPeriodRange: [Dayjs, Dayjs] | null
}): number {
	if (p.periodPreset === 'custom') {
		if (!p.customPeriodRange) return 7
		const [from, to] = p.customPeriodRange
		return Math.max(1, to.startOf('day').diff(from.startOf('day'), 'day') + 1)
	}
	return Math.max(1, Math.min(30, p.fixedCalendarDays))
}

