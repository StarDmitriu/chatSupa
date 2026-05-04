/** Склонение для русского: 1 группа, 2 группы, 5 групп */
export function pluralRu(n: number, forms: [string, string, string]): string {
	const abs = Math.abs(n) % 100
	const d = abs % 10
	if (abs > 10 && abs < 20) return forms[2]
	if (d === 1) return forms[0]
	if (d >= 2 && d <= 4) return forms[1]
	return forms[2]
}

export function pluralRuGroups(n: number): string {
	return pluralRu(n, ['группа', 'группы', 'групп'])
}
