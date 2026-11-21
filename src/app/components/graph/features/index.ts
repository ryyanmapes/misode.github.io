/**
 * Generates Minecraft world generation features (trees, ores, patches, ...) into a block world, from the JSON of data packs.
 * Two formats are known: `legacy` is Minecraft 1.19.2 and `modern` is Minecraft 26.3. Every part reads both, so the format
 * only matters where the two disagree.
 *
 * The module is plain TypeScript without the DOM and without imports from the rest of the app, so it also runs in node.
 *
 * - `types.ts`: the public types, and the context that is passed around while a feature generates
 * - `random.ts`, `noise.ts`, `util.ts`: the random source, smooth noise and helpers for reading JSON
 * - `blocks.ts`: what is known about blocks (air, fluids, solid, sturdy, replaceable, where plants survive) and heightmaps
 * - `providers.ts`, `states.ts`, `predicates.ts`: int, float and height providers, block state providers, block predicates and rule tests
 * - `placement.ts`: the placement modifiers of placed features
 * - `tree.ts`, `basic.ts`, `plants.ts`, `terrain.ts`, `cave.ts`: the features
 */
import { blockColumn, blockPile, disk, fillLayer, noOp, ore, overlay, randomBooleanSelector, randomPatch, randomSelector, replaceSingleBlock, scatteredOre, sequence, simpleBlock, simpleRandomSelector, spring, weightedRandomSelector } from './basic.js'
import { AIR, heightOf, isSolidIn, tagEnv } from './blocks.js'
import { geode, largeDripstone, sculkPatch, speleothem, speleothemCluster } from './cave.js'
import { PLACEMENT_MODIFIERS, runModifiers } from './placement.js'
import { bamboo, chorusPlant, coralClaw, coralMushroom, coralTree, glowstoneBlob, hugeBrownMushroom, hugeFungus, hugeRedMushroom, kelp, multifaceGrowth, netherForestVegetation, randomNeighborSpread, rootSystem, seagrass, seaPickle, twistingVines, vegetationPatchFeature, vines, waterloggedVegetationPatch, weepingVines } from './plants.js'
import { basaltColumns, basaltPillar, blockBlob, blueIce, bonusChest, delta, desertWell, endGateway, endIsland, endPlatform, endPodium, endSpike, freezeTopLayer, iceberg, lake, monsterRoom, netherrackReplaceBlobs, projectedRandomPatchySquare, singleBlockPillar, spike, steppedColumnCluster, underwaterMagma, voidStartPlatform } from './terrain.js'
import { fallenTree, FOLIAGE_PLACERS, ROOT_PLACERS, tree, TREE_DECORATORS, TRUNK_PLACERS } from './tree.js'
import type { Ctx, FBlock, FeatureData, FeatureFn, FeatureRandom, FeatureWorld, HeightmapType, PlacedResult, PlaceResult, Pos } from './types.js'
import { configOf, fullId, isObj, shortId } from './util.js'

export { isAir, isFluid } from './blocks.js'
export { createRandom } from './random.js'
export type { FBlock, FeatureData, FeatureRandom, FeatureWorld, HeightmapType, PlacedResult, PlaceResult } from './types.js'

/** How deep features can be nested before the engine stops, which is what ends features that refer to themselves */
const MAX_DEPTH = 24
/** How many blocks one call may read and write */
const BUDGET = 24_000_000
/** What generating one feature takes from that, on top of its blocks */
const CALL_COST = 64

