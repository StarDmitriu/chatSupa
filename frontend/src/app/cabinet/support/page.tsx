// frontend/src/app/cabinet/support/page.tsx
'use client'
import './page.css'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { SUPPORT_TELEGRAM_URL } from '@/lib/supportContacts'

export default function SupportPage() {
	const router = useRouter()

	return (
		<div className='support'>
			<div className='support-card'>
				<h1 className='support-title'>Поддержка</h1>
				<p className='support-text'>Напишите нам в Telegram — ответим по сервису и рассылкам.</p>

				<a
					href={SUPPORT_TELEGRAM_URL}
					target='_blank'
					rel='noopener noreferrer'
					className='support-tg-btn'
				>
					Открыть чат в Telegram
				</a>

				<div className='support-actions'>
					<button type='button' onClick={() => router.back()}>
						Назад
					</button>
					<Link href='/cabinet' className='support-back-cabinet'>
						В личный кабинет
					</Link>
				</div>
			</div>
		</div>
	)
}
