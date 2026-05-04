import type { StartMode } from '@/lib/campaignCapacity'
import type { TimingHubSendTimeWarning } from '@/lib/timingHubPlanTypes'

export type SendTimeMetaSlice = {
	wa: { fixed: number; interval: number; none: number; sample: number }
	tg: { fixed: number; interval: number; none: number; sample: number }
}

export type TargetsSummarySlice = {
	templatesWithAnyTargetsIntersect: number
	groupsCoveredByAnyTargets: number
	totalSelectedGroups: number
	groupsWithSendTimeOverride: number
	groupsFixedOverride: number
	groupsIntervalOverride: number
	templatesWithAnySendTimeOverrideIntersect: number
	templatesTotalEnabled: number
} | null

export type BuildSendTimeWarningInput = {
	sendTimeMeta: SendTimeMetaSlice
	tgTplHasDefaultSendTime: boolean
	waTargetsSummary: TargetsSummarySlice
	tgTargetsSummary: TargetsSummarySlice
	startMode: StartMode
}

export function buildSendTimeWarning(p: BuildSendTimeWarningInput): TimingHubSendTimeWarning | null {
	const wa = p.sendTimeMeta.wa
	const tg = p.sendTimeMeta.tg

	const waTargets = p.waTargetsSummary
	const tgTargets = p.tgTargetsSummary

	const waTotalForTargets = waTargets?.totalSelectedGroups ?? 0
	const tgTotalForTargets = tgTargets?.totalSelectedGroups ?? 0

	const tgOverrideShare = tgTotalForTargets > 0 ? tgTargets!.groupsWithSendTimeOverride / tgTotalForTargets : 0

	const tgFixedOverrideShare = tgTotalForTargets > 0 ? tgTargets!.groupsFixedOverride / tgTotalForTargets : 0
	const tgIntervalOverrideShare = tgTotalForTargets > 0 ? tgTargets!.groupsIntervalOverride / tgTotalForTargets : 0

	const waTargetsCoverageShare =
		waTargets?.totalSelectedGroups && waTargets.totalSelectedGroups > 0
			? waTargets.groupsCoveredByAnyTargets / waTargets.totalSelectedGroups
			: 0
	const tgTargetsCoverageShare =
		tgTargets?.totalSelectedGroups && tgTargets.totalSelectedGroups > 0
			? tgTargets.groupsCoveredByAnyTargets / tgTargets.totalSelectedGroups
			: 0

	const waShare = wa.sample > 0 ? (wa.fixed + wa.interval) / wa.sample : 0
	const tgShare = tg.sample > 0 ? (tg.fixed + tg.interval) / tg.sample : 0
	const waNoneShare = wa.sample > 0 ? wa.none / wa.sample : 0
	const tgNoneShare = tg.sample > 0 ? tg.none / tg.sample : 0

	const tgDefaultSet = p.tgTplHasDefaultSendTime

	const modeWa = p.startMode === 'wa' || p.startMode === 'both'
	const modeTg = p.startMode === 'tg' || p.startMode === 'both'

	const show =
		(modeWa && waShare >= 0.1) ||
		(modeTg && tgShare >= 0.1) ||
		(modeTg && tgDefaultSet && tgNoneShare >= 0.1) ||
		(modeTg && tgOverrideShare >= 0.1) ||
		(modeWa &&
			waTargets &&
			waTargets.templatesWithAnyTargetsIntersect > 0 &&
			waTargets.groupsCoveredByAnyTargets < waTargets.totalSelectedGroups) ||
		(modeTg &&
			tgTargets &&
			tgTargets.templatesWithAnyTargetsIntersect > 0 &&
			tgTargets.groupsCoveredByAnyTargets < tgTargets.totalSelectedGroups) ||
		false

	if (!show) return null

	const parts: string[] = []
	if (modeWa && wa.sample > 0 && waShare > 0)
		parts.push(`WA: ${Math.round(waShare * 100)}% групп с send_time в данных (для планирования WA не используется)`)
	if (modeTg && tg.sample > 0 && tgShare > 0) parts.push(`TG: ${Math.round(tgShare * 100)}% групп с send_time`)
	if (modeTg && tgDefaultSet && tg.sample > 0 && tgNoneShare > 0)
		parts.push(`TG: ${Math.round(tgNoneShare * 100)}% групп без send_time → default из шаблонов`)

	if (modeWa && waTargets && waTargets.templatesWithAnyTargetsIntersect > 0) {
		if (waTargets.groupsCoveredByAnyTargets < waTargets.totalSelectedGroups) {
			parts.push(
				`WA: ${Math.round(waTargetsCoverageShare * 100)}% групп попадают под targets (у остальных шаблоны не создадут jobs).`,
			)
		}
	}

	if (modeTg && tgTargets && tgTargets.groupsWithSendTimeOverride > 0) {
		if (tgFixedOverrideShare > 0) parts.push(`TG: ${Math.round(tgFixedOverrideShare * 100)}% групп → фикс send_time_override`)
		if (tgIntervalOverrideShare > 0)
			parts.push(`TG: ${Math.round(tgIntervalOverrideShare * 100)}% групп → интервальный send_time_override`)
		if (tgTargets.templatesWithAnySendTimeOverrideIntersect > 0 && tgTargets.templatesTotalEnabled > 0)
			parts.push(
				`TG: ${tgTargets.templatesWithAnySendTimeOverrideIntersect} из ${tgTargets.templatesTotalEnabled} шаблонов имеют send_time_override в targets`,
			)
	}

	if (modeTg && tgTargets && tgTargets.templatesWithAnyTargetsIntersect > 0) {
		if (tgTargets.groupsCoveredByAnyTargets < tgTargets.totalSelectedGroups) {
			parts.push(
				`TG: ${Math.round(tgTargetsCoverageShare * 100)}% групп попадают под targets (у остальных шаблоны не создадут jobs).`,
			)
		}
	}

	return {
		main:
			(modeWa &&
				waTargets &&
				waTargets.templatesWithAnyTargetsIntersect > 0 &&
				waTargets.groupsCoveredByAnyTargets < waTargets.totalSelectedGroups) ||
			(modeTg &&
				tgTargets &&
				tgTargets.templatesWithAnyTargetsIntersect > 0 &&
				tgTargets.groupsCoveredByAnyTargets < tgTargets.totalSelectedGroups)
				? 'Из-за template targets часть групп может получить jobs не по общему ритму (и/или не получить jobs вовсе).'
				: modeTg && tgOverrideShare >= 0.1
					? 'Часть TG-групп получит send_time не только из общего ритма (групповой или default из шаблонов), но и из send_time_override в targets.'
					: 'Часть групп получит send_time не только из общего ритма (групповой или default из шаблонов).',
		etaLine: 'Время волны может отличаться.',
		lines: parts,
	}
}
