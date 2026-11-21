import type { Ctx, FBlock, FeatureData, FeatureWorld, HeightmapType } from './types.js'
import type { Dir } from './util.js'
import { fullId, HORIZONTAL, isObj, obj, OPPOSITE, STEP } from './util.js'

/** Something that knows the blocks of a tag. A context is one. */
export interface TagEnv {
	tag(id: string): ReadonlySet<string>
}

/** Looks up every tag only once */
export function tagEnv(data: FeatureData): TagEnv {
	const cache = new Map<string, ReadonlySet<string>>()
	const empty: ReadonlySet<string> = new Set()
	return {
		tag(id) {
			let result = cache.get(id)
			if (result === undefined) {
				const full = fullId(id.startsWith('#') ? id.slice(1) : id)
				try {
					result = data.blockTag(full) ?? empty
				} catch (e) {
					result = empty
				}
				cache.set(id, result)
			}
			return result
		},
	}
}

export function blk(name: string, properties: Record<string, string> = {}): FBlock {
	return { name: fullId(name), properties }
}

export const AIR: FBlock = blk('air')
export const WATER: FBlock = blk('water', { level: '0' })
export const LAVA: FBlock = blk('lava', { level: '0' })

const BLOCK_ID = /^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/

/** Reads a block state in either format: `"minecraft:stone"`, `{ id, properties }` or `{ Name, Properties }` */
export function parseBlock(value: unknown): FBlock | undefined {
	if (typeof value === 'string') {
		return BLOCK_ID.test(value) ? blk(value) : undefined
	}
	if (!isObj(value)) return undefined
	const name = value.Name ?? value.id ?? value.name
	if (typeof name !== 'string' || !BLOCK_ID.test(name)) return undefined
	const properties: Record<string, string> = {}
	for (const [k, v] of Object.entries(obj(value.Properties ?? value.properties))) {
		properties[k] = String(v)
	}
	return { name: fullId(name), properties }
}

export function withProps(block: FBlock, properties: Record<string, string>): FBlock {
	return { name: block.name, properties: { ...block.properties, ...properties } }
}

/** The name of a block without the `minecraft:` namespace */
export function short(block: FBlock): string {
	return block.name.startsWith('minecraft:') ? block.name.slice(10) : block.name
}

/** Whether a block has one of the names, which are given without namespace */
export function named(block: FBlock, ...names: string[]): boolean {
	return names.includes(short(block))
}

export function isAir(block: FBlock): boolean {
	return block.name === 'minecraft:air' || block.name === 'minecraft:cave_air' || block.name === 'minecraft:void_air'
}

export function isFluid(block: FBlock): boolean {
	return block.name === 'minecraft:water' || block.name === 'minecraft:lava'
}

