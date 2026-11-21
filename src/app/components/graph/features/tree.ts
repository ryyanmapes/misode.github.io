import { blk, inTag, isAir, isDirt, isFullCube, isLog, isSturdy, isTreeReplaceable, isWater, named, withProps } from './blocks.js'
import { holderSet, intBounds, sampleInt } from './providers.js'
import { between, shuffled } from './random.js'
import { provide } from './states.js'
import type { Ctx, FBlock, Json, Pos } from './types.js'
import type { Dir } from './util.js'
import { axisOf, bool, clamp, CLOCKWISE, DIRECTIONS, dirOf, fullId, HORIZONTAL, int, isObj, key, list, num, obj, OPPOSITE, shortId, STEP } from './util.js'

/** The trunk placers that the engine knows, without namespace */
export const TRUNK_PLACERS = [
	'straight_trunk_placer', 'forking_trunk_placer', 'giant_trunk_placer', 'mega_jungle_trunk_placer', 'dark_oak_trunk_placer', 'fancy_trunk_placer',
	'bending_trunk_placer', 'upwards_branching_trunk_placer', 'cherry_trunk_placer', 'poplar_trunk_placer',
]
/** The foliage placers that the engine knows, without namespace */
export const FOLIAGE_PLACERS = [
	'blob_foliage_placer', 'spruce_foliage_placer', 'pine_foliage_placer', 'acacia_foliage_placer', 'bush_foliage_placer', 'fancy_foliage_placer',
	'jungle_foliage_placer', 'mega_pine_foliage_placer', 'dark_oak_foliage_placer', 'random_spread_foliage_placer', 'cherry_foliage_placer', 'poplar_foliage_placer',
]
/** The tree decorators that the engine knows, without namespace */
export const TREE_DECORATORS = [
	'trunk_vine', 'leave_vine', 'cocoa', 'beehive', 'alter_ground', 'attached_to_leaves', 'attached_to_logs', 'place_on_ground', 'pale_moss', 'creaking_heart', 'shelf_mushroom',
]
export const ROOT_PLACERS = ['mangrove_root_placer']

const MAX_HEIGHT = 96
const MAX_RADIUS = 16

interface Attachment {
	x: number
	y: number
	z: number
	radiusOffset: number
	doubleTrunk: boolean
}

/** A tree while it grows */
interface Tree {
	ctx: Ctx
	config: Json
	logs: Map<string, Pos>
	leaves: Map<string, Pos>
	roots: Map<string, Pos>
	/** Blocks that the trunk may grow through on top of the usual ones */
	growThrough?: (name: string) => boolean
}

function trunkValid(t: Tree, x: number, y: number, z: number): boolean {
	const block = t.ctx.get(x, y, z)
	return isTreeReplaceable(block, t.ctx) || t.growThrough !== undefined && t.growThrough(block.name)
}

function trunkFree(t: Tree, x: number, y: number, z: number): boolean {
	return trunkValid(t, x, y, z) || isLog(t.ctx.get(x, y, z), t.ctx)
}

function placeLog(t: Tree, x: number, y: number, z: number, axis?: 'x' | 'y' | 'z'): boolean {
	if (!trunkValid(t, x, y, z)) return false
	let state = provide(t.ctx, t.config.trunk_provider, x, y, z)
	if (state === undefined) return false
	if (axis !== undefined && state.properties.axis !== undefined) state = withProps(state, { axis })
	if (t.ctx.set(x, y, z, state)) t.logs.set(key(x, y, z), [x, y, z])
	return true
}

function setDirtAt(t: Tree, x: number, y: number, z: number) {
	const config = t.config
	if (config.below_trunk_provider !== undefined) {
		// 26.3: the provider decides with its rules whether the ground changes
		const state = provide(t.ctx, config.below_trunk_provider, x, y, z)
		if (state !== undefined) t.ctx.set(x, y, z, state)
		return
	}
	const block = t.ctx.get(x, y, z)
	const keeps = isDirt(block, t.ctx) && !named(block, 'grass_block', 'mycelium')
	if (bool(config.force_dirt, false) || !keeps) {
		const state = provide(t.ctx, config.dirt_provider, x, y, z)
		if (state !== undefined) t.ctx.set(x, y, z, state)
	}
}

function tryPlaceLeaf(t: Tree, x: number, y: number, z: number): boolean {
	const current = t.ctx.get(x, y, z)
	if (!isTreeReplaceable(current, t.ctx)) return false
	let state = provide(t.ctx, t.config.foliage_provider, x, y, z)
	if (state === undefined) return false
	if (state.properties.waterlogged !== undefined && isWater(current)) state = withProps(state, { waterlogged: 'true' })
	if (t.ctx.set(x, y, z, state)) t.leaves.set(key(x, y, z), [x, y, z])
	return true
}

type Skip = (dx: number, y: number, dz: number, range: number, large: boolean) => boolean

function leavesRow(t: Tree, skip: Skip, cx: number, cy: number, cz: number, range: number, yOffset: number, large: boolean, signedSkip?: Skip) {
	const extra = large ? 1 : 0
	const r = Math.min(range, MAX_RADIUS)
	for (let dx = -r; dx <= r + extra; dx += 1) {
		for (let dz = -r; dz <= r + extra; dz += 1) {
			if (signedSkip !== undefined && signedSkip(dx, yOffset, dz, r, large)) continue
			const ax = large ? Math.min(Math.abs(dx), Math.abs(dx - 1)) : Math.abs(dx)
			const az = large ? Math.min(Math.abs(dz), Math.abs(dz - 1)) : Math.abs(dz)
			if (!skip(ax, yOffset, az, r, large)) tryPlaceLeaf(t, cx + dx, cy + yOffset, cz + dz)
		}
	}
}

// Foliage placers

function foliageHeightOf(t: Tree, placer: Json, type: string, treeHeight: number): number {
	const ctx = t.ctx
	switch (type) {
		case 'blob_foliage_placer':
		case 'bush_foliage_placer':
		case 'fancy_foliage_placer':
		case 'jungle_foliage_placer':
			return int(placer.height, 3)
		case 'spruce_foliage_placer':
			return Math.max(4, treeHeight - sampleInt(ctx, placer.trunk_height, 1))
		case 'pine_foliage_placer':
		case 'cherry_foliage_placer':
		case 'poplar_foliage_placer':
			return sampleInt(ctx, placer.height, 4)
		case 'acacia_foliage_placer':
			return 0
		case 'mega_pine_foliage_placer':
			return sampleInt(ctx, placer.crown_height, 4)
		case 'dark_oak_foliage_placer':
			return 4
		case 'random_spread_foliage_placer':
			return sampleInt(ctx, placer.foliage_height, 2)
		default:
			return 0
	}
}

