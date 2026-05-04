-- Добавить опцию «отправлять медиа как файл» в шаблоны сообщений.
-- По умолчанию false: картинка/видео/аудио уходят как медиа (открываются в ТГ/WA).
-- true: медиа уходит как документ/файл.
ALTER TABLE message_templates
ADD COLUMN IF NOT EXISTS send_media_as_file boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN message_templates.send_media_as_file IS 'Если true — медиа отправляется как файл/документ; иначе как фото/видео/аудио';
