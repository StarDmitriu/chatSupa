import type { CapacityResult, StartMode } from '@/lib/campaignCapacity'
import type { TimingHubVolumeBreakdown } from '@/lib/timingHubPlanTypes'

export function buildClientVolumeBreakdown(p: {
	cap: CapacityResult
	startMode: StartMode
	tgGroupsForJobs: number
	waGroupsForJobs: number
	tgActiveTemplates: number
	waActiveTemplates: number
	hasTargetsWa: boolean
	hasTargetsTg: boolean
}): TimingHubVolumeBreakdown {
	const rows: TimingHubVolumeBreakdown['rows'] = []
	if (p.startMode === 'tg' || p.startMode === 'both') {
		rows.push({
			key: 'TG',
			groups: p.tgGroupsForJobs,
			templates: p.tgActiveTemplates,
			jobs: p.cap.tgJobs,
		})
	}
	if (p.startMode === 'wa' || p.startMode === 'both') {
		rows.push({
			key: 'WA',
			groups: p.waGroupsForJobs,
			templates: p.waActiveTemplates,
			jobs: p.cap.waJobs,
		})
	}
	return { rows, hasTargets: p.hasTargetsWa || p.hasTargetsTg }
}