function createFoliage(t: Tree, placer: Json, type: string, a: Attachment, foliageHeight: number, radius: number) {
	const ctx = t.ctx
	const random = ctx.random
	const offset = sampleInt(ctx, placer.offset, 0)
	const large = a.doubleTrunk
	switch (type) {
		case 'blob_foliage_placer': {
			const skip: Skip = (dx, y, dz, range) => dx === range && dz === range && (random.nextInt(2) === 0 || y === 0)
			for (let y = offset; y >= offset - foliageHeight; y -= 1) {
				leavesRow(t, skip, a.x, a.y, a.z, Math.max(radius + a.radiusOffset - 1 - Math.trunc(y / 2), 0), y, large)
			}
			return
		}
		case 'bush_foliage_placer': {
			const skip: Skip = (dx, _y, dz, range) => dx === range && dz === range && random.nextInt(2) === 0
			for (let y = offset; y >= offset - foliageHeight; y -= 1) {
				leavesRow(t, skip, a.x, a.y, a.z, radius + a.radiusOffset - 1 - y, y, large)
			}
			return
		}
		case 'fancy_foliage_placer': {
			const skip: Skip = (dx, _y, dz, range) => (dx + 0.5) * (dx + 0.5) + (dz + 0.5) * (dz + 0.5) > range * range
			for (let y = offset; y >= offset - foliageHeight; y -= 1) {
				leavesRow(t, skip, a.x, a.y, a.z, radius + (y !== offset && y !== offset - foliageHeight ? 1 : 0), y, large)
			}
			return
		}
		case 'spruce_foliage_placer': {
			const skip: Skip = (dx, _y, dz, range) => dx === range && dz === range && range > 0
			let i = random.nextInt(2)
			let j = 1
			let k = 0
			for (let l = offset; l >= -foliageHeight; l -= 1) {
				leavesRow(t, skip, a.x, a.y, a.z, i, l, large)
				if (i >= j) {
					i = k
					k = 1
					j = Math.min(j + 1, radius + a.radiusOffset)
				} else {
					i += 1
				}
			}
			return
		}
		case 'pine_foliage_placer': {
			const skip: Skip = (dx, _y, dz, range) => dx === range && dz === range && range > 0
			let i = 0
			for (let l = offset; l >= offset - foliageHeight; l -= 1) {
				leavesRow(t, skip, a.x, a.y, a.z, i, l, large)
				if (i >= 1 && l === offset - foliageHeight + 1) {
					i -= 1
				} else if (i < radius + a.radiusOffset) {
					i += 1
				}
			}
			return
		}
		case 'acacia_foliage_placer': {
			const skip: Skip = (dx, y, dz, range) => y === 0 ? (dx > 1 || dz > 1) && dx !== 0 && dz !== 0 : dx === range && dz === range && range > 0
			const y = a.y + offset
			leavesRow(t, skip, a.x, y, a.z, radius + a.radiusOffset, -1 - foliageHeight, large)
			leavesRow(t, skip, a.x, y, a.z, radius - 1, -foliageHeight, large)
			leavesRow(t, skip, a.x, y, a.z, radius + a.radiusOffset - 1, 0, large)
			return
		}
		case 'jungle_foliage_placer': {
			const skip: Skip = (dx, _y, dz, range) => dx + dz >= 7 || dx * dx + dz * dz > range * range
			const rows = large ? foliageHeight : 1 + random.nextInt(2)
			for (let y = offset; y >= offset - rows; y -= 1) {
				leavesRow(t, skip, a.x, a.y, a.z, radius + a.radiusOffset + 1 - y, y, large)
			}
			return
		}
		case 'mega_pine_foliage_placer': {
			const skip: Skip = (dx, _y, dz, range) => dx + dz >= 7 || dx * dx + dz * dz > range * range
			let last = 0
			for (let y = a.y - foliageHeight + offset; y <= a.y + offset; y += 1) {
				const down = a.y - y
				const r = radius + a.radiusOffset + Math.floor(down / Math.max(1, foliageHeight) * 3.5)
				const row = down > 0 && r === last && (y & 1) === 0 ? r + 1 : r
				leavesRow(t, skip, a.x, y, a.z, row, 0, large)
				last = r
			}
			return
		}
		case 'dark_oak_foliage_placer': {
			const skip: Skip = (dx, y, dz, range, big) => {
				if (y === -1 && !big) return dx === range && dz === range
				if (y === 1) return dx + dz > range * 2 - 2
				return false
			}
			const signed: Skip = (dx, y, dz, range, big) => y === 0 && big && (dx === -range || dx >= range) && (dz === -range || dz >= range)
			const y = a.y + offset
			if (large) {
				leavesRow(t, skip, a.x, y, a.z, radius + 2, -1, large, signed)
				leavesRow(t, skip, a.x, y, a.z, radius + 3, 0, large, signed)
				leavesRow(t, skip, a.x, y, a.z, radius + 2, 1, large, signed)
				if (random.nextBoolean()) leavesRow(t, skip, a.x, y, a.z, radius, 2, large, signed)
			} else {
				leavesRow(t, skip, a.x, y, a.z, radius + 2, -1, large, signed)
				leavesRow(t, skip, a.x, y, a.z, radius + 1, 0, large, signed)
			}
			return
		}
		case 'random_spread_foliage_placer': {
			const attempts = clamp(int(placer.leaf_placement_attempts, 0), 0, 2048)
			for (let i = 0; i < attempts; i += 1) {
				const dx = random.nextInt(radius) - random.nextInt(radius)
				const dy = random.nextInt(foliageHeight) - random.nextInt(foliageHeight)
				const dz = random.nextInt(radius) - random.nextInt(radius)
				tryPlaceLeaf(t, a.x + dx, a.y + dy, a.z + dz)
			}
			return
		}
		case 'cherry_foliage_placer': {
			const wideHole = num(placer.wide_bottom_layer_hole_chance, 0)
			const cornerHole = num(placer.corner_hole_chance, 0)
			const hanging = num(placer.hanging_leaves_chance, 0)
			const extension = num(placer.hanging_leaves_extension_chance, 0)
			const skip: Skip = (dx, y, dz, range) => {
				if (y === -1 && (dx === range || dz === range) && random.nextFloat() < wideHole) return true
				const corner = dx === range && dz === range
				if (range > 2) return corner || dx + dz > range * 2 - 2 && random.nextFloat() < cornerHole
				return corner && random.nextFloat() < cornerHole
			}
			const y = a.y + offset
			const r = radius + a.radiusOffset - 1
			leavesRow(t, skip, a.x, y, a.z, r - 2, foliageHeight - 3, large)
			leavesRow(t, skip, a.x, y, a.z, r - 1, foliageHeight - 4, large)
			for (let row = foliageHeight - 5; row >= 0; row -= 1) leavesRow(t, skip, a.x, y, a.z, r, row, large)
			const tryExtension = (chance: number, px: number, py: number, pz: number) => {
				if (Math.abs(px - a.x) + Math.abs(py - (y - 1)) + Math.abs(pz - a.z) >= 7) return false
				return random.nextFloat() > chance ? false : tryPlaceLeaf(t, px, py, pz)
			}
			const withHanging = (range: number, row: number) => {
				leavesRow(t, skip, a.x, y, a.z, range, row, large)
				const extra = large ? 1 : 0
				for (const dir of HORIZONTAL) {
					const cw = CLOCKWISE[dir]
					const reach = cw === 'south' || cw === 'east' ? range + extra : range
					let px = a.x + STEP[cw][0] * reach - STEP[dir][0] * range
					let pz = a.z + STEP[cw][2] * reach - STEP[dir][2] * range
					const py = y + row - 1
					for (let k = -range; k < range + extra; k += 1) {
						if (t.leaves.has(key(px, py + 1, pz)) && tryExtension(hanging, px, py, pz)) {
							tryExtension(extension, px, py - 1, pz)
						}
						px += STEP[dir][0]
						pz += STEP[dir][2]
					}
				}
			}
			withHanging(r, -1)
			withHanging(r - 1, -2)
			return
		}
		case 'poplar_foliage_placer': {
			// The game's code for this one is not known here: a narrow column of leaves around the top of the trunk, as tall as `radius`
			const hole = num(placer.side_hole_chance, 0)
			const top = a.y + offset
			const length = clamp(radius + a.radiusOffset, 2, 32)
			tryPlaceLeaf(t, a.x, top + 1, a.z)
			for (let down = 0; down <= length; down += 1) {
				const part = down / length
				const r = down === 0 || part > 0.85 ? 1 : part > 0.25 && part < 0.7 ? 2 : 1
				for (let dx = -r; dx <= r; dx += 1) {
					for (let dz = -r; dz <= r; dz += 1) {
						const ax = Math.abs(dx)
						const az = Math.abs(dz)
						if (ax === r && az === r && (r > 1 || down === 0 || down === length || random.nextFloat() < 0.5)) continue
						if ((ax === r || az === r) && r > 1 && random.nextFloat() < hole) continue
						tryPlaceLeaf(t, a.x + dx, top - down, a.z + dz)
					}
				}
			}
			return
		}
	}
}