const ALWAYS_IN_WATER = new Set(['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])

/** The fluid at a block: of a fluid block, or water of a waterlogged block */
export function fluidOf(block: FBlock): 'minecraft:water' | 'minecraft:lava' | 'minecraft:empty' {
	if (block.name === 'minecraft:water') return 'minecraft:water'
	if (block.name === 'minecraft:lava') return 'minecraft:lava'
	if (block.properties.waterlogged === 'true' || ALWAYS_IN_WATER.has(short(block))) return 'minecraft:water'
	return 'minecraft:empty'
}

export function isWater(block: FBlock) {
	return block.name === 'minecraft:water'
}

export function isLava(block: FBlock) {
	return block.name === 'minecraft:lava'
}

/** Whether there is nothing at a block but air */
export function isEmpty(block: FBlock) {
	return isAir(block)
}

const NON_SOLID_NAME = /(^|_)(air|sapling|button|rail|carpet|candle|torch|head|skull|tulip|orchid|bluet|daisy|mushroom|fungus|sprouts|grass|seagrass|fern|bush|shrub|vine|vines|plant|kelp|pickle|lichen|vein|fire|portal|gateway|lever|tripwire|hook|comparator|repeater|wire|wart|cocoa|ladder|scaffolding|cobweb|water|lava|column|void|propagule|dripleaf|blossom|eyeblossom|azalea|frogspawn|petals|wildflowers|litter|clump|moss|coral|fan|pad|cane|crop|flower|rose|peony|lilac|allium|poppy|dandelion|cornflower|valley|wheat|carrots|potatoes|beetroots|sunflower|torchflower)$/
const NON_SOLID = new Set(['light', 'snow', 'powder_snow', 'end_rod', 'big_dripleaf_stem', 'melon_stem', 'pumpkin_stem', 'attached_melon_stem', 'attached_pumpkin_stem', 'crimson_roots', 'warped_roots', 'hanging_roots', 'seagrass', 'tall_seagrass', 'flower_pot', 'grass'])

const solidNames = new Map<string, boolean>()

/** A guess from the name of a block, for when there is no tag to ask */
function solidByName(name: string): boolean {
	let solid = solidNames.get(name)
	if (solid === undefined) {
		const n = name.slice(name.indexOf(':') + 1)
		solid = !(NON_SOLID.has(n) || n.startsWith('potted_') || /(^|_)sign$/.test(n) && !n.includes('hanging') || NON_SOLID_NAME.test(n))
		if (solidNames.size < 10000) solidNames.set(name, solid)
	}
	return solid
}

/** Whether a block is in the way of movement. Asks the tag `blocks_motion` when the data has it (26.3), and guesses from the name otherwise. */
export function isSolidIn(block: FBlock, env: TagEnv): boolean {
	const motion = env.tag('minecraft:blocks_motion')
	if (motion.size > 0) return motion.has(block.name)
	return solidByName(block.name)
}

export function inTag(env: TagEnv, block: FBlock, tag: string): boolean {
	return env.tag(tag).has(block.name)
}

export function isLeaves(block: FBlock, env: TagEnv): boolean {
	return env.tag('minecraft:leaves').has(block.name) || block.name.endsWith('_leaves')
}

export function isLog(block: FBlock, env: TagEnv): boolean {
	return env.tag('minecraft:logs').has(block.name) || /_(log|stem|wood|hyphae)$/.test(block.name) && !block.name.endsWith('mushroom_stem') && !/(melon|pumpkin|dripleaf)_stem$/.test(block.name)
}

const DIRT_LIKE = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'mycelium', 'rooted_dirt', 'moss_block', 'pale_moss_block', 'mud', 'muddy_mangrove_roots'])

/** What the game calls dirt: the `dirt` tag of 1.19, which became `substrate_overworld` */
export function isDirt(block: FBlock, env: TagEnv): boolean {
	const substrate = env.tag('minecraft:substrate_overworld')
	if (substrate.size > 0) return substrate.has(block.name)
	const dirt = env.tag('minecraft:dirt')
	if (dirt.size > 3) return dirt.has(block.name)
	return DIRT_LIKE.has(short(block))
}

const BASE_STONE = new Set(['stone', 'granite', 'diorite', 'andesite', 'tuff', 'deepslate'])

export function isBaseStone(block: FBlock, env: TagEnv): boolean {
	const tag = env.tag('minecraft:base_stone_overworld')
	return tag.size > 0 ? tag.has(block.name) : BASE_STONE.has(short(block))
}

const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'grass', 'short_grass', 'fern', 'dead_bush', 'seagrass', 'tall_seagrass', 'fire', 'soul_fire', 'snow', 'vine', 'glow_lichen', 'light', 'tall_grass', 'large_fern', 'structure_void', 'bubble_column', 'warped_roots', 'nether_sprouts', 'crimson_roots', 'hanging_roots'])

/** Whether a block gives way when another is placed in it */
export function isReplaceable(block: FBlock, env: TagEnv): boolean {
	const tag = env.tag('minecraft:replaceable')
	if (tag.size > 0) return tag.has(block.name) || isAir(block)
	return REPLACEABLE.has(short(block))
}

const REPLACEABLE_PLANTS = new Set(['grass', 'short_grass', 'fern', 'dead_bush', 'vine', 'glow_lichen', 'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_grass', 'large_fern', 'hanging_roots', 'seagrass', 'tall_seagrass', 'water'])

/** Whether a tree can grow into a block: air, leaves, small plants and water */
export function isTreeReplaceable(block: FBlock, env: TagEnv): boolean {
	if (isAir(block)) return true
	const tag = env.tag('minecraft:replaceable_by_trees')
	if (tag.size > 0) return tag.has(block.name)
	if (isLeaves(block, env) || block.name === 'minecraft:water') return true
	const plants = env.tag('minecraft:replaceable_plants')
	return plants.size > 0 ? plants.has(block.name) : REPLACEABLE_PLANTS.has(short(block))
}

