import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'

import { computeSelectedPeriodDays } from '@/lib/timingHubSelectedPeriodDays'

describe('computeSelectedPeriodDays', () => {
	it('fixed: clamp 1..30', () => {
		expect(
			computeSelectedPeriodDays({
				periodPreset: 'fixed',
				fixedCalendarDays: 0,
				customPeriodRange: null,
			}),
		).toBe(1)

		expect(
			computeSelectedPeriodDays({
				periodPreset: 'fixed',
				fixedCalendarDays: 31,
				customPeriodRange: null,
			}),
		).toBe(30)

		expect(
			computeSelectedPeriodDays({
				periodPreset: 'fixed',
				fixedCalendarDays: 7,
				customPeriodRange: null,
			}),
		).toBe(7)
	})

	it('custom: null range -> 7', () => {
		expect(
			computeSelectedPeriodDays({
				periodPreset: 'custom',
				fixedCalendarDays: 7,
				customPeriodRange: null,
			}),
		).toBe(7)
	})

	it('custom: diff days + 1', () => {
		const from = dayjs('2026-03-01').startOf('day')
		const to = dayjs('2026-03-10').startOf('day')
		expect(
			computeSelectedPeriodDays({
				periodPreset: 'custom',
				fixedCalendarDays: 7,
				customPeriodRange: [from, to],
			}),
		).toBe(10)
	})
})

