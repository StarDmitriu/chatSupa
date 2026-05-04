'use client'

import { Suspense, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Cookies from 'js-cookie'
import Image from 'next/image'
import './page.css'
import { useNotify } from '@/ui/notify/notify'

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

function maskPhone(p: string) {
	if (!p) return ''
	// простая маска: оставим + и последние 2-3 символа, остальное заменим
	const s = p.trim()
	if (s.length <= 4) return s
	const tail = s.slice(-3)
	return s.slice(0, 2) + ' XXX XXX-XX-' + tail
}

function CodeInner() {
	const params = useSearchParams()
	const router = useRouter()

	const phone = params.get('phone') || ''
	const mode = params.get('mode') || 'login' // login | register

	const [code, setCode] = useState('')
	const [loading, setLoading] = useState(false)
	const [resendLoading, setResendLoading] = useState(false)
	const notify = useNotify()

	const verify = async () => {
		if (!code.trim()) {
			notify('Введите код', { type: 'error'})
			return;		}

		setLoading(true)
		try {
			let body: any = { phone, code: code.trim() }

			if (mode === 'register' && typeof window !== 'undefined') {
				const raw = sessionStorage.getItem('registerProfile')
				if (raw) {
					try {
						const profile = JSON.parse(raw)
						body = { ...body, ...profile }
					} catch (e) {
						console.error('Ошибка парсинга registerProfile:', e)
					}
				}
			}

			const res = await fetch(`${backendUrl}/auth/verify-code`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})

			const data = await res.json().catch(() => ({}))

			if (!res.ok || !data?.success) {
				if (data?.message === 'user_not_found' && mode === 'login') {
					const go = confirm(
						'Пользователь с таким номером не найден. Зарегистрироваться?'
					)
					if (go) {
						if (typeof window !== 'undefined') {
							sessionStorage.removeItem('registerProfile')
						}
						router.push(`/auth/register?phone=${encodeURIComponent(phone)}`)
					}
					return;				}

				notify(data?.message || 'Ошибка при проверке кода', {
					type: 'error',
					title: 'Ошибка',
				})
				return;			}

			if (mode === 'register' && typeof window !== 'undefined') {
				sessionStorage.removeItem('registerProfile')
			}

			const token = typeof data?.token === 'string' ? data.token.trim() : ''
			if (!token) {
				notify('Не удалось сохранить вход: токен не получен. Попробуйте ещё раз.', {
					type: 'error',
					title: 'Ошибка',
				})
				return
			}

			const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
			Cookies.set('token', token, { expires: 30, sameSite: 'lax', secure: isHttps })

			// После установки cookie делаем полноценную навигацию, чтобы кабинет точно увидел токен
			if (typeof window !== 'undefined') {
				window.location.assign('/cabinet')
			} else {
				router.push('/cabinet')
			}
		} catch (err) {
			console.error(err)
			notify('Ошибка сети, попробуйте ещё раз', {
				type: 'error',
				title: 'Ошибка',
			})
		} finally {
			setLoading(false)
		}
	}

	const resendCode = async () => {
		if (!phone) {
			notify('Телефон отсутствует', {
				type: 'error',
			})
			return;		}

		setResendLoading(true)
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), 25000)
		try {
			const res = await fetch(`${backendUrl}/auth/send-code`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ phone }),
				signal: controller.signal,
			})
			clearTimeout(timeoutId)

			const data = await res.json().catch(() => ({}))

			if (!res.ok || !data?.success) {
				const msg = data?.message
				const text =
					msg === 'supabase_timeout'
						? 'База данных не ответила вовремя (таймаут 15 сек). Часто это ошибка 522 до Supabase — попробуйте через несколько минут.'
						: msg === 'supabase_error' || msg === 'service_unavailable' || msg === 'supabase_select_error' || msg === 'supabase_upsert_error'
							? 'Ошибка соединения с базой данных. Попробуйте позже.'
							: msg === 'too_many_requests'
							? 'Подождите минуту перед повторной отправкой кода.'
							: msg === 'sms_send_failed'
								? 'Не удалось отправить SMS. Попробуйте позже.'
								: msg || 'Не удалось отправить код'
				notify(text, { type: 'error', title: 'Ошибка' })
				return
			}

			notify('Код отправлен повторно!', {
				type: 'success',
			})
		} catch (err: any) {
			clearTimeout(timeoutId)
			console.error(err)
			if (err?.name === 'AbortError') {
				notify('Сервер не ответил вовремя. Попробуйте снова.', { type: 'error', title: 'Ошибка' })
			} else {
				notify('Ошибка сети при повторной отправке', { type: 'error', title: 'Ошибка' })
			}
		} finally {
			setResendLoading(false)
		}
	}

	return (
		<div className='auth'>
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

				<h1 className='auth__title'>Подтвердите вход</h1>

				<div className='auth__subtitle'>
					Мы отправили код подтверждения
					<br />
					на номер {maskPhone(phone)}
				</div>

				<div className='auth-card'>
					<input
						className='auth-card__input'
						placeholder='Введите 6-значный код'
						value={code}
						onChange={e => setCode(e.target.value)}
						onKeyDown={e => {
							if (e.key === 'Enter') {
								e.preventDefault()
								verify()
							}
						}}
						inputMode='numeric'
						autoComplete='one-time-code'
						maxLength={6}
					/>

					<button
						className='auth-btn auth-card__button ui-action-btn'
						onClick={verify}
						disabled={loading}
						type='button'
					>
						{loading ? 'Проверяем...' : 'Введите 6-значный код'}
					</button>
				</div>

				<div className='auth-card auth-card--secondary'>
					<div className='auth__belowTitle'>Не пришёл код?</div>

					<button
						className='auth-btn auth-card__button ui-action-btn'
						onClick={resendCode}
						disabled={resendLoading}
						type='button'
					>
						{resendLoading ? 'Отправляем...' : 'Отправить ещё раз'}
					</button>
				</div>
			</div>
		</div>
	)
}

export default function CodePage() {
	return (
		<Suspense fallback={<div className='auth'>Загрузка...</div>}>
			<CodeInner />
		</Suspense>
	)
}
