//frontend/src/app/dashboard/campaign/page.tsx
'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button, message, Space, Table, Tag, Typography, Divider } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { apiGet, apiPost } from '@/lib/api'
import { errorMeaning } from '@/lib/campaignErrors'
import { estimateCampaignFinishAt, formatCampaignFinishAt } from '@/lib/campaignFinishEstimate'
import { formatDateTimeUtcPlus3 } from '@/lib/dateTime'
import { ChannelIcon } from '@/components/ChannelIcon'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import './page.css'

const { Title } = Typography

type Job = {
	id: string
	group_jid: string
	template_id: string
	status: 'pending' | 'processing' | 'sent' | 'failed' | 'skipped' | 'paused'
	scheduled_at: string
	sent_at: string | null
	error: string | null
}

type ProgressOk = {
	success: true
	campaignId: string
	total: number
	sent: number
	failed: number
	pending: number
	processing: number
	skipped: number
	paused?: number
	done: boolean
	jobs: Job[]
}

type ProgressResponse =
	| ProgressOk
	| { success: false; message: string; details?: any; error?: any }

function pickErrorText(obj: any) {
	if (!obj) return ''
	const details =
		obj.details?.message ??
		obj.details?.hint ??
		(typeof obj.details === 'string' ? obj.details : null)

	const err =
		obj.error?.message ??
		obj.error?.hint ??
		(typeof obj.error === 'string' ? obj.error : null)

	return details || err || ''
}

function normalizeTgChatIdKey(v: unknown): string {
	const s = String(v ?? '').trim()
	if (!s) return ''
	if (s.startsWith('-100')) return s
	if (/^\d+$/.test(s)) return `-100${s}`
	return s
}

function StatusTag({ done }: { done: boolean }) {
	return done ? (
		<Tag color='green'>завершена</Tag>
	) : (
		<Tag color='default'>выполняется</Tag>
	)
}

const STATUS_LABELS: Record<string, { text: string; color?: string }> = {
	sent: { text: 'отправлено', color: 'green' },
	failed: { text: 'отработано', color: 'default' },
	processing: { text: 'отправляется', color: 'blue' },
	skipped: { text: 'пропущено' },
	pending: { text: 'в ожидании', color: 'gold' },
	paused: { text: 'на паузе', color: 'orange' },
}

function pct(part: number, total: number) {
	if (!total || total <= 0) return '0.0'
	return ((part / total) * 100).toFixed(1)
}

function buildSoftConnectivityHint(channel: 'wa' | 'tg', jobs: Job[]): string | null {
	const active = jobs.filter(
		(j) => j.status === 'pending' || j.status === 'processing' || j.status === 'paused'
	)
	if (!active.length) return null
	const hasConnectivitySignals = active.some((j) => {
		const e = String(j.error || '').toLowerCase()
		if (!e) return false
		return (
			e.includes('wa_connect_retry_') ||
			e.includes('tg_connect_retry_') ||
			e.includes('wa_not_connected') ||
			e.includes('telegram_not_connected') ||
			e.includes('send_timeout') ||
			e.includes('tg_flood_wait_')
		)
	})
	if (!hasConnectivitySignals) return null
	return channel === 'tg'
		? 'Восстанавливаем связь с Telegram, доставка продолжится автоматически.'
		: 'Восстанавливаем связь с WhatsApp, доставка продолжится автоматически.'
}

