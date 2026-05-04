/**
 * Базовые секунды «между группами» при режиме с множителем из шаблона.
 * Должны совпадать с backend: TEMPLATE_BETWEEN_GROUPS_* в campaigns.service.ts
 */
export const SERVER_BETWEEN_GROUPS_SEC = {
	tg: [45, 90] as const,
	wa: [45, 120] as const,
} as const
