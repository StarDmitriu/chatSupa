#!/usr/bin/env bash
# Полный деплой через Docker: сборка образов, запуск, ожидание healthy.
# Использование: ./scripts/deploy-docker.sh   или   npm run deploy:docker

set -e
cd "$(dirname "$0")/.."

echo "=== ЧатРассылка: деплой Docker ==="

if [ ! -f backend/.env ]; then
  echo "Ошибка: backend/.env не найден."
  exit 1
fi

echo "Сборка образов backend и frontend..."
docker compose build backend frontend

echo "Запуск всех сервисов..."
docker compose up -d

echo "Ожидание healthy (redis, backend, frontend) — до 2 минут..."
for i in $(seq 1 24); do
  sleep 5
  if ! docker compose ps 2>/dev/null | grep -qE 'unhealthy|starting'; then
    echo "Все сервисы healthy."
    docker compose ps
    echo ""
    echo "Готово. Сайт: https://chatrassylka.ru"
    exit 0
  fi
  echo "  ... ждём (${i}/24)"
done

echo "Предупреждение: не все сервисы перешли в healthy за 2 минуты."
docker compose ps
exit 1
