'use client'

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'
import { SERVER_BETWEEN_GROUPS_SEC } from '@/lib/campaignBetweenGroupsServerBase'

/**
 * Паузы на запуске берутся из шаблонов; для подсказок в UI оставляем серверную базу как ориентир.
 */
export function useLaunchBetweenGroupsSec() {
	const initialWa = SERVER_BETWEEN_GROUPS_SEC.wa as [number, number]
	const initialTg = SERVER_BETWEEN_GROUPS_SEC.tg as [number, number]

	const [waBetween, setWaBetween] = useState<[number, number]>(initialWa)
	const [tgBetween, setTgBetween] = useState<[number, number]>(initialTg)

	const sync = useCallback(() => {
		setWaBetween(initialWa)
		setTgBetween(initialTg)
	}, [initialWa, initialTg])

	useLayoutEffect(() => {
		sync()
	}, [sync])

	useEffect(() => {
		window.addEventListener(TIMING_HUB_CHANGED_EVENT, sync)
		window.addEventListener('storage', sync)
		return () => {
			window.removeEventListener(TIMING_HUB_CHANGED_EVENT, sync)
			window.removeEventListener('storage', sync)
		}
	}, [sync])

	return { waBetween, tgBetween }
}
