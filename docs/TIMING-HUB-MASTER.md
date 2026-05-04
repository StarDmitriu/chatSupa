# Мастер планирования (Timing Hub)

Кратко: как устроены **мастер-ползунок**, **цель в минутах**, **автоподбор пауз** и защита от **двойного пересчёта**.

## Цель в минутах (`targetEtaMin`)

- В UI мастер показывает **часы**; в состоянии и sessionStorage хранится **`targetEtaMin`** (целые минуты).
- Диапазон: **`ETA_GOAL_MIN_MIN` … `ETA_GOAL_MAX_MIN`** (`src/lib/timingHubMasterConstants.ts`), кламп — `clampEtaMinutes` (`src/lib/timingHubEtaClamp.ts`).

## Подбор пауз под цель

- `applySmartToTargetSeconds` в `TimingHubDrawer` масштабирует паузы между группами и подгоняет длительность волны к целевым секундам.
- Уведомления `message.*` после подбора идут через **`scheduleTimingApplyFeedback`** (`src/lib/timingHubApplyFeedback.ts`) с задержкой ~420 мс, чтобы серия кликов «±15 м / ±1 ч» не засыпала тостами.

## Автоподбор (smart)

- Флаг **`smartEnabled`** сохраняется в **sessionStorage** (`smartEnabled` в `TimingHubSessionUi`, `timingHubUiStorage.ts`).
- Эффект автоподбора срабатывает при изменении **ключа** `buildSmartAutonudgeKey` (`src/lib/timingHubSmartAutonudgeKey.ts`). Тесты: `timingHubSmartAutonudgeKey.test.ts`.

## Suppress (без дубля после мастера)

- После `commitMasterEtaMinutes` выставляется **`suppressNextSmartAutonudgeRef`**: следующий проход эффекта **только синхронизирует** `smartAppliedKeyRef` с актуальным ключом и **не** вызывает повторный `applySmartToFit` / `applySmartToEta`.

## Deep link «к мастеру»

- `openDrawer('settings', { scrollToMaster: true })` — вкладка «Прогноз», прокрутка к `#timing-hub-section-master`, фокус на `#timing-hub-master-focus` (`TimingHubMasterBlock.tsx`).
- На странице `/dashboard/campaigns/timing` кнопка **«Прогноз: мастер темпа»** вызывает этот вариант; **«Планирование: окно и паузы»** открывает вкладку `calc` (как и раньше для правок окна).

## Файлы

| Файл | Назначение |
|------|------------|
| `components/timingHub/TimingHubMasterBlock.tsx` | UI мастера |
| `components/timingHub/TimingHubItogCard.tsx` | Блок «Итог по запуску» (lazy через `dynamic` в drawer) |
| `components/timingHub/TimingHubLoadCalendar.tsx` | Календарь нагрузки (lazy) |
| `components/timingHub/TimingHubAdvancedTab.tsx` | Вкладка «Окно и паузы» (lazy) |
| `components/timingHub/timingHubPlanTypes.ts` | Типы плана периода / прогноза для вынесенных блоков |
| `lib/timingHubFormat.ts` | Подписи длительности / чисел |
| `lib/timingHubApplyFeedback.ts` | Debounce тостов |
| `lib/timingHubSmartAutonudgeKey.ts` | Ключ эффекта smart |
| `lib/timingHubTime.ts` | `parseHHMMToMinutes`, `formatMinutesToHHMM` |
| `lib/timingHubWaveForecastCompute.ts` | `computeWaveForecast` (Kmin/Kmax, карточки волн) |
| `lib/timingHubSendTimeWarning.ts` | `buildSendTimeWarning` |
| `lib/timingHubPeriodPlanCompute.ts` | `buildPeriodPlan` (календарь периода, цели smart) |
| `lib/timingHubPlanningSummaryCompute.ts` | `buildPlanningPeriodSummary` |
| `lib/timingHubClientVolume.ts` | `buildClientVolumeBreakdown` |
| `lib/timingHubRhythm.ts` | `buildRhythmOneLiner` |
| `lib/timingHubCalendarLayout.ts` | сетка календаря и недельные сводки |
| `lib/timingHubPlanningFix.ts` | `computeNeedsPlanningFix`, `computeDayNeedsQuickFix` |
| `lib/timingHubRiskReasonForDay.ts` | `buildRiskReasonForDay` |
| `lib/timingHubAdvScale.ts` | `scaleAdvBetweenGroups` (масштаб пауз для smart-подбора) |
| `lib/timingHubBothChannelCapacity.ts` | `mergeBothChannelCapacity` (WA+TG → один `CapacityResult`) |
| `lib/timingHubCapacityForAdv.ts` | `computeCapacityForAdvCandidate` (пересчёт ёмкости для кандидатного `adv`) |
| `lib/timingHubPlanTypes.ts` | типы плана / прогноза (источник правды для компонентов) |

### Производительность

- Расчёты (`periodPlan`, `waveForecast`, предупреждения, сводки, календарь) живут в **`src/lib/timingHub*.ts`**; `TimingHubDrawer` только вызывает их в `useMemo`/`useCallback` и прокидывает данные в lazy-блоки. Тесты: `timingHubCompute.test.ts` (время, прогноз, предупреждение, план периода, сводка планирования, календарь, риск по дню, склейка WA+TG, масштаб пауз).
- Логика **бинпоиска пауз** (`applySmartToFit`, `applySmartToTargetSeconds`) по-прежнему в drawer, но опирается на **`scaleAdvBetweenGroups`**, **`computeCapacityForAdvCandidate`** и общую склейку каналов **`mergeBothChannelCapacity`** (тот же merge, что и для основного `cap`).
