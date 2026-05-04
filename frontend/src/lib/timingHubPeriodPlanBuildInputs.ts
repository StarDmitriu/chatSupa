import type { Dayjs } from 'dayjs'

import type { TimingHubPeriodPreset } from '@/lib/timingHubPeriodPlanCompute'

/**
 * Подготавливает поля периода для `buildPeriodPlan` из UI-выбора.
 * Важно: поведение совпадает с тем, что было внутри `TimingHubDrawer`.
 */
export function buildPeriodPlanPeriodFields(p: {
	periodPreset: 'fixed' | 'custom'
	customPeriodRange: [Dayjs, Dayjs] | null
}): {
	periodPreset: Extract<TimingHubPeriodPreset, 'fixed' | 'custom'>
	customPeriodRange: [Dayjs, Dayjs] | null
} {
	if (p.periodPreset === 'custom') {
		return {
			periodPreset: 'custom',
			customPeriodRange: p.customPeriodRange,
		}
	}

	return {
		periodPreset: 'fixed',
		customPeriodRange: null,
	}
}

