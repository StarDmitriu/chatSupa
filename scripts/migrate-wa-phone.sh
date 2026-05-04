#!/bin/bash
# Применяет миграцию wa_phone к таблице whatsapp_groups.
# Использование:
#   SUPABASE_DB_URL='postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres' ./scripts/migrate-wa-phone.sh
# или добавьте SUPABASE_DB_URL в backend/.env и запустите без аргументов (подхватит из .env).

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "$SUPABASE_DB_URL" ] && [ -z "$DATABASE_URL" ]; then
  if [ -f "$PROJECT_ROOT/backend/.env" ]; then
    set -a
    source "$PROJECT_ROOT/backend/.env"
    set +a
  fi
fi

DB_URL="${SUPABASE_DB_URL:-$DATABASE_URL}"
if [ -z "$DB_URL" ]; then
  echo "Не задана строка подключения. Укажите SUPABASE_DB_URL или DATABASE_URL (или добавьте в backend/.env)."
  echo "Скопировать: Supabase Dashboard → Settings → Database → Connection string (URI)."
  exit 1
fi

SQL_FILE="$PROJECT_ROOT/backend/migrations/add_wa_phone_to_groups.sql"
if [ ! -f "$SQL_FILE" ]; then
  echo "Файл миграции не найден: $SQL_FILE"
  exit 1
fi

if command -v psql &>/dev/null; then
  echo "Выполняем миграцию через psql..."
  psql "$DB_URL" -f "$SQL_FILE"
  echo "Готово."
else
  echo "psql не найден. Запустите из backend: npm run migrate:wa-phone (нужен Node и pg)."
  exit 1
fi
