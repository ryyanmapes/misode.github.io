import { AIR, blk, canSurvive, fluidOf, inTag, isAir, isDirt, isFluid, isFullCube, isLeaves, isReplaceable, isSolidIn, isSturdy, isWater, named, parseBlock, WATER, withProps } from './blocks.js'
import { testPredicate } from './predicates.js'
import { holderList, holderSet, sampleInt } from './providers.js'
import { between, pick, shuffled } from './random.js'
import { provide } from './states.js'
import type { Ctx, FBlock, FeatureFn, Json, Pos } from './types.js'
import type { Dir } from './util.js'
import { clamp, CLOCKWISE, DIRECTIONS, HORIZONTAL, int, key, num, OPPOSITE, STEP } from './util.js'

/** `minecraft:vines`: one vine on a wall or under a ceiling */
export const vines: FeatureFn = (ctx, _config, x, y, z) => {
	if (!isAir(ctx.get(x, y, z))) return false
	for (const dir of DIRECTIONS) {
		if (dir === 'down') continue
		const neighbour = ctx.get(x + STEP[dir][0], y + STEP[dir][1], z + STEP[dir][2])
		if (!isSturdy(neighbour, OPPOSITE[dir], ctx) && !isLeaves(neighbour, ctx)) continue
		return ctx.set(x, y, z, blk('vine', { east: 'false', north: 'false', south: 'false', west: 'false', up: 'false', [dir]: 'true' }))
	}
	return false
}

/** `minecraft:bamboo` */
export const bamboo: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	if (!isAir(ctx.get(x, y, z))) return false
	if (canSurvive(ctx, blk('bamboo'), x, y, z)) {
		const height = random.nextInt(12) + 5
		if (random.nextFloat() < num(config.probability, 0)) {
			const r = random.nextInt(4) + 1
			const podzolTag = ctx.tag('minecraft:beneath_bamboo_podzol_replaceable')
			for (let px = x - r; px <= x + r; px += 1) {
				for (let pz = z - r; pz <= z + r; pz += 1) {
					if ((px - x) * (px - x) + (pz - z) * (pz - z) > r * r) continue
					const py = ctx.height('WORLD_SURFACE', px, pz) - 1
					const ground = ctx.get(px, py, pz)
					if (podzolTag.size > 0 ? podzolTag.has(ground.name) : isDirt(ground, ctx)) ctx.set(px, py, pz, blk('podzol', { snowy: 'false' }))
				}
			}
		}
		let py = y
		for (let k = 0; k < height && isAir(ctx.get(x, py, z)); k += 1) {
			ctx.set(x, py, z, blk('bamboo', { age: '1', leaves: 'none', stage: '0' }))
			py += 1
		}
		if (py - y >= 3) {
			ctx.set(x, py, z, blk('bamboo', { age: '1', leaves: 'large', stage: '1' }))
			ctx.set(x, py - 1, z, blk('bamboo', { age: '1', leaves: 'large', stage: '0' }))
			ctx.set(x, py - 2, z, blk('bamboo', { age: '1', leaves: 'small', stage: '0' }))
		}
	}
	return true
}

function mushroomHeight(ctx: Ctx) {
	let height = ctx.random.nextInt(3) + 4
	if (ctx.random.nextInt(12) === 0) height *= 2
	return height
}

function hugeMushroom(ctx: Ctx, config: Json, x: number, y: number, z: number, brown: boolean): boolean {
	const height = mushroomHeight(ctx)
	const radius = clamp(int(config.foliage_radius, brown ? 3 : 2), 0, 16)
	if (y < ctx.minY + 1 || y + height + 1 >= ctx.maxY) return false
	const below = ctx.get(x, y - 1, z)
	if (config.can_place_on !== undefined) {
		if (!testPredicate(ctx, config.can_place_on, x, y - 1, z)) return false
	} else if (!isDirt(below, ctx) && !inTag(ctx, below, 'minecraft:mushroom_grow_block')) {
		return false
	}
	for (let j = 0; j <= height; j += 1) {
		const r = brown && j > 3 ? radius : 0
		for (let dx = -r; dx <= r; dx += 1) {
			for (let dz = -r; dz <= r; dz += 1) {
				const block = ctx.get(x + dx, y + j, z + dz)
				if (!isAir(block) && !isLeaves(block, ctx)) return false
			}
		}
	}
	const cap = (px: number, py: number, pz: number, sides: Record<string, string>) => {
		if (isFullCube(ctx.get(px, py, pz), ctx)) return
		const state = provide(ctx, config.cap_provider, x, y, z)
		if (state === undefined) return
		ctx.set(px, py, pz, state.properties.west !== undefined ? withProps(state, sides) : state)
	}
	if (brown) {
		for (let j = -radius; j <= radius; j += 1) {
			for (let k = -radius; k <= radius; k += 1) {
				const minX = j === -radius
				const maxX = j === radius
				const minZ = k === -radius
				const maxZ = k === radius
				const edgeX = minX || maxX
				const edgeZ = minZ || maxZ
				if (edgeX && edgeZ) continue
				cap(x + j, y + height, z + k, {
					west: String(minX || edgeZ && j === 1 - radius),
					east: String(maxX || edgeZ && j === radius - 1),
					north: String(minZ || edgeX && k === 1 - radius),
					south: String(maxZ || edgeX && k === radius - 1),
				})
			}
		}
	} else {
		for (let i = height - 3; i <= height; i += 1) {
			const r = i < height ? radius : radius - 1
			const inner = radius - 2
			for (let l = -r; l <= r; l += 1) {
				for (let m = -r; m <= r; m += 1) {
					const edgeX = l === -r || l === r
					const edgeZ = m === -r || m === r
					if (i < height && edgeX === edgeZ) continue
					cap(x + l, y + i, z + m, {
						up: String(i >= height - 1),
						west: String(l < -inner),
						east: String(l > inner),
						north: String(m < -inner),
						south: String(m > inner),
					})
				}
			}
		}
	}
	for (let i = 0; i < height; i += 1) {
		if (isFullCube(ctx.get(x, y + i, z), ctx)) continue
		const state = provide(ctx, config.stem_provider, x, y, z)
		if (state !== undefined) ctx.set(x, y + i, z, state)
	}
	return true
}

