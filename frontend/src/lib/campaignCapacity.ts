export type StartMode = 'both' | 'wa' | 'tg'
export type CapacityMode = 'optimistic' | 'safe'

/** Только переключатель «повторять волны» на странице рассылок. Паузы — из шаблонов (бэкенд). */
export type AdvSettings = {
	repeatEnabled: boolean
}

const TEMPLATE_BASE_MID_WA_SEC = (45 + 120) / 2
const TEMPLATE_BASE_MID_TG_SEC = (45 + 90) / 2
/** Как на бэкенде по умолчанию: 2–3 мин между шаблонами в одной волне. */
const DEFAULT_BETWEEN_TEMPLATES_MIN = (2 + 3) / 2

export function formatRepeatSummaryShort(adv: AdvSettings): string {
	if (!adv.repeatEnabled) return 'выключен'
	return 'каждые 2–3 часа'
}

/** Интервал между стартами волн для прогнозов в планировщике (приблизительно). */
export function repeatPlanSpacingSec(adv: AdvSettings): { minSec: number; maxSec: number } {
	if (!adv.repeatEnabled) return { minSec: 60, maxSec: 60 }
	return { minSec: 120 * 60, maxSec: 180 * 60 }
}

export type CapacityResult = {
	tplCount: number
	waJobs: number
	tgJobs: number
	totalJobs: number
	avgWaSec: number
	avgTgSec: number
	totalSec: number
	winSec: number
	fit: boolean
	jobsCapacity: number
	needAvgSec: number
	etaHours: string
	winHours: string
	deficitHours: string
	deficitSec: number
	etaHuman: string
	deficitHuman: string
	modeMultiplier: number
	waRecommendedRange: [number, number]
	tgRecommendedRange: [number, number]
}

function parseHm(s: string): { h: number; m: number } | null {
	const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim())
	if (!m) return null
	return { h: Number(m[1]), m: Number(m[2]) }
}

export function windowSeconds(timeFrom: string, timeTo: string): number {
	const a = parseHm(timeFrom)
	const b = parseHm(timeTo)
	if (!a || !b) return 24 * 3600
	const from = a.h * 60 + a.m
	const to = b.h * 60 + b.m
	if (from === to) return 24 * 3600
	if (to > from) return (to - from) * 60
	// через полночь
	return (24 * 60 - from + to) * 60
}

