'use client'

import { DownOutlined } from '@ant-design/icons'
import { Button, Dropdown, Tag } from 'antd'
import type { RefObject } from 'react'
import { memo } from 'react'

import type { CapacityResult, StartMode } from '@/lib/campaignCapacity'
import { formatEtaGoalLabel, formatMsgCount } from '@/lib/timingHubFormat'
import type { StoredSmartGoal } from '@/lib/timingHubUiStorage'

import type {
	TimingHubPeriodPlan,
	TimingHubPlanningPeriodSummary,
	TimingHubSendTimeWarning,
	TimingHubVolumeBreakdown,
	TimingHubWaveForecast,
	TimingHubWaveForecastCard,
} from '@/lib/timingHubPlanTypes'

export type TimingHubItogTargetsSlice = {
	waTargetsSummary: {
		templatesWithAnyTargetsIntersect: number
		groupsCoveredByAnyTargets: number
		totalSelectedGroups: number
	} | null
	tgTargetsSummary: {
		templatesWithAnyTargetsIntersect: number
		groupsCoveredByAnyTargets: number
		totalSelectedGroups: number
	} | null
}

export type TimingHubItogCardProps = {
	tourItogRef: RefObject<HTMLDivElement | null>
	cap: CapacityResult
	periodPlan: TimingHubPeriodPlan | null
	waveForecast: TimingHubWaveForecast | null
	seriesEndCard: TimingHubWaveForecastCard | null
	planningStatusText: string
	clientVolumeBreakdown: TimingHubVolumeBreakdown | null
	rhythmOneLiner: string
	smartGoal: StoredSmartGoal
	targetEtaMin: number
	smartEnabled: boolean
	etaTargetMismatch: boolean
	planningPeriodSummary: TimingHubPlanningPeriodSummary | null
	startMode: StartMode
	customBufferEnabled: boolean
	customBufferMultiplier: number
	capacityMode: 'optimistic' | 'safe'
	counts: TimingHubItogTargetsSlice
	sendTimeWarning: TimingHubSendTimeWarning | null
	needsPlanningFix: boolean
	onPlanningFixFull: () => void
	onPlanningFixPauses: () => void
}

function TimingHubItogCardInner(p: TimingHubItogCardProps) {
	const mainLoad =
		p.periodPlan && p.periodPlan.dayCards.length > 0
			? Math.max(
					...p.periodPlan.dayCards.map((d) => (p.cap.totalJobs > 0 ? (d.jobsMax / p.cap.totalJobs) * 100 : 0)),
				)
			: 0

	return (
		<div
			ref={p.tourItogRef}
			className='timing-hub-plan__card timing-hub-plan__card--lead camp__planningLead'
			style={{ marginTop: 12 }}
		>
			<div className='camp__planningLeadTitle timing-hub-plan__cardTitle'>Итог по запуску</div>
			<div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
				<div aria-live='polite' aria-atomic='true'>
					{p.periodPlan ? (
						<Tag
							aria-label={p.planningStatusText}
							color={p.cap.totalJobs <= 0 ? 'default' : p.periodPlan.canFitGoal ? 'green' : 'red'}
							style={{ alignSelf: 'flex-start', margin: 0 }}
						>
							<span aria-hidden='true'>
								{p.cap.totalJobs <= 0
									? 'Нет объёма (группы × шаблоны)'
									: p.periodPlan.canFitGoal
										? 'Успеете'
										: 'Риск не успеть'}
							</span>
						</Tag>
					) : p.cap.fit ? (
						<Tag aria-label={p.planningStatusText} color='green' style={{ alignSelf: 'flex-start', margin: 0 }}>
							<span aria-hidden='true'>Успеете</span>
						</Tag>
					) : (
						<Tag aria-label={p.planningStatusText} color='red' style={{ alignSelf: 'flex-start', margin: 0 }}>
							<span aria-hidden='true'>Риск не успеть</span>
						</Tag>
					)}
				</div>

				<div
					style={{
						padding: '10px 12px',
						borderRadius: 10,
						background: 'rgba(255,255,255,0.66)',
						border: '1px solid rgba(0,0,0,0.06)',
					}}
				>
					<div style={{ fontWeight: 800, fontSize: 22, lineHeight: 1.2 }}>{p.cap.etaHuman}</div>
					<div style={{ marginTop: 6, fontSize: 12.5 }}>
						Объём: <b>{formatMsgCount(p.cap.totalJobs)}</b> сообщ. · Пик загрузки дня: <b>{Math.round(mainLoad)}%</b>
					</div>
					<div style={{ marginTop: 6, fontSize: 12.5 }}>
						Цель: <b>{formatEtaGoalLabel(p.targetEtaMin)}</b>
					</div>
				</div>

				{p.needsPlanningFix ? (
					<div className='timing-hub-plan__fixStrip'>
						<div className='timing-hub-plan__fixStripText'>Одно действие</div>
						<Dropdown
							trigger={['click']}
							menu={{
								items: [
									{
										key: 'full',
										label:
											p.smartGoal === 'oneWave'
												? 'Паузы из подсказки + выключить повтор (1 волна за период)'
												: 'Паузы + при необходимости выключить повтор',
										onClick: p.onPlanningFixFull,
									},
									{
										key: 'pauses',
										label:
											p.smartGoal === 'oneWave'
												? 'Только паузы из подсказки + выключить повтор'
												: 'Только подставить паузы из подсказки',
										onClick: p.onPlanningFixPauses,
									},
								],
							}}
						>
							<Button type='primary' block size='middle' icon={<DownOutlined />} iconPosition='end'>
								Подстроить
							</Button>
						</Dropdown>
					</div>
				) : p.etaTargetMismatch ? (
					<div className='timing-hub-plan__okNote timing-hub-plan__okNote--muted'>
						Цель и факт расходятся — при ручных паузах см. «Окно и паузы».
					</div>
				) : (
					<div className='timing-hub-plan__okNote'>Окно по оценке сходится.</div>
				)}
			</div>
		</div>
	)
}

export const TimingHubItogCard = memo(TimingHubItogCardInner)
