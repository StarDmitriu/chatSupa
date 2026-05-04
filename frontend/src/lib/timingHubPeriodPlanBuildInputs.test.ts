import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'

import { buildPeriodPlanPeriodFields } from '@/lib/timingHubPeriodPlanBuildInputs'

describe('buildPeriodPlanPeriodFields', () => {
	it('fixed => fixed + customPeriodRange null', () => {
		const r = buildPeriodPlanPeriodFields({
			periodPreset: 'fixed',
			customPeriodRange: [dayjs('2026-01-01'), dayjs('2026-01-02')],
		})
		expect(r.periodPreset).toBe('fixed')
		expect(r.customPeriodRange).toBeNull()
	})

	it('custom => custom + customPeriodRange passthrough', () => {
		const a = dayjs('2026-03-01').startOf('day')
		const b = dayjs('2026-03-10').startOf('day')
		const r = buildPeriodPlanPeriodFields({
			periodPreset: 'custom',
			customPeriodRange: [a, b],
		})
		expect(r.periodPreset).toBe('custom')
		expect(r.customPeriodRange?.[0].isSame(a)).toBe(true)
		expect(r.customPeriodRange?.[1].isSame(b)).toBe(true)
	})
})

