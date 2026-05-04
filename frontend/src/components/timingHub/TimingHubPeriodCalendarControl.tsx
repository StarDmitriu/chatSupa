'use client'

import { Slider } from 'antd'

import { ruDayCountLabel } from '@/lib/timingHubFormat'

export type TimingHubPeriodCalendarControlProps = {
	fixedCalendarDays: number
	onFixedCalendarDaysChange: (n: number) => void
}

export function TimingHubPeriodCalendarControl(p: TimingHubPeriodCalendarControlProps) {
	return (
		<div className='timing-hub-plan__field'>
			<div className='timing-hub-plan__fieldLabel timing-hub-plan__fieldLabel--plain'>
				Сетка нагрузки: <b>{ruDayCountLabel(p.fixedCalendarDays)}</b> от сегодня
			</div>
			<div style={{ marginTop: 10, paddingLeft: 4, paddingRight: 4 }}>
				<Slider
					min={1}
					max={30}
					value={p.fixedCalendarDays}
					data-testid='timing-hub-period-days-slider'
					onChange={(v) => {
						if (typeof v === 'number') p.onFixedCalendarDaysChange(v)
					}}
					marks={{
						1: '1',
						3: '3',
						7: '7',
						30: '30',
					}}
					tooltip={{
						formatter: (v) => (v != null ? ruDayCountLabel(v as number) : ''),
					}}
				/>
			</div>
		</div>
	)
}
