import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

const PROTECTED_PREFIXES = ['/dashboard', '/cabinet', '/admin']

function isProtectedPath(pathname: string): boolean {
	return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

/**
 * Документы и RSC без долгого кэша — иначе после деплоя остаётся старый манифест чанков → ChunkLoadError / 500.
 * Сами `/_next/static/*`: long-cache в `next.config.ts`.
 */
function withNoHtmlCache(request: NextRequest, response: NextResponse): NextResponse {
	const accept = request.headers.get('accept') || ''
	const isRsc =
		request.headers.get('RSC') === '1' ||
		request.headers.get('Next-Router-Prefetch') === '1' ||
		accept.includes('text/x-component')
	if (!accept.includes('text/html') && !isRsc) {
		return response
	}
	response.headers.set(
		'Cache-Control',
		'private, no-cache, no-store, must-revalidate, max-age=0',
	)
	return response
}

export function proxy(request: NextRequest) {
	const pathname = request.nextUrl.pathname

	if (pathname.startsWith('/_next/static') || pathname.startsWith('/_next/image')) {
		return NextResponse.next()
	}
	if (pathname.startsWith('/api')) {
		return NextResponse.next()
	}
	if (/\.(ico|png|jpg|jpeg|svg|gif|webp|woff2?)$/i.test(pathname)) {
		return NextResponse.next()
	}

	if (isProtectedPath(pathname)) {
		const token = request.cookies.get('token')?.value
		if (!token?.trim()) {
			const login = new URL('/auth/phone', request.url)
			login.searchParams.set('next', pathname)
			return NextResponse.redirect(login)
		}
	}

	return withNoHtmlCache(request, NextResponse.next())
}

export const config = {
	matcher: ['/((?!_next/static|_next/image|api/).*)', '/'],
}
