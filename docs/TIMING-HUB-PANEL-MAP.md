# Панель «Планирование — сводка»: связи и источники данных

Краткая карта того, как устроен `TimingHubDrawer` и что с чем синхронизировано.

## Единый источник правды по окружению

| Данные | Где хранится | Кто читает / пишет |
|--------|----------------|---------------------|
| Окно суток `timeFrom` / `timeTo` | `localStorage` `campaigns_time_window_v2` | Рассылки (страница), панель планирования, сводка `/campaigns/timing`; синхрон через `timingHub:changed` |
| Паузы и повтор (`AdvSettings`) | `localStorage` `campaigns_adv_settings_v1` | То же |
| **Канал прогноза** TG+WA / TG / WA | `localStorage` `campaigns_timing_start_mode_v1` | Сегмент «Запуск» на `/dashboard/campaigns` и сегмент «Канал» в панели; `readTimingStartMode` / `writeTimingStartMode` в `timingHubSession.ts` |
| Правки дней календаря (метки) | `localStorage` `campaigns_day_overrides_v1` | Только панель |
| Свёрнутость «Расширенных настроек» | `localStorage` `timing_hub_advanced_collapsed_v1` | Только панель |
| Тур | `localStorage` `timing_hub_intro_tour_v1` | Панель |
| Режим оценки + тонкий коэф. | `localStorage` `timing_hub_capacity_v1` | Панель; переживает F5 |
| UI панели (раздел, цель, период, календарь, ETA) | `sessionStorage` `timing_hub_session_ui_v1` | Панель; переживает закрытие drawer в той же вкладке |

**Только в React (до перезагрузки):** автоподбор (`smartEnabled`).

## Цепочка расчёта «Итога»

1. **`counts`** — API: число выбранных групп, шаблонов, targets, `send_time` мета, speed factors.
2. **`startMode`** — определяет, какие каналы участвуют в `computeCapacity` (один канал или оба с `max(TG, WA)` по времени).
3. **`wave`** — окно и `adv` из LS; участвуют в `cap` как паузы и повтор.
4. **`capacityMode` / `customBufferMultiplier`** — множитель длительности волны («Побыстрее / С запасом / Тонкая точность»).
5. **`cap`** (`campaignCapacity.ts`) — `totalSec`, `winSec`, `fit`, `totalJobs`, рекомендуемые диапазоны пауз и т.д.
6. **`periodPlan`** — на базе `cap` и периода: волны в сутках, дневные карточки, `canFitGoal`, `capacityGapSec`, `waveFitsInWindow`.
7. **`dayLoadPercent`** — \((wavesMax × cap.totalSec / cap.winSec) × 100\); календарь и «риск» по дню согласованы с тем же `cap`, что и итог.

## Цели (сегмент «Цель»)

- **`oneWave`** — одна полная волна на **весь выбранный период** календаря (не «волна каждый день»). В `periodPlan` сумма волн за период = **1**, в дневных карточках объём только у **первого дня** периода, остальные дни с нулём отправок; автоподбор часто отключает повтор. Для **`finishAt`** и «сколько волн влезло бы, если гонять каждый день» внутри расчёта используются отдельно `wavesCapacityMin` / `wavesCapacityMax` (произведение волн/день × дни), чтобы цель **eta** не ломалась.
- **`fit`** — уложиться в окно; календарь — как при ежедневном плане с текущим repeat.
- **`eta`** — целевая длительность волны в минутах + автоподбор пауз.

Помимо автоподбора, **`oneWave`** меняет **агрегацию календаря** и строки «за период» в сводке; **`fit` / `eta`** — нет. Базовый `cap` считается от текущих пауз и окна в любом случае.

## Что намеренно «не связано» с бэкендом в реальном времени

- Расчёт волны — **клиентский прогноз** по тем же правилам, что закладывает планировщик, но без учёта сетевых задержек и очередей воркеров.
- `send_time` по группам — в прогнозе учитываются агрегаты/предупреждения (`sendTimeWarning`), а не полное поминутное расписание по каждому чату.

## Известные ограничения UX

- Рекомендации вида «TG 5–10 сек» — **нижняя граница из формулы** «влезть в окно»; для мессенджеров реальные минимальные паузы могут быть выше — ориентируйтесь на опыт и лимиты API.
- Если одна волна **длиннее суточного окна**, в календаре всё равно показывается **1 волна/день** и нагрузка **>100%**, чтобы не противоречить объёму сообщений (см. комментарий в коде `periodPlan`).

## Матрица контролов (правая панель)

