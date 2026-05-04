import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
	LS_KEY_CAMPAIGN_ADV,
	LS_KEY_CAMPAIGN_TIME_WINDOW,
	mergeAdvWithRecommendedPauses,
	normalizeTimeHm,
	readLocalWaveSettings,
} from './campaignWaveLocal'
import type { AdvSettings } from './campaignCapacity'

describe('normalizeTimeHm', () => {
	it('нормализует HH:mm', () => {
		expect(normalizeTimeHm('09:05', '00:00')).toBe('09:05')
		expect(normalizeTimeHm('23:59', '00:00')).toBe('23:59')
	})
	it('fallback при мусоре', () => {
		expect(normalizeTimeHm('xx', '12:00')).toBe('12:00')
	})
})

describe('readLocalWaveSettings', () => {
	const store: Record<string, string> = {}

	beforeEach(() => {
		const api = {
			getItem: (k: string) => (k in store ? store[k] : null),
			setItem: (k: string, v: string) => {
				store[k] = v
			},
			removeItem: (k: string) => {
				delete store[k]
			},
		}
		vi.stubGlobal('localStorage', api)
		vi.stubGlobal('window', { localStorage: api } as Window)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		Object.keys(store).forEach((k) => delete store[k])
	})

	it('читает окно и repeatEnabled из localStorage', () => {
		store[LS_KEY_CAMPAIGN_TIME_WINDOW] = JSON.stringify({ timeFrom: '08:30', timeTo: '22:00' })
		store[LS_KEY_CAMPAIGN_ADV] = JSON.stringify({
			repeatEnabled: false,
		})
		const w = readLocalWaveSettings()
		expect(w.timeFrom).toBe('08:30')
		expect(w.timeTo).toBe('22:00')
		expect(w.adv.repeatEnabled).toBe(false)
	})
})

describe('mergeAdvWithRecommendedPauses', () => {
	const base: AdvSettings = { repeatEnabled: true }

	it('forceDisableRepeat выключает повтор', () => {
		const n = mergeAdvWithRecommendedPauses(base, [50, 60], [70, 80], {
			alsoDisableRepeatIfNotFit: false,
			forceDisableRepeat: true,
			capFit: true,
		})
		expect(n.repeatEnabled).toBe(false)
	})

	it('alsoDisableRepeatIfNotFit при !capFit выключает повтор', () => {
		const n = mergeAdvWithRecommendedPauses(base, [50, 60], [70, 80], {
			alsoDisableRepeatIfNotFit: true,
			capFit: false,
		})
		expect(n.repeatEnabled).toBe(false)
	})

	it('при capFit и без force — повтор сохраняется', () => {
		const n = mergeAdvWithRecommendedPauses(base, [50, 60], [70, 80], {
			alsoDisableRepeatIfNotFit: true,
			capFit: true,
		})
		expect(n.repeatEnabled).toBe(true)
	})
})
