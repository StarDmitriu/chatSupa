import type { Dayjs } from 'dayjs'

import { ruDayCountLabel } from '@/lib/timingHubFormat'

export type TimingHubPeriodEcho = {
	main: string
	sub: string
}

export type BuildCalendarPeriodEchoInput = {
	periodPreset: 'fixed' | 'custom'
	fixedCalendarDays: number
	customPeriodRange: [Dayjs, Dayjs] | null
	selectedPeriodDays: number
}

/**
 * Подпись периода календаря (используется в блоке «горизонт волны»).
 * Вынесено из `TimingHubDrawer` в отдельную чистую функцию, чтобы не раздувать компонент.
 */
export function buildCalendarPeriodEcho(p: BuildCalendarPeriodEchoInput): TimingHubPeriodEcho {
	const hint = 'Период переключается блоком выше; эта подпись обновляется вместе с ним.'
	const span = ruDayCountLabel(p.selectedPeriodDays)

	if (p.periodPreset === 'fixed') {
		const main =
			p.fixedCalendarDays === 1
				? 'Период календаря: сегодня'
				: `Период календаря: ${ruDayCountLabel(p.fixedCalendarDays)}`
		return { main, sub: `${span} в сетке · ${hint}` }
	}

	if (p.periodPreset === 'custom' && p.customPeriodRange) {
		const [a, b] = p.customPeriodRange
		return {
			main: `Период календаря: ${a.format('DD.MM.YYYY')} — ${b.format('DD.MM.YYYY')}`,
			sub: `${span} · свой диапазон. ${hint}`,
		}
	}

	return { main: 'Период календаря: —', sub: hint }
}

