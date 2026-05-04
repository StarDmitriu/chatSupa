import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'

import type { AdvSettings, CapacityResult } from '@/lib/campaignCapacity'
import { scaleAdvBetweenGroups } from '@/lib/timingHubAdvScale'
import { buildCalendarDayRows, buildCalendarWeekCards, computeDayLoadPercent } from '@/lib/timingHubCalendarLayout'
import { mergeBothChannelCapacity } from '@/lib/timingHubBothChannelCapacity'
import { buildPeriodPlan } from '@/lib/timingHubPeriodPlanCompute'
import { buildPlanningPeriodSummary } from '@/lib/timingHubPlanningSummaryCompute'
import { buildRiskReasonForDay } from '@/lib/timingHubRiskReasonForDay'
import { buildSendTimeWarning } from '@/lib/timingHubSendTimeWarning'
import { formatMinutesToHHMM, parseHHMMToMinutes } from '@/lib/timingHubTime'
import { computeWaveForecast } from '@/lib/timingHubWaveForecastCompute'

const advBase: AdvSettings = {
	repeatEnabled: false,
}

function fakeCap(over: Partial<CapacityResult> = {}): CapacityResult {
	return {
		tplCount: 1,
		waJobs: 0,
		tgJobs: 10,
		totalJobs: 10,
		avgWaSec: 10,
		avgTgSec: 10,
		totalSec: 3600,
		winSec: 12 * 3600,
		fit: true,
		jobsCapacity: 5,
		needAvgSec: 100,
		etaHours: '1.0',
		winHours: '12',
		deficitHours: '0',
		deficitSec: 0,
		etaHuman: 'около 60 мин',
		deficitHuman: '',
		modeMultiplier: 1,
		waRecommendedRange: [1, 60],
		tgRecommendedRange: [1, 60],
		...over,
	}
}

describe('timingHubTime', () => {
	it('parseHHMMToMinutes и formatMinutesToHHMM согласованы', () => {
		expect(parseHHMMToMinutes('09:30')).toBe(9 * 60 + 30)
		expect(formatMinutesToHHMM(9 * 60 + 30)).toBe('09:30')
		expect(formatMinutesToHHMM(-30)).toBe('23:30')
	})

	it('невалидная строка → 0 минут', () => {
		expect(parseHHMMToMinutes('25:00')).toBe(0)
		expect(parseHHMMToMinutes('abc')).toBe(0)
	})
})

describe('computeWaveForecast', () => {
	it('при нуле jobs возвращает пустой прогноз и пояснение', () => {
		const cap = fakeCap({ totalJobs: 0, tgJobs: 0, waJobs: 0 })
		const out = computeWaveForecast(cap, {
			timeFrom: '09:00',
			timeTo: '21:00',
			adv: advBase,
		})
		expect(out.Kmin).toBe(0)
		expect(out.Kmax).toBe(0)
		expect(out.waveCards).toEqual([])
		expect(out.note).toMatch(/jobs/)
	})

	it('без повтора — одна волна', () => {
		const cap = fakeCap()
		const out = computeWaveForecast(cap, {
			timeFrom: '09:00',
			timeTo: '21:00',
			adv: { ...advBase, repeatEnabled: false },
		})
		expect(out.Kmin).toBe(1)
		expect(out.Kmax).toBe(1)
		expect(out.waveCards).toHaveLength(1)
		expect(out.waveCards[0]?.timeRange).toMatch(/–/)
	})
})

describe('buildSendTimeWarning', () => {
	it('возвращает null при «тихих» долях send_time', () => {
		const w = buildSendTimeWarning({
			sendTimeMeta: {
				wa: { fixed: 0, interval: 0, none: 10, sample: 10 },
				tg: { fixed: 0, interval: 0, none: 10, sample: 10 },
			},
			tgTplHasDefaultSendTime: false,
			waTargetsSummary: null,
			tgTargetsSummary: null,
			startMode: 'tg',
		})
		expect(w).toBeNull()
	})
})

