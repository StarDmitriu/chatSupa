/** Число сообщений для подписей в календаре (пробелы как разделитель тысяч). */
export function formatMsgCount(n: number): string {
	if (!Number.isFinite(n)) return '—'
	return Math.max(0, Math.round(n)).toLocaleString('ru-RU')
}

export function formatSecRange(v: [number, number]): string {
	return `${v[0]}–${v[1]} сек`
}

export function formatMinRange(v: [number, number]): string {
	return `${v[0]}–${v[1]} мин`
}

/** Цель «длительность волны» для подписей: минуты или часы. */
export function formatEtaGoalLabel(min: number): string {
	if (!Number.isFinite(min)) return '—'
	const m = Math.max(0, Math.round(min))
	if (m < 60) return `${m} мин`
	const h = Math.floor(m / 60)
	const rem = m % 60
	return rem > 0 ? `${h} ч ${rem} мин` : `${h} ч`
}

export function formatDurationSec(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return '—'
	const s = Math.round(sec)
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	if (h > 0) return `${h} ч ${m} мин`
	if (m > 0) return `${m} мин`
	return `${s} с`
}

export function ruDayCountLabel(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '—'
	const k = n % 10
	const k100 = n % 100
	if (k100 >= 11 && k100 <= 14) return `${n} дней`
	if (k === 1) return `${n} день`
	if (k >= 2 && k <= 4) return `${n} дня`
	return `${n} дней`
}