/** Every feature type that the engine can generate, without namespace */
const FEATURES: Readonly<Record<string, FeatureFn>> = {
	tree,
	fallen_tree: fallenTree,
	ore,
	scattered_ore: scatteredOre,
	simple_block: simpleBlock,
	block_column: blockColumn,
	block_pile: blockPile,
	disk,
	random_patch: randomPatch,
	flower: randomPatch,
	no_bonemeal_flower: randomPatch,
	random_selector: randomSelector,
	simple_random_selector: simpleRandomSelector,
	random_boolean_selector: randomBooleanSelector,
	weighted_random_selector: weightedRandomSelector,
	sequence,
	overlay,
	no_op: noOp,
	replace_single_block: replaceSingleBlock,
	fill_layer: fillLayer,
	spring_feature: spring,
	lake,
	forest_rock: blockBlob,
	block_blob: blockBlob,
	ice_spike: spike,
	spike,
	glowstone_blob: glowstoneBlob,
	random_neighbor_spread: randomNeighborSpread,
	vines,
	bamboo,
	huge_red_mushroom: hugeRedMushroom,
	huge_brown_mushroom: hugeBrownMushroom,
	huge_fungus: hugeFungus,
	nether_forest_vegetation: netherForestVegetation,
	twisting_vines: twistingVines,
	weeping_vines: weepingVines,
	netherrack_replace_blobs: netherrackReplaceBlobs,
	basalt_columns: basaltColumns,
	stepped_column_cluster: steppedColumnCluster,
	basalt_pillar: basaltPillar,
	single_block_pillar: singleBlockPillar,
	projected_random_patchy_square: projectedRandomPatchySquare,
	delta_feature: delta,
	vegetation_patch: vegetationPatchFeature,
	waterlogged_vegetation_patch: waterloggedVegetationPatch,
	seagrass,
	kelp,
	sea_pickle: seaPickle,
	multiface_growth: multifaceGrowth,
	freeze_top_layer: freezeTopLayer,
	blue_ice: blueIce,
	iceberg,
	underwater_magma: underwaterMagma,
	root_system: rootSystem,
	chorus_plant: chorusPlant,
	coral_tree: coralTree,
	coral_claw: coralClaw,
	coral_mushroom: coralMushroom,
	desert_well: desertWell,
	end_island: endIsland,
	end_spike: endSpike,
	end_platform: endPlatform,
	void_start_platform: voidStartPlatform,
	end_gateway: endGateway,
	end_podium: endPodium,
	bonus_chest: bonusChest,
	monster_room: monsterRoom,
	pointed_dripstone: speleothem,
	speleothem,
	dripstone_cluster: speleothemCluster,
	speleothem_cluster: speleothemCluster,
	large_dripstone: largeDripstone,
	geode,
	sculk_patch: sculkPatch,
}

/** The feature types of the two versions, as their registries list them */
const FEATURE_TYPES = {
	legacy: 'bamboo basalt_columns basalt_pillar block_column block_pile blue_ice bonus_chest chorus_plant coral_claw coral_mushroom coral_tree delta_feature desert_well disk dripstone_cluster end_gateway end_island end_spike fill_layer flower forest_rock fossil freeze_top_layer geode glowstone_blob huge_brown_mushroom huge_fungus huge_red_mushroom ice_spike iceberg kelp lake large_dripstone monster_room multiface_growth nether_forest_vegetation netherrack_replace_blobs no_bonemeal_flower no_op ore pointed_dripstone random_boolean_selector random_patch random_selector replace_single_block root_system scattered_ore sculk_patch sea_pickle seagrass simple_block simple_random_selector spring_feature tree twisting_vines underwater_magma vegetation_patch vines void_start_platform waterlogged_vegetation_patch weeping_vines',
	modern: 'bamboo block_blob block_column block_pile blue_ice bonus_chest chorus_plant coral_claw coral_tree delta_feature disk end_gateway end_island end_platform end_podium end_spike fallen_tree fill_layer fossil freeze_top_layer geode huge_brown_mushroom huge_fungus huge_red_mushroom iceberg lake large_dripstone monster_room multiface_growth netherrack_replace_blobs no_op ore overlay projected_random_patchy_square random_boolean_selector random_neighbor_spread random_selector replace_single_block root_system scattered_ore sculk_patch sequence simple_block simple_random_selector single_block_pillar speleothem speleothem_cluster spike spring_feature stepped_column_cluster template tree underwater_magma vegetation_patch vines void_start_platform waterlogged_vegetation_patch weighted_random_selector',
}

class BudgetError extends Error {}

let lastError: unknown

/**
 * What went wrong inside of the last call that caught something, and forgets it: an error, or the text "budget" when a call was
 * stopped because it read and wrote too many blocks. Undefined when nothing went wrong. For finding out why something places nothing.
 */
export function takeLastError(): unknown {
	const error = lastError
	lastError = undefined
	return error
}

