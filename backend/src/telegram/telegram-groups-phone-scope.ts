/**
 * Единая семантика «пул групп активного TG-аккаунта»:
 * tg_phone совпадает с ключом (например tgid:…) ИЛИ NULL/legacy до бэкфилла.
 * Использовать везде, где раньше стояло .eq('tg_phone', activeKey) для выборок пользователю/волне.
 */
export function applyTelegramGroupsTgPhoneScope(
  q: any,
  activeAccountKey: string,
): any {
  const safe = String(activeAccountKey).replace(/"/g, '""');
  return q.or(`tg_phone.is.null,tg_phone.eq."${safe}"`);
}
