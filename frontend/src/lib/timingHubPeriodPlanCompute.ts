import type { Dayjs } from 'dayjs'

import { repeatPlanSpacingSec, type CapacityResult } from '@/lib/campaignCapacity'
import type { TimingHubDayCard, TimingHubPeriodPlan } from '@/lib/timingHubPlanTypes'
import { formatMinutesToHHMM, parseHHMMToMinutes } from '@/lib/timingHubTime'

import type { TimingHubWaveLocal } from '@/lib/timingHubWaveForecastCompute'
import { ruDayCountLabel } from '@/lib/timingHubFormat'

export type TimingHubSmartGoal = 'oneWave' | 'fit' | 'eta'
export type TimingHubPeriodPreset = 'today' | '3d' | '7d' | '30d' | 'custom' | 'fixed'

export type BuildPeriodPlanInput = {
	cap: CapacityResult
	wave: TimingHubWaveLocal
	selectedPeriodDays: number
	smartGoal: TimingHubSmartGoal
	/** Учитывается только для поля `confidence` (наличие строк в предупреждении send_time). */
	sendTimeWarningHasDetailLines: boolean
	periodPreset: TimingHubPeriodPreset
	customPeriodRange: [Dayjs, Dayjs] | null
	/** «Сегодня» для baseDay, если не custom-период. */
	now: Dayjs
}

