import type { MutableRef } from 'preact/hooks'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { clamp } from './geometry.js'
import type { HeightRange } from './types.js'

/** Something that can be drawn as a grid of blocks */
export interface RasterSource {
	/** Changes whenever the values should be computed again */
	key: unknown
	/** Changes whenever the same values should get other colors */
	colorKey?: unknown
	/** Returns a value for the block at x (horizontal) and y (vertical, up is positive) */
	sample(x: number, y: number): number
	/** Turns all the sampled values into colors */
	colorize(values: Float32Array, rgba: Uint8ClampedArray): void
}

/** The region that is visible initially */
export interface Frame {
	centerX: number
	minY: number
	maxY: number
}

export interface HoverInfo {
	x: number
	y: number
	value: number
}

/** The part of the world that a viewport shows */
export interface VisibleArea {
	centerX: number
	minY: number
	maxY: number
}

export interface ViewportApi {
	reset(): void
}

/** A line across the whole view that marks a coordinate and can be dragged by its handle */
export interface Guide {
	id: string
	/** Which end of the line has the handle. Lines with their handles on other ends can always be told apart. */
	end: 'start' | 'end'
	/** `h` is a horizontal line at a height, `v` a vertical line at a horizontal position */
	orientation: 'h' | 'v'
	/** Where the line is, in the coordinates of sample() */
	value: number
	label: string
}

interface RasterView {
	cx: number
	cy: number
	/** CSS pixels per block */
	s: number
}

/** Remembers what a viewport shows while it is not there, for example while another preset is opened */
export interface ViewportMemo {
	view?: RasterView
	/** The frame that the view belongs to */
	key?: unknown
}

interface Rendered {
	canvas: HTMLCanvasElement
	view: RasterView
	w: number
	h: number
	cell: number
}

interface Sampled {
	key: unknown
	values: Float32Array
	gw: number
	gh: number
	view: RasterView
	w: number
	h: number
	cell: number
}

const MIN_SCALE = 0.125
const MAX_SCALE = 48
const TIME_BUDGET = 10

interface Props {
	source: RasterSource | undefined
	frame: Frame
	/** The view resets when this changes */
	frameKey?: unknown
	label: string
	axes: [string, string]
	/** Shows the vertical axis with its sign flipped, for views where down is positive */
	invertY?: boolean
	/** When set, the view can never show anything left or right of this range */
	limitX?: HeightRange
	/** When set, the view can never show anything below or above this range */
	limitY?: HeightRange
	/** Makes the vertical limit fill the whole height when the view is reset */
	fillLimitY?: boolean
	/** Lines that mark coordinates */
	guides?: Guide[]
	/** Called with the coordinate under the pointer while a guide is dragged. It stays inside of the limits. */
	onGuideDrag?: (id: string, value: number) => void
	/** Where the view is kept, so it is the same when the viewport is created again */
	memo?: ViewportMemo
	/** The size in CSS pixels of one sample */
	cell?: number
	onHover?: (info: HoverInfo | undefined) => void
	onError?: (error: Error | undefined) => void
	/** Called whenever another part of the world becomes visible */
	onView?: (area: VisibleArea) => void
	apiRef?: MutableRef<ViewportApi | undefined>
}
/**
 * A canvas that shows a slice of the world which can be panned and zoomed.
 * Zooming keeps the block under the cursor in place. The image is computed
 * in small steps so the page stays responsive, and while that happens the
 * previous image is moved along with the view.
 */
