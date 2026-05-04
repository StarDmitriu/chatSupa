import { describe, expect, it } from 'vitest'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'

describe('timingHubEvents', () => {
	it('строка события стабильна (слушатели и dispatch в разных файлах)', () => {
		expect(TIMING_HUB_CHANGED_EVENT).toBe('timingHub:changed')
	})
})
