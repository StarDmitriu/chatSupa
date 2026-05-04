'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button, Tag, message } from 'antd'
import { useRouter } from 'next/navigation'
import { apiGet } from '@/lib/api'
import { formatDateTimeUtcPlus3 } from '@/lib/dateTime'
import { ChannelIcon } from '@/components/ChannelIcon'
import { CHANNEL_LABELS } from '@/constants/channels'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import './page.css'

type CampaignListItem = {
	id: string
	status: string
	channel: string
	created_at: string
}

type StatusKey = 'running' | 'finished' | 'failed' | 'other'

export default function AnalyticsPage() {
	const router = useRouter()
	const loader = useGlobalLoader()

	const [loading, setLoading] = useState(false)
	const [rows, setRows] = useState<CampaignListItem[]>([])

	const load = async () => {
		setLoading(true)
		try {
			const json: any = await apiGet('/campaigns/list')
			if (json?.success && Array.isArray(json.campaigns)) {
				// Последние рассылки первыми; пустые даты в конец; при равенстве — по id для стабильного порядка
				const sorted = [...json.campaigns].sort((a: CampaignListItem, b: CampaignListItem) => {
					const da = a.created_at ? new Date(a.created_at).getTime() : 0
					const db = b.created_at ? new Date(b.created_at).getTime() : 0
					if (db !== da) return db - da
					return (b.id || '').localeCompare(a.id || '')
				})
				setRows(sorted)
			} else {
				setRows([])
			}
		} catch (e) {
			console.error(e)
			message.error('Не удалось загрузить список рассылок для аналитики')
		} finally {
			setLoading(false)
		}
	}

	useEffect(() => {
		loader.hide()
		load()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const summary = useMemo(() => {
		const total = rows.length
		const byChannel = {
			wa: rows.filter(r => r.channel === 'wa').length,
			tg: rows.filter(r => r.channel === 'tg').length,
		}

		const normStatus = (s: string): StatusKey => {
			if (s === 'running') return 'running'
			if (s === 'finished' || s === 'done' || s === 'completed') return 'finished'
			if (s === 'failed' || s === 'error') return 'failed'
			return 'other'
		}

		const byStatus: Record<StatusKey, number> = {
			running: 0,
			finished: 0,
			failed: 0,
			other: 0,
		}
		for (const r of rows) {
			byStatus[normStatus(r.status)]++
		}

		return { total, byChannel, byStatus }
	}, [rows])

	// Уже отсортировано при загрузке (новые первыми); для рендера используем как есть
	const sortedRows = rows

	return (
		<div className='analytics'>
			<div className='analytics__wrap'>
				<div style={{ marginBottom: 12 }}>
					<button type='button' className='tpl-header__pill ui-action-btn ui-header-btn' onClick={() => load()} disabled={loading}>
						{loading ? 'Обновляем…' : 'Обновить данные'}
					</button>
				</div>
				<p className='analytics__lead'>
					Здесь — <strong>полная история</strong> и сводки: сколько рассылок, по каналам, по статусам, таблица всех рассылок (последние сверху). На странице <strong>Рассылки</strong> — только запуск и текущие запущенные; здесь — весь список. Детальный прогресс по одной рассылке (по группам и шаблонам) — кнопка «Прогресс» в таблице ниже.
				</p>

				<section className='analytics__card'>
					<div className='analytics__cardTitle'>Сводка по кампаниям</div>
					<div className='analytics__grid'>
						<div className='analytics__metric'>
							<div className='analytics__metricLabel'>Всего рассылок</div>
							<div className='analytics__metricValue'>{summary.total}</div>
						</div>
						<div className='analytics__metric'>
							<div className='analytics__metricLabel'>{CHANNEL_LABELS.wa}</div>
							<div className='analytics__metricValue'>{summary.byChannel.wa}</div>
						</div>
						<div className='analytics__metric'>
							<div className='analytics__metricLabel'>{CHANNEL_LABELS.tg}</div>
							<div className='analytics__metricValue'>{summary.byChannel.tg}</div>
						</div>
					</div>
				</section>

				<section className='analytics__card'>
					<div className='analytics__cardTitle'>По статусам</div>
					<div className='analytics__grid analytics__grid--status'>
						<div className='analytics__statusItem'>
							<Tag color='blue'>В процессе</Tag>
							<span className='analytics__statusCount'>
								{summary.byStatus.running}
							</span>
						</div>
						<div className='analytics__statusItem'>
							<Tag color='green'>Завершены</Tag>
							<span className='analytics__statusCount'>
								{summary.byStatus.finished}
							</span>
						</div>
						<div className='analytics__statusItem'>
							<Tag color='red'>С ошибками</Tag>
							<span className='analytics__statusCount'>
								{summary.byStatus.failed}
							</span>
						</div>
						<div className='analytics__statusItem'>
							<Tag>Другие</Tag>
							<span className='analytics__statusCount'>
								{summary.byStatus.other}
							</span>
						</div>
					</div>
					<div className='analytics__hint'>
						Статусы берём из текущих записей кампаний. Позже сюда можно добавить детализацию по доставленным/ошибочным сообщениям.
					</div>
				</section>

				<section className='analytics__card'>
					<div className='analytics__cardTitle'>Полная сводка по рассылкам (последние сверху)</div>
					<p className='analytics__cardDesc'>
						Список рассылок от новых к старым. Кнопка «Прогресс» открывает детальный прогресс выбранной рассылки: по каким группам, что отправлено, когда.
					</p>
					<div className='analytics__tableWrap'>
						<table>
							<thead>
								<tr>
									<th>Канал</th>
									<th>Статус</th>
									<th>Создана</th>
									<th>Действия</th>
								</tr>
							</thead>
							<tbody>
								{sortedRows.map(row => {
									const isFailed = row.status === 'failed' || row.status === 'error'
									return (
									<tr key={row.id}>
										<td>
											<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
												<ChannelIcon
													type={row.channel === 'tg' ? 'tg' : 'wa'}
													size={18}
													variant={isFailed ? 'failed' : 'default'}
												/>
												{row.channel === 'tg' ? CHANNEL_LABELS.tg : CHANNEL_LABELS.wa}
											</span>
										</td>
										<td>
											{row.status === 'running' ? (
												<Tag color='green'>запущена</Tag>
											) : row.status === 'failed' || row.status === 'error' ? (
												<Tag color='red'>ошибка</Tag>
											) : row.status === 'finished' || row.status === 'done' || row.status === 'completed' ? (
												<Tag color='blue'>завершена</Tag>
											) : (
												<Tag>остановлена</Tag>
											)}
										</td>
										<td>
											{formatDateTimeUtcPlus3(row.created_at)}
										</td>
										<td>
											<Button
												size='small'
												type='link'
												onClick={() => {
													loader.show('Открываем прогресс…')
													router.push(`/dashboard/campaign?${row.channel === 'tg' ? 'tg' : 'wa'}=${row.id}`)
												}}
												style={{ padding: 0 }}
											>
												Прогресс
											</Button>
										</td>
									</tr>
								)})}
								{!sortedRows.length && (
									<tr>
										<td colSpan={4} style={{ textAlign: 'center', opacity: 0.7 }}>
											Рассылок пока нет
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</section>
			</div>
		</div>
	)
}