export function computeCapacity(input: {
	templatesCount: number
	waSelectedCount: number
	tgSelectedCount: number
	adv: AdvSettings
	startMode: StartMode
	timeFrom: string
	timeTo: string
	capacityMode: CapacityMode
	// Если задан — используем точный коэффициент запаса вместо preset (optimistic/safe).
	bufferMultiplier?: number
	parallelChannels?: boolean
	waSpeedFactors?: number[] | null
	tgSpeedFactors?: number[] | null
}): CapacityResult {
	const tplCount = Math.max(0, input.templatesCount || 0)
	const waGroups = Math.max(0, input.waSelectedCount || 0)
	const tgGroups = Math.max(0, input.tgSelectedCount || 0)
	const waJobs = waGroups * tplCount
	const tgJobs = tgGroups * tplCount

	const modeWa = input.startMode === 'wa' || input.startMode === 'both'
	const modeTg = input.startMode === 'tg' || input.startMode === 'both'

	const winSec = windowSeconds(input.timeFrom, input.timeTo)
	const parallel = !!input.parallelChannels

	// Всегда паузы из шаблонов (как при запуске с betweenGroupsScaleTemplate=true).
	const baseAvgWaSec = TEMPLATE_BASE_MID_WA_SEC
	const baseAvgTgSec = TEMPLATE_BASE_MID_TG_SEC
	const avgBetweenTplSec = DEFAULT_BETWEEN_TEMPLATES_MIN * 60

	const modeMultiplier =
		typeof input.bufferMultiplier === 'number' && Number.isFinite(input.bufferMultiplier)
			? input.bufferMultiplier
			: input.capacityMode === 'safe'
				? 1.35
				: 1

	const normSf = (sf: number) => {
		const x = Number(sf)
		if (!Number.isFinite(x)) return 100
		return Math.max(10, Math.min(400, x))
	}

	const avgReciprocal = (factors: number[] | null | undefined) => {
		const arr = Array.isArray(factors) ? factors : []
		if (arr.length === 0) return 1 / 100
		const sum = arr.reduce((acc, v) => acc + 1 / normSf(v), 0)
		return sum / arr.length
	}

	const waAvgJobPauseSec = baseAvgWaSec * 100 * avgReciprocal(input.waSpeedFactors) * modeMultiplier
	const tgAvgJobPauseSec = baseAvgTgSec * 100 * avgReciprocal(input.tgSpeedFactors) * modeMultiplier

	const waSec = waJobs * waAvgJobPauseSec + Math.max(0, tplCount - 1) * avgBetweenTplSec
	const tgSec = tgJobs * tgAvgJobPauseSec + Math.max(0, tplCount - 1) * avgBetweenTplSec

	const totalSec =
		parallel && modeWa && modeTg ? Math.max(waSec, tgSec) : (modeWa ? waSec : 0) + (modeTg ? tgSec : 0)

	const fit = totalSec <= winSec

	const totalJobs = (modeWa ? waJobs : 0) + (modeTg ? tgJobs : 0)
	const deficitSec = Math.max(0, totalSec - winSec)

	const overheadBetweenTplSec = Math.max(0, tplCount - 1) * avgBetweenTplSec
	const jobsPossibleWa =
		modeWa && tplCount > 0
			? Math.max(0, Math.floor((winSec - overheadBetweenTplSec) / Math.max(1, waAvgJobPauseSec)))
			: 0
	const jobsPossibleTg =
		modeTg && tplCount > 0
			? Math.max(0, Math.floor((winSec - overheadBetweenTplSec) / Math.max(1, tgAvgJobPauseSec)))
			: 0
	const jobsCapacity = jobsPossibleWa + jobsPossibleTg

	const needAvgSec = totalJobs > 0 ? winSec / totalJobs : 0
	const etaHours = (totalSec / 3600).toFixed(1)
	const winHours = (winSec / 3600).toFixed(1)
	const deficitHours = (deficitSec / 3600).toFixed(1)

	const desiredBaseFromEffective = (channel: 'wa' | 'tg', effectivePauseNeeded: number) => {
		const sfRecip = channel === 'wa' ? avgReciprocal(input.waSpeedFactors) : avgReciprocal(input.tgSpeedFactors)
		const base = effectivePauseNeeded / (100 * sfRecip * Math.max(1e-9, modeMultiplier))
		return base
	}

	const waRecommendedAvg = fit
		? baseAvgWaSec
		: (() => {
				if (!modeWa || waJobs <= 0) return baseAvgWaSec
				const effectiveNeeded = Math.max(1, (winSec - overheadBetweenTplSec) / Math.max(1, waJobs))
				return Math.max(5, Math.ceil(desiredBaseFromEffective('wa', effectiveNeeded)))
			})()

	const tgRecommendedAvg = fit
		? baseAvgTgSec
		: (() => {
				if (!modeTg || tgJobs <= 0) return baseAvgTgSec
				const effectiveNeeded = Math.max(1, (winSec - overheadBetweenTplSec) / Math.max(1, tgJobs))
				return Math.max(5, Math.ceil(desiredBaseFromEffective('tg', effectiveNeeded)))
			})()

	const waRecommendedRange: [number, number] = [
		Math.max(5, Math.min(600, Math.floor((waRecommendedAvg * 0.8) / 5) * 5)),
		Math.max(5, Math.min(600, Math.ceil((waRecommendedAvg * 1.25) / 5) * 5)),
	]
	const tgRecommendedRange: [number, number] = [
		Math.max(5, Math.min(600, Math.floor((tgRecommendedAvg * 0.8) / 5) * 5)),
		Math.max(5, Math.min(600, Math.ceil((tgRecommendedAvg * 1.2) / 5) * 5)),
	]

	const etaMinutes = totalJobs > 0 ? Math.max(1, Math.round(totalSec / 60)) : 0
	const deficitMinutes = Math.max(1, Math.round(deficitSec / 60))
	const etaHuman =
		totalJobs <= 0
			? '0 мин'
			: totalSec < 3600
				? `около ${etaMinutes} мин`
				: `около ${(totalSec / 3600).toFixed(1).replace(/\.0$/, '')} ч`
	const deficitHuman =
		deficitSec <= 0
			? ''
			: totalJobs <= 0
				? ''
				: deficitSec < 3600
					? `≈ ${deficitMinutes} мин`
					: `≈ ${(deficitSec / 3600).toFixed(1).replace(/\.0$/, '')} ч`

	return {
		tplCount,
		waJobs,
		tgJobs,
		totalJobs,
		avgWaSec: waAvgJobPauseSec,
		avgTgSec: tgAvgJobPauseSec,
		totalSec,
		winSec,
		fit,
		jobsCapacity,
		needAvgSec,
		etaHours,
		winHours,
		deficitHours,
		deficitSec,
		etaHuman,
		deficitHuman,
		modeMultiplier,
		waRecommendedRange,
		tgRecommendedRange,
	}
}
