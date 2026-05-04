'use client'

import { Suspense, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import './page.css'
import { useNotify } from '@/ui/notify/notify'

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

function RegisterInner() {
	const router = useRouter()
	const params = useSearchParams()

	const initialPhone = useMemo(() => params.get('phone') || '', [params])
	const ref = useMemo(() => params.get('ref') || '', [params])

	const [fullName, setFullName] = useState('')
	const [phone, setPhone] = useState(initialPhone)
	const [birthday, setBirthday] = useState('')
	const [city, setCity] = useState('')
	const [telegram, setTelegram] = useState('')

	const [pdConsent, setPdConsent] = useState(false)
	const [marketingConsent, setMarketingConsent] = useState(false)

	const [loading, setLoading] = useState(false)
	const notify = useNotify()

	const back = () => {
		router.push(`/`)
	}

	const sendCode = async () => {
		// валидация как на лендинге
		if (!fullName.trim()) return notify('Заполни поле "Имя и фамилия"', { type: "error", title: "Ошибка" });
		if (!phone.trim()) return notify('Заполни поле "Номер телефона"', { type: "error", title: "Ошибка" });
		if (!birthday.trim()) return notify('Заполни поле "Дата рождения"', { type: "error", title: "Ошибка" });
		if (!city.trim()) return notify('Заполни поле "Город"', { type: "error", title: "Ошибка" });
		if (!pdConsent)
			return notify('Нужно согласие на обработку персональных данных', {
				type: 'error',
				title: 'Ошибка',
			})

		setLoading(true)
		const controller = new AbortController()
		let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(), 25000)
		try {
			// 1) отправляем код
			const res = await fetch(`${backendUrl}/auth/send-code`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ phone: phone.trim() }),
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
								: msg || 'Ошибка при отправке кода'
				notify(text, { type: 'error', title: 'Ошибка' })
				return
			}

			// 2) сохраняем профиль (его подхватит verify-code в /auth/code)
			const profile = {
				full_name: fullName.trim(),
				telegram: telegram.trim() || null,
				birthday: birthday.trim() || null,
				city: city.trim(),
				consent_personal: pdConsent,
				consent_marketing: marketingConsent,
				ref: ref || null,
			}

			if (typeof window !== 'undefined') {
				sessionStorage.setItem('registerProfile', JSON.stringify(profile))
			}

			// 3) идём на ввод кода
			router.push(
				`/auth/code?phone=${encodeURIComponent(
					phone.trim()
				)}&mode=register&ref=${encodeURIComponent(ref)}`
			)
		} catch (err: any) {
			if (timeoutId !== undefined) clearTimeout(timeoutId)
			console.error(err)
			if (err?.name === 'AbortError') {
				notify('Сервер не ответил вовремя. Проверьте интернет и попробуйте снова.', { type: 'error', title: 'Ошибка' })
			} else {
				notify('Ошибка сети, попробуйте ещё раз', { type: 'error', title: 'Ошибка' })
			}
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className='auth'>
			<button type='button' className='auth-back__button ui-action-btn' onClick={back}>
				Назад
			</button>
			<div className='auth__wrap'>
				<h1 className='auth__title'>Регистрация пользователя</h1>

				<div className='auth-card'>
					<input
						className='auth-card__input'
						placeholder='Имя и фамилия *'
						value={fullName}
						onChange={e => setFullName(e.target.value)}
					/>

					<input
						className='auth-card__input'
						placeholder='Номер телефона *'
						value={phone}
						onChange={e => setPhone(e.target.value)}
					/>

					<input
						className='auth-card__input'
						type='date'
						value={birthday ?? ''}
						onChange={e => setBirthday(e.target.value)}
					/>

					<input
						className='auth-card__input'
						placeholder='Город *'
						value={city}
						onChange={e => setCity(e.target.value)}
					/>

					<input
						className='auth-card__input'
						placeholder='Ник в телеграм'
						value={telegram}
						onChange={e => setTelegram(e.target.value)}
					/>

					<div className='auth-checks'>
						<label className='auth-check'>
							<input
								type='checkbox'
								checked={pdConsent}
								onChange={e => setPdConsent(e.target.checked)}
							/>
							<span>
								Даю согласие на{' '}
								<a href='/docs/pd-consent.pdf' target='_blank' rel='noreferrer'>
									обработку персональных данных
								</a>
							</span>
						</label>

						<label className='auth-check'>
							<input
								type='checkbox'
								checked={marketingConsent}
								onChange={e => setMarketingConsent(e.target.checked)}
							/>
							<span>
								Даю согласие на{' '}
								<a href='/docs/pd-politic.pdf' target='_blank' rel='noreferrer'>
									получение информации и напоминаний
								</a>
							</span>
						</label>
					</div>

					<button
						className='auth-btn auth-card__button ui-action-btn'
						onClick={sendCode}
						disabled={loading}
						type='button'
					>
						{loading ? 'Отправляем код...' : 'Получить код и продолжить'}
					</button>
				</div>

				<div className='auth__below'>
					<div className='auth__belowTitle'>Уже есть аккаунт?</div>
					<button
						type='button'
						className='auth-btn auth-btn--ghost ui-action-btn'
						onClick={() => router.push('/auth/phone')}
					>
						Войти
					</button>
				</div>
			</div>
		</div>
	)
}

export default function RegisterPage() {
	return (
		<Suspense fallback={<div className='auth'>Загрузка...</div>}>
			<RegisterInner />
		</Suspense>
	)
}
