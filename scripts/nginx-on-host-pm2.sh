#!/usr/bin/env bash
# Nginx на хосте для режима PM2: остановить контейнер nginx, скопировать конфиг,
# включить сайт, перезагрузить nginx. Правило iptables не нужно.
# Запуск: sudo ./scripts/nginx-on-host-pm2.sh   или   sudo npm run nginx:host-pm2

set -e

if [[ $EUID -ne 0 ]]; then
  echo "Запустите с sudo: sudo $0"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF_SRC="$PROJECT_DIR/deploy/nginx/default.pm2.conf"
SITE_NAME="chatrassylka"
SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"
CONF_DEST="$SITES_AVAILABLE/$SITE_NAME"

echo "=== Nginx на хосте для PM2 (proxy 127.0.0.1:3000, :3001) ==="
echo ""

# 1. Остановить контейнер nginx
if command -v docker >/dev/null 2>&1 && [[ -f "$PROJECT_DIR/docker-compose.yml" ]]; then
  (cd "$PROJECT_DIR" && docker compose stop nginx 2>/dev/null) || true
  echo "Контейнер nginx остановлен (или не был запущен)."
else
  echo "Docker не найден или не docker-compose.yml — пропуск остановки контейнера."
fi
echo ""

# 2. Проверить, что nginx установлен
if ! command -v nginx >/dev/null 2>&1; then
  echo "Nginx не установлен. Установите: sudo apt install nginx"
  exit 1
fi

# 3. Скопировать конфиг
mkdir -p "$SITES_AVAILABLE"
cp "$CONF_SRC" "$CONF_DEST"
echo "Конфиг скопирован: $CONF_DEST"
echo ""

# 4. Включить сайт (symlink в sites-enabled)
mkdir -p "$SITES_ENABLED"
ln -sf "$CONF_DEST" "$SITES_ENABLED/$SITE_NAME"
echo "Сайт включён: $SITES_ENABLED/$SITE_NAME -> $CONF_DEST"
echo ""

# 5. Проверка и перезагрузка nginx
if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "Nginx перезагружен."
else
  echo "Ошибка конфига nginx (nginx -t). Исправьте $CONF_DEST и выполните: sudo nginx -t && sudo systemctl reload nginx"
  exit 1
fi
echo ""

echo "Готово. Nginx на хосте проксирует на 127.0.0.1:3000 и 127.0.0.1:3001."
echo "Убедиться, что backend и frontend под PM2 запущены: pm2 list"
echo "При необходимости поднять Redis: cd $PROJECT_DIR && docker compose up -d redis"
echo "SSL: конфиг использует /etc/letsencrypt/live/chatrassylka.ru/ — если certbot только в Docker, скопируйте сертификаты на хост или поправьте пути в $CONF_DEST"
