import { mat4, vec3 } from 'gl-matrix'
import type { MutableRef } from 'preact/hooks'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { clamp } from '../geometry.js'
import type { ViewportApi } from '../Viewport2D.jsx'
import { SliceRenderer } from './renderer.js'

/** The part of space that the view shows */
export interface Box {
	sizeX: number
	sizeZ: number
	minY: number
	maxY: number
	/** The height that the view turns around, when that is not the middle of the box */
	focusY?: number
	/** How far from the middle the view reaches at first, when that is not the whole box */
	fit?: number
}

/**
 * How the view is moved. `orbit` turns the world around its middle like a model on a table,
 * `fly` moves the camera itself through the world, also through blocks.
 */
export type CameraMode = 'orbit' | 'fly'

export interface Camera {
	eye: vec3
	/** The side that the camera looks from, in radians around the vertical axis */
	yaw: number
	/** How far the camera looks down, in radians. Negative when it looks up. */
	pitch: number
}

/** Remembers where the camera is while the view is not there, for example while another preset is opened */
export interface CameraMemo {
	camera?: Camera
	/** The frame that the camera belongs to */
	frame?: unknown
}

const FOV = 40 * Math.PI / 180
const MAX_PITCH = 89 * Math.PI / 180
/** How close zooming can bring the camera to the point that it zooms to, in blocks */
const MIN_DISTANCE = 2
const START_YAW = 35 * Math.PI / 180
const START_PITCH = 28 * Math.PI / 180
/** Radians for each CSS pixel that the pointer is dragged */
const ORBIT_SPEED = 0.0065
const LOOK_SPEED = 0.004
/** The keys that move the camera while flying, by where they are on the keyboard */
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight'])

interface Props<H extends { distance: number }> {
	label: string
	box: Box
	/** The view resets when this changes. Nothing means that it is not known yet what will be shown. */
	frameKey?: unknown
	/** Where the camera is kept, so it is the same when the view is created again */
	memo?: CameraMemo
	mode: CameraMode
	/** How fast the camera flies, in blocks for each second */
	speed: number
	/** The color behind the world, with parts from 0 to 1 */
	background: [number, number, number]
	/** Shows that the world is still being made */
	busy?: boolean
	/** Finds what a ray from the camera hits. The direction has a length of one. */
	pick?: (origin: vec3, direction: vec3) => H | undefined
	onHover?: (hit: H | undefined) => void
	/** Called with what draws the world once it exists, and with nothing when it is gone */
	onRenderer: (renderer: SliceRenderer | undefined) => void
	onError?: (error: Error) => void
	apiRef?: MutableRef<ViewportApi | undefined>
}
/**
 * A view of a box of the world. It can be turned around like a model, or flown through.
 * Zooming keeps the block under the cursor in place.
 */
