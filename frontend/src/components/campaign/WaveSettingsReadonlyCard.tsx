'use client'

import Link from 'next/link'

import type { TimingPageLocalWave } from '@/lib/campaignWaveLocal'

type Props = {
	wave: TimingPageLocalWave
	/** По умолчанию стили страницы сводки (`timing/page.css`) */
	className?: string
}

function repeatLine(w: TimingPageLocalWave): string {
	if (!w.repeatEnabled) return 'выкл.'
	return 'вкл., на следующий календарный день в начале окна'
}

/**
 * Параметры режима «Запуск» из localStorage (тот же источник, что «Рассылки»).
 */
export function WaveSettingsReadonlyCard({ wave, className = 'campTiming__localCard' }: Props) {
	return (
		<div className={className}>
			<div>
				<b>Окно отправки:</b> {wave.timeFrom} — {wave.timeTo}
			</div>
			<div style={{ marginTop: 6 }}>
				<b>Паузы между отправками в волне:</b> только из{' '}
				<Link href='/dashboard/templates'>шаблонов</Link> (карточка шаблона).
			</div>
			<div style={{ marginTop: 6 }}>
				<b>Повтор волны:</b> {repeatLine(wave)}
			</div>
		</div>
	)
}