describe('buildPeriodPlan', () => {
	it('строит карточки на выбранное число дней', () => {
		const fixedNow = dayjs('2025-06-15T12:00:00')
		const plan = buildPeriodPlan({
			cap: fakeCap(),
			wave: { timeFrom: '09:00', timeTo: '21:00', adv: advBase },
			selectedPeriodDays: 3,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: false,
			periodPreset: '3d',
			customPeriodRange: null,
			now: fixedNow,
		})
		expect(plan.days).toBe(3)
		expect(plan.dayCards).toHaveLength(3)
		expect(plan.periodLabel).toBe('3 дня')
		expect(plan.baseDay.format('YYYY-MM-DD')).toBe(fixedNow.format('YYYY-MM-DD'))
	})

	it('sendTimeWarningHasDetailLines снижает уверенность до средней', () => {
		const planLow = buildPeriodPlan({
			cap: fakeCap(),
			wave: { timeFrom: '09:00', timeTo: '21:00', adv: advBase },
			selectedPeriodDays: 1,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: true,
			periodPreset: 'today',
			customPeriodRange: null,
			now: dayjs('2025-06-15'),
		})
		const planHigh = buildPeriodPlan({
			cap: fakeCap(),
			wave: { timeFrom: '09:00', timeTo: '21:00', adv: advBase },
			selectedPeriodDays: 1,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: false,
			periodPreset: 'today',
			customPeriodRange: null,
			now: dayjs('2025-06-15'),
		})
		expect(planLow.confidence).toBe('средняя')
		expect(planHigh.confidence).toBe('высокая')
	})
})

describe('buildPlanningPeriodSummary', () => {
	it('сводит строки окна, периода и календаря', () => {
		const cap = fakeCap()
		const waveFc = computeWaveForecast(cap, {
			timeFrom: '09:00',
			timeTo: '21:00',
			adv: advBase,
		})
		const plan = buildPeriodPlan({
			cap,
			wave: { timeFrom: '09:00', timeTo: '21:00', adv: advBase },
			selectedPeriodDays: 7,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: false,
			periodPreset: '7d',
			customPeriodRange: null,
			now: dayjs('2025-06-15'),
		})
		const s = buildPlanningPeriodSummary({
			cap,
			waveForecast: waveFc,
			periodPlan: plan,
			smartGoal: 'eta',
			targetEtaMin: 30,
			smartEnabled: true,
		})
		expect(s.inWindowStr).not.toBe('—')
		expect(s.inPeriodStr).not.toBe('—')
		expect(s.goalHint).toMatch(/Длит/)
		expect(s.calendar).not.toBeNull()
		expect(s.calendar?.days).toBe(7)
		expect(s.calendar?.totalWaves).toBeGreaterThan(0)
	})
})

describe('buildCalendarDayRows / buildCalendarWeekCards / computeDayLoadPercent', () => {
	it('сетка дней: Monday-first и кратность 7 ячеек', () => {
		const plan = buildPeriodPlan({
			cap: fakeCap(),
			wave: { timeFrom: '09:00', timeTo: '21:00', adv: advBase },
			selectedPeriodDays: 3,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: false,
			periodPreset: '3d',
			customPeriodRange: null,
			now: dayjs('2025-06-15'),
		})
		const rows = buildCalendarDayRows(plan)
		const flat = rows.flat()
		expect(flat.length % 7).toBe(0)
		expect(flat.some((c) => c !== null)).toBe(true)
	})

	it('недельные карточки агрегируют дни и нагрузку', () => {
		const cap = fakeCap()
		const plan = buildPeriodPlan({
			cap,
			wave: { timeFrom: '09:00', timeTo: '21:00', adv: advBase },
			selectedPeriodDays: 7,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: false,
			periodPreset: '7d',
			customPeriodRange: null,
			now: dayjs('2025-06-09'),
		})
		const weeks = buildCalendarWeekCards(plan, cap)
		expect(weeks.length).toBeGreaterThanOrEqual(1)
		expect(weeks[0]?.weekKey).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(weeks[0]?.jobs).toBeGreaterThan(0)
	})

	it('недельные riskDays учитывают глобальный риск периода (даже если load <= 100)', () => {
		const cap = fakeCap({
			totalJobs: 100,
			totalSec: 10 * 3600,
			winSec: 2 * 3600,
			jobsCapacity: 20,
			fit: false,
		})
		const plan = buildPeriodPlan({
			cap,
			wave: { timeFrom: '09:00', timeTo: '12:00', adv: { ...advBase, repeatEnabled: true } },
			selectedPeriodDays: 2,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: false,
			periodPreset: '3d',
			customPeriodRange: null,
			now: dayjs('2025-06-09'),
		})
		expect(plan.canFitGoal).toBe(false)

		const weeks = buildCalendarWeekCards(plan, cap)
		const riskDays = weeks.reduce((sum, w) => sum + w.riskDays, 0)
		expect(riskDays).toBeGreaterThan(0)
	})

	it('computeDayLoadPercent: доля jobs × отношение длительности к окну', () => {
		const cap = fakeCap({ totalSec: 3600, winSec: 3600, totalJobs: 100 })
		const pct = computeDayLoadPercent(cap, { jobsMax: 50, wavesMax: 1 })
		expect(pct).toBeCloseTo(50, 5)
	})
})