function remember(error: unknown) {
	lastError = error instanceof BudgetError ? 'budget' : error
}

function createContext(world: FeatureWorld, random: FeatureRandom, data: FeatureData): Ctx {
	const env = tagEnv(data)
	const minY = world.minY
	const maxY = world.maxY

	function lookup(kind: 'feature' | 'placed', id: string): unknown {
		try {
			return kind === 'feature' ? data.feature(fullId(id)) : data.placed(fullId(id))
		} catch (e) {
			return undefined
		}
	}

	/** Takes from the budget for something that is not a block, so that features that refer to themselves many times over end as well */
	function charge(cost: number) {
		ctx.budget -= cost
		if (ctx.budget < 0) throw new BudgetError()
	}

	/** Runs an inline placed feature from a position */
	function placedAt(placed: Record<string, unknown>, x: number, y: number, z: number): boolean {
		if (ctx.depth >= MAX_DEPTH) return false
		charge(CALL_COST)
		ctx.depth += 1
		try {
			let any = false
			for (const [px, py, pz] of runModifiers(ctx, placed.placement, x, y, z)) {
				if (ctx.feature(placed.feature, px, py, pz)) any = true
			}
			return any
		} finally {
			ctx.depth -= 1
		}
	}

	// The heights of columns, which features ask for a lot, until a block of the column changes
	const heights = new Map<string, Map<number, number>>()
	const columnKey = (x: number, z: number) => (x + 30000000) * 60000001 + z + 30000000

	const ctx: Ctx = {
		world,
		random,
		data,
		modern: data.format === 'modern',
		minY,
		maxY,
		unsupported: new Set(),
		depth: 0,
		placed: 0,
		budget: BUDGET,
		tag: id => env.tag(id),
		get(x, y, z) {
			ctx.budget -= 1
			if (ctx.budget < 0) throw new BudgetError()
			if (y < minY || y >= maxY) return AIR
			return world.getBlock(x, y, z) ?? AIR
		},
		set(x, y, z, block) {
			ctx.budget -= 1
			if (ctx.budget < 0) throw new BudgetError()
			if (y < minY || y >= maxY) return false
			if (!world.setBlock(x, y, z, block)) return false
			ctx.placed += 1
			if (heights.size > 0) {
				const column = columnKey(x, z)
				for (const map of heights.values()) map.delete(column)
			}
			return true
		},
		height(type, x, z) {
			const kind = type.endsWith('_WG') ? type.slice(0, -3) : type
			let map = heights.get(kind)
			if (map === undefined) {
				map = new Map()
				heights.set(kind, map)
			}
			const column = columnKey(x, z)
			let height = map.get(column)
			if (height === undefined) {
				height = heightOf(world, env, type, x, z)
				if (map.size < 100000) map.set(column, height)
			}
			return height
		},
		outside: y => y < minY || y >= maxY,
		unsupportedType(kind, type) {
			ctx.unsupported.add(`${kind} ${type === '' ? '(no type)' : fullId(type)}`)
		},
		feature(ref, x, y, z) {
			if (ctx.depth >= MAX_DEPTH) return false
			charge(CALL_COST)
			let json = ref
			if (typeof ref === 'string') {
				json = lookup('feature', ref)
				if (!isObj(json)) {
					const placed = lookup('placed', ref)
					return isObj(placed) ? placedAt(placed, x, y, z) : false
				}
			}
			if (!isObj(json)) return false
			if (typeof json.type !== 'string') {
				return json.feature !== undefined ? placedAt(json, x, y, z) : false
			}
			const type = shortId(json.type)
			const generate = FEATURES[type]
			if (generate === undefined || !Object.prototype.hasOwnProperty.call(FEATURES, type)) {
				ctx.unsupportedType('feature', type)
				return false
			}
			ctx.depth += 1
			try {
				return generate(ctx, configOf(json), x, y, z)
			} finally {
				ctx.depth -= 1
			}
		},
		nested(ref, x, y, z) {
			if (typeof ref === 'string') {
				// The game means a placed feature here; 26.3 has features and placed features with the same id
				const placed = lookup('placed', ref)
				return isObj(placed) ? placedAt(placed, x, y, z) : ctx.feature(ref, x, y, z)
			}
			if (!isObj(ref)) return false
			if (typeof ref.type === 'string') return ctx.feature(ref, x, y, z)
			return ref.feature !== undefined ? placedAt(ref, x, y, z) : false
		},
		positions: (modifiers, x, y, z) => runModifiers(ctx, modifiers, x, y, z),
	}
	return ctx
}

