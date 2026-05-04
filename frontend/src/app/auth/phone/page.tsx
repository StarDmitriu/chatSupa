'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import './page.css'
import { useNotify } from '@/ui/notify/notify'

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

export default function LoginPage() {
	const [phone, setPhone] = useState('')
	const [loading, setLoading] = useState(false)
	const [sendError, setSendError] = useState<string | null>(null)
	const router = useRouter()
	const notify = useNotify()

	const back = () => {
		router.push(
			`/`,
		)
	}

	const SEND_CODE_TIMEOUT_MS = 25000

	const sendCode = async () => {
		if (!phone.trim()) {
			notify('Введите номер телефона', { type: 'warning' })
			return
		}

		setSendError(null)
		setLoading(true)
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), SEND_CODE_TIMEOUT_MS)
		try {
			const res = await fetch(`${backendUrl}/auth/send-code`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ phone: phone.trim() }),
				signal: controller.signal,
			})
			clearTimeout(timeoutId)

			const data = await res.json().catch(() => ({}))

			if (!data?.success) {
				const msg = data?.message
				const text =
					msg === 'supabase_timeout'
						? 'База данных не ответила вовремя (таймаут 15 сек). Часто это ошибка 522 до Supabase — попробуйте через несколько минут.'
						: msg === 'supabase_error' || msg === 'service_unavailable' || msg === 'supabase_select_error' || msg === 'supabase_upsert_error'
							? 'Ошибка соединения с базой данных. Код не отправлен — попробуйте позже.'
							: msg === 'too_many_requests'
								? 'Подождите минуту перед повторной отправкой кода.'
								: msg === 'sms_send_failed'
									? 'Не удалось отправить SMS. Попробуйте позже.'
									: msg || 'Ошибка при отправке кода'
				setSendError(text)
				notify(text, { type: 'error', title: 'Ошибка' })
				return
			}

			router.push(
				`/auth/code?phone=${encodeURIComponent(phone.trim())}&mode=login`
			)
		} catch (err: any) {
			clearTimeout(timeoutId)
			console.error(err)
			const errorText =
				err?.name === 'AbortError'
					? 'Сервер не ответил вовремя. Проверьте интернет и попробуйте снова.'
					: 'Ошибка сети, попробуйте ещё раз.'
			setSendError(errorText)
			notify(errorText, { type: 'error', title: 'Ошибка' })
		} finally {
			setLoading(false)
		}
	}

	return (
		<main className='auth'>
			<button
				type='button'
				className='auth-back__button ui-action-btn'
				onClick={back}
			>
				Назад
			</button>

			<div className='auth__wrap'>
				<div className='auth-brand' aria-hidden='true'>
					<div className='auth-brand__logo'>
						<Image
							src='/logo-heart.png'
							width={72}
							height={72}
							alt=''
							className='auth-brand__logo-icon'
						/>
						<span className='auth-brand__logo-chat'>Чат</span>
						<span className='auth-brand__logo-accent'>Рассылка</span>
					</div>
				</div>

				<h1 className='auth__title'>Войдите в свой аккаунт</h1>
				<p className='auth__subtitle'>
					Введите номер телефона,
					<br />
					чтобы продолжить работу с сервисом
				</p>

				<section className='auth-card'>
					<input
						id='phone'
						className='auth-card__input'
						placeholder='Ваш номер телефона'
						value={phone}
						onChange={e => { setPhone(e.target.value); setSendError(null) }}
						inputMode='tel'
						autoComplete='tel'
					/>

					<button
						type='button'
						className='auth-card__button ui-action-btn'
						onClick={sendCode}
						disabled={loading}
					>
						{loading ? 'Отправляем код…' : 'Получить код'}
					</button>
					{sendError && (
						<p className='auth-card__error' role='alert'>
							{sendError}
						</p>
					)}
				</section>

				<div className='auth__below'>
					<div className='auth__belowTitle'>Нет аккаунта?</div>

					<button
						type='button'
						className='auth__outlineBtn ui-action-btn'
						onClick={() => router.push('/auth/register')}
					>
						Зарегистрируйтесь
					</button>
				</div>
			</div>
		</main>
	)
}
