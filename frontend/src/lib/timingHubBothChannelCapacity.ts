import type { CapacityResult } from '@/lib/campaignCapacity'

/**
 * Склейка WA+TG в один «волновой» CapacityResult: длительность = max по каналам, jobs = сумма.
 * Общая формула для основного `cap` в drawer и для `calcCapForAdv` в режиме both.
 */
export function mergeBothChannelCapacity(capWa: CapacityResult, capTg: CapacityResult): CapacityResult {
	const totalSec = Math.max(capWa.totalSec, capTg.totalSec)
	const winSec = capWa.winSec
	const fit = totalSec <= winSec
	const totalJobs = capWa.totalJobs + capTg.totalJobs
	const deficitSec = Math.max(0, totalSec - winSec)
	const needAvgSec = totalJobs > 0 ? winSec / totalJobs : 0

	const etaMinutes = Math.max(1, Math.round(totalSec / 60))
	const etaHuman =
		totalSec < 3600 ? `около ${etaMinutes} мин` : `около ${(totalSec / 3600).toFixed(1).replace(/\.0$/, '')} ч`

	const deficitHuman =
		deficitSec <= 0
			? ''
			: deficitSec < 3600
				? `≈ ${Math.max(1, Math.round(deficitSec / 60))} мин`
				: `≈ ${(deficitSec / 3600).toFixed(1).replace(/\.0$/, '')} ч`

	return {
		tplCount: Math.max(capWa.tplCount, capTg.tplCount),
		waJobs: capWa.waJobs,
		tgJobs: capTg.tgJobs,
		totalJobs,
		avgWaSec: capWa.avgWaSec,
		avgTgSec: capTg.avgTgSec,
		totalSec,
		winSec,
		fit,
		deficitSec,
		jobsCapacity: capWa.jobsCapacity + capTg.jobsCapacity,
		needAvgSec,
		etaHours: (totalSec / 3600).toFixed(1),
		winHours: capWa.winHours,
		deficitHours: (deficitSec / 3600).toFixed(1),
		etaHuman,
		deficitHuman,
		modeMultiplier: capWa.modeMultiplier,
		waRecommendedRange: capWa.waRecommendedRange,
		tgRecommendedRange: capTg.tgRecommendedRange,
	}
}
