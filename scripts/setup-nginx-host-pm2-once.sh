#!/usr/bin/env bash
# Один раз запустить С ПАРОЛЕМ: sudo ./scripts/setup-nginx-host-pm2-once.sh
# Скрипт: добавит правило sudoers (дальше sudo npm run nginx:host-pm2 — без пароля),
# установит nginx, настроит и перезагрузит nginx. Пароль sudo понадобится только в этот раз.

set -e

if [[ $EUID -ne 0 ]]; then
  echo "Запустите один раз с паролем: sudo $0"
  echo "После этого sudo npm run nginx:host-pm2 будет работать без пароля."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NGINX_SCRIPT="$PROJECT_DIR/scripts/nginx-on-host-pm2.sh"
SUDOERS_FILE="/etc/sudoers.d/chatrassylka-nginx"

# Пользователь, от имени которого вызвали sudo (чтобы ему разрешить NOPASSWD)
REAL_USER="${SUDO_USER:-}"
if [[ -z "$REAL_USER" ]]; then
  REAL_USER="$(stat -c %U "$PROJECT_DIR" 2>/dev/null)" || true
fi
if [[ -z "$REAL_USER" || "$REAL_USER" == root ]]; then
  REAL_USER="deploy"
fi

echo "=== Один раз: разрешение без пароля + nginx на хосте для PM2 ==="
echo "Пользователь для NOPASSWD: $REAL_USER"
echo ""

# 1. Добавить правило sudoers: этот пользователь может запускать nginx-on-host-pm2.sh без пароля
echo "# Разрешить $REAL_USER запускать nginx-on-host-pm2 без пароля. Добавлено setup-nginx-host-pm2-once.sh" > "$SUDOERS_FILE"
echo "$REAL_USER ALL=(ALL) NOPASSWD: $NGINX_SCRIPT" >> "$SUDOERS_FILE"
chmod 440 "$SUDOERS_FILE"
echo "Правило sudoers добавлено: $SUDOERS_FILE (дальше sudo npm run nginx:host-pm2 — без пароля)"
echo ""

# 2. Установить nginx, если ещё нет
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y nginx
  echo "Nginx установлен."
else
  echo "Nginx уже установлен."
fi
echo ""

# 3. Запустить настройку nginx (конфиг, перезагрузка)
exec "$NGINX_SCRIPT"
