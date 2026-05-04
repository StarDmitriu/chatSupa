import { formatDateTimeUtcPlus3, formatTimeUtcPlus3 } from '@/lib/dateTime'

/** Минимальные поля job для оценки времени окончания рассылки */
export type CampaignFinishJob = {
	status: string
	scheduled_at: string
	sent_at?: string | null
}

/**
 * Человекочитаемое время окончания (локальная зона браузера).
 */
export function formatCampaignFinishAt(isoMs: number): string {
	const d = new Date(isoMs)
	if (Number.isNaN(d.getTime())) return '—'
	const now = new Date()
	const mskDay = formatDateTimeUtcPlus3(d, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	})
	const nowMskDay = formatDateTimeUtcPlus3(now, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	})
	const sameDay =
		mskDay !== '—' && nowMskDay !== '—' && mskDay === nowMskDay
	if (sameDay) {
		return `сегодня ${formatTimeUtcPlus3(d, {
			hour: '2-digit',
			minute: '2-digit',
		})}`
	}
	return formatDateTimeUtcPlus3(d, {
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	})
}

/**
 * Фактическое или плановое окончание по данным прогресса:
 * — при завершённой кампании: максимум `sent_at` по отправленным;
 * — иначе: максимум `scheduled_at` среди оставшихся (pending, processing, paused).
 *
 * `scheduled_at` в БД — реальная сетка планировщика; не опираемся на «серверные» константы пауз.
 */
export function estimateCampaignFinishAt(
	jobs: CampaignFinishJob[] | null | undefined,
	done: boolean,
): number | null {
	if (!jobs || jobs.length === 0) return null

	if (done) {
		const ts = jobs
			.map((j) => (j.sent_at ? new Date(j.sent_at).getTime() : null))
			.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
		if (!ts.length) return null
		return Math.max(...ts)
	}

	const remaining = jobs.filter((j) => {
		const s = String(j.status || '')
		return s === 'pending' || s === 'processing' || s === 'paused'
	})

	const ts = remaining
		.map((j) => {
			const t = j.sent_at ? new Date(j.sent_at).getTime() : new Date(j.scheduled_at).getTime()
			return Number.isFinite(t) ? t : null
		})
		.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))

	if (!ts.length) return null
	return Math.max(...ts)
}
