import { blk, parseBlock, withProps } from './blocks.js'
import { simplex2 } from './noise.js'
import { testPredicate } from './predicates.js'
import { holderList, pickWeighted, sampleInt } from './providers.js'
import { pick } from './random.js'
import type { Ctx, FBlock, Json } from './types.js'
import { axisOf, clamp, dirOf, fullId, int, isObj, list, num, obj, shortId } from './util.js'

/** How often a noise repeats: 1.19 has `firstOctave`, 26.3 has `base_octave` */
function frequency(noise: unknown): number {
	const n = obj(noise)
	return Math.pow(2, clamp(num(n.firstOctave, num(n.base_octave, 0)), -16, 8))
}

function noiseAt(provider: Json, noise: unknown, scale: number, x: number, z: number): number {
	const f = frequency(noise) * scale
	const shift = num(provider.seed, 0) % 1000
	return simplex2(x * f + shift * 1.37, z * f - shift * 0.73)
}

function byNoise(states: unknown[], value: number): unknown {
	if (states.length === 0) return undefined
	return states[clamp(Math.floor((value + 1) / 2 * states.length), 0, states.length - 1)]
}

/**
 * The block of a block state provider at a position, or undefined when it gives none (a rule based provider without a rule that passes).
 * A provider is a block state, the id of a registered provider (26.3) or an object with a type.
 */
export function provide(ctx: Ctx, provider: unknown, x: number, y: number, z: number, depth = 0): FBlock | undefined {
	if (depth > 16) return undefined
	if (typeof provider === 'string') {
		if (provider.startsWith('#')) {
			const name = pick(ctx.random, holderList(ctx, provider))
			return name === undefined ? undefined : blk(name)
		}
		let entry: unknown
		try {
			entry = ctx.data.stateProvider(fullId(provider))
		} catch (e) {
			entry = undefined
		}
		if (isObj(entry) || typeof entry === 'string' && fullId(entry) !== fullId(provider)) {
			return provide(ctx, entry, x, y, z, depth + 1)
		}
		return parseBlock(provider)
	}
	if (!isObj(provider)) return undefined
	const rawType = shortId(provider.type)
	if (rawType === '') {
		// 1.19 has rule based providers without a type
		if (Array.isArray(provider.rules)) return ruleBased(ctx, provider, x, y, z, depth)
		return parseBlock(provider)
	}
	const type = rawType.replace(/(_state|_block)?_provider$/, '')
	switch (type) {
		case 'simple':
			return provide(ctx, provider.state, x, y, z, depth + 1)
		case 'weighted':
			return provide(ctx, pickWeighted(ctx, provider.entries), x, y, z, depth + 1)
		case 'rotated': {
			const state = provide(ctx, provider.state, x, y, z, depth + 1)
			if (state === undefined) return undefined
			if (typeof provider.direction === 'string') {
				const dir = dirOf(provider.direction, 'north')
				return state.properties.axis !== undefined ? withProps(state, { axis: axisOf(dir) }) : withProps(state, { facing: dir })
			}
			return withProps(state, { axis: ['x', 'y', 'z'][ctx.random.nextInt(3)] })
		}
		case 'randomized_int': {
			const state = provide(ctx, provider.source, x, y, z, depth + 1)
			if (state === undefined || typeof provider.property !== 'string') return state
			return withProps(state, { [provider.property]: String(sampleInt(ctx, provider.values, 0)) })
		}
		case 'noise':
			return provide(ctx, byNoise(list(provider.states), noiseAt(provider, provider.noise, num(provider.scale, 1), x, z)), x, y, z, depth + 1)
		case 'dual_noise': {
			const states = list(provider.states)
			const slowScale = num(provider.slow_scale, 1)
			const variety = list(provider.variety)
			const min = int(variety[0], 1)
			const max = int(variety[1] ?? obj(provider.variety).max_inclusive, min)
			const slow = noiseAt(provider, provider.slow_noise, slowScale, x, z)
			const count = clamp(Math.floor(min + (slow + 1) / 2 * (max + 1 - min)), 1, 64)
			const chosen: unknown[] = []
			for (let i = 0; i < count; i += 1) {
				chosen.push(byNoise(states, noiseAt(provider, provider.slow_noise, slowScale, x + i * 54545, z + i * 34234)))
			}
			return provide(ctx, byNoise(chosen, noiseAt(provider, provider.noise, num(provider.scale, 1), x, z)), x, y, z, depth + 1)
		}
		case 'noise_threshold': {
			const value = noiseAt(provider, provider.noise, num(provider.scale, 1), x, z)
			if (value < num(provider.threshold, 0)) return provide(ctx, pick(ctx.random, list(provider.low_states)), x, y, z, depth + 1)
			if (ctx.random.nextFloat() < num(provider.high_chance, 0)) return provide(ctx, pick(ctx.random, list(provider.high_states)), x, y, z, depth + 1)
			return provide(ctx, provider.default_state, x, y, z, depth + 1)
		}
		case 'rule_based':
			return ruleBased(ctx, provider, x, y, z, depth)
		case 'random_block': {
			const name = pick(ctx.random, holderList(ctx, provider.blocks))
			return name === undefined ? undefined : blk(name)
		}
		case 'copy_properties': {
			// No vanilla data uses this one, so the names of its fields are a guess
			const state = provide(ctx, provider.source ?? provider.state ?? provider.provider, x, y, z, depth + 1)
			if (state === undefined) return undefined
			const current = ctx.get(x, y, z)
			const copied: Record<string, string> = {}
			for (const [k, v] of Object.entries(current.properties)) {
				if (state.properties[k] !== undefined) copied[k] = v
			}
			return withProps(state, copied)
		}
		default:
			ctx.unsupportedType('block state provider', rawType)
			return undefined
	}
}

function ruleBased(ctx: Ctx, provider: Json, x: number, y: number, z: number, depth: number): FBlock | undefined {
	for (const rule of list(provider.rules)) {
		if (!isObj(rule)) continue
		if (testPredicate(ctx, rule.if_true, x, y, z)) return provide(ctx, rule.then, x, y, z, depth + 1)
	}
	if (provider.fallback === undefined) return undefined
	return provide(ctx, provider.fallback, x, y, z, depth + 1)
}