const PARTIAL_NAME = /(^|_)(fence|gate|wall|pane|bars|chain|door|trapdoor|bed|lantern|anvil|cactus|bamboo|dripstone|spike|chest|cake|bell|grindstone|lectern|stonecutter|stand|conduit|egg|campfire|cluster|bud|rod|sign|banner|plate|detector|pot|statue|cauldron|composter|frame|skull|head|shelf|core)$/

/** Whether a side of a block is a full face that other blocks can rest on or hang from. A guess from the name. */
export function isSturdy(block: FBlock, dir: Dir, env: TagEnv): boolean {
	if (!isSolidIn(block, env) || isLeaves(block, env)) return false
	const n = short(block)
	if (/(^|_)slab$/.test(n)) {
		const type = block.properties.type ?? 'bottom'
		return type === 'double' || (type === 'top' ? dir === 'up' : dir === 'down')
	}
	if (/(^|_)stairs$/.test(n)) {
		return (block.properties.half ?? 'bottom') === 'top' ? dir === 'up' : dir === 'down'
	}
	if (n === 'farmland' || n === 'dirt_path') return dir === 'down'
	if (n === 'hopper') return dir === 'up'
	if (n === 'enchanting_table') return dir === 'down'
	return !PARTIAL_NAME.test(n)
}

/** Whether a block is a whole cube that hides what is behind it */
export function isFullCube(block: FBlock, env: TagEnv): boolean {
	if (!isSturdy(block, 'up', env) || !isSturdy(block, 'down', env)) return false
	return !/(glass|ice|spawner|slime_block|honey_block)$/.test(block.name)
}

/** The y of the first block above the highest block that a heightmap counts in a column, or world.minY when there is none */
export function heightOf(world: FeatureWorld, env: TagEnv, type: HeightmapType, x: number, z: number): number {
	let counts: (block: FBlock) => boolean
	if (type === 'WORLD_SURFACE' || type === 'WORLD_SURFACE_WG') {
		counts = block => !isAir(block)
	} else if (type === 'OCEAN_FLOOR' || type === 'OCEAN_FLOOR_WG') {
		const motion = env.tag('minecraft:blocks_motion')
		counts = motion.size > 0 ? block => motion.has(block.name) : block => solidByName(block.name)
	} else {
		const noLeaves = type === 'MOTION_BLOCKING_NO_LEAVES'
		const tag = env.tag(noLeaves ? 'minecraft:blocks_motion_in_heightmap_no_leaves' : 'minecraft:blocks_motion_in_heightmap')
		if (tag.size > 0) {
			counts = block => tag.has(block.name) || fluidOf(block) !== 'minecraft:empty'
		} else {
			counts = block => (isSolidIn(block, env) || fluidOf(block) !== 'minecraft:empty') && !(noLeaves && isLeaves(block, env))
		}
	}
	for (let y = world.maxY - 1; y >= world.minY; y -= 1) {
		if (counts(world.getBlock(x, y, z))) return y + 1
	}
	return world.minY
}

const VEGETATION_NAME = /(^|_)(sapling|grass|fern|bush|shrub|tulip|orchid|bluet|daisy|petals|wildflowers|rose|peony|lilac|allium|poppy|dandelion|cornflower|valley|sunflower|torchflower|eyeblossom|plant|wheat|carrots|potatoes|beetroots|crop|stem)$/
const NETHER_PLANTS = new Set(['crimson_fungus', 'warped_fungus', 'crimson_roots', 'warped_roots', 'nether_sprouts'])
const NETHER_GROUND = new Set(['crimson_nylium', 'warped_nylium', 'mycelium', 'soul_soil'])

function anyTag(env: TagEnv, block: FBlock, ...tags: string[]): boolean {
	return tags.some(tag => env.tag(tag).has(block.name))
}

/** Whether a tag has blocks at all, so that the data can be asked instead of guessing */
function known(env: TagEnv, tag: string): boolean {
	return env.tag(tag).size > 0
}

/** Whether something opaque is above a position, which is as close to "dark enough for mushrooms" as this gets */
function isCovered(ctx: Ctx, x: number, y: number, z: number): boolean {
	for (let i = y + 1; i < ctx.maxY; i += 1) {
		const block = ctx.get(x, i, z)
		if (!isAir(block) && isFullCube(block, ctx)) return true
	}
	return false
}

