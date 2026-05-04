#!/usr/bin/env bash
# Текущий режим продакшена: PM2. Backend и frontend на хосте; nginx и redis в Docker.
# Переключить nginx в Docker на проксирование на хост (PM2).
# Устраняет 502, когда backend и frontend под PM2, а nginx смотрит на контейнеры.
# Использование: ./scripts/nginx-pm2-docker.sh   или   npm run nginx:pm2-docker

set -e
cd "$(dirname "$0")/.."

echo "=== Nginx в Docker: переключение на PM2 (host.docker.internal:3000, :3001) ==="
docker compose -f docker-compose.yml -f docker-compose.pm2.yml up -d nginx
echo ""
echo "Готово. Nginx проксирует на хост (backend и frontend под PM2)."
echo "Проверка: curl -s -o /dev/null -w '%{http_code}' https://chatrassylka.ru/"
echo ""
