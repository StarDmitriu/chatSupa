'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { message } from 'antd'
import { htmlToMarkdown, markdownToHtml } from '@/lib/templateEditorMarkdown'

type Props = {
  /** Текст шаблона в виде "псевдо‑markdown" (*жирный*, _курсив_, ~подчёркнутый~, списки). */
  value: string
  onChange: (next: string) => void
  maxChars?: number
}

export function TemplateRichEditor({ value, onChange, maxChars }: Props) {
	const editorRef = useRef<HTMLDivElement>(null)
	/** Последнее значение, которое мы отправили в onChange — не перезаписываем редактор этим же значением после асинхронного обновления родителя (иначе теряются переносы строк на 4+ шаблоне) */
	const lastEmittedRef = useRef<string | null>(null)
	const charCount = useMemo(() => String(value ?? '').length, [value])
	const [formatActive, setFormatActive] = useState({
		bold: false,
		italic: false,
		underline: false,
		strike: false,
		unorderedList: false,
		orderedList: false,
	})
	const hasMaxChars = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0

	// Синхронизируем редактор из value только когда значение пришло извне (начальная загрузка, смена шаблона).
	// Не перезаписываем, пока пользователь вводит (фокус в редакторе) — иначе на 4+ шаблоне теряются переносы из-за race: родитель отстаёт с обновлением value.
	useEffect(() => {
		const editor = editorRef.current
		if (!editor) return
		const isFocused = document.activeElement === editor || editor.contains(document.activeElement)
		if (isFocused && lastEmittedRef.current !== null) return

		const md = String(value ?? '')
		if (lastEmittedRef.current === md) return
		lastEmittedRef.current = md

		if (!md.trim()) {
			editor.innerHTML = '<br>'
			return
		}

		editor.innerHTML = markdownToHtml(md)
	}, [value])

	const updateFormatActive = () => {
		try {
			const editor = editorRef.current
			if (!editor || !document.contains(editor)) return
			if (!editor.contains(document.activeElement) && document.activeElement !== editor) return
			setFormatActive({
				bold: document.queryCommandState('bold'),
				italic: document.queryCommandState('italic'),
				underline: document.queryCommandState('underline'),
				strike: document.queryCommandState('strikeThrough'),
				unorderedList: document.queryCommandState('insertUnorderedList'),
				orderedList: document.queryCommandState('insertOrderedList'),
			})
		} catch {
			// ignore
		}
	}

	const applyCommand = (command: string, value?: string) => {
		const editor = editorRef.current
		if (!editor) return
		editor.focus()
		document.execCommand(command, false, value)
		handleInput()
	}

	const handleInput = () => {
		const editor = editorRef.current
		if (!editor) return
		const html = editor.innerHTML
		const markdown = htmlToMarkdown(html)
		lastEmittedRef.current = markdown
		onChange(markdown)
		updateFormatActive()
	}

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const editor = editorRef.current
		if (!editor) return

		const len = (editor.innerText || '').length
		const isAdding =
			!['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.key) &&
			!(e.ctrlKey || e.metaKey) &&
			e.key.length === 1

		if (hasMaxChars && isAdding && len >= maxChars!) {
			e.preventDefault()
			message.warning(`Лимит сообщения — ${maxChars} символов`)
			return
		}

		// Enter в пустой строке (в т.ч. вложенный div после жирного): insertParagraph — иначе DOM даёт «strong + div» без \n в markdown
		if (e.key === 'Enter') {
			const sel = window.getSelection()
			if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
				const block = (sel.anchorNode as HTMLElement)?.closest?.('div, p')
				if (block && block !== editor && editor.contains(block)) {
					const onlyBr =
						block.childNodes.length === 1 &&
						block.firstChild?.nodeType === Node.ELEMENT_NODE &&
						(block.firstChild as HTMLElement).tagName?.toLowerCase() === 'br'
					const empty = !block.textContent?.trim()
					if (onlyBr || empty) {
						e.preventDefault()
						document.execCommand('insertParagraph', false)
						handleInput()
						return
					}
				}
			}
		}

		if (e.ctrlKey || e.metaKey) {
			if (e.key === 'b') {
				e.preventDefault()
				applyCommand('bold')
			} else if (e.key === 'i') {
				e.preventDefault()
				applyCommand('italic')
			} else if (e.key === 'u') {
				e.preventDefault()
				applyCommand('underline')
			}
		}
	}

	const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
		e.preventDefault()
		const editor = editorRef.current
		if (!editor) return

		const currentLen = (editor.innerText || '').length
		let text = e.clipboardData.getData('text/plain')
		if (hasMaxChars && currentLen + text.length > maxChars!) {
			text = text.slice(0, maxChars! - currentLen)
			message.warning(`Лимит сообщения — ${maxChars} символов, вставлено до лимита`)
		}
		document.execCommand('insertText', false, text)
		handleInput()
	}

	return (
		<div className='tedit-textarea-wrapper'>
			<div className='tedit-format-toolbar'>
				<button
					type='button'
					className={`tedit-format-btn ${formatActive.bold ? 'is-active' : ''}`}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => applyCommand('bold')}
					title='Жирный (Ctrl+B)'
				>
					<span className='tedit-format-btn__char'>B</span>
				</button>
				<button
					type='button'
					className={`tedit-format-btn ${formatActive.italic ? 'is-active' : ''}`}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => applyCommand('italic')}
					title='Курсив (Ctrl+I)'
				>
					<span className='tedit-format-btn__char tedit-format-btn__char--italic'>I</span>
				</button>
				<button
					type='button'
					className={`tedit-format-btn ${formatActive.underline ? 'is-active' : ''}`}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => applyCommand('underline')}
					title='Подчёркнутый (Ctrl+U)'
				>
					<span className='tedit-format-btn__char tedit-format-btn__char--underline'>U</span>
				</button>
				<button
					type='button'
					className={`tedit-format-btn ${formatActive.strike ? 'is-active' : ''}`}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => applyCommand('strikeThrough')}
					title='Зачёркнутый'
				>
					<span className='tedit-format-btn__char tedit-format-btn__char--strike'>S</span>
				</button>
				<div className='tedit-format-separator' />
				<button
					type='button'
					className={`tedit-format-btn ${formatActive.unorderedList ? 'is-active' : ''}`}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => applyCommand('insertUnorderedList')}
					title='Маркированный список'
				>
					<span className='tedit-format-btn__char'>•</span>
				</button>
				<button
					type='button'
					className={`tedit-format-btn ${formatActive.orderedList ? 'is-active' : ''}`}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => applyCommand('insertOrderedList')}
					title='Нумерованный список'
				>
					<span className='tedit-format-btn__char'>1.</span>
				</button>
			</div>

			<div
				ref={editorRef}
				contentEditable
				className='tedit-textarea-editor'
				data-placeholder='Введите текст...'
				onInput={handleInput}
				onFocus={updateFormatActive}
				onKeyDown={handleKeyDown}
				onPaste={handlePaste}
			/>

			<div className='tedit-char-count'>
				<span className='tedit-char-count__nums'>
					Символов: <strong>{charCount}</strong>{hasMaxChars ? ` / ${maxChars}` : ''}
				</span>
			</div>
		</div>
	)
}
