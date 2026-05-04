'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Spin, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import Cookies from 'js-cookie'
import { apiGet } from '@/lib/api'
import { ChannelIcon } from '@/components/ChannelIcon'
import { SEND_INTERVAL_OPTIONS } from '@/constants/sendIntervals'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { readLocalWaveSettings, waveSettingsToTimingPageShape } from '@/lib/campaignWaveLocal'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'
import { WaveSettingsReadonlyCard } from '@/components/campaign/WaveSettingsReadonlyCard'
import '../page.css'
import './page.css'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

function labelSendTime(raw: string | null | undefined): string {
	if (!raw?.trim()) return 'Без правила (в пределах базовой паузы режима «Запуск»)'
	const s = raw.trim()
	// Для TG "интервалов" UI хранит HH:mm как длительность.
	// backend тоже трактует HH:mm как interval (minutes), а не как фиксированное время суток.
	if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
		const [hh, mm] = s.split(':').map((x) => Number(x))
		const totalMin = hh * 60 + mm
		if (totalMin < 60) return `Интервал ${totalMin} мин`
		return mm ? `Интервал ${hh}ч ${mm}м` : `Интервал ${hh}ч`
	}
	const opt = SEND_INTERVAL_OPTIONS.find((o) => o.value === s)
	return opt ? opt.label : s
}

type WaRow = {
	wa_group_id: string
	subject: string | null
	wa_phone?: string | null
}

type TgRow = {
	tg_chat_id: string
	title: string | null
	send_time?: string | null
	tg_phone?: string | null
}

type Job = {
	id: string
	status: 'pending' | 'processing' | 'sent' | 'failed' | 'skipped' | 'paused'
	scheduled_at: string
	sent_at: string | null
}

type ProgressOk = {
	success: true
	campaignId: string
	done: boolean
	jobs: Job[]
}

type ActiveAllResp =
	| { success: true; wa: null | { campaignId: string }; tg: null | { campaignId: string } }
	| { success: false; message: string; error?: unknown }

