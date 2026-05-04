'use client'

import { DownOutlined } from '@ant-design/icons'
import { Button, Dropdown, Progress, Tag } from 'antd'
import { memo } from 'react'

import type { CapacityResult } from '@/lib/campaignCapacity'
import { formatMsgCount } from '@/lib/timingHubFormat'
import type { StoredSmartGoal } from '@/lib/timingHubUiStorage'

import type {
	TimingHubDayCard,
	TimingHubPeriodPlan,
	TimingHubPlanningPeriodSummary,
	TimingHubWeekSummaryCard,
} from '@/lib/timingHubPlanTypes'

export type TimingHubLoadCalendarProps = {
	periodPlan: TimingHubPeriodPlan
	planningPeriodSummary: TimingHubPlanningPeriodSummary | null
	smartGoal: StoredSmartGoal
	calendarMode: 'days' | 'list' | 'weeks'
	onCalendarModeChange: (m: 'days' | 'list' | 'weeks') => void
	calendarDayRows: Array<Array<TimingHubDayCard | null>>
	calendarWeekCards: TimingHubWeekSummaryCard[]
	dayLoadPercent: (day: Pick<TimingHubDayCard, 'jobsMax' | 'wavesMax'>) => number
	getDayStatus: (jobs: number, load: number) => 'ok' | 'risk' | 'empty'
	getLoadColor: (load: number) => string
	selectedDayKey: string | null
	onSelectDayKey: (key: string) => void
	dayOverrides: Record<string, { action: string; updatedAt: number }>
	onClearDayOverrides: () => void
	selectedDay: TimingHubDayCard | null
	dayNeedsQuickFix: (loadPct: number) => boolean
	riskReasonForDay: (day: Pick<TimingHubDayCard, 'jobsMax' | 'wavesMax'>, load: number) => string
	onApplyDayAction: (action: 'reducePauses' | 'disableRepeat' | 'shiftWindow', dateKey: string) => void
	waveTimeFrom: string
	waveTimeTo: string
	cap: CapacityResult
	onScrollToAdvanced: () => void
}

