'use client'

import React, { useEffect } from 'react'
import './MediaViewerModal.css'

function isVideoUrl(url: string) {
	const clean = (url || '').split('?')[0] || ''
	return /\.(mp4|webm|mov|m4v)$/i.test(clean)
}

function isAudioUrl(url: string) {
	const clean = (url || '').split('?')[0] || ''
	return /\.(mp3|ogg|wav|m4a|webm)$/i.test(clean)
}

type Props = {
	open: boolean
	url: string | null
	onClose: () => void
}

/**
 * Модальное окно полного просмотра медиа: картинка (увеличенная), видео или аудио с плеером.
 */
export function MediaViewerModal({ open, url, onClose }: Props) {
	useEffect(() => {
		if (!open) return
		const onEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onEscape)
		return () => window.removeEventListener('keydown', onEscape)
	}, [open, onClose])

	if (!open || !url) return null

	const isVideo = isVideoUrl(url)
	const isAudio = isAudioUrl(url)

	return (
		<div
			className='media-viewer-overlay'
			onClick={onClose}
			role='dialog'
			aria-modal='true'
			aria-label='Просмотр медиа'
		>
			<div
				className='media-viewer-content'
				onClick={e => e.stopPropagation()}
			>
				<button
					type='button'
					className='media-viewer-close'
					onClick={onClose}
					aria-label='Закрыть'
				>
					×
				</button>
				{isVideo && (
					<video
						src={url}
						controls
						autoPlay
						className='media-viewer-video'
						onClick={e => e.stopPropagation()}
					/>
				)}
				{isAudio && !isVideo && (
					<div className='media-viewer-audio-wrap'>
						<audio
							src={url}
							controls
							autoPlay
							className='media-viewer-audio'
							onClick={e => e.stopPropagation()}
						/>
					</div>
				)}
				{!isVideo && !isAudio && (
					<img
						src={url}
						alt='Просмотр'
						className='media-viewer-img'
						onClick={e => e.stopPropagation()}
					/>
				)}
			</div>
		</div>
	)
}
