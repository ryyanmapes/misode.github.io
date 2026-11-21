import { isAir, isFluid, named } from './blocks.js'
import { simplex2 } from './noise.js'
import { testPredicate } from './predicates.js'
import { sampleHeight, sampleInt } from './providers.js'
import { pick } from './random.js'
import type { Ctx, FBlock, HeightmapType, Pos } from './types.js'
import { clamp, dirOf, int, isObj, list, num, shortId, STEP } from './util.js'

/** The most positions that one list of placement modifiers can end up with */
export const MAX_POSITIONS = 4096
const MAX_COUNT = 256
const MAX_LAYERS = 64

const HEIGHTMAPS = new Set(['WORLD_SURFACE_WG', 'WORLD_SURFACE', 'OCEAN_FLOOR_WG', 'OCEAN_FLOOR', 'MOTION_BLOCKING', 'MOTION_BLOCKING_NO_LEAVES'])

export function heightmapOf(value: unknown): HeightmapType {
	const text = typeof value === 'string' ? value.toUpperCase() : ''
	return HEIGHTMAPS.has(text) ? text as HeightmapType : 'WORLD_SURFACE'
}

/** The placement modifiers that the engine knows, without namespace */
export const PLACEMENT_MODIFIERS = [
	'biome', 'block_predicate_filter', 'carving_mask', 'count', 'count_on_every_layer', 'cuboid', 'environment_scan', 'fixed_placement',
	'height_range', 'heightmap', 'in_square', 'noise_based_count', 'noise_threshold_count', 'offset', 'random_chance', 'random_offset',
	'randomly_selected', 'rarity_filter', 'surface_relative_threshold_filter', 'surface_water_depth_filter',
]

/**
 * The noise that the count modifiers look at. The game has one noise of its own for this, which is the same in every world.
 * This one is shifted so that it is about 0.5 around the origin, where previews tend to be.
 */
function countNoise(x: number, z: number) {
	return simplex2(x + 15, z + 35.5)
}

function emptyForLayers(block: FBlock) {
	return isAir(block) || isFluid(block)
}

/** The y above the n-th floor of a column, counted from the top */
function groundOfLayer(ctx: Ctx, x: number, startY: number, z: number, layer: number): number | undefined {
	let count = 0
	let state = ctx.get(x, startY, z)
	for (let y = startY; y >= ctx.minY + 1; y -= 1) {
		const below = ctx.get(x, y - 1, z)
		if (!emptyForLayers(below) && emptyForLayers(state) && !named(below, 'bedrock')) {
			if (count === layer) return y
			count += 1
		}
		state = below
	}
	return undefined
}

