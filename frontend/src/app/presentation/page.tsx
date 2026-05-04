'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	BRAND_IMAGES,
	FAQ_ITEMS,
	GLOSSARY,
	HOW_STEPS,
	KEY_STATS,
	ONELINERS,
	PAGE_OUTLINE,
	SLIDES,
} from './data'
import './page.css'

function IconWa({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox='0 0 24 24' aria-hidden width={20} height={20}>
			<path
				fill='currentColor'
				d='M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z'
			/>
		</svg>
	)
}

function IconTg({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox='0 0 24 24' aria-hidden width={20} height={20}>
			<path
				fill='currentColor'
				d='M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z'
			/>
		</svg>
	)
}

const TOP_LINKS = [
	{ href: '#outline', label: 'Содержание' },
	{ href: '#deck', label: 'О продукте' },
	{ href: '#how', label: 'Как начать' },
	{ href: '#faq', label: 'Вопросы' },
	{ href: '#glossary', label: 'Термины' },
	{ href: '#oneliners', label: 'Тексты' },
]

function SlideVisualFrame({
	src,
	alt,
	layout,
	priority,
}: {
	src: string
	alt: string
	layout: 'side' | 'below' | 'hero'
	priority?: boolean
}) {
	const isSvg = src.endsWith('.svg')
	if (isSvg) {
		return (
			<div className={`pres-slide__media pres-slide__media--${layout}`}>
				<img src={src} alt={alt} className='pres-slide__img' />
			</div>
		)
	}
	return (
		<div className={`pres-slide__media pres-slide__media--${layout}`}>
			<Image
				src={src}
				alt={alt}
				width={layout === 'hero' ? 1200 : 560}
				height={layout === 'hero' ? 520 : 360}
				className='pres-slide__img'
				priority={priority}
				sizes='(max-width: 960px) 100vw, 560px'
			/>
		</div>
	)
}

