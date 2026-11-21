import { AIR, blk, canSurvive, isAir, isBaseStone, isDirt, isFluid, isLava, isLeaves, isLog, isSolidIn, isSturdy, isWater, named, parseBlock, WATER, withProps } from './blocks.js'
import { testPredicate } from './predicates.js'
import { holderSet, sampleInt } from './providers.js'
import { between, shuffled } from './random.js'
import { provide } from './states.js'
import type { Ctx, FBlock, FeatureFn } from './types.js'
import type { Dir } from './util.js'
import { clamp, dirOf, DIRECTIONS, HORIZONTAL, int, isObj, list, num, STEP, withinManhattan } from './util.js'

/** `minecraft:lake` */
export const lake: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	if (y <= ctx.minY + 4) return false
	const oy = y - 4
	const cells = new Uint8Array(2048)
	const at = (i: number, j: number, k: number) => cells[(i * 16 + j) * 8 + k] === 1
	const blobs = random.nextInt(4) + 4
	for (let n = 0; n < blobs; n += 1) {
		const d = random.nextDouble() * 6 + 3
		const e = random.nextDouble() * 4 + 2
		const f = random.nextDouble() * 6 + 3
		const g = random.nextDouble() * (16 - d - 2) + 1 + d / 2
		const h = random.nextDouble() * (8 - e - 4) + 2 + e / 2
		const k = random.nextDouble() * (16 - f - 2) + 1 + f / 2
		for (let i = 1; i < 15; i += 1) {
			for (let j = 1; j < 15; j += 1) {
				for (let l = 1; l < 7; l += 1) {
					const o = (i - g) / (d / 2)
					const p = (l - h) / (e / 2)
					const q = (j - k) / (f / 2)
					if (o * o + p * p + q * q < 1) cells[(i * 16 + j) * 8 + l] = 1
				}
			}
		}
	}
	const isEdge = (i: number, j: number, k: number) => !at(i, j, k) && (
		i < 15 && at(i + 1, j, k) || i > 0 && at(i - 1, j, k) || j < 15 && at(i, j + 1, k) || j > 0 && at(i, j - 1, k) || k < 7 && at(i, j, k + 1) || k > 0 && at(i, j, k - 1)
	)
	const fluid = provide(ctx, config.fluid, x, oy, z)
	if (fluid === undefined) return false
	const modern = config.can_replace_with_air_or_fluid !== undefined || config.can_replace_with_barrier !== undefined
	for (let i = 0; i < 16; i += 1) {
		for (let j = 0; j < 16; j += 1) {
			for (let k = 0; k < 8; k += 1) {
				if (at(i, j, k)) {
					// 26.3 can say where a lake may not be; which blocks it asks is a guess
					if (config.can_place_feature !== undefined && !testPredicate(ctx, config.can_place_feature, x + i, oy + k, z + j)) return false
					continue
				}
				if (!isEdge(i, j, k)) continue
				const block = ctx.get(x + i, oy + k, z + j)
				if (k >= 4 && isFluid(block)) return false
				if (k < 4 && !isSolidIn(block, ctx) && block.name !== fluid.name) return false
			}
		}
	}
	const cannotReplace = ctx.tag('minecraft:features_cannot_replace')
	for (let i = 0; i < 16; i += 1) {
		for (let j = 0; j < 16; j += 1) {
			for (let k = 0; k < 8; k += 1) {
				if (!at(i, j, k)) continue
				const px = x + i
				const py = oy + k
				const pz = z + j
				const allowed = modern ? testPredicate(ctx, config.can_replace_with_air_or_fluid, px, py, pz) : !cannotReplace.has(ctx.get(px, py, pz).name)
				if (allowed) ctx.set(px, py, pz, k >= 4 ? AIR : fluid)
			}
		}
	}
	const barrier = provide(ctx, config.barrier, x, oy, z)
	if (barrier !== undefined && !isAir(barrier)) {
		const stoneCannotReplace = ctx.tag('minecraft:lava_pool_stone_cannot_replace')
		for (let i = 0; i < 16; i += 1) {
			for (let j = 0; j < 16; j += 1) {
				for (let k = 0; k < 8; k += 1) {
					if (!isEdge(i, j, k) || !(k < 4 || random.nextInt(2) !== 0)) continue
					const px = x + i
					const py = oy + k
					const pz = z + j
					const block = ctx.get(px, py, pz)
					if (!isSolidIn(block, ctx)) continue
					const allowed = modern
						? testPredicate(ctx, config.can_replace_with_barrier, px, py, pz)
						: !stoneCannotReplace.has(block.name) && !cannotReplace.has(block.name) && !isLeaves(block, ctx) && !isLog(block, ctx)
					if (allowed) ctx.set(px, py, pz, barrier)
				}
			}
		}
	}
	return true
}

/** `minecraft:forest_rock` (1.19) and `minecraft:block_blob` (26.3): a few balls of a block on the ground */
export const blockBlob: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const state = parseBlock(config.state)
	if (state === undefined) return false
	let px = x
	let py = y
	let pz = z
	for (; py > ctx.minY + 3; py -= 1) {
		const below = ctx.get(px, py - 1, pz)
		if (isAir(below)) continue
		if (config.can_place_on !== undefined ? testPredicate(ctx, config.can_place_on, px, py - 1, pz) : isDirt(below, ctx) || isBaseStone(below, ctx)) break
	}
	if (py <= ctx.minY + 3) return false
	for (let i = 0; i < 3; i += 1) {
		const j = random.nextInt(2)
		const k = random.nextInt(2)
		const l = random.nextInt(2)
		const f = (j + k + l) * 0.333 + 0.5
		for (let dx = -j; dx <= j; dx += 1) {
			for (let dy = -k; dy <= k; dy += 1) {
				for (let dz = -l; dz <= l; dz += 1) {
					if (dx * dx + dy * dy + dz * dz <= f * f) ctx.set(px + dx, py + dy, pz + dz, state)
				}
			}
		}
		px += -1 + random.nextInt(2)
		py += -random.nextInt(2)
		pz += -1 + random.nextInt(2)
	}
	return true
}

