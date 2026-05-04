#!/usr/bin/env bash
# Деплой Next.js frontend на VPS: полная сборка (.next + postbuild в standalone) и перезапуск PM2.
# Использование (с сервера, из корня репозитория):
#   ./scripts/deploy-frontend-vps.sh
# Или из frontend:
#   npm run deploy:vps
#
# Требования: Node.js, npm, pm2; процесс PM2 с именем по умолчанию «frontend» (см. FRONTEND_PM2_NAME).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="$ROOT/frontend"
FRONTEND_PM2_NAME="${FRONTEND_PM2_NAME:-frontend}"

cd "$FRONTEND_DIR"

echo "=== Frontend: каталог $(pwd) ==="

if [ ! -f package.json ]; then
	echo "Ошибка: package.json не найден в $FRONTEND_DIR"
	exit 1
fi

echo "==> Установка зависимостей (npm ci при наличии lock-файла)"
if [ -f package-lock.json ]; then
	npm ci
else
	npm install
fi

if [ "${SKIP_CLEAN:-}" = "1" ]; then
	echo "==> SKIP_CLEAN=1 — старый каталог .next не удаляем"
else
	echo "==> Удаление .next (иначе на диске остаются «чужие» чанки → 404/500 и смешение с новой сборкой)"
	rm -rf .next
fi

echo "==> Сборка: next build + postbuild (копирование .next/static и public в standalone)"
npm run build

echo "==> Перезапуск PM2: $FRONTEND_PM2_NAME"
if command -v pm2 >/dev/null 2>&1; then
	pm2 restart "$FRONTEND_PM2_NAME" --update-env
	pm2 save 2>/dev/null || true
else
	echo "Предупреждение: pm2 не найден в PATH. Перезапустите процесс вручную, например:"
	echo "  pm2 restart $FRONTEND_PM2_NAME"
	exit 1
fi

echo ""
echo "Готово. Проверка:"
echo "  curl -sI http://127.0.0.1:3001/ | head -5"
echo "Документация: docs/FRONTEND-CHUNKS-DEPLOY.md"
