import dayjs from 'dayjs'

import type { CapacityResult } from '@/lib/campaignCapacity'
import type { TimingHubDayCard, TimingHubPeriodPlan, TimingHubWeekSummaryCard } from '@/lib/timingHubPlanTypes'

export function buildCalendarDayRows(periodPlan: TimingHubPeriodPlan): Array<Array<TimingHubDayCard | null>> {
	const rows: Array<Array<TimingHubDayCard | null>> = []
	const start = periodPlan.baseDay.startOf('day')
	const offset = (start.day() + 6) % 7
	const cells: Array<TimingHubDayCard | null> = Array.from({ length: offset }, () => null)
	for (const day of periodPlan.dayCards) cells.push(day)
	while (cells.length % 7 !== 0) cells.push(null)
	for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
	return rows
}

export function buildCalendarWeekCards(periodPlan: TimingHubPeriodPlan, cap: CapacityResult): TimingHubWeekSummaryCard[] {
	const map = new Map<string, TimingHubWeekSummaryCard>()
	const globalPeriodRisk = !periodPlan.canFitGoal
	for (const d of periodPlan.dayCards) {
		const dt = dayjs(d.dateKey)
		const ws = dt.subtract((dt.day() + 6) % 7, 'day')
		const weekKey = ws.format('YYYY-MM-DD')
		const load =
			cap.winSec > 0 && d.jobsMax > 0 && cap.totalJobs > 0
				? (d.jobsMax / cap.totalJobs) * (cap.totalSec / cap.winSec) * 100
				: 0
		const isRisk = load > 100 || (globalPeriodRisk && d.jobsMax > 0)
		const isEmpty = d.jobsMax <= 0
		if (!map.has(weekKey)) {
			map.set(weekKey, {
				weekKey,
				label: `${ws.format('DD.MM')}–${ws.add(6, 'day').format('DD.MM')}`,
				days: 0,
				riskDays: 0,
				emptyDays: 0,
				loadAvg: 0,
				loadMax: 0,
				jobs: 0,
				waves: 0,
			})
		}
		const cur = map.get(weekKey)!
		cur.days += 1
		cur.riskDays += isRisk ? 1 : 0
		cur.emptyDays += isEmpty ? 1 : 0
		cur.loadAvg += load
		cur.loadMax = Math.max(cur.loadMax, load)
		cur.jobs += d.jobsMax
		cur.waves += d.wavesMax
	}
	return Array.from(map.values()).map((w) => ({ ...w, loadAvg: w.days ? w.loadAvg / w.days : 0 }))
}

export function computeDayLoadPercent(
	cap: CapacityResult,
	day: Pick<TimingHubDayCard, 'jobsMax' | 'wavesMax'>,
): number {
	if (cap.winSec <= 0 || day.jobsMax <= 0 || cap.totalJobs <= 0) return 0
	const frac = day.jobsMax / cap.totalJobs
	return frac * (cap.totalSec / cap.winSec) * 100
}
