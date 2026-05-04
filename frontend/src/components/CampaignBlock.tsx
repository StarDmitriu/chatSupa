'use client'

import { Button, Space } from 'antd'
import { useRouter } from 'next/navigation'
import './CampaignBlock.css'

export interface CampaignBlockProps {
	onGoToCampaigns?: () => void
}

export function CampaignBlock({ onGoToCampaigns }: CampaignBlockProps) {
	const router = useRouter()
	const handleClick = onGoToCampaigns ?? (() => router.push('/dashboard/campaigns'))

	return (
		<div className='newsletters'>
			<h2 className='newsletters-title'>Рассылка почти готова!</h2>
			<p className='newsletters-text'>
				Сообщения уйдут в выбранные группы. Отправка идёт с паузами, как у живого пользователя — так надёжнее.
			</p>
			<div className="newsletters-button">
				<Space>
					<Button type='primary' onClick={handleClick}>
						Перейти в рассылки
					</Button>
				</Space>
			</div>
		</div>
	)
}
