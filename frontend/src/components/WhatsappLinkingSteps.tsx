import React from 'react'

type Step = {
	id: string
	text: string
}

const ArrowDown = ({
	color = '#797979',
}: {
	size?: number
	color?: string
}) => (
	<svg
		width={40}
		height={40}
		viewBox='0 0 20 20'
		fill='none'
		aria-hidden='true'
	>
		<path d='M12 4v14' stroke={color} strokeWidth='1.5' strokeLinecap='round' />
		<path
			d='M7.5 14.5 12 19l4.5-4.5'
			stroke={color}
			strokeWidth='1.5'
			strokeLinecap='round'
			strokeLinejoin='round'
		/>
	</svg>
)

export function WhatsappLinkingSteps() {
	const steps: Step[] = [
		{ id: '1', text: 'Откройте WhatsApp на телефоне' },
		{ id: '2', text: 'Перейдите в «Настройки → Связанные устройства»' },
		{ id: '3', text: 'Нажмите «Связать устройство»' },
		{ id: '4', text: 'Отсканируйте QR-код на экране' },
	]

	return (
		<div style={styles.wrap}>
			<div style={styles.column}>
				{steps.map((s, idx) => (
					<React.Fragment key={s.id}>
						<div style={styles.pill}>
							<span style={styles.pillText}>
								{s.id}. {s.text}
							</span>
						</div>

						{idx !== steps.length - 1 && (
							<div style={styles.arrow}>
								<ArrowDown />
							</div>
						)}
					</React.Fragment>
				))}
			</div>
		</div>
	)
}

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		width: '100%',
		display: 'flex',
		justifyContent: 'center',
	},
	column: {
		width: 'auto',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: 10,
		padding: 16,
	},
	pill: {
		width: 'auto',
		background: '#FFFFFF',
		border: '1px solid #D6D6D6',
		borderRadius: 999,
		padding: '14px 18px',
		textAlign: 'center',
		boxShadow: '0 1px 0 rgba(0,0,0,0.02)',
		margin: '10px'
	},
	pillText: {
		fontSize: 16,
		lineHeight: 1.25,
		color: '#2B2B2B',
		fontWeight: 500,
		whiteSpace: 'normal',
	},
	arrow: {
		height: 26,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	},
}
