'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import Cookies from 'js-cookie'
import { usePathname, useRouter } from 'next/navigation'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { ChannelIcon } from '@/components/ChannelIcon'
import { AppBurgerButton } from '@/components/AppBurgerButton'

const NAV_ITEMS: { path: string; label: string; icon?: 'wa' | 'tg' }[] = [
  { path: '/dashboard/campaigns', label: 'Рассылки' },
  { path: '/dashboard/templates', label: 'Шаблоны' },
  { path: '/dashboard/groups', label: 'WhatsApp', icon: 'wa' },
  { path: '/dashboard/groups/telegram', label: 'Telegram', icon: 'tg' },
]

function pluralRu(n: number, one: string, few: string, many: string) {
  const abs = Math.abs(n)
  const mod10 = abs % 10
  const mod100 = abs % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

export function DashboardHeader() {
  const pathname = usePathname()
  const router = useRouter()
  const loader = useGlobalLoader()
  const [menuOpen, setMenuOpen] = useState(false)

  const [waSelectedCount, setWaSelectedCount] = useState<number | null>(null)
  const [tgSelectedCount, setTgSelectedCount] = useState<number | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [waStatus, setWaStatus] = useState<string | null>(null)
  const [waRetryAttempt, setWaRetryAttempt] = useState<number | null>(null)
  const [waRetryMax, setWaRetryMax] = useState<number | null>(null)
  const [tgStatus, setTgStatus] = useState<string | null>(null)

  const groupCountsLabel = useMemo(() => {
    const waCountText = waSelectedCount == null ? '' : `${waSelectedCount}`
    const tgCountText = tgSelectedCount == null ? '' : `${tgSelectedCount}`
    const waSuffix =
      waSelectedCount == null
        ? ''
        : ` ${pluralRu(waSelectedCount, 'группа', 'группы', 'групп')}`
    const tgSuffix =
      tgSelectedCount == null
        ? ''
        : ` ${pluralRu(tgSelectedCount, 'группа', 'группы', 'групп')}`

    const waBase = waCountText ? `WhatsApp: ${waCountText}${waSuffix}` : 'WhatsApp'
    const tgBase = tgCountText ? `Telegram: ${tgCountText}${tgSuffix}` : 'Telegram'

    const waStatusText =
      waStatus === 'connected'
        ? 'online'
        : waStatus === 'temporary_network_issue'
          ? `reconnect ${waRetryAttempt ?? 0}/${waRetryMax ?? 0}`
          : waStatus === 'connecting' || waStatus === 'pending_qr'
            ? 'connecting'
            : waStatus === 'error'
              ? 'error'
              : waStatus
                ? 'offline'
                : '...'

    const tgStatusText =
      tgStatus === 'connected'
        ? 'online'
        : tgStatus === 'pending_qr' || tgStatus === 'awaiting_password'
          ? 'connecting'
          : tgStatus === 'error'
            ? 'error'
            : tgStatus
              ? 'offline'
              : '...'

    return {
      wa: `${waBase} · ${waStatusText}`,
      tg: `${tgBase} · ${tgStatusText}`,
    }
  }, [waSelectedCount, tgSelectedCount, waStatus, waRetryAttempt, waRetryMax, tgStatus])

  useEffect(() => {
    if (!pathname.startsWith('/dashboard')) return

    const safeJson = async (res: Response): Promise<any | null> => {
      try {
        if (!res.ok) return null
        return await res.json().catch(() => null)
      } catch {
        return null
      }
    }

    const run = async () => {
      const token = Cookies.get('token') || ''
      if (!token) return

      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '/api'
      setIsRefreshing(true)
      try {
        const meRes = await fetch(`${backendUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        const meJson: any = await meRes.json().catch(() => null)
        const userId = String(meJson?.user?.id || '')
        if (!userId) return

        const [waRes, tgRes, waStatusRes, tgStatusRes] = await Promise.all([
          fetch(`${backendUrl}/whatsapp/groups/${userId}/count`, {
            cache: 'no-store',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
          fetch(`${backendUrl}/telegram/groups/${userId}/count`, {
            cache: 'no-store',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
          fetch(`${backendUrl}/whatsapp/status/${userId}?_=${Date.now()}`, {
            cache: 'no-store',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
          fetch(`${backendUrl}/telegram/qr/status/${userId}?_=${Date.now()}`, {
            cache: 'no-store',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
        ])

        const waJson: any = await safeJson(waRes)
        const tgJson: any = await safeJson(tgRes)
        const waStatusJson: any = await safeJson(waStatusRes)
        const tgStatusJson: any = await safeJson(tgStatusRes)

        if (waJson?.success) setWaSelectedCount(Number(waJson?.selected || 0))
        if (tgJson?.success) setTgSelectedCount(Number(tgJson?.selected || 0))
        if (waStatusJson?.success) {
          const st = waStatusJson?.status
          setWaStatus(typeof st?.status === 'string' ? st.status : null)
          setWaRetryAttempt(typeof st?.retryAttempt === 'number' ? Number(st.retryAttempt) : null)
          setWaRetryMax(typeof st?.retryMax === 'number' ? Number(st.retryMax) : null)
        }
        if (tgStatusJson?.success) {
          setTgStatus(typeof tgStatusJson?.status === 'string' ? tgStatusJson.status : null)
        }
      } finally {
        setIsRefreshing(false)
      }
    }

    void run()
    const stable =
      (waStatus === 'connected' || waStatus == null) &&
      (tgStatus === 'connected' || tgStatus == null)
    const intervalMs = stable ? 30000 : 10000
    const timer = window.setInterval(run, intervalMs)
    return () => window.clearInterval(timer)
  }, [pathname, waStatus, tgStatus])

  const navLabel = (label: string, icon?: 'wa' | 'tg') => {
    if (icon === 'wa') return groupCountsLabel.wa
    if (icon === 'tg') return groupCountsLabel.tg
    return label
  }

  const navDotColor = (icon?: 'wa' | 'tg') => {
    if (icon === 'wa') {
      if (waStatus === 'connected') return '#16a34a'
      if (
        waStatus === 'temporary_network_issue' ||
        waStatus === 'connecting' ||
        waStatus === 'pending_qr'
      ) {
        return '#d97706'
      }
      if (waStatus === 'error') return '#dc2626'
      return '#9ca3af'
    }
    if (icon === 'tg') {
      if (tgStatus === 'connected') return '#16a34a'
      if (tgStatus === 'pending_qr' || tgStatus === 'awaiting_password') return '#d97706'
      if (tgStatus === 'error') return '#dc2626'
      return '#9ca3af'
    }
    return 'transparent'
  }

  const navLabelNode = (label: string, icon?: 'wa' | 'tg'): ReactNode => {
    const text = navLabel(label, icon)
    if (!icon) return text

    const parts = text.split(' · ')
    const base = parts[0] ?? text
    const status = parts[1] ?? ''

    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span>{base}</span>
        {status ? (
          <>
            <span>·</span>
            <span
              aria-hidden
              className={isRefreshing ? 'tpl-header__statusDot--refreshing' : undefined}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: navDotColor(icon),
                boxShadow: '0 0 0 1px rgba(0,0,0,0.08)',
                flex: '0 0 auto',
              }}
            />
            <span>{status}</span>
          </>
        ) : null}
      </span>
    )
  }

  const go = (path: string, label: string) => {
    setMenuOpen(false)
    loader.show(`Открываем ${label}…`)
    router.push(path)
  }

  const currentPageTitle = useMemo(() => {
    if (pathname === '/dashboard/templates') return 'Ваши шаблоны'
    if (pathname === '/dashboard/templates/new') return 'Создание шаблона'
    if (pathname.startsWith('/dashboard/templates/')) return 'Редактирование шаблона'
    if (pathname === '/dashboard/campaigns') return 'Рассылки'
    if (pathname === '/dashboard/campaigns/timing') return 'Сводка времени и интервалов'
    if (pathname === '/dashboard/campaign') return 'Прогресс рассылки'
    if (pathname === '/dashboard/groups') return 'Управление группами WhatsApp'
    if (pathname === '/dashboard/groups/telegram') return 'Управление группами Telegram'
    return 'Дашборд'
  }, [pathname])

  const isCampaignProgressPage = pathname === '/dashboard/campaign'
  const hideCampaignsNavItem = pathname === '/dashboard/campaigns' || isCampaignProgressPage
  const hideTemplatesNavItem = pathname === '/dashboard/templates'
  const navItems =
    hideCampaignsNavItem || hideTemplatesNavItem
      ? NAV_ITEMS.filter((item) => {
          if (hideCampaignsNavItem && item.path === '/dashboard/campaigns') return false
          if (hideTemplatesNavItem && item.path === '/dashboard/templates') return false
          return true
        })
      : NAV_ITEMS

  const createTemplateButton = (
    <button
      type="button"
      className="tpl-header__pill ui-action-btn ui-header-btn tpl-header__pill--primary"
      onClick={() => {
        setMenuOpen(false)
        loader.show('Открываем создание шаблона…')
        router.push('/dashboard/templates/new')
      }}
    >
      Создать шаблон
    </button>
  )

  return (
    <header className="tpl-header" role="banner">
      <div className="tpl-header__container">
        <div className="tpl-header__row">
          <div className="tpl-header__logoWrap">
            <div className="tpl-header__pageTitle">{currentPageTitle}</div>
            <Link href="/" className="tpl-header__logo" aria-label="ЧатРассылка — на главную">
              <Image
                src="/logo-heart.png"
                alt=""
                width={54}
                height={54}
                className="tpl-header__logo-icon"
                priority
              />
              <span className="tpl-header__logo-chat">Чат</span>
              <span className="tpl-header__logo-accent">Рассылка</span>
            </Link>
          </div>
          {!isCampaignProgressPage ? (
            <AppBurgerButton
              open={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="tpl-header__burger"
              ariaLabelOpen="Открыть меню"
              ariaLabelClose="Закрыть меню"
            />
          ) : null}
          <nav className="tpl-header__nav" aria-label="Навигация дашборда">
            <button
              type="button"
              className="tpl-header__pill ui-action-btn ui-header-btn"
              onClick={() => go('/cabinet', 'кабинет')}
              aria-label="Перейти в личный кабинет"
            >
              ← В кабинет
            </button>
            {pathname === '/dashboard/templates' ? createTemplateButton : null}
            {navItems.map(({ path, label, icon }) => {
              const isActive =
                path === '/dashboard/groups'
                  ? pathname === '/dashboard/groups'
                  : pathname === path ||
                    (path !== '/dashboard/campaigns' && pathname.startsWith(path + '/'))

              const computedLabel = navLabel(label, icon)

              return (
                <button
                  key={path}
                  type="button"
                  className={`tpl-header__pill ui-action-btn ui-header-btn${isActive ? ' tpl-header__pill--active' : ''}`}
                  onClick={() => go(path, label)}
                  aria-label={computedLabel}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {icon ? (
                    <span className="tpl-header__chanIcon" aria-hidden>
                      <ChannelIcon type={icon} size={24} aria-hidden />
                    </span>
                  ) : null}
                  {navLabelNode(label, icon)}
                </button>
              )
            })}
          </nav>
        </div>
      </div>
      <div className={`tpl-header__mobile-panel ${menuOpen ? 'tpl-header__mobile-panel--open' : ''}`}>
        <div className="tpl-header__mobile-backdrop" onClick={() => setMenuOpen(false)} aria-hidden />
        <div className="tpl-header__mobile-nav">
          <button
            type="button"
            className="tpl-header__pill ui-action-btn ui-header-btn"
            onClick={() => go('/cabinet', 'кабинет')}
          >
            ← В кабинет
          </button>
          {pathname === '/dashboard/templates' ? createTemplateButton : null}
          {navItems.map(({ path, label, icon }) => (
            <button
              key={path}
              type="button"
              className="tpl-header__pill ui-action-btn ui-header-btn"
              onClick={() => go(path, label)}
            >
              {icon ? (
                <span className="tpl-header__chanIcon" aria-hidden>
                  <ChannelIcon type={icon} size={24} />
                </span>
              ) : null}
              {navLabelNode(label, icon)}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