/** Whether vegetation can grow on a block */
export function isPlantGround(block: FBlock, env: TagEnv): boolean {
	if (known(env, 'minecraft:supports_vegetation')) return inTag(env, block, 'minecraft:supports_vegetation')
	return isDirt(block, env) || block.name === 'minecraft:farmland'
}

/** An approximation of whether a block would stay where it is put: plants need their ground, vines something to hang from, and so on. Whole blocks always stay. */
export function canSurvive(ctx: Ctx, block: FBlock, x: number, y: number, z: number): boolean {
	const n = short(block)
	const below = ctx.get(x, y - 1, z)
	const above = () => ctx.get(x, y + 1, z)
	if (block.properties.half === 'upper') return below.name === block.name
	switch (n) {
		case 'cactus': {
			const ground = below.name === block.name || (known(ctx, 'minecraft:supports_cactus') ? inTag(ctx, below, 'minecraft:supports_cactus') : named(below, 'sand', 'red_sand'))
			if (!ground || fluidOf(above()) !== 'minecraft:empty') return false
			return HORIZONTAL.every(dir => {
				const side = ctx.get(x + STEP[dir][0], y, z + STEP[dir][2])
				return !isSolidIn(side, ctx) && !isLava(side)
			})
		}
		case 'sugar_cane': {
			if (below.name === block.name) return true
			const ground = known(ctx, 'minecraft:supports_sugar_cane') ? inTag(ctx, below, 'minecraft:supports_sugar_cane') : isDirt(below, ctx) || named(below, 'sand', 'red_sand')
			if (!ground) return false
			return HORIZONTAL.some(dir => {
				const side = ctx.get(x + STEP[dir][0], y - 1, z + STEP[dir][2])
				return fluidOf(side) === 'minecraft:water' || named(side, 'frosted_ice')
			})
		}
		case 'bamboo':
		case 'bamboo_sapling':
			if (known(ctx, 'minecraft:supports_bamboo')) return inTag(ctx, below, 'minecraft:supports_bamboo')
			if (known(ctx, 'minecraft:bamboo_plantable_on')) return inTag(ctx, below, 'minecraft:bamboo_plantable_on')
			return isDirt(below, ctx) || named(below, 'sand', 'red_sand', 'gravel', 'bamboo', 'bamboo_sapling')
		case 'dead_bush':
		case 'short_dry_grass':
		case 'tall_dry_grass':
			if (known(ctx, 'minecraft:supports_dry_vegetation')) return inTag(ctx, below, 'minecraft:supports_dry_vegetation')
			if (known(ctx, 'minecraft:dead_bush_may_place_on')) return inTag(ctx, below, 'minecraft:dead_bush_may_place_on')
			return isDirt(below, ctx) || named(below, 'sand', 'red_sand') || below.name.endsWith('terracotta')
		case 'brown_mushroom':
		case 'red_mushroom':
			if (anyTag(ctx, below, 'minecraft:overrides_mushroom_light_requirement', 'minecraft:mushroom_grow_block')) return true
			return isFullCube(below, ctx) && isCovered(ctx, x, y, z)
		case 'lily_pad':
			return (isWater(below) || anyTag(ctx, below, 'minecraft:supports_lily_pad') || named(below, 'ice', 'frosted_ice')) && fluidOf(ctx.get(x, y, z)) === 'minecraft:empty'
		case 'kelp':
		case 'kelp_plant':
			return named(below, 'kelp', 'kelp_plant') || isSturdy(below, 'up', ctx) && !named(below, 'magma_block')
		case 'seagrass':
		case 'tall_seagrass':
			return isSturdy(below, 'up', ctx) && !named(below, 'magma_block')
		case 'sea_pickle':
			return isSolidIn(below, ctx)
		case 'twisting_vines':
		case 'twisting_vines_plant':
			return named(below, 'twisting_vines', 'twisting_vines_plant') || isSturdy(below, 'up', ctx)
		case 'weeping_vines':
		case 'weeping_vines_plant':
			return named(above(), 'weeping_vines', 'weeping_vines_plant') || isSturdy(above(), 'down', ctx)
		case 'cave_vines':
		case 'cave_vines_plant':
			return named(above(), 'cave_vines', 'cave_vines_plant') || isSturdy(above(), 'down', ctx)
		case 'hanging_roots':
		case 'spore_blossom':
			return isSturdy(above(), 'down', ctx)
		case 'pale_hanging_moss':
			return named(above(), 'pale_hanging_moss') || isSturdy(above(), 'down', ctx)
		case 'vine':
			return named(above(), 'vine') || isSolidIn(above(), ctx) || HORIZONTAL.some(dir => isSturdy(ctx.get(x + STEP[dir][0], y, z + STEP[dir][2]), OPPOSITE[dir], ctx))
		case 'glow_lichen':
		case 'sculk_vein':
		case 'resin_clump':
			return (['down', 'up', 'north', 'south', 'west', 'east'] as Dir[]).some(dir => isSturdy(ctx.get(x + STEP[dir][0], y + STEP[dir][1], z + STEP[dir][2]), OPPOSITE[dir], ctx))
		case 'small_dripleaf': {
			if (anyTag(ctx, below, 'minecraft:supports_small_dripleaf', 'minecraft:small_dripleaf_placeable') || named(below, 'clay', 'moss_block')) return true
			return fluidOf(ctx.get(x, y, z)) === 'minecraft:water' && (isPlantGround(below, ctx) || anyTag(ctx, below, 'minecraft:supports_big_dripleaf'))
		}
		case 'big_dripleaf':
		case 'big_dripleaf_stem':
			if (named(below, 'big_dripleaf_stem')) return true
			if (known(ctx, 'minecraft:supports_big_dripleaf')) return inTag(ctx, below, 'minecraft:supports_big_dripleaf')
			if (known(ctx, 'minecraft:big_dripleaf_placeable')) return inTag(ctx, below, 'minecraft:big_dripleaf_placeable')
			return isDirt(below, ctx) || named(below, 'clay', 'farmland')
		case 'snow': {
			if (anyTag(ctx, below, 'minecraft:cannot_support_snow_layer', 'minecraft:snow_layer_cannot_survive_on') || named(below, 'ice', 'packed_ice', 'barrier')) return false
			if (anyTag(ctx, below, 'minecraft:support_override_snow_layer', 'minecraft:snow_layer_can_survive_on') || named(below, 'honey_block', 'soul_sand', 'mud')) return true
			return isSturdy(below, 'up', ctx) || isLeaves(below, ctx) || named(below, 'snow') && below.properties.layers === '8'
		}
		case 'mangrove_propagule':
			if (block.properties.hanging === 'true') return named(above(), 'mangrove_leaves')
			if (known(ctx, 'minecraft:supports_mangrove_propagule')) return inTag(ctx, below, 'minecraft:supports_mangrove_propagule')
			return isDirt(below, ctx) || named(below, 'clay', 'farmland')
		case 'azalea':
		case 'flowering_azalea':
			if (known(ctx, 'minecraft:supports_azalea')) return inTag(ctx, below, 'minecraft:supports_azalea')
			return isDirt(below, ctx) || named(below, 'clay', 'farmland')
		case 'nether_wart':
			return named(below, 'soul_sand')
		case 'wither_rose':
			if (known(ctx, 'minecraft:supports_wither_rose')) return inTag(ctx, below, 'minecraft:supports_wither_rose')
			return isPlantGround(below, ctx) || named(below, 'netherrack', 'soul_sand', 'soul_soil')
		case 'cactus_flower':
			return named(below, 'cactus', 'farmland') || isSturdy(below, 'up', ctx)
		case 'leaf_litter':
		case 'torch':
		case 'soul_torch':
		case 'redstone_torch':
			return isSturdy(below, 'up', ctx)
		case 'chorus_plant':
		case 'chorus_flower':
		case 'cocoa':
		case 'fire':
		case 'soul_fire':
		case 'pointed_dripstone':
		case 'sulfur_spike':
			return true
	}
	if (NETHER_PLANTS.has(n)) {
		if (known(ctx, `minecraft:supports_${n}`)) return inTag(ctx, below, `minecraft:supports_${n}`)
		return NETHER_GROUND.has(short(below)) || isPlantGround(below, ctx)
	}
	if (n.endsWith('_carpet')) return !isAir(below)
	if (isSolidIn(block, ctx)) return true
	// 26.3 has a tag for what most plants grow on
	if (block.name.startsWith('minecraft:') && known(ctx, `minecraft:supports_${n}`)) return inTag(ctx, below, `minecraft:supports_${n}`)
	if (VEGETATION_NAME.test(n) || anyTag(ctx, block, 'minecraft:flowers', 'minecraft:small_flowers', 'minecraft:saplings', 'minecraft:crops')) {
		return isPlantGround(below, ctx)
	}
	return true
}
