import { canSurvive, isAir, isSturdy, isWater, named, parseBlock, short, withProps } from './blocks.js'
import { testPredicate, testRule } from './predicates.js'
import { holderSet, pickWeighted, sampleInt } from './providers.js'
import { provide } from './states.js'
import type { Ctx, FBlock, FeatureFn } from './types.js'
import { clamp, dirOf, int, isObj, lerp, list, num, STEP } from './util.js'

const DOUBLE_PLANTS = new Set(['tall_grass', 'large_fern', 'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_seagrass', 'small_dripleaf', 'pitcher_plant'])

function nextToAir(ctx: Ctx, x: number, y: number, z: number): boolean {
	return isAir(ctx.get(x + 1, y, z)) || isAir(ctx.get(x - 1, y, z)) || isAir(ctx.get(x, y + 1, z))
		|| isAir(ctx.get(x, y - 1, z)) || isAir(ctx.get(x, y, z + 1)) || isAir(ctx.get(x, y, z - 1))
}

/** Replaces a block with the first target of an ore that accepts it */
function placeOre(ctx: Ctx, targets: unknown[], discard: number, x: number, y: number, z: number): boolean {
	const block = ctx.get(x, y, z)
	for (const target of targets) {
		if (!isObj(target) || !testRule(ctx, target.target, block, y)) continue
		const skipAirCheck = discard <= 0 ? true : discard >= 1 ? false : ctx.random.nextFloat() >= discard
		if (!skipAirCheck && nextToAir(ctx, x, y, z)) continue
		const state = parseBlock(target.state)
		if (state === undefined) continue
		return ctx.set(x, y, z, state)
	}
	return false
}

/** `minecraft:ore`: a row of overlapping balls */
export const ore: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const size = clamp(int(config.size, 0), 0, 64)
	const targets = list(config.targets)
	const discard = num(config.discard_chance_on_air_exposure, 0)
	const angle = random.nextFloat() * Math.PI
	const reach = size / 8
	const spread = Math.ceil((size / 16 * 2 + 1) / 2)
	const fromX = x + Math.sin(angle) * reach
	const toX = x - Math.sin(angle) * reach
	const fromZ = z + Math.cos(angle) * reach
	const toZ = z - Math.cos(angle) * reach
	const fromY = y + random.nextInt(3) - 2
	const toY = y + random.nextInt(3) - 2
	const minX = x - Math.ceil(reach) - spread
	const minY = y - 2 - spread
	const minZ = z - Math.ceil(reach) - spread
	const width = 2 * (Math.ceil(reach) + spread)
	let below = false
	search: for (let px = minX; px <= minX + width; px += 1) {
		for (let pz = minZ; pz <= minZ + width; pz += 1) {
			if (minY <= ctx.height('OCEAN_FLOOR_WG', px, pz)) {
				below = true
				break search
			}
		}
	}
	if (!below || size === 0) return false

	const balls = new Float64Array(size * 4)
	for (let k = 0; k < size; k += 1) {
		const f = k / size
		const h = random.nextDouble() * size / 16
		balls[k * 4] = lerp(f, fromX, toX)
		balls[k * 4 + 1] = lerp(f, fromY, toY)
		balls[k * 4 + 2] = lerp(f, fromZ, toZ)
		balls[k * 4 + 3] = ((Math.sin(Math.PI * f) + 1) * h + 1) / 2
	}
	for (let k = 0; k < size - 1; k += 1) {
		if (balls[k * 4 + 3] <= 0) continue
		for (let m = k + 1; m < size; m += 1) {
			if (balls[m * 4 + 3] <= 0) continue
			const dx = balls[k * 4] - balls[m * 4]
			const dy = balls[k * 4 + 1] - balls[m * 4 + 1]
			const dz = balls[k * 4 + 2] - balls[m * 4 + 2]
			const dr = balls[k * 4 + 3] - balls[m * 4 + 3]
			if (dr * dr > dx * dx + dy * dy + dz * dz) {
				if (dr > 0) balls[m * 4 + 3] = -1
				else balls[k * 4 + 3] = -1
			}
		}
	}
	const done = new Set<number>()
	const span = width + 1
	let placed = 0
	for (let m = 0; m < size; m += 1) {
		const r = balls[m * 4 + 3]
		if (r < 0) continue
		const cx = balls[m * 4]
		const cy = balls[m * 4 + 1]
		const cz = balls[m * 4 + 2]
		const x0 = Math.max(Math.floor(cx - r), minX)
		const y0 = Math.max(Math.floor(cy - r), minY)
		const z0 = Math.max(Math.floor(cz - r), minZ)
		const x1 = Math.max(Math.floor(cx + r), x0)
		const y1 = Math.max(Math.floor(cy + r), y0)
		const z1 = Math.max(Math.floor(cz + r), z0)
		for (let px = x0; px <= x1; px += 1) {
			const u = (px + 0.5 - cx) / r
			if (u * u >= 1) continue
			for (let py = y0; py <= y1; py += 1) {
				const v = (py + 0.5 - cy) / r
				if (u * u + v * v >= 1) continue
				for (let pz = z0; pz <= z1; pz += 1) {
					const w = (pz + 0.5 - cz) / r
					if (u * u + v * v + w * w >= 1 || ctx.outside(py)) continue
					const index = px - minX + (py - minY) * span + (pz - minZ) * span * 64
					if (done.has(index)) continue
					done.add(index)
					if (placeOre(ctx, targets, discard, px, py, pz)) placed += 1
				}
			}
		}
	}
	return placed > 0
}