export default function PresentationPage() {
	const [progress, setProgress] = useState(0)
	const [activeId, setActiveId] = useState<string>(SLIDES[0]?.id ?? '')
	const [tocOpen, setTocOpen] = useState(false)
	const slideRefs = useRef<Map<string, HTMLElement>>(new Map())
	const structuredData = {
		'@context': 'https://schema.org',
		'@type': 'WebPage',
		name: 'Презентация для клиентов — ЧатРассылка',
		description:
			'Клиентская презентация сервиса массовых рассылок в WhatsApp и Telegram: возможности, шаги запуска, FAQ и готовые формулировки.',
		url: 'https://chatrassylka.ru/presentation',
		inLanguage: 'ru',
		primaryImageOfPage: 'https://chatrassylka.ru/presentation/og-cover.png',
		publisher: {
			'@type': 'Organization',
			name: 'ЧатРассылка',
			logo: {
				'@type': 'ImageObject',
				url: 'https://chatrassylka.ru/logo-heart-hero.png',
			},
		},
	}

	const scrollToSlide = useCallback((id: string) => {
		const el = slideRefs.current.get(id)
		el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
		setTocOpen(false)
	}, [])

	useEffect(() => {
		const onScroll = () => {
			const doc = document.documentElement
			const h = doc.scrollHeight - doc.clientHeight
			setProgress(h > 0 ? (doc.scrollTop / h) * 100 : 0)
		}
		window.addEventListener('scroll', onScroll, { passive: true })
		onScroll()
		return () => window.removeEventListener('scroll', onScroll)
	}, [])

	useEffect(() => {
		const ids = SLIDES.map((s) => s.id)
		const obs = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting && e.target.id) {
						const sid = e.target.id.replace('slide-', '')
						setActiveId(sid)
						break
					}
				}
			},
			{ rootMargin: '-40% 0px -45% 0px', threshold: 0 }
		)
		for (const id of ids) {
			const el = document.getElementById(`slide-${id}`)
			if (el) obs.observe(el)
		}
		return () => obs.disconnect()
	}, [])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
			const idx = SLIDES.findIndex((s) => s.id === activeId)
			if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J') {
				e.preventDefault()
				const next = SLIDES[Math.min(idx + 1, SLIDES.length - 1)]
				if (next) scrollToSlide(next.id)
			}
			if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'K') {
				e.preventDefault()
				const prev = SLIDES[Math.max(idx - 1, 0)]
				if (prev) scrollToSlide(prev.id)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [activeId, scrollToSlide])

	const printPage = () => window.print()

	return (
		<div className='presentation presentation--client'>
			<script type='application/ld+json' dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
			<div className='pres-progress' aria-hidden>
				<div className='pres-progress__bar' style={{ width: `${progress}%` }} />
			</div>

			<header className='pres-topbar'>
				<Link href='/' className='pres-brand' aria-label='На главную'>
					<span className='pres-brand__chat'>Чат</span>
					<span className='pres-brand__accent'>Рассылка</span>
				</Link>
				<div className='pres-topbar__actions'>
					<button type='button' className='pres-btn pres-btn--ghost' onClick={printPage}>
						Печать / PDF
					</button>
					<nav className='pres-nav' aria-label='Разделы страницы'>
						{TOP_LINKS.map((l) => (
							<a key={l.href} href={l.href}>
								{l.label}
							</a>
						))}
						<Link href='/'>Сайт</Link>
						<Link href='/cabinet'>Кабинет</Link>
					</nav>
				</div>
			</header>

			<div className='pres-layout'>
				<aside className='pres-toc' aria-label='Навигация по слайдам'>
					<p className='pres-toc__title'>Разделы ({SLIDES.length})</p>
					<ol className='pres-toc__list'>
						{SLIDES.map((s, i) => (
							<li key={s.id}>
								<button
									type='button'
									className={`pres-toc__link ${activeId === s.id ? 'is-active' : ''}`}
									onClick={() => scrollToSlide(s.id)}
								>
									<span className='pres-toc__num'>{String(i + 1).padStart(2, '0')}</span>
									<span className='pres-toc__text'>{s.title}</span>
								</button>
							</li>
						))}
					</ol>
					<p className='pres-toc__hint'>
						<kbd>↑</kbd> <kbd>↓</kbd> — листать
					</p>
				</aside>

				<div className='pres-main'>
					<section className='pres-hero pres-hero--client' aria-labelledby='pres-hero-title'>
						<div className='pres-hero__grain' aria-hidden />
						<div className='pres-hero__glow' aria-hidden />
						<div className='pres-hero__gridlines' aria-hidden />
						<p className='pres-kicker'>Презентация для клиентов</p>
						<h1 id='pres-hero-title' className='pres-hero__title'>
							Рассылки в WhatsApp и Telegram без рутины
						</h1>
						<p className='pres-hero__lead'>
							Один кабинет — шаблоны, очередь с паузами и повтор по расписанию. Ниже — наглядные слайды
							с фирменной графикой, краткий путь «как начать», ответы на частые вопросы и готовые
							формулировки для сайта и соцсетей.
						</p>
						<div className='pres-hero__visual-row'>
							<div className='pres-hero__brand-block'>
								<Image
									src={BRAND_IMAGES.heroLogo}
									alt='ЧатРассылка'
									width={200}
									height={200}
									className='pres-hero__logo-img'
									priority
								/>
							</div>
							<div className='pres-hero__art'>
								<Image
									src={BRAND_IMAGES.heroArt}
									alt='Иллюстрация: единый кабинет для рассылок'
									width={640}
									height={400}
									className='pres-hero__art-img'
									priority
									sizes='(max-width: 960px) 100vw, 420px'
								/>
							</div>
						</div>
						<div className='pres-stats'>
							{KEY_STATS.map((k) => (
								<div key={k.label} className='pres-stat'>
									<span className='pres-stat__value'>{k.value}</span>
									<span className='pres-stat__label'>{k.label}</span>
									<span className='pres-stat__hint'>{k.hint}</span>
								</div>
							))}
						</div>
						<div className='pres-hero__channels'>
							<span className='pres-pill'>
								<IconWa /> WhatsApp
							</span>
							<span className='pres-pill'>
								<IconTg /> Telegram
							</span>
							<span className='pres-pill pres-pill--accent'>Можно сохранить в PDF</span>
						</div>
					</section>

					<section id='outline' className='pres-outline' aria-labelledby='outline-title'>
						<h2 id='outline-title' className='pres-section-title'>
							<span className='pres-section-title__mark' />
							Содержание
						</h2>
						<p className='pres-outline__intro'>
							Перейдите к нужному блоку — страница сверстана как единая презентация, удобная для
							показа с экрана или печати.
						</p>
						<div className='pres-outline__grid'>
							{PAGE_OUTLINE.map((item) => (
								<a key={item.id} className='pres-outline__card' href={`#${item.id}`}>
									<span className='pres-outline__card-title'>{item.title}</span>
									<span className='pres-outline__card-desc'>{item.desc}</span>
								</a>
							))}
						</div>
					</section>

					<section id='deck' className='pres-deck-intro'>
						<h2 className='pres-section-title'>
							<span className='pres-section-title__mark' />
							О продукте
						</h2>
						<p className='pres-deck-intro__text'>
							<strong>{SLIDES.length} слайдов</strong> — от контекста и задачи до тарифов и первого шага.
							Текст сформулирован так, чтобы его можно было показывать клиентам и партнёрам как
							готовый сценарий презентации.
						</p>
					</section>

					<div className='pres-slides'>
						{SLIDES.map((slide, i) => {
							const layout = slide.visual?.layout ?? 'below'
							const withSideVisual = slide.visual && layout === 'side'
							return (
								<article
									key={slide.id}
									id={`slide-${slide.id}`}
									className={`pres-slide pres-slide--layout-${layout} ${withSideVisual ? 'pres-slide--with-side-visual' : ''}`}
									ref={(el) => {
										if (el) slideRefs.current.set(slide.id, el)
										else slideRefs.current.delete(slide.id)
									}}
								>
									<div className='pres-slide__main'>
										<div className='pres-slide__head'>
											<span className='pres-slide__tag'>{slide.tag}</span>
											<span className='pres-slide__index'>
												{i + 1} / {SLIDES.length}
											</span>
										</div>
										<h3 className='pres-slide__title'>{slide.title}</h3>
										{slide.lead ? <p className='pres-slide__lead'>{slide.lead}</p> : null}
										{slide.body ? <p className='pres-slide__body'>{slide.body}</p> : null}
										{slide.bullets ? (
											<ul className='pres-slide__bullets'>
												{slide.bullets.map((b, j) => (
													<li key={j}>
														<span className='pres-slide__bullet'>{b.text}</span>
														{b.sub ? <span className='pres-slide__sub'>{b.sub}</span> : null}
													</li>
												))}
											</ul>
										) : null}
										{slide.visual && layout === 'hero' ? (
											<SlideVisualFrame
												src={slide.visual.src}
												alt={slide.visual.alt}
												layout='hero'
												priority={i < 2}
											/>
										) : null}
										{slide.visual && layout === 'below' ? (
											<SlideVisualFrame
												src={slide.visual.src}
												alt={slide.visual.alt}
												layout='below'
												priority={i < 3}
											/>
										) : null}
									</div>
									{slide.visual && layout === 'side' ? (
										<SlideVisualFrame
											src={slide.visual.src}
											alt={slide.visual.alt}
											layout='side'
											priority={i < 3}
										/>
									) : null}
								</article>
							)
						})}
					</div>

					<section id='how' className='pres-how' aria-labelledby='how-title'>
						<h2 id='how-title' className='pres-section-title'>
							<span className='pres-section-title__mark pres-section-title__mark--how' />
							Как начать работу
						</h2>
						<p className='pres-how__intro'>
							Четыре шага от регистрации до первой волны — без лишней терминологии.
						</p>
						<div className='pres-how__grid'>
							{HOW_STEPS.map((h) => (
								<div key={h.step} className='pres-how__card'>
									<span className='pres-how__step'>{h.step}</span>
									<h3>{h.title}</h3>
									<p className='pres-how__body'>{h.body}</p>
								</div>
							))}
						</div>
					</section>

					<section id='faq' className='pres-faq' aria-labelledby='faq-title'>
						<h2 id='faq-title' className='pres-section-title'>
							<span className='pres-section-title__mark pres-section-title__mark--faq' />
							Частые вопросы
						</h2>
						<p className='pres-faq__intro'>
							Короткие ответы, которые можно использовать на сайте, в переписке и при личной встрече.
						</p>
						<div className='pres-faq__list'>
							{FAQ_ITEMS.map((item, i) => (
								<details key={i} className='pres-faq__item'>
									<summary>{item.q}</summary>
									<p>{item.a}</p>
								</details>
							))}
						</div>
					</section>

					<section id='glossary' className='pres-gloss' aria-labelledby='gloss-title'>
						<h2 id='gloss-title' className='pres-section-title'>
							<span className='pres-section-title__mark pres-section-title__mark--gloss' />
							Термины
						</h2>
						<p className='pres-gloss__intro'>
							Единые формулировки — чтобы команда и клиенты говорили на одном языке.
						</p>
						<dl className='pres-gloss__dl'>
							{GLOSSARY.map((row) => (
								<div key={row.term} className='pres-gloss__row'>
									<dt>{row.term}</dt>
									<dd>{row.def}</dd>
								</div>
							))}
						</dl>
					</section>

					<section id='oneliners' className='pres-one' aria-labelledby='one-title'>
						<h2 id='one-title' className='pres-section-title'>
							<span className='pres-section-title__mark pres-section-title__mark--one' />
							Готовые тексты
						</h2>
						<div className='pres-one__grid'>
							<figure className='pres-one__card'>
								<figcaption>Кратко о сервисе (~20 секунд)</figcaption>
								<blockquote>{ONELINERS.pitch}</blockquote>
							</figure>
							<figure className='pres-one__card'>
								<figcaption>Пост в соцсети</figcaption>
								<blockquote>{ONELINERS.post}</blockquote>
							</figure>
							<figure className='pres-one__card'>
								<figcaption>Один слайд — одна мысль</figcaption>
								<blockquote>{ONELINERS.slide}</blockquote>
							</figure>
							<figure className='pres-one__card'>
								<figcaption>Призыв к действию</figcaption>
								<blockquote>{ONELINERS.cta}</blockquote>
							</figure>
						</div>
					</section>

					<footer className='pres-footer'>
						<p>
							<strong>ЧатРассылка</strong> — сервис массовых рассылок в групповые чаты WhatsApp и Telegram.
							Условия подключения, тарифы и оферта — на сайте. При изменении продукта актуализируйте
							цифры и формулировки вместе с командой.
						</p>
						<p className='pres-footer__links'>
							<Link href='/'>Главная</Link>
							<span aria-hidden> · </span>
							<Link href='/cabinet'>Личный кабинет</Link>
							<span aria-hidden> · </span>
							<Link href='/presentation'>Обновить страницу</Link>
						</p>
					</footer>
				</div>
			</div>

			<button
				type='button'
				className={`pres-mobile-toc ${tocOpen ? 'is-open' : ''}`}
				onClick={() => setTocOpen(!tocOpen)}
				aria-expanded={tocOpen}
				aria-controls='pres-mobile-toc-panel'
			>
				Слайд {SLIDES.findIndex((s) => s.id === activeId) + 1}/{SLIDES.length}
			</button>
			<div
				id='pres-mobile-toc-panel'
				className={`pres-mobile-panel ${tocOpen ? 'is-open' : ''}`}
				aria-hidden={!tocOpen}
				onClick={() => setTocOpen(false)}
				role='presentation'
			>
				<div
					className='pres-mobile-panel__inner'
					onClick={(e) => e.stopPropagation()}
					role='dialog'
					aria-label='Список слайдов'
				>
					<p className='pres-mobile-panel__title'>Разделы ({SLIDES.length})</p>
					<ul className='pres-mobile-panel__list'>
						{SLIDES.map((s, i) => (
							<li key={s.id}>
								<button type='button' onClick={() => scrollToSlide(s.id)}>
									<span>{String(i + 1).padStart(2, '0')}</span> {s.title}
								</button>
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	)
}