// Trunk placers

function treeHeightOf(t: Tree, placer: Json): number {
	const random = t.ctx.random
	return clamp(int(placer.base_height, 4) + random.nextInt(int(placer.height_rand_a, 0) + 1) + random.nextInt(int(placer.height_rand_b, 0) + 1), 0, MAX_HEIGHT)
}

function limb(t: Tree, from: Pos, to: Pos, place: boolean): boolean {
	if (!place && from[0] === to[0] && from[1] === to[1] && from[2] === to[2]) return true
	const dx = to[0] - from[0]
	const dy = to[1] - from[1]
	const dz = to[2] - from[2]
	const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))
	if (steps === 0) {
		if (place) placeLog(t, from[0], from[1], from[2])
		return true
	}
	for (let j = 0; j <= steps; j += 1) {
		const x = from[0] + Math.floor(0.5 + j * dx / steps)
		const y = from[1] + Math.floor(0.5 + j * dy / steps)
		const z = from[2] + Math.floor(0.5 + j * dz / steps)
		if (place) {
			const ax = Math.abs(x - from[0])
			const az = Math.abs(z - from[2])
			const m = Math.max(ax, az)
			placeLog(t, x, y, z, m > 0 ? ax === m ? 'x' : 'z' : 'y')
		} else if (!trunkFree(t, x, y, z)) {
			return false
		}
	}
	return true
}

function fancyTrunk(t: Tree, height: number, x: number, y: number, z: number): Attachment[] {
	const random = t.ctx.random
	const j = height + 2
	const k = Math.floor(j * 0.618)
	setDirtAt(t, x, y - 1, z)
	const perLayer = Math.min(1, Math.floor(1.382 + Math.pow(j / 13, 2)))
	const m = y + k
	const coords: { pos: Pos, base: number }[] = [{ pos: [x, y + j - 5, z], base: m }]
	const shape = (n: number) => {
		if (n < j * 0.3) return -1
		const f = j / 2
		const g = f - n
		let h = Math.sqrt(Math.max(0, f * f - g * g))
		if (g === 0) h = f
		else if (Math.abs(g) >= f) return 0
		return h * 0.5
	}
	for (let n = j - 5; n >= 0; n -= 1) {
		const f = shape(n)
		if (f < 0) continue
		for (let o = 0; o < perLayer; o += 1) {
			const g = f * (random.nextFloat() + 0.328)
			const h = random.nextFloat() * 2 * Math.PI
			const end: Pos = [x + Math.floor(g * Math.sin(h) + 0.5), y + n - 1, z + Math.floor(g * Math.cos(h) + 0.5)]
			if (!limb(t, end, [end[0], end[1] + 5, end[2]], false)) continue
			const r = x - end[0]
			const s = z - end[2]
			const slope = end[1] - Math.sqrt(r * r + s * s) * 0.381
			const base = slope > m ? m : Math.trunc(slope)
			if (limb(t, [x, base, z], end, false)) coords.push({ pos: end, base })
		}
	}
	limb(t, [x, y, z], [x, y + k, z], true)
	const trim = (branchY: number) => branchY >= j * 0.2
	for (const c of coords) {
		const same = c.pos[0] === x && c.pos[1] === c.base && c.pos[2] === z
		if (!same && trim(c.base - y)) limb(t, [x, c.base, z], c.pos, true)
	}
	return coords.filter(c => trim(c.base - y)).map(c => ({ x: c.pos[0], y: c.pos[1], z: c.pos[2], radiusOffset: 0, doubleTrunk: false }))
}

