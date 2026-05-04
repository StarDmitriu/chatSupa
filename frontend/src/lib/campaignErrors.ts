/**
 * Коды ошибок отправки (TG/WA) → короткий смысл на русском.
 * Используется на странице прогресса рассылки и в бейджах ограничений в списках групп.
 */
export const ERROR_MEANINGS: Record<string, string> = {
  CHAT_ADMIN_REQUIRED: 'Для отправки нужны права администратора в группе',
  CHAT_WRITE_FORBIDDEN: 'Сейчас нет прав на отправку в эту группу',
  CHANNEL_PRIVATE: 'Группа/канал недоступны для отправки',
  CHAT_SEND_DOCS_FORBIDDEN: 'В этой группе запрещены документы',
  CHAT_SEND_MEDIA_FORBIDDEN: 'В этой группе запрещены медиафайлы',
  USER_BANNED_IN_CHANNEL: 'Аккаунт временно не может писать в эту группу',
  PEER_ID_INVALID: 'Группа недоступна для отправки (проверьте доступ)',
  tg_access_hash_missing: 'Временная проблема доступа к группе',
  telegram_not_connected: 'Связь с Telegram временно нестабильна, продолжаем восстановление',
  wa_not_connected: 'Связь с WhatsApp временно нестабильна, продолжаем восстановление',
  send_timeout: 'Отправка заняла слишком много времени, пробуем ещё раз',
  template_not_found: 'Шаблон не найден',
  template_disabled: 'Шаблон отключён',
  wrong_target_for_tg: 'Неверная цель для Telegram',
  wrong_target_for_wa: 'Неверная цель для WhatsApp',
  campaign_paused: 'Рассылка на паузе',
  trial_expired: 'Пробный период закончился',
  subscription_expired: 'Подписка закончилась',
  no_subscription: 'Нет активной подписки',
  plan_not_allowed: 'Тариф не включает этот канал',
  no_access: 'Нет доступа (требуется подписка)',
  database_timeout: 'Сервис временно занят, попробуйте ещё раз через минуту.',
  supabase_jobs_update_error: 'Ошибка обновления задач. Попробуйте ещё раз.',
}

export function errorMeaning(raw: string | null | undefined): string {
  if (!raw || !String(raw).trim()) return ''
  const s = String(raw).trim()
  if (ERROR_MEANINGS[s]) return ERROR_MEANINGS[s]
  if (/^wa_connect_retry_\d+$/i.test(s))
    return 'Восстанавливаем связь с WhatsApp, отправка продолжится автоматически'
  if (/^tg_connect_retry_\d+$/i.test(s))
    return 'Восстанавливаем связь с Telegram, отправка продолжится автоматически'
  if (/media upload failed/i.test(s))
    return 'Не удалось отправить медиафайл, проверьте файл и повторите отправку'
  if (/peer_id_invalid|channel_invalid|chat_write_forbidden|user_banned_in_channel/i.test(s))
    return 'Группа недоступна для отправки, пропускаем её и продолжаем'
  if (/whatsapp_not_connected/i.test(s))
    return 'Связь с WhatsApp временно нестабильна, выполняем автовосстановление'
  if (/telegram_not_connected/i.test(s))
    return 'Связь с Telegram временно нестабильна, выполняем автовосстановление'
  if (/wait of \d+ second/i.test(s))
    return 'Telegram временно ограничил частоту отправки, продолжаем автоматически'
  if (/flood/i.test(s)) return 'Временное ограничение по скорости отправки, продолжаем автоматически'
  if (/timeout|etimedout|fetch failed|network/i.test(s))
    return 'Нестабильное соединение, пробуем доставить автоматически'
  return 'Временная техническая сложность, система продолжает отправку автоматически'
}