/** `minecraft:ice_spike` (1.19) and `minecraft:spike` (26.3) */
export const spike: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const state = parseBlock(config.state) ?? blk('packed_ice')
	let py = y
	while (isAir(ctx.get(x, py, z)) && py > ctx.minY + 2) py -= 1
	if (config.can_place_on !== undefined ? !testPredicate(ctx, config.can_place_on, x, py, z) : !named(ctx.get(x, py, z), 'snow_block')) return false
	const replaceable = (px: number, qy: number, pz: number, orSelf: boolean) => {
		const block = ctx.get(px, qy, pz)
		if (isAir(block) || orSelf && block.name === state.name) return true
		if (config.can_replace !== undefined) return testPredicate(ctx, config.can_replace, px, qy, pz)
		return isDirt(block, ctx) || named(block, 'snow_block', 'ice')
	}
	py += random.nextInt(4)
	const height = random.nextInt(4) + 7
	const width = Math.floor(height / 4) + random.nextInt(2)
	if (width > 1 && random.nextInt(60) === 0) py += 10 + random.nextInt(30)
	for (let k = 0; k < height; k += 1) {
		const f = (1 - k / height) * width
		const l = Math.ceil(f)
		for (let m = -l; m <= l; m += 1) {
			const g = Math.abs(m) - 0.25
			for (let n = -l; n <= l; n += 1) {
				const h = Math.abs(n) - 0.25
				if ((m !== 0 || n !== 0) && g * g + h * h > f * f || (m === -l || m === l || n === -l || n === l) && random.nextFloat() > 0.75) continue
				if (replaceable(x + m, py + k, z + n, false)) ctx.set(x + m, py + k, z + n, state)
				if (k === 0 || l <= 1) continue
				if (replaceable(x + m, py - k, z + n, false)) ctx.set(x + m, py - k, z + n, state)
			}
		}
	}
	const base = clamp(width - 1, 0, 1)
	for (let o = -base; o <= base; o += 1) {
		for (let l = -base; l <= base; l += 1) {
			let qy = py - 1
			let run = 50
			if (Math.abs(o) === 1 && Math.abs(l) === 1) run = random.nextInt(5)
			while (qy > 50 && qy > ctx.minY) {
				if (!replaceable(x + o, qy, z + l, true)) break
				ctx.set(x + o, qy, z + l, state)
				qy -= 1
				run -= 1
				if (run <= 0) {
					qy -= random.nextInt(5) + 1
					run = random.nextInt(5)
				}
			}
		}
	}
	return true
}

/** `minecraft:netherrack_replace_blobs` */
export const netherrackReplaceBlobs: FeatureFn = (ctx, config, x, y, z) => {
	const target = parseBlock(config.target)
	const state = parseBlock(config.state)
	if (target === undefined || state === undefined) return false
	let py = clamp(y, ctx.minY + 1, ctx.maxY - 1)
	while (py > ctx.minY + 1 && ctx.get(x, py, z).name !== target.name) py -= 1
	if (py <= ctx.minY + 1) return false
	const rx = clamp(sampleInt(ctx, config.radius, 3), 0, 16)
	const ry = clamp(sampleInt(ctx, config.radius, 3), 0, 16)
	const rz = clamp(sampleInt(ctx, config.radius, 3), 0, 16)
	const reach = Math.max(rx, ry, rz)
	let placed = false
	for (let dx = -rx; dx <= rx; dx += 1) {
		for (let dy = -ry; dy <= ry; dy += 1) {
			for (let dz = -rz; dz <= rz; dz += 1) {
				if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > reach) continue
				if (ctx.get(x + dx, py + dy, z + dz).name === target.name && ctx.set(x + dx, py + dy, z + dz, state)) placed = true
			}
		}
	}
	return placed
}

const NO_COLUMNS_ON = new Set(['lava', 'bedrock', 'magma_block', 'soul_sand', 'nether_bricks', 'nether_brick_fence', 'nether_brick_stairs', 'nether_wart', 'chest', 'spawner'])

interface ColumnOptions {
	height: number
	clusterReach: number
	count: number
	reach: () => number
	block: (x: number, y: number, z: number) => FBlock | undefined
	canReplace: (x: number, y: number, z: number) => boolean
	cannotPlaceOn: (block: FBlock) => boolean
	continueThrough: (x: number, y: number, z: number) => boolean
}

