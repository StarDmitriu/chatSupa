import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'

import { buildCalendarPeriodEcho } from '@/lib/timingHubCalendarPeriodEcho'

describe('buildCalendarPeriodEcho', () => {
	it('fixed=1 формирует «сегодня»', () => {
		const r = buildCalendarPeriodEcho({
			periodPreset: 'fixed',
			fixedCalendarDays: 1,
			customPeriodRange: null,
			selectedPeriodDays: 1,
		})
		expect(r.main).toBe('Период календаря: сегодня')
		expect(r.sub).toContain('1 день в сетке')
	})

	it('fixed=7 формирует «7 дней»', () => {
		const r = buildCalendarPeriodEcho({
			periodPreset: 'fixed',
			fixedCalendarDays: 7,
			customPeriodRange: null,
			selectedPeriodDays: 7,
		})
		expect(r.main).toBe('Период календаря: 7 дней')
		expect(r.sub).toContain('7 дней в сетке')
	})

	it('custom формирует диапазон дат', () => {
		const a = dayjs('2026-03-01').startOf('day')
		const b = dayjs('2026-03-10').startOf('day')
		const r = buildCalendarPeriodEcho({
			periodPreset: 'custom',
			fixedCalendarDays: 7,
			customPeriodRange: [a, b],
			selectedPeriodDays: 10,
		})
		expect(r.main).toBe('Период календаря: 01.03.2026 — 10.03.2026')
		expect(r.sub).toContain('10 дней')
		expect(r.sub).toContain('свой диапазон')
	})

	it('custom без диапазона даёт «—»', () => {
		const r = buildCalendarPeriodEcho({
			periodPreset: 'custom',
			fixedCalendarDays: 7,
			customPeriodRange: null,
			selectedPeriodDays: 7,
		})
		expect(r.main).toBe('Период календаря: —')
	})
})

