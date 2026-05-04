-- Часовой пояс пользователя для корректного времени рассылок
ALTER TABLE users
ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'Europe/Moscow';

COMMENT ON COLUMN users.timezone IS 'IANA timezone (например Europe/Moscow) для времени рассылок';
