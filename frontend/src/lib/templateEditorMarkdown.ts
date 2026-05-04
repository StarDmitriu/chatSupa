/**
 * Псевдо-markdown шаблонов: *жирный*, _курсив_, ~подчёркнутый~, ~~зачёркнутый~~, `код`, списки.
 * HTML ↔ markdown для contentEditable (создание / редактирование шаблона).
 */

const BLOCK_TAGS = new Set([
	'div',
	'p',
	'ul',
	'ol',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'pre',
	'blockquote',
])

type ListContext = { listType: 'ol' | 'ul'; itemIndex: number }

/** Конвертация markdown -> HTML для отображения в contentEditable */
export function markdownToHtml(markdown: string): string {
	if (!markdown) return ''
	let html = markdown
		.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/\*(.+?)\*/g, '<strong>$1</strong>')
		.replace(/_(.+?)_/g, '<em>$1</em>')
		.replace(/~~(.+?)~~/g, '<s>$1</s>')
		.replace(/~(.+?)~/g, '<u>$1</u>')
		.replace(/`(.+?)`/g, '<code>$1</code>')

	const lines = html.split('\n')
	const out: string[] = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		const numMatch = line.match(/^(\d+)\. (.+)$/)
		const bulletMatch = line.match(/^- (.+)$/)
		if (numMatch) {
			const olItems: string[] = []
			while (i < lines.length && lines[i].match(/^\d+\. (.+)$/)) {
				const m = lines[i].match(/^\d+\. (.+)$/)!
				olItems.push('<li>' + m[1] + '</li>')
				i++
			}
			out.push('<ol>' + olItems.join('') + '</ol>')
			continue
		}
		if (bulletMatch) {
			const ulItems: string[] = []
			while (i < lines.length && lines[i].match(/^- (.+)$/)) {
				const m = lines[i].match(/^- (.+)$/)!
				ulItems.push('<li>' + m[1] + '</li>')
				i++
			}
			out.push('<ul>' + ulItems.join('') + '</ul>')
			continue
		}
		out.push(line)
		i++
	}
	html = out.join('\n')
	html = html.replace(/\n/g, '<br>')
	return html
}

function wrapMarkerPerLine(value: string, marker: string): string {
	const parts = String(value ?? '').split('\n')
	return parts
		.map((p) => {
			if (!p) return p
			if (p.startsWith(marker) && p.endsWith(marker) && p.length >= marker.length * 2) return p
			return `${marker}${p}${marker}`
		})
		.join('\n')
}

/**
 * Соседний блочный элемент (div/p/список/заголовок) должен начинаться с новой строки в markdown,
 * иначе после Enter внутри жирного браузер даёт <div><strong>a</strong><div>b</div></div> и строки сливаются.
 */
function appendNewlineBeforeNextBlock(piece: string, next: Node | undefined): string {
	if (!next || next.nodeType !== Node.ELEMENT_NODE) return piece
	const nt = (next as HTMLElement).tagName.toLowerCase()
	if (!BLOCK_TAGS.has(nt)) return piece
	if (!piece) return piece
	if (piece.endsWith('\n')) return piece
	return `${piece}\n`
}

/** Конвертация HTML -> markdown для сохранения */
export function htmlToMarkdown(html: string): string {
	if (!html || html === '<br>' || html === '<div><br></div>' || html === '<div></div>') return ''

	const temp = document.createElement('div')
	temp.innerHTML = html

	const processNode = (n: Node, ctx?: ListContext): string => {
		if (n.nodeType === Node.TEXT_NODE) {
			return n.textContent || ''
		}
		if (n.nodeType === Node.ELEMENT_NODE) {
			const el = n as HTMLElement
			const tagName = el.tagName.toLowerCase()

			if (tagName === 'ol' || tagName === 'ul') {
				const listType = tagName as 'ol' | 'ul'
				const items = Array.from(el.childNodes).filter(
					(c) => c.nodeType === Node.ELEMENT_NODE && (c as HTMLElement).tagName.toLowerCase() === 'li',
				)
				return items.map((li, idx) => processNode(li, { listType, itemIndex: idx })).join('')
			}

			let children: string
			if (tagName === 'div' || tagName === 'p') {
				const childNodes = Array.from(el.childNodes)
				const parts: string[] = []
				for (let i = 0; i < childNodes.length; i++) {
					const c = childNodes[i]
					let piece = processNode(c, ctx)
					const next = childNodes[i + 1]
					piece = appendNewlineBeforeNextBlock(piece, next)
					parts.push(piece)
				}
				children = parts.join('')
			} else {
				children = Array.from(el.childNodes)
					.map((c) => processNode(c, ctx))
					.join('')
			}
			if (!children.trim() && !['br', 'div', 'p'].includes(tagName)) return ''

			switch (tagName) {
				case 'br':
					return '\n'
				case 'div':
				case 'p': {
					const inner = children
					const lastChild = el.lastChild as HTMLElement | null
					const hasTrailingBr =
						!!lastChild &&
						lastChild.nodeType === Node.ELEMENT_NODE &&
						lastChild.tagName.toLowerCase() === 'br'

					if (!inner.trim()) {
						return '\n'
					}

					if (hasTrailingBr || inner.endsWith('\n')) return inner
					return inner + '\n'
				}
				case 'strong':
				case 'b':
					return wrapMarkerPerLine(children, '*')
				case 'em':
				case 'i':
					return wrapMarkerPerLine(children, '_')
				case 'u':
					return wrapMarkerPerLine(children, '~')
				case 's':
				case 'del':
					return wrapMarkerPerLine(children, '~~')
				case 'code':
					return wrapMarkerPerLine(children, '`')
				case 'li':
					if (ctx?.listType === 'ol') return `${ctx.itemIndex + 1}. ${children.trim()}\n`
					return `- ${children.trim()}\n`
				case 'ul':
				case 'ol':
					return children
				default:
					return children
			}
		}
		return ''
	}

	const nodes = Array.from(temp.childNodes)
	const parts: string[] = []
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i]
		let s = processNode(n)
		const next = nodes[i + 1]
		s = appendNewlineBeforeNextBlock(s, next)
		parts.push(s)
	}
	return parts.join('')
}
