'use client'

import {
	ClockCircleOutlined,
	ReloadOutlined,
	ThunderboltOutlined,
} from '@ant-design/icons'
import { Alert, Button, Divider, Segmented, Slider, Space, Switch, TimePicker } from 'antd'
import dayjs from 'dayjs'
import type { RefObject } from 'react'
import { memo } from 'react'
import Link from 'next/link'

import type { AdvSettings, CapacityMode, CapacityResult } from '@/lib/campaignCapacity'
import { formatDurationSec, formatEtaGoalLabel } from '@/lib/timingHubFormat'

export type TimingHubAdvancedTabProps = {
	tourAdvancedRef: RefObject<HTMLDivElement | null>
	wave: { timeFrom: string; timeTo: string; adv: AdvSettings }
	smartEnabled: boolean
	cap: CapacityResult
	targetEtaMin: number
	waveHorizonSummary: { line: string } | null
	sendWindowDurationLabel: string | null
	capacityMode: CapacityMode
	customBufferEnabled: boolean
	customBufferMultiplier: number
	onCapacitySegmentChange: (v: 'optimistic' | 'safe' | 'custom') => void
	onCustomBufferMultiplierChange: (n: number) => void
	persistWave: (next: { timeFrom: string; timeTo: string; adv: AdvSettings }) => void
	onScrollToPlan: () => void
	onResetToAutoDefaults: () => void
	onSettingsAcknowledged: () => void
}