export const hugeRedMushroom: FeatureFn = (ctx, config, x, y, z) => hugeMushroom(ctx, config, x, y, z, false)
export const hugeBrownMushroom: FeatureFn = (ctx, config, x, y, z) => hugeMushroom(ctx, config, x, y, z, true)

/** A column of weeping vines that hangs down from a position */
function weepingColumn(ctx: Ctx, x: number, y: number, z: number, height: number, minAge: number, maxAge: number) {
	let py = y
	for (let i = 0; i <= height; i += 1) {
		if (isAir(ctx.get(x, py, z))) {
			if (i === height || !isAir(ctx.get(x, py - 1, z))) {
				ctx.set(x, py, z, blk('weeping_vines', { age: String(between(ctx.random, minAge, maxAge)) }))
				break
			}
			ctx.set(x, py, z, blk('weeping_vines_plant'))
		}
		py -= 1
	}
}

/** A column of twisting vines that grows up from a position */
function twistingColumn(ctx: Ctx, x: number, y: number, z: number, height: number, minAge: number, maxAge: number) {
	let py = y
	for (let i = 1; i <= height; i += 1) {
		if (isAir(ctx.get(x, py, z))) {
			if (i === height || !isAir(ctx.get(x, py + 1, z))) {
				ctx.set(x, py, z, blk('twisting_vines', { age: String(between(ctx.random, minAge, maxAge)) }))
				break
			}
			ctx.set(x, py, z, blk('twisting_vines_plant'))
		}
		py += 1
	}
}

