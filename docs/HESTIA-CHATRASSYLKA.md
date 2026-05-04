# chattrassylka.ru в Hestia

## Что сделано

Домен **chattrassylka.ru** добавлен в Hestia для пользователя **admin**:

- **Панель:** https://45.12.75.57:8083 (или ваш адрес Hestia) → раздел «Web» → домен chattrassylka.ru.
- **Конфиг nginx:** наш прокси (backend 3000, frontend 3001) задан в `/etc/nginx/conf.d/chatrassylka.ru.conf` и обрабатывает запросы первым, поэтому отдаётся приложение ЧатРассылка, а не стандартная страница Hestia.

## SSL (Let's Encrypt)

Сейчас у домена **SSL: no**. После настройки DNS (A-запись chattrassylka.ru → 45.12.75.57) можно включить бесплатный SSL:

**Через панель Hestia:**
1. Web → chattrassylka.ru → вкладка «SSL».
2. Включить Let's Encrypt (галочка «Let's Encrypt» и кнопка сохранения).

**Через CLI:**
```bash
# Когда DNS уже указывает на сервер:
v-add-letsencrypt-domain admin chattrassylka.ru
```

Либо запустить скрипт: `sudo /var/www/scripts/get-ssl-cert.sh`.

## Важно

- Не удаляйте домен chattrassylka.ru из Hestia — иначе пропадёт конфиг из `conf.d/domains/`.
- Наш прокси в `/etc/nginx/conf.d/chatrassylka.ru.conf` при перезагрузке nginx загружается и продолжает отдавать приложение. Если в панели «пересобрать» домен, конфиг Hestia обновится, но наш файл в `conf.d/` остаётся и по-прежнему обрабатывает запросы первым.
