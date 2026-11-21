import { AIR, blk, fluidOf, isAir, isBaseStone, isLava, isSturdy, isWater, named, parseBlock, WATER, withProps } from './blocks.js'
import { noise3 } from './noise.js'
import { clampedNormal, holderSet, intBounds, sampleFloat, sampleInt } from './providers.js'
import { between, pick } from './random.js'
import { provide } from './states.js'
import type { Ctx, FBlock, FeatureFn, Json, Pos } from './types.js'
import type { Dir } from './util.js'
import { clamp, clampedMap, DIRECTIONS, HORIZONTAL, int, key, list, num, obj, OPPOSITE, STEP } from './util.js'

/** The blocks of dripstone or of another kind of stalactite (26.3 has sulfur spikes) */
interface Speleothem {
	base: FBlock
	pointed: FBlock
	replaceable: (name: string) => boolean
}

function speleothemOf(ctx: Ctx, config: Json): Speleothem {
	return {
		base: parseBlock(config.base_block) ?? blk('dripstone_block'),
		pointed: parseBlock(config.pointed_block) ?? blk('pointed_dripstone'),
		replaceable: holderSet(ctx, config.replaceable_blocks ?? '#minecraft:dripstone_replaceable_blocks'),
	}
}

function emptyOrWater(block: FBlock) {
	return isAir(block) || isWater(block)
}

function isBase(s: Speleothem, block: FBlock) {
	return block.name === s.base.name || s.replaceable(block.name)
}

function placeBase(ctx: Ctx, s: Speleothem, x: number, y: number, z: number): boolean {
	if (!s.replaceable(ctx.get(x, y, z).name)) return false
	ctx.set(x, y, z, s.base)
	return true
}

/** Grows a stalagmite (up) or a stalactite (down) from a position next to its base */
function growPointed(ctx: Ctx, s: Speleothem, x: number, y: number, z: number, up: boolean, height: number, merge: boolean) {
	const step = up ? 1 : -1
	if (!isBase(s, ctx.get(x, y - step, z))) return
	const parts: string[] = []
	if (height >= 3) {
		parts.push('base')
		for (let i = 0; i < height - 3; i += 1) parts.push('middle')
	}
	if (height >= 2) parts.push('frustum')
	if (height >= 1) parts.push(merge ? 'tip_merge' : 'tip')
	let py = y
	for (const thickness of parts) {
		const waterlogged = String(isWater(ctx.get(x, py, z)))
		ctx.set(x, py, z, withProps(s.pointed, { thickness, vertical_direction: up ? 'up' : 'down', waterlogged }))
		py += step
	}
}

/** `minecraft:pointed_dripstone` (1.19) and `minecraft:speleothem` (26.3): one small stalagmite or stalactite */
export const speleothem: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const s = speleothemOf(ctx, config)
	const above = isBase(s, ctx.get(x, y + 1, z))
	const below = isBase(s, ctx.get(x, y - 1, z))
	if (!above && !below) return false
	const up = above && below ? random.nextBoolean() : below
	const baseY = up ? y - 1 : y + 1
	placeBase(ctx, s, x, baseY, z)
	for (const dir of HORIZONTAL) {
		if (random.nextFloat() > num(config.chance_of_directional_spread, 0.7)) continue
		let px = x + STEP[dir][0]
		let py = baseY
		let pz = z + STEP[dir][2]
		placeBase(ctx, s, px, py, pz)
		if (random.nextFloat() > num(config.chance_of_spread_radius2, 0.5)) continue
		const second = DIRECTIONS[random.nextInt(6)]
		px += STEP[second][0]
		py += STEP[second][1]
		pz += STEP[second][2]
		placeBase(ctx, s, px, py, pz)
		if (random.nextFloat() > num(config.chance_of_spread_radius3, 0.5)) continue
		const third = DIRECTIONS[random.nextInt(6)]
		placeBase(ctx, s, px + STEP[third][0], py + STEP[third][1], pz + STEP[third][2])
	}
	const tall = random.nextFloat() < num(config.chance_of_taller_dripstone, 0.2) && emptyOrWater(ctx.get(x, y + (up ? 1 : -1), z))
	growPointed(ctx, s, x, y, z, up, tall ? 2 : 1, false)
	return true
}

interface Column {
	floor: number | undefined
	ceiling: number | undefined
}