/** `minecraft:huge_fungus` */
export const hugeFungus: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const base = parseBlock(config.valid_base_block)
	const stem = parseBlock(config.stem_state)
	const hat = parseBlock(config.hat_state)
	const decor = parseBlock(config.decor_state)
	if (base === undefined || stem === undefined || hat === undefined || decor === undefined) return false
	if (ctx.get(x, y - 1, z).name !== base.name) return false
	const planted = config.planted === true
	let height = between(random, 4, 13)
	if (random.nextInt(12) === 0) height *= 2
	if (!planted && y + height + 1 >= ctx.maxY) return false
	const thick = !planted && random.nextFloat() < 0.06
	const replaceable = (px: number, py: number, pz: number, checkConfig: boolean) => {
		const block = ctx.get(px, py, pz)
		if (isReplaceable(block, ctx)) return true
		if (!checkConfig) return false
		if (config.replaceable_blocks !== undefined) return testPredicate(ctx, config.replaceable_blocks, px, py, pz)
		return !isSolidIn(block, ctx) && !isFluid(block)
	}
	ctx.set(x, y, z, AIR)
	const reach = thick ? 1 : 0
	const stemState = stem.properties.axis === undefined && /_(stem|log)$/.test(stem.name) ? withProps(stem, { axis: 'y' }) : stem
	for (let dx = -reach; dx <= reach; dx += 1) {
		for (let dz = -reach; dz <= reach; dz += 1) {
			const corner = thick && Math.abs(dx) === reach && Math.abs(dz) === reach
			for (let dy = 0; dy < height; dy += 1) {
				if (!replaceable(x + dx, y + dy, z + dz, true)) continue
				if (corner && !planted) {
					if (random.nextFloat() < 0.1) ctx.set(x + dx, y + dy, z + dz, stemState)
				} else {
					ctx.set(x + dx, y + dy, z + dz, stemState)
				}
			}
		}
	}
	const wart = named(hat, 'nether_wart_block')
	const vinesBelow = (px: number, py: number, pz: number) => {
		if (!isAir(ctx.get(px, py - 1, pz))) return
		let length = between(random, 1, 5)
		if (random.nextInt(7) === 0) length *= 2
		weepingColumn(ctx, px, py - 1, pz, length, 23, 25)
	}
	const hatBlock = (px: number, py: number, pz: number, decorChance: number, hatChance: number, vineChance: number) => {
		if (random.nextFloat() < decorChance) {
			ctx.set(px, py, pz, decor)
		} else if (random.nextFloat() < hatChance) {
			ctx.set(px, py, pz, hat)
			if (random.nextFloat() < vineChance) vinesBelow(px, py, pz)
		}
	}
	const hatHeight = Math.min(random.nextInt(1 + Math.floor(height / 3)) + 5, height)
	const hatStart = height - hatHeight
	for (let k = hatStart; k <= height; k += 1) {
		let r = k < height - random.nextInt(3) ? 2 : 1
		if (hatHeight > 8 && k < hatStart + 4) r = 3
		if (thick) r += 1
		for (let dx = -r; dx <= r; dx += 1) {
			for (let dz = -r; dz <= r; dz += 1) {
				const edgeX = dx === -r || dx === r
				const edgeZ = dz === -r || dz === r
				const inner = !edgeX && !edgeZ && k !== height
				const corner = edgeX && edgeZ
				const px = x + dx
				const py = y + k
				const pz = z + dz
				if (!replaceable(px, py, pz, false)) continue
				if (k < hatStart + 3) {
					if (inner) continue
					if (ctx.get(px, py - 1, pz).name === hat.name) {
						ctx.set(px, py, pz, hat)
					} else if (random.nextFloat() < 0.15) {
						ctx.set(px, py, pz, hat)
						if (wart && random.nextInt(11) === 0) vinesBelow(px, py, pz)
					}
				} else if (inner) {
					hatBlock(px, py, pz, 0.1, 0.2, wart ? 0.1 : 0)
				} else if (corner) {
					hatBlock(px, py, pz, 0.01, 0.7, wart ? 0.083 : 0)
				} else {
					hatBlock(px, py, pz, 0.0005, 0.98, wart ? 0.07 : 0)
				}
			}
		}
	}
	return true
}

/** `minecraft:nether_forest_vegetation` (1.19) */
export const netherForestVegetation: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const below = ctx.get(x, y - 1, z)
	if (!inTag(ctx, below, 'minecraft:nylium') && !named(below, 'crimson_nylium', 'warped_nylium')) return false
	if (y < ctx.minY + 1 || y + 1 >= ctx.maxY) return false
	const width = clamp(int(config.spread_width, 8), 1, 32)
	const height = clamp(int(config.spread_height, 4), 1, 32)
	let placed = 0
	for (let i = 0; i < width * width; i += 1) {
		const px = x + random.nextInt(width) - random.nextInt(width)
		const py = y + random.nextInt(height) - random.nextInt(height)
		const pz = z + random.nextInt(width) - random.nextInt(width)
		const state = provide(ctx, config.state_provider, px, py, pz)
		if (state !== undefined && isAir(ctx.get(px, py, pz)) && py > ctx.minY && canSurvive(ctx, state, px, py, pz)) {
			ctx.set(px, py, pz, state)
			placed += 1
		}
	}
	return placed > 0
}

/** `minecraft:twisting_vines` (1.19) */
export const twistingVines: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const invalid = (px: number, py: number, pz: number) => {
		if (!isAir(ctx.get(px, py, pz))) return true
		return !named(ctx.get(px, py - 1, pz), 'netherrack', 'warped_nylium', 'warped_wart_block')
	}
	if (invalid(x, y, z)) return false
	const width = clamp(int(config.spread_width, 8), 1, 32)
	const height = clamp(int(config.spread_height, 4), 1, 32)
	const maxHeight = clamp(int(config.max_height, 8), 1, 64)
	for (let i = 0; i < width * width; i += 1) {
		const px = x + between(random, -width, width)
		let py = y + between(random, -height, height)
		const pz = z + between(random, -width, width)
		let ground = false
		for (let guard = 0; guard < 512; guard += 1) {
			py -= 1
			if (ctx.outside(py)) break
			if (!isAir(ctx.get(px, py, pz))) {
				ground = true
				break
			}
		}
		if (!ground) continue
		py += 1
		if (invalid(px, py, pz)) continue
		let length = between(random, 1, maxHeight)
		if (random.nextInt(6) === 0) length *= 2
		if (random.nextInt(5) === 0) length = 1
		twistingColumn(ctx, px, py, pz, length, 17, 25)
	}
	return true
}

