'use client'

/**
 * Единая панель «Планирование» для всего приложения (дашборд, кабинет и др.).
 * Раньше провайдер висел только на `/dashboard/*` — вне дашборда `useTimingHub` был пустышкой.
 */
export function TimingHubRoot({ children }: { children: React.ReactNode }) {
	return (
		<>
			{children}
		</>
	)
}
