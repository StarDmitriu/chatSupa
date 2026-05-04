'use client'

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

export type TimingHubTab = 'settings' | 'calc' | 'scheme'

export type TimingHubOpenOptions = {
	/** Открыть «Прогноз», прокрутить к мастеру и отдать фокус области мастера */
	scrollToMaster?: boolean
}

type TimingHubContextValue = {
	open: boolean
	openDrawer: (initialTab?: TimingHubTab, options?: TimingHubOpenOptions) => void
	closeDrawer: () => void
	refresh: () => void
	refreshNonce: number
	requestedTab: TimingHubTab
	/** Сбрасывается обработчиком drawer после применения */
	lastOpenOptions: TimingHubOpenOptions
	clearOpenOptions: () => void
	/** Увеличивается при каждом openDrawer — чтобы эффекты отличали повторное открытие */
	openSequence: number
}

const TimingHubContext = createContext<TimingHubContextValue | null>(null)

export function TimingHubProvider({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = useState(false)
	const [refreshNonce, setRefreshNonce] = useState(0)
	const [requestedTab, setRequestedTab] = useState<TimingHubTab>('settings')
	const [lastOpenOptions, setLastOpenOptions] = useState<TimingHubOpenOptions>({})
	const [openSequence, setOpenSequence] = useState(0)

	/**
	 * Одна панель «Планирование»; `initialTab` только прокручивает к блоку:
	 * `settings` — прогноз и итог, `calc` — окно и паузы, `scheme` — справка «где что менять».
	 */
	const openDrawer = useCallback((initialTab?: TimingHubTab, options?: TimingHubOpenOptions) => {
		setRequestedTab(initialTab ?? 'settings')
		setLastOpenOptions(options ?? {})
		setOpenSequence((n) => n + 1)
		setOpen(true)
	}, [])

	const clearOpenOptions = useCallback(() => setLastOpenOptions({}), [])

	const closeDrawer = useCallback(() => setOpen(false), [])
	const refresh = useCallback(() => setRefreshNonce((n) => n + 1), [])

	const value = useMemo(
		() => ({
			open,
			openDrawer,
			closeDrawer,
			refresh,
			refreshNonce,
			requestedTab,
			lastOpenOptions,
			clearOpenOptions,
			openSequence,
		}),
		[
			open,
			openDrawer,
			closeDrawer,
			refresh,
			refreshNonce,
			requestedTab,
			lastOpenOptions,
			clearOpenOptions,
			openSequence,
		],
	)

	return <TimingHubContext.Provider value={value}>{children}</TimingHubContext.Provider>
}

let timingHubProviderMissingWarned = false

export function useTimingHub() {
	const ctx = useContext(TimingHubContext)
	if (!ctx) {
		if (typeof process !== 'undefined' && process.env.NODE_ENV === 'development' && !timingHubProviderMissingWarned) {
			timingHubProviderMissingWarned = true
			console.warn(
				'[useTimingHub] TimingHubProvider не найден в дереве — открытие панели «Планирование» отключено. Оберните layout в TimingHubProvider.',
			)
		}
		return {
			open: false,
			openDrawer: () => {},
			closeDrawer: () => {},
			refresh: () => {},
			refreshNonce: 0,
			requestedTab: 'settings',
			lastOpenOptions: {},
			clearOpenOptions: () => {},
			openSequence: 0,
		} as TimingHubContextValue
	}
	return ctx
}