/** `minecraft:weeping_vines` (1.19) */
export const weepingVines: FeatureFn = (ctx, _config, x, y, z) => {
	const random = ctx.random
	const roof = (px: number, py: number, pz: number) => named(ctx.get(px, py, pz), 'netherrack', 'nether_wart_block')
	if (!isAir(ctx.get(x, y, z)) || !roof(x, y + 1, z)) return false
	ctx.set(x, y, z, blk('nether_wart_block'))
	for (let i = 0; i < 200; i += 1) {
		const px = x + random.nextInt(6) - random.nextInt(6)
		const py = y + random.nextInt(2) - random.nextInt(5)
		const pz = z + random.nextInt(6) - random.nextInt(6)
		if (!isAir(ctx.get(px, py, pz))) continue
		let count = 0
		for (const dir of DIRECTIONS) {
			if (roof(px + STEP[dir][0], py + STEP[dir][1], pz + STEP[dir][2])) count += 1
			if (count > 1) break
		}
		if (count === 1) ctx.set(px, py, pz, blk('nether_wart_block'))
	}
	for (let i = 0; i < 100; i += 1) {
		const px = x + random.nextInt(8) - random.nextInt(8)
		const py = y + random.nextInt(2) - random.nextInt(7)
		const pz = z + random.nextInt(8) - random.nextInt(8)
		if (!isAir(ctx.get(px, py, pz)) || !roof(px, py + 1, pz)) continue
		let length = between(random, 1, 8)
		if (random.nextInt(6) === 0) length *= 2
		if (random.nextInt(5) === 0) length = 1
		weepingColumn(ctx, px, py, pz, length, 17, 25)
	}
	return true
}

/** `minecraft:glowstone_blob` (1.19) */
export const glowstoneBlob: FeatureFn = (ctx, _config, x, y, z) => {
	const random = ctx.random
	if (!isAir(ctx.get(x, y, z))) return false
	if (!named(ctx.get(x, y + 1, z), 'netherrack', 'basalt', 'blackstone')) return false
	const glowstone = blk('glowstone')
	ctx.set(x, y, z, glowstone)
	for (let i = 0; i < 1500; i += 1) {
		const px = x + random.nextInt(8) - random.nextInt(8)
		const py = y - random.nextInt(12)
		const pz = z + random.nextInt(8) - random.nextInt(8)
		if (!isAir(ctx.get(px, py, pz))) continue
		let count = 0
		for (const dir of DIRECTIONS) {
			if (ctx.get(px + STEP[dir][0], py + STEP[dir][1], pz + STEP[dir][2]).name === glowstone.name) count += 1
			if (count > 1) break
		}
		if (count === 1) ctx.set(px, py, pz, glowstone)
	}
	return true
}

/** `minecraft:random_neighbor_spread` (26.3): grows a blob by adding blocks that touch exactly one accepted neighbour */
export const randomNeighborSpread: FeatureFn = (ctx, config, x, y, z) => {
	const accepted = holderSet(ctx, config.accepted_neighbors)
	const attempts = clamp(int(config.attempts, 0), 0, 4096)
	let placed = false
	const put = (px: number, py: number, pz: number) => {
		const state = provide(ctx, config.block, px, py, pz)
		if (state !== undefined && ctx.set(px, py, pz, state)) placed = true
	}
	if (testPredicate(ctx, config.can_replace, x, y, z)) put(x, y, z)
	for (let i = 0; i < attempts; i += 1) {
		const px = x + sampleInt(ctx, config.xz_offset, 0)
		const py = y + sampleInt(ctx, config.y_offset, 0)
		const pz = z + sampleInt(ctx, config.xz_offset, 0)
		if (!testPredicate(ctx, config.can_replace, px, py, pz)) continue
		let count = 0
		for (const dir of DIRECTIONS) {
			if (accepted(ctx.get(px + STEP[dir][0], py + STEP[dir][1], pz + STEP[dir][2]).name)) count += 1
			if (count > 1) break
		}
		if (count === 1) put(px, py, pz)
	}
	return placed
}

/** `minecraft:kelp` (1.19) */
export const kelp: FeatureFn = (ctx, _config, x, _y, z) => {
	const random = ctx.random
	let py = ctx.height('OCEAN_FLOOR', x, z)
	if (!isWater(ctx.get(x, py, z))) return false
	const top = () => blk('kelp', { age: String(random.nextInt(4) + 20) })
	const plant = blk('kelp_plant')
	const height = 1 + random.nextInt(10)
	let placed = 0
	for (let l = 0; l <= height; l += 1) {
		if (isWater(ctx.get(x, py, z)) && isWater(ctx.get(x, py + 1, z)) && canSurvive(ctx, plant, x, py, z)) {
			if (l === height) {
				ctx.set(x, py, z, top())
				placed += 1
			} else {
				ctx.set(x, py, z, plant)
			}
		} else if (l > 0) {
			if (canSurvive(ctx, plant, x, py - 1, z) && !named(ctx.get(x, py - 2, z), 'kelp')) {
				ctx.set(x, py - 1, z, top())
				placed += 1
			}
			break
		}
		py += 1
	}
	return placed > 0
}