/** Columns that get lower away from the middle, which is how basalt columns are made */
function columnCluster(ctx: Ctx, x: number, y: number, z: number, o: ColumnOptions): boolean {
	const random = ctx.random
	const canPlaceAt = (px: number, py: number, pz: number) => {
		if (!o.canReplace(px, py, pz)) return false
		const below = ctx.get(px, py - 1, pz)
		return !isAir(below) && !o.cannotPlaceOn(below)
	}
	if (!canPlaceAt(x, y, z)) return false
	const k = Math.min(o.height, o.clusterReach)
	let placed = false
	for (let n = 0; n < o.count; n += 1) {
		const cx = between(random, x - k, x + k)
		const cz = between(random, z - k, z + k)
		const height = o.height - Math.abs(cx - x) - Math.abs(cz - z)
		if (height < 0) continue
		const reach = clamp(o.reach(), 0, 16)
		for (let px = cx - reach; px <= cx + reach; px += 1) {
			for (let pz = cz - reach; pz <= cz + reach; pz += 1) {
				const dist = Math.abs(px - cx) + Math.abs(pz - cz)
				let py = y
				let found = false
				if (o.canReplace(px, py, pz)) {
					for (let left = dist; py > ctx.minY + 1 && left > 0; left -= 1) {
						if (canPlaceAt(px, py, pz)) {
							found = true
							break
						}
						py -= 1
					}
				} else {
					for (let left = dist; py < ctx.maxY && left > 0; left -= 1) {
						const block = ctx.get(px, py, pz)
						if (o.cannotPlaceOn(block)) break
						if (isAir(block)) {
							found = true
							break
						}
						py += 1
					}
				}
				if (!found) continue
				for (let j = height - Math.floor(dist / 2); j >= 0; j -= 1) {
					if (o.canReplace(px, py, pz)) {
						const state = o.block(px, py, pz)
						if (state !== undefined && ctx.set(px, py, pz, state)) placed = true
						py += 1
						continue
					}
					if (!o.continueThrough(px, py, pz)) break
					py += 1
				}
			}
		}
	}
	return placed
}

/** `minecraft:basalt_columns` (1.19) */
export const basaltColumns: FeatureFn = (ctx, config, x, y, z) => {
	const few = ctx.random.nextFloat() >= 0.9
	const basalt = blk('basalt', { axis: 'y' })
	return columnCluster(ctx, x, y, z, {
		height: clamp(sampleInt(ctx, config.height, 1), 0, 64),
		clusterReach: few ? 8 : 5,
		count: few ? 15 : 50,
		reach: () => sampleInt(ctx, config.reach, 1),
		block: () => basalt,
		canReplace: (px, py, pz) => {
			const block = ctx.get(px, py, pz)
			return isAir(block) || isLava(block) && py <= ctx.world.seaLevel
		},
		cannotPlaceOn: block => NO_COLUMNS_ON.has(block.name.replace('minecraft:', '')),
		continueThrough: (px, py, pz) => named(ctx.get(px, py, pz), 'basalt'),
	})
}

/** `minecraft:stepped_column_cluster` (26.3) */
export const steppedColumnCluster: FeatureFn = (ctx, config, x, y, z) => {
	const cannot = holderSet(ctx, config.cannot_place_on)
	return columnCluster(ctx, x, y, z, {
		height: clamp(sampleInt(ctx, config.height, 1), 0, 64),
		clusterReach: clamp(int(config.cluster_reach, 5), 0, 32),
		count: clamp(int(config.column_count, 0), 0, 1024),
		reach: () => sampleInt(ctx, config.column_reach, 1),
		block: (px, py, pz) => provide(ctx, config.block, px, py, pz),
		canReplace: (px, py, pz) => testPredicate(ctx, config.can_replace, px, py, pz),
		cannotPlaceOn: block => cannot(block.name),
		continueThrough: (px, py, pz) => config.continue_through !== undefined && testPredicate(ctx, config.continue_through, px, py, pz),
	})
}

/** `minecraft:basalt_pillar` (1.19): a pillar from a ceiling down to the floor */
export const basaltPillar: FeatureFn = (ctx, _config, x, y, z) => {
	const random = ctx.random
	const basalt = blk('basalt', { axis: 'y' })
	const air = (px: number, py: number, pz: number) => isAir(ctx.get(px, py, pz))
	if (!air(x, y, z) || air(x, y + 1, z)) return false
	const sides: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]]
	const hanging = [true, true, true, true]
	let py = y
	while (air(x, py, z)) {
		if (ctx.outside(py)) return true
		ctx.set(x, py, z, basalt)
		for (let i = 0; i < 4; i += 1) {
			if (!hanging[i]) continue
			const px = x + sides[i][0]
			const pz = z + sides[i][1]
			hanging[i] = air(px, py, pz) && random.nextInt(10) !== 0 && ctx.set(px, py, pz, basalt)
		}
		py -= 1
	}
	py += 1
	for (const [dx, dz] of sides) {
		if (random.nextBoolean()) ctx.set(x + dx, py, z + dz, basalt)
	}
	py -= 1
	for (let i = -3; i <= 3; i += 1) {
		for (let j = -3; j <= 3; j += 1) {
			if (random.nextInt(10) >= 10 - Math.abs(i) * Math.abs(j)) continue
			let qy = py
			let left = 3
			while (air(x + i, qy - 1, z + j)) {
				qy -= 1
				left -= 1
				if (left <= 0) break
			}
			if (!air(x + i, qy - 1, z + j)) ctx.set(x + i, qy, z + j, basalt)
		}
	}
	return true
}

/** `minecraft:single_block_pillar` (26.3): a row of one block for as long as it can replace what is there, with something at its end */
export const singleBlockPillar: FeatureFn = (ctx, config, x, y, z) => {
	const step = STEP[dirOf(config.direction, 'down')]
	const chance = num(config.chance_to_continue, 1)
	let px = x
	let py = y
	let pz = z
	let last: [number, number, number] | undefined
	for (let guard = 0; guard < 512; guard += 1) {
		if (ctx.outside(py) || !testPredicate(ctx, config.can_replace, px, py, pz)) break
		if (chance < 1 && ctx.random.nextFloat() >= chance) break
		const state = provide(ctx, config.block, px, py, pz)
		if (state === undefined || !ctx.set(px, py, pz, state)) break
		last = [px, py, pz]
		px += step[0]
		py += step[1]
		pz += step[2]
	}
	if (last === undefined) return false
	if (config.cap_feature !== undefined) ctx.nested(config.cap_feature, last[0], last[1], last[2])
	return true
}

