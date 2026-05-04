# Планирование (Timing Hub): границы и где что

## Где живёт UI

- **`TimingHubRoot`** (`src/components/TimingHubRoot.tsx`) — провайдер и **`TimingHubDrawer`** подключены в **корневом** `app/layout.tsx`, чтобы панель «Планирование» открывалась и из дашборда, и из личного кабинета, и с любых маршрутов приложения.
- Раньше провайдер был только в `dashboard/layout.tsx` — вне `/dashboard/*` хук `useTimingHub` возвращал заглушку.

## Прогноз vs сервер

- Расчёты в панели — **клиентский симулятор** по выбранным группам/шаблонам и настройкам волны из **localStorage** этого браузера.
- Очередь на сервере (`scheduled_at`, повторы, паузы кампании, фикс. время в шаблонах) может **отличаться**; в панели есть информационный блок с пояснением и ссылками на «Рассылки» и «Сводку интервалов».

## Связанные страницы

- `/dashboard/campaigns` — запуск и активные кампании.
- `/dashboard/campaign` — прогресс конкретной кампании (после старта).
- `/dashboard/campaigns/timing` — сводка интервалов (те же локальные окно/паузы).

## Событие синхронизации

Константа **`TIMING_HUB_CHANGED_EVENT`** (`src/lib/timingHubEvents.ts`, значение `'timingHub:changed'`) — одно имя для `dispatchEvent` и `addEventListener` между панелью, страницей рассылок, шаблонами и группами TG. Тест стабильности строки: `timingHubEvents.test.ts`.

## E2E (Playwright)

- Скрипты: `npm run test:e2e`, при необходимости `PLAYWRIGHT_SKIP_WEBSERVER=1` если dev уже запущен.
- Первый запуск: `npx playwright install chromium`. На Linux при ошибке `libgbm.so.1`: `npx playwright install-deps` или см. `e2e/README.md`.
- Смоук: `e2e/smoke.spec.ts`. Сценарий с панелью и авторизацией — заготовка `e2e/timing-hub.spec.ts` (пока `skip`, нужен тестовый логин / `storageState`).
- У корня drawer в DOM: **`data-testid="timing-hub-drawer"`** (для селекторов в тестах).
