/** Парсинг «HH:mm» в минуты от полуночи. */
export function parseHHMMToMinutes(s: string): number {
	const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim())
	if (!m) return 0
	return Number(m[1]) * 60 + Number(m[2])
}

/** Минуты от полуночи → «HH:mm» (суточная нормализация). */
export function formatMinutesToHHMM(totalMinutes: number): string {
	const m = ((Math.floor(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60)
	const hh = Math.floor(m / 60)
	const mm = m % 60
	return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