export function Viewport3D<H extends { distance: number }>({ label, box, frameKey, memo, mode, speed, background, busy, pick, onHover, onRenderer, onError, apiRef }: Props<H>) {
	const wrapper = useRef<HTMLDivElement>(null)
	const canvas = useRef<HTMLCanvasElement>(null)
	const renderer = useRef<SliceRenderer>()
	const camera = useRef<Camera>()
	const size = useRef({ w: 0, h: 0 })
	const paintRequest = useRef<number>()
	const pointers = useRef(new Map<number, { x: number, y: number }>())
	/** What a drag does, and how deep in the view the world was grabbed */
	const drag = useRef<{ action: 'turn' | 'pan', depth: number }>({ action: 'turn', depth: 1 })
	const hoverAt = useRef<{ x: number, y: number }>()
	const keys = useRef(new Set<string>())
	const flight = useRef<{ frame?: number, time: number }>({ time: 0 })
	const [grabbing, setGrabbing] = useState(false)
	// The handlers below are created once, so they read the latest props from here
	const latest = useRef({ box, frameKey, memo, mode, speed, background, pick, onHover, onRenderer, onError })
	latest.current = { box, frameKey, memo, mode, speed, background, pick, onHover, onRenderer, onError }

	/** The middle of the box, which the world turns around */
	const center = () => {
		const b = latest.current.box
		return vec3.fromValues(b.sizeX / 2, b.focusY ?? (b.minY + b.maxY) / 2, b.sizeZ / 2)
	}

	const radius = () => {
		const b = latest.current.box
		return Math.hypot(b.sizeX, b.maxY - b.minY, b.sizeZ) / 2
	}

	/** The direction opposite to where the camera looks */
	const back = (c: Camera) => vec3.fromValues(Math.cos(c.pitch) * Math.sin(c.yaw), Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw))
	const right = (c: Camera) => vec3.fromValues(Math.cos(c.yaw), 0, -Math.sin(c.yaw))
	const up = (c: Camera) => vec3.cross(vec3.create(), back(c), right(c))

	const fitCamera = (): Camera => {
		const { w, h } = size.current
		const aspect = h > 0 ? w / h : 1
		// The narrowest angle of the view decides how far away the whole box fits
		const angle = Math.min(FOV, 2 * Math.atan(Math.tan(FOV / 2) * aspect))
		const c = { eye: vec3.create(), yaw: START_YAW, pitch: START_PITCH }
		vec3.scaleAndAdd(c.eye, center(), back(c), (latest.current.box.fit ?? radius()) / Math.sin(angle / 2) * 1.04)
		return c
	}

	/** How far the camera is from the box, which is zero inside of it */
	const distanceToBox = (c: Camera) => {
		const b = latest.current.box
		return Math.hypot(
			Math.max(-c.eye[0], 0, c.eye[0] - b.sizeX),
			Math.max(b.minY - c.eye[1], 0, c.eye[1] - b.maxY),
			Math.max(-c.eye[2], 0, c.eye[2] - b.sizeZ))
	}

	const viewProjection = (c: Camera) => {
		const { w, h } = size.current
		// Nothing of the world is closer than the box, so what is drawn is never cut off in front of the camera
		const near = clamp(distanceToBox(c) * 0.5, 0.1, 16)
		const far = (vec3.distance(c.eye, center()) + radius()) * 1.05 + 16
		const projection = mat4.perspective(mat4.create(), FOV, w / Math.max(1, h), near, far)
		const view = mat4.lookAt(mat4.create(), c.eye, vec3.subtract(vec3.create(), c.eye, back(c)), [0, 1, 0])
		return mat4.multiply(projection, projection, view)
	}

	/** The ray from the camera through a point of the view, in CSS pixels */
	const rayAt = (px: number, py: number) => {
		const c = camera.current!
		const { w, h } = size.current
		const inverse = mat4.invert(mat4.create(), viewProjection(c))
		const far = vec3.transformMat4(vec3.create(), [px / w * 2 - 1, 1 - py / h * 2, 1], inverse)
		const direction = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), far, c.eye))
		return { origin: c.eye, direction }
	}

	/** How deep in the view the middle of the box is, for when nothing is under the pointer */
	const centerDepth = (c: Camera) => {
		const depth = -vec3.dot(vec3.subtract(vec3.create(), center(), c.eye), back(c))
		return depth > 1 ? depth : Math.max(1, radius())
	}

	/** The point of the world under a point of the view, and how deep in the view it is */
	const anchorAt = (px: number, py: number) => {
		const c = camera.current!
		const { origin, direction } = rayAt(px, py)
		const hit = latest.current.pick?.(origin, direction)
		const facing = Math.max(0.2, -vec3.dot(direction, back(c)))
		const distance = hit ? hit.distance : centerDepth(c) / facing
		return { point: vec3.scaleAndAdd(vec3.create(), origin, direction, distance), depth: Math.max(0.5, distance * facing) }
	}

	const paint = () => {
		if (paintRequest.current !== undefined) cancelAnimationFrame(paintRequest.current)
		paintRequest.current = undefined
		const c = camera.current
		const { w, h } = size.current
		if (!renderer.current || !c || w === 0 || h === 0) return
		renderer.current.draw(viewProjection(c) as Float32Array, latest.current.background)
	}

	const requestPaint = () => {
		if (paintRequest.current === undefined) {
			paintRequest.current = requestAnimationFrame(paint)
		}
	}

	/** Keeps the camera near the box, so the world cannot get lost out of view */
	const applyCamera = (next: Camera) => {
		const middle = center()
		const limit = Math.max(64, radius() * 12)
		const distance = vec3.distance(next.eye, middle)
		if (distance > limit) vec3.lerp(next.eye, middle, next.eye, limit / distance)
		next.pitch = clamp(next.pitch, -MAX_PITCH, MAX_PITCH)
		camera.current = next
		const { memo: remembered, frameKey: frame } = latest.current
		if (remembered && frame !== undefined) {
			remembered.camera = next
			remembered.frame = frame
		}
	}

	/** The camera of last time when that showed the same frame, and else one that shows all of it */
	const startCamera = () => {
		const { memo: remembered, frameKey: frame } = latest.current
		return remembered?.camera && frame !== undefined && remembered.frame === frame ? remembered.camera : fitCamera()
	}

	const setCamera = (next: Camera) => {
		applyCamera(next)
		requestPaint()
	}

	const reset = () => {
		if (size.current.w > 0) setCamera(fitCamera())
	}

	/** Moves closer to a point or further away from it, while that point stays at the same place in the view */
	const zoom = (factor: number, anchor: vec3) => {
		const c = camera.current!
		const distance = vec3.distance(c.eye, anchor)
		const k = factor < 1 ? Math.max(factor, Math.min(1, MIN_DISTANCE / Math.max(distance, 1e-6))) : factor
		setCamera({ ...c, eye: vec3.lerp(vec3.create(), anchor, c.eye, k) })
	}

	/** Moves the world along with the pointer, by a distance in CSS pixels. What is at the given depth follows exactly. */
	const pan = (dx: number, dy: number, depth: number) => {
		const c = camera.current!
		const blocks = 2 * Math.tan(FOV / 2) * depth / Math.max(1, size.current.h)
		const eye = vec3.clone(c.eye)
		vec3.scaleAndAdd(eye, eye, right(c), -dx * blocks)
		vec3.scaleAndAdd(eye, eye, up(c), dy * blocks)
		setCamera({ ...c, eye })
	}

	/**
	 * Turns the camera around a point, which stays at the same place in the view.
	 * Turning around the camera itself looks around.
	 */
	const turn = (yaw: number, pitch: number, pivot: vec3) => {
		const c = camera.current!
		const next = { eye: vec3.create(), yaw: c.yaw + yaw, pitch: clamp(c.pitch + pitch, -MAX_PITCH, MAX_PITCH) }
		// The camera keeps its place as seen from itself, relative to the pivot
		const offset = vec3.subtract(vec3.create(), c.eye, pivot)
		vec3.copy(next.eye, pivot)
		vec3.scaleAndAdd(next.eye, next.eye, right(next), vec3.dot(offset, right(c)))
		vec3.scaleAndAdd(next.eye, next.eye, up(next), vec3.dot(offset, up(c)))
		vec3.scaleAndAdd(next.eye, next.eye, back(next), vec3.dot(offset, back(c)))
		setCamera(next)
	}

	/** Turns the world around its middle, or looks around when flying */
	const turnBy = (yaw: number, pitch: number) => {
		turn(yaw, pitch, latest.current.mode === 'fly' ? camera.current!.eye : center())
	}

	/** Moves the camera for as long as keys are held */
	const fly = (time: number) => {
		flight.current.frame = undefined
		const c = camera.current
		const held = keys.current
		if (!c || held.size === 0 || latest.current.mode !== 'fly') return
		const seconds = Math.min(0.1, Math.max(0, (time - flight.current.time) / 1000))
		flight.current.time = time
		const has = (...codes: string[]) => codes.some(code => held.has(code)) ? 1 : 0
		const move = vec3.create()
		vec3.scaleAndAdd(move, move, back(c), has('KeyS') - has('KeyW'))
		vec3.scaleAndAdd(move, move, right(c), has('KeyD') - has('KeyA'))
		move[1] += has('Space', 'KeyE') - has('ShiftLeft', 'ShiftRight', 'KeyQ')
		const length = vec3.length(move)
		if (length > 0) {
			applyCamera({ ...c, eye: vec3.scaleAndAdd(vec3.create(), c.eye, move, latest.current.speed * seconds / length) })
			// Painting in the same frame keeps the flight smooth
			paint()
		}
		flight.current.frame = requestAnimationFrame(fly)
	}

	const startFlying = () => {
		if (flight.current.frame === undefined) {
			flight.current.time = performance.now()
			flight.current.frame = requestAnimationFrame(fly)
		}
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
		try {
			renderer.current = new SliceRenderer(cv)
			renderer.current.onChange = requestPaint
		} catch (e) {
			latest.current.onError?.(e instanceof Error ? e : new Error(String(e)))
			return
		}
		const update = () => {
			const w = el.clientWidth
			const h = el.clientHeight
			if (w === size.current.w && h === size.current.h) return
			size.current = { w, h }
			const dpr = Math.min(2, window.devicePixelRatio || 1)
			cv.width = Math.max(1, Math.round(w * dpr))
			cv.height = Math.max(1, Math.round(h * dpr))
			if (w === 0 || h === 0) return
			if (!camera.current) camera.current = startCamera()
			// Painting right away keeps the image from flickering while the view is resized
			paint()
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(el)
		latest.current.onRenderer(renderer.current)
		return () => {
			observer.disconnect()
			if (paintRequest.current !== undefined) cancelAnimationFrame(paintRequest.current)
			if (flight.current.frame !== undefined) cancelAnimationFrame(flight.current.frame)
			latest.current.onRenderer(undefined)
			renderer.current?.dispose()
			renderer.current = undefined
		}
	}, [])

	// Only an actual change of the frame resets the view, never a render that repeats the same one
	const framed = useRef(frameKey)
	useEffect(() => {
		if (framed.current === frameKey) return
		framed.current = frameKey
		if (size.current.w > 0) setCamera(startCamera())
	}, [frameKey])

	const lastMode = useRef(mode)
	useEffect(() => {
		if (lastMode.current === mode) return
		lastMode.current = mode
		keys.current.clear()
		// The keys for flying only reach the view while it has the focus
		if (mode === 'fly') wrapper.current?.focus({ preventScroll: true })
	}, [mode])

	useEffect(() => {
		requestPaint()
	}, [background[0], background[1], background[2]])

	useEffect(() => {
		const el = wrapper.current
		if (!el) return
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			if (!camera.current) return
			const rect = el.getBoundingClientRect()
			let delta = e.deltaY
			if (e.deltaMode === 1) delta *= 32
			else if (e.deltaMode === 2) delta *= 400
			zoom(Math.exp(delta * (e.ctrlKey ? 0.01 : 0.0018)), anchorAt(e.clientX - rect.left, e.clientY - rect.top).point)
		}
		el.addEventListener('wheel', onWheel, { passive: false })
		return () => el.removeEventListener('wheel', onWheel)
	}, [])

	const pointerAt = (e: { clientX: number, clientY: number }) => {
		const rect = wrapper.current!.getBoundingClientRect()
		return { px: e.clientX - rect.left, py: e.clientY - rect.top }
	}

	const hoverRequest = useRef<number>()
	const hover = () => {
		hoverRequest.current = undefined
		const at = hoverAt.current
		const { pick, onHover } = latest.current
		if (!at || !camera.current || !pick || !onHover) return
		const { origin, direction } = rayAt(at.x, at.y)
		onHover(pick(origin, direction))
	}
	useEffect(() => () => {
		if (hoverRequest.current !== undefined) cancelAnimationFrame(hoverRequest.current)
	}, [])

	const onKeyDown = (e: KeyboardEvent) => {
		const c = camera.current
		if (!c || e.ctrlKey || e.metaKey || e.altKey) return
		const flying = latest.current.mode === 'fly'
		const step = 10 * Math.PI / 180
		const horizontal = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
		const vertical = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
		if (flying && FLY_KEYS.has(e.code)) {
			keys.current.add(e.code)
			startFlying()
		} else if (horizontal !== 0 || vertical !== 0) {
			if (flying) turnBy(-horizontal * step, vertical * step)
			else if (e.shiftKey) pan(-horizontal * 40, -vertical * 40, centerDepth(c))
			else turnBy(horizontal * step, -vertical * step)
		} else if (e.key === '+' || e.key === '=') zoom(0.8, anchorAt(size.current.w / 2, size.current.h / 2).point)
		else if (e.key === '-' || e.key === '_') zoom(1.25, anchorAt(size.current.w / 2, size.current.h / 2).point)
		else if (e.key === '0' || e.key === 'Home') reset()
		else return
		e.preventDefault()
		e.stopPropagation()
	}

	const endPointer = (e: PointerEvent) => {
		pointers.current.delete(e.pointerId)
		if (pointers.current.size === 0) setGrabbing(false)
	}

	const flying = mode === 'fly'
	return <div ref={wrapper} class={`gx-viewport gx-view3d${grabbing ? ' is-grabbing' : ''}${busy ? ' is-busy' : ''}`} tabIndex={0} role="img"
		aria-label={flying
			? `${label}. Drag to look around, fly with W, A, S and D, go up with Space and down with Shift, scroll to move to what is under the pointer.`
			: `${label}. Drag to turn, drag with the right mouse button or with Shift to move, scroll to zoom, double-click to reset.`}
		onKeyDown={onKeyDown}
		onKeyUp={e => keys.current.delete(e.code)}
		onBlur={() => keys.current.clear()}
		onContextMenu={e => e.preventDefault()}
		onPointerDown={e => {
			if (e.button > 2 || !camera.current) return
			pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
			// While flying, Shift goes down, so it does not change what a drag does
			const moves = e.button !== 0 || (e.shiftKey && latest.current.mode !== 'fly')
			const { px, py } = pointerAt(e)
			drag.current = { action: moves ? 'pan' : 'turn', depth: moves ? anchorAt(px, py).depth : 1 }
			try {
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
			} catch (error) {
				// The pointer is already gone, the drag still works while it is over the view
			}
			setGrabbing(true)
			latest.current.onHover?.(undefined)
		}}
		onPointerMove={e => {
			const last = pointers.current.get(e.pointerId)
			const c = camera.current
			if (!last || !c) {
				const { px, py } = pointerAt(e)
				hoverAt.current = { x: px, y: py }
				if (hoverRequest.current === undefined) hoverRequest.current = requestAnimationFrame(hover)
				return
			}
			const dx = e.clientX - last.x
			const dy = e.clientY - last.y
			if (pointers.current.size === 2) {
				// Two fingers move the world and zoom around the point between them
				const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)![1]
				const before = Math.hypot(last.x - other.x, last.y - other.y)
				const after = Math.hypot(e.clientX - other.x, e.clientY - other.y)
				const { px, py } = pointerAt({ clientX: (e.clientX + other.x) / 2, clientY: (e.clientY + other.y) / 2 })
				const anchor = anchorAt(px, py)
				pan(dx / 2, dy / 2, anchor.depth)
				if (before > 0 && after > 0) zoom(before / after, anchor.point)
			} else if (drag.current.action === 'pan') {
				pan(dx, dy, drag.current.depth)
			} else {
				const rate = latest.current.mode === 'fly' ? LOOK_SPEED : ORBIT_SPEED
				turnBy(-dx * rate, dy * rate)
			}
			pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
		}}
		onPointerUp={endPointer}
		onPointerCancel={endPointer}
		onPointerLeave={() => {
			hoverAt.current = undefined
			latest.current.onHover?.(undefined)
		}}
		onDblClick={reset}>
		<canvas ref={canvas} />
		<div class="gx-viewport-progress" aria-hidden="true" />
	</div>
}