describe('buildRiskReasonForDay', () => {
	it('пустой день — про шаблоны/группы', () => {
		expect(
			buildRiskReasonForDay({
				day: { jobsMax: 0, wavesMax: 0 },
				load: 0,
				cap: fakeCap(),
				periodPlan: null,
				repeatEnabled: false,
				repeatMinMinutes: 60,
			}),
		).toMatch(/нет активных/)
	})

	it('перегрузка при разбиении волны — своя формулировка', () => {
		const cap = fakeCap({ totalJobs: 100 })
		const plan = buildPeriodPlan({
			cap,
			wave: { timeFrom: '09:00', timeTo: '12:00', adv: { ...advBase, repeatEnabled: true } },
			selectedPeriodDays: 3,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: false,
			periodPreset: '3d',
			customPeriodRange: null,
			now: dayjs('2025-06-15'),
		})
		const r = buildRiskReasonForDay({
			day: { jobsMax: 40, wavesMax: 1 },
			load: 120,
			cap,
			periodPlan: plan,
			repeatEnabled: true,
			repeatMinMinutes: 60,
		})
		expect(r).toMatch(/долю волны|нагрузка/)
	})

	it('норма — «параметры в норме»', () => {
		expect(
			buildRiskReasonForDay({
				day: { jobsMax: 10, wavesMax: 1 },
				load: 50,
				cap: fakeCap({ winSec: 24 * 3600, totalSec: 3600 }),
				periodPlan: null,
				repeatEnabled: true,
				repeatMinMinutes: 60,
			}),
		).toBe('параметры в норме')
	})

	it('при глобальном риске периода объясняет несходимость цели, даже при load <= 100', () => {
		const cap = fakeCap({
			totalJobs: 100,
			totalSec: 10 * 3600,
			winSec: 2 * 3600,
			jobsCapacity: 20,
			fit: false,
		})
		const plan = buildPeriodPlan({
			cap,
			wave: { timeFrom: '09:00', timeTo: '12:00', adv: { ...advBase, repeatEnabled: true } },
			selectedPeriodDays: 2,
			smartGoal: 'eta',
			sendTimeWarningHasDetailLines: false,
			periodPreset: '3d',
			customPeriodRange: null,
			now: dayjs('2025-06-15'),
		})
		expect(plan.canFitGoal).toBe(false)

		const r = buildRiskReasonForDay({
			day: { jobsMax: 20, wavesMax: 1 },
			load: 100,
			cap,
			periodPlan: plan,
			repeatEnabled: true,
			repeatMinMinutes: 60,
		})
		expect(r).toMatch(/цель периода не сходится/)
	})
})

describe('scaleAdvBetweenGroups', () => {
	it('не меняет adv — паузы только в шаблонах', () => {
		const adv: AdvSettings = { repeatEnabled: true }
		const next = scaleAdvBetweenGroups(adv, 2)
		expect(next).toEqual(adv)
	})
})

describe('mergeBothChannelCapacity', () => {
	it('склеивает jobs и берёт max по времени', () => {
		const wa = fakeCap({
			totalSec: 1000,
			totalJobs: 3,
			waJobs: 3,
			tgJobs: 0,
			winSec: 5000,
			fit: true,
		})
		const tg = fakeCap({
			totalSec: 2000,
			totalJobs: 7,
			waJobs: 0,
			tgJobs: 7,
			winSec: 5000,
			fit: true,
		})
		const m = mergeBothChannelCapacity(wa, tg)
		expect(m.totalSec).toBe(2000)
		expect(m.totalJobs).toBe(10)
		expect(m.waJobs).toBe(3)
		expect(m.tgJobs).toBe(7)
		expect(m.deficitSec).toBe(0)
	})
})
