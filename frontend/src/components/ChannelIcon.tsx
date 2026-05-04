'use client'

import React from 'react'

type Props = {
	type: 'wa' | 'tg'
	size?: number
	className?: string
	/** Для рассылок: failed — зачеркнутый/алерт, иначе обычный */
	variant?: 'default' | 'failed' | 'warning'
}

type IconSvgProps = React.SVGProps<SVGSVGElement>

const WaIcon: React.FC<IconSvgProps> = props => (
	<svg {...props}>
		<circle cx='12' cy='12' r='10' fill='#25D366' />
		<path
			fill='#ffffff'
			d='M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884'
		/>
	</svg>
)

const TgIcon: React.FC<IconSvgProps> = props => (
	<svg {...props}>
		<circle cx='12' cy='12' r='10' fill='#29A9EB' />
		<path
			fill='#ffffff'
			d='M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z'
		/>
	</svg>
)

/** Официальные логотипы Telegram и WhatsApp (узнаваемые бренд-иконки) */
export function ChannelIcon({ type, size = 18, className, variant = 'default' }: Props) {
	const wrap = variant === 'failed'
	const svgProps: IconSvgProps = {
		width: size,
		height: size,
		className: wrap ? undefined : className,
		viewBox: '0 0 24 24' as const,
		'aria-hidden': true,
		style: variant === 'failed' ? { opacity: 0.7 } : undefined,
	}

	if (wrap) {
		return (
			<span className={className} style={{ position: 'relative', display: 'inline-flex' }}>
				{type === 'wa' ? <WaIcon {...svgProps} /> : <TgIcon {...svgProps} />}
				<span
					style={{
						position: 'absolute',
						left: 0,
						top: '50%',
						width: '100%',
						height: 2,
						background: '#c00',
						transform: 'translateY(-50%) rotate(-45deg)',
						borderRadius: 1,
					}}
					aria-hidden
				/>
			</span>
		)
	}
	return type === 'wa' ? <WaIcon {...svgProps} /> : <TgIcon {...svgProps} />
}
