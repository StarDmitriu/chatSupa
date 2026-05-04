'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Button, Collapse, Input, message, Space } from 'antd'
import { apiDownload, apiPost, apiPostForm } from '@/lib/api'
import './TemplatesSheetCard.css'

/** Порядок колонок для первой строки таблицы (совпадает с бэкендом) */
const CSV_HEADERS_ROW =
	'enabled,order,title,text,media_url,send_media_as_file,wa_speed_factor,tg_speed_factor,wa_default_send_time,tg_default_send_time'

/** Описание полей для подсказки пользователю (включая картинки и все настройки) */
const FIELD_DESCRIPTIONS: Record<string, string> = {
	enabled: 'Включён ли шаблон: true или false',
	order: 'Порядок (число), например 1, 2, 3',
	title: 'Название шаблона',
	text: 'Текст сообщения (можно с переносами строк)',
	media_url: 'Ссылка на картинку или видео (URL). Оставьте пусто, если без медиа',
	send_media_as_file: 'В Telegram: отправлять как файл (true) или как фото/видео (false)',
	wa_speed_factor: 'Скорость WA: 10–400 (100 = норма), меньше — реже сообщения',
	tg_speed_factor: 'Скорость TG: 10–400 (100 = норма)',
	wa_default_send_time: 'Дефолтный интервал/время для WA (если используется)',
	tg_default_send_time: 'Дефолтный интервал/время для TG (из списка интервалов или HH:mm)',
}

function getGoogleSheetUrlIssue(rawUrl: string): string | null {
	const value = rawUrl.trim()
	if (!value) return null
	try {
		const parsed = new URL(value)
		if (parsed.protocol !== 'https:') {
			return 'Используйте защищенную ссылку https://'
		}
		const host = parsed.hostname.toLowerCase()
		const path = parsed.pathname.toLowerCase()
		const isGoogleSheetsHost = host === 'docs.google.com' || host.endsWith('.google.com')
		if (!isGoogleSheetsHost || !path.includes('/spreadsheets/')) {
			return 'Нужна ссылка на Google Таблицу формата docs.google.com/spreadsheets/...'
		}
		return null
	} catch {
		return 'Некорректная ссылка. Вставьте полный URL Google Таблицы'
	}
}

type CheckSheetResult = {
	ok: boolean
	text: string
	details?: {
		csvRows?: number
		dataRows?: number
		presentHeaders?: string[]
		missingHeaders?: string[]
	}
}

type ImportResult = {
	totalRows: number
	importedRows: number
	skippedRows: number
}

