import { memo } from 'preact/compat'
import type { MutableRef } from 'preact/hooks'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { readClip, writeClip } from './clipboard.js'
import type { Rect } from './geometry.js'
import { absolute, arrowPath, clamp, docBounds, edgePath, GRID, intersects, snapToGrid } from './geometry.js'
import { Ico } from './icons.jsx'
import type { MenuItem } from './Palette.jsx'
import { Menu, Palette } from './Palette.jsx'
import type { GraphStore } from './store.js'
import { connect, indexLinks, newId, removeNodes, useStore, wouldCycle } from './store.js'
import type { GDoc, GEdge, GNode, GraphKind, LinkEnd, NodeLinks, PaletteItem, View } from './types.js'
import { NO_LINKS } from './types.js'
import { IconButton } from './ui.jsx'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 2.5
const DRAG_THRESHOLD = 3
const PALETTE_SIZE = { w: 300, h: 380 }

export interface CanvasApi {
	fit(): void
	zoomBy(factor: number): void
	openPalette(): void
	reveal(id: string): void
	focus(): void
	/** Copies the selected nodes, except those that every graph has exactly one of */
	copy(): void
	cut(): void
	/** Adds the nodes that were copied last to the middle of the view */
	paste(): void
}

/** Remembers the viewport of a canvas while it is not mounted */
export interface ViewMemo {
	view?: View
	epoch?: number
}

type Drag =
	| { type: 'pan', sx: number, sy: number, vx: number, vy: number, moved: boolean, keep?: boolean }
	| { type: 'marquee', x0: number, y0: number, base: string[] }
	| { type: 'move', sx: number, sy: number, id: string, starts?: Map<string, { x: number, y: number }>, collapse: boolean }
	| { type: 'link', sx: number, sy: number, fixed: LinkEnd, detached: boolean, moved: boolean }

interface LinkState {
	fixed: LinkEnd
	x: number
	y: number
	target?: { node: string, port: string }
}

interface PaletteState {
	x: number
	y: number
	wx: number
	wy: number
	pending?: LinkEnd
}

interface MenuState {
	x: number
	y: number
	items: MenuItem[]
}

