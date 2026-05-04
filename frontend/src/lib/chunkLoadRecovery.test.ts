import { describe, expect, it } from 'vitest'

import { isChunkLoadError } from '@/lib/chunkLoadRecovery'

describe('isChunkLoadError', () => {
	it('распознаёт типичные сообщения Next/Webpack', () => {
		expect(isChunkLoadError('Failed to load chunk 12')).toBe(true)
		expect(isChunkLoadError('Loading chunk 3 failed')).toBe(true)
		expect(isChunkLoadError('ChunkLoadError: ...')).toBe(true)
		expect(isChunkLoadError('Loading CSS chunk 1 failed')).toBe(true)
		expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(true)
		expect(isChunkLoadError('Importing a module script failed')).toBe(true)
		expect(
			isChunkLoadError('Failed to load chunk /_next/static/chunks/abc.js from module 64893'),
		).toBe(true)
	})

	it('возвращает false для обычных ошибок', () => {
		expect(isChunkLoadError('NetworkError')).toBe(false)
		expect(isChunkLoadError(undefined)).toBe(false)
	})
})
