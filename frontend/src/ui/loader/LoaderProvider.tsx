'use client'

import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'

type LoaderContextValue = {
	show: (label?: string) => void
	hide: () => void
}

const LoaderContext = createContext<LoaderContextValue | null>(null)

const LONG_LOADING_MS = 6000

type OverlayState = {
	visible: boolean
	label: string | null
	startedAt: number | null
	long: boolean
}

export function LoaderProvider({ children }: { children: React.ReactNode }) {
	const [state, setState] = useState<OverlayState>({
		visible: false,
		label: null,
		startedAt: null,
		long: false,
	})

	// Оверлей не скрываем при смене маршрута — каждая страница сама вызывает hide() по готовности данных

	// флаг "долго думаем"
	useEffect(() => {
		if (!state.visible || state.startedAt == null) return

		const timeout = setTimeout(() => {
			setState(prev => ({
				...prev,
				long: true,
			}))
		}, LONG_LOADING_MS)

		return () => clearTimeout(timeout)
	}, [state.visible, state.startedAt])

	const show = useCallback((label?: string) => {
		setState({
			visible: true,
			label: label || null,
			startedAt: Date.now(),
			long: false,
		})
	}, [])

	const hide = useCallback(() => {
		setState(prev => ({
			...prev,
			visible: false,
			label: null,
			startedAt: null,
			long: false,
		}))
	}, [])

	const value = useMemo(
		() => ({
			show,
			hide,
		}),
		[show, hide]
	)

	return (
		<LoaderContext.Provider value={value}>
			{children}
			{state.visible && (
				<div className='app-loaderOverlay' aria-live='polite'>
					<div className='app-loaderOverlay__backdrop' />
					<div className='app-loaderOverlay__center'>
						<div className='app-loaderBubble'>
							<div className='app-loaderBubble__icon'>
								<div className='brand-logo app-loaderLogo'>
									<span className='brand-logo__chat'>Чат</span>
									<span className='brand-logo__accent'>Рассылка</span>
								</div>
							</div>
							<div className='app-loaderBubble__dots'>
								<span />
								<span />
								<span />
							</div>
						</div>
						<div className='app-loaderOverlay__text'>
							{state.label || 'Загружаем…'}
						</div>
						{state.long && (
							<div className='app-loaderOverlay__text app-loaderOverlay__text--muted'>
								Долго думаем, но ещё работаем…
							</div>
						)}
					</div>
				</div>
			)}
		</LoaderContext.Provider>
	)
}

const noopLoader: LoaderContextValue = { show: () => {}, hide: () => {} }

export function useGlobalLoader() {
	const ctx = useContext(LoaderContext)
	// Не бросать при отсутствии контекста (гидрация, другой устройство, ошибка выше по дереву)
	if (!ctx) return noopLoader
	return ctx
}