function giantTrunk(t: Tree, height: number, x: number, y: number, z: number): Attachment[] {
	setDirtAt(t, x, y - 1, z)
	setDirtAt(t, x + 1, y - 1, z)
	setDirtAt(t, x, y - 1, z + 1)
	setDirtAt(t, x + 1, y - 1, z + 1)
	for (let i = 0; i < height; i += 1) {
		placeLog(t, x, y + i, z)
		if (i < height - 1) {
			placeLog(t, x + 1, y + i, z)
			placeLog(t, x + 1, y + i, z + 1)
			placeLog(t, x, y + i, z + 1)
		}
	}
	return [{ x, y: y + height, z, radiusOffset: 0, doubleTrunk: true }]
}

function placeTrunk(t: Tree, placer: Json, type: string, height: number, x: number, y: number, z: number): Attachment[] {
	const ctx = t.ctx
	const random = ctx.random
	const result: Attachment[] = []
	const single = (ax: number, ay: number, az: number, radiusOffset = 0): Attachment => ({ x: ax, y: ay, z: az, radiusOffset, doubleTrunk: false })
	switch (type) {
		case 'straight_trunk_placer': {
			setDirtAt(t, x, y - 1, z)
			for (let i = 0; i < height; i += 1) placeLog(t, x, y + i, z)
			return [single(x, y + height, z)]
		}
		case 'forking_trunk_placer': {
			setDirtAt(t, x, y - 1, z)
			const dir = HORIZONTAL[random.nextInt(4)]
			const bendAt = height - random.nextInt(4) - 1
			let bends = 3 - random.nextInt(3)
			let px = x
			let pz = z
			let top: number | undefined
			for (let m = 0; m < height; m += 1) {
				if (m >= bendAt && bends > 0) {
					px += STEP[dir][0]
					pz += STEP[dir][2]
					bends -= 1
				}
				if (placeLog(t, px, y + m, pz)) top = y + m + 1
			}
			if (top !== undefined) result.push(single(px, top, pz, 1))
			px = x
			pz = z
			const dir2 = HORIZONTAL[random.nextInt(4)]
			if (dir2 !== dir) {
				const start = bendAt - random.nextInt(2) - 1
				let length = 1 + random.nextInt(3)
				top = undefined
				for (let q = start; q < height && length > 0; length -= 1) {
					if (q >= 1) {
						px += STEP[dir2][0]
						pz += STEP[dir2][2]
						if (placeLog(t, px, y + q, pz)) top = y + q + 1
					}
					q += 1
				}
				if (top !== undefined) result.push(single(px, top, pz))
			}
			return result
		}
		case 'giant_trunk_placer':
			return giantTrunk(t, height, x, y, z)
		case 'mega_jungle_trunk_placer': {
			result.push(...giantTrunk(t, height, x, y, z))
			for (let i = height - 2 - random.nextInt(4); i > height / 2; i -= 2 + random.nextInt(4)) {
				const angle = random.nextFloat() * Math.PI * 2
				let j = 0
				let k = 0
				for (let l = 0; l < 5; l += 1) {
					j = Math.trunc(1.5 + Math.cos(angle) * l)
					k = Math.trunc(1.5 + Math.sin(angle) * l)
					placeLog(t, x + j, y + i - 3 + Math.trunc(l / 2), z + k)
				}
				result.push(single(x + j, y + i, z + k, -2))
			}
			return result
		}
		case 'dark_oak_trunk_placer': {
			setDirtAt(t, x, y - 1, z)
			setDirtAt(t, x + 1, y - 1, z)
			setDirtAt(t, x, y - 1, z + 1)
			setDirtAt(t, x + 1, y - 1, z + 1)
			const dir = HORIZONTAL[random.nextInt(4)]
			const bendAt = height - random.nextInt(4)
			let bends = 2 - random.nextInt(3)
			let px = x
			let pz = z
			const top = y + height - 1
			for (let q = 0; q < height; q += 1) {
				if (q >= bendAt && bends > 0) {
					px += STEP[dir][0]
					pz += STEP[dir][2]
					bends -= 1
				}
				const current = ctx.get(px, y + q, pz)
				if (isAir(current) || inTag(ctx, current, 'minecraft:leaves') || current.name.endsWith('_leaves')) {
					placeLog(t, px, y + q, pz)
					placeLog(t, px + 1, y + q, pz)
					placeLog(t, px, y + q, pz + 1)
					placeLog(t, px + 1, y + q, pz + 1)
				}
			}
			result.push({ x: px, y: top, z: pz, radiusOffset: 0, doubleTrunk: true })
			for (let q = -1; q <= 2; q += 1) {
				for (let r = -1; r <= 2; r += 1) {
					if ((q < 0 || q > 1 || r < 0 || r > 1) && random.nextInt(3) <= 0) {
						const length = random.nextInt(3) + 2
						for (let s = 0; s < length; s += 1) placeLog(t, x + q, top - s - 1, z + r)
						result.push(single(px + q, top, pz + r))
					}
				}
			}
			return result
		}
		case 'fancy_trunk_placer':
			return fancyTrunk(t, height, x, y, z)
		case 'bending_trunk_placer': {
			const dir = HORIZONTAL[random.nextInt(4)]
			const last = height - 1
			let px = x
			let py = y
			let pz = z
			setDirtAt(t, x, y - 1, z)
			const minForLeaves = int(placer.min_height_for_leaves, 1)
			for (let j = 0; j <= last; j += 1) {
				if (j + 1 >= last + random.nextInt(2)) {
					px += STEP[dir][0]
					pz += STEP[dir][2]
				}
				placeLog(t, px, py, pz)
				if (j >= minForLeaves) result.push(single(px, py, pz))
				py += 1
			}
			const bend = clamp(sampleInt(ctx, placer.bend_length, 1), 0, 32)
			for (let l = 0; l <= bend; l += 1) {
				placeLog(t, px, py, pz)
				result.push(single(px, py, pz))
				px += STEP[dir][0]
				pz += STEP[dir][2]
			}
			return result
		}
		case 'upwards_branching_trunk_placer': {
			const chance = num(placer.place_branch_per_log_probability, 0)
			for (let i = 0; i < height; i += 1) {
				const py = y + i
				if (placeLog(t, x, py, z) && i < height - 1 && random.nextFloat() < chance) {
					const dir = HORIZONTAL[random.nextInt(4)]
					const extra = sampleInt(ctx, placer.extra_branch_length, 0)
					const length = Math.max(0, extra - sampleInt(ctx, placer.extra_branch_length, 0) - 1)
					let steps = clamp(sampleInt(ctx, placer.extra_branch_steps, 1), 0, 64)
					let end = py + length
					let bx = x
					let bz = z
					for (let l = length; l < height && steps > 0; steps -= 1) {
						if (l >= 1) {
							const by = py + l
							bx += STEP[dir][0]
							bz += STEP[dir][2]
							end = by
							if (placeLog(t, bx, by, bz)) end = by + 1
							result.push(single(bx, by, bz))
						}
						l += 1
					}
					if (end - py > 1) {
						result.push(single(bx, end, bz))
						result.push(single(bx, end - 2, bz))
					}
				}
				if (i === height - 1) result.push(single(x, py + 1, z))
			}
			return result
		}
		case 'cherry_trunk_placer': {
			setDirtAt(t, x, y - 1, z)
			const [startMin, startMax] = intBounds(placer.branch_start_offset_from_top, [-4, -3])
			const first = Math.max(0, height - 1 + between(random, startMin, startMax))
			let second = Math.max(0, height - 1 + between(random, startMin, Math.max(startMin, startMax - 1)))
			if (second >= first) second += 1
			const count = sampleInt(ctx, placer.branch_count, 1)
			const three = count === 3
			const two = count >= 2
			const trunk = three ? height : two ? Math.max(first, second) + 1 : first + 1
			for (let m = 0; m < trunk; m += 1) placeLog(t, x, y + m, z)
			if (three) result.push(single(x, y + trunk, z))
			const branch = (dir: Dir, start: number, middle: boolean): Attachment => {
				let px = x
				let py = y + start
				let pz = z
				const endY = height - 1 + sampleInt(ctx, placer.branch_end_offset_from_top, 0)
				const longer = middle || endY < start
				const length = clamp(sampleInt(ctx, placer.branch_horizontal_length, 2), 0, 32) + (longer ? 1 : 0)
				const ex = x + STEP[dir][0] * length
				const ey = y + endY
				const ez = z + STEP[dir][2] * length
				for (let l = 0; l < (longer ? 2 : 1); l += 1) {
					px += STEP[dir][0]
					pz += STEP[dir][2]
					placeLog(t, px, py, pz, axisOf(dir))
				}
				const vertical = ey > py ? 1 : -1
				for (let guard = 0; guard < 256; guard += 1) {
					const dist = Math.abs(ex - px) + Math.abs(ey - py) + Math.abs(ez - pz)
					if (dist === 0) break
					if (random.nextFloat() < Math.abs(ey - py) / dist) {
						py += vertical
						placeLog(t, px, py, pz)
					} else {
						px += STEP[dir][0]
						pz += STEP[dir][2]
						placeLog(t, px, py, pz, axisOf(dir))
					}
				}
				return single(ex, ey + 1, ez)
			}
			const dir = HORIZONTAL[random.nextInt(4)]
			result.push(branch(dir, first, first < trunk - 1))
			if (two) result.push(branch(OPPOSITE[dir], second, second < trunk - 1))
			return result
		}
		case 'poplar_trunk_placer': {
			// The game's code for this one is not known here: a straight trunk with a few one block branches below the top
			setDirtAt(t, x, y - 1, z)
			for (let i = 0; i < height; i += 1) placeLog(t, x, y + i, z)
			const branches = clamp(sampleInt(ctx, placer.branch_amount, 0), 0, 16)
			let by = height - int(placer.trunk_height_above_branches, 4) - 1
			let dir = HORIZONTAL[random.nextInt(4)]
			for (let i = 0; i < branches && by >= 2; i += 1) {
				placeLog(t, x + STEP[dir][0], y + by, z + STEP[dir][2], axisOf(dir))
				dir = random.nextBoolean() ? CLOCKWISE[dir] : OPPOSITE[dir]
				by -= 1 + random.nextInt(2)
			}
			return [single(x, y + height, z)]
		}
		default:
			return []
	}
}

