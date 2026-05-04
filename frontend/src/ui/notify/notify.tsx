'use client'

import React, {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from 'react'

type NotifyType = 'success' | 'error' | 'warning' | 'info'

type Toast = {
	id: string
	type: NotifyType
	title?: string
	message: string
	timeoutMs: number
}

type NotifyFn = (
	message: string,
	opts?: { type?: NotifyType; title?: string; timeoutMs?: number }
) => void

const NotifyContext = createContext<{ notify: NotifyFn } | null>(null)

function uid() {
	return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function NotifyProvider({ children }: { children: React.ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([])
	const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

	const remove = useCallback((id: string) => {
		const t = timers.current.get(id)
		if (t) clearTimeout(t)
		timers.current.delete(id)
		setToasts(prev => prev.filter(x => x.id !== id))
	}, [])

	const notify: NotifyFn = useCallback(
		(message, opts) => {
			const id = uid()
			const toast: Toast = {
				id,
				type: opts?.type ?? 'info',
				title: opts?.title,
				message,
				timeoutMs: opts?.timeoutMs ?? 3500,
			}

			setToasts(prev => [toast, ...prev].slice(0, 5)) // максимум 5 уведомлений

			const t = setTimeout(() => remove(id), toast.timeoutMs)
			timers.current.set(id, t)
		},
		[remove]
	)

	const value = useMemo(() => ({ notify }), [notify])

	return (
		<NotifyContext.Provider value={value}>
			{children}

			{/* stack */}
			<div className='ntf-stack' role='region' aria-label='Notifications'>
				{toasts.map(t => (
					<div
						key={t.id}
						className='ntf-toast'
						data-type={t.type}
						role='status'
					>
						<div className='ntf-bar' />
						<div>
							{t.title ? <p className='ntf-title'>{t.title}</p> : null}
							<p className='ntf-message'>{t.message}</p>
						</div>
						<button
							className='ntf-close'
							onClick={() => remove(t.id)}
							aria-label='Close'
						>
							✕
						</button>
					</div>
				))}
			</div>
		</NotifyContext.Provider>
	)
}

const noopNotify: NotifyFn = () => {}

export function useNotify() {
	const ctx = useContext(NotifyContext)
	if (!ctx) return noopNotify
	return ctx.notify
}
