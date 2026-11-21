import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Ico } from './icons.jsx'

/** A drag of a row that is going on. Positions are those of the page when the drag started. */
interface Drag {
	from: number
	to: number
	startY: number
	/** Where the rows were when the drag started */
	slots: { top: number, height: number }[]
	stop: () => void
}

interface Props<T> {
	items: T[]
	keyOf: (item: T) => string
	/** What a row is called, for the handle and for screen readers */
	nameOf: (item: T) => string
	render: (item: T, index: number) => ComponentChildren
	/** Puts the row at `from` at the place `to` */
	onMove: (from: number, to: number) => void
	/** What the list is, for screen readers */
	label: string
	/** Whether the rows cannot be moved */
	locked?: boolean
	/** Tells which row is the selected one, when rows can be selected */
	selected?: (item: T) => boolean
}
/** A list of rows that are put in another order by dragging their handle, or with the arrow keys on it */
export function SortableList<T>({ items, keyOf, nameOf, render, onMove, label, locked, selected }: Props<T>) {
	const list = useRef<HTMLOListElement>(null)
	const drag = useRef<Drag>()
	const [dragging, setDragging] = useState<{ from: number, to: number, delta: number, step: number }>()
	const [announcement, setAnnouncement] = useState('')
	const refocus = useRef<string>()
	const latest = useRef(onMove)
	latest.current = onMove

	useEffect(() => () => drag.current?.stop(), [])

	// The handle that moved a row with the keyboard keeps the focus
	const order = items.map(keyOf).join('\n')
	useEffect(() => {
		const key = refocus.current
		if (key === undefined) return
		refocus.current = undefined
		list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"] .gx-sort-handle`)?.focus()
	}, [order])

	const start = (e: PointerEvent, from: number) => {
		const el = list.current
		if (!el || e.button !== 0 || drag.current || locked) return
		e.preventDefault()
		const rows = Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-row]'))
		if (rows.length < 2) return
		const slots = rows.map(row => {
			const rect = row.getBoundingClientRect()
			return { top: rect.top, height: rect.height }
		})
		const step = slots[1].top - slots[0].top - slots[0].height + slots[from].height

		const onPointerMove = (ev: PointerEvent) => {
			const d = drag.current
			if (!d) return
			const me = d.slots[d.from]
			const last = d.slots[d.slots.length - 1]
			const delta = Math.max(d.slots[0].top - me.top, Math.min(last.top + last.height - me.top - me.height, ev.clientY - d.startY))
			// A row makes room once the dragged one covers half of it
			let to = d.from
			d.slots.forEach((slot, i) => {
				const middle = slot.top + slot.height / 2
				if (i < d.from && me.top + delta < middle) to = Math.min(to, i)
				if (i > d.from && me.top + me.height + delta > middle) to = Math.max(to, i)
			})
			d.to = to
			setDragging(prev => prev && prev.delta === delta && prev.to === to ? prev : { from: d.from, to, delta, step })
		}
		const finish = (commit: boolean) => {
			const d = drag.current
			if (!d) return
			d.stop()
			setDragging(undefined)
			if (commit && d.to !== d.from) latest.current(d.from, d.to)
		}
		const onPointerUp = () => finish(true)
		const onPointerCancel = () => finish(false)
		const onKeyDown = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape') return
			ev.preventDefault()
			finish(false)
		}
		window.addEventListener('pointermove', onPointerMove)
		window.addEventListener('pointerup', onPointerUp)
		window.addEventListener('pointercancel', onPointerCancel)
		window.addEventListener('keydown', onKeyDown, true)
		drag.current = {
			from, slots,
			to: from,
			startY: e.clientY,
			stop: () => {
				window.removeEventListener('pointermove', onPointerMove)
				window.removeEventListener('pointerup', onPointerUp)
				window.removeEventListener('pointercancel', onPointerCancel)
				window.removeEventListener('keydown', onKeyDown, true)
				drag.current = undefined
			},
		}
		setDragging({ from, to: from, delta: 0, step })
	}

	const moveWithKeys = (e: KeyboardEvent, item: T, index: number) => {
		if (locked || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
		e.preventDefault()
		const to = index + (e.key === 'ArrowUp' ? -1 : 1)
		if (to < 0 || to >= items.length) return
		refocus.current = keyOf(item)
		setAnnouncement(`${nameOf(item)} moved to place ${to + 1} of ${items.length}`)
		onMove(index, to)
	}

	return <>
		<ol ref={list} class={`gx-sort${dragging ? ' is-sorting' : ''}`} aria-label={label}>
			{items.map((item, index) => {
				const dragged = dragging?.from === index
				// The other rows step aside to show where the dragged one would land
				const offset = !dragging ? 0
					: dragged ? dragging.delta
						: index < dragging.from && index >= dragging.to ? dragging.step
							: index > dragging.from && index <= dragging.to ? -dragging.step : 0
				return <li key={keyOf(item)} data-row={keyOf(item)} class={`gx-sort-row${dragged ? ' is-dragged' : ''}${selected?.(item) ? ' is-selected' : ''}`}
					style={offset !== 0 ? { transform: `translateY(${offset}px)` } : undefined}>
					{!locked && <button type="button" class="gx-sort-handle" aria-label={`Move ${nameOf(item)}. Drag, or use the arrow keys.`}
						onPointerDown={e => start(e, index)} onKeyDown={(e: KeyboardEvent) => moveWithKeys(e, item, index)}>
						{Ico.grip}
					</button>}
					{render(item, index)}
				</li>
			})}
		</ol>
		<span class="gx-dtabs-status" role="status">{announcement}</span>
	</>
}