/** `minecraft:projected_random_patchy_square` (26.3): a square that is full in the middle and thin at its corners, laid on what is below */
export const projectedRandomPatchySquare: FeatureFn = (ctx, config, x, y, z) => {
	const size = clamp(int(config.size, 3), 0, 16)
	const maxDrop = clamp(int(config.max_projection_height, 3), 0, 64)
	let placed = false
	for (let i = -size; i <= size; i += 1) {
		for (let j = -size; j <= size; j += 1) {
			if (ctx.random.nextInt(10) >= 10 - Math.abs(i) * Math.abs(j)) continue
			let py = y
			for (let left = maxDrop; left > 0 && testPredicate(ctx, config.project_through, x + i, py - 1, z + j); left -= 1) py -= 1
			const state = provide(ctx, config.block, x + i, py, z + j)
			if (state !== undefined && ctx.set(x + i, py, z + j, state)) placed = true
		}
	}
	return placed
}

const DELTA_KEEPS = new Set(['bedrock', 'nether_bricks', 'nether_brick_fence', 'nether_brick_stairs', 'nether_wart', 'chest', 'spawner'])

/** `minecraft:delta_feature`: pools in a floor, where the floor has a step */
export const delta: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const contents = parseBlock(config.contents)
	const rim = parseBlock(config.rim)
	if (contents === undefined || rim === undefined) return false
	const clear = (px: number, py: number, pz: number) => {
		const block = ctx.get(px, py, pz)
		if (block.name === contents.name || DELTA_KEEPS.has(block.name.replace('minecraft:', ''))) return false
		for (const dir of DIRECTIONS) {
			const air = isAir(ctx.get(px + STEP[dir][0], py + STEP[dir][1], pz + STEP[dir][2]))
			if (air && dir !== 'up' || !air && dir === 'up') return false
		}
		return true
	}
	const withRim = random.nextDouble() < 0.9
	const rimX = withRim ? sampleInt(ctx, config.rim_size, 0) : 0
	const rimZ = withRim ? sampleInt(ctx, config.rim_size, 0) : 0
	const hasRim = withRim && rimX !== 0 && rimZ !== 0
	const sizeX = clamp(sampleInt(ctx, config.size, 1), 0, 32)
	const sizeZ = clamp(sampleInt(ctx, config.size, 1), 0, 32)
	const reach = Math.max(sizeX, sizeZ)
	let placed = false
	for (const [dx, , dz] of withinManhattan(sizeX, 0, sizeZ)) {
		if (Math.abs(dx) + Math.abs(dz) > reach) break
		if (!clear(x + dx, y, z + dz)) continue
		if (hasRim && ctx.set(x + dx, y, z + dz, rim)) placed = true
		if (!clear(x + dx + rimX, y, z + dz + rimZ)) continue
		if (ctx.set(x + dx + rimX, y, z + dz + rimZ, contents)) placed = true
	}
	return placed
}

/**
 * `minecraft:freeze_top_layer`: ice on water and snow on the ground of a chunk, where the biome is cold enough.
 * It gets colder higher up, so a mild biome still has snow on its mountains. Without a biome everywhere is cold.
 */
export const freezeTopLayer: FeatureFn = (ctx, _config, x, _y, z) => {
	const cx = x & ~15
	const cz = z & ~15
	const snow = blk('snow', { layers: '1' })
	const temperature = ctx.data.temperature ?? 0
	const warmUpTo = ctx.world.seaLevel + 17
	let placed = false
	for (let i = 0; i < 16; i += 1) {
		for (let j = 0; j < 16; j += 1) {
			const px = cx + i
			const pz = cz + j
			const py = ctx.height('MOTION_BLOCKING', px, pz)
			// The game also varies this a little from place to place
			if ((py > warmUpTo ? temperature - (py - warmUpTo) * 0.05 / 40 : temperature) >= 0.15) continue
			const below = ctx.get(px, py - 1, pz)
			if (isWater(below) && (below.properties.level ?? '0') === '0') {
				if (ctx.set(px, py - 1, pz, blk('ice'))) placed = true
			}
			const current = ctx.get(px, py, pz)
			if (!isAir(current) || ctx.outside(py) || !canSurvive(ctx, snow, px, py, pz)) continue
			if (ctx.set(px, py, pz, snow)) placed = true
			const ground = ctx.get(px, py - 1, pz)
			if (ground.properties.snowy !== undefined) ctx.set(px, py - 1, pz, withProps(ground, { snowy: 'true' }))
		}
	}
	return placed
}

/** `minecraft:blue_ice` */
export const blueIce: FeatureFn = (ctx, _config, x, y, z) => {
	const random = ctx.random
	if (y > ctx.world.seaLevel - 1) return false
	if (!isWater(ctx.get(x, y, z)) && !isWater(ctx.get(x, y - 1, z))) return false
	const touches = (px: number, py: number, pz: number, name: string) => DIRECTIONS.some(dir => {
		return dir !== 'down' && named(ctx.get(px + STEP[dir][0], py + STEP[dir][1], pz + STEP[dir][2]), name)
	})
	if (!touches(x, y, z, 'packed_ice')) return false
	const ice = blk('blue_ice')
	ctx.set(x, y, z, ice)
	for (let i = 0; i < 200; i += 1) {
		const dy = random.nextInt(5) - random.nextInt(6)
		let reach = 3
		if (dy < 2) reach += Math.trunc(dy / 2)
		if (reach < 1) continue
		const px = x + random.nextInt(reach) - random.nextInt(reach)
		const py = y + dy
		const pz = z + random.nextInt(reach) - random.nextInt(reach)
		const block = ctx.get(px, py, pz)
		if (!isAir(block) && !isWater(block) && !named(block, 'packed_ice', 'ice')) continue
		if (DIRECTIONS.some(dir => named(ctx.get(px + STEP[dir][0], py + STEP[dir][1], pz + STEP[dir][2]), 'blue_ice'))) ctx.set(px, py, pz, ice)
	}
	return true
}

