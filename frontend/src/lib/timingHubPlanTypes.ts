import type { Dayjs } from 'dayjs'

/** День в сетке календаря нагрузки. */
export type TimingHubDayCard = {
	dateKey: string
	dateLabel: string
	dayIndex: number
	label: string
	wavesMin: number
	wavesMax: number
	firstWindow: string
	endHuman: string
	jobsMin: number
	jobsMax: number
}

export type TimingHubPeriodPlan = {
	days: number
	activeHours: number
	oneWaveHours: number
	wavesNeeded: number | null
	wavesPossibleMin: number
	wavesPossibleMax: number
	jobsPossibleMin: number
	jobsPossibleMax: number
	capacityGapSec: number
	waveFitsInWindow: boolean
	canFitGoal: boolean
	confidence: 'низкая' | 'средняя' | 'высокая'
	finishAt: string
	baseDay: Dayjs
	dayCards: TimingHubDayCard[]
	shouldSplitWaveAcrossDays: boolean
	splitFitsInPeriod: boolean
	splitDaysNeeded: number
	jobsPerDayCap: number
	periodLabel: string
}

/** Карточка волны в прогнозе (поля для UI + внутренние). */
export type TimingHubWaveForecastCard = {
	index?: number
	dayLabel?: string
	timeRange: string
	dayLabelEnd: string
	endHH: string
	endRelSec?: number
}

export type TimingHubWaveForecast = {
	Kmin: number
	Kmax: number
	waveCards: TimingHubWaveForecastCard[]
	note?: string
}

export type TimingHubPlanningPeriodSummary = {
	inWindowStr: string
	inPeriodStr: string
	goalHint: string
	calendar: {
		totalJobs: number
		totalWaves: number
		activeDays: number
		days: number
		avgJobsOnActiveDay: number
	} | null
}

export type TimingHubSendTimeWarning = { main: string; etaLine: string; lines: string[] }

export type TimingHubVolumeBreakdownRow = { key: string; groups: number; templates: number; jobs: number }

export type TimingHubVolumeBreakdown = {
	rows: TimingHubVolumeBreakdownRow[]
	hasTargets?: boolean
}

export type TimingHubWeekSummaryCard = {
	weekKey: string
	label: string
	days: number
	riskDays: number
	emptyDays: number
	loadAvg: number
	loadMax: number
	jobs: number
	waves: number
}
