import { describe, expect, it } from 'vitest'
import { buildSmartAutonudgeKey } from '@/lib/timingHubSmartAutonudgeKey'

const base = {
	smartGoal: 'eta' as const,
	targetEtaMin: 30,
	timeFrom: '09:00',
	timeTo: '21:00',
	startMode: 'both' as const,
	capacityMode: 'optimistic' as const,
	customBufferEnabled: false,
	customBufferMultiplier: 1,
	tplEnabled: 3,
	waSelected: 1,
	tgSelected: 2,
	waSpeedFactors: [1, 1] as const,
	tgSpeedFactors: [1] as const,
}

describe('buildSmartAutonudgeKey', () => {
	it('меняется при смене цели минут', () => {
		const a = buildSmartAutonudgeKey(base)
		const b = buildSmartAutonudgeKey({ ...base, targetEtaMin: 45 })
		expect(a).not.toBe(b)
	})

	it('меняется при смене smartGoal', () => {
		const a = buildSmartAutonudgeKey(base)
		const b = buildSmartAutonudgeKey({ ...base, smartGoal: 'fit' })
		expect(a).not.toBe(b)
	})

	it('стабилен при одинаковых входах', () => {
		expect(buildSmartAutonudgeKey(base)).toBe(buildSmartAutonudgeKey({ ...base }))
	})

	it('учитывает коэффициент запаса в custom', () => {
		const a = buildSmartAutonudgeKey({
			...base,
			customBufferEnabled: true,
			customBufferMultiplier: 1.2,
		})
		const b = buildSmartAutonudgeKey({
			...base,
			customBufferEnabled: true,
			customBufferMultiplier: 1.35,
		})
		expect(a).not.toBe(b)
	})
})
