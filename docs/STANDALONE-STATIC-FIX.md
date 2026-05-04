# Исправление статики в Next.js standalone режиме

## Проблема

При запуске Next.js в режиме `standalone` (`output: "standalone"` в `next.config.ts`) статические файлы не отдавались:

1. **CSS файлы** (`/_next/static/chunks/*.css`) — 404
2. **Изображения из `public/`** (`/fon.png`, `/iconFoto.png`) — 404

## Причина

В standalone режиме Next.js создаёт минимальный бандл в `.next/standalone/`, но:
- `.next/static/` не копируется в `.next/standalone/.next/static/`
- `public/` не копируется в `.next/standalone/public/`

При запуске `node .next/standalone/server.js` процесс работает из папки `.next/standalone/`, поэтому Next.js ищет статику относительно этой папки.

## Решение

### Автоматическое (рекомендуется)

В `frontend/package.json` добавлен скрипт `postbuild`, который автоматически копирует нужные папки после сборки:

```json
"postbuild": "cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public"
```

При каждом `npm run build` статика автоматически копируется в standalone.

### Ручное копирование

Если нужно скопировать вручную (например, после изменения файлов в `public/` без пересборки):

```bash
cd /var/www/frontend
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
pm2 restart frontend
```

## Проверка

После исправления все ресурсы должны отдаваться с кодом 200:

```bash
curl -I https://chatrassylka.ru/fon.png
curl -I https://chatrassylka.ru/_next/static/chunks/1f245530a97e4d30.css
curl -I https://chatrassylka.ru/iconFoto.png
```

## Примечание

Это стандартное поведение Next.js standalone — он не включает статику автоматически, чтобы уменьшить размер бандла. В Docker это решается через `COPY` в Dockerfile, при PM2 нужно копировать вручную или через postbuild скрипт.