function apply(ctx: Ctx, modifier: unknown, pos: Pos, out: Pos[], depth: number): void {
	if (!isObj(modifier)) {
		out.push(pos)
		return
	}
	const random = ctx.random
	const [x, y, z] = pos
	const type = shortId(modifier.type)
	switch (type) {
		case 'count': {
			const count = clamp(sampleInt(ctx, modifier.count, 0), 0, MAX_COUNT)
			for (let i = 0; i < count; i += 1) out.push([x, y, z])
			return
		}
		case 'count_on_every_layer': {
			for (let layer = 0; layer < MAX_LAYERS; layer += 1) {
				let found = false
				const count = clamp(sampleInt(ctx, modifier.count, 0), 0, MAX_COUNT)
				for (let i = 0; i < count; i += 1) {
					const px = x + random.nextInt(16)
					const pz = z + random.nextInt(16)
					const ground = groundOfLayer(ctx, px, ctx.height('MOTION_BLOCKING', px, pz), pz, layer)
					if (ground !== undefined) {
						out.push([px, ground, pz])
						found = true
					}
				}
				if (!found || out.length >= MAX_POSITIONS) break
			}
			return
		}
		case 'in_square':
			out.push([x + random.nextInt(16), y, z + random.nextInt(16)])
			return
		case 'height_range':
			out.push([x, sampleHeight(ctx, modifier.height), z])
			return
		case 'heightmap': {
			const height = ctx.height(heightmapOf(modifier.heightmap), x, z)
			if (height > ctx.minY) out.push([x, height, z])
			return
		}
		case 'rarity_filter': {
			const chance = num(modifier.chance, 1)
			if (chance <= 1 || random.nextFloat() < 1 / chance) out.push(pos)
			return
		}
		case 'random_chance':
			if (random.nextFloat() < num(modifier.chance, 1)) out.push(pos)
			return
		case 'random_offset': {
			const dx = sampleInt(ctx, modifier.xz_spread, 0)
			const dy = sampleInt(ctx, modifier.y_spread, 0)
			const dz = sampleInt(ctx, modifier.xz_spread, 0)
			out.push([x + dx, y + dy, z + dz])
			return
		}
		case 'offset': {
			const dx = sampleInt(ctx, modifier.x, 0)
			const dy = sampleInt(ctx, modifier.y, 0)
			const dz = sampleInt(ctx, modifier.z, 0)
			out.push([x + dx, y + dy, z + dz])
			return
		}
		case 'environment_scan': {
			const step = STEP[dirOf(modifier.direction_of_search, 'down')][1] || -1
			const steps = clamp(int(modifier.max_steps, 1), 1, 512)
			const allowed = modifier.allowed_search_condition
			let py = y
			if (!testPredicate(ctx, allowed, x, py, z)) return
			for (let i = 0; i < steps; i += 1) {
				if (testPredicate(ctx, modifier.target_condition, x, py, z)) {
					out.push([x, py, z])
					return
				}
				py += step
				if (ctx.outside(py)) return
				if (!testPredicate(ctx, allowed, x, py, z)) break
			}
			if (testPredicate(ctx, modifier.target_condition, x, py, z)) out.push([x, py, z])
			return
		}
		case 'block_predicate_filter':
			if (testPredicate(ctx, modifier.predicate, x, y, z)) out.push(pos)
			return
		case 'surface_relative_threshold_filter': {
			const surface = ctx.height(heightmapOf(modifier.heightmap), x, z)
			const min = surface + num(modifier.min_inclusive, -Infinity)
			const max = surface + num(modifier.max_inclusive, Infinity)
			if (y >= min && y <= max) out.push(pos)
			return
		}
		case 'surface_water_depth_filter': {
			const floor = ctx.height('OCEAN_FLOOR', x, z)
			const surface = ctx.height('WORLD_SURFACE', x, z)
			if (surface - floor <= int(modifier.max_water_depth, 0)) out.push(pos)
			return
		}
		case 'noise_based_count': {
			const factor = num(modifier.noise_factor, 1) || 1
			const noise = countNoise(x / factor, z / factor)
			const count = clamp(Math.ceil((noise + num(modifier.noise_offset, 0)) * num(modifier.noise_to_count_ratio, 0)), 0, MAX_COUNT)
			for (let i = 0; i < count; i += 1) out.push([x, y, z])
			return
		}
		case 'noise_threshold_count': {
			const noise = countNoise(x / 200, z / 200)
			const count = clamp(int(noise < num(modifier.noise_level, 0) ? modifier.below_noise : modifier.above_noise, 0), 0, MAX_COUNT)
			for (let i = 0; i < count; i += 1) out.push([x, y, z])
			return
		}
		case 'biome':
			// The engine does not know biomes, so every position is in the right one
			out.push(pos)
			return
		case 'carving_mask':
			// Nothing is carved here
			return
		case 'cuboid': {
			// The faces of a box that starts at the position, without its inside, edges and corners unless asked for
			const sx = clamp(sampleInt(ctx, modifier.xz_size, 0), 0, 32)
			const sy = clamp(sampleInt(ctx, modifier.y_size, 0), 0, 32)
			const sz = clamp(sampleInt(ctx, modifier.xz_size, 0), 0, 32)
			const edges = modifier.include_edges !== false
			const interior = modifier.include_interior !== false
			for (let dx = 0; dx <= sx; dx += 1) {
				for (let dy = 0; dy <= sy; dy += 1) {
					for (let dz = 0; dz <= sz; dz += 1) {
						const borders = (dx === 0 || dx === sx ? 1 : 0) + (dy === 0 || dy === sy ? 1 : 0) + (dz === 0 || dz === sz ? 1 : 0)
						if (borders === 0 ? !interior : borders >= 2 && !edges) continue
						out.push([x + dx, y + dy, z + dz])
					}
				}
			}
			return
		}
		case 'fixed_placement': {
			for (const entry of list(modifier.positions)) {
				if (!Array.isArray(entry)) continue
				const px = int(entry[0], 0)
				const py = int(entry[1], 0)
				const pz = int(entry[2], 0)
				if (px >> 4 === x >> 4 && pz >> 4 === z >> 4) out.push([px, py, pz])
			}
			return
		}
		case 'randomly_selected': {
			const chosen = pick(random, list(modifier.placements))
			if (chosen === undefined || depth > 8) return
			apply(ctx, chosen, pos, out, depth + 1)
			return
		}
		default:
			ctx.unsupportedType('placement modifier', type)
			out.push(pos)
	}
}

/** Runs a list of placement modifiers from a position and returns the positions that are left, at most `MAX_POSITIONS` */
export function runModifiers(ctx: Ctx, modifiers: unknown, x: number, y: number, z: number): Pos[] {
	let positions: Pos[] = [[x, y, z]]
	for (const modifier of list(modifiers)) {
		const next: Pos[] = []
		for (const pos of positions) {
			apply(ctx, modifier, pos, next, 0)
			if (next.length >= MAX_POSITIONS) break
		}
		if (next.length > MAX_POSITIONS) next.length = MAX_POSITIONS
		positions = next
		if (positions.length === 0) break
	}
	return positions
}
