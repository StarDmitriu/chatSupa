'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Cookies from 'js-cookie'
import {
	Form,
	Input,
	InputNumber,
	Switch,
	message,
	Upload,
	Table,
	Segmented,
	Select,
	Slider,
	TimePicker,
	Tag,
	Popover,
	Tooltip,
} from 'antd'
import type { UploadProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { UploadOutlined } from '@ant-design/icons'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { apiPost, getApiErrorMessage } from '@/lib/api'
import { useGlobalLoader } from '@/ui/loader/LoaderProvider'
import { SEND_INTERVAL_OPTIONS } from '@/constants/sendIntervals'
import { ChannelIcon } from '@/components/ChannelIcon'
import { MediaViewerModal } from '@/components/MediaViewerModal'
import './page.css'
import { TemplateRichEditor } from '@/components/TemplateRichEditor'
import { TIMING_HUB_CHANGED_EVENT } from '@/lib/timingHubEvents'
import {
	clampPausePairFromFormValues,
	clampTemplatePauseSecPair,
	TEMPLATE_FORM_DEFAULT_PAUSE,
} from '@/lib/templateBetweenGroupsRange'
import { pluralRuGroups } from '@/lib/pluralRu'
import Image from 'next/image'
import dayjs from 'dayjs'


const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || '/api'

const TEMPLATE_SAVE_TIMEOUT_MS = 90_000

function isVideoUrl(url: string | null) {
	if (!url) return false
	const clean = url.split('?')[0] || ''
	// webm не включаем: голосовые идут как .webm, показываем их как аудио
	return /\.(mp4|mov|m4v)$/i.test(clean)
}

function isAudioUrl(url: string | null) {
	if (!url) return false
	const clean = url.split('?')[0] || ''
	// .webm — часто голосовые; показываем как аудио (без окна видео)
	return /\.(mp3|ogg|wav|m4a|webm)$/i.test(clean)
}

function isHHMM(v: any) {
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim())
}

function normalizeParticipantsCount(value: unknown): number | null {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? n : null
}

type UiGroupRow = {
	jid: string
	title: string | null
	participants_count: number | null
	is_restricted?: boolean | null
	updated_at: string
	send_time?: string | null
	avatar_url?: string | null
}

function reasonDescription(reason: string): string {
	const r = String(reason || '').toUpperCase()
	if (r === 'CHANNEL_INVALID') return 'Группа недоступна по текущим данным Telegram. Часто помогает синхронизация.'
	if (r === 'CHAT_WRITE_FORBIDDEN') return 'Нет прав на отправку в эту группу или отправка ограничена.'
	if (r === 'USER_BANNED_IN_CHANNEL') return 'Ваш аккаунт ограничен в этой группе/канале.'
	if (r === 'CHANNEL_PRIVATE') return 'Группа/канал приватные и недоступны для отправки.'
	if (r === 'PEER_ID_INVALID') return 'Ссылка на группу устарела или неверна.'
	if (r === 'WA_NOT_CONNECTED' || r === 'ETIMEDOUT') return 'В момент отправки была проблема со связью WhatsApp.'
	return 'Сообщение не отправилось в эту группу. Проверьте доступ и состояние канала.'
}

/** Нормализует Telegram chat id: -100123 и 123 считаются одной группой, храним в виде -100... */
function normalizeTgChatId(jid: string): string {
	const s = String(jid).trim()
	if (s.startsWith('-100')) return s
	const num = parseInt(s, 10)
	if (!Number.isNaN(num) && num > 0 && num < 1e13) return '-100' + s
	return s
}

