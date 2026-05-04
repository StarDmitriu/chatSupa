import { ETA_GOAL_MAX_MIN, ETA_GOAL_MIN_MIN } from '@/lib/timingHubMasterConstants'

export function clampEtaMinutes(
	n: number,
	min: number = ETA_GOAL_MIN_MIN,
	max: number = ETA_GOAL_MAX_MIN,
): number {
	if (!Number.isFinite(n)) return min
	return Math.max(min, Math.min(max, Math.round(n)))
}
