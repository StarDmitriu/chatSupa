'use client'

import './AppBurgerButton.css'

export function AppBurgerButton(props: {
	open: boolean
	onClick: () => void
	className?: string
	ariaLabelOpen?: string
	ariaLabelClose?: string
}) {
	const {
		open,
		onClick,
		className = '',
		ariaLabelOpen = 'Открыть меню',
		ariaLabelClose = 'Закрыть меню',
	} = props

	return (
		<button
			type="button"
			className={`app-burger ${open ? 'is-open' : ''} ${className}`.trim()}
			aria-label={open ? ariaLabelClose : ariaLabelOpen}
			aria-expanded={open}
			onClick={onClick}
		>
			<span className="app-burger__line" />
			<span className="app-burger__line" />
			<span className="app-burger__line" />
		</button>
	)
}

