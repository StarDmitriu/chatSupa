import type { Metadata } from 'next'
import { Lora, Manrope } from 'next/font/google'

const display = Lora({
	subsets: ['latin', 'cyrillic'],
	variable: '--pres-font-display',
	display: 'swap',
})

const sans = Manrope({
	subsets: ['latin', 'cyrillic'],
	variable: '--pres-font-sans',
	display: 'swap',
})

export const metadata: Metadata = {
	metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_ORIGIN || 'https://chatrassylka.ru'),
	title: 'Презентация для клиентов — ЧатРассылка',
	description:
		'Готовые слайды о сервисе массовых рассылок в WhatsApp и Telegram: возможности, шаги подключения, ответы на вопросы и тексты для сайта.',
	keywords: [
		'чатрассылка',
		'рассылки whatsapp',
		'рассылки telegram',
		'массовые рассылки в чаты',
		'автоматизация рассылок',
	],
	alternates: {
		canonical: '/presentation',
	},
	openGraph: {
		type: 'article',
		locale: 'ru_RU',
		url: '/presentation',
		siteName: 'ЧатРассылка',
		title: 'Презентация для клиентов — ЧатРассылка',
		description:
			'WhatsApp и Telegram для бизнеса: шаблоны, очередь с паузами, повтор по расписанию, шаги запуска и FAQ.',
		images: [
			{
				url: '/presentation/og-cover.png',
				width: 1200,
				height: 630,
				alt: 'ЧатРассылка — презентация для клиентов',
			},
		],
	},
	twitter: {
		card: 'summary_large_image',
		title: 'Презентация для клиентов — ЧатРассылка',
		description:
			'Готовая клиентская презентация сервиса рассылок в WhatsApp и Telegram.',
		images: ['/presentation/og-cover.png'],
	},
	robots: {
		index: true,
		follow: true,
	},
}

export default function PresentationLayout({
	children,
}: {
	children: React.ReactNode
}) {
	return (
		<div className={`${display.variable} ${sans.variable} pres-root`}>
			{children}
		</div>
	)
}