/** Looks up and down a column of open blocks for the blocks that end it */
function scanColumn(ctx: Ctx, x: number, y: number, z: number, range: number, inside: (block: FBlock) => boolean, boundary: (block: FBlock) => boolean): Column | undefined {
	if (!inside(ctx.get(x, y, z))) return undefined
	const scan = (step: number) => {
		let py = y
		for (let j = 1; j < range && inside(ctx.get(x, py, z)); j += 1) py += step
		return boundary(ctx.get(x, py, z)) ? py : undefined
	}
	return { ceiling: scan(1), floor: scan(-1) }
}

/** `minecraft:dripstone_cluster` (1.19) and `minecraft:speleothem_cluster` (26.3) */
export const speleothemCluster: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const s = speleothemOf(ctx, config)
	if (!emptyOrWater(ctx.get(x, y, z))) return false
	const height = clamp(sampleInt(ctx, config.height, 1), 0, 64)
	const wetness = sampleFloat(ctx, config.wetness, 0)
	const density = sampleFloat(ctx, config.density, 0)
	const rx = clamp(sampleInt(ctx, config.radius, 1), 0, 32)
	const rz = clamp(sampleInt(ctx, config.radius, 1), 0, 32)
	const range = clamp(int(config.floor_to_ceiling_search_range, 12), 1, 128)
	const thickness = config.speleothem_block_layer_thickness ?? config.dripstone_block_layer_thickness
	const edgeReach = num(config.max_distance_from_edge_affecting_chance_of_speleothem ?? config.max_distance_from_edge_affecting_chance_of_dripstone_column, 3)
	const edgeChance = num(config.chance_of_speleothem_at_max_distance_from_center ?? config.chance_of_dripstone_column_at_max_distance_from_center, 0.1)
	const biasReach = num(config.max_distance_from_center_affecting_height_bias, 8)
	const deviation = num(config.height_deviation, 3)
	const maxDiff = Math.max(0, int(config.max_stalagmite_stalactite_height_diff, 1))

	const heightOfColumn = (dx: number, dz: number, maxHeight: number) => {
		if (random.nextFloat() > density) return 0
		const mean = clampedMap(Math.abs(dx) + Math.abs(dz), 0, biasReach, maxHeight / 2, 0)
		return Math.trunc(clampedNormal(ctx, mean, deviation, 0, maxHeight))
	}
	const layer = (px: number, py: number, pz: number, step: number) => {
		const count = clamp(sampleInt(ctx, thickness, 1), 0, 32)
		for (let i = 0; i < count; i += 1) {
			if (!placeBase(ctx, s, px, py + i * step, pz)) return
		}
	}
	const besideWater = (px: number, py: number, pz: number) => {
		const block = ctx.get(px, py, pz)
		return isBaseStone(block, ctx) || s.replaceable(block.name) || fluidOf(block) === 'minecraft:water'
	}
	const canPool = (px: number, py: number, pz: number) => {
		const block = ctx.get(px, py, pz)
		if (isWater(block) || block.name === s.base.name || block.name === s.pointed.name) return false
		if (fluidOf(ctx.get(px, py + 1, pz)) === 'minecraft:water') return false
		return HORIZONTAL.every(dir => besideWater(px + STEP[dir][0], py, pz + STEP[dir][2])) && besideWater(px, py - 1, pz)
	}

	for (let dx = -rx; dx <= rx; dx += 1) {
		for (let dz = -rz; dz <= rz; dz += 1) {
			const chance = clampedMap(Math.min(rx - Math.abs(dx), rz - Math.abs(dz)), 0, edgeReach, edgeChance, 1)
			const px = x + dx
			const pz = z + dz
			const column = scanColumn(ctx, px, y, pz, range, emptyOrWater, block => !emptyOrWater(block))
			if (column === undefined || column.ceiling === undefined && column.floor === undefined) continue
			const ceiling = column.ceiling
			let floor = column.floor
			if (random.nextFloat() < wetness && floor !== undefined && canPool(px, floor, pz)) {
				ctx.set(px, floor, pz, WATER)
				floor -= 1
			}
			let down = 0
			if (ceiling !== undefined && random.nextDouble() < chance && !isLava(ctx.get(px, ceiling, pz))) {
				layer(px, ceiling, pz, 1)
				down = heightOfColumn(dx, dz, floor !== undefined ? Math.min(height, ceiling - floor) : height)
			}
			let up = 0
			if (floor !== undefined && random.nextDouble() < chance && !isLava(ctx.get(px, floor, pz))) {
				layer(px, floor, pz, -1)
				up = ceiling !== undefined ? Math.max(0, down + between(random, -maxDiff, maxDiff)) : heightOfColumn(dx, dz, height)
			}
			if (ceiling !== undefined && floor !== undefined && ceiling - down <= floor + up) {
				const from = Math.max(ceiling - down, floor + 1)
				const to = Math.min(floor + up, ceiling - 1)
				const meet = between(random, from, to + 1)
				down = ceiling - meet
				up = meet - 1 - floor
			}
			const merge = random.nextBoolean() && down > 0 && up > 0 && ceiling !== undefined && floor !== undefined && down + up === ceiling - floor - 1
			if (ceiling !== undefined) growPointed(ctx, s, px, ceiling - 1, pz, false, down, merge)
			if (floor !== undefined) growPointed(ctx, s, px, floor + 1, pz, true, up, merge)
		}
	}
	return true
}