/** `minecraft:iceberg` */
export const iceberg: FeatureFn = (ctx, config, x, _y, z) => {
	const random = ctx.random
	const state = parseBlock(config.state) ?? blk('packed_ice')
	const y = ctx.world.seaLevel
	const snowBlock = blk('snow_block')
	const snowy = random.nextDouble() > 0.7
	const angle = random.nextDouble() * 2 * Math.PI
	const ellipseA = 11 - random.nextInt(5)
	const ellipseB = 3 + random.nextInt(3)
	const ellipse = random.nextDouble() > 0.7
	let above = ellipse ? random.nextInt(6) + 6 : random.nextInt(15) + 3
	if (!ellipse && random.nextDouble() > 0.9) above += random.nextInt(19) + 7
	const below = Math.min(above + random.nextInt(11), 18)
	const width = Math.min(above + random.nextInt(7) - random.nextInt(5), 11)
	const reach = ellipse ? ellipseA : 11

	const icy = (block: FBlock) => named(block, 'packed_ice', 'snow_block', 'blue_ice')
	const radiusRound = (i: number, j: number, k: number) => {
		const f = 3.5 - random.nextFloat()
		let g = (1 - i * i / (j * f)) * k
		if (j > 15 + random.nextInt(5)) {
			const l = i < 3 + random.nextInt(6) ? Math.trunc(i / 2) : i
			g = (1 - l / (j * f * 0.4)) * k
		}
		return Math.ceil(g / 2)
	}
	const radiusEllipse = (i: number, j: number, k: number) => Math.ceil((1 - i * i / j) * k / 2)
	const radiusSteep = (i: number, j: number, k: number) => {
		const f = 1 + random.nextFloat() / 2
		return Math.ceil((1 - i / (j * f)) * k / 2)
	}
	const distEllipse = (i: number, j: number, cx: number, cz: number, a: number, b: number, d: number) => {
		const u = ((i - cx) * Math.cos(d) - (j - cz) * Math.sin(d)) / (a || 1)
		const v = ((i - cx) * Math.sin(d) + (j - cz) * Math.cos(d)) / (b || 1)
		return u * u + v * v - 1
	}
	const distCircle = (i: number, j: number, r: number) => {
		const f = 10 * clamp(random.nextFloat(), 0.2, 0.8) / (r || 1)
		return f + i * i + j * j - r * r
	}
	const block = (dx: number, dy: number, dz: number, total: number, radius: number, a: number) => {
		let e: number
		if (ellipse) {
			let b = ellipseB
			if (dy > 0 && total - dy <= 3) b = ellipseB - (4 - (total - dy))
			e = distEllipse(dx, dz, 0, 0, a, b, angle)
		} else {
			e = distCircle(dx, dz, radius)
		}
		if (e >= 0) return
		const f = ellipse ? -0.5 : -6 - random.nextInt(3)
		if (e > f && random.nextDouble() > 0.9) return
		const current = ctx.get(x + dx, y + dy, z + dz)
		if (!isAir(current) && !named(current, 'snow_block', 'ice', 'water')) return
		const keep = !ellipse || random.nextDouble() > 0.05
		const depth = total - dy
		if (snowy && !isWater(current) && depth <= random.nextInt(Math.max(1, Math.trunc(total / (ellipse ? 3 : 2)))) + total * 0.6 && keep) {
			ctx.set(x + dx, y + dy, z + dz, snowBlock)
		} else {
			ctx.set(x + dx, y + dy, z + dz, state)
		}
	}

	for (let p = -reach; p < reach; p += 1) {
		for (let q = -reach; q < reach; q += 1) {
			for (let r = 0; r < above; r += 1) {
				const s = ellipse ? radiusEllipse(r, above, width) : radiusRound(r, above, width)
				if (!ellipse && p >= s) continue
				block(p, r, q, above, s, reach)
			}
		}
	}
	// Smooth
	const smoothReach = ellipse ? ellipseA : Math.trunc(width / 2)
	for (let m = -smoothReach; m <= smoothReach; m += 1) {
		for (let n = -smoothReach; n <= smoothReach; n += 1) {
			for (let o = 0; o <= above; o += 1) {
				const px = x + m
				const py = y + o
				const pz = z + n
				const current = ctx.get(px, py, pz)
				if (!icy(current) && !named(current, 'snow')) continue
				if (isAir(ctx.get(px, py - 1, pz))) {
					ctx.set(px, py, pz, AIR)
					ctx.set(px, py + 1, pz, AIR)
					continue
				}
				if (!icy(current)) continue
				let open = 0
				for (const dir of HORIZONTAL) {
					if (!icy(ctx.get(px + STEP[dir][0], py, pz + STEP[dir][2]))) open += 1
				}
				if (open >= 3) ctx.set(px, py, pz, AIR)
			}
		}
	}
	for (let p = -reach; p < reach; p += 1) {
		for (let q = -reach; q < reach; q += 1) {
			for (let r = -1; r > -below; r -= 1) {
				const s = ellipse ? Math.ceil(reach * (1 - r * r / (below * 8))) : reach
				const t = radiusSteep(-r, below, width)
				if (p >= t) continue
				block(p, r, q, below, t, s)
			}
		}
	}
	const cut = ellipse ? random.nextDouble() > 0.1 : random.nextDouble() > 0.7
	if (cut) {
		const signX = random.nextBoolean() ? -1 : 1
		const signZ = random.nextBoolean() ? -1 : 1
		const half = Math.trunc(width / 2)
		let offX = random.nextInt(Math.max(half - 2, 1))
		if (random.nextBoolean()) offX = half + 1 - random.nextInt(Math.max(width - half - 1, 1))
		let offZ = random.nextInt(Math.max(half - 2, 1))
		if (random.nextBoolean()) offZ = half + 1 - random.nextInt(Math.max(width - half - 1, 1))
		if (ellipse) {
			offX = random.nextInt(Math.max(ellipseA - 5, 1))
			offZ = offX
		}
		const cx = signX * offX
		const cz = signZ * offZ
		const cutAngle = ellipse ? angle + Math.PI / 2 : random.nextDouble() * 2 * Math.PI
		const carve = (radius: number, dy: number, underwater: boolean) => {
			const a = radius + 1 + Math.trunc(ellipseA / 3)
			const b = Math.min(radius - 3, 3) + Math.trunc(ellipseB / 2) - 1
			for (let o = -a; o < a; o += 1) {
				for (let p = -a; p < a; p += 1) {
					if (distEllipse(o, p, cx, cz, a, b, cutAngle) >= 0) continue
					const current = ctx.get(x + o, y + dy, z + p)
					if (!icy(current)) continue
					if (underwater) {
						ctx.set(x + o, y + dy, z + p, WATER)
					} else {
						ctx.set(x + o, y + dy, z + p, AIR)
						if (named(ctx.get(x + o, y + dy + 1, z + p), 'snow')) ctx.set(x + o, y + dy + 1, z + p, AIR)
					}
				}
			}
		}
		for (let q = 0; q < above - 3; q += 1) carve(radiusRound(q, above, width), q, false)
		for (let q = -1; q > -above + random.nextInt(5); q -= 1) carve(radiusSteep(-q, above, width), q, true)
	}
	return true
}