export default function TemplateCreatePage() {
	const router = useRouter()
	const [userId, setUserId] = useState('')
	const [saving, setSaving] = useState(false)
	const [uploading, setUploading] = useState(false)
	const [mediaViewerUrl, setMediaViewerUrl] = useState<string | null>(null)
	const [mediaUrl, setMediaUrl] = useState<string | null>(null)
	/** 'audio' = голосовое/аудио, 'video' = видео, 'image' = картинка; для превью без окна видео у аудио */
	const [mediaKind, setMediaKind] = useState<'audio' | 'video' | 'image' | null>(null)
	const [form] = Form.useForm()

	const tgDefaultSendTime = Form.useWatch('tg_default_send_time', form)
	const waPauseLo = Form.useWatch('wa_between_groups_sec_min', form)
	const waPauseHi = Form.useWatch('wa_between_groups_sec_max', form)
	const tgPauseLo = Form.useWatch('tg_between_groups_sec_min', form)
	const tgPauseHi = Form.useWatch('tg_between_groups_sec_max', form)

	// ✅ channel + groups
	const [channel, setChannel] = useState<'wa' | 'tg'>('tg')
	const [waGroups, setWaGroups] = useState<UiGroupRow[]>([])
	const [tgGroups, setTgGroups] = useState<UiGroupRow[]>([])

	// ✅ selections per channel
	const [waSelected, setWaSelected] = useState<string[]>([])
	const [tgSelected, setTgSelected] = useState<string[]>([])
	const [waConnected, setWaConnected] = useState<boolean | null>(null)
	const [tgConnected, setTgConnected] = useState<boolean | null>(null)
	const [savingTargets, setSavingTargets] = useState(false)
	const [textValue, setTextValue] = useState('')
	const [waAvatarMap, setWaAvatarMap] = useState<Record<string, string | null>>({})
	const [waAvatarLoading, setWaAvatarLoading] = useState<Record<string, boolean>>({})
	const [bulkInterval, setBulkInterval] = useState<string | null>(null)
	const [applyingBulkInterval, setApplyingBulkInterval] = useState(false)
	const [groupFilterQuery, setGroupFilterQuery] = useState('')

	// Override интервала TG на уровне (шаблон → группа)
	const [tgTargetOverrides, setTgTargetOverrides] = useState<Record<string, string | null>>({})

	const [loadingWaGroups, setLoadingWaGroups] = useState(false)
	const [loadingTgGroups, setLoadingTgGroups] = useState(false)
	const [tgTotalGroups, setTgTotalGroups] = useState(0)
	/** Строк в telegram_groups (пагинация); если больше tgTotalGroups — в БД есть дубли по tg_chat_id */
	const [tgTotalRows, setTgTotalRows] = useState(0)
	const [tgHasMore, setTgHasMore] = useState(false)
	const [waAnimatedCount, setWaAnimatedCount] = useState(0)
	const [tgAnimatedCount, setTgAnimatedCount] = useState(0)
	const waAnimationFrameRef = useRef<number | null>(null)
	const tgAnimationFrameRef = useRef<number | null>(null)
	/** Сводка из /telegram/groups/:id/count: всего чатов vs с рассылкой (как на странице «Группы TG») */
	const [tgDbStats, setTgDbStats] = useState<{ total: number; selected: number } | null>(null)

	const loader = useGlobalLoader()

	const token = typeof document !== 'undefined' ? (Cookies.get('token') || '') : ''

	const buildWaAvatarProxyUrl = (waGroupId: string): string | null => {
		if (!userId) return null
		const gid = String(waGroupId || '').trim()
		if (!gid) return null
		return `${BACKEND_URL}/whatsapp/group-avatar-content/${encodeURIComponent(userId)}?wa_group_id=${encodeURIComponent(gid)}`
	}

	const normalizeWaAvatarUrl = (waGroupId: string, rawUrl: string | null | undefined): string | null => {
		const trimmed = String(rawUrl || '').trim()
		if (!trimmed) return null
		if (/^https?:\/\/pps\.whatsapp\.net\//i.test(trimmed)) {
			return buildWaAvatarProxyUrl(waGroupId) || trimmed
		}
		return trimmed
	}

	const fetchMe = async () => {
		if (!token) {
			router.push('/auth/phone')
			return;		}

		try {
			const res = await fetch(`${BACKEND_URL}/auth/me`, {
				headers: { Authorization: `Bearer ${token}` },
				cache: 'no-store',
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) {
				Cookies.remove('token')
				router.push('/auth/phone')
				return;			}
			setUserId(String(json.user.id))
		} catch (e) {
			console.error(e)
			message.error('Не удалось получить пользователя')
		}
	}

	const fetchWaGroupAvatar = async (waGroupId: string): Promise<string | null> => {
		if (!userId) return null
		const gid = String(waGroupId || '').trim()
		if (!gid) return null

		try {
			const url = `${BACKEND_URL}/whatsapp/group-avatar/${userId}?wa_group_id=${encodeURIComponent(
				gid,
			)}`
			const res = await fetch(url, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const json: any = await res.json().catch(() => null)
			if (!json?.success) return null
			const u = String(json.url || '').trim()
			return u || null
		} catch {
			return null
		}
	}

	const ensureWaAvatar = async (waGroupId: string) => {
		const gid = String(waGroupId || '').trim()
		if (!gid) return
		if (waAvatarMap[gid] !== undefined) return
		if (waAvatarLoading[gid]) return

		setWaAvatarLoading(prev => ({ ...prev, [gid]: true }))
		const url = await fetchWaGroupAvatar(gid)
		setWaAvatarMap(prev => ({ ...prev, [gid]: url }))
		setWaAvatarLoading(prev => ({ ...prev, [gid]: false }))
	}

	const warmupWaAvatars = (rows: UiGroupRow[], limit = 18) => {
		const toLoad = rows
			.slice(0, limit)
			.map(row => String(row.jid || '').trim())
			.filter(Boolean)

		for (const jid of toLoad) {
			if (waAvatarMap[jid] === undefined && !waAvatarLoading[jid]) {
				void ensureWaAvatar(jid)
			}
		}
	}

	function animateWaCount(from: number, to: number) {
		if (waAnimationFrameRef.current !== null) cancelAnimationFrame(waAnimationFrameRef.current)
		if (from === to) {
			setWaAnimatedCount(to)
			return
		}
		const startTime = Date.now()
		const duration = Math.min(800, Math.abs(to - from) * 15)
		const startValue = from
		const animate = () => {
			const elapsed = Date.now() - startTime
			const progress = Math.min(elapsed / duration, 1)
			const eased = 1 - Math.pow(1 - progress, 3)
			const current = Math.floor(startValue + (to - startValue) * eased)
			setWaAnimatedCount(current)
			if (progress < 1) waAnimationFrameRef.current = requestAnimationFrame(animate)
			else {
				setWaAnimatedCount(to)
				waAnimationFrameRef.current = null
			}
		}
		waAnimationFrameRef.current = requestAnimationFrame(animate)
	}

	function animateTgCount(from: number, to: number) {
		if (tgAnimationFrameRef.current !== null) cancelAnimationFrame(tgAnimationFrameRef.current)
		if (from === to) {
			setTgAnimatedCount(to)
			return
		}
		const startTime = Date.now()
		const duration = Math.min(800, Math.abs(to - from) * 15)
		const startValue = from
		const animate = () => {
			const elapsed = Date.now() - startTime
			const progress = Math.min(elapsed / duration, 1)
			const eased = 1 - Math.pow(1 - progress, 3)
			const current = Math.floor(startValue + (to - startValue) * eased)
			setTgAnimatedCount(current)
			if (progress < 1) tgAnimationFrameRef.current = requestAnimationFrame(animate)
			else {
				setTgAnimatedCount(to)
				tgAnimationFrameRef.current = null
			}
		}
		tgAnimationFrameRef.current = requestAnimationFrame(animate)
	}

	const loadWaGroups = async (uid: string) => {
		setLoadingWaGroups(true)
		setWaAnimatedCount(0)
		try {
			const res = await fetch(`${BACKEND_URL}/whatsapp/groups/${uid}?selectedOnly=true`, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const raw = await res.json().catch(() => null)
			if (!raw) {
				message.error('Нет ответа от сервера при загрузке WA групп')
				setWaGroups([])
				return
			}
			if (!raw.success) {
				message.error(raw.message || 'Не удалось загрузить WA группы')
				setWaGroups([])
				return
			}

			// Бэкенд уже вернул только выбранные (selectedOnly=true). Исключаем только announcement.
			const usable = (raw.groups || []).filter((g: any) => !g.is_announcement)

			const mapped: UiGroupRow[] = usable.map((g: any) => ({
				jid: String(g.wa_group_id),
				title: g.subject ?? null,
				participants_count: normalizeParticipantsCount(g.participants_count),
				is_restricted: g.is_restricted ?? false,
				updated_at: g.updated_at,
				send_time: g.send_time ?? null,
				avatar_url: null,
			}))

			const unique = mapped.filter(
				(row, index, self) =>
					index === self.findIndex(g => g.jid === row.jid),
			)

			setWaGroups(unique)
			animateWaCount(0, unique.length)
			warmupWaAvatars(unique)
			if (unique.length === 0) {
				message.info('Нет выбранных WA групп. Выберите группы на странице «Управление группами» (WhatsApp).')
			}
		} catch (e) {
			console.error(e)
			message.error(
				getApiErrorMessage(
					e,
					'Не удалось загрузить WA группы. Проверьте подключение и обновите страницу.',
				),
			)
			setWaGroups([])
		} finally {
			setLoadingWaGroups(false)
		}
	}

	/** Один запрос из БД: все выбранные TG для шаблона (без порций и курсоров). */
	const loadTgGroups = async (uid: string) => {
		setLoadingTgGroups(true)
		setTgAnimatedCount(0)
		setTgTotalGroups(0)
		setTgTotalRows(0)
		setTgHasMore(false)
		try {
			const params = new URLSearchParams({
				selectedOnly: 'true',
				template: '1',
			})
			const res = await fetch(`${BACKEND_URL}/telegram/groups/${uid}?${params}`, {
				cache: 'no-store',
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
			const json: any = await res.json().catch(() => null)
			if (!res.ok) {
				message.error(
					`Не удалось загрузить TG группы (${res.status}). Повторите позже или обновите страницу.`,
				)
				setTgGroups([])
				setTgTotalGroups(0)
				setTgTotalRows(0)
				setTgHasMore(false)
				return
			}
			if (!json?.success) {
				message.error(json?.userMessage || 'Не удалось загрузить TG группы')
				setTgGroups([])
				setTgTotalGroups(0)
				setTgTotalRows(0)
				setTgHasMore(false)
				return
			}

			const mapped: UiGroupRow[] = (json.groups || []).map((g: any) => ({
				jid: normalizeTgChatId(String(g.tg_chat_id)),
				title: g.title ?? null,
				participants_count: g.participants_count ?? null,
				is_restricted: false,
				updated_at: g.updated_at,
				send_time: g.send_time ?? null,
				avatar_url: g.avatar_url ?? null,
			}))

			const unique = mapped.filter(
				(row, index, self) =>
					index === self.findIndex(g => g.jid === row.jid),
			)

			setTgGroups(unique)
			animateTgCount(0, unique.length)
			const chatTotal = Number(json.total || 0)
			setTgTotalGroups(chatTotal)
			setTgTotalRows(Number(json.totalRows ?? json.total ?? 0) || chatTotal)
			setTgHasMore(Boolean(json.hasMore))
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось загрузить TG группы'))
			setTgGroups([])
			setTgTotalGroups(0)
			setTgTotalRows(0)
			setTgHasMore(false)
		} finally {
			setLoadingTgGroups(false)
		}
	}

	useEffect(() => {
		loader.hide()
		fetchMe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// WA и TG группы загружаем при появлении userId. TG — одним запросом из БД (template=1), без фоновой догрузки порциями.
	useEffect(() => {
		if (!userId) return
		loadWaGroups(userId)
		loadTgGroups(userId)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId])


	useEffect(() => {
		if (!userId || !token) return
		let cancelled = false
		;(async () => {
			try {
				const res = await fetch(`${BACKEND_URL}/telegram/groups/${userId}/count`, {
					cache: 'no-store',
					headers: { Authorization: `Bearer ${token}` },
				})
				const data: { success?: boolean; total?: number; selected?: number } | null = await res
					.json()
					.catch(() => null)
				if (cancelled || !data?.success) return
				setTgDbStats({
					total: Number(data.total ?? 0),
					selected: Number(data.selected ?? 0),
				})
			} catch {
				/* ignore */
			}
		})()
		return () => {
			cancelled = true
		}
	}, [userId, token])

	useEffect(() => {
		if (channel !== 'wa' || waGroups.length === 0) return
		warmupWaAvatars(waGroups)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [channel, waGroups.length])

	// Статус подключения WA/TG для отображения «Подключить TG/WA» в выборе канала
	useEffect(() => {
		if (!userId || !token) return
		Promise.all([
			fetch(`${BACKEND_URL}/whatsapp/account-info/${userId}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
			fetch(`${BACKEND_URL}/telegram/qr/status/${userId}?_=${Date.now()}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
		]).then(([waData, tgData]) => {
			setWaConnected(waData?.success ? (waData.connected === true) : false)
			setTgConnected(
				tgData?.success && tgData?.status === 'connected',
			)
		}).catch(() => {})
	}, [userId, token])

	const uploadProps: UploadProps = useMemo(
		() => ({
			maxCount: 1,
			beforeUpload: async file => {
				if (!userId) {
					message.error('Нет userId')
					return Upload.LIST_IGNORE
				}

				setUploading(true)
				try {
					const fd = new FormData()
					fd.append('userId', userId)
					fd.append('file', file)

					const res = await fetch(`${BACKEND_URL}/templates/upload-media`, {
						method: 'POST',
						headers: {
							...(token ? { Authorization: `Bearer ${token}` } : {}),
						},
						body: fd,
					})

					const json: any = await res.json().catch(() => null)
					if (!json?.success) {
						message.error(
							`Ошибка загрузки файла: ${json?.message || 'unknown'}`
						)
						return Upload.LIST_IGNORE
					}

					const url = String(json.publicUrl || json.url || '')
					if (!url) {
						message.error('Не пришла ссылка на файл от сервера')
						return Upload.LIST_IGNORE
					}
					const type = (file.type || '').toLowerCase()
					setMediaKind(type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : 'image')
					setMediaUrl(url)
					message.success('Файл загружен')
				} catch (e) {
					console.error(e)
					message.error(getApiErrorMessage(e, 'Не удалось загрузить файл'))
				} finally {
					setUploading(false)
				}

				return Upload.LIST_IGNORE
			},
		}),
		[userId, token]
	)

	const groupColumns: ColumnsType<UiGroupRow> = useMemo(() => {
		const cols: ColumnsType<UiGroupRow> = [
			{
				title: 'Группа',
				key: 'group',
				render: (_: any, row: UiGroupRow) => {
					const nameForAvatar = (row.title || 'Группа').trim() || 'Группа'

					// Текущее состояние выбора для этой строки
					const selectedList = channel === 'wa' ? waSelected : tgSelected
					const checked = selectedList.includes(row.jid)

					// Для WA подгружаем аватар через API и кэш по jid
					let avatarUrl = row.avatar_url || null
					if (channel === 'wa') {
						avatarUrl = normalizeWaAvatarUrl(row.jid, avatarUrl)
						const hasCachedAvatar = Object.prototype.hasOwnProperty.call(waAvatarMap, row.jid)
						if (!hasCachedAvatar && !waAvatarLoading[row.jid]) {
							void ensureWaAvatar(row.jid)
						}
						avatarUrl = hasCachedAvatar ? waAvatarMap[row.jid] ?? null : avatarUrl
					}

					const toggleSelected = () => {
						const list = channel === 'wa' ? waSelected : tgSelected
						const isSelected = list.includes(row.jid)
						const next = isSelected
							? list.filter(k => k !== row.jid)
							: [...list, row.jid]
						if (channel === 'wa') setWaSelected(next)
						else setTgSelected(next)
					}

					return (
						<div className={channel === 'wa' ? 'tedit-group-row-inner tedit-group-row-inner--wa' : 'tedit-group-row-inner'}>
							<div className="tedit-group-row-main">
								<div
									className={`tedit-custom-checkbox ${checked ? 'checked' : ''}`}
									role="button"
									tabIndex={0}
									title={checked ? 'Снять выделение' : 'Выбрать группу'}
									onClick={(e) => {
										e.stopPropagation()
										toggleSelected()
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											e.stopPropagation()
											toggleSelected()
										}
									}}
								>
									{checked && (
										<svg className="tedit-check-icon" viewBox="0 0 20 20" fill="none">
											<path
												d="M16.7071 5.29289C17.0976 5.68342 17.0976 6.31658 16.7071 6.70711L8.70711 14.7071C8.31658 15.0976 7.68342 15.0976 7.29289 14.7071L3.29289 10.7071C2.90237 10.3166 2.90237 9.68342 3.29289 9.29289C3.68342 8.90237 4.31658 8.90237 4.70711 9.29289L8 12.5858L15.2929 5.29289C15.6834 4.90237 16.3166 4.90237 16.7071 5.29289Z"
												fill="currentColor"
											/>
										</svg>
									)}
								</div>

								{avatarUrl ? (
									<div className="tedit-group-avatar-wrap">
										<img
											src={avatarUrl}
											alt=""
											className="tedit-group-avatar"
											onError={() => setWaAvatarMap(prev => ({ ...prev, [row.jid]: null }))}
										/>
									</div>
								) : (
									<div className="tedit-group-avatar tedit-group-avatar--placeholder">
										{nameForAvatar.slice(0, 1).toUpperCase()}
									</div>
								)}
								<div className="tedit-group-row-info">
									<span className="tedit-group-row-title">
										{row.title || 'без названия'}
									</span>
								</div>
							</div>
							{channel === 'tg' && (
								<div className="tedit-group-row-interval" onClick={(e) => e.stopPropagation()}>
									{(() => {
										const ov = tgTargetOverrides[row.jid] ?? null
										const tplDef = tgDefaultSendTime
										const eff = ov ?? (tplDef ? String(tplDef) : null) ?? (row.send_time ?? null)
										const title = eff ? `Эффективно: ${eff}` : 'Эффективно: авто'
										return (
											<Select
												allowClear
												placeholder="По умолчанию"
												size="small"
												className="tedit-group-interval-select"
												value={tgTargetOverrides[row.jid] ?? undefined}
												options={SEND_INTERVAL_OPTIONS}
												disabled={!checked}
												title={title}
												onChange={v => setTgTargetOverride(row.jid, v ?? null)}
											/>
										)
									})()}
								</div>
							)}
							{channel === 'wa' && (
								<span
									className="tedit-group-row-count"
									title="Количество участников в группе"
								>
									{typeof row.participants_count === 'number'
										? `Участников: ${row.participants_count}`
										: 'Участников: —'}
								</span>
							)}
						</div>
					)
				},
			},
		]

		return cols
	}, [channel, waAvatarMap, waAvatarLoading, waSelected, tgSelected, tgTargetOverrides, tgDefaultSendTime])

	const currentGroups = channel === 'wa' ? waGroups : tgGroups
	const currentSelected = channel === 'wa' ? waSelected : tgSelected
	const currentGroupsLoading = channel === 'wa' ? loadingWaGroups : loadingTgGroups
	// Фильтр по названию или ID, затем выбранные наверх
	const currentGroupsSorted = useMemo(() => {
		const q = groupFilterQuery.trim().toLowerCase()
		const filtered = q
			? currentGroups.filter(
					(g) =>
						(g.title ?? '').toLowerCase().includes(q) ||
						String(g.jid ?? '').toLowerCase().includes(q),
				)
			: [...currentGroups]
		return filtered.sort((a, b) => {
			const aIn = currentSelected.includes(a.jid)
			const bIn = currentSelected.includes(b.jid)
			if (aIn && !bIn) return -1
			if (!aIn && bIn) return 1
			return 0
		})
	}, [currentGroups, currentSelected, groupFilterQuery])
	const setCurrentSelected = (keys: string[]) => {
		if (channel === 'wa') setWaSelected(keys)
		else setTgSelected(keys)
	}

	function setTgTargetOverride(jid: string, next: string | null) {
		setTgTargetOverrides(prev => ({ ...prev, [jid]: next }))
	}

	const saveTargetsForTemplate = async (templateId: string) => {
		setSavingTargets(true)
		try {
			// ✅ сохраняем targets отдельно по каналам
			const tasks: Array<{ ch: 'wa' | 'tg'; keys: string[] }> = [
				{ ch: 'wa', keys: waSelected },
				// TG: на всякий случай нормализуем id перед сохранением
				{ ch: 'tg', keys: tgSelected.map(normalizeTgChatId) },
			]

			for (const t of tasks) {
				const overrides =
					t.ch === 'wa'
						? ({} as Record<string, string | null>)
						: t.keys.reduce((acc, jid) => {
								acc[jid] = tgTargetOverrides[jid] ?? null
								return acc
							}, {} as Record<string, string | null>)

				// eslint-disable-next-line no-await-in-loop
				const json: any = await apiPost(
					'/templates/targets/set',
					{
						userId,
						templateId,
						groupJids: t.keys,
						channel: t.ch,
						overrides,
					},
					{ timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS },
				)

				if (!json?.success) {
					message.error(
						`Ошибка сохранения групп (${t.ch.toUpperCase()}): ${
							json?.message || 'unknown'
						}`
					)
					return false
				}
			}

			return true
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось сохранить группы для шаблона'))
			return false
		} finally {
			setSavingTargets(false)
		}
	}

	const onFinish = async (values: any) => {
		if (!userId) return message.error('Нет userId')

		setSaving(true)
		loader.show('Сохраняем шаблон…')
		try {
			const merged = { ...form.getFieldsValue(true), ...values }
			const [wLo, wHi] = clampPausePairFromFormValues(
				'wa',
				merged.wa_between_groups_sec_min,
				merged.wa_between_groups_sec_max,
			)
			const [tLo, tHi] = clampPausePairFromFormValues(
				'tg',
				merged.tg_between_groups_sec_min,
				merged.tg_between_groups_sec_max,
			)
			const payload = {
				title: values.title,
				text: values.text,
				media_url: mediaUrl ?? undefined,
				enabled: values.enabled ?? true,
				order: values.order ?? 1,
				send_media_as_file: values.send_media_as_file === true,
				wa_speed_factor: 100,
				tg_speed_factor: 100,
				wa_between_groups_sec_min: wLo,
				wa_between_groups_sec_max: wHi,
				tg_between_groups_sec_min: tLo,
				tg_between_groups_sec_max: tHi,
				tg_default_send_time: values.tg_default_send_time || undefined,
			}

			const json: any = await apiPost('/templates/create', payload, {
				timeoutMs: TEMPLATE_SAVE_TIMEOUT_MS,
			})
			if (!json?.success) {
				message.error(`Ошибка создания: ${json?.message || 'unknown'}`)
				return
			}
			if (json?.persistenceDegraded) {
				message.warning(
					'В Supabase нет колонок пауз для шаблонов — ползунки не сохранились. Выполните SQL: backend/migrations/add_message_templates_between_groups_sec_range.sql',
				)
			}

			const templateId = String(json.templateId || '')
			if (!templateId) {
				message.error('templateId не пришёл')
				return
			}

			// ✅ сразу сохраняем выбранные группы (и WA и TG)
			const ok = await saveTargetsForTemplate(templateId)
			if (!ok) return

			const parts: string[] = []
			parts.push('паузы между группами заданы диапазоном в шаблоне')
			if (values.tg_default_send_time != null) {
				parts.push('в drawer обновится предупреждение про интервал TG (дефолт из шаблона)')
			}
			message.success(
				parts.length
					? `Шаблон создан и группы сохранены (WA/TG) — ${parts.join(' и ')}.`
					: 'Шаблон создан и группы сохранены (WA/TG)',
			)
			if (typeof window !== 'undefined') window.dispatchEvent(new Event(TIMING_HUB_CHANGED_EVENT))
			router.push(`/dashboard/templates/`)
		} catch (e) {
			console.error(e)
			message.error(getApiErrorMessage(e, 'Не удалось создать шаблон'))
		} finally {
			setSaving(false)
			loader.hide()
		}
	}

	return (
		<div className='tedit'>
			<div className='tedit__wrap'>
				<p className='tedit__intro'>
					Заполните название и текст, выберите группы (вкладки WA/TG). Группы сохранятся автоматически при создании шаблона.
				</p>

				<div className='tedit__card'>
				<Form
					className='tedit__form'
					form={form}
					layout='vertical'
					initialValues={{
						enabled: true,
						order: 1,
						send_media_as_file: false,
						wa_speed_factor: 100,
						tg_speed_factor: 100,
						wa_between_groups_sec_min: TEMPLATE_FORM_DEFAULT_PAUSE.wa[0],
						wa_between_groups_sec_max: TEMPLATE_FORM_DEFAULT_PAUSE.wa[1],
						tg_between_groups_sec_min: TEMPLATE_FORM_DEFAULT_PAUSE.tg[0],
						tg_between_groups_sec_max: TEMPLATE_FORM_DEFAULT_PAUSE.tg[1],
						tg_default_send_time: null,
					}}
					onFinish={onFinish}
				>
					{/* Название */}
					<div className="tedit-cont">
						<div className='tedit-cont-one'>
							<div className='tedit-field'>
								<div className='tedit-field__label'>Название шаблона</div>
								<Form.Item name='title' style={{ marginBottom: 0 }}>
									<Input
										className='tedit-input'
										placeholder=''
										variant='borderless'
									/>
								</Form.Item>
								<div className='tedit-field__hint'>
									Например: Описание квартиры, Акция, Подбор объектов
								</div>
							</div>
							{/* Текст */}
							<div className='tedit-field'>
								<div className='tedit-field__label'>Текст сообщения</div>
								<Form.Item
									name='text'
									style={{ marginBottom: 0 }}
									rules={[
										{
											validator: async (_, value) => {
												const title = form.getFieldValue('title')
												const text = String(value || '').trim()
												if (!String(title || '').trim() && !text) {
													return Promise.reject(
														new Error('Нужно заполнить title или text'),
													)
												}
												return Promise.resolve()
											},
										},
									]}
								>
									<TemplateRichEditor
										value={textValue}
										onChange={next => {
											setTextValue(next)
											form.setFieldsValue({ text: next })
										}}
									/>
								</Form.Item>
								<div className='tedit-field__hint'>
									Поддерживается форматирование и эмодзи.
								</div>
							</div>
							{/* Загрузка */}
							<div className='tedit-upload'>
								<div className='tedit-upload__label'>Прикрепите изображение</div>

								<div className='tedit-upload__row'>
									<div className='tedit-upload__drop'>
										<Upload.Dragger
											{...uploadProps}
											showUploadList={false}
											disabled={!userId || uploading}
										>
											<div className='tedit-upload__btn'>
												<span className='tedit-upload__icon'>
													<Image
														src='/iconFoto.png'
														alt='Картинка'
														width={19}
														height={19}
													/>
												</span>
												<span>
													Перетащите файл сюда
													<br />
													или нажмите, чтобы выбрать
												</span>
											</div>
										</Upload.Dragger>
									</div>

									<div className='tedit-upload__note'>
										<div className='tedit-upload__noteTitle'>Внимание!</div>
										<div className='tedit-upload__noteText'>
											Можно добавить только 1 файл (изображение)
											<br />
											Советуем сделать коллаж из фото
										</div>

										{mediaUrl ? (
											<div className='tedit-upload__current'>
												<button
													type='button'
													className='tedit-upload__previewBtn'
													onClick={() => setMediaViewerUrl(mediaUrl)}
													title='Открыть в полном размере / запустить'
												>
													<div className='tedit-upload__preview'>
														{mediaKind === 'audio' || (!mediaKind && isAudioUrl(mediaUrl)) ? (
															<audio
																src={mediaUrl}
																className='tedit-upload__previewAudio'
																controls
																onClick={e => e.stopPropagation()}
															/>
														) : mediaKind === 'video' || (!mediaKind && isVideoUrl(mediaUrl)) ? (
															<video
																src={mediaUrl}
																className='tedit-upload__previewMedia'
																controls
																onClick={e => e.stopPropagation()}
															/>
														) : (
															<img
																src={mediaUrl}
																className='tedit-upload__previewImg'
																alt='Превью файла'
															/>
														)}
													</div>
												</button>
												<div className='tedit-upload__previewHint'>Нажмите на превью для полного просмотра или запуска</div>
												<button
													type='button'
													className='tedit-linkbtn'
													onClick={() => { setMediaUrl(null); setMediaKind(null) }}
												>
													Убрать
												</button>
											</div>
										) : null}
									</div>
								</div>
							</div>
						{/* Включение + порядок (рядом) */}
							<div className='tedit-mini'>
								<div className='tedit-mini__item'>
									<div>
										<div className='tedit-mini__label'>Включён</div>
										<div className='tedit-mini__hint'>Если выключить — этот шаблон не будет участвовать в рассылках.</div>
									</div>
									<Form.Item name='enabled' valuePropName='checked' style={{ marginBottom: 0 }}>
										<Switch />
									</Form.Item>
								</div>

								<div className='tedit-mini__item' style={{ display: 'none' }}>
									<div>
										<div className='tedit-mini__label'>Порядок отправки</div>
										<div className='tedit-mini__hint'>Чем меньше число, тем раньше отправляется этот шаблон (1 — самый первый).</div>
									</div>
									<Form.Item name='order' style={{ marginBottom: 0 }}>
										<InputNumber min={1} />
									</Form.Item>
								</div>
							</div>

							{/* Медиа как файл (сразу под загрузчиком) */}
							<div className='tedit-mini'>
								<div className='tedit-mini__item'>
									<div>
										<div className='tedit-mini__label'>Отправлять медиа как файл</div>
										<div className='tedit-mini__hint'>Включено — медиа придёт как документ. Выключено — показывается прямо в чате (превью/плеер).</div>
									</div>
									<Form.Item name='send_media_as_file' valuePropName='checked' style={{ marginBottom: 0 }}>
										<Switch />
									</Form.Item>
								</div>
							</div>

							<div className='tedit-mini'>
								<Form.Item name='wa_speed_factor' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='tg_speed_factor' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='wa_between_groups_sec_min' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='wa_between_groups_sec_max' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='tg_between_groups_sec_min' hidden>
									<input type='hidden' />
								</Form.Item>
								<Form.Item name='tg_between_groups_sec_max' hidden>
									<input type='hidden' />
								</Form.Item>
								<div className='tedit-mini__item tedit-mini__item--pauseBlock'>
									<div className='tedit-pauseBetweenGroups__head'>
										<div>
											<div className='tedit-mini__label'>
												<ChannelIcon type='wa' size={14} /> Пауза между группами WhatsApp (этот шаблон)
											</div>
											<div className='tedit-mini__hint'>
												Здесь вы задаёте для шаблона минимум и максимум секунд паузы между группами в волне WhatsApp: при рассылке берётся{' '}
												<b>случайное</b> число секунд между выбранными «от» и «до». Ползунки настраиваются в пределах 5–600 с.
											</div>
										</div>
										<Tag className='tedit-pauseBetweenGroups__tag'>
											{(() => {
												const [lo, hi] = clampTemplatePauseSecPair(
													Number(waPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[0]),
													Number(waPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[1]),
												)
												return `${lo}–${hi} с`
											})()}
										</Tag>
									</div>
									<Slider
										range
										className='tedit-speed-slider'
										min={5}
										max={600}
										step={5}
										tooltip={{ formatter: (v) => `${v} сек` }}
										value={clampTemplatePauseSecPair(
											Number(waPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[0]),
											Number(waPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.wa[1]),
										)}
										onChange={(v) => {
											const [x, y] = v as [number, number]
											const [lo, hi] = clampTemplatePauseSecPair(x, y)
											form.setFieldsValue({
												wa_between_groups_sec_min: lo,
												wa_between_groups_sec_max: hi,
												wa_speed_factor: 100,
											})
										}}
									/>
								</div>

								<div className='tedit-mini__item tedit-mini__item--pauseBlock'>
									<div className='tedit-pauseBetweenGroups__head'>
										<div>
											<div className='tedit-mini__label'>
												<ChannelIcon type='tg' size={14} /> Пауза между группами Telegram (этот шаблон)
											</div>
											<div className='tedit-mini__hint'>
												То же для Telegram: ползунки задают диапазон секунд между группами (случайная пауза внутри «от»–«до»). Ползунки: 5–600 с.
											</div>
										</div>
										<Tag className='tedit-pauseBetweenGroups__tag'>
											{(() => {
												const [lo, hi] = clampTemplatePauseSecPair(
													Number(tgPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[0]),
													Number(tgPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[1]),
												)
												return `${lo}–${hi} с`
											})()}
										</Tag>
									</div>
									<Slider
										range
										className='tedit-speed-slider'
										min={5}
										max={600}
										step={5}
										tooltip={{ formatter: (v) => `${v} сек` }}
										value={clampTemplatePauseSecPair(
											Number(tgPauseLo ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[0]),
											Number(tgPauseHi ?? TEMPLATE_FORM_DEFAULT_PAUSE.tg[1]),
										)}
										onChange={(v) => {
											const [x, y] = v as [number, number]
											const [lo, hi] = clampTemplatePauseSecPair(x, y)
											form.setFieldsValue({
												tg_between_groups_sec_min: lo,
												tg_between_groups_sec_max: hi,
												tg_speed_factor: 100,
											})
										}}
									/>
								</div>

								<div className='tedit-mini__item'>
									<div>
										<div className='tedit-mini__label'>Дефолтный интервал Telegram</div>
										<div className='tedit-mini__hint'>Если у TG-группы не задан свой интервал (override), используется этот интервал шаблона. Если override задан — он важнее.</div>
									</div>
									<Form.Item name='tg_default_send_time' style={{ marginBottom: 0 }}>
										<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
											<Select
												allowClear
												placeholder='Интервал'
												size='small'
												style={{ width: 170 }}
												options={SEND_INTERVAL_OPTIONS}
												value={isHHMM(tgDefaultSendTime) ? undefined : (tgDefaultSendTime ?? undefined)}
												onChange={(v) => form.setFieldValue('tg_default_send_time', v ?? null)}
											/>
											<TimePicker
												allowClear
												format='HH:mm'
												minuteStep={1}
												size='small'
												style={{ width: 110 }}
												placeholder='HH:mm'
												value={isHHMM(tgDefaultSendTime) ? dayjs(String(tgDefaultSendTime), 'HH:mm') : null}
												onChange={(v) => form.setFieldValue('tg_default_send_time', v ? v.format('HH:mm') : null)}
											/>
										</div>
									</Form.Item>
								</div>
							</div>
						</div>
						{/* Группы */}
						<div className='tedit-targets'>
							<div className='tedit-targets__head'>
								<div className='tedit-targets__title'>
									Куда отправлять этот шаблон
								</div>

								<Segmented
									value={channel}
									onChange={v => setChannel(v as any)}
									size='large'
									options={[
										{
											label: (
												<span className='tedit-channelTab'>
													<span className='tedit-channelTab__icon tedit-channelTab__icon--tg'>
														<ChannelIcon type='tg' size={16} variant={tgConnected === false ? 'failed' : 'default'} />
													</span>
													<span className='tedit-channelTab__text'>
														{tgConnected === false
															? 'Подключить TG'
															: `Telegram${loadingTgGroups ? ' · загрузка' : ''}`}
													</span>
													{tgConnected !== false && (
														<span className='tedit-channelTab__meta'>
															{loadingTgGroups ? (
																<span className='tedit-channelTab__load' aria-hidden='true' />
															) : null}
															<span>
																{loadingTgGroups
																	? `${tgAnimatedCount}/${tgTotalGroups > 0 ? tgTotalGroups : '…'}`
																	: `${tgGroups.length}`}
															</span>
														</span>
													)}
												</span>
											),
											value: 'tg',
										},
										{
											label: (
												<span className='tedit-channelTab'>
													<span className='tedit-channelTab__icon tedit-channelTab__icon--wa'>
														<ChannelIcon type='wa' size={16} variant={waConnected === false ? 'failed' : 'default'} />
													</span>
													<span className='tedit-channelTab__text'>
														{waConnected === false
															? 'Подключить WA'
															: `WhatsApp${loadingWaGroups ? ' · загрузка' : ''}`}
													</span>
													{waConnected !== false && (
														<span className='tedit-channelTab__meta'>
															{loadingWaGroups ? (
																<span className='tedit-channelTab__load' aria-hidden='true' />
															) : null}
															<span>{loadingWaGroups ? '…' : `${waGroups.length}`}</span>
														</span>
													)}
												</span>
											),
											value: 'wa',
										},
									]}
								/>
								<div className='tedit-targets__counts'>
									<div className='tedit-targets__countBlock'>
										<span className='tedit-targets__countItem'>
											<ChannelIcon type='tg' size={14} />
											<span>
												TG: для шаблона <b>{tgSelected.length}</b>
												{' · '}
												в таблице <b>{tgGroups.length}</b> {pluralRuGroups(tgGroups.length)}
											</span>
										</span>
										{!tgHasMore && tgTotalRows > tgTotalGroups ? (
											<div className='tedit-targets__countHint'>
												В базе для выбранных групп TG записано <b>{tgTotalRows}</b> строк, а разных
												чатов <b>{tgTotalGroups}</b> — лишние строки дублируют один и тот же чат
												(обычно после повторных синков). Готовая чистка: файл{' '}
												<b>backend/migrations/fix_duplicate_groups.sql</b> (п. 3–4 и уникальный индекс
												для TG).
											</div>
										) : null}
									</div>
									<span className='tedit-targets__countItem'>
										<ChannelIcon type='wa' size={14} />
										<span>
											WA: для шаблона <b>{waSelected.length}</b>
											{' · '}
											в таблице <b>{waGroups.length}</b> {pluralRuGroups(waGroups.length)}
										</span>
									</span>
									<p className='tedit-targets__legend'>
										«Для шаблона» — чаты, отмеченные для этого шаблона в таблице ниже (пока не
										отметили — 0). «В таблице» — группы с включённой рассылкой из «Группы TG / WA»;
										TG подгружается из базы одним запросом при открытии страницы.
									</p>
								</div>
							</div>

							{channel === 'wa' && waConnected !== false && (
								<div
									className='tedit-targets__meta'
									style={{ '--channel-color': '#25D366' } as React.CSSProperties}
								>
									{loadingWaGroups ? (
										<span className='tedit-targets__meta-loading'>
											<span className='tedit-spinner' />
											Загружаем WhatsApp-группы…
										</span>
									) : (
										<span className='tedit-targets__meta-idle'>
											В списке <b>{waGroups.length}</b> {pluralRuGroups(waGroups.length)}
										</span>
									)}
								</div>
							)}
							{channel === 'tg' && tgConnected !== false && (
								<div
									className='tedit-targets__meta'
									style={{ '--channel-color': '#29A9EB' } as React.CSSProperties}
								>
									{loadingTgGroups ? (
										<span className='tedit-targets__meta-loading'>
											<span className='tedit-spinner' />
											{tgTotalGroups > 0
												? `Загружаем чаты: ${tgAnimatedCount} из ${tgTotalGroups}${
														tgTotalRows > tgTotalGroups
															? ` (в БД ${tgTotalRows} строк — есть дубли по чату)`
															: ''
													}…`
												: 'Загружаем Telegram-группы…'}
										</span>
									) : (
										<>
											<span className='tedit-targets__meta-idle'>
												В списке <b>{tgGroups.length}</b> {pluralRuGroups(tgGroups.length)}
												{tgDbStats && tgDbStats.total > 0 && (
													<>
														{' '}
														· в «
														<Link href='/dashboard/groups/telegram' className='tedit-link'>
															Группы TG
														</Link>
														»: всего <b>{tgDbStats.total}</b>, с рассылкой{' '}
														<b>{tgDbStats.selected}</b>
													</>
												)}
											</span>
											{tgDbStats &&
												tgDbStats.selected < tgDbStats.total &&
												!loadingTgGroups && (
													<div className='tedit-targets__meta-hint'>
														С рассылкой сейчас только <b>{tgDbStats.selected}</b> из{' '}
														<b>{tgDbStats.total}</b> групп. Остальные здесь не появятся, пока не
														включите их в «Группы TG».
													</div>
												)}
											{tgDbStats &&
												tgDbStats.selected > 0 &&
												!tgHasMore &&
												!loadingTgGroups &&
												tgGroups.length < tgDbStats.selected && (
													<div className='tedit-targets__meta-hint tedit-targets__meta-hint--warn'>
														В таблице <b>{tgGroups.length}</b>, а с рассылкой в базе{' '}
														<b>{tgDbStats.selected}</b> — проверьте ответ API или обновите страницу.
													</div>
												)}
										</>
									)}
								</div>
							)}

							<div className='tedit-warning-placeholder'>
								{channel === 'tg' && tgConnected === false && (
									<div className='tedit-warning-message tedit-warning-message--connect'>
										<ChannelIcon type='tg' size={20} variant='failed' />{' '}
										Telegram не подключён. Подключите в кабинете, чтобы выбирать группы.{' '}
										<button
											type='button'
											className='tedit-link'
											onClick={() => { loader.show('В кабинет…'); router.push('/cabinet#telegram') }}
										>
											Подключить TG
										</button>
									</div>
								)}
								{channel === 'wa' && waConnected === false && (
									<div className='tedit-warning-message tedit-warning-message--connect'>
										<ChannelIcon type='wa' size={20} variant='failed' />{' '}
										WhatsApp не подключён. Подключите в кабинете, чтобы выбирать группы.{' '}
										<button
											type='button'
											className='tedit-link'
											onClick={() => { loader.show('В кабинет…'); router.push('/cabinet#whatsapp') }}
										>
											Подключить WA
										</button>
									</div>
								)}
								{channel === 'wa' && waConnected !== false && !loadingWaGroups && waGroups.length === 0 && (
									<div className='tedit-warning-message tedit-warning-message--empty'>
										Нет выбранных WhatsApp групп. Выберите группы на странице{' '}
										<Link href='/dashboard/groups' className='tedit-link'>Управление группами</Link> (вкладка WhatsApp), затем возвращайтесь сюда.
									</div>
								)}
							</div>

							<div className='tedit-targets__buttons'>
								<button
									type='button'
									className='tedit-pill'
									onClick={() =>
										setCurrentSelected(currentGroups.map(g => g.jid))
									}
									disabled={
										!currentGroups.length ||
										(channel === 'tg' && loadingTgGroups)
									}
								>
									Выбрать все
								</button>

								<button
									type='button'
									className='tedit-pill'
									onClick={() => setCurrentSelected([])}
									disabled={!currentSelected.length}
								>
									Снять все
								</button>

								{channel === 'tg' && currentSelected.length > 0 && (
									<div className='tedit-targets__bulk-interval'>
										<Select
											placeholder='Интервал для всех'
											allowClear
											className='tedit-bulk-interval-select'
											value={bulkInterval ?? undefined}
											onChange={v => setBulkInterval(v ?? null)}
											options={SEND_INTERVAL_OPTIONS}
											style={{ minWidth: 160 }}
										/>
										<button
											type='button'
											className='tedit-pill tedit-pill--primary'
											disabled={!bulkInterval || applyingBulkInterval}
											onClick={() => {
												if (!bulkInterval || !currentSelected.length) return
												setApplyingBulkInterval(true)
												setTgTargetOverrides(prev => {
													const next = { ...prev }
													for (const jid of currentSelected) next[jid] = bulkInterval
													return next
												})
												setApplyingBulkInterval(false)
												message.success(`Интервал применён к ${currentSelected.length} группам (сохранится при создании шаблона)`)
											}}
										>
											{applyingBulkInterval ? 'Применяем…' : 'Применить ко всем'}
										</button>
									</div>
								)}
							</div>

							<div className='tedit-targets__filter'>
								<Input
									placeholder='Фильтр по названию или ID группы'
									value={groupFilterQuery}
									onChange={(e) => setGroupFilterQuery(e.target.value)}
									allowClear
									className='tedit-filter-input'
								/>
							</div>

							<div className='tedit-table-panel'>
								<div className='tedit-scroll-container'>
									<div className='tedit-table'>
										<Table
											rowKey='jid'
											columns={groupColumns}
											dataSource={currentGroupsSorted}
											pagination={false}
											size='small'
											loading={currentGroupsLoading}
											onRow={record => ({
												onClick: (e: any) => {
													// Не переключаем выбор, если клик был на Select или кастомном чекбоксе
													if (e?.target?.closest?.('.ant-select') || e?.target?.closest?.('.tedit-custom-checkbox')) return
													const jid = record.jid
													const isSelected = currentSelected.includes(jid)
													const next = isSelected
														? currentSelected.filter(k => k !== jid)
														: [...currentSelected, jid]
													setCurrentSelected(next)
												},
												className: currentSelected.includes(record.jid)
													? 'tedit-table-row rowSelected'
													: 'tedit-table-row',
											})}
										/>
									</div>
								</div>
							</div>

							<div className='tedit-targets__hint'>
								Выбор сохранится автоматически при создании шаблона.
							</div>
						</div>
					</div>
					
					{/* Кнопки */}
					<div className='tedit-actions'>
						<button
							className='tedit-btn tedit-btn--primary'
							type='submit'
							disabled={saving || uploading || savingTargets}
						>
							{saving ? 'Сохраняем…' : 'Сохранить шаблон'}
						</button>

						<button
							className='tedit-btn'
							type='button'
							onClick={() => {
								loader.show('К списку шаблонов…')
								router.push('/dashboard/templates')
							}}
							disabled={saving}
						>
							Назад
						</button>
					</div>
				</Form>
				</div>
			</div>
			<MediaViewerModal
				open={!!mediaViewerUrl}
				url={mediaViewerUrl}
				onClose={() => setMediaViewerUrl(null)}
			/>
		</div>
	)

}
