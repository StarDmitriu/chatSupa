'use client'

import { useEffect, useState } from 'react'
import Cookies from 'js-cookie'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/api'
import './page.css'
import { useNotify } from '@/ui/notify/notify'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { PLAN_LABELS, PLAN_PRICES, isPlanCode } from '@/constants/channels'
import { useBackendSWR } from '@/lib/useBackendSWR'

const backendUrl =
	process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

type SubscriptionsMeResponse = {
	success?: boolean
	message?: string
	subscription?: Record<string, unknown>
	status?: string
	accessEndsAt?: string | null
	accessDaysLeft?: number
	isBlocked?: boolean
}

export default function SubscriptionPage() {
	const router = useRouter()
	const [swrKey, setSwrKey] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const notify = useNotify()
	const loader = useGlobalLoader()

	useEffect(() => {
		loader?.hide?.()
		const token = typeof document !== 'undefined' ? Cookies.get('token') : undefined
		if (!token) {
			router.push('/auth/phone')
			return
		}
		setSwrKey('subscriptions/me')
	}, [router, loader])

	const { data, error, isLoading: loading, mutate } = useBackendSWR<SubscriptionsMeResponse>(swrKey)

	const startTrial = async () => {
			const token = typeof document !== 'undefined' ? Cookies.get('token') : undefined
		if (!token) return
		setBusy(true)
		try {
			const res = await fetch(`${backendUrl}/subscriptions/start-trial`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				notify(json.message || 'Не удалось запустить тест', {
					type: 'error',
					title: 'Ошибка',
				})
				return;			}

			notify('Пробный период активирован!', { type: 'success' })
			await mutate()
		} catch (e) {
			console.error(e)
			notify('Ошибка сети', { type: 'error', title: 'Ошибка' })
		} finally {
			setBusy(false)
		}
	}

	const PAYMENT_ERROR_MESSAGES: Record<string, string> = {
		user_not_found: 'Пользователь не найден. Войдите снова.',
		invalid_plan_code: 'Выбран неверный тариф.',
		supabase_users_error: 'Ошибка загрузки данных. Попробуйте позже.',
		supabase_payments_insert_error:
			'Не удалось создать платёж. Попробуйте позже или обратитесь в поддержку.',
		payment_provider_error:
			'Ошибка платёжной системы. Попробуйте позже или оплатите другим способом.',
		payment_config_error:
			'Оплата временно недоступна: не настроена на сервере. Обратитесь в поддержку.',
	}

	const startPayment = async (planCode: 'wa' | 'tg' | 'wa_tg') => {
		try {
			const res = await apiPost('/payments/prodamus/create', {
				plan_code: planCode,
			})
			if (!res?.success || !res?.payment_url) {
				const code = res?.message || ''
				const text =
					PAYMENT_ERROR_MESSAGES[code] ||
					(res?.error ? `${res.error}` : 'Не удалось создать оплату. Попробуйте позже.')
				notify(text, { type: 'error', title: 'Ошибка оплаты' })
				return
			}
			window.location.href = res.payment_url
		} catch (e) {
			console.error(e)
			let msg =
				e instanceof ApiError
					? e.message
					: 'Ошибка сети. Проверьте подключение и попробуйте снова.'
			if (e instanceof ApiError && e.status === 500) {
				msg =
					'Внутренняя ошибка сервера. Возможные причины: не настроена платёжная система или сбой на стороне провайдера. Обратитесь в поддержку.'
			}
			notify(msg, { type: 'error', title: 'Ошибка оплаты' })
		}
	}

	const toggleAutoRenew = async (nextCancel: boolean) => {
		try {
			setBusy(true)
			const res = await apiPost('/subscriptions/cancel', {
				cancel: nextCancel,
			})
			if (!res?.success) {
				notify(res?.message || 'Не удалось обновить подписку', {
					type: 'error',
				})
				return
			}
			await mutate()
		} catch (e) {
			console.error(e)
			const msg = e instanceof ApiError ? e.message : 'Ошибка сети. Проверьте подключение и попробуйте снова.'
			notify(msg, { type: 'error', title: 'Ошибка' })
		} finally {
			setBusy(false)
		}
	}

	if (loading && !data) return null

	if (error) {
		return (
			<div className='subscription'>
				<div className='subscription__wrap'>
					<h1 className='subscription-title'>Моя подписка</h1>
					<div className='subscription-cont'>
						<p>Не удалось загрузить данные: {error.message || 'ошибка сети'}</p>
						<button type='button' onClick={() => mutate()}>Повторить</button>
						<button type='button' onClick={() => router.push('/cabinet')} style={{ marginLeft: 12 }}>В кабинет</button>
					</div>
				</div>
			</div>
		)
	}

	// ❗ если success=false — показываем ошибку
	if (!data?.success) {
		return (
			<div className='subscription'>
				<div className='subscription__wrap'>
					<h1 className='subscription-title'>Моя подписка</h1>
					<div className='subscription-cont'>
						<p>Не удалось загрузить данные: {data?.message || 'ошибка'}</p>
						<button type='button' onClick={() => router.push('/cabinet')}>Назад в кабинет</button>
					</div>
				</div>
			</div>
		)
	}

	// ✅ success=true — используем РЕАЛЬНЫЕ поля ответа
	const sub = data.subscription || {}
	const status = data.status || sub.status || 'none'
	const endsAt = data.accessEndsAt ?? null
	const daysLeft = endsAt
		? Math.max(
				0,
				Math.floor((new Date(endsAt).getTime() - Date.now()) / 86400000)
		  )
		: data.accessDaysLeft ?? 0
	const planCode = String(sub.plan_code || 'wa_tg')
	const cancelAtPeriodEnd = !!sub.cancel_at_period_end

	const canStartTrial =
		!data.isBlocked &&
		status !== 'active' &&
		status !== 'trial' &&
		daysLeft === 0

	const rusStatus =
		status === 'active'
			? 'Активна'
			: status === 'trial'
				? 'Пробный период'
				: 'Неактивна'

	const planLabel = isPlanCode(planCode) ? PLAN_LABELS[planCode] : 'Без тарифа'
	const showExpiringNotice =
		status === 'active' && (daysLeft === 3 || daysLeft === 1)

	return (
		<div className='subscription'>
			<div className='subscription__wrap'>
			<h1 className='subscription-title'>Моя подписка</h1>
			<p className='subscription-text'>
				Здесь вы можете продлить доступ, сменить тариф или отключить
				автосписание
			</p>
			<div className='subscription-cont'>
				{showExpiringNotice ? (
					<div
						style={{
							background: '#fff7d6',
							border: '1px solid #f2e2a8',
							borderRadius: 12,
							padding: 12,
							marginBottom: 12,
							width: '100%',
						}}
					>
						До конца подписки осталось {daysLeft} дн.
					</div>
				) : null}

				<div className='subscription-data'>
					<strong>Текущий тариф</strong>
					<p className='subscription-data-text'>{planLabel}</p>
				</div>
				<div className='subscription-data'>
					<strong>Статус</strong>
					<p className='subscription-data-text'>{rusStatus}</p>
				</div>
				<div className='subscription-data'>
					<strong>Осталось дней</strong>
					<p className='subscription-data-text'>{daysLeft}</p>
				</div>
				<div className='subscription-data'>
					<strong>Действует до:</strong>{' '}
					<p className='subscription-data-text'>
						{endsAt ? new Date(endsAt).toLocaleString() : '-'}
					</p>
				</div>

				{data.isBlocked ? (
					<p style={{ color: 'red' }}>
						<strong>Аккаунт заблокирован администратором</strong>
					</p>
				) : null}

				<div style={{ marginTop: 12 }}>
					{canStartTrial ? (
						<button
							onClick={startTrial}
							disabled={busy}
							className='trial-btn'
						>
							{busy ? 'Запускаем...' : 'Начать пробный период (3 дня)'}
						</button>
					) : null}

					{status === 'active' && !data.isBlocked ? (
						<button
							onClick={() => toggleAutoRenew(!cancelAtPeriodEnd)}
							disabled={busy}
							style={{ padding: 10, marginRight: 8 }}
						>
							{cancelAtPeriodEnd
								? 'Подключить подписку'
								: 'Отменить подписку'}
						</button>
					) : null}

					{!data.isBlocked ? (
						<div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
							<button
								onClick={() => startPayment('wa')}
								style={{ padding: 10 }}
							>
								Оплатить WhatsApp - {PLAN_PRICES.wa} руб. / месяц
							</button>
							<button
								onClick={() => startPayment('tg')}
								style={{ padding: 10 }}
							>
								Оплатить Telegram - {PLAN_PRICES.tg} руб. / месяц
							</button>
							<button
								onClick={() => startPayment('wa_tg')}
								style={{ padding: 10 }}
							>
								Оплатить WhatsApp + Telegram - {PLAN_PRICES.wa_tg} руб. / месяц
							</button>
						</div>
					) : null}

					<button
						onClick={() => router.push('/cabinet')}
						style={{ padding: 10, marginTop: 10 }}
					>
						Назад в кабинет
					</button>
				</div>
			</div>
			<p className='subscription-footer'>
				После окончания подписки доступ к сервису будет приостановлен
			</p>
			</div>
		</div>
	)
}