function TimingHubAdvancedTabInner(p: TimingHubAdvancedTabProps) {
	const { wave } = p
	return (
		<div
			id='timing-hub-section-advanced'
			ref={p.tourAdvancedRef}
			className='timing-hub-plan__card timing-hub-advanced'
			role='region'
			aria-label='Окно суток и повтор'
		>
			<header className='timing-hub-advanced__intro'>
				<div className='timing-hub-advanced__title'>Окно и повтор</div>
				<p className='timing-hub-advanced__lead'>
					Паузы между отправками в волне — в{' '}
					<Link href='/dashboard/templates'>шаблонах</Link>. Здесь: окно суток, запас прогноза и повтор волны.
				</p>
				<Space wrap size={[8, 4]} className='timing-hub-advanced__introActions'>
					<Button type='link' size='small' onClick={p.onScrollToPlan}>
						← К прогнозу
					</Button>
				</Space>
			</header>

			{p.smartEnabled ? (
				<Alert
					type='warning'
					showIcon
					message='Автоподбор активен'
					description={<>На «Прогнозе» подбор касается в основном повтора. Паузы меняются только в шаблонах.</>}
					className='timing-hub-advanced__alert'
				/>
			) : null}

			<Alert
				type='info'
				showIcon
				className='timing-hub-advanced__masterPointer'
				message='Текущая цель волны'
				description={
					<>
						Цель: <strong>{formatEtaGoalLabel(p.targetEtaMin)}</strong>
						{' '}
						· оценка по шаблонам: <strong>{formatDurationSec(p.cap.totalSec)}</strong>
					</>
				}
			/>
			{p.waveHorizonSummary ? <p className='timing-hub-advanced__masterPointerFoot'>{p.waveHorizonSummary.line}</p> : null}

			<Divider className='timing-hub-advanced__divider' />

			<section className='timing-hub-advanced__section' aria-labelledby='timing-hub-adv-buffer'>
				<div className='timing-hub-advanced__sectionHead' id='timing-hub-adv-buffer'>
					<ThunderboltOutlined className='timing-hub-advanced__sectionIcon' aria-hidden />
					<span className='timing-hub-advanced__sectionTitle'>Запас в оценке времени</span>
				</div>
				<p className='timing-hub-advanced__sectionHint'>Только для оценки длительности волны (отправку не меняет).</p>
				<div className='camp__planningMode timing-hub-advanced__modeBlock'>
					<Segmented
						block
						size='small'
						value={(p.customBufferEnabled ? 'custom' : p.capacityMode) as 'optimistic' | 'safe' | 'custom'}
						onChange={(v) => p.onCapacitySegmentChange(v as 'optimistic' | 'safe' | 'custom')}
						options={[
							{ label: 'Побыстрее', value: 'optimistic' },
							{ label: 'С запасом', value: 'safe' },
							{ label: 'Тонкая точность', value: 'custom' },
						]}
					/>
					<div className='camp__planningModeHint'>
						{p.customBufferEnabled ? (
							<>
								Коэффициент запаса <b>{p.customBufferMultiplier.toFixed(2)}</b>.
							</>
						) : p.capacityMode === 'safe' ? (
							<>С запасом: ориентир +~35% к длительности волны.</>
						) : (
							<>Побыстрее: коэффициент 1.00.</>
						)}
					</div>
					{p.customBufferEnabled && (
						<div className='timing-hub-advanced__sliderWrap'>
							<Slider
								range={false}
								min={1}
								max={1.7}
								step={0.05}
								tooltip={{ formatter: (v) => `коэф. ${v}` }}
								value={p.customBufferMultiplier}
								onChange={(v) => p.onCustomBufferMultiplierChange(typeof v === 'number' ? v : Number(v))}
							/>
						</div>
					)}
				</div>
			</section>

			<Divider className='timing-hub-advanced__divider' />

			<section className='timing-hub-advanced__section' aria-labelledby='timing-hub-adv-window'>
				<div className='timing-hub-advanced__sectionHead' id='timing-hub-adv-window'>
					<ClockCircleOutlined className='timing-hub-advanced__sectionIcon' aria-hidden />
					<span className='timing-hub-advanced__sectionTitle'>Суточное окно отправки</span>
				</div>
				<p className='timing-hub-advanced__sectionHint'>
					Интервал, когда разрешены отправки.
					{p.sendWindowDurationLabel ? (
						<>
							{' '}
							Длительность окна: <strong>{p.sendWindowDurationLabel}</strong>.
						</>
					) : null}
				</p>
				<div className='timing-hub-advanced__timeGrid'>
					<div className='timing-hub-advanced__timeCell'>
						<span className='timing-hub-advanced__timeLabel'>Начало</span>
						<TimePicker
							format='HH:mm'
							minuteStep={1}
							allowClear={false}
							value={dayjs(wave.timeFrom, 'HH:mm')}
							onChange={(v) => p.persistWave({ ...wave, timeFrom: v ? v.format('HH:mm') : '00:00' })}
							className='timing-hub-advanced__timePicker'
						/>
					</div>
					<div className='timing-hub-advanced__timeCell'>
						<span className='timing-hub-advanced__timeLabel'>Конец</span>
						<TimePicker
							format='HH:mm'
							minuteStep={1}
							allowClear={false}
							value={dayjs(wave.timeTo, 'HH:mm')}
							onChange={(v) => p.persistWave({ ...wave, timeTo: v ? v.format('HH:mm') : '23:59' })}
							className='timing-hub-advanced__timePicker'
						/>
					</div>
				</div>
			</section>

			<Divider className='timing-hub-advanced__divider' />

			<section className='timing-hub-advanced__section' aria-labelledby='timing-hub-adv-repeat'>
				<div className='timing-hub-advanced__sectionHead' id='timing-hub-adv-repeat'>
					<span className='timing-hub-advanced__sectionTitle'>Повтор волны</span>
				</div>
				<p className='timing-hub-advanced__sectionHint'>
					Если включено — после волны планируется следующий проход через <b>2–3 часа</b>, когда предыдущая волна завершилась.
				</p>
				<div className='timing-hub-advanced__repeatRow'>
					<span>Повторять рассылки каждые 2–3 часа</span>
					<Switch
						disabled={p.smartEnabled}
						checked={wave.adv.repeatEnabled}
						onChange={(checked) => p.persistWave({ ...wave, adv: { ...wave.adv, repeatEnabled: checked } })}
					/>
				</div>
			</section>

			<footer className='timing-hub-advanced__footer'>
				<Space direction='vertical' size={10} style={{ width: '100%' }}>
					<Button type='primary' block size='middle' onClick={p.onSettingsAcknowledged}>
						Готово
					</Button>
					<Button block size='middle' icon={<ReloadOutlined />} onClick={p.onResetToAutoDefaults}>
						Сброс к автоподбору
					</Button>
					<Button block size='middle' type='default' onClick={p.onScrollToPlan}>
						К прогнозу
					</Button>
				</Space>
			</footer>
		</div>
	)
}

export const TimingHubAdvancedTab = memo(TimingHubAdvancedTabInner)