/** `minecraft:scattered_ore`: single blocks around the origin */
export const scatteredOre: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const targets = list(config.targets)
	const discard = num(config.discard_chance_on_air_exposure, 0)
	const count = random.nextInt(clamp(int(config.size, 0), 0, 64) + 1)
	const offset = (spread: number) => Math.round((random.nextFloat() - random.nextFloat()) * spread)
	for (let i = 0; i < count; i += 1) {
		const spread = Math.min(i, 7)
		const px = x + offset(spread)
		const py = y + offset(spread)
		const pz = z + offset(spread)
		placeOre(ctx, targets, discard, px, py, pz)
	}
	return true
}

/** Places a block the way `simple_block` does: plants of two blocks get their upper half */
export function placeSimple(ctx: Ctx, state: FBlock, x: number, y: number, z: number): boolean {
	if (!canSurvive(ctx, state, x, y, z)) return false
	if (DOUBLE_PLANTS.has(short(state)) && state.properties.half !== 'upper') {
		const above = ctx.get(x, y + 1, z)
		const inWater = isWater(above) && named(state, 'tall_seagrass', 'small_dripleaf')
		if (!isAir(above) && !inWater) return false
		const lower = withProps(state, { half: 'lower' })
		let upper = withProps(state, { half: 'upper' })
		if (inWater && upper.properties.waterlogged !== undefined) upper = withProps(upper, { waterlogged: 'true' })
		ctx.set(x, y, z, lower)
		ctx.set(x, y + 1, z, upper)
		return true
	}
	ctx.set(x, y, z, state)
	return true
}

/** `minecraft:simple_block` */
export const simpleBlock: FeatureFn = (ctx, config, x, y, z) => {
	const state = provide(ctx, config.to_place, x, y, z)
	if (state === undefined) return false
	return placeSimple(ctx, state, x, y, z)
}