// Roots

function mangroveRoots(t: Tree, placer: Json, x: number, y: number, z: number, originY: number): boolean {
	const ctx = t.ctx
	const random = ctx.random
	const settings = obj(placer.mangrove_root_placement)
	const through = holderSet(ctx, settings.can_grow_through)
	const muddyIn = holderSet(ctx, settings.muddy_roots_in)
	const maxLength = clamp(int(settings.max_root_length, 15), 1, 64)
	const maxWidth = int(settings.max_root_width, 8)
	const skew = num(settings.random_skew_chance, 0.2)
	const canPlace = (px: number, py: number, pz: number) => {
		const block = ctx.get(px, py, pz)
		return isTreeReplaceable(block, ctx) || through(block.name)
	}
	for (let py = y; py < originY; py += 1) {
		if (!canPlace(x, py, z)) return false
	}
	const all: Pos[] = [[x, originY - 1, z]]
	const simulate = (px: number, py: number, pz: number, dir: Dir, found: Pos[], length: number): boolean => {
		if (length === maxLength || found.length > maxLength) return false
		const dist = Math.abs(px - x) + Math.abs(py - originY) + Math.abs(pz - z)
		const below: Pos = [px, py - 1, pz]
		const side: Pos = [px + STEP[dir][0], py, pz + STEP[dir][2]]
		let next: Pos[]
		if (dist > maxWidth - 3 && dist <= maxWidth) {
			next = random.nextFloat() < skew ? [below, [side[0], side[1] - 1, side[2]]] : [below]
		} else if (dist > maxWidth || random.nextFloat() < skew) {
			next = [below]
		} else {
			next = [random.nextBoolean() ? side : below]
		}
		for (const p of next) {
			if (!canPlace(p[0], p[1], p[2])) continue
			found.push(p)
			if (!simulate(p[0], p[1], p[2], dir, found, length + 1)) return false
		}
		return true
	}
	for (const dir of HORIZONTAL) {
		const sx = x + STEP[dir][0]
		const sz = z + STEP[dir][2]
		const found: Pos[] = []
		if (!simulate(sx, originY, sz, dir, found, 0)) return false
		all.push(...found, [sx, originY, sz])
	}
	const above = obj(placer.above_root_placement)
	for (const [px, py, pz] of all) {
		const current = ctx.get(px, py, pz)
		if (muddyIn(current.name)) {
			const muddy = provide(ctx, settings.muddy_roots_provider, px, py, pz)
			if (muddy !== undefined && ctx.set(px, py, pz, muddy)) t.roots.set(key(px, py, pz), [px, py, pz])
			continue
		}
		if (!canPlace(px, py, pz)) continue
		let state = provide(ctx, placer.root_provider, px, py, pz)
		if (state === undefined) continue
		if (state.properties.waterlogged !== undefined && isWater(current)) state = withProps(state, { waterlogged: 'true' })
		if (ctx.set(px, py, pz, state)) t.roots.set(key(px, py, pz), [px, py, pz])
		if (above.above_root_provider !== undefined && random.nextFloat() < num(above.above_root_placement_chance, 0) && isAir(ctx.get(px, py + 1, pz))) {
			const cover = provide(ctx, above.above_root_provider, px, py + 1, pz)
			if (cover !== undefined) ctx.set(px, py + 1, pz, cover)
		}
	}
	return true
}

