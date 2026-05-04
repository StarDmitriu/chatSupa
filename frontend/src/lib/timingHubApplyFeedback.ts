'use client'

import { message } from 'antd'

let flushTimer: ReturnType<typeof setTimeout> | null = null
type Kind = 'success' | 'warning' | 'info'
let pending: { kind: Kind; text: string } | null = null

const FLUSH_MS = 420

function flush() {
	flushTimer = null
	if (!pending) return
	const { kind, text } = pending
	pending = null
	if (kind === 'success') message.success(text)
	else if (kind === 'warning') message.warning(text)
	else message.info(text)
}

/** Склеивает частые тосты подбора пауз в одно уведомление после паузы. */
export function scheduleTimingApplyFeedback(kind: Kind, text: string): void {
	pending = { kind, text }
	if (flushTimer != null) clearTimeout(flushTimer)
	flushTimer = setTimeout(flush, FLUSH_MS)
}
