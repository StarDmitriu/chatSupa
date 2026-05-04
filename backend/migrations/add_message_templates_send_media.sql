-- Колонка send_media_as_file для шаблонов (дублирует supabase_add_send_media_as_file.sql для миграций)
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS send_media_as_file boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN message_templates.send_media_as_file IS 'Если true — медиа отправляется как файл/документ; иначе как фото/видео/аудио';
