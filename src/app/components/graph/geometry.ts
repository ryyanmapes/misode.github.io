import type { GDoc, GraphKind, PortPos, Side } from './types.js'

export interface Point {
	x: number
	y: number
	side: Side
}

export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

/** The distance between the dots of the background, which nodes can snap to */
export const GRID = 24

/** The nearest dot of the background */
export function snapToGrid(value: number) {
	return Math.round(value / GRID) * GRID
}

/** The nearest dot of the background that is not before the value, so things that are laid out do not overlap */
export function nextOnGrid(value: number) {
	return Math.ceil(value / GRID) * GRID
}

export function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value))
}

export function absolute(node: { x: number, y: number }, pos: PortPos): Point {
	return { x: node.x + pos.x, y: node.y + pos.y, side: pos.side }
}

export function docBounds(doc: GDoc, kind: GraphKind): Rect | undefined {
	if (doc.nodes.length === 0) return undefined
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (const node of doc.nodes) {
		const size = kind.size(node)
		minX = Math.min(minX, node.x)
		minY = Math.min(minY, node.y)
		maxX = Math.max(maxX, node.x + size.w)
		maxY = Math.max(maxY, node.y + size.h)
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function intersects(a: Rect, b: Rect) {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function bezier(s: Point, t: Point) {
	const distance = Math.abs(t.x - s.x)
	let handle = clamp(distance * 0.5, 28, 140)
	if (t.x < s.x) {
		// Looping back: widen the curve so it stays readable
		handle = clamp(distance * 0.5 + Math.abs(t.y - s.y) * 0.25, 70, 220)
	}
	return `M${s.x},${s.y} C${s.x + handle},${s.y} ${t.x - handle},${t.y} ${t.x},${t.y}`
}

function rounded(points: [number, number][], radius: number) {
	// Remove points that do not change direction
	const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1])
	if (pts.length < 2) return ''
	let d = `M${pts[0][0]},${pts[0][1]}`
	for (let i = 1; i < pts.length - 1; i += 1) {
		const [px, py] = pts[i - 1]
		const [cx, cy] = pts[i]
		const [nx, ny] = pts[i + 1]
		const inLen = Math.hypot(cx - px, cy - py)
		const outLen = Math.hypot(nx - cx, ny - cy)
		const r = Math.min(radius, inLen / 2, outLen / 2)
		if (r < 0.5) {
			d += ` L${cx},${cy}`
			continue
		}
		const ax = cx - (cx - px) / inLen * r
		const ay = cy - (cy - py) / inLen * r
		const bx = cx + (nx - cx) / outLen * r
		const by = cy + (ny - cy) / outLen * r
		d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`
	}
	const last = pts[pts.length - 1]
	return `${d} L${last[0]},${last[1]}`
}

const STEP_RADIUS = 10
const DETOUR = 22

function step(s: Point, t: Point) {
	if (s.side === 'bottom') {
		// Flows down into the top of the target
		if (t.y >= s.y + 12) {
			const midY = s.y + (t.y - s.y) / 2
			return rounded([[s.x, s.y], [s.x, midY], [t.x, midY], [t.x, t.y]], STEP_RADIUS)
		}
		const midX = Math.abs(t.x - s.x) < 60 ? Math.max(s.x, t.x) + 140 : (s.x + t.x) / 2
		return rounded([[s.x, s.y], [s.x, s.y + DETOUR], [midX, s.y + DETOUR], [midX, t.y - DETOUR], [t.x, t.y - DETOUR], [t.x, t.y]], STEP_RADIUS)
	}
	// Flows right into the left side of the target
	if (t.x >= s.x + 12) {
		const midX = s.x + (t.x - s.x) / 2
		return rounded([[s.x, s.y], [midX, s.y], [midX, t.y], [t.x, t.y]], STEP_RADIUS)
	}
	const midY = Math.abs(t.y - s.y) < 50 ? Math.max(s.y, t.y) + 70 : (s.y + t.y) / 2
	return rounded([[s.x, s.y], [s.x + DETOUR, s.y], [s.x + DETOUR, midY], [t.x - DETOUR, midY], [t.x - DETOUR, t.y], [t.x, t.y]], STEP_RADIUS)
}

export function edgePath(style: 'bezier' | 'step', s: Point, t: Point) {
	return style === 'bezier' ? bezier(s, t) : step(s, t)
}

/** A small arrow head that points into the target port */
export function arrowPath(t: Point) {
	const l = 8
	const w = 4.5
	if (t.side === 'top') {
		return `M${t.x},${t.y} L${t.x - w},${t.y - l} L${t.x + w},${t.y - l} Z`
	}
	return `M${t.x},${t.y} L${t.x - l},${t.y - w} L${t.x - l},${t.y + w} Z`
}