export function TemplatesSheetCard({
	userId,
	gsheetUrl,
	onCreated,
	onGsheetUrlSaved,
	onTemplatesChanged,
}: {
	userId: string
	gsheetUrl?: string | null
	onCreated?: (url: string) => void
	onGsheetUrlSaved?: (url: string | null) => void
	onTemplatesChanged?: () => void
}) {
	const [creating, setCreating] = useState(false)
	const [syncing, setSyncing] = useState(false)
	const [downloading, setDownloading] = useState(false)
	const [importing, setImporting] = useState(false)
	const [savingUrl, setSavingUrl] = useState(false)
	const [checkingSheet, setCheckingSheet] = useState(false)
	const [checkStatus, setCheckStatus] = useState<CheckSheetResult | null>(null)
	const [hintVisible, setHintVisible] = useState(false)
	const [showGoToTemplates, setShowGoToTemplates] = useState(false)
	const [urlInput, setUrlInput] = useState(gsheetUrl ?? '')
	const [importResult, setImportResult] = useState<ImportResult | null>(null)

	useEffect(() => {
		setUrlInput(gsheetUrl ?? '')
	}, [gsheetUrl])

	useEffect(() => {
		setCheckStatus(null)
	}, [urlInput, gsheetUrl])

	useEffect(() => {
		if (!showGoToTemplates) return
		const t = setTimeout(() => setShowGoToTemplates(false), 12000)
		return () => clearTimeout(t)
	}, [showGoToTemplates])

	const createSheet = async () => {
		if (!userId) return message.error('Нет userId')
		setCreating(true)
		try {
			const data: any = await apiPost('/sheets/create', { userId })
			if (!data?.success) {
				message.error(data?.message || 'Ошибка создания таблицы')
				return
			}
			const url = data?.url ?? data?.gsheet_url ?? data?.sheetUrl
			if (url) {
				message.success('Таблица создана')
				onCreated?.(url)
				setUrlInput(url)
				onGsheetUrlSaved?.(url)
				window.open(url, '_blank')
				setHintVisible(true)
			} else {
				message.warning('Таблица создана, но ссылка не пришла')
			}
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при создании таблицы')
		} finally {
			setCreating(false)
		}
	}

	const copyLink = async () => {
		const url = gsheetUrl || urlInput.trim()
		if (!url) return message.error('Нет ссылки на таблицу')
		try {
			await navigator.clipboard.writeText(url)
			message.success('Ссылка скопирована')
		} catch {
			message.error('Не удалось скопировать')
		}
	}

	const copyHeaders = async () => {
		try {
			await navigator.clipboard.writeText(CSV_HEADERS_ROW)
			message.success('Заголовки скопированы — вставьте в первую строку таблицы')
		} catch {
			message.error('Не удалось скопировать')
		}
	}

	const saveGsheetUrl = async () => {
		const url = urlInput.trim()
		if (!userId) return message.error('Нет userId')
		const issue = getGoogleSheetUrlIssue(url)
		if (issue) return message.error(issue)
		setSavingUrl(true)
		try {
			const data: any = await apiPost('/auth/update-profile', {
				gsheet_url: url || null,
			})
			if (!data?.success) {
				message.error(data?.message || 'Не удалось сохранить ссылку')
				return
			}
			message.success(url ? 'Ссылка на таблицу сохранена' : 'Ссылка очищена')
			onGsheetUrlSaved?.(url || null)
			if (url) {
				setTimeout(() => {
					void checkSheet()
				}, 100)
			}
		} catch (e) {
			console.error(e)
			message.error('Ошибка при сохранении ссылки')
		} finally {
			setSavingUrl(false)
		}
	}

	const sync = async () => {
		if (!userId) return message.error('Нет userId')
		const issue = getGoogleSheetUrlIssue(effectiveUrl)
		if (issue) return message.error(`Проверьте ссылку таблицы: ${issue}`)
		setSyncing(true)
		try {
			const data: any = await apiPost('/templates/sync', {})
			if (!data?.success) {
				message.error(data?.message || 'Укажите и сохраните ссылку на таблицу выше')
				return
			}
			message.success(`Загружено шаблонов: ${data?.count ?? 0}`)
			onTemplatesChanged?.()
			setShowGoToTemplates(true)
		} catch (e) {
			console.error(e)
			message.error('Ошибка загрузки из таблицы')
		} finally {
			setSyncing(false)
		}
	}

	const checkSheet = async () => {
		if (!userId) return message.error('Нет userId')
		const issue = getGoogleSheetUrlIssue(effectiveUrl)
		if (issue) return message.error(`Проверьте ссылку таблицы: ${issue}`)
		setCheckingSheet(true)
		try {
			const data: any = await apiPost('/templates/check-sheet', {})
			if (data?.success) {
				const okText = data?.message || 'Таблица доступна и готова к загрузке.'
				setCheckStatus({ ok: true, text: okText, details: data?.details })
				message.success(okText)
				return
			}
			const errText = data?.message || 'Проверка не пройдена'
			setCheckStatus({ ok: false, text: errText, details: data?.details })
			message.error(errText)
		} catch (e: any) {
			const errText = e?.message || 'Ошибка проверки ссылки'
			setCheckStatus({ ok: false, text: errText })
			message.error(errText)
		} finally {
			setCheckingSheet(false)
		}
	}

	const downloadBackup = async () => {
		if (!userId) return message.error('Нет userId')
		setDownloading(true)
		try {
			const { blob, filename } = await apiDownload('/templates/export')
			const url = URL.createObjectURL(blob)
			const a = document.createElement('a')
			a.href = url
			a.download = filename
			a.click()
			URL.revokeObjectURL(url)
			message.success('Бэкап скачан')
		} catch (e) {
			console.error(e)
			message.error('Не удалось скачать бэкап')
		} finally {
			setDownloading(false)
		}
	}

	const importBackupFromFile = async (file: File) => {
		if (!userId) return message.error('Нет userId')
		setImporting(true)
		try {
			const fd = new FormData()
			fd.append('file', file)
			const data: any = await apiPostForm('/templates/import', fd)
			if (!data?.success) {
				message.error(data?.message || 'Не удалось восстановить шаблоны из файла')
				return
			}
			message.success(`Шаблоны восстановлены из файла: ${data?.count ?? 0}`)
			setImportResult({
				totalRows: Number(data?.totalRows ?? data?.count ?? 0),
				importedRows: Number(data?.importedRows ?? data?.count ?? 0),
				skippedRows: Number(data?.skippedRows ?? 0),
			})
			onTemplatesChanged?.()
			setShowGoToTemplates(true)
		} catch (e) {
			console.error(e)
			message.error('Ошибка импорта CSV')
		} finally {
			setImporting(false)
		}
	}

	const hasTable = !!(gsheetUrl || urlInput.trim())
	const effectiveUrl = gsheetUrl || urlInput.trim() || ''
	const urlIssue = getGoogleSheetUrlIssue(urlInput)
	const hasUnsavedChanges = urlInput.trim() !== (gsheetUrl ?? '').trim()

	const fieldsCollapseItems = [
		{
			key: 'fields',
			label: 'Что означают колонки (все поля, включая картинки)',
			children: (
				<ul className="tsc__fields-list">
					{CSV_HEADERS_ROW.split(',').map((key) => (
						<li key={key}>
							<code className="tsc__hint-code">{key}</code>
							<span className="tsc__field-desc"> — {FIELD_DESCRIPTIONS[key] ?? key}</span>
						</li>
					))}
				</ul>
			),
		},
	]

	return (
		<Collapse
			className="tsc__outer-collapse"
			accordion={false}
			defaultActiveKey={[]}
			items={[
				{
					key: 'backup',
					label: <h3 className="tsc__title tsc__outer-title">Бэкап шаблонов и загрузка в приложение</h3>,
					children: (
						<div className="tsc__outer-content">
							<div className="tsc tsc__inside-collapse">
								<p className="tsc__lead">
									Два рабочих сценария: <strong>CSV-файл</strong> (самый надежный) и{' '}
									<strong>Google Таблица</strong> (удобно редактировать совместно). Импорт из файла выполняется в разделе{' '}
									<strong>Шаблоны</strong> дашборда.
								</p>

								{/* Секция 1: CSV — основной способ */}
								<section className="tsc__section">
									<h4 className="tsc__section-title">Скачать бэкап (CSV)</h4>
									<p className="tsc__section-lead">
										Скачайте CSV со всеми шаблонами. Файл можно открыть в Excel/Google Таблицах, обновить и вернуть обратно через
										<strong> Шаблоны → Восстановить из файла</strong>.
									</p>
									<div className="tsc__actions">
										<Space wrap size="middle">
											<Button
												type="primary"
												size="large"
												onClick={downloadBackup}
												loading={downloading}
												disabled={downloading || importing}
												className="tsc__btn-download"
											>
												Скачать бэкап (CSV)
											</Button>
											<Button
												size="large"
												onClick={() => {
													const input = document.getElementById('tsc-import-file') as HTMLInputElement | null
													input?.click()
												}}
												loading={importing}
												disabled={importing || downloading}
											>
												Восстановить из файла
											</Button>
											<input
												id="tsc-import-file"
												type="file"
												accept=".csv,text/csv"
												className="tsc__file-input"
												onChange={(e) => {
													const file = e.target.files?.[0]
													e.currentTarget.value = ''
													if (!file) return
													void importBackupFromFile(file)
												}}
											/>
										</Space>
									</div>
									{importResult ? (
										<div className="tsc__import-summary" role="status" aria-live="polite">
											<div className="tsc__import-summary-title">Результат импорта CSV</div>
											<div className="tsc__import-summary-grid">
												<div className="tsc__import-cell">
													<span className="tsc__import-label">Всего строк</span>
													<b>{importResult.totalRows}</b>
												</div>
												<div className="tsc__import-cell">
													<span className="tsc__import-label">Импортировано</span>
													<b>{importResult.importedRows}</b>
												</div>
												<div className="tsc__import-cell">
													<span className="tsc__import-label">Пропущено</span>
													<b>{importResult.skippedRows}</b>
												</div>
											</div>
										</div>
									) : null}
								</section>

								{/* Секция 2: Google Таблица */}
								<section className="tsc__section">
									<h4 className="tsc__section-title">Google Таблица</h4>
									<p className="tsc__section-lead">
										Создайте новую таблицу кнопкой ниже или вставьте ссылку на свою. После сохранения ссылки можно загружать шаблоны прямо из таблицы.
									</p>
									<ol className="tsc__steps">
										<li>Создайте таблицу или вставьте ссылку на уже готовую.</li>
										<li>Проверьте заголовки первой строки (кнопка «Скопировать заголовки»).</li>
										<li>Заполните данные, начиная со 2-й строки.</li>
										<li>Откройте доступ по ссылке (минимум «Просмотр»).</li>
										<li>Нажмите «Загрузить шаблоны из таблицы».</li>
									</ol>

									<div className="tsc__url-row">
										<Input
											placeholder="Вставьте ссылку на Google Таблицу (или оставьте пусто)"
											value={urlInput}
											onChange={(e) => setUrlInput(e.target.value)}
											className="tsc__url-input"
											allowClear
										/>
										<Button
											type="default"
											onClick={saveGsheetUrl}
											loading={savingUrl}
											disabled={savingUrl || !!urlIssue || !hasUnsavedChanges}
											className="tsc__btn-save-url"
										>
											Сохранить ссылку
										</Button>
									</div>
									{urlIssue ? (
										<p className="tsc__hint tsc__hint--error">{urlIssue}</p>
									) : hasUnsavedChanges ? (
										<p className="tsc__hint tsc__hint--warn">Изменения ссылки не сохранены. Нажмите «Сохранить ссылку».</p>
									) : hasTable ? (
										<p className="tsc__hint tsc__hint--ok">Интеграция активна: ссылка сохранена в профиле.</p>
									) : null}

									{!hasTable ? (
										<>
											<Collapse className="tsc__fields-collapse" items={fieldsCollapseItems} />
											<div className="tsc__actions">
												<Space wrap size="middle">
													<Button
														type="primary"
														size="large"
														onClick={createSheet}
														loading={creating}
														disabled={creating}
													>
														Создать таблицу
													</Button>
													<Button onClick={copyHeaders} className="tsc__copy-headers-btn">
														Скопировать заголовки
													</Button>
												</Space>
											</div>
											{hintVisible && (
												<p className="tsc__hint tsc__hint--success">
													Таблица открыта в новой вкладке. В первой строке уже есть заголовки. Заполните данные со 2-й строки или вставьте из скачанного CSV, сохраните ссылку выше и нажмите «Загрузить шаблоны из таблицы», когда будет готово.
												</p>
											)}
										</>
									) : (
										<>
											<div className="tsc__row">
												<span className="tsc__label">Таблица:</span>
												<Space wrap size="small" className="tsc__link-actions">
													<a href={effectiveUrl} target="_blank" rel="noreferrer" className="tsc__open-link">
														Открыть таблицу
													</a>
													<Button type="text" onClick={copyLink} className="tsc__copy-btn">
														Копировать ссылку
													</Button>
													<Button type="text" onClick={copyHeaders} className="tsc__copy-btn">
														Скопировать заголовки
													</Button>
												</Space>
											</div>
											<p className="tsc__note">
												Первая строка — заголовки, со 2-й — данные. Если загрузка не проходит, чаще всего причина в доступе:
												включите доступ по ссылке хотя бы на «Просмотр».
											</p>
											<Collapse className="tsc__fields-collapse" items={fieldsCollapseItems} />
											<div className="tsc__actions">
												<Space wrap size="middle">
													<Button onClick={downloadBackup} loading={downloading} disabled={downloading}>
														Скачать бэкап в CSV
													</Button>
													<Button
														onClick={checkSheet}
														loading={checkingSheet}
														disabled={checkingSheet || !!urlIssue || hasUnsavedChanges}
													>
														{checkingSheet ? 'Проверяем…' : 'Проверить ссылку'}
													</Button>
													<Button type="primary" onClick={sync} loading={syncing} disabled={syncing}>
														Загрузить шаблоны из таблицы
													</Button>
												</Space>
											</div>
											{checkStatus ? (
												<div className={`tsc__hint ${checkStatus.ok ? 'tsc__hint--ok' : 'tsc__hint--error'}`}>
													<p className="tsc__hintText">{checkStatus.text}</p>
													{typeof checkStatus.details?.dataRows === 'number' ? (
														<p className="tsc__hintMeta">Строк данных: {checkStatus.details.dataRows}</p>
													) : null}
													{checkStatus.details?.missingHeaders?.length ? (
														<p className="tsc__hintMeta">
															Отсутствуют колонки: {checkStatus.details.missingHeaders.join(', ')}
														</p>
													) : null}
												</div>
											) : null}
											{showGoToTemplates && (
												<p className="tsc__go-wrap">
													<Link href="/dashboard/templates" className="tsc__go-link">
														→ Перейти в Шаблоны
													</Link>
												</p>
											)}
										</>
									)}
								</section>
							</div>
						</div>
					),
				},
			]}
		/>
	)
}