export function Viewport2D({ source, frame, frameKey, label, axes, invertY, limitX, limitY, fillLimitY, guides, onGuideDrag, memo, cell = 2, onHover, onError, onView, apiRef }: Props) {
	const wrapper = useRef<HTMLDivElement>(null)
	const canvas = useRef<HTMLCanvasElement>(null)
	const guideLayer = useRef<HTMLDivElement>(null)
	const view = useRef<RasterView>()
	const size = useRef({ w: 0, h: 0 })
	const rendered = useRef<Rendered>()
	const sampled = useRef<Sampled>()
	const job = useRef(0)
	const timer = useRef<number>()
	const paintRequest = useRef<number>()
	const dragging = useRef<{ x: number, y: number, guide?: Guide }>()
	const [busy, setBusy] = useState(false)
	const [grabbing, setGrabbing] = useState(false)
	const [draggedGuide, setDraggedGuide] = useState<'h' | 'v'>()
	// The handlers below are created once, so they read the latest props from here
	const latest = useRef({ source, frame, frameKey, invertY, axes, limitX, limitY, fillLimitY, guides, onGuideDrag, memo, onHover, onError, onView })
	latest.current = { source, frame, frameKey, invertY, axes, limitX, limitY, fillLimitY, guides, onGuideDrag, memo, onHover, onError, onView }

	const reportView = () => {
		const v = view.current
		const { h } = size.current
		if (v && h > 0) latest.current.onView?.({ centerX: v.cx, minY: v.cy - h / (2 * v.s), maxY: v.cy + h / (2 * v.s) })
	}

	/** The smallest scale at which nothing outside of the limits is visible */
	const minScale = () => {
		const { limitX, limitY } = latest.current
		const { w, h } = size.current
		let min = MIN_SCALE
		if (limitY && h > 0) min = Math.max(min, h / Math.max(1, limitY.max - limitY.min))
		if (limitX && w > 0) min = Math.max(min, w / Math.max(1, limitX.max - limitX.min))
		return min
	}

	const clampScale = (s: number) => {
		const min = minScale()
		return clamp(s, min, Math.max(MAX_SCALE, min))
	}

	const clampCenter = (center: number, limit: HeightRange | undefined, half: number) => {
		if (!limit) return center
		if (limit.max - limit.min <= 2 * half) return (limit.min + limit.max) / 2
		return clamp(center, limit.min + half, limit.max - half)
	}

	/** Treats the limits as hard edges: the view stops there when panning and zooming */
	const constrain = (v: RasterView): RasterView => {
		const { limitX, limitY } = latest.current
		const { w, h } = size.current
		if ((!limitX && !limitY) || w === 0 || h === 0) return v
		const s = clampScale(v.s)
		return {
			s,
			cx: clampCenter(v.cx, limitX, w / (2 * s)),
			cy: clampCenter(v.cy, limitY, h / (2 * s)),
		}
	}

	const fitView = (): RasterView => {
		const { h } = size.current
		const { frame: f, limitY, fillLimitY } = latest.current
		if (limitY && fillLimitY) {
			return constrain({ cx: f.centerX, cy: (limitY.min + limitY.max) / 2, s: h / Math.max(1, limitY.max - limitY.min) })
		}
		const s = clamp((h / Math.max(1, f.maxY - f.minY)) * 0.94, MIN_SCALE, MAX_SCALE)
		return constrain({ cx: f.centerX, cy: (f.minY + f.maxY) / 2, s })
	}

	/** Where a guide is on the screen, in CSS pixels from the top or left */
	const guidePixel = (guide: Guide, v: RasterView) => {
		const { w, h } = size.current
		return guide.orientation === 'h' ? (v.cy - guide.value) * v.s + h / 2 : (guide.value - v.cx) * v.s + w / 2
	}

	const outlinedText = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number) => {
		ctx.strokeText(text, x, y)
		ctx.fillText(text, x, y)
	}

	/**
	 * Moves the lines to where their coordinates are. They are elements on top of the image
	 * and not a part of it, so they are whole at the rounded corners and on the very edge.
	 */
	const placeGuides = (v: RasterView) => {
		const layer = guideLayer.current
		if (!layer) return
		const { w, h } = size.current
		for (const el of Array.from(layer.children) as HTMLElement[]) {
			const guide = latest.current.guides?.find(g => g.id === el.dataset.guide)
			if (!guide) continue
			const horizontal = guide.orientation === 'h'
			const length = horizontal ? h : w
			const at = Math.round(guidePixel(guide, v))
			const outside = at < 0 || at > length
			// A line that is out of view keeps its handle on the nearest edge, so it can be pulled back in
			const p = clamp(at, 0, length)
			el.style.visibility = !outside || latest.current.onGuideDrag ? 'visible' : 'hidden'
			el.style.transform = horizontal ? `translateY(${p}px)` : `translateX(${p}px)`
			el.classList.toggle('is-outside', outside)
			// The label moves to the other side of the line where it would not fit
			el.classList.toggle('is-flipped', horizontal ? p < 24 : p > w - 76)
		}
	}

	const paint = () => {
		paintRequest.current = undefined
		const el = canvas.current
		const v = view.current
		const ctx = el?.getContext('2d')
		if (!el || !ctx || !v) return
		const { w, h } = size.current
		const dpr = el.width / Math.max(1, w)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, w, h)
		const last = rendered.current
		if (last) {
			const ratio = v.s / last.view.s
			const left = (last.view.cx - last.w / (2 * last.view.s) - v.cx) * v.s + w / 2
			const top = (v.cy - (last.view.cy + last.h / (2 * last.view.s))) * v.s + h / 2
			ctx.imageSmoothingEnabled = false
			ctx.drawImage(last.canvas, left, top, last.canvas.width * last.cell * ratio, last.canvas.height * last.cell * ratio)
		}
		// Axis labels
		const { invertY, axes } = latest.current
		const steps = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]
		const step = steps.find(n => n * v.s >= 46) ?? 8192
		ctx.font = '10px system-ui, "Segoe UI", Roboto, sans-serif'
		ctx.lineWidth = 3
		ctx.lineJoin = 'round'
		ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
		ctx.fillStyle = '#fff'
		ctx.textBaseline = 'middle'
		ctx.textAlign = 'left'
		const topY = v.cy + h / (2 * v.s)
		const bottomY = v.cy - h / (2 * v.s)
		for (let y = Math.ceil(bottomY / step) * step; y <= topY; y += step) {
			const py = (v.cy - y) * v.s + h / 2
			if (py < 8 || py > h - 18) continue
			outlinedText(ctx, String(invertY && y !== 0 ? -y : y), 6, py)
		}
		ctx.textAlign = 'center'
		const leftX = v.cx - w / (2 * v.s)
		const rightX = v.cx + w / (2 * v.s)
		for (let x = Math.ceil(leftX / step) * step; x <= rightX; x += step) {
			const px = (x - v.cx) * v.s + w / 2
			if (px < 34 || px > w - 30) continue
			outlinedText(ctx, String(x), px, h - 8)
		}
		ctx.textAlign = 'left'
		outlinedText(ctx, axes[1], 6, 10)
		ctx.textAlign = 'right'
		outlinedText(ctx, axes[0], w - 6, h - 8)
		placeGuides(v)
	}

	const requestPaint = () => {
		if (paintRequest.current === undefined) {
			paintRequest.current = requestAnimationFrame(paint)
		}
	}

	/** Turns sampled values into the image that is painted */
	const draw = (data: Sampled, src: RasterSource) => {
		try {
			const image = new ImageData(data.gw, data.gh)
			src.colorize(data.values, image.data)
			const target = rendered.current?.canvas ?? document.createElement('canvas')
			target.width = data.gw
			target.height = data.gh
			target.getContext('2d')!.putImageData(image, 0, 0)
			rendered.current = { canvas: target, view: data.view, w: data.w, h: data.h, cell: data.cell }
			latest.current.onError?.(undefined)
		} catch (e) {
			latest.current.onError?.(e instanceof Error ? e : new Error(String(e)))
		}
		requestPaint()
	}

	const compute = () => {
		const token = job.current += 1
		if (timer.current !== undefined) clearTimeout(timer.current)
		const src = latest.current.source
		const v = view.current
		const { w, h } = size.current
		if (!src || !v || w === 0 || h === 0) {
			setBusy(false)
			return
		}
		const at = { ...v }
		const gw = Math.ceil(w / cell)
		const gh = Math.ceil(h / cell)
		const values = new Float32Array(gw * gh)
		const ys = new Int32Array(gh)
		for (let row = 0; row < gh; row += 1) {
			ys[row] = Math.floor(at.cy - ((row + 0.5) * cell - h / 2) / at.s)
		}
		let col = 0
		let previousX = NaN
		const started = performance.now()
		let shownBusy = false
		const step = () => {
			if (token !== job.current) return
			const t0 = performance.now()
			try {
				while (col < gw && performance.now() - t0 < TIME_BUDGET) {
					const x = Math.floor(at.cx + ((col + 0.5) * cell - w / 2) / at.s)
					if (x === previousX) {
						// Zoomed in far enough that this column shows the same blocks
						for (let row = 0; row < gh; row += 1) {
							values[row * gw + col] = values[row * gw + col - 1]
						}
					} else {
						let value = 0
						for (let row = 0; row < gh; row += 1) {
							if (row === 0 || ys[row] !== ys[row - 1]) {
								value = src.sample(x, ys[row])
							}
							values[row * gw + col] = value
						}
					}
					previousX = x
					col += 1
				}
			} catch (e) {
				setBusy(false)
				latest.current.onError?.(e instanceof Error ? e : new Error(String(e)))
				return
			}
			if (col < gw) {
				if (!shownBusy && performance.now() - started > 180) {
					shownBusy = true
					setBusy(true)
				}
				timer.current = window.setTimeout(step, 0)
				return
			}
			sampled.current = { key: src.key, values, gw, gh, view: at, w, h, cell }
			// The colors may have changed while the values were computed
			const current = latest.current.source
			draw(sampled.current, current && current.key === src.key ? current : src)
			setBusy(false)
		}
		step()
	}

	const setView = (next: RasterView) => {
		view.current = constrain(next)
		const { memo: remembered, frameKey: key } = latest.current
		if (remembered) {
			remembered.view = view.current
			remembered.key = key
		}
		reportView()
		requestPaint()
		compute()
	}

	const reset = () => {
		if (size.current.w === 0) return
		setView(fitView())
	}

	useEffect(() => {
		if (!apiRef) return
		apiRef.current = { reset }
		return () => {
			apiRef.current = undefined
		}
	}, [apiRef])

	useLayoutEffect(() => {
		const el = wrapper.current
		const cv = canvas.current
		if (!el || !cv) return
		const update = () => {
			const w = el.clientWidth
			const h = el.clientHeight
			if (w === size.current.w && h === size.current.h) return
			const first = size.current.w === 0 || !view.current
			size.current = { w, h }
			const dpr = Math.min(2, window.devicePixelRatio || 1)
			cv.width = Math.max(1, Math.round(w * dpr))
			cv.height = Math.max(1, Math.round(h * dpr))
			if (w === 0 || h === 0) return
			// What was shown before comes back, unless that was another frame
			const { memo: remembered, frameKey: key } = latest.current
			view.current = !first ? constrain(view.current!)
				: remembered?.view && remembered.key === key ? constrain(remembered.view) : fitView()
			reportView()
			paint()
			compute()
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(el)
		return () => {
			observer.disconnect()
			job.current += 1
			if (timer.current !== undefined) clearTimeout(timer.current)
			if (paintRequest.current !== undefined) cancelAnimationFrame(paintRequest.current)
		}
	}, [])

	// Only an actual change resets the view, never a render that repeats what was there
	const framed = useRef(frameKey)
	useEffect(() => {
		if (framed.current === frameKey) return
		framed.current = frameKey
		rendered.current = undefined
		sampled.current = undefined
		reset()
	}, [frameKey])

	useEffect(() => {
		compute()
	}, [source?.key, cell])

	// Other colors for the same values do not need the values to be computed again
	useEffect(() => {
		const data = sampled.current
		if (source && data && data.key === source.key) draw(data, source)
	}, [source?.colorKey])

	const limitedY = `${limitY?.min} ${limitY?.max} ${fillLimitY}`
	const lastLimitY = useRef(limitedY)
	useEffect(() => {
		if (lastLimitY.current === limitedY) return
		lastLimitY.current = limitedY
		reset()
	}, [limitedY])

	const limitedX = `${limitX?.min} ${limitX?.max}`
	const lastLimitX = useRef(limitedX)
	useEffect(() => {
		if (lastLimitX.current === limitedX) return
		lastLimitX.current = limitedX
		if (view.current && size.current.w > 0) setView(view.current)
	}, [limitedX])

	// New lines are placed before they are seen
	useLayoutEffect(() => {
		if (view.current) placeGuides(view.current)
	}, [guides])

	useEffect(() => {
		const el = wrapper.current
		if (!el) return
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			const v = view.current
			if (!v) return
			const rect = el.getBoundingClientRect()
			const { w, h } = size.current
			const px = e.clientX - rect.left
			const py = e.clientY - rect.top
			let delta = e.deltaY
			if (e.deltaMode === 1) delta *= 32
			else if (e.deltaMode === 2) delta *= 400
			const s = clampScale(v.s * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018)))
			if (s === v.s) return
			// Keep the block under the cursor in the same place
			const worldX = v.cx + (px - w / 2) / v.s
			const worldY = v.cy - (py - h / 2) / v.s
			setView({ s, cx: worldX - (px - w / 2) / s, cy: worldY + (py - h / 2) / s })
		}
		el.addEventListener('wheel', onWheel, { passive: false })
		return () => el.removeEventListener('wheel', onWheel)
	}, [])

	const pointerAt = (e: MouseEvent) => {
		const rect = wrapper.current!.getBoundingClientRect()
		return { px: e.clientX - rect.left, py: e.clientY - rect.top }
	}

	const hoverAt = (e: PointerEvent) => {
		const v = view.current
		const { source: src, onHover, invertY } = latest.current
		const { px, py } = pointerAt(e)
		if (!v || !src || !onHover) return
		const { w, h } = size.current
		const x = Math.floor(v.cx + (px - w / 2) / v.s)
		const y = Math.floor(v.cy - (py - h / 2) / v.s)
		try {
			onHover({ x, y: invertY ? -y : y, value: src.sample(x, y) })
		} catch (e) {
			onHover(undefined)
		}
	}

	const onKeyDown = (e: KeyboardEvent) => {
		const v = view.current
		if (!v) return
		const pan = 40 / v.s
		if (e.key === 'ArrowLeft') setView({ ...v, cx: v.cx - pan })
		else if (e.key === 'ArrowRight') setView({ ...v, cx: v.cx + pan })
		else if (e.key === 'ArrowUp') setView({ ...v, cy: v.cy + pan })
		else if (e.key === 'ArrowDown') setView({ ...v, cy: v.cy - pan })
		else if (e.key === '+' || e.key === '=') setView({ ...v, s: clampScale(v.s * 1.25) })
		else if (e.key === '-' || e.key === '_') setView({ ...v, s: clampScale(v.s * 0.8) })
		else if (e.key === '0' || e.key === 'Home') reset()
		else return
		e.preventDefault()
		e.stopPropagation()
	}

	const endDrag = () => {
		dragging.current = undefined
		setGrabbing(false)
		setDraggedGuide(undefined)
	}

	/** The guide whose handle an event is on */
	const guideOf = (e: Event) => {
		const id = (e.target as HTMLElement).closest<HTMLElement>('[data-grip]')?.dataset.grip
		return id === undefined ? undefined : latest.current.guides?.find(g => g.id === id)
	}

	// While a line is dragged the cursor keeps its shape, also away from the handle
	const cursor = draggedGuide === 'h' ? 'ns-resize' : draggedGuide === 'v' ? 'ew-resize' : undefined

	return <div ref={wrapper} class={`gx-viewport${grabbing ? ' is-grabbing' : ''}${busy ? ' is-busy' : ''}`} tabIndex={0} role="img"
		style={cursor ? { cursor } : undefined}
		aria-label={`${label}. Drag to pan, scroll to zoom, double-click to reset.`}
		onKeyDown={onKeyDown}
		onPointerDown={e => {
			if (e.button !== 0 && e.button !== 1) return
			const guide = e.button === 0 && latest.current.onGuideDrag ? guideOf(e) : undefined
			dragging.current = { x: e.clientX, y: e.clientY, guide }
			try {
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
			} catch (error) {
				// The pointer is already gone, the drag still works while it is over the view
			}
			if (guide) setDraggedGuide(guide.orientation)
			else setGrabbing(true)
		}}
		onPointerMove={e => {
			const d = dragging.current
			const v = view.current
			if (d?.guide && v) {
				const { px, py } = pointerAt(e)
				const { w, h } = size.current
				const value = d.guide.orientation === 'h' ? v.cy - (py - h / 2) / v.s : v.cx + (px - w / 2) / v.s
				// A line that is dragged past the edge of the area comes to rest exactly on that edge
				const limit = d.guide.orientation === 'h' ? latest.current.limitY : latest.current.limitX
				latest.current.onGuideDrag?.(d.guide.id, limit ? clamp(value, limit.min, limit.max) : value)
			} else if (d && v) {
				setView({ s: v.s, cx: v.cx - (e.clientX - d.x) / v.s, cy: v.cy + (e.clientY - d.y) / v.s })
				dragging.current = { x: e.clientX, y: e.clientY }
			} else {
				hoverAt(e)
			}
		}}
		onPointerUp={endDrag}
		onPointerCancel={endDrag}
		onPointerLeave={() => latest.current.onHover?.(undefined)}
		onDblClick={e => {
			if (!guideOf(e)) reset()
		}}>
		<div class="gx-viewport-clip">
			<canvas ref={canvas} />
			<div class="gx-viewport-progress" aria-hidden="true" />
		</div>
		<div ref={guideLayer} class="gx-guides" aria-hidden="true">
			{(guides ?? []).map(guide => <div key={guide.id} data-guide={guide.id}
				class={`gx-guide gx-guide-${guide.orientation} gx-guide-${guide.end}`}>
				<span class="gx-guide-line" />
				{onGuideDrag && <span class="gx-guide-grip" data-grip={guide.id} title={`${guide.label}: drag to move`} />}
				<span class="gx-guide-label">{guide.label}</span>
			</div>)}
		</div>
	</div>
}
