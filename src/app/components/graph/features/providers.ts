import { between } from './random.js'
import type { Ctx, Json } from './types.js'
import { clamp, int, isObj, list, num, obj, shortId } from './util.js'

/** The fields of a provider: 1.19 keeps them in `value`, 26.3 next to `type` */
function fields(value: Json): Json {
	return isObj(value.value) ? value.value : value
}

function weighted(ctx: Ctx, distribution: unknown): unknown {
	const entries = list(distribution).filter(isObj)
	let total = 0
	for (const entry of entries) total += Math.max(0, num(entry.weight, 1))
	if (entries.length === 0 || total <= 0) return undefined
	let roll = ctx.random.nextDouble() * total
	for (const entry of entries) {
		roll -= Math.max(0, num(entry.weight, 1))
		if (roll < 0) return entry.data
	}
	return entries[entries.length - 1].data
}

/** Picks an entry of a list of `{ data, weight }` */
export function pickWeighted(ctx: Ctx, entries: unknown): unknown {
	return weighted(ctx, entries)
}

/** Samples an int provider of either format */
export function sampleInt(ctx: Ctx, value: unknown, fallback = 0): number {
	if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback
	if (!isObj(value)) return fallback
	const random = ctx.random
	const v = fields(value)
	const type = shortId(value.type)
	switch (type) {
		case 'constant':
			return int(value.value, fallback)
		case '':
		case 'uniform': {
			if (type === '' && v.min_inclusive === undefined) return fallback
			const min = int(v.min_inclusive, 0)
			return between(random, min, int(v.max_inclusive, min))
		}
		case 'biased_to_bottom': {
			const min = int(v.min_inclusive, 0)
			const max = int(v.max_inclusive, min)
			return min + random.nextInt(random.nextInt(Math.max(0, max - min) + 1) + 1)
		}
		case 'very_biased_to_bottom': {
			const min = int(v.min_inclusive, 0)
			const max = int(v.max_inclusive, min)
			return min + random.nextInt(random.nextInt(random.nextInt(Math.max(0, max - min) + 1) + 1) + 1)
		}
		case 'clamped': {
			const min = int(v.min_inclusive, 0)
			return clamp(sampleInt(ctx, v.source, min), min, int(v.max_inclusive, min))
		}
		case 'clamped_normal': {
			const min = int(v.min_inclusive, 0)
			const max = int(v.max_inclusive, min)
			return Math.trunc(clamp(num(v.mean, 0) + random.nextGaussian() * num(v.deviation, 0), min, max))
		}
		case 'weighted_list':
			return sampleInt(ctx, weighted(ctx, value.distribution ?? v.distribution), fallback)
		case 'trapezoid': {
			const min = int(v.min, int(v.min_inclusive, 0))
			const max = int(v.max, int(v.max_inclusive, min))
			const range = max - min
			if (range <= 0) return min
			const side = Math.max(0, Math.floor((range - int(v.plateau, 0)) / 2))
			return min + random.nextInt(range - side + 1) + random.nextInt(side + 1)
		}
		default:
			ctx.unsupportedType('int provider', type)
			return fallback
	}
}

/** The lowest and the highest value that an int provider can give */
export function intBounds(value: unknown, fallback: [number, number] = [0, 0]): [number, number] {
	if (typeof value === 'number') return [Math.trunc(value), Math.trunc(value)]
	if (!isObj(value)) return fallback
	const v = fields(value)
	const type = shortId(value.type)
	if (type === 'constant') return [int(value.value, 0), int(value.value, 0)]
	if (type === 'weighted_list') {
		const bounds = list(value.distribution ?? v.distribution).filter(isObj).map(entry => intBounds(entry.data))
		if (bounds.length === 0) return fallback
		return [Math.min(...bounds.map(b => b[0])), Math.max(...bounds.map(b => b[1]))]
	}
	if (type === 'trapezoid') return [int(v.min, 0), int(v.max, 0)]
	if (v.min_inclusive === undefined) return fallback
	const min = int(v.min_inclusive, 0)
	return [min, int(v.max_inclusive, min)]
}