interface Props {
	store: GraphStore
	kind: GraphKind
	label: string
	/** Which graphs nodes can be copied from and to: those with the same type */
	clipType: string
	apiRef?: MutableRef<CanvasApi | undefined>
	viewMemo?: ViewMemo
	/** When the whole graph does not fit at this zoom level, the first view shows only a part of it */
	/** Whether nodes that are placed or moved end up on the dots of the background */
	snap?: boolean
	minInitialZoom?: number
	/** Which part to show in that case */
	anchor?: 'start' | 'end'
}
export function GraphCanvas({ store, kind, label, clipType, apiRef, viewMemo, snap, minInitialZoom, anchor = 'start' }: Props) {
	const snapRef = useRef(snap)
	snapRef.current = snap
	useStore(store)
	const { readOnly } = store
	const root = useRef<HTMLDivElement>(null)
	const [view, setViewState] = useState<View>(viewMemo?.view ?? { x: 0, y: 0, k: 1 })
	const viewRef = useRef(view)
	const [size, setSize] = useState({ w: 0, h: 0 })
	const sizeRef = useRef(size)
	const [marquee, setMarquee] = useState<Rect>()
	const [link, setLink] = useState<LinkState>()
	const linkRef = useRef<LinkState>()
	const [palette, setPalette] = useState<PaletteState>()
	const [menu, setMenu] = useState<MenuState>()
	const [panning, setPanning] = useState(false)
	const [announcement, setAnnouncement] = useState('')
	const [toast, setToast] = useState<string>()
	const drag = useRef<Drag>()
	const animation = useRef<number>()
	const spaceDown = useRef(false)
	const lastClick = useRef({ time: 0, x: 0, y: 0 })
	const fittedEpoch = useRef<number>()

	const doc = store.doc
	const links = useMemo(() => indexLinks(doc), [doc.edges])
	const nodeMap = useMemo(() => new Map(doc.nodes.map(n => [n.id, n])), [doc.nodes])
	const selected = useMemo(() => new Set(store.selection), [store.selection])

	const setView = useCallback((next: View) => {
		viewRef.current = next
		if (viewMemo) viewMemo.view = next
		setViewState(next)
	}, [viewMemo])

	const cancelAnimation = useCallback(() => {
		if (animation.current !== undefined) {
			cancelAnimationFrame(animation.current)
			animation.current = undefined
		}
	}, [])

	const animateTo = useCallback((target: View) => {
		cancelAnimation()
		const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
		if (reduceMotion) {
			setView(target)
			return
		}
		const from = viewRef.current
		const start = performance.now()
		const duration = 220
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / duration)
			const e = 1 - Math.pow(1 - t, 3)
			setView({
				x: from.x + (target.x - from.x) * e,
				y: from.y + (target.y - from.y) * e,
				k: from.k + (target.k - from.k) * e,
			})
			animation.current = t < 1 ? requestAnimationFrame(tick) : undefined
		}
		animation.current = requestAnimationFrame(tick)
	}, [setView, cancelAnimation])

	const computeFit = useCallback((): View | undefined => {
		const bounds = docBounds(store.doc, kind)
		const { w, h } = sizeRef.current
		if (!bounds || w === 0 || h === 0) return undefined
		const padX = Math.min(40, w * 0.06)
		const padTop = Math.min(40, h * 0.06)
		const padBottom = padTop + 44
		const k = clamp(Math.min((w - padX * 2) / bounds.w, (h - padTop - padBottom) / bounds.h), MIN_ZOOM, 1)
		return {
			k,
			x: Math.round((w - bounds.w * k) / 2 - bounds.x * k),
			y: Math.round(padTop + (h - padTop - padBottom - bounds.h * k) / 2 - bounds.y * k),
		}
	}, [store, kind])

	const zoomAt = useCallback((px: number, py: number, factor: number, animate = false) => {
		const v = viewRef.current
		const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM)
		if (k === v.k) return
		const ratio = k / v.k
		const next = { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio }
		if (animate) animateTo(next)
		else setView(next)
	}, [animateTo, setView])

	const toWorld = useCallback((clientX: number, clientY: number) => {
		const rect = root.current!.getBoundingClientRect()
		const v = viewRef.current
		return {
			px: clientX - rect.left,
			py: clientY - rect.top,
			x: (clientX - rect.left - v.x) / v.k,
			y: (clientY - rect.top - v.y) / v.k,
		}
	}, [])

	const reveal = useCallback((id: string) => {
		const node = store.node(id)
		if (!node) return
		const { w, h } = sizeRef.current
		const v = viewRef.current
		const nodeSize = kind.size(node)
		const margin = 40
		const left = node.x * v.k + v.x
		const top = node.y * v.k + v.y
		const right = left + nodeSize.w * v.k
		const bottom = top + nodeSize.h * v.k
		let dx = 0
		let dy = 0
		if (left < margin) dx = margin - left
		else if (right > w - margin) dx = Math.max(w - margin - right, margin - left)
		if (top < margin) dy = margin - top
		else if (bottom > h - margin) dy = Math.max(h - margin - bottom, margin - top)
		if (dx !== 0 || dy !== 0) {
			animateTo({ k: v.k, x: v.x + dx, y: v.y + dy })
		}
	}, [store, kind, animateTo])

	const openPaletteAt = useCallback((px: number, py: number, pending?: LinkEnd) => {
		const { w, h } = sizeRef.current
		const v = viewRef.current
		setMenu(undefined)
		setPalette({
			x: clamp(px, 8, Math.max(8, w - PALETTE_SIZE.w - 8)),
			y: clamp(py, 8, Math.max(8, h - PALETTE_SIZE.h - 8)),
			wx: (px - v.x) / v.k,
			wy: (py - v.y) / v.k,
			pending,
		})
	}, [])

	// A short message that confirms what a shortcut did
	useEffect(() => {
		if (toast === undefined) return
		const timeout = setTimeout(() => setToast(undefined), 2200)
		return () => clearTimeout(timeout)
	}, [toast])
	const tell = (message: string) => {
		setAnnouncement(message)
		setToast(message)
	}

	const copy = () => {
		// The output of a density graph and the start of a rule stay where they are
		const picked = new Set(store.selection.filter(id => {
			const node = store.node(id)
			return node !== undefined && kind.deletable(node)
		}))
		if (picked.size === 0) {
			tell(store.selection.length > 0 ? 'This node cannot be copied' : 'Select nodes to copy them')
			return false
		}
		writeClip(clipType, store.doc.nodes.filter(n => picked.has(n.id)), store.doc.edges.filter(e => picked.has(e.from) && picked.has(e.to)))
		tell(`Copied ${picked.size} node${picked.size === 1 ? '' : 's'}`)
		return true
	}

	const paste = () => {
		const clip = readClip()
		if (readOnly) {
			tell('Presets cannot be changed. Paste into Custom instead.')
			return
		}
		if (!clip || clip.nodes.length === 0) {
			tell('Nothing was copied yet')
			return
		}
		if (clip.type !== clipType) {
			tell('The copied nodes are from another kind of graph or another version')
			return
		}
		const bounds = docBounds({ nodes: clip.nodes, edges: [] }, kind)!
		const v = viewRef.current
		// The copies go to the middle of the view, a step further for every time they are pasted again
		let dx = (sizeRef.current.w / 2 - v.x) / v.k - (bounds.x + bounds.w / 2) + clip.pastes * GRID
		let dy = (sizeRef.current.h / 2 - v.y) / v.k - (bounds.y + bounds.h / 2) + clip.pastes * GRID
		// Where that would cover nodes that are already there, the copies go next to the graph instead:
		// before it when it flows to the right, and under it when it flows down
		const existing = docBounds(store.doc, kind)
		const aside = existing !== undefined && intersects({ x: bounds.x + dx, y: bounds.y + dy, w: bounds.w, h: bounds.h }, existing)
		if (aside && kind.edgeStyle === 'step') {
			dx = existing.x - bounds.x
			dy = existing.y + existing.h + GRID * 2 - bounds.y
		} else if (aside) {
			dx = existing.x - GRID * 2 - (bounds.x + bounds.w)
			dy = existing.y + existing.h / 2 - (bounds.y + bounds.h / 2)
		}
		clip.pastes += 1
		const ids = new Map(clip.nodes.map(n => [n.id, newId()]))
		// Pasted nodes start on the dots of the background, like those of the presets that they come from
		const nodes: GNode[] = clip.nodes.map(n => ({ ...n, id: ids.get(n.id)!, x: snapToGrid(n.x + dx), y: snapToGrid(n.y + dy), data: structuredClone(n.data) }))
		const edges: GEdge[] = clip.edges.map(e => ({ ...e, id: newId('e'), from: ids.get(e.from)!, to: ids.get(e.to)! }))
		store.setDoc({ nodes: [...store.doc.nodes, ...nodes], edges: [...store.doc.edges, ...edges] })
		store.select(nodes.map(n => n.id))
		tell(`Pasted ${nodes.length} node${nodes.length === 1 ? '' : 's'}`)
		if (aside) {
			// They may be out of view there, so show the whole graph
			const fit = computeFit()
			if (fit) animateTo(fit)
		}
	}

	const cut = () => {
		if (readOnly) {
			tell('Presets cannot be changed')
		} else if (copy()) {
			store.deleteSelection(kind)
		}
	}

	// The toolbar and the keyboard use what was rendered last
	const actions = useRef({ copy, cut, paste })
	actions.current = { copy, cut, paste }

	useEffect(() => {
		if (!apiRef) return
		apiRef.current = {
			copy: () => {
				actions.current.copy()
			},
			cut: () => actions.current.cut(),
			paste: () => actions.current.paste(),
			fit: () => {
				const target = computeFit()
				if (target) animateTo(target)
			},
			zoomBy: factor => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, factor, true),
			openPalette: () => openPaletteAt(sizeRef.current.w / 2 - PALETTE_SIZE.w / 2, Math.max(24, sizeRef.current.h / 2 - PALETTE_SIZE.h / 2)),
			reveal,
			focus: () => root.current?.focus({ preventScroll: true }),
		}
		return () => {
			apiRef.current = undefined
		}
	}, [apiRef, computeFit, animateTo, zoomAt, openPaletteAt, reveal])

	// Track the size of the canvas
	useLayoutEffect(() => {
		const el = root.current
		if (!el) return
		const update = () => {
			const next = { w: el.clientWidth, h: el.clientHeight }
			if (next.w !== sizeRef.current.w || next.h !== sizeRef.current.h) {
				sizeRef.current = next
				setSize(next)
			}
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// Frame the whole graph the first time it is shown, and again when a new document is loaded
	useLayoutEffect(() => {
		if (size.w === 0 || size.h === 0) return
		const fitted = viewMemo ? viewMemo.epoch : fittedEpoch.current
		if (fitted === store.epoch) return
		let target = computeFit()
		const bounds = docBounds(store.doc, kind)
		if (!target || !bounds) return
		if (minInitialZoom !== undefined && target.k < minInitialZoom) {
			const k = minInitialZoom
			const padX = Math.min(64, size.w * 0.08)
			target = {
				k,
				x: Math.round(anchor === 'start' ? padX - bounds.x * k : size.w - padX - (bounds.x + bounds.w) * k),
				y: Math.round(anchor === 'start' ? 40 - bounds.y * k : size.h / 2 - (bounds.y + bounds.h / 2) * k),
			}
		}
		if (viewMemo) viewMemo.epoch = store.epoch
		fittedEpoch.current = store.epoch
		setView(target)
	}, [size.w, size.h, store.epoch, doc.nodes.length === 0])

	// Zoom around the cursor
	useEffect(() => {
		const el = root.current
		if (!el) return
		const onWheel = (e: WheelEvent) => {
			if ((e.target as HTMLElement).closest('.gx-pop')) return
			e.preventDefault()
			cancelAnimation()
			const rect = el.getBoundingClientRect()
			let delta = e.deltaY
			if (e.deltaMode === 1) delta *= 32
			else if (e.deltaMode === 2) delta *= 400
			zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0016)))
		}
		// Focusing something off-screen makes the browser scroll the container, undo that
		const onScroll = () => {
			if (el.scrollLeft !== 0 || el.scrollTop !== 0) {
				el.scrollLeft = 0
				el.scrollTop = 0
			}
		}
		el.addEventListener('wheel', onWheel, { passive: false })
		el.addEventListener('scroll', onScroll)
		return () => {
			el.removeEventListener('wheel', onWheel)
			el.removeEventListener('scroll', onScroll)
		}
	}, [zoomAt, cancelAnimation])

	useEffect(() => {
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.code === 'Space') spaceDown.current = false
		}
		const onBlur = () => spaceDown.current = false
		window.addEventListener('keyup', onKeyUp)
		window.addEventListener('blur', onBlur)
		return () => {
			window.removeEventListener('keyup', onKeyUp)
			window.removeEventListener('blur', onBlur)
			cancelAnimation()
		}
	}, [cancelAnimation])

	const findLinkTarget = (fixed: LinkEnd, clientX: number, clientY: number) => {
		const el = document.elementFromPoint(clientX, clientY)
		const nodeEl = el?.closest<HTMLElement>('[data-node]')
		if (!nodeEl || !root.current?.contains(nodeEl)) return undefined
		const id = nodeEl.dataset.node!
		const node = store.node(id)
		if (!node || id === fixed.node) return undefined
		const portEl = el?.closest<HTMLElement>('[data-port]')
		const nodeLinks = links.get(id) ?? NO_LINKS
		if (fixed.dir === 'out') {
			const port = portEl?.dataset.dir === 'in' ? portEl.dataset.port : kind.defaultIn(node, nodeLinks)
			if (port === undefined || wouldCycle(store.doc, fixed.node, id)) return undefined
			return { node: id, port }
		}
		const port = portEl?.dataset.dir === 'out' ? portEl.dataset.port : kind.defaultOut(node, nodeLinks)
		if (port === undefined || wouldCycle(store.doc, id, fixed.node)) return undefined
		return { node: id, port }
	}

	const onPointerDown = (e: PointerEvent) => {
		const target = e.target as HTMLElement
		if (target.closest('.gx-pop, .gx-overlay')) return
		if (palette) setPalette(undefined)
		if (menu) setMenu(undefined)
		if (e.button === 2) return
		const nodeEl = target.closest<HTMLElement>('[data-node]')
		const portEl = target.closest<HTMLElement>('[data-port]')
		const edgeEl = target.closest<SVGElement>('[data-edge]')
		const control = target.closest('input, select, textarea, button, a, [data-nodrag]')
		if (control && !portEl) {
			const id = nodeEl?.dataset.node
			if (id && !store.selection.includes(id)) store.select([id])
			return
		}
		cancelAnimation()
		const additive = e.shiftKey || e.ctrlKey || e.metaKey
		const world = toWorld(e.clientX, e.clientY)
		if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
			e.preventDefault()
			drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: true }
			setPanning(true)
		} else if (e.button !== 0) {
			return
		} else if (portEl && nodeEl && !readOnly) {
			const id = nodeEl.dataset.node!
			const port = portEl.dataset.port!
			let fixed: LinkEnd = { node: id, port, dir: portEl.dataset.dir === 'in' ? 'in' : 'out' }
			let detached = false
			if (fixed.dir === 'in' && kind.maxIn === 1) {
				// Grabbing a connected input picks up the existing connection
				const existing = links.get(id)?.ins[port]?.[0]
				if (existing) {
					store.beginTransient()
					store.setTransient(removeNodes(store.doc, [], [existing.id]))
					fixed = { node: existing.from, port: existing.fromPort, dir: 'out' }
					detached = true
				}
			}
			drag.current = { type: 'link', sx: e.clientX, sy: e.clientY, fixed, detached, moved: false }
			linkRef.current = { fixed, x: world.x, y: world.y }
			setLink(linkRef.current)
		} else if (nodeEl) {
			const id = nodeEl.dataset.node!
			const wasSelected = store.selection.includes(id)
			if (additive) {
				store.toggle(id)
				if (wasSelected) return
			} else if (!wasSelected) {
				store.select([id])
			}
			// Nodes of a preset stay where they are, so dragging one moves the view instead
			drag.current = readOnly
				? { type: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false, keep: true }
				: { type: 'move', sx: e.clientX, sy: e.clientY, id, collapse: wasSelected && !additive }
		} else if (edgeEl) {
			const id = edgeEl.dataset.edge!
			if (additive) {
				store.select(store.selection, store.edgeSelection.includes(id) ? store.edgeSelection.filter(s => s !== id) : [...store.edgeSelection, id])
			} else {
				store.select([], [id])
			}
			return
		} else if (e.shiftKey) {
			drag.current = { type: 'marquee', x0: world.x, y0: world.y, base: store.selection }
			setMarquee({ x: world.x, y: world.y, w: 0, h: 0 })
		} else {
			drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false }
		}
		try {
			root.current?.setPointerCapture(e.pointerId)
		} catch (error) {
			// The pointer is already gone, the drag still works without capture
		}
	}

	const onPointerMove = (e: PointerEvent) => {
		const d = drag.current
		if (!d) return
		if (d.type === 'pan') {
			const dx = e.clientX - d.sx
			const dy = e.clientY - d.sy
			if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
			if (!d.moved) {
				d.moved = true
				setPanning(true)
			}
			setView({ k: viewRef.current.k, x: d.vx + dx, y: d.vy + dy })
		} else if (d.type === 'move') {
			const dx = e.clientX - d.sx
			const dy = e.clientY - d.sy
			if (!d.starts) {
				if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
				d.starts = new Map(store.doc.nodes.filter(n => store.selection.includes(n.id)).map(n => [n.id, { x: n.x, y: n.y }]))
				store.beginTransient()
			}
			const k = viewRef.current.k
			const starts = d.starts
			let mx = dx / k
			let my = dy / k
			const grabbed = starts.get(d.id)
			if (snapRef.current && grabbed) {
				// The node under the cursor lands on the grid, the rest of the selection keeps its place relative to it
				mx = snapToGrid(grabbed.x + mx) - grabbed.x
				my = snapToGrid(grabbed.y + my) - grabbed.y
			}
			store.setTransient({
				nodes: store.doc.nodes.map(n => {
					const start = starts.get(n.id)
					return start ? { ...n, x: Math.round(start.x + mx), y: Math.round(start.y + my) } : n
				}),
				edges: store.doc.edges,
			})
		} else if (d.type === 'marquee') {
			const world = toWorld(e.clientX, e.clientY)
			const rect = { x: Math.min(d.x0, world.x), y: Math.min(d.y0, world.y), w: Math.abs(world.x - d.x0), h: Math.abs(world.y - d.y0) }
			setMarquee(rect)
			const hits = store.doc.nodes.filter(n => {
				const s = kind.size(n)
				return intersects(rect, { x: n.x, y: n.y, w: s.w, h: s.h })
			}).map(n => n.id)
			store.select([...d.base.filter(id => !hits.includes(id)), ...hits])
		} else if (d.type === 'link') {
			if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= DRAG_THRESHOLD) d.moved = true
			const world = toWorld(e.clientX, e.clientY)
			linkRef.current = { fixed: d.fixed, x: world.x, y: world.y, target: findLinkTarget(d.fixed, e.clientX, e.clientY) }
			setLink(linkRef.current)
		}
	}

	const endDrag = (e: PointerEvent, cancelled: boolean) => {
		const d = drag.current
		drag.current = undefined
		if (!d) return
		if (root.current?.hasPointerCapture(e.pointerId)) root.current.releasePointerCapture(e.pointerId)
		if (d.type === 'pan') {
			setPanning(false)
			if (!d.moved && !cancelled && !d.keep) {
				store.select([])
				// Double click on the background adds a node
				const now = performance.now()
				const last = lastClick.current
				if (!readOnly && now - last.time < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 8) {
					const world = toWorld(e.clientX, e.clientY)
					openPaletteAt(world.px, world.py)
					lastClick.current = { time: 0, x: 0, y: 0 }
				} else {
					lastClick.current = { time: now, x: e.clientX, y: e.clientY }
				}
			}
		} else if (d.type === 'move') {
			if (d.starts) {
				if (cancelled) store.cancelTransient()
				else store.endTransient()
			} else if (d.collapse && !cancelled) {
				store.select([d.id])
			}
		} else if (d.type === 'marquee') {
			setMarquee(undefined)
		} else if (d.type === 'link') {
			const target = cancelled ? undefined : linkRef.current?.target
			linkRef.current = undefined
			setLink(undefined)
			if (target) {
				const next = d.fixed.dir === 'out'
					? connect(store.doc, kind, d.fixed.node, d.fixed.port, target.node, target.port)
					: connect(store.doc, kind, target.node, target.port, d.fixed.node, d.fixed.port)
				if (d.detached) {
					store.setTransient(next)
					store.endTransient()
				} else {
					store.setDoc(next)
				}
				setAnnouncement('Connected')
			} else if (d.detached) {
				if (cancelled) store.cancelTransient()
				else {
					store.endTransient()
					setAnnouncement('Disconnected')
				}
			} else if (d.moved && !cancelled) {
				// Dropping a link on empty space offers to create a node there
				const el = document.elementFromPoint(e.clientX, e.clientY)
				if (!el?.closest('[data-node]')) {
					const world = toWorld(e.clientX, e.clientY)
					openPaletteAt(world.px, world.py, d.fixed)
				}
			}
		}
	}

	const addNode = (item: PaletteItem, state: PaletteState) => {
		const node: GNode = { id: newId(), x: 0, y: 0, ...kind.create(item.type) }
		const nodeSize = kind.size(node)
		const pending = state.pending
		if (!pending) {
			node.x = state.wx - nodeSize.w / 2
			node.y = state.wy - nodeSize.h / 2
		} else if (pending.dir === 'in') {
			node.x = state.wx - nodeSize.w
			node.y = state.wy - 18
		} else {
			const source = store.node(pending.node)
			const side = source ? kind.outPos(source, pending.port).side : 'right'
			node.x = side === 'bottom' ? state.wx - nodeSize.w / 2 : state.wx
			node.y = side === 'bottom' ? state.wy : state.wy - 18
		}
		node.x = snapRef.current ? snapToGrid(node.x) : Math.round(node.x)
		node.y = snapRef.current ? snapToGrid(node.y) : Math.round(node.y)
		let next: GDoc = { nodes: [...store.doc.nodes, node], edges: store.doc.edges }
		if (pending) {
			if (pending.dir === 'out') {
				const port = kind.defaultIn(node, NO_LINKS)
				if (port !== undefined) next = connect(next, kind, pending.node, pending.port, node.id, port)
			} else {
				const port = kind.defaultOut(node, NO_LINKS)
				if (port !== undefined) next = connect(next, kind, node.id, port, pending.node, pending.port)
			}
		}
		store.setDoc(next)
		store.select([node.id])
		setPalette(undefined)
		setAnnouncement(`Added ${item.label} node`)
		root.current?.focus({ preventScroll: true })
	}

	const deleteSelection = () => {
		const count = store.selection.length + store.edgeSelection.length
		if (count === 0 || readOnly) return
		store.deleteSelection(kind)
		setAnnouncement('Deleted selection')
	}

	const onContextMenu = (e: MouseEvent) => {
		const target = e.target as HTMLElement
		if (target.closest('.gx-pop, .gx-overlay, input, textarea')) return
		e.preventDefault()
		const world = toWorld(e.clientX, e.clientY)
		const nodeEl = target.closest<HTMLElement>('[data-node]')
		const edgeEl = target.closest<SVGElement>('[data-edge]')
		setPalette(undefined)
		if (nodeEl) {
			const id = nodeEl.dataset.node!
			if (!store.selection.includes(id)) store.select([id])
			const node = store.node(id)
			const canDelete = store.selection.some(s => {
				const n = store.node(s)
				return n && kind.deletable(n)
			})
			const attached = store.doc.edges.filter(edge => store.selection.includes(edge.from) || store.selection.includes(edge.to)).map(edge => edge.id)
			setMenu({
				x: clamp(world.px, 8, sizeRef.current.w - 216),
				y: clamp(world.py, 8, sizeRef.current.h - 150),
				items: [
					{ label: 'Copy', icon: Ico.copy, shortcut: 'Ctrl+C', disabled: !canDelete, onSelect: copy },
					...(readOnly ? [] : [
						{ label: 'Duplicate', icon: Ico.duplicate, shortcut: 'Ctrl+D', disabled: !canDelete, onSelect: () => store.duplicateSelection(kind) },
						{ label: 'Disconnect', icon: Ico.unlink, disabled: attached.length === 0, onSelect: () => store.disconnect(attached) },
						{ label: 'Delete', icon: Ico.trash, shortcut: 'Del', danger: true, disabled: !canDelete || !node, onSelect: deleteSelection },
					]),
				],
			})
		} else if (readOnly) {
			setMenu(undefined)
		} else if (edgeEl) {
			const id = edgeEl.dataset.edge!
			store.select([], [id])
			setMenu({
				x: clamp(world.px, 8, sizeRef.current.w - 216),
				y: clamp(world.py, 8, sizeRef.current.h - 60),
				items: [{ label: 'Delete connection', icon: Ico.trash, shortcut: 'Del', danger: true, onSelect: () => store.disconnect([id]) }],
			})
		} else {
			setMenu(undefined)
			openPaletteAt(world.px, world.py)
		}
	}

	const onKeyDown = (e: KeyboardEvent) => {
		const target = e.target as HTMLElement
		if (target.closest('.gx-pop')) return
		const typing = target.matches('input, textarea, select, [contenteditable="true"]')
		if (typing) {
			if (e.key === 'Escape') {
				target.blur()
				root.current?.focus({ preventScroll: true })
			}
			return
		}
		const mod = e.ctrlKey || e.metaKey
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
		const center = { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 }
		let handled = true
		if (e.code === 'Space' && !mod) {
			spaceDown.current = true
		} else if (key === 'Delete' || key === 'Backspace') {
			deleteSelection()
		} else if (key === 'Escape') {
			if (drag.current?.type === 'link') {
				handled = true
			} else if (palette || menu) {
				setPalette(undefined)
				setMenu(undefined)
			} else {
				store.select([])
			}
		} else if (mod && key === 'z') {
			if (e.shiftKey) store.redo()
			else store.undo()
		} else if (mod && key === 'y') {
			store.redo()
		} else if (mod && key === 'a') {
			store.select(store.doc.nodes.map(n => n.id))
		} else if (mod && key === 'd') {
			store.duplicateSelection(kind)
		} else if (mod && key === 'c') {
			copy()
		} else if (mod && key === 'x') {
			cut()
		} else if (mod && key === 'v') {
			paste()
		} else if (mod && key === '0') {
			zoomAt(center.x, center.y, 1 / viewRef.current.k, true)
		} else if (mod) {
			handled = false
		} else if (key === 'a' || key === 'n') {
			if (!readOnly) openPaletteAt(center.x - PALETTE_SIZE.w / 2, Math.max(24, center.y - PALETTE_SIZE.h / 2))
		} else if (key === 'f') {
			const fit = computeFit()
			if (fit) animateTo(fit)
		} else if (key === '+' || key === '=') {
			zoomAt(center.x, center.y, 1.25, true)
		} else if (key === '-' || key === '_') {
			zoomAt(center.x, center.y, 0.8, true)
		} else if (key === '0' || key === '1') {
			zoomAt(center.x, center.y, 1 / viewRef.current.k, true)
		} else if (key.startsWith('Arrow')) {
			const snapping = snapRef.current && !e.shiftKey
			const amount = e.shiftKey ? 1 : snapping ? GRID : 16
			const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
			const dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
			if (store.selection.length > 0 && !readOnly) {
				const moving = new Set(store.selection)
				const move = (value: number, direction: number) => direction === 0 ? value
					: snapping ? snapToGrid(value + direction * amount) : value + direction * amount
				store.setDoc({
					nodes: store.doc.nodes.map(n => moving.has(n.id) ? { ...n, x: move(n.x, dx), y: move(n.y, dy) } : n),
					edges: store.doc.edges,
				}, { coalesce: 'nudge' })
			} else {
				const v = viewRef.current
				setView({ k: v.k, x: v.x - dx * 48, y: v.y - dy * 48 })
			}
		} else {
			handled = false
		}
		if (handled) e.preventDefault()
	}

	const onNodeFocus = useCallback((id: string) => {
		// Only keyboard focus should move the selection and viewport
		if (drag.current) return
		if (!store.selection.includes(id)) store.select([id])
		reveal(id)
	}, [store, reveal])

	const paletteItems = useMemo(() => {
		if (!palette?.pending) return kind.palette
		return kind.palette.filter(item => palette.pending!.dir === 'out' ? item.hasInputs : item.hasOutput)
	}, [kind, palette?.pending])

	const grid = useMemo(() => {
		let g = GRID * view.k
		while (g < 14) g *= 2
		return g
	}, [view.k])

	const tempLink = useMemo(() => {
		if (!link) return undefined
		const fixedNode = nodeMap.get(link.fixed.node)
		if (!fixedNode) return undefined
		const targetNode = link.target ? nodeMap.get(link.target.node) : undefined
		if (link.fixed.dir === 'out') {
			const s = absolute(fixedNode, kind.outPos(fixedNode, link.fixed.port))
			const t = targetNode
				? absolute(targetNode, kind.inPos(targetNode, link.target!.port, link.fixed.port))
				: { x: link.x, y: link.y, side: s.side === 'bottom' ? 'top' as const : 'left' as const }
			return edgePath(kind.edgeStyle, s, t)
		}
		const t = absolute(fixedNode, kind.inPos(fixedNode, link.fixed.port, 'out'))
		const s = targetNode
			? absolute(targetNode, kind.outPos(targetNode, link.target!.port))
			: { x: link.x, y: link.y, side: 'right' as const }
		return edgePath(kind.edgeStyle, s, t)
	}, [link, nodeMap, kind])

	return <div ref={root} class={`gx-canvas${panning ? ' is-panning' : ''}${link ? ' is-linking' : ''}${readOnly ? ' is-readonly' : ''}`} tabIndex={0} role="group"
		aria-label={readOnly
			? `${label}, read-only. ${doc.nodes.length} nodes. Press Tab to move between nodes and Control C to copy the selected ones.`
			: `${label}. ${doc.nodes.length} nodes. Press A to add a node, Tab to move between nodes.`}
		style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x - grid / 2}px ${view.y - grid / 2}px` }}
		onPointerDown={onPointerDown} onPointerMove={onPointerMove}
		onPointerUp={e => endDrag(e, false)} onPointerCancel={e => endDrag(e, true)}
		onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
		<div class="gx-layer" style={{ transform: `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.k})` }}>
			<EdgeLayer doc={doc} kind={kind} nodeMap={nodeMap} selection={store.edgeSelection} nodeSelection={selected} />
			{doc.nodes.map(node => <NodeShell key={node.id} node={node} kind={kind} store={store}
				links={links.get(node.id) ?? NO_LINKS} selected={selected.has(node.id)} readOnly={readOnly}
				dropPort={link?.target?.node === node.id ? link.target.port : undefined}
				onFocus={onNodeFocus} />)}
			{tempLink && <svg class="gx-edges gx-edges-top" aria-hidden="true">
				<path class={`gx-edge-temp${link?.target ? ' is-valid' : ''}`} d={tempLink} />
			</svg>}
			{marquee && <div class="gx-marquee" style={{ left: `${marquee.x}px`, top: `${marquee.y}px`, width: `${marquee.w}px`, height: `${marquee.h}px` }} />}
		</div>
		{doc.nodes.length === 0 && <div class="gx-empty">
			<p>This graph is empty</p>
			<span>Double-click anywhere or press <kbd>A</kbd> to add a node, or paste nodes that you copied from a preset</span>
		</div>}
		{toast !== undefined && <div class="gx-overlay gx-toast" aria-hidden="true">{toast}</div>}
		<div class="gx-overlay gx-zoom" role="toolbar" aria-label="Zoom">
			<IconButton icon={Ico.minus} label="Zoom out" shortcut="-" tipSide="top" onClick={() => zoomAt(size.w / 2, size.h / 2, 0.8, true)} disabled={view.k <= MIN_ZOOM} />
			<button type="button" class="gx-zoom-value" data-tip="Reset to 100% (0)" data-tip-side="top" aria-label={`Zoom ${Math.round(view.k * 100)}%. Reset to 100%`}
				onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / view.k, true)}>
				{Math.round(view.k * 100)}%
			</button>
			<IconButton icon={Ico.plus} label="Zoom in" shortcut="+" tipSide="top" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.25, true)} disabled={view.k >= MAX_ZOOM} />
			<span class="gx-divider" />
			<IconButton icon={Ico.fit} label="Fit to screen" shortcut="F" tipSide="top" onClick={() => {
				const fit = computeFit()
				if (fit) animateTo(fit)
			}} />
		</div>
		{size.w >= 560 && size.h >= 320 && doc.nodes.length > 0 && <Minimap doc={doc} kind={kind} view={view} size={size} selected={selected}
			onNavigate={(wx, wy) => {
				cancelAnimation()
				const k = viewRef.current.k
				setView({ k, x: size.w / 2 - wx * k, y: size.h / 2 - wy * k })
			}} />}
		{palette && <Palette items={paletteItems} x={palette.x} y={palette.y}
			title={palette.pending ? 'Add and connect a node' : 'Add a node'}
			onPick={item => addNode(item, palette)}
			onClose={() => {
				setPalette(undefined)
				root.current?.focus({ preventScroll: true })
			}} />}
		{menu && <Menu items={menu.items} x={menu.x} y={menu.y} label="Node actions" onClose={() => {
			setMenu(undefined)
			root.current?.focus({ preventScroll: true })
		}} />}
		<div class="gx-sr" role="status" aria-live="polite">{announcement}</div>
	</div>
}

interface NodeShellProps {
	node: GNode
	kind: GraphKind
	store: GraphStore
	links: NodeLinks
	selected: boolean
	readOnly: boolean
	dropPort: string | undefined
	onFocus: (id: string) => void
}
const NodeShell = memo(function NodeShell({ node, kind, store, links, selected, readOnly, dropPort, onFocus }: NodeShellProps) {
	const size = kind.size(node)
	return <div class={`gx-node${selected ? ' is-selected' : ''}${dropPort !== undefined ? ' is-drop' : ''}`}
		data-node={node.id} tabIndex={0} role="group" aria-roledescription="node"
		aria-label={kind.describe(node, links, store.doc)}
		style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: `${size.w}px`, height: `${size.h}px` }}
		onFocus={e => {
			if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).matches(':focus-visible')) onFocus(node.id)
		}}>
		{kind.render({ node, links, selected, store, dropPort, readOnly })}
	</div>
})

interface EdgeLayerProps {
	doc: GDoc
	kind: GraphKind
	nodeMap: Map<string, GNode>
	selection: string[]
	nodeSelection: Set<string>
}
const EdgeLayer = memo(function EdgeLayer({ doc, kind, nodeMap, selection, nodeSelection }: EdgeLayerProps) {
	const arrows = kind.edgeStyle === 'step'
	const render = (edge: GEdge) => {
		const from = nodeMap.get(edge.from)
		const to = nodeMap.get(edge.to)
		if (!from || !to) return null
		const s = absolute(from, kind.outPos(from, edge.fromPort))
		const t = absolute(to, kind.inPos(to, edge.toPort, edge.fromPort))
		const d = edgePath(kind.edgeStyle, s, t)
		const isSelected = selection.includes(edge.id)
		const isNear = nodeSelection.has(edge.from) || nodeSelection.has(edge.to)
		const extra = kind.edgeClass?.(edge)
		return <g key={edge.id} data-edge={edge.id} class={`gx-edge${extra ? ` ${extra}` : ''}${isSelected ? ' is-selected' : ''}${isNear ? ' is-near' : ''}`}>
			<path class="gx-edge-hit" d={d} />
			<path class="gx-edge-line" d={d} />
			{arrows && <path class="gx-edge-arrow" d={arrowPath(t)} />}
		</g>
	}
	// Draw highlighted edges last so they end up on top
	const normal = doc.edges.filter(e => !selection.includes(e.id) && !nodeSelection.has(e.from) && !nodeSelection.has(e.to))
	const highlighted = doc.edges.filter(e => !normal.includes(e))
	return <svg class="gx-edges" aria-hidden="true">
		{normal.map(render)}
		{highlighted.map(render)}
	</svg>
})

interface MinimapProps {
	doc: GDoc
	kind: GraphKind
	view: View
	size: { w: number, h: number }
	selected: Set<string>
	onNavigate: (wx: number, wy: number) => void
}
function Minimap({ doc, kind, view, size, selected, onNavigate }: MinimapProps) {
	const W = 184
	const H = 116
	const frozen = useRef<Rect>()
	const viewport = { x: -view.x / view.k, y: -view.y / view.k, w: size.w / view.k, h: size.h / view.k }
	const bounds = useMemo(() => docBounds(doc, kind), [doc, kind])
	if (!bounds) return null
	const area = frozen.current ?? (() => {
		const pad = 60
		const x = Math.min(bounds.x, viewport.x) - pad
		const y = Math.min(bounds.y, viewport.y) - pad
		return {
			x,
			y,
			w: Math.max(bounds.x + bounds.w, viewport.x + viewport.w) + pad - x,
			h: Math.max(bounds.y + bounds.h, viewport.y + viewport.h) + pad - y,
		}
	})()
	const scale = Math.min(W / area.w, H / area.h)
	const ox = (W - area.w * scale) / 2
	const oy = (H - area.h * scale) / 2
	const navigate = (e: PointerEvent) => {
		const rect = (e.currentTarget as Element).getBoundingClientRect()
		onNavigate((e.clientX - rect.left - ox) / scale + area.x, (e.clientY - rect.top - oy) / scale + area.y)
	}
	return <div class="gx-overlay gx-minimap" aria-hidden="true">
		<svg width={W} height={H}
			onPointerDown={e => {
				frozen.current = area;
				(e.currentTarget as Element).setPointerCapture(e.pointerId)
				navigate(e)
			}}
			onPointerMove={e => {
				if (frozen.current) navigate(e)
			}}
			onPointerUp={() => frozen.current = undefined}
			onPointerCancel={() => frozen.current = undefined}>
			{doc.nodes.map(node => {
				const s = kind.size(node)
				return <rect key={node.id} x={ox + (node.x - area.x) * scale} y={oy + (node.y - area.y) * scale}
					width={Math.max(2, s.w * scale)} height={Math.max(2, s.h * scale)} rx="1.5"
					fill={kind.color(node)} class={selected.has(node.id) ? 'is-selected' : ''} />
			})}
			<rect class="gx-minimap-view" x={ox + (viewport.x - area.x) * scale} y={oy + (viewport.y - area.y) * scale}
				width={viewport.w * scale} height={viewport.h * scale} rx="3" />
		</svg>
	</div>
}
