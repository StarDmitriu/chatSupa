import type { AdvSettings } from '@/lib/campaignCapacity'

export type RhythmWave = { timeFrom: string; timeTo: string; adv: AdvSettings }

function repeatLabel(adv: AdvSettings): string {
	if (!adv.repeatEnabled) return 'без повтора волны'
	return 'следующая волна через 2–3 часа после завершения предыдущей'
}

export function buildRhythmOneLiner(wave: RhythmWave | null | undefined): string {
	if (!wave) return ''
	return `${wave.timeFrom}–${wave.timeTo} · ${repeatLabel(wave.adv)}`
}
