import type { ColormapType } from '../../previews/Colormap.js'
import { getColormap } from '../../previews/Colormap.js'
import type { DensitySampler } from '../worldgen.js'

const LUT_SIZE = 512
const luts = new Map<ColormapType, Uint8ClampedArray>()

/**
 * A lookup table from negative (index 0) to positive (last index).
 * The colors skip a bit around zero so the edge between air and solid is clearly visible.
 */
function getLut(colormap: ColormapType) {
	let lut = luts.get(colormap)
	if (!lut) {
		const fn = getColormap(colormap)
		lut = new Uint8ClampedArray(LUT_SIZE * 3)
		for (let i = 0; i < LUT_SIZE; i += 1) {
			const t = 1 - i / (LUT_SIZE - 1)
			const color = fn(t <= 0.5 ? t - 0.08 : t + 0.08)
			lut[i * 3] = color[0] * 256
			lut[i * 3 + 1] = color[1] * 256
			lut[i * 3 + 2] = color[2] * 256
		}
		luts.set(colormap, lut)
	}
	return lut
}

/** A CSS gradient that matches the colors of colorizeDensity, from negative to positive */
export function colormapGradient(colormap: ColormapType) {
	const lut = getLut(colormap)
	const stops: string[] = []
	const half = LUT_SIZE / 2
	const push = (index: number, percent: number) => {
		stops.push(`rgb(${lut[index * 3]}, ${lut[index * 3 + 1]}, ${lut[index * 3 + 2]}) ${percent}%`)
	}
	for (let i = 0; i <= 8; i += 1) push(Math.round(i / 8 * (half - 1)), i / 8 * 50)
	for (let i = 0; i <= 8; i += 1) push(Math.round(half + i / 8 * (half - 1)), 50 + i / 8 * 50)
	return `linear-gradient(to right, ${stops.join(', ')})`
}

/** The colors of the binary view, where only the sign of the density matters */
export const SOLID_COLOR = [66, 70, 77] as const
export const AIR_COLOR = [214, 229, 250] as const

export interface DensityRange {
	/** The value that is mapped to the ends of the colormap */
	limit: number
	min: number
	max: number
}

/** Finds the extremes of values, and the magnitude that the ends of the colormap stand for */
export function measureDensity(values: Float32Array, length = values.length): DensityRange {
	let min = Infinity
	let max = -Infinity
	const magnitudes = new Float32Array(length)
	let count = 0
	for (let i = 0; i < length; i += 1) {
		const v = values[i]
		if (!Number.isFinite(v)) continue
		if (v < min) min = v
		if (v > max) max = v
		magnitudes[count] = Math.abs(v)
		count += 1
	}
	if (count === 0) {
		min = 0
		max = 0
	}
	// Ignore the most extreme 1%, so a few outliers do not flatten everything else
	const sortedMagnitudes = magnitudes.subarray(0, count).sort()
	let limit = count > 0 ? sortedMagnitudes[Math.floor((count - 1) * 0.99)] : 0
	if (!(limit > 0)) limit = count > 0 ? sortedMagnitudes[count - 1] : 0
	if (!(limit > 0)) limit = 1
	return { limit, min, max }
}

/**
 * Colors densities with zero in the middle of the colormap.
 * The range of the colors is `fixed` when given, and otherwise adapts to the values.
 * With `binary` there are only two colors: solid where the density is positive, air elsewhere.
 */
export function colorizeDensity(values: Float32Array, rgba: Uint8ClampedArray, colormap: ColormapType, binary = false, fixed?: DensityRange): DensityRange {
	const lut = getLut(colormap)
	const n = values.length
	const range = fixed ?? measureDensity(values)
	if (binary) {
		for (let i = 0; i < n; i += 1) {
			const color = values[i] > 0 ? SOLID_COLOR : AIR_COLOR
			rgba[i * 4] = color[0]
			rgba[i * 4 + 1] = color[1]
			rgba[i * 4 + 2] = color[2]
			rgba[i * 4 + 3] = 255
		}
		return range
	}
	const { limit } = range
	const scale = (LUT_SIZE - 1) / (2 * limit)
	for (let i = 0; i < n; i += 1) {
		const v = values[i]
		let index = Number.isFinite(v) ? Math.round((v + limit) * scale) : (v > 0 ? LUT_SIZE - 1 : 0)
		if (index < 0) index = 0
		else if (index >= LUT_SIZE) index = LUT_SIZE - 1
		rgba[i * 4] = lut[index * 3]
		rgba[i * 4 + 1] = lut[index * 3 + 1]
		rgba[i * 4 + 2] = lut[index * 3 + 2]
		rgba[i * 4 + 3] = 255
	}
	return range
}

const REGION_COLS = 112
const REGION_ROWS = 56

/**
 * Measures a function over a whole area, a few milliseconds at a time, so the colors
 * of a preview can stay the same wherever it is zoomed in. Both ranges exclude their end.
 * Returns a function that cancels the measurement.
 */