| Элемент | Состояние / хранение | Эффект |
|--------|----------------------|--------|
| Segmented «Прогноз / Окно и паузы / Справка» | React `toolSection`, прокрутка + scroll-spy | Только навигация по якорям внутри drawer |
| Период календаря | React `periodPreset`, custom range | Влияет на **календарь** и строки «за период» в сводке; **не** меняет `cap` и автоподбор пауз |
| Цель (1 волна / В окно / Длит. волны) | React `smartGoal` | Автоподбор: `oneWave` → `forceNoRepeat`; `fit` → в окно; `eta` → бинпоиск по длительности. Календарь: при `oneWave` одна волна на первый день периода |
| Слайдер «Длит. волны» (мин) | React `targetEtaMin` | Только при `smartGoal === 'eta'`; при первом входе в eta инициализируется из текущей длительности волны |
| Канал TG/WA | `localStorage` `campaigns_timing_start_mode_v1` + событие | Синхрон с «Запуск» на «Рассылках»; меняет `cap` и пересчёт |
| Автоподбор (Switch) | React `smartEnabled` | Вкл → эффект подбирает паузы по цели; **слайдеры пауз и Switch повтора** в расширенных настройках **disabled** |
| «Пересчитать подбор» | Сбрасывает `smartAppliedKeyRef` | Повторный прогон автоподбора при том же ключе ввода |
| «Оценка времени» Segmented + слайдер коэф. | React + влияет на `cap` через `computeCapacity` | Меняет длительность волны в прогнозе; при вкл. автоподборе пересчёт сработает (ключ эффекта включает buffer) |
| TimePicker окна | `localStorage` `campaigns_time_window_v2` через `persistWave` | Меняет окно и `cap`; автоподбор пересчитывает паузы |
| Слайдеры пауз / повтор | `localStorage` `campaigns_adv_settings_v1` | Вручную только при **выкл** автоподборе |
| «Готово» | `timingHub:changed` | Уведомляет остальной UI; новые значения уже в LS |
| «Сброс к автоподбору» | Вкл smart, safe 1.35, сброс ключа | Следующий тик эффекта применит подбор |
| «Выбрать действие» | Dropdown | Учитывает **цель**: при `oneWave` принудительно выключает повтор вместе с подсказочными паузами |
| Календарь: дни / быстрые действия | `dayOverrides` в LS | Локальные метки + `applyAction` (окно 08–23:59, паузы из подсказки, выкл. повтор) |
| Обзор / тур | LS `timing_hub_intro_tour_v1` | Онбординг |

## Файлы

- Общее чтение окна/пауз из LS: `frontend/src/lib/campaignWaveLocal.ts`
- UI панели в session + capacity в LS + снимок: `frontend/src/lib/timingHubUiStorage.ts`
- UI и логика панели: `frontend/src/components/TimingHubDrawer.tsx`
- Контекст открытия: `frontend/src/components/TimingHubContext.tsx`
- Общие ключи сессии/канала: `frontend/src/components/timingHubSession.ts`
- Формулы вместимости: `frontend/src/lib/campaignCapacity.ts`
- Страница запуска: `frontend/src/app/dashboard/campaigns/page.tsx`

---

## Сделано из бэклога (реализация)

- **sessionStorage** `timing_hub_session_ui_v1` — раздел «Прогноз/Окно/Справка», цель, период, свой диапазон, режим календаря, `targetEtaMin`; сброс `toolSection` при закрытии drawer убран.
- **localStorage** `timing_hub_capacity_v1` — «Побыстрее / С запасом / Тонкая точность» и коэффициент.
- **Слайдеры пауз** — запись в LS и `persistWave` по **`onChangeComplete`**; черновик движения через `advSliderDraft`. Коэф. запаса — черновик + `onChangeComplete`.
- **DRY** — `src/lib/campaignWaveLocal.ts` (`readLocalWaveSettings`, ключи окна/пауз); «Рассылки» и `/campaigns/timing` переведены на него.
- **Удалён** неиспользуемый `CampaignTimingHubDrawer.tsx` (стили остаются в `CampaignTimingHubDrawer.css`).
- **Dev:** `useTimingHub()` без Provider — однократный `console.warn`.
- **Кнопка** «Сбросить метки «правка»» у календаря; **«Скопировать снимок настроек»** в блоке диагностики (`collectTimingHubLocalSnapshot`).
- **a11y:** скрытый текст + `aria-live="polite"` у статуса «Успеете / Риск».
- **Drawer:** при ширине viewport ≤576px — `width: 100%`.
- **Тесты:** `vitest`, `npm run test`, `src/lib/campaignWaveLocal.test.ts`.

## Дальнейшие улучшения

- **Профиль тайминга на сервере** — фаза C в `CAMPAIGN-TIMING-HUB-PROPOSAL.md` (синхрон устройств, API).
- Расширить тестами чистую логику `periodPlan` / `oneWave` (при выносе в `lib`).

### Уже покрыто документацией

- Синхрон канала с «Рассылками»: `campaigns_timing_start_mode_v1` + `timingHub:changed` (см. выше и `CAMPAIGN-TIMING-HUB-PROPOSAL.md`).
