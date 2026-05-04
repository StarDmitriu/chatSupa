-- Добавляем wa_phone для фильтрации групп по номеру WhatsApp (когда у пользователя были подключены разные номера)
ALTER TABLE whatsapp_groups
  ADD COLUMN IF NOT EXISTS wa_phone text;

COMMENT ON COLUMN whatsapp_groups.wa_phone IS 'Номер WhatsApp (wa_id), с которого синхронизирована группа. Для фильтрации при нескольких подключённых номерах.';

CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_user_wa_phone
  ON whatsapp_groups(user_id, wa_phone)
  WHERE wa_phone IS NOT NULL;

COMMENT ON INDEX idx_whatsapp_groups_user_wa_phone IS 'Ускоряет фильтрацию групп по номеру WhatsApp';
