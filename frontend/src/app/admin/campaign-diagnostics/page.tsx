'use client'

import { useEffect, useMemo, useState } from 'react'
import Cookies from 'js-cookie'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { apiGet, ApiError } from '@/lib/api'
import { formatDateTimeUtcPlus3 } from '@/lib/dateTime'

const LS_ADMIN_PW = 'admin_panel_password'

type Row = {
	campaign_id: string
	user_id: string
	user_phone: string | null
	user_name: string | null
	channel: 'wa' | 'tg'
	status: string
	total: number
	sent: number
	failed: number
	pending: number
	processing: number
	skipped: number
	paused: number
	retried: number
	slow: number
	created_at: string | null
	started_at: string | null
	last_attempt_at: string | null
	completed_at: string | null
	overload_level: 'normal' | 'elevated' | 'high' | 'critical'
	overload_hits_5m: number
	overload_factor: number
}

function overloadColor(level: Row['overload_level']) {
	if (level === 'critical') return '#b42318'
	if (level === 'high') return '#b54708'
	if (level === 'elevated') return '#b54708'
	return '#067647'
}

export default function AdminCampaignDiagnosticsPage() {
	const router = useRouter()
	const token = typeof document !== 'undefined' ? (Cookies.get('token') || '') : ''

	const [rows, setRows] = useState<Row[]>([])
	const [loading, setLoading] = useState(true)
	const [err, setErr] = useState<string | null>(null)
	const [limit, setLimit] = useState<number>(40)
	const [qUser, setQUser] = useState('')
	const [channelFilter, setChannelFilter] = useState<'all' | 'wa' | 'tg'>('all')
	const [overloadFilter, setOverloadFilter] = useState<
		'all' | 'normal' | 'elevated' | 'high' | 'critical'
	>('all')
	const [statusFilter, setStatusFilter] = useState<string>('all')
	const [preset, setPreset] = useState<'none' | 'problem' | 'high_critical' | 'running_failed'>('none')
	const [pwInput, setPwInput] = useState('')
	const [adminPw, setAdminPw] = useState<string>(() => {
		if (typeof window === 'undefined') return ''
		return String(window.localStorage.getItem(LS_ADMIN_PW) || '')
	})

	const adminHeaders = useMemo(() => {
		const v = String(adminPw || '').trim()
		return v ? ({ 'X-Admin-Password': v } as Record<string, string>) : {}
	}, [adminPw])

	const load = async () => {
		if (!token) return
		setLoading(true)
		setErr(null)
		try {
			const qs = new URLSearchParams()
			qs.set('limit', String(limit))
			const uid = qUser.trim()
			if (uid) qs.set('userId', uid)
			const json = await apiGet(`/admin/campaigns/diagnostics?${qs.toString()}`, {
				headers: adminHeaders,
			})
			if (!json?.success) throw new Error(String(json?.message || 'Не удалось загрузить'))
			setRows((json.campaigns || []) as Row[])
		} catch (e) {
			const msg = e instanceof ApiError ? e.message : (e as Error)?.message
			if (msg && String(msg).includes('admin_password')) {
				setErr('Неверный пароль админки')
			} else {
				setErr(msg || 'Ошибка сети')
			}
			setRows([])
		} finally {
			setLoading(false)
		}
	}

	const statusOptions = useMemo(() => {
		const set = new Set<string>()
		for (const r of rows) {
			const s = String(r.status || '').trim()
			if (s) set.add(s)
		}
		return Array.from(set).sort((a, b) => a.localeCompare(b))
	}, [rows])

	const filteredRows = useMemo(() => {
		const base = rows.filter((r) => {
			if (channelFilter !== 'all' && r.channel !== channelFilter) return false
			if (overloadFilter !== 'all' && r.overload_level !== overloadFilter) return false
			if (statusFilter !== 'all' && String(r.status || '') !== statusFilter) return false
			return true
		})
		if (preset === 'problem') {
			return base.filter(
				(r) =>
					r.failed > 0 ||
					r.overload_level === 'high' ||
					r.overload_level === 'critical' ||
					r.status === 'paused',
			)
		}
		if (preset === 'high_critical') {
			return base.filter(
				(r) => r.overload_level === 'high' || r.overload_level === 'critical',
			)
		}
		if (preset === 'running_failed') {
			return base.filter((r) => r.status === 'running' && r.failed > 0)
		}
		return base
	}, [rows, channelFilter, overloadFilter, statusFilter, preset])

	const exportCsv = () => {
		const head = [
			'campaign_id',
			'user_id',
			'user_phone',
			'user_name',
			'channel',
			'status',
			'total',
			'sent',
			'failed',
			'pending',
			'processing',
			'skipped',
			'paused',
			'retried',
			'slow',
			'overload_level',
			'overload_hits_5m',
			'overload_factor',
			'created_at',
			'started_at',
			'last_attempt_at',
			'completed_at',
		]
		const esc = (v: unknown) => {
			const s = String(v ?? '')
			return `"${s.replace(/"/g, '""')}"`
		}
		const lines = [head.join(',')]
		for (const r of filteredRows) {
			lines.push(
				[
					r.campaign_id,
					r.user_id,
					r.user_phone ?? '',
					r.user_name ?? '',
					r.channel,
					r.status,
					r.total,
					r.sent,
					r.failed,
					r.pending,
					r.processing,
					r.skipped,
					r.paused,
					r.retried,
					r.slow,
					r.overload_level,
					r.overload_hits_5m,
					r.overload_factor,
					r.created_at ?? '',
					r.started_at ?? '',
					r.last_attempt_at ?? '',
					r.completed_at ?? '',
				]
					.map(esc)
					.join(','),
			)
		}
		const blob = new Blob(['\uFEFF' + lines.join('\n')], {
			type: 'text/csv;charset=utf-8;',
		})
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		const now = new Date()
		const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
			now.getDate(),
		).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(
			now.getMinutes(),
		).padStart(2, '0')}`
		a.download = `campaign_diagnostics_${ts}.csv`
		document.body.appendChild(a)
		a.click()
		a.remove()
		URL.revokeObjectURL(url)
	}

	const applyPreset = (preset: 'problem' | 'high_critical' | 'running_failed') => {
		setPreset(preset)
	}

	const presetRows = useMemo(() => {
		const problem = rows.filter(
			(r) =>
				r.failed > 0 ||
				r.overload_level === 'high' ||
				r.overload_level === 'critical' ||
				r.status === 'paused',
		)
		const highCritical = rows.filter(
			(r) => r.overload_level === 'high' || r.overload_level === 'critical',
		)
		const runningFailed = rows.filter((r) => r.status === 'running' && r.failed > 0)
		return { problem, highCritical, runningFailed }
	}, [rows])

	useEffect(() => {
		if (!token) {
			router.push('/auth/phone')
			return
		}
		load()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token, adminHeaders])

	return (
		<div style={{ maxWidth: 1360, margin: '0 auto', padding: '16px 12px 24px' }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
				<Link href='/admin' style={{ textDecoration: 'none' }}>← Админка</Link>
				<strong>Диагностика кампаний</strong>
			</div>

			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
				<input
					value={pwInput}
					onChange={(e) => setPwInput(e.target.value)}
					placeholder='Пароль админки'
					type='password'
					style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				/>
				<button
					type='button'
					onClick={() => {
						const v = pwInput.trim()
						setAdminPw(v)
						try { window.localStorage.setItem(LS_ADMIN_PW, v) } catch {}
					}}
					style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					Сохранить пароль
				</button>
				<input
					value={qUser}
					onChange={(e) => setQUser(e.target.value)}
					placeholder='Фильтр по user_id'
					style={{ minWidth: 260, padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				/>
				<select
					value={String(limit)}
					onChange={(e) => setLimit(Number(e.target.value))}
					style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					<option value='20'>20</option>
					<option value='40'>40</option>
					<option value='60'>60</option>
					<option value='100'>100</option>
				</select>
				<select
					value={channelFilter}
					onChange={(e) => {
						setPreset('none')
						setChannelFilter(e.target.value as 'all' | 'wa' | 'tg')
					}}
					style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					<option value='all'>Channel: all</option>
					<option value='wa'>WA</option>
					<option value='tg'>TG</option>
				</select>
				<select
					value={overloadFilter}
					onChange={(e) => {
						setPreset('none')
						setOverloadFilter(
							e.target.value as 'all' | 'normal' | 'elevated' | 'high' | 'critical',
						)
					}}
					style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					<option value='all'>Overload: all</option>
					<option value='normal'>normal</option>
					<option value='elevated'>elevated</option>
					<option value='high'>high</option>
					<option value='critical'>critical</option>
				</select>
				<select
					value={statusFilter}
					onChange={(e) => {
						setPreset('none')
						setStatusFilter(e.target.value)
					}}
					style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					<option value='all'>Status: all</option>
					{statusOptions.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>
				<button
					type='button'
					onClick={load}
					disabled={loading}
					style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					{loading ? 'Загрузка…' : 'Обновить'}
				</button>
				<button
					type='button'
					onClick={exportCsv}
					disabled={filteredRows.length === 0}
					style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					Экспорт CSV ({filteredRows.length})
				</button>
			</div>

			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
				<button
					type='button'
					onClick={() => applyPreset('problem')}
					style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					Только проблемные ({presetRows.problem.length})
				</button>
				<button
					type='button'
					onClick={() => applyPreset('high_critical')}
					style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					high+critical ({presetRows.highCritical.length})
				</button>
				<button
					type='button'
					onClick={() => applyPreset('running_failed')}
					style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					running с failed {'>'} 0 ({presetRows.runningFailed.length})
				</button>
				<button
					type='button'
					onClick={() => setPreset('none')}
					style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #d0d5dd' }}
				>
					Сброс пресета
				</button>
			</div>

			{err ? <div style={{ color: '#b42318', marginBottom: 10 }}>{err}</div> : null}

			<div style={{ overflowX: 'auto', border: '1px solid #eaecf0', borderRadius: 12, background: '#fff' }}>
				<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
					<thead>
						<tr style={{ background: '#f9fafb' }}>
							<th style={{ textAlign: 'left', padding: 8 }}>Клиент</th>
							<th style={{ textAlign: 'left', padding: 8 }}>Кампания</th>
							<th style={{ textAlign: 'left', padding: 8 }}>Счётчики</th>
							<th style={{ textAlign: 'left', padding: 8 }}>Перегруз</th>
							<th style={{ textAlign: 'left', padding: 8 }}>Времена (UTC+3)</th>
						</tr>
					</thead>
					<tbody>
						{filteredRows.map((r) => (
							<tr key={r.campaign_id} style={{ borderTop: '1px solid #f2f4f7', verticalAlign: 'top' }}>
								<td style={{ padding: 8 }}>
									<div>{r.user_name || '—'}</div>
									<div style={{ opacity: 0.75 }}>{r.user_phone || '—'}</div>
									<div style={{ opacity: 0.6, fontSize: 12 }}>{r.user_id}</div>
								</td>
								<td style={{ padding: 8 }}>
									<div>{r.channel.toUpperCase()} · {r.status}</div>
									<div style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.campaign_id}</div>
								</td>
								<td style={{ padding: 8, whiteSpace: 'nowrap' }}>
									<div>total: {r.total}</div>
									<div>sent: {r.sent} · failed: {r.failed}</div>
									<div>pending: {r.pending} · proc: {r.processing}</div>
									<div>skipped: {r.skipped} · paused: {r.paused}</div>
									<div>retried: {r.retried} · slow: {r.slow}</div>
								</td>
								<td style={{ padding: 8 }}>
									<div style={{ color: overloadColor(r.overload_level), fontWeight: 700 }}>
										{r.overload_level}
									</div>
									<div>hits 5m: {r.overload_hits_5m}</div>
									<div>factor: {r.overload_factor}</div>
								</td>
								<td style={{ padding: 8 }}>
									<div>created: {formatDateTimeUtcPlus3(r.created_at)}</div>
									<div>started: {formatDateTimeUtcPlus3(r.started_at)}</div>
									<div>last: {formatDateTimeUtcPlus3(r.last_attempt_at)}</div>
									<div>completed: {formatDateTimeUtcPlus3(r.completed_at)}</div>
								</td>
							</tr>
						))}
						{!loading && filteredRows.length === 0 ? (
							<tr>
								<td colSpan={5} style={{ padding: 14, opacity: 0.7 }}>
									Нет данных
								</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</div>
		</div>
	)
}
