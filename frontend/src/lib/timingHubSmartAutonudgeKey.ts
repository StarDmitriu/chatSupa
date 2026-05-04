import type { CapacityMode, StartMode } from '@/lib/campaignCapacity'

export type SmartAutonudgeKeyInput = {
	smartGoal: 'oneWave' | 'fit' | 'eta'
	targetEtaMin: number
	timeFrom: string
	timeTo: string
	startMode: StartMode
	capacityMode: CapacityMode
	customBufferEnabled: boolean
	customBufferMultiplier: number
	/** Число включённых шаблонов (как в счётчике панели). */
	tplEnabled: number
	waSelected: number
	tgSelected: number
	waSpeedFactors: readonly number[]
	tgSpeedFactors: readonly number[]
}

/** Ключ для эффекта автоподбора пауз (изменился → пересчитать). */
export function buildSmartAutonudgeKey(p: SmartAutonudgeKeyInput): string {
	return [
		p.smartGoal,
		Math.floor(p.targetEtaMin),
		p.timeFrom,
		p.timeTo,
		p.startMode,
		p.capacityMode,
		String(p.customBufferEnabled),
		p.customBufferEnabled ? p.customBufferMultiplier.toFixed(2) : 'n/a',
		String(p.tplEnabled),
		String(p.waSelected),
		String(p.tgSelected),
		p.waSpeedFactors.join(','),
		p.tgSpeedFactors.join(','),
	].join('|')
}