/** `minecraft:seagrass` (1.19) */
export const seagrass: FeatureFn = (ctx, config, x, _y, z) => {
	const random = ctx.random
	const px = x + random.nextInt(8) - random.nextInt(8)
	const pz = z + random.nextInt(8) - random.nextInt(8)
	const py = ctx.height('OCEAN_FLOOR', px, pz)
	if (!isWater(ctx.get(px, py, pz))) return false
	const tall = random.nextDouble() < num(config.probability, 0)
	const state = tall ? blk('tall_seagrass', { half: 'lower' }) : blk('seagrass')
	if (!canSurvive(ctx, state, px, py, pz)) return false
	if (tall) {
		if (isWater(ctx.get(px, py + 1, pz))) {
			ctx.set(px, py, pz, state)
			ctx.set(px, py + 1, pz, blk('tall_seagrass', { half: 'upper' }))
		}
	} else {
		ctx.set(px, py, pz, state)
	}
	return true
}

/** `minecraft:sea_pickle` (1.19) */
export const seaPickle: FeatureFn = (ctx, config, x, _y, z) => {
	const random = ctx.random
	const count = clamp(sampleInt(ctx, config.count, 0), 0, 256)
	let placed = 0
	for (let i = 0; i < count; i += 1) {
		const px = x + random.nextInt(8) - random.nextInt(8)
		const pz = z + random.nextInt(8) - random.nextInt(8)
		const py = ctx.height('OCEAN_FLOOR', px, pz)
		const state = blk('sea_pickle', { pickles: String(random.nextInt(4) + 1), waterlogged: 'true' })
		if (isWater(ctx.get(px, py, pz)) && canSurvive(ctx, state, px, py, pz)) {
			ctx.set(px, py, pz, state)
			placed += 1
		}
	}
	return placed > 0
}

/** `minecraft:multiface_growth`: glow lichen and sculk veins on the faces of blocks */
export const multifaceGrowth: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const name = blk(typeof config.block === 'string' ? config.block : 'glow_lichen').name
	const canBeOn = holderSet(ctx, config.can_be_placed_on)
	const open = (block: FBlock) => isAir(block) || isWater(block)
	if (!open(ctx.get(x, y, z))) return false
	const faces: Dir[] = []
	if (config.can_place_on_wall !== false) faces.push(...HORIZONTAL)
	if (config.can_place_on_ceiling !== false) faces.push('up')
	if (config.can_place_on_floor === true) faces.push('down')
	const stateWith = (current: FBlock, face: Dir): FBlock => {
		if (current.name === name) return withProps(current, { [face]: 'true' })
		return { name, properties: { down: 'false', east: 'false', north: 'false', south: 'false', up: 'false', west: 'false', waterlogged: String(isWater(current)), [face]: 'true' } }
	}
	const spread = (px: number, py: number, pz: number, face: Dir) => {
		const sideways = DIRECTIONS.filter(dir => dir !== face && dir !== OPPOSITE[face])
		const dir = sideways[random.nextInt(sideways.length)]
		const nx = px + STEP[dir][0]
		const ny = py + STEP[dir][1]
		const nz = pz + STEP[dir][2]
		const next = ctx.get(nx, ny, nz)
		if ((open(next) || next.name === name) && isSturdy(ctx.get(nx + STEP[face][0], ny + STEP[face][1], nz + STEP[face][2]), OPPOSITE[face], ctx)) {
			ctx.set(nx, ny, nz, stateWith(next, face))
		} else if (isSturdy(next, OPPOSITE[dir], ctx)) {
			ctx.set(px, py, pz, stateWith(ctx.get(px, py, pz), dir))
		}
	}
	const grow = (px: number, py: number, pz: number, tryFaces: Dir[]): boolean => {
		for (const face of tryFaces) {
			if (!canBeOn(ctx.get(px + STEP[face][0], py + STEP[face][1], pz + STEP[face][2]).name)) continue
			if (!ctx.set(px, py, pz, stateWith(ctx.get(px, py, pz), face))) return false
			if (random.nextFloat() < num(config.chance_of_spreading, 0.5)) spread(px, py, pz, face)
			return true
		}
		return false
	}
	const order = shuffled(random, faces)
	if (grow(x, y, z, order)) return true
	for (const dir of order) {
		// The game means to search further away, but only ever looks at the block next to the origin
		const px = x + STEP[dir][0]
		const py = y + STEP[dir][1]
		const pz = z + STEP[dir][2]
		const block = ctx.get(px, py, pz)
		if (!open(block) && block.name !== name) continue
		if (grow(px, py, pz, shuffled(random, faces.filter(face => face !== OPPOSITE[dir])))) return true
	}
	return false
}

