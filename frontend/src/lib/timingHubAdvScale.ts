import type { AdvSettings } from '@/lib/campaignCapacity'

/**
 * Раньше масштабировали паузы со страницы; паузы задаются в шаблонах — масштабирование не применяется.
 */
export function scaleAdvBetweenGroups(adv: AdvSettings, _scale: number): AdvSettings {
	return { ...adv }
}
