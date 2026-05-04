import type { CapacityResult } from '@/lib/campaignCapacity'
import type { TimingHubPeriodPlan } from '@/lib/timingHubPlanTypes'

export function buildRiskReasonForDay(p: {
	day: { jobsMax: number; wavesMax: number }
	load: number
	cap: CapacityResult | null
	periodPlan: TimingHubPeriodPlan | null
	repeatEnabled: boolean
	repeatMinMinutes: number
	/** Для предупреждения «слишком плотный repeat» учитывается только режим minutes. */
	repeatScheduleKind?: 'minutes' | 'next_day' | 'clock_time'
}): string {
	const { day, load, cap, periodPlan } = p
	if (day.jobsMax <= 0) return 'нет активных шаблонов или групп'
	if (load > 100) {
		const isPartOfSplit =
			cap && cap.totalJobs > 0 && day.jobsMax < cap.totalJobs && periodPlan?.shouldSplitWaveAcrossDays
		if (isPartOfSplit) {
			return `нагрузка ${Math.round(load)}% — доля волны на этот день относительно суточного окна`
		}
		if (cap && cap.winSec > 0 && cap.totalSec > cap.winSec) {
			const deficitH = Math.max(0.05, (cap.totalSec - cap.winSec) / 3600)
			return `окно короче одной волны (~${deficitH.toFixed(1)} ч)`
		}
		return `нагрузка ${Math.round(load)}% относительно суточного окна (длительность волны vs окно)`
	}
	if (!p.repeatEnabled && day.wavesMax <= 1) return 'повтор выключен'
	const repKind = p.repeatScheduleKind ?? 'minutes'
	if (p.repeatEnabled && repKind === 'minutes' && p.repeatMinMinutes <= 2) return 'слишком плотный repeat'
	if (periodPlan && !periodPlan.canFitGoal) {
		return periodPlan.waveFitsInWindow
			? 'цель периода не сходится (число волн за период недостаточно)'
			: 'цель периода не сходится (нужно больше дней или мягче паузы)'
	}
	if ((cap?.winSec || 0) < (cap?.totalSec || 0) && !periodPlan?.shouldSplitWaveAcrossDays) return 'окно короткое'
	return 'параметры в норме'
}
