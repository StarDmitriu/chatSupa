import type { CapacityResult } from '@/lib/campaignCapacity'
import type { TimingHubPeriodPlan, TimingHubSendTimeWarning } from '@/lib/timingHubPlanTypes'

export function computeNeedsPlanningFix(p: {
	cap: CapacityResult
	sendTimeWarning: TimingHubSendTimeWarning | null
	periodPlan: TimingHubPeriodPlan | null
}): boolean {
	if (p.sendTimeWarning) return true
	const splitOk = p.periodPlan?.shouldSplitWaveAcrossDays && p.periodPlan.splitFitsInPeriod
	if (!p.cap.fit && !splitOk) return true
	if (p.periodPlan && !p.periodPlan.canFitGoal) return true
	return false
}

export function computeDayNeedsQuickFix(p: {
	cap: CapacityResult
	periodPlan: TimingHubPeriodPlan | null
	needsPlanningFix: boolean
	loadPct: number
}): boolean {
	if (p.needsPlanningFix) return true
	const splitOk = p.periodPlan?.shouldSplitWaveAcrossDays && p.periodPlan.splitFitsInPeriod
	if (!p.cap.fit && !splitOk) return true
	if (p.loadPct > 100) return true
	if (p.cap.totalSec > p.cap.winSec && !p.periodPlan?.shouldSplitWaveAcrossDays) return true
	return false
}
