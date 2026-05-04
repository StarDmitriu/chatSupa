import { describe, expect, it } from 'vitest'
import { clampEtaMinutes } from '@/lib/timingHubEtaClamp'

describe('clampEtaMinutes', () => {
	it('клампит в пределы по умолчанию', () => {
		expect(clampEtaMinutes(3)).toBe(5)
		expect(clampEtaMinutes(50 * 60)).toBe(48 * 60)
		expect(clampEtaMinutes(120)).toBe(120)
	})

	it('округляет', () => {
		expect(clampEtaMinutes(30.4)).toBe(30)
	})
})