/** `minecraft:block_column`: layers of blocks in a row, up or down */
export const blockColumn: FeatureFn = (ctx, config, x, y, z) => {
	const layers = list(config.layers).filter(isObj).slice(0, 64)
	const heights = layers.map(layer => clamp(sampleInt(ctx, layer.height, 0), 0, 256))
	const total = heights.reduce((a, b) => a + b, 0)
	if (total === 0) return false
	const step = STEP[dirOf(config.direction, 'up')]
	const tip = config.prioritize_tip === true
	for (let l = 0; l < total; l += 1) {
		const px = x + step[0] * (l + 1)
		const py = y + step[1] * (l + 1)
		const pz = z + step[2] * (l + 1)
		if (testPredicate(ctx, config.allowed_placement, px, py, pz)) continue
		// Shorten the column to what fits
		let over = total - l
		for (let m = tip ? 0 : heights.length - 1; m >= 0 && m < heights.length && over > 0; m += tip ? 1 : -1) {
			const cut = Math.min(heights[m], over)
			over -= cut
			heights[m] -= cut
		}
		break
	}
	let n = 0
	for (let l = 0; l < layers.length; l += 1) {
		for (let i = 0; i < heights[l]; i += 1) {
			const px = x + step[0] * n
			const py = y + step[1] * n
			const pz = z + step[2] * n
			const state = provide(ctx, layers[l].provider, px, py, pz)
			if (state !== undefined) ctx.set(px, py, pz, state)
			n += 1
		}
	}
	return true
}

/** `minecraft:block_pile` */
export const blockPile: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	if (y < ctx.minY + 5) return false
	const rx = 2 + random.nextInt(2)
	const rz = 2 + random.nextInt(2)
	const tryPlace = (px: number, py: number, pz: number) => {
		if (!isAir(ctx.get(px, py, pz))) return
		const below = ctx.get(px, py - 1, pz)
		const supported = named(below, 'dirt_path') ? random.nextBoolean() : isSturdy(below, 'up', ctx)
		if (!supported) return
		const state = provide(ctx, config.state_provider, px, py, pz)
		if (state !== undefined) ctx.set(px, py, pz, state)
	}
	for (let px = x - rx; px <= x + rx; px += 1) {
		for (let py = y; py <= y + 1; py += 1) {
			for (let pz = z - rz; pz <= z + rz; pz += 1) {
				const dx = x - px
				const dz = z - pz
				if (dx * dx + dz * dz <= random.nextFloat() * 10 - random.nextFloat() * 6) tryPlace(px, py, pz)
				else if (random.nextFloat() < 0.031) tryPlace(px, py, pz)
			}
		}
	}
	return true
}

/** `minecraft:disk`: a round patch that replaces its target */
export const disk: FeatureFn = (ctx, config, x, y, z) => {
	const half = clamp(int(config.half_height, 0), 0, 32)
	const radius = clamp(sampleInt(ctx, config.radius, 0), 0, 32)
	let placed = false
	for (let px = x - radius; px <= x + radius; px += 1) {
		for (let pz = z - radius; pz <= z + radius; pz += 1) {
			const dx = px - x
			const dz = pz - z
			if (dx * dx + dz * dz > radius * radius) continue
			for (let py = y + half; py > y - half - 1; py -= 1) {
				if (!testPredicate(ctx, config.target, px, py, pz)) continue
				const state = provide(ctx, config.state_provider, px, py, pz)
				if (state !== undefined && ctx.set(px, py, pz, state)) placed = true
			}
		}
	}
	return placed
}

/** `minecraft:random_patch`, `minecraft:flower` and `minecraft:no_bonemeal_flower` (1.19) */
export const randomPatch: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const tries = clamp(int(config.tries, 128), 0, 4096)
	const xz = clamp(int(config.xz_spread, 7), 0, 64) + 1
	const ys = clamp(int(config.y_spread, 3), 0, 64) + 1
	let placed = 0
	for (let i = 0; i < tries; i += 1) {
		const px = x + random.nextInt(xz) - random.nextInt(xz)
		const py = y + random.nextInt(ys) - random.nextInt(ys)
		const pz = z + random.nextInt(xz) - random.nextInt(xz)
		if (ctx.nested(config.feature, px, py, pz)) placed += 1
	}
	return placed > 0
}