function CampaignInner() {
	const router = useRouter()
	const sp = useSearchParams()
	const loader = useGlobalLoader()

	// Снимаем loader при входе на страницу (если перешли из аналитики/рассылок с loader)
	useEffect(() => {
		loader.hide()
	}, [loader])

	// ✅ новый контракт: ?wa=...&tg=...
	const waId = (sp.get('wa') || '').trim()
	const tgId = (sp.get('tg') || '').trim()

	// ✅ старый контракт поддержим: ?campaignId=...
	const legacyId = (sp.get('campaignId') || '').trim()
	const embed = (sp.get('embed') || '').trim() === '1'

	const effectiveWa = waId || (legacyId ? legacyId : '')
	const effectiveTg = tgId

	const [loading, setLoading] = useState(false)
	const [stoppingWa, setStoppingWa] = useState(false)
	const [stoppingTg, setStoppingTg] = useState(false)
	const [wa, setWa] = useState<ProgressResponse | null>(null)
	const [tg, setTg] = useState<ProgressResponse | null>(null)
	const [groupMapWa, setGroupMapWa] = useState<Record<string, string>>({})
	const [groupMapTg, setGroupMapTg] = useState<Record<string, string>>({})
	const [templateMap, setTemplateMap] = useState<Record<string, string>>({})

	const POLL_MS = 5000
	const timerRef = useRef<number | null>(null)

	const stopPolling = () => {
		if (timerRef.current) {
			window.clearInterval(timerRef.current)
			timerRef.current = null
		}
	}

	const loadOne = async (cid: string) => {
		const json: ProgressResponse = await apiGet(`/campaigns/${cid}/progress`)
		return json
	}

	const load = async () => {
		if (!effectiveWa && !effectiveTg) return
		setLoading(true)
		try {
			if (effectiveWa) setWa(await loadOne(effectiveWa))
			if (effectiveTg) setTg(await loadOne(effectiveTg))
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при загрузке прогресса')
		} finally {
			setLoading(false)
		}
	}

	const loadNames = async () => {
		const me = await apiGet('/auth/me')
		if (!me?.success || !me?.user?.id) return
		const uid = String(me.user.id)

		const [waGroups, tgGroups, templates] = await Promise.all([
			apiGet(`/whatsapp/groups/${uid}`),
			apiGet(`/telegram/groups/${uid}`),
			apiGet(`/templates/list/${uid}`),
		])

		if (waGroups?.success) {
			const map: Record<string, string> = {}
			for (const g of waGroups.groups || []) {
				const id = String(g.wa_group_id || '')
				if (!id) continue
				map[id] = g.subject || id
			}
			setGroupMapWa(map)
		}

		if (tgGroups?.success) {
			const map: Record<string, string> = {}
			for (const g of tgGroups.groups || []) {
				const id = String(g.tg_chat_id || '')
				if (!id) continue
				const title = g.title || id
				map[id] = title
				map[normalizeTgChatIdKey(id)] = title
			}
			setGroupMapTg(map)
		}

		if (templates?.success) {
			const map: Record<string, string> = {}
			for (const t of templates.templates || []) {
				const id = String(t.id || '')
				if (!id) continue
				map[id] = t.title || id
			}
			setTemplateMap(map)
		}
	}

	const startPolling = () => {
		stopPolling()
		timerRef.current = window.setInterval(load, POLL_MS)
	}

	const stopCampaign = async (cid: string, channel: 'wa' | 'tg') => {
		const setStopping = channel === 'wa' ? setStoppingWa : setStoppingTg
		setStopping(true)
		try {
			const json: any = await apiPost(`/campaigns/${cid}/stop`)
			if (!json?.success) {
				const msg = json?.message || 'unknown'
				const text = errorMeaning(msg) || msg
				const extra = pickErrorText(json)
				message.error(
					extra ? `${text} (${extra})` : text,
					6
				)
				return
			}
			message.success('Рассылка остановлена')
			if (channel === 'wa') {
				// Останавливаем поллинг сразу, чтобы до router.replace
				// не перезагружать старые jobs обратно в таблицу.
				stopPolling()
				setWa(null)
			} else {
				stopPolling()
				setTg(null)
			}
			const next = new URLSearchParams(sp.toString())
			if (channel === 'wa') {
				next.delete('wa')
				next.delete('campaignId')
			} else {
				next.delete('tg')
			}
			const qs = next.toString()
			if (qs) {
				router.replace(`/dashboard/campaign?${qs}`)
			} else {
				router.replace('/dashboard/campaigns')
			}
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при остановке. Попробуйте ещё раз.')
		} finally {
			setStopping(false)
		}
	}

	useEffect(() => {
		if (!effectiveWa && !effectiveTg) return
		load()
		loadNames()
		startPolling()
		return () => stopPolling()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [effectiveWa, effectiveTg])

	const buildColumns = (
		groupMap: Record<string, string>,
		channel: 'wa' | 'tg',
		jobs: Job[]
	): ColumnsType<Job> => {
		const hasAnyError = jobs.some(j => !!j.error)
		const cols: ColumnsType<Job> = [
			{
				title: 'Группа',
				dataIndex: 'group_jid',
				key: 'group_jid',
				render: (v: string) =>
					channel === 'tg'
						? groupMap[v] || groupMap[normalizeTgChatIdKey(v)] || v
						: groupMap[v] || v,
			},
			{
				title: 'Шаблон',
				dataIndex: 'template_id',
				key: 'template_id',
				render: (v: string) => templateMap[v] || v,
			},
			{
				title: 'Статус',
				dataIndex: 'status',
				key: 'status',
				render: (v: Job['status']) => {
					const label = STATUS_LABELS[v] ?? { text: String(v), color: 'default' as const }
					const isSent = v === 'sent'
					return (
						<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
							{isSent && <ChannelIcon type={channel} size={18} />}
							<Tag color={label.color}>{label.text}</Tag>
						</span>
					)
				},
			},
			...(hasAnyError
				? [
						{
							title: 'Причина недоставки',
							dataIndex: 'error',
							key: 'error',
							render: (v: string | null, row: Job) =>
								row.error ? (
									<span>{errorMeaning(row.error)}</span>
								) : (
									'—'
								),
						} as const,
					]
				: []),
			{
				title: 'Запланировано',
				dataIndex: 'scheduled_at',
				key: 'scheduled_at',
				render: (v: string) => formatDateTimeUtcPlus3(v),
			},
			{
				title: 'Отправлено',
				dataIndex: 'sent_at',
				key: 'sent_at',
				render: (v: string | null) => formatDateTimeUtcPlus3(v),
			},
		]
		return cols
	}

	const waSummary = useMemo(() => {
		if (!wa || !(wa as any).success) return null
		const d = wa as ProgressOk
		const doneCount = d.sent + d.failed + d.skipped
		const finishAtTs = estimateCampaignFinishAt(d.jobs, d.done)
		const softHint = buildSoftConnectivityHint('wa', d.jobs)
		return (
			<div style={{ marginBottom: 12 }}>
				<div>всего: {d.total}</div>
				<div>отправлено: {d.sent} ({pct(d.sent, d.total)}%)</div>
				<div>отработано: {d.failed} ({pct(d.failed, d.total)}%)</div>
				<div>в ожидании: {d.pending}</div>
				<div>отправляется: {d.processing}</div>
				<div>пропущено: {d.skipped}</div>
				{(d.paused ?? 0) > 0 && <div>на паузе: {d.paused}</div>}
				<div>завершено: {doneCount} ({pct(doneCount, d.total)}%)</div>
				{finishAtTs ? <div>окончание: {formatCampaignFinishAt(finishAtTs)}</div> : null}
				<div style={{ marginTop: 6 }}>
					Статус: <StatusTag done={d.done} />
				</div>
				{softHint ? (
					<div style={{ marginTop: 8, color: '#2f855a' }}>
						{softHint}
					</div>
				) : null}
			</div>
		)
	}, [wa])

	const tgSummary = useMemo(() => {
		if (!tg || !(tg as any).success) return null
		const d = tg as ProgressOk
		const doneCount = d.sent + d.failed + d.skipped
		const finishAtTs = estimateCampaignFinishAt(d.jobs, d.done)
		const softHint = buildSoftConnectivityHint('tg', d.jobs)
		return (
			<div style={{ marginBottom: 12 }}>
				<div>всего: {d.total}</div>
				<div>отправлено: {d.sent} ({pct(d.sent, d.total)}%)</div>
				<div>отработано: {d.failed} ({pct(d.failed, d.total)}%)</div>
				<div>в ожидании: {d.pending}</div>
				<div>отправляется: {d.processing}</div>
				<div>пропущено: {d.skipped}</div>
				{(d.paused ?? 0) > 0 && <div>на паузе: {d.paused}</div>}
				<div>завершено: {doneCount} ({pct(doneCount, d.total)}%)</div>
				{finishAtTs ? <div>окончание: {formatCampaignFinishAt(finishAtTs)}</div> : null}
				<div style={{ marginTop: 6 }}>
					Статус: <StatusTag done={d.done} />
				</div>
				{softHint ? (
					<div style={{ marginTop: 8, color: '#2f855a' }}>
						{softHint}
					</div>
				) : null}
			</div>
		)
	}, [tg])

	// Задачи в таблице: последние по времени сверху (сначала недавно отправленные/запланированные)
	const sortJobsNewestFirst = (jobs: Job[]) =>
		[...jobs].sort((a, b) => {
			const ta = new Date(a.sent_at || a.scheduled_at || 0).getTime()
			const tb = new Date(b.sent_at || b.scheduled_at || 0).getTime()
			return tb - ta
		})
	const waJobsSorted = useMemo(
		() => (wa && (wa as any).success ? sortJobsNewestFirst((wa as ProgressOk).jobs) : []),
		[wa]
	)
	const tgJobsSorted = useMemo(
		() => (tg && (tg as any).success ? sortJobsNewestFirst((tg as ProgressOk).jobs) : []),
		[tg]
	)

	if (!effectiveWa && !effectiveTg) {
		return (
			<div className={`camp${embed ? ' camp--embed' : ''}`}>
				<div className='camp__wrap'>
					<div style={{ color: 'crimson', marginBottom: 16 }}>
						Не переданы параметры в URL. Ожидаю:
						<div style={{ marginTop: 8 }}>
							<code>?wa=...&tg=...</code> или <code>?wa=...</code> /{' '}
							<code>?tg=...</code>
						</div>
					</div>
					<Button type='primary' onClick={() => router.push('/dashboard/campaigns')}>
						Перейти к рассылкам
					</Button>
				</div>
			</div>
		)
	}

	return (
		<div className={`camp${embed ? ' camp--embed' : ''}`}>
			<div className='camp__wrap'>
				<Title level={3} style={{ marginTop: 0 }}>
					Прогресс рассылки
				</Title>
				<p className='camp-progress__lead'>
					Детальный прогресс <strong>одной выбранной</strong> рассылки: по каким группам и шаблонам что отправлено, когда. Строки в таблице — последние по времени сверху. Полный список всех рассылок — в разделе <strong>История</strong>; с этой страницы вы смотрите только одну рассылку (WA и/или TG).
				</p>

				{/* WA */}
				{effectiveWa ? (
					<div className='camp-progress__channel' style={{ marginBottom: 24 }}>
						<Title level={4} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
							<ChannelIcon type='wa' size={24} /> WhatsApp
						</Title>
						<div style={{ marginBottom: 8 }}>
							campaignId: <code>{effectiveWa}</code>
						</div>

						<Space wrap style={{ marginBottom: 12 }}>
							<Button
								danger
								loading={stoppingWa}
								disabled={stoppingWa}
								onClick={() => stopCampaign(effectiveWa, 'wa')}
							>
								<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
									<ChannelIcon type='wa' size={16} /> Остановить WA
								</span>
							</Button>
						</Space>

						{wa && !(wa as any).success ? (
							<div style={{ color: 'crimson', marginBottom: 12 }}>
								Ошибка: {(wa as any).message || 'unknown'}
								{pickErrorText(wa) ? ` — ${pickErrorText(wa)}` : ''}
							</div>
						) : null}

						{waSummary}

						<Table
							rowKey='id'
							columns={buildColumns(groupMapWa, 'wa', waJobsSorted)}
							dataSource={waJobsSorted}
							loading={loading}
							pagination={{ pageSize: 10 }}
						/>
					</div>
				) : null}

				{effectiveWa && effectiveTg ? <Divider /> : null}

				{/* TG */}
				{effectiveTg ? (
					<div className='camp-progress__channel'>
						{/* Если показываем обе канала сразу, заголовок TG не дублируем (сетка становится компактнее) */}
						{!effectiveWa ? (
							<>
								<Title level={4} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
									<ChannelIcon type='tg' size={24} /> Telegram
								</Title>
								<div style={{ marginBottom: 8 }}>
									campaignId: <code>{effectiveTg}</code>
								</div>
							</>
						) : null}

						<Space wrap style={{ marginBottom: 12 }}>
							<Button
								danger
								loading={stoppingTg}
								disabled={stoppingTg}
								onClick={() => stopCampaign(effectiveTg, 'tg')}
							>
								<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
									<ChannelIcon type='tg' size={16} /> Остановить TG
								</span>
							</Button>
						</Space>

						{tg && !(tg as any).success ? (
							<div style={{ color: 'crimson', marginBottom: 12 }}>
								Ошибка: {(tg as any).message || 'unknown'}
								{pickErrorText(tg) ? ` — ${pickErrorText(tg)}` : ''}
							</div>
						) : null}

						{tgSummary}

						<Table
							rowKey='id'
							columns={buildColumns(groupMapTg, 'tg', tgJobsSorted)}
							dataSource={tgJobsSorted}
							loading={loading}
							pagination={{ pageSize: 10 }}
						/>
					</div>
				) : null}
			</div>
		</div>
	)
}

export default function CampaignPage() {
	return (
		<Suspense fallback={<div style={{ padding: 24 }}>Загрузка...</div>}>
			<CampaignInner />
		</Suspense>
	)
}