/** How high a large dripstone is at a distance from its middle */
function dripstoneHeight(distance: number, radius: number, scale: number, bluntness: number) {
	const d = Math.max(distance, bluntness)
	const f = d / radius * 0.384
	const j = Math.max(scale * (0.75 * Math.pow(f, 4 / 3) - Math.pow(f, 2 / 3) - Math.log(f) / 3), 0)
	return j / 0.384 * radius
}

/** `minecraft:large_dripstone`: a big stalactite and stalagmite that can meet */
export const largeDripstone: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const s = speleothemOf(ctx, config)
	if (!emptyOrWater(ctx.get(x, y, z))) return false
	const range = clamp(int(config.floor_to_ceiling_search_range, 30), 1, 128)
	const column = scanColumn(ctx, x, y, z, range, emptyOrWater, block => isBase(s, block) || isLava(block))
	if (column === undefined || column.floor === undefined || column.ceiling === undefined) return false
	const space = column.ceiling - column.floor - 1
	if (space < 4) return false
	const [minRadius, maxRadius] = intBounds(config.column_radius, [3, 19])
	const limit = clamp(Math.trunc(space * num(config.max_column_radius_to_cave_height_ratio, 0.33)), minRadius, Math.min(maxRadius, 32))
	const radius = between(random, minRadius, limit)
	const open = (block: FBlock) => isAir(block) || isWater(block) || isLava(block)

	interface Large { x: number, y: number, z: number, up: boolean, radius: number, bluntness: number, scale: number }
	const make = (py: number, up: boolean, bluntness: unknown): Large => ({
		x, y: py, z, up, radius, bluntness: sampleFloat(ctx, bluntness, 0.5), scale: sampleFloat(ctx, config.height_scale, 1),
	})
	const stalactite = make(column.ceiling - 1, false, config.stalactite_bluntness)
	const stalagmite = make(column.floor + 1, true, config.stalagmite_bluntness)
	const heightAtRadius = (d: Large, r: number) => Math.trunc(dripstoneHeight(r, d.radius, d.scale, d.bluntness))
	const windy = (d: Large) => d.radius >= int(config.min_radius_for_wind, 4) && d.bluntness >= num(config.min_bluntness_for_wind, 0.6)
	let windX = 0
	let windZ = 0
	if (windy(stalactite) && windy(stalagmite)) {
		const speed = sampleFloat(ctx, config.wind_speed, 0)
		const angle = random.nextFloat() * Math.PI
		windX = Math.cos(angle) * speed
		windZ = Math.sin(angle) * speed
	}
	const blown = (px: number, py: number, pz: number): Pos => [px + Math.floor(windX * (y - py)), py, pz + Math.floor(windZ * (y - py))]
	const embedded = (px: number, py: number, pz: number, r: number) => {
		if (open(ctx.get(px, py, pz))) return false
		const step = 6 / r
		for (let a = 0; a < Math.PI * 2; a += step) {
			if (open(ctx.get(px + Math.trunc(Math.cos(a) * r), py, pz + Math.trunc(Math.sin(a) * r)))) return false
		}
		return true
	}
	const moveBack = (d: Large) => {
		while (d.radius > 1) {
			let py = d.y
			const tries = Math.min(10, heightAtRadius(d, 0))
			for (let j = 0; j < tries; j += 1) {
				if (isLava(ctx.get(d.x, py, d.z))) return false
				const [bx, by, bz] = blown(d.x, py, d.z)
				if (embedded(bx, by, bz, d.radius)) {
					d.y = py
					return true
				}
				py += d.up ? -1 : 1
			}
			d.radius = Math.trunc(d.radius / 2)
		}
		return false
	}
	const place = (d: Large) => {
		for (let i = -d.radius; i <= d.radius; i += 1) {
			for (let j = -d.radius; j <= d.radius; j += 1) {
				const dist = Math.sqrt(i * i + j * j)
				if (dist > d.radius) continue
				let height = heightAtRadius(d, dist)
				if (height <= 0) continue
				if (random.nextFloat() < 0.2) height = Math.trunc(height * (0.8 + random.nextFloat() * 0.2))
				let py = d.y
				let started = false
				const top = d.up ? ctx.height('WORLD_SURFACE_WG', d.x + i, d.z + j) : Infinity
				for (let m = 0; m < height && py < top; m += 1) {
					const [bx, by, bz] = blown(d.x + i, py, d.z + j)
					const block = ctx.get(bx, by, bz)
					if (open(block) && !ctx.outside(by)) {
						started = true
						ctx.set(bx, by, bz, s.base)
					} else if (started && isBaseStone(block, ctx)) {
						break
					}
					py += d.up ? 1 : -1
				}
			}
		}
	}
	const doStalactite = moveBack(stalactite)
	const doStalagmite = moveBack(stalagmite)
	if (doStalactite) place(stalactite)
	if (doStalagmite) place(stalagmite)
	return true
}