function vegetationPatch(ctx: Ctx, config: Json, x: number, y: number, z: number, waterlogged: boolean): boolean {
	const random = ctx.random
	const replaceable = holderSet(ctx, config.replaceable)
	const ceiling = config.surface === 'ceiling'
	const toSurface = ceiling ? 1 : -1
	const range = clamp(int(config.vertical_range, 1), 0, 64)
	const edgeChance = num(config.extra_edge_column_chance, 0)
	const bottomChance = num(config.extra_bottom_block_chance, 0)
	const rx = clamp(sampleInt(ctx, config.xz_radius, 1), 0, 32) + 1
	const rz = clamp(sampleInt(ctx, config.xz_radius, 1), 0, 32) + 1
	let surface: Pos[] = []
	for (let i = -rx; i <= rx; i += 1) {
		const edgeX = i === -rx || i === rx
		for (let j = -rz; j <= rz; j += 1) {
			const edgeZ = j === -rz || j === rz
			const corner = edgeX && edgeZ
			const edge = (edgeX || edgeZ) && !corner
			if (corner || edge && (edgeChance === 0 || random.nextFloat() > edgeChance)) continue
			let py = y
			for (let k = 0; isAir(ctx.get(x + i, py, z + j)) && k < range; k += 1) py += toSurface
			for (let k = 0; !isAir(ctx.get(x + i, py, z + j)) && k < range; k += 1) py -= toSurface
			const groundY = py + toSurface
			const ground = ctx.get(x + i, groundY, z + j)
			if (!isAir(ctx.get(x + i, py, z + j)) || !isSturdy(ground, ceiling ? 'down' : 'up', ctx)) continue
			const depth = clamp(sampleInt(ctx, config.depth, 1), 0, 64) + (bottomChance > 0 && random.nextFloat() < bottomChance ? 1 : 0)
			let gy = groundY
			let ok = true
			for (let d = 0; d < depth; d += 1) {
				const state = provide(ctx, config.ground_state, x + i, gy, z + j)
				const current = ctx.get(x + i, gy, z + j)
				if (state === undefined || state.name === current.name) continue
				if (!replaceable(current.name)) {
					ok = d !== 0
					break
				}
				ctx.set(x + i, gy, z + j, state)
				gy += toSurface
			}
			if (ok) surface.push([x + i, groundY, z + j])
		}
	}
	if (waterlogged) {
		const pool: Pos[] = []
		for (const [px, py, pz] of surface) {
			const exposed = (['north', 'east', 'south', 'west', 'down'] as Dir[]).some(dir => {
				return !isSturdy(ctx.get(px + STEP[dir][0], py + STEP[dir][1], pz + STEP[dir][2]), OPPOSITE[dir], ctx)
			})
			if (!exposed) pool.push([px, py, pz])
		}
		for (const [px, py, pz] of pool) ctx.set(px, py, pz, WATER)
		surface = pool
	}
	const chance = num(config.vegetation_chance, 0)
	for (const [px, py, pz] of surface) {
		if (!(chance > 0 && random.nextFloat() < chance)) continue
		if (waterlogged) {
			if (ctx.nested(config.vegetation_feature, px, py, pz)) {
				const state = ctx.get(px, py, pz)
				if (state.properties.waterlogged === 'false') ctx.set(px, py, pz, withProps(state, { waterlogged: 'true' }))
			}
		} else {
			ctx.nested(config.vegetation_feature, px, py - toSurface, pz)
		}
	}
	return surface.length > 0
}

export const vegetationPatchFeature: FeatureFn = (ctx, config, x, y, z) => vegetationPatch(ctx, config, x, y, z, false)
export const waterloggedVegetationPatch: FeatureFn = (ctx, config, x, y, z) => vegetationPatch(ctx, config, x, y, z, true)

