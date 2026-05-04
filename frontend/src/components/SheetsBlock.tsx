// frontend/src/components/SheetsBlock.tsx
'use client'

import { useState } from 'react'
import { Button, message, Space } from 'antd'
import { apiPost } from '@/lib/api'

export function SheetsBlock({
	userId,
	gsheetUrl,
	onCreated,
}: {
	userId: string
	gsheetUrl?: string | null
	onCreated?: (url: string) => void
}) {
	const [loading, setLoading] = useState(false)

	const createSheet = async () => {
		if (!userId) return message.error('Нет userId')
		setLoading(true)
		try {
			const data: any = await apiPost('/sheets/create', { userId })
			if (!data?.success) {
				message.error(`Ошибка создания таблицы: ${data?.message || 'unknown'}`)
				return;			}
			const url = data?.url || data?.gsheet_url || data?.sheetUrl
			if (url) {
				message.success('Таблица создана')
				onCreated?.(url)
				window.open(url, '_blank')
			} else {
				message.warning('Таблица создана, но ссылка не пришла от бэка')
			}
		} catch (e) {
			console.error(e)
			message.error('Ошибка сети при создании таблицы')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className='sheets-block'>
			<h3 className='sheets-block__title'>Таблица шаблонов</h3>

			{gsheetUrl ? (
				<div className='sheets-block__url-wrap'>
					<div className='sheets-block__url-label'>Ваша таблица:</div>
					<a
						href={gsheetUrl}
						target='_blank'
						rel='noreferrer'
						className='sheets-block__link'
					>
						{gsheetUrl}
					</a>
				</div>
			) : (
				<p className='sheets-block__no-url'>
					У вас ещё нет таблицы. Нажмите кнопку — создадим персональную Google
					Sheet.
				</p>
			)}

			<Space className='sheets-block__actions'>
				<Button
					type='primary'
					onClick={createSheet}
					loading={loading}
					disabled={!!gsheetUrl}
				>
					Создать таблицу
				</Button>
			</Space>
		</div>
	)
}
