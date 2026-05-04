/**
 * Глобальные обработчики ошибок: ETIMEDOUT, ECONNRESET, NEXT_REDIRECT,
 * returnNaN (баг зависимостей), ENOENT chmod — не роняют и не заспамливают лог.
 * process.on вызывается только в Node.js runtime (см. instrumentation-node.ts).
 */

// Полифилл returnNaN до загрузки остального (баг React Compiler / зависимостей)
const g =
	typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : ({} as any)
if (g && (g as any).returnNaN === undefined) {
	;(g as any).returnNaN = Number.NaN
}
if (typeof global !== 'undefined' && (global as any).returnNaN === undefined) {
	;(global as any).returnNaN = Number.NaN
}

export async function register() {
	if (process.env.NEXT_RUNTIME !== 'nodejs') return
	const { registerNodeErrorHandlers } = await import('./instrumentation-node')
	registerNodeErrorHandlers()
}
