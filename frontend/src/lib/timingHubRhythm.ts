import type { AdvSettings } from '@/lib/campaignCapacity'

export type RhythmWave = { timeFrom: string; timeTo: string; adv: AdvSettings }

function repeatLabel(adv: AdvSettings): string {
	if (!adv.repeatEnabled) return 'без повтора волны'
	return 'следующая волна на следующий календарный день (время начала окна)'
}

export function buildRhythmOneLiner(wave: RhythmWave | null | undefined): string {
	if (!wave) return ''
	return `${wave.timeFrom}–${wave.timeTo} · ${repeatLabel(wave.adv)}`
}
