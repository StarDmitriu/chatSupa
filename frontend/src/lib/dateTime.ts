const MOSCOW_TZ = 'Europe/Moscow'

export function formatDateTimeUtcPlus3(
	value: string | number | Date | null | undefined,
	opts?: Intl.DateTimeFormatOptions,
): string {
	if (!value) return '—'
	const d = new Date(value)
	if (Number.isNaN(d.getTime())) return '—'
	return d.toLocaleString('ru-RU', {
		timeZone: MOSCOW_TZ,
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		...opts,
	})
}

export function formatTimeUtcPlus3(
	value: string | number | Date | null | undefined,
	opts?: Intl.DateTimeFormatOptions,
): string {
	if (!value) return '—'
	const d = new Date(value)
	if (Number.isNaN(d.getTime())) return '—'
	return d.toLocaleTimeString('ru-RU', {
		timeZone: MOSCOW_TZ,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		...opts,
	})
}