function whole(value: number) {
	return Number.isFinite(value) ? Math.floor(value) : 0
}

/** Generates a configured feature / feature at a position. `feature` is its JSON, or an id that `data.feature` knows. Never throws: bad JSON places nothing. */
export function placeFeature(feature: unknown, world: FeatureWorld, random: FeatureRandom, x: number, y: number, z: number, data: FeatureData): PlaceResult {
	let ctx: Ctx | undefined
	try {
		ctx = createContext(world, random, data)
		ctx.feature(feature, whole(x), whole(y), whole(z))
	} catch (e) {
		// Broken JSON, a world that throws, or the budget ran out: what was placed so far stays
		remember(e)
	}
	return { placed: ctx !== undefined && ctx.placed > 0, unsupported: ctx === undefined ? [] : [...ctx.unsupported] }
}

/**
 * Runs a placed feature for one chunk, the way the game decorates a chunk: the placement modifiers start at the lowest corner of the chunk
 * (chunkX * 16, world.minY, chunkZ * 16) and the feature is generated at every position that is left. `placed` is its JSON, or an id that
 * `data.placed` knows. With `onlyPositions` the feature itself is not generated. Never throws.
 */
export function placePlacedFeature(placed: unknown, world: FeatureWorld, random: FeatureRandom, chunkX: number, chunkZ: number, data: FeatureData, onlyPositions?: boolean): PlacedResult {
	let ctx: Ctx | undefined
	let positions: Pos[] = []
	try {
		ctx = createContext(world, random, data)
		const json = typeof placed === 'string' ? data.placed(fullId(placed)) : placed
		if (isObj(json)) {
			positions = ctx.positions(json.placement, whole(chunkX) * 16, world.minY, whole(chunkZ) * 16)
			if (onlyPositions !== true) {
				for (const [x, y, z] of positions) ctx.feature(json.feature, x, y, z)
			}
		}
	} catch (e) {
		// See placeFeature
		remember(e)
	}
	return { placed: ctx !== undefined && ctx.placed > 0, unsupported: ctx === undefined ? [] : [...ctx.unsupported], positions }
}

/** The y of the first block above the highest block that a heightmap counts in a column, or world.minY when there is none */
export function heightAt(world: FeatureWorld, type: HeightmapType, x: number, z: number, data: FeatureData): number {
	try {
		return heightOf(world, tagEnv(data), type, whole(x), whole(z))
	} catch (e) {
		return world.minY
	}
}

/**
 * Whether a block is in the way of movement, which is what OCEAN_FLOOR and MOTION_BLOCKING heightmaps and "solid" predicates look at.
 * With 26.3 data this is the block tag `minecraft:blocks_motion`; without that tag it is a guess from the name of the block.
 */
export function isSolid(block: FBlock, data: FeatureData): boolean {
	try {
		return isSolidIn(block, tagEnv(data))
	} catch (e) {
		return false
	}
}

/** The feature types that the engine can generate for a format, with namespace, for showing in the UI */
export function supportedFeatureTypes(format: 'modern' | 'legacy'): string[] {
	return FEATURE_TYPES[format].split(' ').filter(type => Object.prototype.hasOwnProperty.call(FEATURES, type)).map(type => `minecraft:${type}`)
}

/** The other things that the engine knows, with namespace, for showing in the UI */
export function supportedParts(): { placementModifiers: string[], trunkPlacers: string[], foliagePlacers: string[], rootPlacers: string[], treeDecorators: string[] } {
	const full = (types: string[]) => types.map(type => `minecraft:${type}`)
	return {
		placementModifiers: full(PLACEMENT_MODIFIERS),
		trunkPlacers: full(TRUNK_PLACERS),
		foliagePlacers: full(FOLIAGE_PLACERS),
		rootPlacers: full(ROOT_PLACERS),
		treeDecorators: full(TREE_DECORATORS),
	}
}