/** Samples a float provider of either format */
export function sampleFloat(ctx: Ctx, value: unknown, fallback = 0): number {
	if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
	if (!isObj(value)) return fallback
	const random = ctx.random
	const v = fields(value)
	const type = shortId(value.type)
	switch (type) {
		case 'constant':
			return num(value.value, fallback)
		case 'uniform': {
			const min = num(v.min_inclusive, 0)
			return min + random.nextFloat() * (num(v.max_exclusive, num(v.max_inclusive, min)) - min)
		}
		case 'clamped_normal': {
			const min = num(v.min, num(v.min_inclusive, 0))
			const max = num(v.max, num(v.max_inclusive, min))
			return clamp(num(v.mean, 0) + random.nextGaussian() * num(v.deviation, 0), min, max)
		}
		case 'trapezoid': {
			const min = num(v.min, 0)
			const range = num(v.max, min) - min
			const side = (range - num(v.plateau, 0)) / 2
			return min + random.nextFloat() * (range - side) + random.nextFloat() * side
		}
		default:
			ctx.unsupportedType('float provider', type)
			return fallback
	}
}

/** A normal distribution that stays inside of a range */
export function clampedNormal(ctx: Ctx, mean: number, deviation: number, min: number, max: number) {
	return clamp(mean + ctx.random.nextGaussian() * deviation, min, max)
}

/** The height of a vertical anchor, which counts from the bottom or the top of the world */
export function anchorY(ctx: Ctx, value: unknown, fallback: number): number {
	if (typeof value === 'number') return Math.trunc(value)
	if (!isObj(value)) return fallback
	if (typeof value.absolute === 'number') return Math.trunc(value.absolute)
	if (typeof value.above_bottom === 'number') return ctx.minY + Math.trunc(value.above_bottom)
	if (typeof value.below_top === 'number') return ctx.maxY - 1 - Math.trunc(value.below_top)
	if (typeof value.relative_to_sea_level === 'number') return ctx.world.seaLevel + Math.trunc(value.relative_to_sea_level)
	return fallback
}

/** Samples a height provider */
export function sampleHeight(ctx: Ctx, value: unknown): number {
	if (!isObj(value)) return typeof value === 'number' ? Math.trunc(value) : ctx.minY
	const random = ctx.random
	const type = shortId(value.type)
	const min = anchorY(ctx, value.min_inclusive, ctx.minY)
	const max = anchorY(ctx, value.max_inclusive, min)
	switch (type) {
		case '':
			return anchorY(ctx, value, ctx.minY)
		case 'constant':
			return anchorY(ctx, value.value, ctx.minY)
		case 'uniform':
			return min > max ? min : between(random, min, max)
		case 'biased_to_bottom': {
			const inner = Math.max(1, int(value.inner, 1))
			if (max - min - inner + 1 <= 0) return min
			return random.nextInt(random.nextInt(max - min - inner + 1) + inner) + min
		}
		case 'very_biased_to_bottom': {
			const inner = Math.max(1, int(value.inner, 1))
			if (max - min - inner + 1 <= 0) return min
			const a = between(random, min + inner, max)
			const b = between(random, min, a - 1)
			return between(random, min, b - 1 + inner)
		}
		case 'trapezoid': {
			if (min > max) return min
			const range = max - min
			const plateau = int(value.plateau, 0)
			if (plateau >= range) return between(random, min, max)
			const side = Math.floor((range - plateau) / 2)
			return min + between(random, 0, range - side) + between(random, 0, side)
		}
		case 'weighted_list':
			return sampleHeight(ctx, weighted(ctx, value.distribution))
		default:
			ctx.unsupportedType('height provider', type)
			return min
	}
}

/** A block id, a list of them or a `#tag`, as a test of block ids */
export function holderSet(ctx: Ctx, value: unknown): (name: string) => boolean {
	const names = new Set<string>()
	const tags: ReadonlySet<string>[] = []
	for (const entry of list(value)) {
		const text = typeof entry === 'string' ? entry : typeof obj(entry).id === 'string' ? obj(entry).id as string : ''
		if (text === '') continue
		if (text.startsWith('#')) {
			tags.push(ctx.tag(text.slice(1)))
		} else {
			names.add(text.includes(':') ? text : `minecraft:${text}`)
		}
	}
	return name => names.has(name) || tags.some(tag => tag.has(name))
}

/** The block ids of a block id, a list of them or a `#tag` */
export function holderList(ctx: Ctx, value: unknown): string[] {
	const result: string[] = []
	for (const entry of list(value)) {
		if (typeof entry !== 'string' || entry === '') continue
		if (entry.startsWith('#')) {
			result.push(...ctx.tag(entry.slice(1)))
		} else {
			result.push(entry.includes(':') ? entry : `minecraft:${entry}`)
		}
	}
	return result
}
