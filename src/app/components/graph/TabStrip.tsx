import { Link } from 'preact-router'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Sub, TabRef } from './dimensions.js'
import { tabHref } from './dimensions.js'
import { Ico } from './icons.jsx'

/** What a tab is called: the name of an example, or the id of a dimension of your own */
export function tabLabel(tab: TabRef) {
	return tab.kind === 'example' ? tab.preset.label : tab.meta.id
}

/** How far the pointer moves before a press on a tab becomes a drag */
const DRAG_START = 6
/** How close to the ends of the strip a drag starts to scroll it, and how fast at most */
const SCROLL_ZONE = 40
const SCROLL_SPEED = 14

/** A drag of a tab that is going on. Positions are measured along the strip, so scrolling does not change them. */
interface Drag {
	id: string
	from: number
	/** The place it would get when it is let go now */
	to: number
	startX: number
	startScroll: number
	lastX: number
	/** Where the tabs were when the drag started */
	slots: { left: number, width: number }[]
	/** The room that a tab takes up, including the gap to the next one */
	step: number
	moved: boolean
	frame: number
	stop: () => void
}

interface Props {
	tabs: TabRef[]
	/** The id of the tab that is open, or nothing when the home tab is */
	active: string | undefined
	/** The view that a dimension opens in when its tab is chosen */
	sub: Sub
	/** The address of the home tab, which is the one of the version that the tabs are of */
	home: string
	onClose: (id: string) => void
	/** Puts a tab at another place among the dimension tabs. The home tab stays first. */
	onMove: (id: string, to: number) => void
}
/** The home tab and the dimensions that are open, like the tabs of documents in an editor */
export function TabStrip({ tabs, active, sub, home, onClose, onMove }: Props) {
	const strip = useRef<HTMLElement>(null)
	const drag = useRef<Drag>()
	// What is drawn of the drag: how far the tab is from where it started, and the place it would get
	const [dragging, setDragging] = useState<{ id: string, from: number, to: number, delta: number, step: number }>()
	// The tab that was moved with the keyboard keeps the focus, and its new place is read out
	const refocus = useRef<string>()
	const [announcement, setAnnouncement] = useState('')
	const latest = useRef({ tabs, onMove })
	latest.current = { tabs, onMove }

	// With many tabs the strip scrolls, the open one should not be out of sight
	useEffect(() => {
		strip.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [active, tabs.length])

	const order = tabs.map(tab => tab.id).join('\n')
	useEffect(() => {
		const id = refocus.current
		if (id === undefined) return
		refocus.current = undefined
		const link = strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"] .gx-dtab-link`)
		if (link && document.activeElement !== link) link.focus()
		link?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [order])

	useEffect(() => () => drag.current?.stop(), [])

	const startDrag = (e: PointerEvent, id: string) => {
		const nav = strip.current
		// Touch scrolls the strip instead. The close button is not a handle.
		if (!nav || e.button !== 0 || e.pointerType === 'touch' || drag.current) return
		if ((e.target as Element).closest('.gx-dtab-close')) return
		const elements = Array.from(nav.querySelectorAll<HTMLElement>('[data-tab]'))
		const from = elements.findIndex(el => el.dataset.tab === id)
		if (from < 0 || elements.length < 2) return
		const origin = nav.getBoundingClientRect().left - nav.scrollLeft
		const slots = elements.map(el => {
			const rect = el.getBoundingClientRect()
			return { left: rect.left - origin, width: rect.width }
		})

		const update = () => {
			const d = drag.current
			if (!d) return
			const me = d.slots[d.from]
			const last = d.slots[d.slots.length - 1]
			// The tab stays among the dimension tabs, so it never passes the home tab
			const delta = Math.max(d.slots[0].left - me.left, Math.min(last.left + last.width - me.left - me.width,
				d.lastX - d.startX + nav.scrollLeft - d.startScroll))
			// A tab makes room once the dragged one covers half of it
			let to = d.from
			d.slots.forEach((slot, i) => {
				const middle = slot.left + slot.width / 2
				if (i < d.from && me.left + delta < middle) to = Math.min(to, i)
				if (i > d.from && me.left + me.width + delta > middle) to = Math.max(to, i)
			})
			d.to = to
			setDragging(prev => prev && prev.delta === delta && prev.to === to ? prev : { id: d.id, from: d.from, to, delta, step: d.step })
		}

		// Near the ends the strip scrolls, so a tab can be brought to a place that is out of sight
		const scroll = () => {
			const d = drag.current
			if (!d) return
			d.frame = 0
			const rect = nav.getBoundingClientRect()
			const pull = d.lastX < rect.left + SCROLL_ZONE ? (d.lastX - rect.left - SCROLL_ZONE) / SCROLL_ZONE
				: d.lastX > rect.right - SCROLL_ZONE ? (d.lastX - rect.right + SCROLL_ZONE) / SCROLL_ZONE : 0
			if (pull === 0) return
			const before = nav.scrollLeft
			nav.scrollLeft += Math.max(-1, Math.min(1, pull)) * SCROLL_SPEED
			if (nav.scrollLeft === before) return
			update()
			d.frame = requestAnimationFrame(scroll)
		}

		const onPointerMove = (ev: PointerEvent) => {
			const d = drag.current
			if (!d) return
			d.lastX = ev.clientX
			if (!d.moved) {
				if (Math.abs(ev.clientX - d.startX) < DRAG_START) return
				d.moved = true
			}
			update()
			if (d.frame === 0) d.frame = requestAnimationFrame(scroll)
		}
		const finish = (commit: boolean) => {
			const d = drag.current
			if (!d) return
			d.stop()
			setDragging(undefined)
			if (!d.moved) return
			// Letting go of a tab that was dragged does not also open it
			const swallow = (ev: MouseEvent) => {
				ev.preventDefault()
				ev.stopPropagation()
			}
			window.addEventListener('click', swallow, { capture: true, once: true })
			setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
			if (commit && d.to !== d.from) latest.current.onMove(d.id, d.to)
		}
		const onPointerUp = () => finish(true)
		const onPointerCancel = () => finish(false)
		const onKeyDown = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape' || !drag.current?.moved) return
			ev.preventDefault()
			finish(false)
		}
		window.addEventListener('pointermove', onPointerMove)
		window.addEventListener('pointerup', onPointerUp)
		window.addEventListener('pointercancel', onPointerCancel)
		window.addEventListener('keydown', onKeyDown, true)

		drag.current = {
			id, from, slots,
			to: from,
			startX: e.clientX,
			lastX: e.clientX,
			startScroll: nav.scrollLeft,
			step: slots.length > 1 ? slots[1].left - slots[0].left - slots[0].width + slots[from].width : slots[from].width,
			moved: false,
			frame: 0,
			stop: () => {
				window.removeEventListener('pointermove', onPointerMove)
				window.removeEventListener('pointerup', onPointerUp)
				window.removeEventListener('pointercancel', onPointerCancel)
				window.removeEventListener('keydown', onKeyDown, true)
				if (drag.current?.frame) cancelAnimationFrame(drag.current.frame)
				drag.current = undefined
			},
		}
	}

	const moveWithKeys = (e: KeyboardEvent, tab: TabRef, index: number) => {
		if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
		e.preventDefault()
		const to = index + (e.key === 'ArrowLeft' ? -1 : 1)
		if (to < 0 || to >= tabs.length) return
		refocus.current = tab.id
		setAnnouncement(`${tabLabel(tab)} moved to place ${to + 1} of ${tabs.length}`)
		onMove(tab.id, to)
	}

	return <nav ref={strip} class={`gx-dtabs${dragging ? ' is-sorting' : ''}`} aria-label="Open dimensions"
		onWheel={e => {
			// A mouse wheel moves through the tabs when they do not fit
			if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY
		}}>
		<div class={`gx-dtab gx-dtab-home${active === undefined ? ' is-active' : ''}`}>
			<Link class="gx-dtab-link" href={home} draggable={false} aria-current={active === undefined ? 'page' : undefined}>
				{Ico.home}
				<span class="gx-dtab-name">Home</span>
			</Link>
		</div>
		{tabs.map((tab, index) => {
			const label = tabLabel(tab)
			const locked = tab.kind === 'example'
			const description = `${label}, ${locked ? 'read-only example' : 'your dimension'} for Minecraft ${tab.version.label}`
			const dragged = dragging?.id === tab.id
			// The other tabs step aside to show where the dragged one would land
			const offset = !dragging ? 0
				: dragged ? dragging.delta
					: index < dragging.from && index >= dragging.to ? dragging.step
						: index > dragging.from && index <= dragging.to ? -dragging.step : 0
			return <div key={tab.id} data-tab={tab.id} class={`gx-dtab${tab.id === active ? ' is-active' : ''}${dragged ? ' is-dragged' : ''}`} title={dragging ? undefined : description}
				style={offset !== 0 ? { transform: `translateX(${offset}px)` } : undefined}
				onPointerDown={e => startDrag(e, tab.id)}
				onMouseDown={e => {
					// The middle button closes the tab instead of starting to scroll
					if (e.button === 1) e.preventDefault()
				}}
				onMouseUp={e => {
					if (e.button === 1) onClose(tab.id)
				}}>
				<Link class="gx-dtab-link" href={tabHref(tab, sub)} draggable={false} aria-current={tab.id === active ? 'page' : undefined} aria-label={description}
					aria-keyshortcuts="Control+Shift+ArrowLeft Control+Shift+ArrowRight"
					onKeyDown={(e: KeyboardEvent) => moveWithKeys(e, tab, index)}>
					{locked ? Ico.lock : Ico.globe}
					<span class="gx-dtab-name">{label}</span>
				</Link>
				<button type="button" class="gx-dtab-close" aria-label={`Close ${label}`} onClick={() => onClose(tab.id)}>
					{Ico.close}
				</button>
			</div>
		})}
		<span class="gx-dtabs-status" role="status">{announcement}</span>
	</nav>
}