/** `minecraft:geode`: a hollow ball of layers, with a crack */
export const geode: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const blocks = obj(config.blocks)
	const layers = obj(config.layers)
	const crack = obj(config.crack)
	const minOffset = clamp(int(config.min_gen_offset, -16), -24, 0)
	const maxOffset = clamp(int(config.max_gen_offset, 16), 0, 24)
	const pointCount = clamp(sampleInt(ctx, config.distribution_points ?? { type: 'uniform', min_inclusive: 3, max_inclusive: 4 }, 3), 1, 20)
	const wall = config.outer_wall_distance ?? { type: 'uniform', min_inclusive: 4, max_inclusive: 5 }
	const pointOffset = config.point_offset ?? { type: 'uniform', min_inclusive: 1, max_inclusive: 2 }
	const d = pointCount / Math.max(1, intBounds(wall, [4, 5])[1])
	const filling = 1 / Math.sqrt(num(layers.filling, 1.7))
	const inner = 1 / Math.sqrt(num(layers.inner_layer, 2.2) + d)
	const middle = 1 / Math.sqrt(num(layers.middle_layer, 3.2) + d)
	const outer = 1 / Math.sqrt(num(layers.outer_layer, 4.2) + d)
	const crackSize = 1 / Math.sqrt(num(crack.base_crack_size, 2) + random.nextDouble() / 2 + (pointCount > 3 ? d : 0))
	const cracked = random.nextFloat() < num(crack.generate_crack_chance, 1)
	const crackOffset = num(crack.crack_point_offset, 2)
	const invalid = holderSet(ctx, blocks.invalid_blocks)
	const cannotReplace = holderSet(ctx, blocks.cannot_replace)
	const threshold = int(config.invalid_blocks_threshold, 0)
	const noiseMultiplier = num(config.noise_multiplier, 0.05)
	const points: [number, number, number, number][] = []
	let invalidCount = 0
	for (let n = 0; n < pointCount; n += 1) {
		const px = x + sampleInt(ctx, wall, 4)
		const py = y + sampleInt(ctx, wall, 4)
		const pz = z + sampleInt(ctx, wall, 4)
		const block = ctx.get(px, py, pz)
		if (isAir(block) || invalid(block.name)) {
			invalidCount += 1
			if (invalidCount > threshold) return false
		}
		points.push([px, py, pz, sampleInt(ctx, pointOffset, 1)])
	}
	const crackPoints: Pos[] = []
	if (cracked) {
		const side = random.nextInt(4)
		const o = pointCount * 2 + 1
		const cx = side === 0 || side === 2 ? o : 0
		const cz = side === 1 || side === 2 ? o : 0
		for (const cy of [7, 5, 1]) crackPoints.push([x + cx, y + cy, z + cz])
	}
	const safeSet = (px: number, py: number, pz: number, state: FBlock | undefined) => {
		if (state !== undefined && !cannotReplace(ctx.get(px, py, pz).name)) ctx.set(px, py, pz, state)
	}
	const requireAlternate = config.placements_require_layer0_alternate !== false
	const alternateChance = num(config.use_alternate_layer0_chance, 0)
	const budChance = num(config.use_potential_placements_chance, 0.35)
	const buds: Pos[] = []
	for (let px = x + minOffset; px <= x + maxOffset; px += 1) {
		for (let py = y + minOffset; py <= y + maxOffset; py += 1) {
			for (let pz = z + minOffset; pz <= z + maxOffset; pz += 1) {
				const r = noise3(px / 16, py / 16, pz / 16) * noiseMultiplier
				let sum = 0
				for (const p of points) {
					sum += 1 / Math.sqrt((px - p[0]) * (px - p[0]) + (py - p[1]) * (py - p[1]) + (pz - p[2]) * (pz - p[2]) + p[3]) + r
				}
				if (sum < outer) continue
				let crackSum = 0
				for (const p of crackPoints) {
					crackSum += 1 / Math.sqrt((px - p[0]) * (px - p[0]) + (py - p[1]) * (py - p[1]) + (pz - p[2]) * (pz - p[2]) + crackOffset) + r
				}
				if (cracked && crackSum >= crackSize && sum < filling) {
					safeSet(px, py, pz, AIR)
				} else if (sum >= filling) {
					safeSet(px, py, pz, provide(ctx, blocks.filling_provider, px, py, pz))
				} else if (sum >= inner) {
					const alternate = random.nextFloat() < alternateChance
					safeSet(px, py, pz, provide(ctx, alternate ? blocks.alternate_inner_layer_provider : blocks.inner_layer_provider, px, py, pz))
					if ((!requireAlternate || alternate) && random.nextFloat() < budChance) buds.push([px, py, pz])
				} else if (sum >= middle) {
					safeSet(px, py, pz, provide(ctx, blocks.middle_layer_provider, px, py, pz))
				} else {
					safeSet(px, py, pz, provide(ctx, blocks.outer_layer_provider, px, py, pz))
				}
			}
		}
	}
	const placements = list(blocks.inner_placements).map(parseBlock).filter((b): b is FBlock => b !== undefined)
	for (const [px, py, pz] of buds) {
		const bud = pick(random, placements)
		if (bud === undefined) break
		for (const dir of DIRECTIONS) {
			const qx = px + STEP[dir][0]
			const qy = py + STEP[dir][1]
			const qz = pz + STEP[dir][2]
			const target = ctx.get(qx, qy, qz)
			if (!isAir(target) && !isWater(target)) continue
			// The game sets these on blocks that have them; only the names of the blocks are known here
			const directed = bud.properties.facing !== undefined || /amethyst_(bud|cluster)$/.test(bud.name)
			safeSet(qx, qy, qz, directed ? withProps(bud, { facing: dir, waterlogged: String(isWater(target)) }) : bud)
			break
		}
	}
	return true
}