export function measureRegion(
	sample: (h: number, v: number) => number,
	horizontal: { min: number, max: number },
	vertical: { min: number, max: number },
	done: (range: DensityRange | undefined) => void,
) {
	const values = new Float32Array(REGION_COLS * REGION_ROWS)
	let col = 0
	let timer: number | undefined
	const step = () => {
		const t0 = performance.now()
		try {
			while (col < REGION_COLS && performance.now() - t0 < 6) {
				const h = Math.floor(horizontal.min + (col + 0.5) / REGION_COLS * (horizontal.max - horizontal.min))
				for (let row = 0; row < REGION_ROWS; row += 1) {
					const v = Math.floor(vertical.min + (row + 0.5) / REGION_ROWS * (vertical.max - vertical.min))
					values[col * REGION_ROWS + row] = sample(h, v)
				}
				col += 1
			}
		} catch (e) {
			done(undefined)
			return
		}
		if (col < REGION_COLS) {
			timer = window.setTimeout(step, 0)
		} else {
			done(measureDensity(values))
		}
	}
	timer = window.setTimeout(step, 0)
	return () => {
		if (timer !== undefined) clearTimeout(timer)
		col = REGION_COLS
	}
}

// === Views ===

/**
 * The views of a density function. A side view is named after its horizontal axis,
 * and each view has one axis left over that picks which layer is shown.
 */
export type ViewMode = 'x' | 'z' | 'top'

/**
 * Turns a density function into the image of one view: the value at a horizontal
 * and vertical position. In the top view north is up, so Z grows downwards.
 * With `delta` it is the change from the layer before.
 */
export function sliceSampler(fn: DensitySampler, mode: ViewMode, layer: number, delta: boolean): (h: number, v: number) => number {
	const at = mode === 'x' ? (h: number, v: number, c: number) => fn(h, v, c)
		: mode === 'z' ? (h: number, v: number, c: number) => fn(c, v, h)
			: (h: number, v: number, c: number) => fn(h, c, -v)
	return delta
		? (h, v) => at(h, v, layer) - at(h, v, layer - 1)
		: (h, v) => at(h, v, layer)
}

/** What the previews on nodes show: a view, its layer and the part that is visible */
export interface ThumbView {
	mode: ViewMode
	layer: number
	delta: boolean
	/** The horizontal position in the middle */
	centerH: number
	/** The vertical range, from the bottom to the top edge */
	minV: number
	maxV: number
}

// === Thumbnails ===

export const THUMB_COLS = 100
export const THUMB_ROWS = 32

export type ThumbResult = { values: Float32Array } | { error: string }

interface ThumbJob {
	key: string
	create: () => (h: number, v: number) => number
	centerH: number
	minV: number
	maxV: number
	callbacks: Set<(result: ThumbResult) => void>
}

const MAX_CACHED = 400
const cache = new Map<string, ThumbResult>()
const jobs = new Map<string, ThumbJob>()
const queue: string[] = []
let running = false

function finish(job: ThumbJob, result: ThumbResult) {
	jobs.delete(job.key)
	cache.set(job.key, result)
	if (cache.size > MAX_CACHED) {
		cache.delete(cache.keys().next().value!)
	}
	for (const callback of job.callbacks) callback(result)
}

function pump() {
	const key = queue.shift()
	const job = key === undefined ? undefined : jobs.get(key)
	if (key === undefined) {
		running = false
		return
	}
	if (!job || job.callbacks.size === 0) {
		// Nobody is waiting for this anymore
		jobs.delete(key)
		setTimeout(pump, 0)
		return
	}
	let sampler: (h: number, v: number) => number
	try {
		sampler = job.create()
	} catch (e) {
		finish(job, { error: e instanceof Error ? e.message : String(e) })
		setTimeout(pump, 0)
		return
	}
	const values = new Float32Array(THUMB_COLS * THUMB_ROWS)
	const step = (job.maxV - job.minV) / THUMB_ROWS
	const top = job.maxV
	let col = 0
	const slice = () => {
		if (job.callbacks.size === 0) {
			jobs.delete(job.key)
			setTimeout(pump, 0)
			return
		}
		const t0 = performance.now()
		try {
			while (col < THUMB_COLS && performance.now() - t0 < 7) {
				const x = Math.floor(job.centerH + (col - THUMB_COLS / 2 + 0.5) * step)
				for (let row = 0; row < THUMB_ROWS; row += 1) {
					values[row * THUMB_COLS + col] = sampler(x, Math.floor(top - (row + 0.5) * step))
				}
				col += 1
			}
		} catch (e) {
			finish(job, { error: e instanceof Error ? e.message : String(e) })
			setTimeout(pump, 0)
			return
		}
		if (col < THUMB_COLS) {
			setTimeout(slice, 0)
		} else {
			finish(job, { values })
			setTimeout(pump, 0)
		}
	}
	slice()
}

/**
 * Computes a small side view of a density function, a few milliseconds at a time.
 * Returns a function that cancels the request.
 */
export function requestThumb(key: string, create: () => (h: number, v: number) => number, view: ThumbView, callback: (result: ThumbResult) => void) {
	const cached = cache.get(key)
	if (cached) {
		callback(cached)
		return () => {}
	}
	let job = jobs.get(key)
	if (!job) {
		job = { key, create, centerH: view.centerH, minV: view.minV, maxV: view.maxV, callbacks: new Set() }
		jobs.set(key, job)
		queue.push(key)
	}
	job.callbacks.add(callback)
	if (!running) {
		running = true
		setTimeout(pump, 0)
	}
	const pending = job
	return () => {
		pending.callbacks.delete(callback)
	}
}
