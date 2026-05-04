/**
 * Единые константы каналов для UI и вызовов API.
 * Синхронизировать с бэкендом: plan_code (wa, tg, wa_tg), channel в campaigns.
 */

export const CHANNELS = ['wa', 'tg'] as const
export type Channel = (typeof CHANNELS)[number]

export const CHANNEL_LABELS: Record<Channel, string> = {
  wa: 'WhatsApp',
  tg: 'Telegram',
}

/** Коды тарифов подписки (Prodamus, subscriptions.plan_code) */
export const PLAN_CODES = ['wa', 'tg', 'wa_tg'] as const
export type PlanCode = (typeof PLAN_CODES)[number]

export const PLAN_LABELS: Record<PlanCode, string> = {
  wa: 'WhatsApp',
  tg: 'Telegram',
  wa_tg: 'WhatsApp + Telegram',
}

/** Цены тарифов (руб/мес) для отображения в кабинете и на странице подписки */
export const PLAN_PRICES: Record<PlanCode, number> = {
  wa: 2000,
  tg: 1000,
  wa_tg: 2500,
}

export function isChannel(v: string): v is Channel {
  return CHANNELS.includes(v as Channel)
}

export function isPlanCode(v: string): v is PlanCode {
  return PLAN_CODES.includes(v as PlanCode)
}
