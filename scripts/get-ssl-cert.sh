#!/bin/bash
# Автоматическое получение SSL-сертификата Let's Encrypt для chattrassylka.ru
# Использование: sudo /var/www/scripts/get-ssl-cert.sh

set -e

DOMAIN="chatrassylka.ru"
DOMAINS="$DOMAIN www.$DOMAIN"

echo "=== Получение SSL-сертификата для $DOMAIN ==="
echo ""

# Проверка DNS
echo "Проверка DNS..."
DNS_IP=$(dig +short $DOMAIN A 2>/dev/null | head -1 || echo "")
if [ -z "$DNS_IP" ]; then
  echo "❌ Ошибка: домен $DOMAIN не резолвится (DNS не настроен)"
  echo ""
  echo "Настройте DNS A-запись для $DOMAIN → IP этого сервера"
  echo "Проверка: nslookup $DOMAIN (должен вернуть IP сервера)"
  exit 1
fi

SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s icanhazip.com 2>/dev/null || echo "45.12.75.57")
if [ "$DNS_IP" != "$SERVER_IP" ]; then
  echo "⚠️  Внимание: DNS указывает на $DNS_IP, а сервер на $SERVER_IP"
  echo "   Убедитесь, что DNS A-запись указывает на IP этого сервера"
  read -p "Продолжить? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[yY] ]]; then
    exit 1
  fi
fi

echo "✓ DNS резолвится: $DNS_IP"
echo ""

# Получение сертификата
echo "Запуск certbot..."
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN --no-eff-email

echo ""
echo "✓ Сертификат получен и установлен в nginx"
echo ""
echo "Проверка:"
echo "  curl -I https://$DOMAIN/"
echo ""
