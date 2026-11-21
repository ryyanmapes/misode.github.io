import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Ico } from './icons.jsx'
import type { PaletteItem } from './types.js'
import { useUid } from './ui.jsx'

interface PaletteProps {
	items: PaletteItem[]
	x: number
	y: number
	title: string
	onPick: (item: PaletteItem) => void
	onClose: () => void
}
/** A searchable list of the nodes that can be added */
export function Palette({ items, x, y, title, onPick, onClose }: PaletteProps) {
	const [query, setQuery] = useState('')
	const [index, setIndex] = useState(0)
	const input = useRef<HTMLInputElement>(null)
	const list = useRef<HTMLDivElement>(null)
	const id = useUid()

	const results = useMemo(() => {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
		if (terms.length === 0) return items
		const scored = items.flatMap(item => {
			const label = item.label.toLowerCase()
			const haystack = `${label} ${item.type} ${item.category} ${item.keywords ?? ''}`.toLowerCase()
			if (!terms.every(t => haystack.includes(t))) return []
			const score = label.startsWith(terms[0]) ? 0 : label.includes(terms[0]) ? 1 : 2
			return [{ item, score }]
		})
		return scored.sort((a, b) => a.score - b.score).map(s => s.item)
	}, [items, query])

	const groups = useMemo(() => {
		if (query.trim() !== '') return [{ name: undefined, items: results }]
		const map = new Map<string, PaletteItem[]>()
		for (const item of results) {
			const group = map.get(item.category)
			if (group) group.push(item)
			else map.set(item.category, [item])
		}
		return [...map.entries()].map(([name, items]) => ({ name, items }))
	}, [results, query])
	const ordered = useMemo(() => groups.flatMap(g => g.items), [groups])

	// Focus right away, so typing immediately after opening ends up in the search field
	useLayoutEffect(() => {
		input.current?.focus({ preventScroll: true })
	}, [])

	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
	}, [index, ordered])

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setIndex(i => Math.min(ordered.length - 1, i + 1))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setIndex(i => Math.max(0, i - 1))
		} else if (e.key === 'Enter') {
			e.preventDefault()
			if (ordered[index]) onPick(ordered[index])
		} else if (e.key === 'Escape') {
			e.preventDefault()
			onClose()
		}
		e.stopPropagation()
	}

	let position = -1
	return <div class="gx-pop gx-palette" role="dialog" aria-label={title} style={{ left: `${x}px`, top: `${y}px` }}
		onKeyDown={onKeyDown}
		onfocusout={(e: FocusEvent) => {
			const next = e.relatedTarget as Node | null
			if (!next || !(e.currentTarget as HTMLElement).contains(next)) onClose()
		}}>
		<div class="gx-palette-search">
			{Ico.search}
			<input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
				aria-activedescendant={ordered[index] ? `${id}-${ordered[index].type}` : undefined}
				aria-label={title} placeholder="Search nodes" autocomplete="off" spellcheck={false} value={query}
				onInput={e => {
					setQuery((e.target as HTMLInputElement).value)
					setIndex(0)
				}} />
		</div>
		<div ref={list} id={`${id}-list`} class="gx-palette-list" role="listbox" aria-label="Nodes">
			{groups.map(group => <div key={group.name ?? 'results'} role="group" aria-label={group.name}>
				{group.name && <div class="gx-palette-cat" aria-hidden="true">{group.name}</div>}
				{group.items.map(item => {
					position += 1
					const i = position
					return <div key={item.type} id={`${id}-${item.type}`} role="option" aria-selected={i === index}
						class={`gx-palette-item${i === index ? ' is-active' : ''}`}
						onPointerMove={() => setIndex(i)}
						onPointerDown={e => e.preventDefault()}
						onClick={() => onPick(item)}>
						<span class="gx-dot" style={{ background: item.color }} />
						<span class="gx-palette-label">{item.label}</span>
						<span class="gx-palette-desc">{item.description}</span>
					</div>
				})}
			</div>)}
			{ordered.length === 0 && <div class="gx-palette-empty">No nodes match “{query}”</div>}
		</div>
	</div>
}

export interface MenuItem {
	label: string
	icon?: ComponentChildren
	shortcut?: string
	danger?: boolean
	disabled?: boolean
	onSelect: () => void
}

interface MenuProps {
	items: MenuItem[]
	x: number
	y: number
	label: string
	onClose: () => void
}
export function Menu({ items, x, y, label, onClose }: MenuProps) {
	const root = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
	}, [])
	const onKeyDown = (e: KeyboardEvent) => {
		const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			buttons[(current + 1) % buttons.length]?.focus()
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			buttons[(current - 1 + buttons.length) % buttons.length]?.focus()
		} else if (e.key === 'Escape' || e.key === 'Tab') {
			e.preventDefault()
			onClose()
		}
		e.stopPropagation()
	}
	return <div ref={root} class="gx-pop gx-menu" role="menu" aria-label={label} style={{ left: `${x}px`, top: `${y}px` }}
		onKeyDown={onKeyDown}
		onfocusout={(e: FocusEvent) => {
			const next = e.relatedTarget as Node | null
			if (!next || !(e.currentTarget as HTMLElement).contains(next)) onClose()
		}}>
		{items.map(item => <button key={item.label} type="button" role="menuitem" class={item.danger ? 'is-danger' : ''} disabled={item.disabled}
			onClick={() => {
				onClose()
				item.onSelect()
			}}>
			{item.icon}
			<span>{item.label}</span>
			{item.shortcut && <kbd>{item.shortcut}</kbd>}
		</button>)}
	</div>
}