/** `minecraft:random_selector` */
export const randomSelector: FeatureFn = (ctx, config, x, y, z) => {
	for (const entry of list(config.features)) {
		if (!isObj(entry)) continue
		if (ctx.random.nextFloat() < num(entry.chance, 0)) return ctx.nested(entry.feature, x, y, z)
	}
	return ctx.nested(config.default, x, y, z)
}

/** `minecraft:simple_random_selector` */
export const simpleRandomSelector: FeatureFn = (ctx, config, x, y, z) => {
	const features = list(config.features)
	if (features.length === 0) return false
	return ctx.nested(features[ctx.random.nextInt(features.length)], x, y, z)
}

/** `minecraft:random_boolean_selector` */
export const randomBooleanSelector: FeatureFn = (ctx, config, x, y, z) => {
	return ctx.nested(ctx.random.nextBoolean() ? config.feature_true : config.feature_false, x, y, z)
}

/** `minecraft:weighted_random_selector` (26.3) */
export const weightedRandomSelector: FeatureFn = (ctx, config, x, y, z) => {
	const chosen = pickWeighted(ctx, config.features)
	return chosen === undefined ? false : ctx.nested(chosen, x, y, z)
}

/** `minecraft:sequence` (26.3): the features one after the other, until one of them fails */
export const sequence: FeatureFn = (ctx, config, x, y, z) => {
	let any = false
	for (const feature of list(config.features)) {
		if (!ctx.nested(feature, x, y, z)) break
		any = true
	}
	return any
}

/** `minecraft:overlay` (26.3): all of the features at the same place */
export const overlay: FeatureFn = (ctx, config, x, y, z) => {
	let any = false
	for (const feature of list(config.features)) {
		if (ctx.nested(feature, x, y, z)) any = true
	}
	return any
}

export const noOp: FeatureFn = () => true

/** `minecraft:replace_single_block` */
export const replaceSingleBlock: FeatureFn = (ctx, config, x, y, z) => {
	placeOre(ctx, list(config.targets), 0, x, y, z)
	return true
}

/** `minecraft:fill_layer`: a layer over the whole chunk */
export const fillLayer: FeatureFn = (ctx, config, x, _y, z) => {
	const state = parseBlock(config.state)
	if (state === undefined) return false
	const py = ctx.minY + int(config.height, 0)
	const cx = x & ~15
	const cz = z & ~15
	let placed = false
	for (let dx = 0; dx < 16; dx += 1) {
		for (let dz = 0; dz < 16; dz += 1) {
			if (isAir(ctx.get(cx + dx, py, cz + dz)) && ctx.set(cx + dx, py, cz + dz, state)) placed = true
		}
	}
	return placed
}

/** `minecraft:spring_feature`: a source of water or lava in a wall */
export const spring: FeatureFn = (ctx, config, x, y, z) => {
	const valid = holderSet(ctx, config.valid_blocks)
	const isValid = (px: number, py: number, pz: number) => valid(ctx.get(px, py, pz).name)
	if (!isValid(x, y + 1, z)) return false
	if (config.requires_block_below !== false && !isValid(x, y - 1, z)) return false
	const current = ctx.get(x, y, z)
	if (!isAir(current) && !valid(current.name)) return false
	const around: [number, number, number][] = [[x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1], [x, y - 1, z]]
	let rocks = 0
	let holes = 0
	for (const [px, py, pz] of around) {
		if (isValid(px, py, pz)) rocks += 1
		if (isAir(ctx.get(px, py, pz))) holes += 1
	}
	if (rocks !== int(config.rock_count, 4) || holes !== int(config.hole_count, 1)) return false
	const fluid = parseBlock(config.state)
	if (fluid === undefined) return false
	// The fluid of a spring is a source that starts to flow, so it is placed as a source
	return ctx.set(x, y, z, { name: fluid.name, properties: { level: '0' } })
}
