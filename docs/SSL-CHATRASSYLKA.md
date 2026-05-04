# SSL для chattrassylka.ru

## Что сделано

1. **HTTPS включён** — nginx слушает 45.12.75.57:443 для chattrassylka.ru и www.chattrassylka.ru.
2. **Редирект HTTP → HTTPS** — запросы на http://chatrassylka.ru/ перенаправляются на https://chatrassylka.ru/.
3. **Сертификат** — используется общий сертификат Hestia (`/usr/local/hestia/ssl/`). В браузере будет предупреждение о несоответствии имени, пока не будет выдан сертификат именно для chattrassylka.ru.

## Как получить свой сертификат (Let's Encrypt)

Когда **DNS для chattrassylka.ru** будет указывать на этот сервер (A-запись → 45.12.75.57), выполните:

```bash
sudo certbot --nginx -d chattrassylka.ru -d www.chattrassylka.ru
```

Certbot сам обновит конфиг nginx и подставит пути к сертификатам Let's Encrypt. Продление — автоматически (таймер certbot).

Сейчас certbot не смог выдать сертификат: домен не резолвится (NXDOMAIN). Сначала настройте DNS, затем снова запустите команду выше.

## Проверка

- **HTTP:** `curl -I http://chatrassylka.ru/` → 301, Location: https://chatrassylka.ru/
- **HTTPS:** `curl -I -k https://chatrassylka.ru/` → 200 (с текущим сертификатом)
