# Чанки Next.js и деплой

## Симптомы

- В консоли: `GET ... /_next/static/chunks/<hash>.js` → **404** или **500** (`net::ERR_ABORTED`).
- **404** — обычно «старый HTML в браузере / CDN» ссылается на чанки, которых **уже нет** в текущей сборке на сервере.
- **500** с телом `Internal Server Error` (21 байт, `text/plain`) — **не** «нормальный» ответ на отсутствующий файл: в Node падает обработчик запроса (см. ниже). На практике часто сочетается с **битыми артефактами** после неполного деплоя (остаток старого файла/каталога с тем же именем, права, сбой `fs.stat`).

### Как отличить «битый диск» от простого 404

Если для **случайного** имени `.../deadbeefdeadbeef.js` сервер отдаёт **404**, а для **конкретного** старого хеша из консоли — **500**, на диске у процесса Next часто есть **аномалия именно по этому пути** (или сочетание версий сборки). Лечение: **полное удаление `frontend/.next`**, затем `npm run build` и перезапуск (Docker: `docker compose build --no-cache frontend` при подозрении на кэш слоёв).

## Причина

1. Браузер или CDN держит **старый HTML** со ссылками на чанки **прошлой** сборки.
2. На сервере уже **другая** папка `.next/static/chunks/` — старых имён нет → **404**.
3. Смешение/обломки `.next` между деплоями без очистки → редкие **500** на отдельных путях.

## Что сделано в коде

- **`src/proxy.ts`**: для ответов с `Accept: text/html` — `Cache-Control: no-store` (документ не кэшируется долго; сами чанки — `immutable` из `next.config.ts`).
- **`chunkLoadRecovery`** + **`ChunkLoadRecoveryClient`**: авто‑reload с `?__t=` при ошибке чанка в error boundary и при **сбое загрузки** `script`/`link` на `/_next/static/*` (до гидрации).
- **`package.json` → `start`**: `node .next/standalone/server.js` (при `output: 'standalone'` корректнее, чем `next start`).

## Операционно (сервер)

### Полный выкат и перезапуск

На VPS после `git pull` (или копирования кода):

```bash
cd /var/www   # корень репозитория
./scripts/deploy-frontend-vps.sh
```

Скрипт выполняет: `npm ci` (или `npm install`), **`rm -rf .next`** (если не задано `SKIP_CLEAN=1`), **`npm run build`** (включает `next build` и **postbuild** — копирование `.next/static` и `public` в `.next/standalone`), затем **`pm2 restart frontend`** (имя: `FRONTEND_PM2_NAME=myapp ./scripts/deploy-frontend-vps.sh`).

Альтернатива из каталога `frontend`:

```bash
npm run deploy:vps
```

Вручную (эквивалент):

```bash
cd frontend && rm -rf .next && npm ci && npm run build && pm2 restart frontend --update-env
```

Проверка, что standalone содержит статику:

```bash
test -d frontend/.next/standalone/.next/static && echo OK
```

### nginx / CDN

- **HTML и динамические ответы** — не держать в долгом кэше у nginx/CDN (см. заголовки в приложении и пример ниже).
- **`/_next/static/`** — файлы с хешами в имени; **долгий кэш** (`immutable` / `max-age=31536000`) безопасен.

Готовый фрагмент для вставки в `server { }`: **`deploy/nginx-frontend-next.example.conf`**.

На **Cloudflare**: избегать «Cache Everything» для HTML; для `/_next/static/*` можно отдельное правило с длинным TTL.

### Пользователи со старой вкладкой

- Один раз **жёсткое обновление** (Ctrl+F5 / очистка кэша для сайта) — если вкладка открыта до деплоя.
- **Авто‑reload** при ошибке загрузки чанка — `src/lib/chunkLoadRecovery.ts`, `src/ui/ChunkLoadRecoveryClient.tsx`, `error.tsx` / `global-error.tsx`.
