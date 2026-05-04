// frontend/src/components/TemplatesSyncBlock.tsx
'use client'
import './TemplatesSyncBlock.css'
import { useState } from 'react'
import { Button, message, Space } from 'antd'
import { apiDownload, apiPost } from '@/lib/api'

export function TemplatesSyncBlock({ userId }: { userId: string }) {
	const [loading, setLoading] = useState(false)
	const [downloading, setDownloading] = useState(false)

	const sync = async () => {
		if (!userId) return message.error('Нет userId')
		setLoading(true)
		try {
			const data: any = await apiPost('/templates/sync', {})
			if (!data?.success) {
				message.error(data?.message || 'Ошибка синхронизации. Укажите ссылку на таблицу выше.')
				return
			}
			message.success(`Из таблицы загружено шаблонов: ${data?.count ?? 0}`)
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при загрузке из таблицы')
		} finally {
			setLoading(false)
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

	return (
		<div className='sinh'>
			<h2 className='sinh-title'>Снимок шаблонов (бэкап)</h2>
			<p className='sinh-text'>
				Скачайте все шаблоны в CSV или восстановите их из таблицы. Полный бэкап и восстановление из файла — в разделе <strong>Шаблоны</strong> дашборда.
			</p>
			<div className='pattern-button'>
				<Space wrap>
					<Button onClick={downloadBackup} loading={downloading} disabled={!!downloading}>
						Скачать бэкап
					</Button>
					<Button onClick={sync} loading={loading}>
						Восстановить из таблицы
					</Button>
				</Space>
			</div>
		</div>
	)
}