// Decorators

const VINE_SIDE: Readonly<Record<string, string>> = { west: 'east', east: 'west', north: 'south', south: 'north' }

function vine(side: string): FBlock {
	return blk('vine', { east: 'false', north: 'false', south: 'false', west: 'false', up: 'false', [side]: 'true' })
}

function byHeight(positions: Map<string, Pos>): Pos[] {
	return [...positions.values()].sort((a, b) => a[1] - b[1])
}

/** The lowest logs or roots of a tree, which is where its ground is */
function lowestOf(logs: Pos[], roots: Pos[]): Pos[] {
	if (roots.length === 0) return logs
	if (logs.length > 0 && roots[0][1] === logs[0][1]) return [...logs, ...roots]
	return roots
}

function decorate(ctx: Ctx, decorator: unknown, logs: Pos[], leaves: Pos[], roots: Pos[]) {
	if (!isObj(decorator)) return
	const random = ctx.random
	const air = (x: number, y: number, z: number) => isAir(ctx.get(x, y, z))
	const type = shortId(decorator.type)
	const chance = num(decorator.probability, 1)
	switch (type) {
		case 'trunk_vine': {
			for (const [x, y, z] of logs) {
				for (const dir of ['west', 'east', 'north', 'south'] as Dir[]) {
					if (random.nextInt(3) === 0) continue
					const px = x + STEP[dir][0]
					const pz = z + STEP[dir][2]
					if (air(px, y, pz)) ctx.set(px, y, pz, vine(VINE_SIDE[dir]))
				}
			}
			return
		}
		case 'leave_vine': {
			for (const [x, y, z] of leaves) {
				for (const dir of ['west', 'east', 'north', 'south'] as Dir[]) {
					if (random.nextFloat() >= chance) continue
					const px = x + STEP[dir][0]
					const pz = z + STEP[dir][2]
					if (!air(px, y, pz)) continue
					ctx.set(px, y, pz, vine(VINE_SIDE[dir]))
					let py = y - 1
					for (let i = 4; i > 0 && air(px, py, pz); i -= 1) {
						ctx.set(px, py, pz, vine(VINE_SIDE[dir]))
						py -= 1
					}
				}
			}
			return
		}
		case 'cocoa': {
			if (random.nextFloat() >= chance || logs.length === 0) return
			const base = logs[0][1]
			for (const [x, y, z] of logs) {
				if (y - base > 2) continue
				for (const dir of HORIZONTAL) {
					if (random.nextFloat() > 0.25) continue
					const opposite = OPPOSITE[dir]
					const px = x + STEP[opposite][0]
					const pz = z + STEP[opposite][2]
					if (air(px, y, pz)) ctx.set(px, y, pz, blk('cocoa', { age: String(random.nextInt(3)), facing: dir }))
				}
			}
			return
		}
		case 'beehive': {
			if (random.nextFloat() >= chance || logs.length === 0) return
			const y = leaves.length > 0
				? Math.max(leaves[0][1] - 1, logs[0][1] + 1)
				: Math.min(logs[0][1] + 1 + random.nextInt(3), logs[logs.length - 1][1])
			const spots: Pos[] = []
			for (const log of logs) {
				if (log[1] !== y) continue
				for (const dir of ['west', 'east', 'south'] as Dir[]) spots.push([log[0] + STEP[dir][0], y, log[2] + STEP[dir][2]])
			}
			for (const [px, py, pz] of shuffled(random, spots)) {
				if (air(px, py, pz) && air(px, py, pz + 1)) {
					ctx.set(px, py, pz, blk('bee_nest', { facing: 'south', honey_level: '0' }))
					return
				}
			}
			return
		}
		case 'alter_ground': {
			const list2 = lowestOf(logs, roots)
			if (list2.length === 0) return
			const base = list2[0][1]
			// 26.3: the provider has rules that say which ground changes. 1.19: the ground has to be dirt.
			let resolved = decorator.provider
			if (typeof resolved === 'string') resolved = ctx.data.stateProvider(fullId(resolved))
			const hasRules = isObj(resolved) && Array.isArray(resolved.rules)
			const column = (x: number, y: number, z: number) => {
				for (let i = 2; i >= -3; i -= 1) {
					const block = ctx.get(x, y + i, z)
					if (hasRules || isDirt(block, ctx)) {
						const state = provide(ctx, decorator.provider, x, y + i, z)
						if (state !== undefined) {
							ctx.set(x, y + i, z, state)
							break
						}
						if (!hasRules) break
					}
					if (!isAir(block) && i < 0) break
				}
			}
			const circle = (x: number, y: number, z: number) => {
				for (let i = -2; i <= 2; i += 1) {
					for (let j = -2; j <= 2; j += 1) {
						if (Math.abs(i) !== 2 || Math.abs(j) !== 2) column(x + i, y, z + j)
					}
				}
			}
			for (const [x, y, z] of list2) {
				if (y !== base) continue
				circle(x - 1, y, z - 1)
				circle(x + 2, y, z - 1)
				circle(x - 1, y, z + 2)
				circle(x + 2, y, z + 2)
				for (let i = 0; i < 5; i += 1) {
					const roll = random.nextInt(64)
					const k = roll % 8
					const l = Math.floor(roll / 8)
					if (k === 0 || k === 7 || l === 0 || l === 7) circle(x - 3 + k, y, z - 3 + l)
				}
			}
			return
		}
		case 'attached_to_leaves':
		case 'attached_to_logs': {
			const onLeaves = type === 'attached_to_leaves'
			const directions = list(decorator.directions).map(d => dirOf(d, 'down'))
			if (directions.length === 0) return
			const exXZ = clamp(int(decorator.exclusion_radius_xz, 0), 0, 16)
			const exY = clamp(int(decorator.exclusion_radius_y, 0), 0, 16)
			const empty = int(decorator.required_empty_blocks, 1)
			const taken = new Set<string>()
			for (const [x, y, z] of shuffled(random, onLeaves ? leaves : logs)) {
				const dir = directions[random.nextInt(directions.length)]
				const px = x + STEP[dir][0]
				const py = y + STEP[dir][1]
				const pz = z + STEP[dir][2]
				if (!onLeaves) {
					if (random.nextFloat() <= chance && air(px, py, pz)) {
						const state = provide(ctx, decorator.block_provider, px, py, pz)
						if (state !== undefined) ctx.set(px, py, pz, state)
					}
					continue
				}
				if (taken.has(key(px, py, pz)) || random.nextFloat() >= chance) continue
				let free = true
				for (let i = 1; i <= empty; i += 1) {
					if (!air(x + STEP[dir][0] * i, y + STEP[dir][1] * i, z + STEP[dir][2] * i)) free = false
				}
				if (!free) continue
				for (let dx = -exXZ; dx <= exXZ; dx += 1) {
					for (let dy = -exY; dy <= exY; dy += 1) {
						for (let dz = -exXZ; dz <= exXZ; dz += 1) taken.add(key(px + dx, py + dy, pz + dz))
					}
				}
				const state = provide(ctx, decorator.block_provider, px, py, pz)
				if (state !== undefined) ctx.set(px, py, pz, state)
			}
			return
		}
		case 'place_on_ground': {
			const lowest = lowestOf(logs, roots)
			if (lowest.length === 0) return
			const base = lowest[0][1]
			const row = lowest.filter(p => p[1] === base)
			const radius = clamp(int(decorator.radius, 2), 0, 32)
			const height = clamp(int(decorator.height, 1), 0, 32)
			const minX = Math.min(...row.map(p => p[0])) - radius
			const maxX = Math.max(...row.map(p => p[0])) + radius
			const minZ = Math.min(...row.map(p => p[2])) - radius
			const maxZ = Math.max(...row.map(p => p[2])) + radius
			const tries = clamp(int(decorator.tries, 128), 0, 1024)
			for (let i = 0; i < tries; i += 1) {
				const x = between(random, minX, maxX)
				const y = between(random, base - height, base + height)
				const z = between(random, minZ, maxZ)
				const above = ctx.get(x, y + 1, z)
				if (!isAir(above) && !named(above, 'vine')) continue
				if (!isFullCube(ctx.get(x, y, z), ctx)) continue
				if (ctx.height('MOTION_BLOCKING_NO_LEAVES', x, z) > y + 1) continue
				const state = provide(ctx, decorator.block_state_provider, x, y + 1, z)
				if (state !== undefined) ctx.set(x, y + 1, z, state)
			}
			return
		}
		case 'pale_moss': {
			if (logs.length === 0) return
			const hanger = (x: number, y: number, z: number) => {
				let py = y
				while (air(x, py - 1, z) && random.nextFloat() >= 0.5) {
					ctx.set(x, py, z, blk('pale_hanging_moss', { tip: 'false' }))
					py -= 1
				}
				ctx.set(x, py, z, blk('pale_hanging_moss', { tip: 'true' }))
			}
			if (random.nextFloat() < num(decorator.ground_probability, 0)) {
				ctx.feature('minecraft:pale_moss_patch', logs[0][0], logs[0][1] + 1, logs[0][2])
			}
			for (const [x, y, z] of logs) {
				if (random.nextFloat() < num(decorator.trunk_probability, 0) && air(x, y - 1, z)) hanger(x, y - 1, z)
			}
			for (const [x, y, z] of leaves) {
				if (random.nextFloat() < num(decorator.leaves_probability, 0) && air(x, y - 1, z)) hanger(x, y - 1, z)
			}
			return
		}
		case 'creaking_heart': {
			if (random.nextFloat() >= chance) return
			for (const [x, y, z] of shuffled(random, logs)) {
				if (DIRECTIONS.every(dir => isLog(ctx.get(x + STEP[dir][0], y + STEP[dir][1], z + STEP[dir][2]), ctx))) {
					ctx.set(x, y, z, blk('creaking_heart', { axis: 'y', creaking_heart_state: 'dormant', natural: 'true' }))
					return
				}
			}
			return
		}
		case 'shelf_mushroom': {
			// The game's code for this one is not known here: a few shelf mushrooms on the sides of the logs
			if (random.nextFloat() >= chance) return
			let left = 1 + random.nextInt(3)
			for (const [x, y, z] of shuffled(random, logs)) {
				if (left <= 0) break
				const dir = HORIZONTAL[random.nextInt(4)]
				const px = x + STEP[dir][0]
				const pz = z + STEP[dir][2]
				if (!air(px, y, pz) || !isSturdy(ctx.get(x, y, z), dir, ctx)) continue
				ctx.set(px, y, pz, blk('shelf_mushroom', { age: String(random.nextInt(2)), facing: dir }))
				left -= 1
			}
			return
		}
		default:
			ctx.unsupportedType('tree decorator', type)
	}
}