function TimingHubLoadCalendarInner(p: TimingHubLoadCalendarProps) {
	const maxLoad = p.periodPlan.dayCards.length
		? Math.max(...p.periodPlan.dayCards.map((d) => p.dayLoadPercent(d)))
		: 0
	const overloadedDays = p.periodPlan.dayCards.filter((d) => p.dayLoadPercent(d) > 100).length

	return (
		<div className='timing-hub-period-days' style={{ marginTop: 10 }}>
			<div
				className='timing-hub-drawer__sectionLabel'
				style={{ margin: '0 0 8px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}
			>
				<span>Календарь нагрузки</span>
				<Button type='link' size='small' style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={p.onClearDayOverrides}>
					Сбросить метки «правка»
				</Button>
			</div>
			{p.planningPeriodSummary?.calendar ? (
				<div
					className='timing-hub-load-calendar__summary'
					style={{
						marginBottom: 10,
						padding: '10px 12px',
						borderRadius: 12,
						background: 'rgba(255,255,255,0.72)',
						border: '1px solid rgba(0,0,0,0.08)',
						fontSize: 12.5,
						lineHeight: 1.45,
						display: 'flex',
						flexWrap: 'wrap',
						alignItems: 'center',
						gap: 10,
					}}
				>
					<div style={{ fontWeight: 800, fontSize: 20, lineHeight: 1.2 }}>{Math.round(maxLoad)}%</div>
					<div style={{ fontSize: 12.5, flex: '1 1 140px' }}>
						Перегруз &gt;100%: <b>{overloadedDays}</b> / {p.periodPlan.dayCards.length}
					</div>
					<Button size='small' type='primary' onClick={p.onScrollToAdvanced}>
						Окно и паузы
					</Button>
				</div>
			) : null}

			<div className='timing-hub-load-calendar__scroll'>
				<div className='timing-hub-load-calendar__gridWrap'>
					<div className='timing-hub-load-calendar__weekdayRow'>
						{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w) => (
							<div key={w} className='timing-hub-load-calendar__weekdayCell'>
								{w}
							</div>
						))}
					</div>
					{p.calendarDayRows.map((weekRow, weekIdx) => (
						<div key={`week-row-${weekIdx}`} className='timing-hub-load-calendar__weekRow'>
							{weekRow.map((d, dayIdx) => {
								if (!d)
									return (
										<div
											key={`empty-${weekIdx}-${dayIdx}`}
											className='timing-hub-load-calendar__dayCell timing-hub-load-calendar__dayCell--empty'
										/>
									)
								const load = p.dayLoadPercent(d)
								const status = p.getDayStatus(d.jobsMax, load)
								const isSelected = p.selectedDayKey === d.dateKey
								const tip = `${d.label}: отправок ${formatMsgCount(d.jobsMax)}, волн ${d.wavesMax}, загрузка окна ${Math.round(load)}%`
								return (
									<button
										type='button'
										key={d.dateKey}
										title={tip}
										aria-label={tip}
										aria-pressed={isSelected}
										onClick={() => p.onSelectDayKey(d.dateKey)}
										className={
											'timing-hub-load-calendar__dayCell timing-hub-load-calendar__dayBtn' +
											(isSelected ? ' timing-hub-load-calendar__dayBtn--selected' : '')
										}
										style={{ background: p.getLoadColor(load) }}
									>
										<div className='timing-hub-load-calendar__dayHead'>
											<span className='timing-hub-load-calendar__dayDate'>{d.dateLabel}</span>
											{p.dayOverrides[d.dateKey] ? (
												<Tag color='blue' style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: 1.2, padding: '0 5px' }}>
													правка
												</Tag>
											) : null}
										</div>
										<div className='timing-hub-load-calendar__dayMsgs' style={{ fontVariantNumeric: 'tabular-nums' }}>
											{formatMsgCount(d.jobsMax)}
											<span className='timing-hub-load-calendar__dayMsgsLabel'> сообщ.</span>
										</div>
										<Progress
											className='timing-hub-load-calendar__miniProgress'
											percent={load > 100 ? 100 : Math.min(100, Math.round(load))}
											status={load > 100 ? 'exception' : load > 85 ? 'active' : 'success'}
											showInfo={false}
											strokeWidth={4}
										/>
										<div className='timing-hub-load-calendar__dayMeta'>
											<span
												className={
													'timing-hub-load-calendar__pill ' +
													(status === 'risk'
														? 'timing-hub-load-calendar__pill--risk'
														: status === 'empty'
															? 'timing-hub-load-calendar__pill--empty'
															: 'timing-hub-load-calendar__pill--ok')
												}
											>
												{status === 'risk' ? 'Риск' : status === 'empty' ? 'Пусто' : 'Ок'}
											</span>
											<span className='timing-hub-load-calendar__dayPct'>{Math.round(load)}%</span>
										</div>
										<div className='timing-hub-load-calendar__dayFoot'>
											{d.wavesMax} волн · {d.firstWindow}
										</div>
									</button>
								)
							})}
						</div>
					))}
				</div>
			</div>

			{p.selectedDay ? (
				(() => {
					const selLoad = p.dayLoadPercent(p.selectedDay)
					const selLoadR = Math.round(selLoad)
					const quick = p.dayNeedsQuickFix(selLoad)
					return (
						<div
							className='timing-hub-load-calendar__detail'
							style={{
								marginTop: 10,
								padding: '12px 14px',
								borderRadius: 12,
								background: 'rgba(255,255,255,0.78)',
								border: '1px solid rgba(0,0,0,0.08)',
							}}
						>
							<div style={{ fontWeight: 800, marginBottom: 8, fontSize: 14 }}>
								{p.selectedDay.label} · {p.selectedDay.dateLabel}
							</div>
							<div style={{ fontSize: 12.5, opacity: 0.8, marginBottom: 10, lineHeight: 1.4 }}>
								Окно {p.waveTimeFrom}–{p.waveTimeTo}: до <b>{formatMsgCount(p.cap.jobsCapacity)}</b> сообщ. вместится по оценке; в плане дня —{' '}
								<b>{formatMsgCount(p.selectedDay.jobsMax)}</b>, волн{' '}
								<b>
									{p.selectedDay.wavesMin === p.selectedDay.wavesMax
										? p.selectedDay.wavesMax
										: `${p.selectedDay.wavesMin}–${p.selectedDay.wavesMax}`}
								</b>
								, загрузка <b>{selLoadR}%</b>.
								{p.selectedDay.jobsMin !== p.selectedDay.jobsMax ? (
									<>
										{' '}
										Диапазон отправок: {formatMsgCount(p.selectedDay.jobsMin)}–{formatMsgCount(p.selectedDay.jobsMax)}.
									</>
								) : null}
							</div>
							{quick ? (
								<div style={{ marginTop: 4 }}>
									<Progress
										percent={selLoad > 100 ? 100 : Math.min(100, selLoadR)}
										status={selLoad > 100 ? 'exception' : 'active'}
										format={() => `${selLoadR}%`}
									/>
								</div>
							) : null}
							<div style={{ marginTop: quick ? 8 : 0, fontSize: 12.5, opacity: 0.88, lineHeight: 1.4 }}>
								{p.riskReasonForDay(p.selectedDay, selLoad)}
							</div>
							{quick ? (
								<div style={{ marginTop: 12 }}>
									<Dropdown
										trigger={['click']}
										menu={{
											items: [
												{
													key: 'shift',
													label: 'Сдвинуть окно (08:00–23:59)',
													onClick: () => p.onApplyDayAction('shiftWindow', p.selectedDay!.dateKey),
												},
												{
													key: 'pauses',
													label: 'Снизить паузы',
													onClick: () => p.onApplyDayAction('reducePauses', p.selectedDay!.dateKey),
												},
												{
													key: 'repeat',
													label: 'Отключить повтор',
													onClick: () => p.onApplyDayAction('disableRepeat', p.selectedDay!.dateKey),
												},
											],
										}}
									>
										<Button type='primary' block size='middle' icon={<DownOutlined />} iconPosition='end'>
											Быстрые действия для дня
										</Button>
									</Dropdown>
								</div>
							) : null}
						</div>
					)
				})()
			) : null}
		</div>
	)
}

export const TimingHubLoadCalendar = memo(TimingHubLoadCalendarInner)