/** `minecraft:underwater_magma` */
export const underwaterMagma: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	if (!isWater(ctx.get(x, y, z))) return false
	const range = clamp(int(config.floor_search_range, 5), 1, 64)
	let floor = y
	for (let j = 1; j < range && isWater(ctx.get(x, floor, z)); j += 1) floor -= 1
	if (isWater(ctx.get(x, floor, z))) return false
	const r = clamp(int(config.placement_radius_around_floor, 1), 0, 8)
	const chance = num(config.placement_probability_per_valid_position, 0.5)
	const open = (px: number, py: number, pz: number) => {
		const block = ctx.get(px, py, pz)
		return isWater(block) || isAir(block)
	}
	let placed = false
	for (let dx = -r; dx <= r; dx += 1) {
		for (let dy = -r; dy <= r; dy += 1) {
			for (let dz = -r; dz <= r; dz += 1) {
				if (random.nextFloat() >= chance) continue
				const px = x + dx
				const py = floor + dy
				const pz = z + dz
				if (open(px, py, pz) || open(px, py - 1, pz) || HORIZONTAL.some(dir => open(px + STEP[dir][0], py, pz + STEP[dir][2]))) continue
				if (ctx.set(px, py, pz, blk('magma_block'))) placed = true
			}
		}
	}
	return placed
}

/** `minecraft:desert_well` (1.19) */
export const desertWell: FeatureFn = (ctx, _config, x, y, z) => {
	let py = y + 1
	while (isAir(ctx.get(x, py, z)) && py > ctx.minY + 2) py -= 1
	if (!named(ctx.get(x, py, z), 'sand')) return false
	for (let i = -2; i <= 2; i += 1) {
		for (let j = -2; j <= 2; j += 1) {
			if (isAir(ctx.get(x + i, py - 1, z + j)) && isAir(ctx.get(x + i, py - 2, z + j))) return false
		}
	}
	const sandstone = blk('sandstone')
	const slab = blk('sandstone_slab', { type: 'bottom', waterlogged: 'false' })
	for (let i = -1; i <= 0; i += 1) {
		for (let j = -2; j <= 2; j += 1) {
			for (let k = -2; k <= 2; k += 1) ctx.set(x + j, py + i, z + k, sandstone)
		}
	}
	ctx.set(x, py, z, WATER)
	for (const dir of HORIZONTAL) ctx.set(x + STEP[dir][0], py, z + STEP[dir][2], WATER)
	for (let i = -2; i <= 2; i += 1) {
		for (let j = -2; j <= 2; j += 1) {
			if (i === -2 || i === 2 || j === -2 || j === 2) ctx.set(x + i, py + 1, z + j, sandstone)
		}
	}
	ctx.set(x + 2, py + 1, z, slab)
	ctx.set(x - 2, py + 1, z, slab)
	ctx.set(x, py + 1, z + 2, slab)
	ctx.set(x, py + 1, z - 2, slab)
	for (let i = -1; i <= 1; i += 1) {
		for (let j = -1; j <= 1; j += 1) ctx.set(x + i, py + 4, z + j, i === 0 && j === 0 ? sandstone : slab)
	}
	for (let i = 1; i <= 3; i += 1) {
		ctx.set(x - 1, py + i, z - 1, sandstone)
		ctx.set(x - 1, py + i, z + 1, sandstone)
		ctx.set(x + 1, py + i, z - 1, sandstone)
		ctx.set(x + 1, py + i, z + 1, sandstone)
	}
	return true
}