export function buildPeriodPlan(p: BuildPeriodPlanInput): TimingHubPeriodPlan {
	const { cap, wave } = p
	const days = p.selectedPeriodDays
	const oneWaveSec = cap.totalSec
	const waveFitsInWindow = oneWaveSec <= cap.winSec
	const activeHours = Number((Number(cap.winHours) * days).toFixed(1))
	const oneWaveHours = Number((oneWaveSec / 3600).toFixed(2))
	const { minSec: repeatMinSecRaw, maxSec: repeatMaxSecRaw } = repeatPlanSpacingSec(wave.adv)
	const repeatMinSec = Math.max(1, repeatMinSecRaw)
	const repeatMaxSec = Math.max(1, repeatMaxSecRaw)
	let wavesPerDayMin = 0
	let wavesPerDayMax = 0
	if (cap.totalJobs > 0) {
		if (waveFitsInWindow) {
			if (!wave.adv.repeatEnabled) {
				wavesPerDayMin = 1
				wavesPerDayMax = 1
			} else {
				const remainingSec = cap.winSec - oneWaveSec
				wavesPerDayMax = 1 + Math.floor(remainingSec / Math.max(1, oneWaveSec + repeatMinSec))
				wavesPerDayMin = 1 + Math.floor(remainingSec / Math.max(1, oneWaveSec + repeatMaxSec))
			}
		} else {
			wavesPerDayMin = 1
			wavesPerDayMax = 1
		}
	}
	const wavesCapacityMin = Math.max(0, wavesPerDayMin * days)
	const wavesCapacityMax = Math.max(0, wavesPerDayMax * days)
	const jobsPerWave = cap.totalJobs
	const jobsPerDayCap = Math.max(1, cap.jobsCapacity || 1)
	const shouldSplitWaveAcrossDays =
		(p.smartGoal === 'fit' || p.smartGoal === 'eta') && !waveFitsInWindow && jobsPerWave > 0 && days > 0
	const splitDaysNeeded = shouldSplitWaveAcrossDays ? Math.ceil(jobsPerWave / jobsPerDayCap) : 0
	const splitFitsInPeriod = shouldSplitWaveAcrossDays ? splitDaysNeeded <= days : false
	const splitWaveSegments = shouldSplitWaveAcrossDays ? Math.min(days, splitDaysNeeded) : 0

	let wavesPossibleMin = p.smartGoal === 'oneWave' ? (cap.totalJobs > 0 ? 1 : 0) : wavesCapacityMin
	let wavesPossibleMax = p.smartGoal === 'oneWave' ? (cap.totalJobs > 0 ? 1 : 0) : wavesCapacityMax
	if (shouldSplitWaveAcrossDays) {
		wavesPossibleMin = splitWaveSegments
		wavesPossibleMax = splitWaveSegments
	}

	const jobsPossibleMin = shouldSplitWaveAcrossDays
		? jobsPerWave
		: p.smartGoal === 'oneWave'
			? cap.totalJobs > 0
				? jobsPerWave
				: 0
			: jobsPerWave * wavesPossibleMin
	const jobsPossibleMax = shouldSplitWaveAcrossDays
		? jobsPerWave
		: p.smartGoal === 'oneWave'
			? cap.totalJobs > 0
				? jobsPerWave
				: 0
			: jobsPerWave * wavesPossibleMax
	const wavesNeeded = p.smartGoal === 'oneWave' ? 1 : p.smartGoal === 'fit' ? 1 : null
	const enoughWavesForGoal = wavesNeeded == null ? wavesPossibleMax > 0 : wavesPossibleMax >= wavesNeeded
	const canFitGoal = (waveFitsInWindow && enoughWavesForGoal) || (shouldSplitWaveAcrossDays && splitFitsInPeriod)
	const capacityGapSec = canFitGoal ? 0 : Math.max(0, oneWaveSec - cap.winSec)
	const confidence: TimingHubPeriodPlan['confidence'] = p.sendTimeWarningHasDetailLines
		? 'средняя'
		: shouldSplitWaveAcrossDays && splitFitsInPeriod
			? 'высокая'
			: !waveFitsInWindow && !shouldSplitWaveAcrossDays
				? 'низкая'
				: wave.adv.repeatEnabled && repeatMinSec !== repeatMaxSec
					? 'средняя'
					: canFitGoal
						? 'высокая'
						: 'низкая'

	const baseDay =
		p.periodPreset === 'custom' && p.customPeriodRange ? p.customPeriodRange[0].startOf('day') : p.now.startOf('day')

	const dayCardsRaw: TimingHubDayCard[] = Array.from({ length: days }).map((_, i) => {
		const d = baseDay.add(i, 'day')
		const label =
			i === 0
				? 'Сегодня'
				: i === 1
					? 'Завтра'
					: p.periodPreset === 'custom'
						? d.format('DD.MM')
						: `День ${i + 1}`
		const startMin = parseHHMMToMinutes(wave.timeFrom)
		const endMin = startMin + Math.floor(oneWaveSec / 60)
		const firstWindow =
			formatMinutesToHHMM(startMin) +
			'–' +
			formatMinutesToHHMM(endMin) +
			(endMin >= 24 * 60 ? ' (через полночь)' : '')
		const endDayOffset = Math.floor(endMin / (24 * 60))
		const endHuman =
			endDayOffset <= 0
				? `закончится сегодня в ${formatMinutesToHHMM(endMin)}`
				: endDayOffset === 1
					? `закончится завтра в ${formatMinutesToHHMM(endMin)}`
					: `закончится через ${endDayOffset} дн. в ${formatMinutesToHHMM(endMin)}`
		return {
			dateKey: d.format('YYYY-MM-DD'),
			dateLabel: d.format('DD.MM'),
			dayIndex: i + 1,
			label,
			wavesMin: wavesPerDayMin,
			wavesMax: wavesPerDayMax,
			firstWindow,
			endHuman,
			jobsMin: jobsPerWave * wavesPerDayMin,
			jobsMax: jobsPerWave * wavesPerDayMax,
		}
	})

	const dayCards: TimingHubDayCard[] =
		p.smartGoal === 'oneWave' && cap.totalJobs > 0
			? dayCardsRaw.map((card, i) =>
					i === 0
						? {
								...card,
								wavesMin: 1,
								wavesMax: 1,
								jobsMin: jobsPerWave,
								jobsMax: jobsPerWave,
							}
						: { ...card, wavesMin: 0, wavesMax: 0, jobsMin: 0, jobsMax: 0 },
				)
			: p.smartGoal === 'oneWave'
				? dayCardsRaw.map((card) => ({
						...card,
						wavesMin: 0,
						wavesMax: 0,
						jobsMin: 0,
						jobsMax: 0,
					}))
				: shouldSplitWaveAcrossDays
					? (() => {
							let remaining = jobsPerWave
							return dayCardsRaw.map((card, i, arr) => {
								const isLast = i === arr.length - 1
								const dayJobs = isLast ? remaining : Math.min(remaining, jobsPerDayCap)
								remaining -= dayJobs
								const w = dayJobs > 0 ? 1 : 0
								const startMin = parseHHMMToMinutes(wave.timeFrom)
								const frac = jobsPerWave > 0 ? dayJobs / jobsPerWave : 0
								const daySec = frac * oneWaveSec
								const endMin = startMin + Math.floor(daySec / 60)
								const firstWindow =
									dayJobs <= 0
										? '—'
										: formatMinutesToHHMM(startMin) +
											'–' +
											formatMinutesToHHMM(endMin) +
											(endMin >= 24 * 60 ? ' (через полночь)' : '')
								const endDayOffset = Math.floor(endMin / (24 * 60))
								const endHuman =
									dayJobs <= 0
										? '—'
										: endDayOffset <= 0
											? `фрагмент закончится сегодня в ${formatMinutesToHHMM(endMin)}`
											: endDayOffset === 1
												? `фрагмент закончится завтра в ${formatMinutesToHHMM(endMin)}`
												: `фрагмент закончится через ${endDayOffset} дн. в ${formatMinutesToHHMM(endMin)}`
								return {
									...card,
									wavesMin: w,
									wavesMax: w,
									jobsMin: dayJobs,
									jobsMax: dayJobs,
									firstWindow,
									endHuman,
								}
							})
						})()
					: dayCardsRaw

	const finishAt =
		wavesCapacityMax <= 0 && !shouldSplitWaveAcrossDays
			? '—'
			: shouldSplitWaveAcrossDays
				? (() => {
						let remaining = jobsPerWave
						let lastIdx = 0
						let lastDayJobs = 0
						for (let i = 0; i < dayCardsRaw.length; i++) {
							const isLast = i === dayCardsRaw.length - 1
							const dayJobs = isLast ? remaining : Math.min(remaining, jobsPerDayCap)
							remaining -= dayJobs
							if (dayJobs > 0) {
								lastIdx = i
								lastDayJobs = dayJobs
							}
						}
						const startMin = parseHHMMToMinutes(wave.timeFrom)
						const frac = jobsPerWave > 0 ? lastDayJobs / jobsPerWave : 0
						const endMin = startMin + Math.floor((frac * oneWaveSec) / 60)
						const d = baseDay.add(lastIdx, 'day')
						const dayLabel = lastIdx === 0 ? 'сегодня' : lastIdx === 1 ? 'завтра' : d.format('DD.MM')
						return `${dayLabel} ${formatMinutesToHHMM(endMin)}`
					})()
				: (() => {
						const targetWaves = wavesNeeded ?? wavesCapacityMax
						const wavesPerDay = Math.max(1, wavesPerDayMax)
						const dayOffset = Math.max(0, Math.ceil(targetWaves / wavesPerDay) - 1)
						const endMin = parseHHMMToMinutes(wave.timeFrom) + Math.floor(oneWaveSec / 60)
						const d = baseDay.add(dayOffset, 'day')
						const dayLabel = dayOffset === 0 ? 'сегодня' : dayOffset === 1 ? 'завтра' : d.format('DD.MM')
						return `${dayLabel} ${formatMinutesToHHMM(endMin)}`
					})()

	const periodLabel =
		p.periodPreset === 'today'
			? 'Сегодня'
			: p.periodPreset === '3d'
				? '3 дня'
				: p.periodPreset === '7d'
					? '7 дней'
					: p.periodPreset === '30d'
						? '30 дней'
						: p.periodPreset === 'fixed'
							? ruDayCountLabel(p.selectedPeriodDays)
							: p.customPeriodRange
								? `${p.customPeriodRange[0].format('DD.MM')}–${p.customPeriodRange[1].format('DD.MM')}`
								: 'Свой период'

	return {
		days,
		activeHours,
		oneWaveHours,
		wavesNeeded,
		wavesPossibleMin,
		wavesPossibleMax,
		jobsPossibleMin,
		jobsPossibleMax,
		capacityGapSec,
		waveFitsInWindow,
		canFitGoal,
		confidence,
		finishAt,
		baseDay,
		dayCards,
		shouldSplitWaveAcrossDays,
		splitFitsInPeriod,
		splitDaysNeeded,
		jobsPerDayCap,
		periodLabel,
	}
}
