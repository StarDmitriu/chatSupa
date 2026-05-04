import { formatEtaGoalLabel } from '@/lib/timingHubFormat'
import type { CapacityResult } from '@/lib/campaignCapacity'
import type {
	TimingHubPeriodPlan,
	TimingHubPlanningPeriodSummary,
	TimingHubWaveForecast,
} from '@/lib/timingHubPlanTypes'

import type { TimingHubSmartGoal } from '@/lib/timingHubPeriodPlanCompute'

export function buildPlanningPeriodSummary(p: {
	cap: CapacityResult
	waveForecast: TimingHubWaveForecast | null
	periodPlan: TimingHubPeriodPlan | null
	smartGoal: TimingHubSmartGoal
	targetEtaMin: number
	smartEnabled: boolean
}): TimingHubPlanningPeriodSummary {
	const { cap, waveForecast, periodPlan } = p
	const inWindowStr =
		!waveForecast || cap.totalJobs <= 0
			? '—'
			: !cap.fit && (waveForecast.Kmax ?? 0) <= 0
				? 'не влезает в окно'
				: waveForecast.Kmin === waveForecast.Kmax
					? String(waveForecast.Kmax)
					: `${waveForecast.Kmin}–${waveForecast.Kmax}`
	const inPeriodStr = periodPlan
		? periodPlan.wavesPossibleMin === periodPlan.wavesPossibleMax
			? String(periodPlan.wavesPossibleMax)
			: `${periodPlan.wavesPossibleMin}–${periodPlan.wavesPossibleMax}`
		: '—'
	const goalHint =
		p.smartGoal === 'oneWave'
			? 'Цель «1 волна за период»: автоподбор отключает повтор; в календаре объём на первый день периода, остальные дни без рассылки.'
			: p.smartGoal === 'fit'
				? periodPlan?.shouldSplitWaveAcrossDays
					? 'Цель «В окно»: волна длиннее суточного окна — в календаре объём делится по дням (~столько сообщений, сколько влезает в окно за день).'
					: 'Цель «В окно»: подобрать паузы так, чтобы одна волна уместилась в окно (повтор можно).'
				: p.smartGoal === 'eta' && periodPlan?.shouldSplitWaveAcrossDays
					? `Цель «Длит. волны» (~${formatEtaGoalLabel(p.targetEtaMin)}): волна длиннее окна — календарь дробит отправки по дням по вместимости окна.`
					: p.smartEnabled
						? `Цель «Длит. волны» (~${formatEtaGoalLabel(p.targetEtaMin)}): автоподбор держит паузы под мастер-ползунком в часах (вверху «Прогноза»).`
						: `Цель «Длит. волны» (~${formatEtaGoalLabel(p.targetEtaMin)}): при выключенном автоподборе мастер — ориентир; факт — по паузам (вкладка «Окно и паузы») или «Пересчитать подбор».`

	let calendar: TimingHubPlanningPeriodSummary['calendar'] = null
	if (periodPlan) {
		let totalJobs = 0
		let totalWaves = 0
		let activeDays = 0
		for (const d of periodPlan.dayCards) {
			totalJobs += d.jobsMax
			totalWaves += d.wavesMax
			if (d.jobsMax > 0) activeDays += 1
		}
		const days = periodPlan.dayCards.length
		calendar = {
			totalJobs,
			totalWaves,
			activeDays,
			days,
			avgJobsOnActiveDay: activeDays ? Math.round(totalJobs / activeDays) : 0,
		}
	}

	return { inWindowStr, inPeriodStr, goalHint, calendar }
}
