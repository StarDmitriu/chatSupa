// frontend/src/app/page.tsx
'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import './page.css'
import { useNotify } from '@/ui/notify/notify'
import { ChannelIcon } from '@/components/ChannelIcon'

export default function HomePage() {
	const [menuOpen, setMenuOpen] = useState(false)
	const [visibleSections, setVisibleSections] = useState<Set<string>>(new Set())


	const [fullName, setFullName] = useState('')
	const [phone, setPhone] = useState('')
	const [birthDate, setBirthDate] = useState('')
	const [city, setCity] = useState('')
	const [telegram, setTelegram] = useState('')

	const [pdConsent, setPdConsent] = useState(false)
	const [marketingConsent, setMarketingConsent] = useState(false)

	const [sending, setSending] = useState(false)
	const notify = useNotify()

	// Анимация появления контента при скролле; подстраховка — через 0.6 с показываем все секции (на случай bfcache/другого устройства)
	useEffect(() => {
		const ids = ['hero', 'about', 'how', 'pricing', 'contact']
		setVisibleSections((prev) => new Set(prev).add('hero'))

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						const id = entry.target.getAttribute('data-section-id')
						if (id) setVisibleSections((prev) => new Set(prev).add(id))
					}
				})
			},
			{ threshold: 0.05, rootMargin: '0px 0px -20px 0px' }
		)

		const sections = document.querySelectorAll('[data-section-id]')
		sections.forEach((section) => observer.observe(section))

		const timer = window.setTimeout(() => {
			setVisibleSections((prev) => {
				const next = new Set(prev)
				ids.forEach((id) => next.add(id))
				return next
			})
		}, 600)

		return () => {
			window.clearTimeout(timer)
			sections.forEach((section) => section && observer.unobserve(section))
		}
	}, [])

	useEffect(() => {
		// блокируем скролл при открытом меню
		document.body.style.overflow = menuOpen ? 'hidden' : ''
		return () => {
			document.body.style.overflow = ''
		}
	}, [menuOpen])

	const closeMenu = () => setMenuOpen(false)

	

	return (
		<main className='landing'>
			<header className='landing-header'>
				<div className={`mobile-menu ${menuOpen ? 'open' : ''}`}>
					<div className='mobile-menu__backdrop' onClick={closeMenu} />
					<div className='mobile-menu__panel'>
						<div className='mobile-menu__top'>
							<div className='mobile-brand brand-logo'>
								<Image
									src='/logo-heart.png'
									alt=''
									width={54}
									height={54}
									priority
									className='brand-logo__icon'
								/>
								<span className='brand-logo__chat'>Чат</span>
								<span className='brand-logo__accent'>Рассылка</span>
							</div>
							<button
								className='mobile-close'
								onClick={closeMenu}
								aria-label='Закрыть меню'
							>
								✕
							</button>
						</div>

						<div className='mobile-links'>
							<a className='mobile-link ui-action-btn ui-header-btn' href='#about' onClick={closeMenu}>
								О нас
							</a>
							<a className='mobile-link ui-action-btn ui-header-btn' href='#how' onClick={closeMenu}>
								Как работает сервис?
							</a>
							<a className='mobile-link ui-action-btn ui-header-btn' href='#pricing' onClick={closeMenu}>
								Тарифы
							</a>
							<Link className='mobile-link ui-action-btn ui-header-btn' href='/presentation' onClick={closeMenu}>
								Презентация
							</Link>
							<Link className='mobile-link ui-action-btn ui-header-btn' href='/cabinet' onClick={closeMenu}>
								Личный кабинет
							</Link>
						</div>
					</div>
				</div>

				<div className='container header-row'>
					<div className='brand-logo'>
						<Image
							src='/logo-heart.png'
							alt=''
							width={72}
							height={72}
							priority
							className='brand-logo__icon'
						/>
						<span className='brand-logo__chat'>Чат</span>
						<span className='brand-logo__accent'>Рассылка</span>
					</div>

					{/* Desktop nav */}
					<nav className='nav nav-desktop'>
						<a className='pill ui-action-btn ui-header-btn' href='#about'>
							О нас
						</a>
						<a className='pill ui-action-btn ui-header-btn' href='#how'>
							Как работает сервис?
						</a>
						<a className='pill ui-action-btn ui-header-btn' href='#pricing'>
							Тарифы
						</a>
						<Link className='pill ui-action-btn ui-header-btn' href='/presentation'>
							Презентация
						</Link>
						<Link className='pill ui-action-btn ui-header-btn' href='/cabinet'>
							Личный кабинет
						</Link>
					</nav>

					{/* Burger button (mobile) */}
					<button
						className={`burger ${menuOpen ? 'is-open' : ''}`}
						aria-label='Открыть меню'
						aria-expanded={menuOpen}
						onClick={() => setMenuOpen(v => !v)}
					>
						<span />
						<span />
						<span />
					</button>
				</div>
			</header>

			<section 
				className={`hero ${visibleSections.has('hero') ? 'fade-in' : ''}`}
				data-section-id='hero'
			>
				<div className='container'>
					<div className='hero-card'>
						<div className='hero-cont'>
							<div className='hero-titleStack'>
								<Image
									src='/logo-heart-hero.png'
									alt=''
									priority
									width={80}
									height={56}
									className='hero-titleStack__logo'
								/>
								<h1 className='hero-title' data-text='ЧатРассылка'>
									<span className='hero-title__chat'>Чат</span>
									<span className='hero-title__accent'>Рассылка</span>
								</h1>
							</div>
							<p className='hero-subtitle'>
								Автоматическая рассылка сообщений по группам в{' '}
								<a
									className='hero-subtitle-app hero-subtitle-app--wa'
									href='/dashboard/groups'
									aria-label='Открыть группы WhatsApp'
								>
									<span className='hero-subtitle-appIcon'>
										<ChannelIcon type='wa' size={22} />
									</span>
									<span>WhatsApp</span>
								</a>{' '}
								и{' '}
								<a
									className='hero-subtitle-app hero-subtitle-app--tg'
									href='/dashboard/groups/telegram'
									aria-label='Открыть группы Telegram'
								>
									<span className='hero-subtitle-appIcon'>
										<ChannelIcon type='tg' size={22} />
									</span>
									<span>Telegram</span>
								</a>
							</p>

							<a className='hero-button' href='#zaayka'>
								Отправить заявку
							</a>
						</div>
					</div>
				</div>
			</section>

			<section 
				id='about' 
				className={`section section-about ${visibleSections.has('about') ? 'fade-in' : ''}`}
				data-section-id='about'
			>
				<div className='container'>
					<h2 className='section-title'>О нас</h2>

					<p className='section-text'>
						Сервис «ЧатРассылка» помогает Вам ежедневно публиковать объявления в
						группы WhatsApp и Telegram автоматически - без ручной рассылки,
						независимо от работы интернета в городе
					</p>

					<div className='stats'>
						<div className='stat'>
							<div className='stat-value'>300+</div>
							<div className='stat-label'>
								специалистов уже
								<br />
								используют наш сервис
							</div>
						</div>

						<div className='stat'>
							<div className='stat-value'>24/7</div>
							<div className='stat-label'>
								доставляем Ваши сообщения
								<br />
								независимо от сбоев интернета
							</div>
						</div>

						<div className='stat'>
							<div className='stat-value'>100%</div>
							<div className='stat-label'>
								доставляемость
								<br />
								сообщений в Ваши группы
							</div>
						</div>
					</div>
				</div>
			</section>

			<section 
				id='how' 
				className={`section section-how ${visibleSections.has('how') ? 'fade-in' : ''}`}
				data-section-id='how'
			>
				<div className='container'>
					<h2 className='section-title'>
						Как работает сервис{' '}
						<span className='brand-logo section-title__brand'>
							<span className='brand-logo__chat'>Чат</span>
							<span className='brand-logo__accent'>Рассылка</span>
						</span>
					</h2>

					<div className='how-grid'>
						<div className='how-card'>
							<div className='how-num' data-num='1'>1</div>
							<div className='how-head'>
								Подготовка аккаунта
								<br />
								WhatsApp, Telegram
							</div>
							<p className='how-text'>
								<span className='how-text__span'>
									{' '}
									Для эффективной рассылки
								</span>{' '}
								важно, чтобы Ваш аккаунт WhatsApp, Telegram должен быть
								участником групп
							</p>
							<p className='how-text'>
								Если Вы не являетесь участником группы или Вы заблокированы в
								этой группе, Ваше сообщение{' '}
								<span className='how-text__span'>не будет доставлено</span> в
								эту группу
							</p>
							<div className='how-actions'>
								<Link className='how-action-btn' href='/cabinet'>
									Личный кабинет
								</Link>
							</div>
						</div>

						<div className='how-card'>
							<div className='how-num' data-num='2'>2</div>
							<div className='how-head'>
								Подключение Ваших
								<br />
								аккаунтов WhatsApp и Telegram
							</div>
							<p className='how-text'>
								После{' '}
								<span className='how-text__span'>личной консультации</span>{' '}
								<br />
								Вы получите доступ к личному кабинету
							</p>
							<p className='how-text'>
								Совершите вход в систему и выполните синхронизацию Ваших
								WhatsApp, Telegram
							</p>
							<p className='how-text'>
								Мы автоматически загрузим группы, <br />в которых Вы состоите
							</p>
							<div className='how-actions'>
								<Link className='how-action-btn how-action-btn--wa' href='/dashboard/groups'>
									Группы WA
								</Link>
								<Link
									className='how-action-btn how-action-btn--tg'
									href='/dashboard/groups/telegram'
								>
									Группы TG
								</Link>
							</div>
						</div>

						<div className='how-card'>
							<div className='how-num' data-num='3'>3</div>
							<div className='how-head'>
								Добавление
								<br />
								Ваших объявлений
							</div>
							<p className='how-text'>
								После загрузки Ваших групп, Вам необходимо{' '}
								<span className='how-text__span'>создать объявления </span>
								для рассылки
							</p>
							<p className='how-text'>
								<span className='how-text__span'>Всего несколько кликов: </span>
								добавляете фото, текст и выбираете группы, в которые система
								автоматически будет отправлять сообщения
							</p>
							<div className='how-actions'>
								<Link className='how-action-btn' href='/dashboard/templates'>
									Шаблоны
								</Link>
							</div>
						</div>

						<div className='how-card'>
							<div className='how-num' data-num='4'>4</div>
							<div className='how-head'>
								Автоматическая рассылка
								<br />
								по расписанию
							</div>
							<div className='how-text'>
								Настройте время отправки{' '}
								<span className='how-text__span'>1 раз</span> — и система{' '}
								<span className='how-text__span'>сама ежедневно</span> будет
								публиковать <br />
								Ваши объявления в группы независимо от наличия подключения к
								интернету
							</div>
							<div className='how-text'>
								Теперь Вам <span className='how-text__span'>не нужно</span>{' '}
								тратить
								<br />{' '}
								<span className='how-text__span'>
									по несколько часов в день
								</span>{' '}
								на рассылки
							</div>
							<div className='how-actions'>
								<Link className='how-action-btn' href='/dashboard/campaigns'>
									Рассылки
								</Link>
							</div>
						</div>
					</div>
				</div>
			</section>

			<section 
				id='pricing' 
				className={`section section-pricing ${visibleSections.has('pricing') ? 'fade-in' : ''}`}
				data-section-id='pricing'
			>
				<div className='container'>
					<h2 className='section-title'>Тарифы</h2>

					<p className='pricing-text'>
						Тарифы по рассылке <br /> Стоимость <b>не зависит</b> от количества
						групп и сообщений отправляемых в день
					</p>

							<div className='pricing-price ui-action-surface'>
						<div className='pricing-price__row'>
							<span>Отправка сообщений в</span>
							<span className='pricing-price__app'>
								<ChannelIcon type='tg' size={22} />
								<span>Telegram</span>
							</span>
						</div>
						<div className='pricing-price__right'>1000 ₽</div>
					</div>
							<div className='pricing-price ui-action-surface'>
						<div className='pricing-price__row'>
							<span>Отправка сообщений в</span>
							<span className='pricing-price__app'>
								<ChannelIcon type='wa' size={22} />
								<span>WhatsApp</span>
							</span>
						</div>
						<div className='pricing-price__right'>2000 ₽</div>
					</div>
							<div className='pricing-price ui-action-surface'>
						<div className='pricing-price__row'>
							<span>Отправка сообщений в</span>
							<span className='pricing-price__app'>
								<ChannelIcon type='wa' size={22} />
								<span>WhatsApp</span>
							</span>
							<span>и</span>
							<span className='pricing-price__app'>
								<ChannelIcon type='tg' size={22} />
								<span>Telegram</span>
							</span>
						</div>
						<div className='pricing-price__right'>2500 ₽</div>
					</div>

					<div className='trial-card'>
						<div className='trial-title'>
							<span className='trial-title__accent' data-text='3 дня'>
								3 дня
							</span>{' '}
							бесплатного доступа
						</div>
						<div className='trial-subtitle'>
							Попробуйте <b>бесплатно все функции</b> сервиса без ограничений
						</div>

						<div className='trial-steps'>
							<div className='trial-pill'>Подключайте WhatsApp и Telegram</div>
							<div className='trial-arrow'>→</div>
							<div className='trial-pill'>Создавайте шаблоны</div>
							<div className='trial-arrow'>→</div>
							<div className='trial-pill'>Отправляйте рассылки</div>
						</div>

						<div className='trial-down'>↓</div>

						<Link className='trial-main trial-pill ' href='/cabinet'>
							Перейти к подключению
						</Link>
					</div>
				</div>
			</section>

			<section 
				id='zaayka' 
				className={`section section-contact ${visibleSections.has('contact') ? 'fade-in' : ''}`}
				data-section-id='contact'
			>
				<div className='container'>
					<h2 className='section-title'>Форма обратной связи</h2>

					<form
						className='contact-card'
						onSubmit={async e => {
							e.preventDefault()

							if (!pdConsent) {
								notify('Нужно согласие на обработку персональных данных', {
									type: 'warning',
								})
								return;
							}

							// простая проверка обязательных
							if (!fullName.trim())
								return notify('Заполни поле "Имя и фамилия"', {
									type: 'warning',
								})
							if (!phone.trim())
								return notify('Заполни поле "Номер телефона"', {
									type: 'warning',
								})
							if (!birthDate.trim())
								return notify('Заполни поле "Дата рождения"', {
									type: 'warning',
								})
							if (!city.trim())
								return notify('Заполни поле "Город"', {
									type: 'warning',
								})
							if (!pdConsent)
								return notify(
									'Нужно согласие на обработку персональных данных',
									{
										type: 'warning',
									},
								)

							try {
								setSending(true)

								const res = await fetch('/api/leads', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({
										full_name: fullName.trim(),
										phone: phone.trim(),
										birth_date: birthDate.trim(),
										city: city.trim(),
										telegram: telegram.trim() || null,
										consent_personal: pdConsent,
										consent_marketing: marketingConsent,
									}),
								})

								const data = await res.json().catch(() => ({}))

								if (!res.ok || !data?.success) {
									notify(data?.message || 'Не удалось отправить заявку', {
										type: 'error',
										title: 'Ошибка',
									})
									return;
								}

								notify('Заявка отправлена!', {
									type: 'success',
								})

								// очистим форму
								setFullName('')
								setPhone('')
								setBirthDate('')
								setCity('')
								setTelegram('')
								setPdConsent(false)
								setMarketingConsent(false)
							} catch (err) {
								console.error(err)
								notify('Ошибка сети', {
									type: 'error',
									title: 'Ошибка',
								})
							} finally {
								setSending(false)
							}
						}}
					>
						<input
							className='input'
							placeholder='Имя и фамилия *'
							value={fullName}
							onChange={e => setFullName(e.target.value)}
							autoComplete='name'
						/>

						<input
							className='input'
							placeholder='Номер телефона *'
							value={phone}
							onChange={e => setPhone(e.target.value)}
							type='tel'
							autoComplete='tel'
						/>

						<input
							className='input'
							type='date'
							value={birthDate ?? ''}
							onChange={e => setBirthDate(e.target.value)}
							autoComplete='bday'
						/>

						<input
							className='input'
							placeholder='Город *'
							value={city}
							onChange={e => setCity(e.target.value)}
							autoComplete='address-level2'
						/>

						<input
							className='input'
							placeholder='Ник в телеграм'
							value={telegram}
							onChange={e => setTelegram(e.target.value)}
							autoComplete='username'
						/>

						<div className='check-cont'>
							<label className='check'>
								<input
									type='checkbox'
									checked={pdConsent}
									onChange={e => setPdConsent(e.target.checked)}
								/>
								<span>
									Даю согласие на{' '}
									<a
										href='/docs/pd-consent.pdf'
										target='_blank'
										rel='noreferrer'
									>
										обработку персональных данных
									</a>
								</span>
							</label>

							<label className='check'>
								<input
									type='checkbox'
									checked={marketingConsent}
									onChange={e => setMarketingConsent(e.target.checked)}
								/>
								<span>
									Даю согласие на{' '}
									<a
										href='/docs/pd-politic.pdf'
										target='_blank'
										rel='noreferrer'
									>
										получение информации и напоминаний
									</a>
								</span>
							</label>
						</div>
						<button className='contact-button' disabled={sending} type='submit'>
							{sending ? 'Отправка...' : 'Отправить заявку'}
						</button>
					</form>

					<footer className='footer-card'>
						<div className='footer-nav'>
							<a className='ui-action-btn' href='#about'>О нас</a>
							<a className='ui-action-btn' href='#how'>Как работает сервис?</a>
							<a className='ui-action-btn' href='#pricing'>Тарифы</a>
							<Link className='ui-action-btn' href='/cabinet'>Личный кабинет</Link>
							<Link className='ui-action-btn' href='/presentation'>Презентация</Link>
						</div>

						<div className='footer-meta'>
							<div className='footer-meta__left'>
								<p>ИНН 233200403399</p>
								<p>Зыбцева Любовь Васильевна</p>
							</div>
							<div className='footer-meta__right'>
								<p className='footer-meta__label'>Сервис сделали</p>
								<p className='footer-meta__names'>
									<a
										href='https://t.me/el230326'
										target='_blank'
										rel='noreferrer'
									>
										El Tech
									</a>
									<span>&nbsp;×&nbsp;</span>
									<a
										href='https://t.me/Borislav_Barsukov'
										target='_blank'
										rel='noreferrer'
									>
										Boss AI
									</a>
								</p>
								<p className='footer-meta__people'>
									<a
										href='https://t.me/el230326'
										target='_blank'
										rel='noreferrer'
									>
										Эл Сёмин
									</a>
									<span>&nbsp;и&nbsp;</span>
									<a
										href='https://t.me/Borislav_Barsukov'
										target='_blank'
										rel='noreferrer'
									>
										Борислав Барсуков
									</a>
								</p>
							</div>
						</div>

						<div className='footer-title'>
							<span className='footer-title__chat'>Чат</span>
							<span className='footer-title__accent'>Рассылка</span>
						</div>
					</footer>
				</div>
			</section>
		</main>
	)
}
