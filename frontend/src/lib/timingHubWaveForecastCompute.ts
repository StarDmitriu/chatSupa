import type { AdvSettings, CapacityResult } from '@/lib/campaignCapacity'
import { repeatPlanSpacingSec } from '@/lib/campaignCapacity'
import type { TimingHubWaveForecast } from '@/lib/timingHubPlanTypes'
import { formatMinutesToHHMM, parseHHMMToMinutes } from '@/lib/timingHubTime'

export type TimingHubWaveLocal = {
	timeFrom: string
	timeTo: string
	adv: AdvSettings
}

const SECONDS_IN_DAY = 24 * 3600

function dayLabel(dayOffset: number): string {
	if (dayOffset <= 0) return 'сегодня'
	if (dayOffset === 1) return 'завтра'
	return `через ${dayOffset} дн.`
}

/** Прогноз числа волн в суточном окне и карточек для UI. */
export function computeWaveForecast(cap: CapacityResult, wave: TimingHubWaveLocal): TimingHubWaveForecast {
	const oneWaveSec = cap.totalSec
	if (cap.totalJobs <= 0) {
		return {
			Kmin: 0,
			Kmax: 0,
			waveCards: [],
			note: 'В этой настройке jobs в волну не создаются (проверьте template targets и выбранные группы).',
		}
	}
	const winSec = cap.winSec
	const repeatEnabled = wave.adv.repeatEnabled

	const { minSec: rMinRaw, maxSec: rMaxRaw } = repeatPlanSpacingSec(wave.adv)
	const repeatMinSec = Math.max(1, rMinRaw)
	const repeatMaxSec = Math.max(1, rMaxRaw)

	if (!repeatEnabled) {
		const startMidSec = parseHHMMToMinutes(wave.timeFrom) * 60
		const endMidSec = startMidSec + oneWaveSec
		const startDayOffset = Math.floor(startMidSec / SECONDS_IN_DAY)
		const endDayOffset = Math.floor(endMidSec / SECONDS_IN_DAY)
		const startHH = formatMinutesToHHMM(startMidSec / 60)
		const endHH = formatMinutesToHHMM(endMidSec / 60)

		return {
			Kmin: 1,
			Kmax: 1,
			waveCards: [
				{
					index: 1,
					dayLabel: dayLabel(startDayOffset),
					dayLabelEnd: dayLabel(endDayOffset),
					endHH,
					timeRange:
						startDayOffset === endDayOffset ? `${startHH}–${endHH}` : `${startHH}–${endHH} (пересекает полночь)`,
					endRelSec: endMidSec,
				},
			],
		}
	}

	if (!cap.fit) {
		return {
			Kmin: 0,
			Kmax: 0,
			waveCards: [],
			note: '1 волна может не уложиться в окно — точный план повторов при запуске может отличаться.',
		}
	}

	const remainingSec = winSec - oneWaveSec
	if (remainingSec < 0) {
		return { Kmin: 0, Kmax: 0, waveCards: [] }
	}

	const cycleMinSec = oneWaveSec + repeatMinSec
	const cycleMaxSec = oneWaveSec + repeatMaxSec

	const Kmax = 1 + Math.floor(remainingSec / Math.max(1, cycleMinSec))
	const Kmin = 1 + Math.floor(remainingSec / Math.max(1, cycleMaxSec))

	const winFromMin = parseHHMMToMinutes(wave.timeFrom)
	const winToMinRaw = parseHHMMToMinutes(wave.timeTo)
	const winToMinAdj = winToMinRaw <= winFromMin ? winToMinRaw + 24 * 60 : winToMinRaw

	const winStartSec = winFromMin * 60
	const winEndSec = winToMinAdj * 60

	const maxCards = Math.min(3, Math.max(1, Kmax))

	const cards: TimingHubWaveForecast['waveCards'] = []
	for (let i = 1; i <= maxCards; i++) {
		const startEarliestSec = i === 1 ? winStartSec : winStartSec + (i - 1) * (oneWaveSec + repeatMinSec)
		const startLatestSec = i === 1 ? winStartSec : winStartSec + (i - 1) * (oneWaveSec + repeatMaxSec)
		const endLatestSec = startLatestSec + oneWaveSec

		if (startEarliestSec > winEndSec) break

		const endRelSec = Math.min(endLatestSec, winEndSec)
		const startDayOffset = Math.floor(startEarliestSec / SECONDS_IN_DAY)
		const endDayOffset = Math.floor(endRelSec / SECONDS_IN_DAY)

		const startHH = formatMinutesToHHMM(startEarliestSec / 60)
		const endHH = formatMinutesToHHMM(endRelSec / 60)

		cards.push({
			index: i,
			dayLabel: dayLabel(startDayOffset),
			dayLabelEnd: dayLabel(endDayOffset),
			timeRange:
				startDayOffset === endDayOffset ? `${startHH}–${endHH}` : `${startHH}–${endHH} (через полночь)`,
			endHH,
			endRelSec,
		})
	}

	return {
		Kmin,
		Kmax,
		waveCards: cards,
		note:
			repeatEnabled && Kmax > maxCards
				? `Показаны первые ${maxCards} волн для читабельности. Дальше в окне повторится ещё до ${Kmax} волн.`
				: undefined,
	}
}