/** `minecraft:root_system`: a tree on the surface above a cave, with roots down to the cave */
export const rootSystem: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	if (!isAir(ctx.get(x, y, z))) return false
	const space = clamp(int(config.required_vertical_space_for_tree, 1), 0, 64)
	const water = int(config.allowed_vertical_water_for_tree, 0)
	const maxHeight = clamp(int(config.root_column_max_height, 1), 0, 512)
	const replaceable = holderSet(ctx, config.root_replaceable)
	const hasSpace = (py: number) => {
		for (let i = 1; i <= space; i += 1) {
			const block = ctx.get(x, py + i, z)
			if (isAir(block)) continue
			if (!(i + 1 <= water && fluidOf(block) === 'minecraft:water')) return false
		}
		return true
	}
	let treeAt: number | undefined
	for (let i = 0; i < maxHeight; i += 1) {
		const py = y + i + 1
		if (ctx.outside(py)) break
		if (!testPredicate(ctx, config.allowed_tree_position, x, py, z) || !hasSpace(py)) continue
		const below = ctx.get(x, py - 1, z)
		if (fluidOf(below) === 'minecraft:lava' || !isSolidIn(below, ctx)) break
		if (ctx.nested(config.feature, x, py, z)) {
			treeAt = y + i
			break
		}
	}
	if (treeAt === undefined) return true
	const radius = clamp(int(config.root_radius, 1), 1, 32)
	const attempts = clamp(int(config.root_placement_attempts, 0), 0, 256)
	for (let py = y; py < treeAt; py += 1) {
		for (let j = 0; j < attempts; j += 1) {
			const px = x + random.nextInt(radius) - random.nextInt(radius)
			const pz = z + random.nextInt(radius) - random.nextInt(radius)
			if (!replaceable(ctx.get(px, py, pz).name)) continue
			const state = provide(ctx, config.root_state_provider, px, py, pz)
			if (state !== undefined) ctx.set(px, py, pz, state)
		}
	}
	const hangRadius = clamp(int(config.hanging_root_radius, 1), 1, 32)
	const span = clamp(int(config.hanging_roots_vertical_span, 1), 1, 32)
	const hangAttempts = clamp(int(config.hanging_root_placement_attempts, 0), 0, 256)
	for (let k = 0; k < hangAttempts; k += 1) {
		const px = x + random.nextInt(hangRadius) - random.nextInt(hangRadius)
		const py = y + random.nextInt(span) - random.nextInt(span)
		const pz = z + random.nextInt(hangRadius) - random.nextInt(hangRadius)
		if (!isAir(ctx.get(px, py, pz))) continue
		const state = provide(ctx, config.hanging_root_state_provider, px, py, pz)
		if (state !== undefined && canSurvive(ctx, state, px, py, pz) && isSturdy(ctx.get(px, py + 1, pz), 'down', ctx)) ctx.set(px, py, pz, state)
	}
	return true
}

/** `minecraft:chorus_plant` */
export const chorusPlant: FeatureFn = (ctx, _config, x, y, z) => {
	const random = ctx.random
	if (!isAir(ctx.get(x, y, z)) || !named(ctx.get(x, y - 1, z), 'end_stone')) return false
	const stems = new Map<string, Pos>()
	const stem = (px: number, py: number, pz: number) => {
		if (ctx.set(px, py, pz, blk('chorus_plant'))) stems.set(key(px, py, pz), [px, py, pz])
	}
	const air = (px: number, py: number, pz: number) => isAir(ctx.get(px, py, pz))
	const sidesEmpty = (px: number, py: number, pz: number, except?: Dir) => {
		return HORIZONTAL.every(dir => dir === except || air(px + STEP[dir][0], py, pz + STEP[dir][2]))
	}
	const grow = (px: number, py: number, pz: number, depth: number) => {
		let height = random.nextInt(4) + 1
		if (depth === 0) height += 1
		for (let j = 0; j < height; j += 1) {
			if (!sidesEmpty(px, py + j + 1, pz)) return
			stem(px, py + j + 1, pz)
			stem(px, py + j, pz)
		}
		let grew = false
		if (depth < 4) {
			let branches = random.nextInt(4)
			if (depth === 0) branches += 1
			for (let k = 0; k < branches; k += 1) {
				const dir = HORIZONTAL[random.nextInt(4)]
				const bx = px + STEP[dir][0]
				const by = py + height
				const bz = pz + STEP[dir][2]
				if (Math.abs(bx - x) >= 8 || Math.abs(bz - z) >= 8 || !air(bx, by, bz) || !air(bx, by - 1, bz) || !sidesEmpty(bx, by, bz, OPPOSITE[dir])) continue
				grew = true
				stem(bx, by, bz)
				stem(px, by, pz)
				grow(bx, by, bz, depth + 1)
			}
		}
		if (!grew) {
			stems.delete(key(px, py + height, pz))
			ctx.set(px, py + height, pz, blk('chorus_flower', { age: '5' }))
		}
	}
	stem(x, y, z)
	grow(x, y, z, 0)
	// The stems connect to what is next to them
	for (const [px, py, pz] of stems.values()) {
		const properties: Record<string, string> = {}
		for (const dir of DIRECTIONS) {
			const next = ctx.get(px + STEP[dir][0], py + STEP[dir][1], pz + STEP[dir][2])
			properties[dir] = String(named(next, 'chorus_plant', 'chorus_flower') || dir === 'down' && named(next, 'end_stone'))
		}
		ctx.set(px, py, pz, blk('chorus_plant', properties))
	}
	return true
}