function sizeAtHeight(size: Json, height: number, y: number): number {
	const limit = int(size.limit, 1)
	const lower = int(size.lower_size, 0)
	const upper = int(size.upper_size, 1)
	if (shortId(size.type) === 'three_layers_feature_size') {
		if (y < limit) return lower
		return y >= height - int(size.upper_limit, 1) ? upper : int(size.middle_size, 1)
	}
	return y < limit ? lower : upper
}

/** `minecraft:tree` */
export function tree(ctx: Ctx, config: Json, x: number, y: number, z: number): boolean {
	const trunkPlacer = obj(config.trunk_placer)
	const foliagePlacer = obj(config.foliage_placer)
	const trunkType = shortId(trunkPlacer.type)
	const foliageType = shortId(foliagePlacer.type)
	let known = true
	if (!TRUNK_PLACERS.includes(trunkType)) {
		ctx.unsupportedType('trunk placer', trunkType)
		known = false
	}
	if (!FOLIAGE_PLACERS.includes(foliageType)) {
		ctx.unsupportedType('foliage placer', foliageType)
		known = false
	}
	const rootPlacer = isObj(config.root_placer) ? config.root_placer : undefined
	if (rootPlacer !== undefined && !ROOT_PLACERS.includes(shortId(rootPlacer.type))) {
		ctx.unsupportedType('root placer', shortId(rootPlacer.type))
		known = false
	}
	if (!known) return false

	const t: Tree = { ctx, config, logs: new Map(), leaves: new Map(), roots: new Map() }
	if (trunkType === 'upwards_branching_trunk_placer') t.growThrough = holderSet(ctx, trunkPlacer.can_grow_through)

	const treeHeight = treeHeightOf(t, trunkPlacer)
	const foliageHeight = clamp(foliageHeightOf(t, foliagePlacer, foliageType, treeHeight), 0, MAX_HEIGHT)
	const trunkLength = treeHeight - foliageHeight
	let foliageRadius = sampleInt(ctx, foliagePlacer.radius, 0)
	if (foliageType === 'pine_foliage_placer') foliageRadius += ctx.random.nextInt(Math.max(trunkLength + 1, 1))
	foliageRadius = clamp(foliageRadius, 0, MAX_RADIUS)
	const originY = rootPlacer !== undefined ? y + clamp(sampleInt(ctx, rootPlacer.trunk_offset_y, 0), 0, 32) : y

	if (Math.min(y, originY) < ctx.minY + 1 || Math.max(y, originY) + treeHeight + 1 > ctx.maxY) return false

	const size = obj(config.minimum_size)
	const ignoreVines = bool(config.ignore_vines, false)
	let maxFree = treeHeight
	check: for (let dy = 0; dy <= treeHeight + 1; dy += 1) {
		const r = clamp(sizeAtHeight(size, treeHeight, dy), 0, 8)
		for (let dx = -r; dx <= r; dx += 1) {
			for (let dz = -r; dz <= r; dz += 1) {
				if (!trunkFree(t, x + dx, originY + dy, z + dz) || !ignoreVines && named(ctx.get(x + dx, originY + dy, z + dz), 'vine')) {
					maxFree = dy - 2
					break check
				}
			}
		}
	}
	const minClipped = typeof size.min_clipped_height === 'number' ? size.min_clipped_height : undefined
	if (maxFree < treeHeight && (minClipped === undefined || maxFree < minClipped)) return false

	if (rootPlacer !== undefined && !mangroveRoots(t, rootPlacer, x, y, z, originY)) return false
	const attachments = placeTrunk(t, trunkPlacer, trunkType, maxFree, x, originY, z)
	for (const attachment of attachments) {
		createFoliage(t, foliagePlacer, foliageType, attachment, foliageHeight, foliageRadius)
	}
	const placed = t.logs.size + t.leaves.size + t.roots.size > 0
	if (placed) {
		const logs = byHeight(t.logs)
		const leaves = byHeight(t.leaves)
		const roots = byHeight(t.roots)
		for (const decorator of list(config.decorators)) decorate(ctx, decorator, logs, leaves, roots)
	}
	return placed
}

