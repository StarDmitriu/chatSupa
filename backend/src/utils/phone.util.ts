/**
 * Единая нормализация и валидация номеров телефонов.
 * Используется в auth, telegram, whatsapp, leads, admin, payments.
 */

/** Минимальная и максимальная длина номера в цифрах (с кодом страны) */
const MIN_DIGITS = 10;
const MAX_DIGITS = 15;

/**
 * Извлекает только цифры из строки.
 */
export function digitsOnly(input: string): string {
  return String(input ?? '').replace(/\D/g, '');
}

/**
 * Применяет правила страны к цифрам (RU: 8 -> 7, 10 цифр -> 7; BY: 9 цифр -> 375).
 * Возвращает только цифры (без +).
 */
function applyCountryRules(digits: string): string {
  if (!digits) return '';

  // RU: 8XXXXXXXXXX -> 7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }
  // RU: 10 цифр -> код 7
  if (digits.length === 10) {
    digits = '7' + digits;
  }
  // BY: 9 цифр -> код 375
  if (digits.length === 9) {
    digits = '375' + digits;
  }

  return digits;
}

/**
 * Нормализация для хранения в БД (только цифры с кодом страны).
 * Используется в users.phone, otp_codes.phone для совместимости.
 */
export function normalizePhoneForStorage(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const digits = applyCountryRules(digitsOnly(raw));
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return '';
  return digits;
}

/**
 * Нормализация в формат E.164 с плюсом (+79001234567).
 * Для API: Telegram, SMS, Prodamus, отображение.
 */
export function normalizePhoneE164(input: string): string {
  const digits = normalizePhoneForStorage(input);
  return digits ? '+' + digits : '';
}

/**
 * Проверка: строка выглядит как валидный номер после нормализации.
 */
export function isValidPhone(input: string): boolean {
  return normalizePhoneForStorage(input).length >= MIN_DIGITS;
}

/**
 * Для поиска/фильтра: приводит номер к цифрам, чтобы "900" находил "+7 900 123-45-67".
 */
export function phoneDigitsForSearch(input: string): string {
  return digitsOnly(String(input ?? ''));
}