/** Places one block of a coral structure with what grows on it. 26.3 has a feature for that, 1.19 does it itself. */
function coralBlock(ctx: Ctx, config: Json, state: FBlock | undefined, x: number, y: number, z: number): boolean {
	if (config.feature !== undefined) return ctx.nested(config.feature, x, y, z)
	if (state === undefined) return false
	const random = ctx.random
	const current = ctx.get(x, y, z)
	if (!isWater(current) && !inTag(ctx, current, 'minecraft:corals') || !isWater(ctx.get(x, y + 1, z))) return false
	ctx.set(x, y, z, state)
	if (random.nextFloat() < 0.25) {
		const coral = pick(random, holderList(ctx, '#minecraft:corals'))
		if (coral !== undefined) ctx.set(x, y + 1, z, blk(coral, { waterlogged: 'true' }))
	} else if (random.nextFloat() < 0.05) {
		ctx.set(x, y + 1, z, blk('sea_pickle', { pickles: String(random.nextInt(4) + 1), waterlogged: 'true' }))
	}
	for (const dir of HORIZONTAL) {
		if (random.nextFloat() >= 0.2) continue
		const px = x + STEP[dir][0]
		const pz = z + STEP[dir][2]
		if (!isWater(ctx.get(px, y, pz))) continue
		const fan = pick(random, holderList(ctx, '#minecraft:wall_corals'))
		if (fan !== undefined) ctx.set(px, y, pz, blk(fan, { facing: dir, waterlogged: 'true' }))
	}
	return true
}

function coralState(ctx: Ctx, config: Json): FBlock | undefined {
	if (config.feature !== undefined) return undefined
	const name = pick(ctx.random, holderList(ctx, '#minecraft:coral_blocks'))
	return name === undefined ? undefined : blk(name)
}

/** `minecraft:coral_tree` */
export const coralTree: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const state = coralState(ctx, config)
	if (state === undefined && config.feature === undefined) return false
	let py = y
	const trunk = random.nextInt(3) + 1
	for (let j = 0; j < trunk; j += 1) {
		if (!coralBlock(ctx, config, state, x, py, z)) return true
		py += 1
	}
	const branches = random.nextInt(3) + 2
	for (const dir of shuffled(random, HORIZONTAL).slice(0, branches)) {
		let bx = x + STEP[dir][0]
		let by = py
		let bz = z + STEP[dir][2]
		const length = random.nextInt(5) + 2
		let straight = 0
		for (let n = 0; n < length && coralBlock(ctx, config, state, bx, by, bz); n += 1) {
			straight += 1
			by += 1
			if (n === 0 || straight >= 2 && random.nextFloat() < 0.25) {
				bx += STEP[dir][0]
				bz += STEP[dir][2]
				straight = 0
			}
		}
	}
	return true
}

/** `minecraft:coral_claw` */
export const coralClaw: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const state = coralState(ctx, config)
	if (state === undefined && config.feature === undefined) return false
	if (!coralBlock(ctx, config, state, x, y, z)) return false
	const dir = HORIZONTAL[random.nextInt(4)]
	const count = random.nextInt(2) + 2
	const sides = shuffled(random, [dir, CLOCKWISE[dir], OPPOSITE[CLOCKWISE[dir]]])
	for (const side of sides.slice(0, count)) {
		let px = x + STEP[side][0]
		let py = y
		let pz = z + STEP[side][2]
		const first = random.nextInt(2) + 1
		let along: Readonly<Pos>
		let reach: number
		if (side === dir) {
			along = STEP[dir]
			reach = random.nextInt(3) + 2
		} else {
			py += 1
			along = random.nextBoolean() ? STEP[side] : STEP.up
			reach = random.nextInt(3) + 3
		}
		for (let l = 0; l < first && coralBlock(ctx, config, state, px, py, pz); l += 1) {
			px += along[0]
			py += along[1]
			pz += along[2]
		}
		px -= along[0]
		py -= along[1] - 1
		pz -= along[2]
		for (let l = 0; l < reach; l += 1) {
			px += STEP[dir][0]
			pz += STEP[dir][2]
			if (!coralBlock(ctx, config, state, px, py, pz)) break
			if (random.nextFloat() < 0.25) py += 1
		}
	}
	return true
}

/** `minecraft:coral_mushroom` (1.19): the hollow shell of a box */
export const coralMushroom: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const state = coralState(ctx, config)
	if (state === undefined && config.feature === undefined) return false
	const sy = random.nextInt(3) + 3
	const sx = random.nextInt(3) + 3
	const sz = random.nextInt(3) + 3
	const down = random.nextInt(3) + 1
	for (let dx = 0; dx <= sx; dx += 1) {
		for (let dy = 0; dy <= sy; dy += 1) {
			for (let dz = 0; dz <= sz; dz += 1) {
				const borders = (dx === 0 || dx === sx ? 1 : 0) + (dy === 0 || dy === sy ? 1 : 0) + (dz === 0 || dz === sz ? 1 : 0)
				if (borders !== 1 || random.nextFloat() < 0.1) continue
				coralBlock(ctx, config, state, x + dx, y + dy - down, z + dz)
			}
		}
	}
	return true
}
