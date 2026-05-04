'use client'

import { useEffect } from 'react'
import { TIMING_HUB_DEFERRED_TOUR_KEY, TIMING_HUB_POST_NAV_KEY } from '@/components/timingHubSession'
import { useTimingHub } from '@/components/TimingHubContext'

export function TimingHubDashboardIntent() {
	const { openDrawer } = useTimingHub()

	useEffect(() => {
		if (typeof window === 'undefined') return
		const v = sessionStorage.getItem(TIMING_HUB_POST_NAV_KEY)
		if (v !== 'planningTour') return
		sessionStorage.removeItem(TIMING_HUB_POST_NAV_KEY)
		sessionStorage.setItem(TIMING_HUB_DEFERRED_TOUR_KEY, '1')
		openDrawer('settings')
	}, [openDrawer])

	return null
}