/** `minecraft:end_island` */
export const endIsland: FeatureFn = (ctx, _config, x, y, z) => {
	const random = ctx.random
	const stone = blk('end_stone')
	let f = random.nextInt(3) + 4
	for (let i = 0; f > 0.5; i -= 1) {
		for (let j = Math.floor(-f); j <= Math.ceil(f); j += 1) {
			for (let k = Math.floor(-f); k <= Math.ceil(f); k += 1) {
				if (j * j + k * k <= (f + 1) * (f + 1)) ctx.set(x + j, y + i, z + k, stone)
			}
		}
		f -= random.nextInt(2) + 0.5
	}
	return true
}

/** `minecraft:end_spike`: the obsidian pillars around the middle of the End, for those that stand in the chunk of the position */
export const endSpike: FeatureFn = (ctx, config, x, _y, z) => {
	interface Spike { cx: number, cz: number, radius: number, height: number, guarded: boolean }
	const spikes: Spike[] = []
	for (const entry of list(config.spikes)) {
		if (!isObj(entry)) continue
		spikes.push({ cx: int(entry.centerX, 0), cz: int(entry.centerZ, 0), radius: clamp(int(entry.radius, 0), 0, 16), height: int(entry.height, 0), guarded: entry.guarded === true })
	}
	if (spikes.length === 0) {
		const sizes = shuffled(ctx.random, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
		for (let i = 0; i < 10; i += 1) {
			const a = 2 * (-Math.PI + Math.PI / 10 * i)
			spikes.push({ cx: Math.floor(42 * Math.cos(a)), cz: Math.floor(42 * Math.sin(a)), radius: 2 + Math.floor(sizes[i] / 3), height: 76 + sizes[i] * 3, guarded: sizes[i] === 1 || sizes[i] === 2 })
		}
	}
	const obsidian = blk('obsidian')
	let placed = false
	for (const s of spikes) {
		if (s.cx >> 4 !== x >> 4 || s.cz >> 4 !== z >> 4) continue
		for (let px = s.cx - s.radius; px <= s.cx + s.radius; px += 1) {
			for (let pz = s.cz - s.radius; pz <= s.cz + s.radius; pz += 1) {
				const inside = (px - s.cx) * (px - s.cx) + (pz - s.cz) * (pz - s.cz) <= s.radius * s.radius + 1
				for (let py = ctx.minY; py <= Math.min(s.height + 10, ctx.maxY - 1); py += 1) {
					if (inside && py < s.height) {
						if (ctx.set(px, py, pz, obsidian)) placed = true
					} else if (py > 65) {
						ctx.set(px, py, pz, AIR)
					}
				}
			}
		}
		if (s.guarded) {
			for (let i = -2; i <= 2; i += 1) {
				for (let j = -2; j <= 2; j += 1) {
					for (let k = 0; k <= 3; k += 1) {
						const edgeX = Math.abs(i) === 2
						const edgeZ = Math.abs(j) === 2
						const top = k === 3
						if (!edgeX && !edgeZ && !top) continue
						const ns = edgeX || top
						const we = edgeZ || top
						ctx.set(s.cx + i, s.height + k, s.cz + j, blk('iron_bars', {
							north: String(ns && j !== -2), south: String(ns && j !== 2), west: String(we && i !== -2), east: String(we && i !== 2), waterlogged: 'false',
						}))
					}
				}
			}
		}
		ctx.set(s.cx, s.height, s.cz, blk('bedrock'))
		ctx.set(s.cx, s.height + 1, s.cz, blk('fire', { age: '0', east: 'false', north: 'false', south: 'false', up: 'false', west: 'false' }))
	}
	return placed
}

/** `minecraft:end_platform` (26.3): the obsidian platform that players arrive on */
export const endPlatform: FeatureFn = (ctx, _config, x, y, z) => {
	const obsidian = blk('obsidian')
	for (let i = -2; i <= 2; i += 1) {
		for (let j = -2; j <= 2; j += 1) {
			for (let k = -1; k < 3; k += 1) {
				const wanted = k === -1 ? obsidian : AIR
				if (ctx.get(x + j, y + k, z + i).name !== wanted.name) ctx.set(x + j, y + k, z + i, wanted)
			}
		}
	}
	return true
}

/** `minecraft:void_start_platform`: the platform of the void world, in the chunks around its middle */
export const voidStartPlatform: FeatureFn = (ctx, _config, x, y, z) => {
	const cx = x >> 4
	const cz = z >> 4
	if (Math.max(Math.abs(cx), Math.abs(cz)) > 1) return true
	for (let px = cx * 16; px < cx * 16 + 16; px += 1) {
		for (let pz = cz * 16; pz < cz * 16 + 16; pz += 1) {
			if (Math.max(Math.abs(px - 8), Math.abs(pz - 8)) > 16) continue
			ctx.set(px, y + 3, pz, blk(px === 8 && pz === 8 ? 'cobblestone' : 'stone'))
		}
	}
	return true
}

/** `minecraft:end_gateway`, without where it leads */
export const endGateway: FeatureFn = (ctx, _config, x, y, z) => {
	const bedrock = blk('bedrock')
	for (let dx = -1; dx <= 1; dx += 1) {
		for (let dy = -2; dy <= 2; dy += 1) {
			for (let dz = -1; dz <= 1; dz += 1) {
				const sameX = dx === 0
				const sameY = dy === 0
				const sameZ = dz === 0
				const cap = Math.abs(dy) === 2
				let state: FBlock
				if (sameX && sameY && sameZ) state = blk('end_gateway')
				else if (sameY) state = AIR
				else if (cap && sameX && sameZ) state = bedrock
				else if (!sameX && !sameZ || cap) state = AIR
				else state = bedrock
				ctx.set(x + dx, y + dy, z + dz, state)
			}
		}
	}
	return true
}

/** `minecraft:end_podium` */
export const endPodium: FeatureFn = (ctx, config, x, y, z) => {
	const bedrock = blk('bedrock')
	for (let dx = -4; dx <= 4; dx += 1) {
		for (let dz = -4; dz <= 4; dz += 1) {
			for (let dy = -1; dy <= 32; dy += 1) {
				const dist = dx * dx + dy * dy + dz * dz
				const near = dist < 2.5 * 2.5
				if (!near && dist >= 3.5 * 3.5) continue
				let state: FBlock
				if (dy < 0) state = near ? bedrock : blk('end_stone')
				else if (dy > 0) state = AIR
				else if (!near) state = bedrock
				else state = config.active === true ? blk('end_portal') : AIR
				ctx.set(x + dx, y + dy, z + dz, state)
			}
		}
	}
	for (let i = 0; i < 4; i += 1) ctx.set(x, y + i, z, bedrock)
	for (const dir of HORIZONTAL) ctx.set(x + STEP[dir][0], y + 2, z + STEP[dir][2], blk('wall_torch', { facing: dir }))
	return true
}

/** `minecraft:bonus_chest`, without what is in the chest */
export const bonusChest: FeatureFn = (ctx, _config, x, _y, z) => {
	const random = ctx.random
	const cx = x & ~15
	const cz = z & ~15
	const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
	const zs = shuffled(random, offsets)
	for (const dx of shuffled(random, offsets)) {
		for (const dz of zs) {
			const px = cx + dx
			const pz = cz + dz
			const py = ctx.height('MOTION_BLOCKING_NO_LEAVES', px, pz)
			if (py <= ctx.minY || ctx.outside(py) || isSolidIn(ctx.get(px, py, pz), ctx)) continue
			ctx.set(px, py, pz, blk('chest', { facing: 'north', type: 'single', waterlogged: 'false' }))
			for (const dir of HORIZONTAL) {
				const tx = px + STEP[dir][0]
				const tz = pz + STEP[dir][2]
				if (isAir(ctx.get(tx, py, tz)) && isSturdy(ctx.get(tx, py - 1, tz), 'up', ctx)) ctx.set(tx, py, tz, blk('torch'))
			}
			return true
		}
	}
	return false
}

/** `minecraft:monster_room`, without what is in the chests and the spawner */
export const monsterRoom: FeatureFn = (ctx, _config, x, y, z) => {
	const random = ctx.random
	const rx = random.nextInt(2) + 2
	const rz = random.nextInt(2) + 2
	const solid = (px: number, py: number, pz: number) => isSolidIn(ctx.get(px, py, pz), ctx)
	let openings = 0
	for (let s = -rx - 1; s <= rx + 1; s += 1) {
		for (let t = -1; t <= 4; t += 1) {
			for (let u = -rz - 1; u <= rz + 1; u += 1) {
				const isSolid = solid(x + s, y + t, z + u)
				if ((t === -1 || t === 4) && !isSolid) return false
				const wall = s === -rx - 1 || s === rx + 1 || u === -rz - 1 || u === rz + 1
				if (wall && t === 0 && isAir(ctx.get(x + s, y + t, z + u)) && isAir(ctx.get(x + s, y + t + 1, z + u))) openings += 1
			}
		}
	}
	if (openings < 1 || openings > 5) return false
	const cannotReplace = ctx.tag('minecraft:features_cannot_replace')
	const safeSet = (px: number, py: number, pz: number, state: FBlock) => {
		if (!cannotReplace.has(ctx.get(px, py, pz).name)) ctx.set(px, py, pz, state)
	}
	for (let s = -rx - 1; s <= rx + 1; s += 1) {
		for (let t = 3; t >= -1; t -= 1) {
			for (let u = -rz - 1; u <= rz + 1; u += 1) {
				const px = x + s
				const py = y + t
				const pz = z + u
				const current = ctx.get(px, py, pz)
				if (s === -rx - 1 || t === -1 || u === -rz - 1 || s === rx + 1 || t === 4 || u === rz + 1) {
					if (py >= ctx.minY && !solid(px, py - 1, pz)) {
						ctx.set(px, py, pz, AIR)
					} else if (isSolidIn(current, ctx) && !named(current, 'chest')) {
						safeSet(px, py, pz, blk(t === -1 && random.nextInt(4) !== 0 ? 'mossy_cobblestone' : 'cobblestone'))
					}
				} else if (!named(current, 'chest', 'spawner')) {
					safeSet(px, py, pz, AIR)
				}
			}
		}
	}
	for (let s = 0; s < 2; s += 1) {
		for (let t = 0; t < 3; t += 1) {
			const px = x + random.nextInt(rx * 2 + 1) - rx
			const pz = z + random.nextInt(rz * 2 + 1) - rz
			if (!isAir(ctx.get(px, y, pz))) continue
			const walls = HORIZONTAL.filter(dir => solid(px + STEP[dir][0], y, pz + STEP[dir][2]))
			if (walls.length !== 1) continue
			const facing: Dir = walls[0] === 'north' ? 'south' : walls[0] === 'south' ? 'north' : walls[0] === 'west' ? 'east' : 'west'
			safeSet(px, y, pz, blk('chest', { facing, type: 'single', waterlogged: 'false' }))
			break
		}
	}
	safeSet(x, y, z, blk('spawner'))
	return true
}