function formatFinishAt(isoMs: number) {
	const d = new Date(isoMs)
	if (Number.isNaN(d.getTime())) return '—'
	const now = new Date()
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate()
	if (sameDay) {
		return `сегодня ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
	}
	return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function estimateChannelFinishAt(jobs: Job[] | null | undefined, done: boolean) {
	if (!jobs || jobs.length === 0) return null
	if (done) {
		const ts = jobs
			.map((j) => (j.sent_at ? new Date(j.sent_at).getTime() : null))
			.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
		if (!ts.length) return null
		return Math.max(...ts)
	}
	const ts = jobs
		.filter((j) => j.status === 'pending' || j.status === 'processing')
		.map((j) => new Date(j.scheduled_at).getTime())
		.filter((x) => Number.isFinite(x))
	if (!ts.length) return null
	return Math.max(...ts)
}

async function fetchSelectedGroupsPaged(
	channel: 'wa' | 'tg',
	userId: string,
	token: string,
): Promise<any[]> {
	const base =
		channel === 'wa'
			? `${BACKEND_URL}/whatsapp/groups/${userId}`
			: `${BACKEND_URL}/telegram/groups/${userId}`
	const all: any[] = []
	let offset = 0
	const limit = 200
	while (true) {
		const params = new URLSearchParams({
			selectedOnly: 'true',
			limit: String(limit),
			offset: String(offset),
		})
		const res = await fetch(`${base}?${params}`, {
			cache: 'no-store',
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		})
		const data = await res.json().catch(() => ({}))
		if (!res.ok || !data.success) {
			if (all.length === 0) {
				throw new Error(String(data?.message || res.statusText || 'Ошибка загрузки групп'))
			}
			break
		}
		const chunk: any[] = Array.isArray(data.groups) ? data.groups : []
		all.push(...chunk)
		if (chunk.length < limit) break
		if (data.hasMore === false) break
		offset += limit
		if (offset > 50_000) break
	}
	return all
}

export default function CampaignTimingSummaryPage() {
	const loader = useGlobalLoader()
	const [loading, setLoading] = useState(true)
	const [waRows, setWaRows] = useState<WaRow[]>([])
	const [tgRows, setTgRows] = useState<TgRow[]>([])
	const [localWave, setLocalWave] = useState(() =>
		typeof window !== 'undefined'
			? waveSettingsToTimingPageShape(readLocalWaveSettings())
			: {
					timeFrom: '00:00',
					timeTo: '23:59',
					repeatEnabled: true,
				},
	)
	const [waFinishAt, setWaFinishAt] = useState<number | null>(null)
	const [tgFinishAt, setTgFinishAt] = useState<number | null>(null)

	const reload = useCallback(async () => {
		const token = Cookies.get('token') || ''
		if (!token) {
			message.error('Нужна авторизация')
			setLoading(false)
			return
		}
		setLoading(true)
		try {
			const me: any = await apiGet('/auth/me')
			if (!me?.success || !me?.user?.id) {
				message.error(me?.message || 'Не удалось получить профиль')
				setLoading(false)
				return
			}
			const uid = String(me.user.id)

			if (typeof window !== 'undefined') {
				setLocalWave(waveSettingsToTimingPageShape(readLocalWaveSettings()))
			}

			const [wa, tg] = await Promise.all([
				fetchSelectedGroupsPaged('wa', uid, token).catch((e) => {
					console.warn(e)
					return [] as WaRow[]
				}),
				fetchSelectedGroupsPaged('tg', uid, token).catch((e) => {
					console.warn(e)
					return [] as TgRow[]
				}),
			])

			setWaRows(wa as WaRow[])
			setTgRows(tg as TgRow[])
		} catch (e: any) {
			console.error(e)
			message.error(e?.message || 'Ошибка загрузки сводки')
		} finally {
			setLoading(false)
		}
	}, [])

	// Оценка "во сколько закончится" по активным рассылкам (WA/TG), если они запущены.
	useEffect(() => {
		let cancelled = false
		let timer: number | null = null

		const loadFinish = async () => {
			try {
				const active = (await apiGet('/campaigns/active')) as ActiveAllResp
				if (!active?.success) return
				const waId = String(active.wa?.campaignId || '').trim()
				const tgId = String(active.tg?.campaignId || '').trim()

				const [waProg, tgProg] = await Promise.all([
					waId ? (apiGet(`/campaigns/${waId}/progress`) as Promise<any>) : Promise.resolve(null),
					tgId ? (apiGet(`/campaigns/${tgId}/progress`) as Promise<any>) : Promise.resolve(null),
				])

				if (cancelled) return

				if (waProg?.success) {
					const p = waProg as ProgressOk
					setWaFinishAt(estimateChannelFinishAt(p.jobs, !!p.done))
				} else {
					setWaFinishAt(null)
				}
				if (tgProg?.success) {
					const p = tgProg as ProgressOk
					setTgFinishAt(estimateChannelFinishAt(p.jobs, !!p.done))
				} else {
					setTgFinishAt(null)
				}
			} catch {
				// ignore
			}
		}

		void loadFinish()
		timer = window.setInterval(loadFinish, 5000)
		return () => {
			cancelled = true
			if (timer) window.clearInterval(timer)
		}
	}, [])

	useEffect(() => {
		loader.hide()
		void reload()
	}, [loader, reload])

	/* Те же параметры режима «Запуск», что на «Рассылках» / в панели планирования — обновляем без перезагрузки страницы */
	useEffect(() => {
		const sync = () => {
			if (typeof window === 'undefined') return
			setLocalWave(waveSettingsToTimingPageShape(readLocalWaveSettings()))
		}
		window.addEventListener(TIMING_HUB_CHANGED_EVENT, sync)
		window.addEventListener('storage', sync)
		return () => {
			window.removeEventListener(TIMING_HUB_CHANGED_EVENT, sync)
			window.removeEventListener('storage', sync)
		}
	}, [])

	const waColumns: ColumnsType<WaRow> = useMemo(
		() => [
			{
				title: 'Группа WA',
				dataIndex: 'subject',
				key: 'subject',
				render: (s: string | null) => s || '—',
			},
			{
				title: 'Телефон',
				dataIndex: 'wa_phone',
				key: 'wa_phone',
				width: 130,
				render: (p: string | null | undefined) => p || '—',
			},
			{
				title: 'Ритм отправки',
				key: 'wa_rhythm',
				width: 260,
				render: () => (
					<>
						<Tag color='geekblue'>шаблоны</Tag>{' '}
						<span>пауза из карточки шаблона</span>
					</>
				),
			},
			{
				title: 'ID',
				dataIndex: 'wa_group_id',
				key: 'wa_group_id',
				ellipsis: true,
				render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code>,
			},
		],
		[],
	)

	const tgColumns: ColumnsType<TgRow> = useMemo(
		() => [
			{
				title: 'Группа TG',
				dataIndex: 'title',
				key: 'title',
				render: (s: string | null) => s || '—',
			},
			{
				title: 'Интервал / правило',
				key: 'send_time',
				width: 220,
				render: (_, r) => {
					const raw = r.send_time
					const isAuto = !raw?.trim()
					const isHHMM = !!raw && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.trim())
					const label = labelSendTime(raw)

					return (
						<>
							<Tag color={isAuto ? 'default' : isHHMM ? 'cyan' : 'blue'}>
								{isAuto ? 'Авто' : isHHMM ? 'HH:mm' : 'Интервал'}
							</Tag>{' '}
							<span>{label}</span>
						</>
					)
				},
			},
			{
				title: 'ID',
				dataIndex: 'tg_chat_id',
				key: 'tg_chat_id',
				ellipsis: true,
				render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code>,
			},
		],
		[],
	)

	const tgNoRule = tgRows.filter((r) => !String(r.send_time || '').trim()).length

	return (
		<div className="camp">
			<div className="camp__wrap">
				<div className="campTiming__topNav" style={{ marginBottom: 12 }}>
					{/* Кнопки "назад/обновить" убрали: страница сама обновляется при входе. */}
				</div>
				<div className="camp__one">
					<p className="camp__intro" style={{ marginBottom: 20 }}>
						<b>Обзор:</b> TG — интервалы по группам с сервера; WA — список групп. Паузы между отправками в волне — только в{' '}
						<Link href="/dashboard/templates">шаблонах</Link>. Окно суток и повтор — на{' '}
						<Link href="/dashboard/campaigns">Рассылках</Link>.
						<br />
						Блок «Режим „Запуск“» ниже — из localStorage этого браузера.
					</p>

					{loading ? (
						<div style={{ textAlign: 'center', padding: 40 }}>
							<Spin size="large" />
						</div>
					) : (
						<>
							{waFinishAt || tgFinishAt ? (
								<section className="campTiming__section">
									<h2 className="campTiming__sectionTitle">Окончание активной рассылки</h2>
									<p className="campTiming__muted" style={{ marginBottom: 0 }}>
										{waFinishAt ? (
											<>
												<ChannelIcon type="wa" size={14} /> WA: <b>{formatFinishAt(waFinishAt)}</b>{' '}
											</>
										) : null}
										{waFinishAt && tgFinishAt ? <span style={{ opacity: 0.7 }}>· </span> : null}
										{tgFinishAt ? (
											<>
												<ChannelIcon type="tg" size={14} /> TG: <b>{formatFinishAt(tgFinishAt)}</b>
											</>
										) : null}
									</p>
								</section>
							) : null}

							<section className="campTiming__section">
								<h2 className="campTiming__sectionTitle">Режим «Запуск» (в браузере)</h2>
								<WaveSettingsReadonlyCard wave={localWave} />
							</section>

							<section className="campTiming__section">
								<h2 className="campTiming__sectionTitle">
									<ChannelIcon type="wa" size={18} /> WhatsApp — выбранные группы ({waRows.length})
								</h2>
								{waRows.length === 0 ? (
									<p className="campTiming__muted">Нет выбранных групп или сессия не подключена.</p>
								) : (
									<>
										<p className="campTiming__muted" style={{ marginBottom: 8 }}>
											Паузы между отправками — в шаблонах. <Link href="/dashboard/groups">Группы WA</Link>.
										</p>
										<Table
											size="small"
											pagination={{ pageSize: 15, showSizeChanger: true }}
											rowKey={(r) => r.wa_group_id}
											columns={waColumns}
											dataSource={waRows}
										/>
									</>
								)}
							</section>

							<section className="campTiming__section">
								<h2 className="campTiming__sectionTitle">
									<ChannelIcon type="tg" size={18} /> Telegram — выбранные группы ({tgRows.length})
								</h2>
								{tgRows.length === 0 ? (
									<p className="campTiming__muted">Нет выбранных групп или сессия не подключена.</p>
								) : (
									<>
										<p className="campTiming__muted" style={{ marginBottom: 8 }}>
											Без интервала: <b>{tgNoRule}</b> из {tgRows.length}. Редактировать:{' '}
											<Link href="/dashboard/groups/telegram">Группы TG</Link>.
										</p>
										<Table
											size="small"
											pagination={{ pageSize: 15, showSizeChanger: true }}
											rowKey={(r) => r.tg_chat_id}
											columns={tgColumns}
											dataSource={tgRows}
										/>
									</>
								)}
							</section>
						</>
					)}
				</div>
			</div>
		</div>
	)
}