const SCULK_FALLBACK = new Set(['stone', 'granite', 'diorite', 'andesite', 'tuff', 'deepslate', 'dirt', 'grass_block', 'sand', 'gravel', 'clay', 'calcite', 'netherrack', 'end_stone'])

/** `minecraft:sculk_patch`. The game sends charges that crawl over the surface; this is a simpler crawl that makes the same kind of patch. */
export const sculkPatch: FeatureFn = (ctx, config, x, y, z) => {
	const random = ctx.random
	const open = (block: FBlock) => isAir(block) || isWater(block)
	const isSculk = (block: FBlock) => named(block, 'sculk')
	const tag = ctx.tag('minecraft:sculk_replaceable_world_gen')
	const replaceable = (block: FBlock) => tag.size > 0 ? tag.has(block.name) : SCULK_FALLBACK.has(block.name.replace('minecraft:', ''))
	const at = (p: Pos) => ctx.get(p[0], p[1], p[2])
	const exposed = (p: Pos) => DIRECTIONS.some(dir => open(ctx.get(p[0] + STEP[dir][0], p[1] + STEP[dir][1], p[2] + STEP[dir][2])))
	const origin = ctx.get(x, y, z)
	let start: Pos | undefined
	if (isSculk(origin) || replaceable(origin)) {
		start = [x, y, z]
	} else if (open(origin)) {
		for (const dir of DIRECTIONS) {
			const p: Pos = [x + STEP[dir][0], y + STEP[dir][1], z + STEP[dir][2]]
			if (isSturdy(at(p), OPPOSITE[dir], ctx)) {
				start = p
				break
			}
		}
	}
	if (start === undefined) return false
	const sculk = blk('sculk')
	const placed = new Map<string, Pos>()
	const growths = new Set<string>()
	const rounds = clamp(int(config.spread_rounds, 1) + int(config.growth_rounds, 0), 0, 16)
	const charges = clamp(int(config.charge_count, 10), 0, 32)
	const amount = clamp(int(config.amount_per_charge, 32), 0, 1000)
	const attempts = clamp(int(config.spread_attempts, 64), 0, 512)
	for (let round = 0; round < rounds; round += 1) {
		const spreading = round < int(config.spread_rounds, 1)
		const cursors = Array.from({ length: charges }, () => ({ pos: start as Pos, charge: amount }))
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			for (const cursor of cursors) {
				if (cursor.charge <= 0) continue
				const here = at(cursor.pos)
				if (replaceable(here) && exposed(cursor.pos)) {
					if (ctx.set(cursor.pos[0], cursor.pos[1], cursor.pos[2], sculk)) placed.set(key(cursor.pos[0], cursor.pos[1], cursor.pos[2]), cursor.pos)
					cursor.charge -= 1
				} else if (isSculk(here)) {
					const [px, py, pz] = cursor.pos
					const near = [...growths].some(k => {
						const [gx, gy, gz] = k.split(',').map(Number)
						return Math.abs(gx - px) + Math.abs(gy - py) + Math.abs(gz - pz) < 4
					})
					if ((!spreading || random.nextInt(40) === 0) && cursor.charge >= 10 && isAir(ctx.get(px, py + 1, pz)) && !near) {
						const growth = random.nextInt(11) === 0
							? blk('sculk_shrieker', { can_summon: 'true', shrieking: 'false', waterlogged: 'false' })
							: blk('sculk_sensor', { power: '0', sculk_sensor_phase: 'inactive', waterlogged: 'false' })
						ctx.set(px, py + 1, pz, growth)
						growths.add(key(px, py + 1, pz))
						cursor.charge -= 10
					} else if (random.nextInt(10) === 0) {
						cursor.charge -= 1
					}
				}
				const next: Pos = [cursor.pos[0] + random.nextInt(3) - 1, cursor.pos[1] + random.nextInt(3) - 1, cursor.pos[2] + random.nextInt(3) - 1]
				const block = at(next)
				if ((isSculk(block) || replaceable(block)) && exposed(next)) cursor.pos = next
			}
		}
	}
	// Veins on the blocks around the patch
	for (const [px, py, pz] of placed.values()) {
		for (const dir of HORIZONTAL) {
			const side: Pos = [px + STEP[dir][0], py, pz + STEP[dir][2]]
			if (!replaceable(at(side)) || random.nextInt(2) === 0) continue
			for (const face of ['up', 'down', 'north', 'south', 'west', 'east'] as Dir[]) {
				const vx = side[0] + STEP[face][0]
				const vy = side[1] + STEP[face][1]
				const vz = side[2] + STEP[face][2]
				const target = ctx.get(vx, vy, vz)
				if (!open(target)) continue
				ctx.set(vx, vy, vz, blk('sculk_vein', {
					down: 'false', east: 'false', north: 'false', south: 'false', up: 'false', west: 'false', waterlogged: String(isWater(target)), [OPPOSITE[face]]: 'true',
				}))
				break
			}
		}
	}
	// 1.19 has the catalyst and the shriekers in the feature itself
	if (config.catalyst_chance !== undefined && random.nextFloat() <= num(config.catalyst_chance, 0) && isSturdy(ctx.get(x, y - 1, z), 'up', ctx)) {
		ctx.set(x, y, z, blk('sculk_catalyst', { bloom: 'false' }))
	}
	const extra = clamp(sampleInt(ctx, config.extra_rare_growths, 0), 0, 16)
	for (let i = 0; i < extra; i += 1) {
		const px = x + random.nextInt(5) - 2
		const pz = z + random.nextInt(5) - 2
		if (isAir(ctx.get(px, y, pz)) && isSturdy(ctx.get(px, y - 1, pz), 'up', ctx)) {
			ctx.set(px, y, pz, blk('sculk_shrieker', { can_summon: 'true', shrieking: 'false', waterlogged: 'false' }))
		}
	}
	return true
}
