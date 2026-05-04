import type { AdvSettings, CapacityMode, StartMode } from '@/lib/campaignCapacity'
import { computeCapacity } from '@/lib/campaignCapacity'
import { mergeBothChannelCapacity } from '@/lib/timingHubBothChannelCapacity'

/** Срез `counts`, достаточный для пересчёта ёмкости при кандидатных паузах (smart-подбор). */
export type TimingHubAdvCapacityCounts = {
	tplEnabled: number
	waSelected: number
	tgSelected: number
	waSpeedFactors: number[]
	tgSpeedFactors: number[]
	waTargetsSummary: null | { templatesWithAnyTargetsIntersect?: number }
	tgTargetsSummary: null | { templatesWithAnyTargetsIntersect?: number }
}

/**
 * Ёмкость для произвольного `adv` при текущем окне и режимах — то же, что `calcCapForAdv` в drawer.
 */
export function computeCapacityForAdvCandidate(p: {
	adv: AdvSettings
	timeFrom: string
	timeTo: string
	startMode: StartMode
	capacityMode: CapacityMode
	bufferMultiplier?: number
	counts: TimingHubAdvCapacityCounts
}) {
	const { adv, timeFrom, timeTo, startMode, capacityMode, bufferMultiplier, counts } = p

	const effectiveWaTpl = counts.waTargetsSummary?.templatesWithAnyTargetsIntersect ?? counts.tplEnabled
	const effectiveTgTpl = counts.tgTargetsSummary?.templatesWithAnyTargetsIntersect ?? counts.tplEnabled

	const common = {
		adv,
		timeFrom,
		timeTo,
		capacityMode,
		bufferMultiplier,
		waSpeedFactors: counts.waSpeedFactors,
		tgSpeedFactors: counts.tgSpeedFactors,
		parallelChannels: true,
	}

	if (startMode === 'wa') {
		return computeCapacity({
			...common,
			templatesCount: effectiveWaTpl,
			waSelectedCount: counts.waSelected,
			tgSelectedCount: counts.tgSelected,
			startMode: 'wa',
		})
	}

	if (startMode === 'tg') {
		return computeCapacity({
			...common,
			templatesCount: effectiveTgTpl,
			waSelectedCount: counts.waSelected,
			tgSelectedCount: counts.tgSelected,
			startMode: 'tg',
		})
	}

	const capWa = computeCapacity({
		...common,
		templatesCount: effectiveWaTpl,
		waSelectedCount: counts.waSelected,
		tgSelectedCount: counts.tgSelected,
		startMode: 'wa',
	})
	const capTg = computeCapacity({
		...common,
		templatesCount: effectiveTgTpl,
		waSelectedCount: counts.waSelected,
		tgSelectedCount: counts.tgSelected,
		startMode: 'tg',
	})
	return mergeBothChannelCapacity(capWa, capTg)
}