/** `minecraft:fallen_tree` (26.3): a stump and a log that lies next to it */
export function fallenTree(ctx: Ctx, config: Json, x: number, y: number, z: number): boolean {
	const random = ctx.random
	const validPos = (px: number, py: number, pz: number) => isTreeReplaceable(ctx.get(px, py, pz), ctx)
	const overGround = (px: number, py: number, pz: number) => isSturdy(ctx.get(px, py - 1, pz), 'up', ctx)
	const logAt = (px: number, py: number, pz: number, axis: 'x' | 'y' | 'z') => {
		const state = provide(ctx, config.trunk_provider, px, py, pz)
		if (state === undefined) return false
		return ctx.set(px, py, pz, state.properties.axis !== undefined ? withProps(state, { axis }) : state)
	}
	let placed = false
	if (validPos(x, y, z) && logAt(x, y, z, 'y')) {
		placed = true
		for (const decorator of list(config.stump_decorators)) decorate(ctx, decorator, [[x, y, z]], [], [])
	}
	const dir = HORIZONTAL[random.nextInt(4)]
	const length = clamp(sampleInt(ctx, config.log_length, 5) - 2, 0, 64)
	const start = 2 + random.nextInt(2)
	const px = x + STEP[dir][0] * start
	const pz = z + STEP[dir][2] * start
	let py = y + 1
	let found = false
	for (let i = 0; i < 6; i += 1) {
		if (validPos(px, py, pz) && overGround(px, py, pz)) {
			found = true
			break
		}
		py -= 1
	}
	if (!found) return placed
	let gaps = 0
	for (let i = 0; i < length; i += 1) {
		const lx = px + STEP[dir][0] * i
		const lz = pz + STEP[dir][2] * i
		if (!validPos(lx, py, lz)) return placed
		if (!overGround(lx, py, lz)) {
			gaps += 1
			if (gaps > 2) return placed
		} else {
			gaps = 0
		}
	}
	const logs: Pos[] = []
	for (let i = 0; i < length; i += 1) {
		const lx = px + STEP[dir][0] * i
		const lz = pz + STEP[dir][2] * i
		if (logAt(lx, py, lz, axisOf(dir))) {
			logs.push([lx, py, lz])
			placed = true
		}
	}
	for (const decorator of list(config.log_decorators)) decorate(ctx, decorator, logs, [], [])
	return placed
}
