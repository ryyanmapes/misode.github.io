import { fetchAllPresets } from '../../../services/index.js'
import type { FBlock, FeatureData, FeatureWorld } from '../features/index.js'
import { createRandom, placeFeature, placePlacedFeature } from '../features/index.js'
import type { Own } from '../items.js'
import { fullId } from '../items.js'
import type { GraphVersion } from '../presets.js'
import type { Carving } from './carve.js'
import type { SliceDecorator, SliceVolume } from './slice.js'
import { WorldSlice } from './slice.js'
import type { VolumeBlock } from '../worldgen.js'

/** What the game has that features refer to by id */
export interface VanillaFeatures {
	features: Map<string, unknown>
	placed: Map<string, unknown>
	carvers: Map<string, unknown>
	providers: Map<string, unknown>
	/** The blocks of every block tag, with the tags inside of tags already followed */
	tags: Map<string, Set<string>>
}

const vanilla = new Map<string, Promise<VanillaFeatures>>()

function withNamespace(entries: Map<string, unknown>) {
	return new Map([...entries].map(([id, json]) => [fullId(id), json]))
}

/** Downloads the features, placed features, carvers and block tags of a version of the game, once */
export function loadVanillaFeatures(version: GraphVersion): Promise<VanillaFeatures> {
	let result = vanilla.get(version.id)
	if (!result) {
		result = (async () => {
			const [features, placed, carvers, providers, rawTags] = await Promise.all([
				fetchAllPresets(version.id, version.format === 'modern' ? 'worldgen/feature' : 'worldgen/configured_feature'),
				fetchAllPresets(version.id, 'worldgen/placed_feature'),
				fetchAllPresets(version.id, version.format === 'modern' ? 'worldgen/carver' : 'worldgen/configured_carver').catch(() => new Map<string, unknown>()),
				// Only 26.3 has block state providers with an id
				version.format === 'modern' ? fetchAllPresets(version.id, 'worldgen/block_state_provider').catch(() => new Map<string, unknown>()) : new Map<string, unknown>(),
				fetchAllPresets(version.id, 'tag/block').catch(() => new Map<string, unknown>()),
			])
			const tags = new Map<string, Set<string>>()
			const resolve = (id: string, seen: string[]): Set<string> => {
				const known = tags.get(id)
				if (known) return known
				const blocks = new Set<string>()
				const tag = rawTags.get(id.replace(/^minecraft:/, '')) as { values?: unknown[] } | undefined
				for (const entry of Array.isArray(tag?.values) ? tag!.values! : []) {
					const value = typeof entry === 'string' ? entry : typeof (entry as { id?: unknown })?.id === 'string' ? (entry as { id: string }).id : undefined
					if (value === undefined) continue
					if (!value.startsWith('#')) {
						blocks.add(fullId(value))
					} else if (!seen.includes(value)) {
						for (const block of resolve(fullId(value.slice(1)), [...seen, value])) blocks.add(block)
					}
				}
				if (seen.length === 0) tags.set(id, blocks)
				return blocks
			}
			for (const id of rawTags.keys()) resolve(fullId(id), [])
			return { features: withNamespace(features), placed: withNamespace(placed), carvers: withNamespace(carvers), providers: withNamespace(providers), tags }
		})()
		result.catch(() => vanilla.delete(version.id))
		vanilla.set(version.id, result)
	}
	return result
}

const NO_BLOCKS: ReadonlySet<string> = new Set()

/** What features can refer to in a dimension: its own features, placed features and carvers first, then those of the game. The temperature is the one of its biome. */
export function featureDataOf(version: GraphVersion, game: VanillaFeatures, own: Pick<Own, 'features' | 'placers' | 'carvers'>, temperature?: number): FeatureData {
	return {
		format: version.format,
		temperature,
		feature: id => own.features[fullId(id)] ?? game.features.get(fullId(id)),
		placed: id => own.placers[fullId(id)] ?? game.placed.get(fullId(id)),
		carver: id => own.carvers[fullId(id)] ?? game.carvers.get(fullId(id)),
		stateProvider: id => game.providers.get(fullId(id)),
		blockTag: id => game.tags.get(fullId(id.replace(/^#/, ''))) ?? NO_BLOCKS,
	}
}

const AIR: FBlock = { name: 'minecraft:air', properties: {} }

/** Lets features read and change the blocks of a slice */
export class SliceFeatureWorld implements FeatureWorld {
	readonly minY: number
	readonly maxY: number
	/** Which part of the decoration is placing blocks now, from 1 on */
	part = 1
	/** How many blocks were placed so far */
	placed = 0
	private readonly blocks: FBlock[] = [AIR]
	private readonly indices = new Map<FBlock, number>()

	constructor(private readonly slice: WorldSlice, readonly seaLevel: number) {
		this.minY = slice.minY
		this.maxY = slice.minY + slice.height
	}

	getBlock(x: number, y: number, z: number): FBlock {
		const index = this.slice.blockAt(x, y, z)
		let block = this.blocks[index]
		if (!block) {
			const kind: VolumeBlock = this.slice.volume.palette[index]
			block = { name: kind.name, properties: kind.properties }
			this.blocks[index] = block
		}
		return block
	}

	setBlock(x: number, y: number, z: number, block: FBlock): boolean {
		let index = this.indices.get(block)
		if (index === undefined) {
			index = this.slice.volume.indexOf(fullId(block.name), { ...block.properties })
			this.indices.set(block, index)
		}
		if (!this.slice.place(x, y, z, index, this.part)) return false
		this.placed += 1
		return true
	}

	isLoaded(x: number, z: number): boolean {
		return this.slice.contains(x, z)
	}
}

/** A number that differs for every chunk and every thing that is placed in it, from one seed */
function mix(seed: bigint, chunkX: number, chunkZ: number, index: number) {
	const value = BigInt.asIntN(64, seed * BigInt(6364136223846793005) + BigInt(chunkX) * BigInt(341873128712) + BigInt(chunkZ) * BigInt(132897987541) + BigInt(index) * BigInt(2654435761))
	return value
}

/** Where a placed feature ended up, and which one of the list it was */
export interface PlacedPosition {
	x: number
	y: number
	z: number
	placer: number
}

/**
 * Places placed features in every chunk of a slice, the way the game decorates chunks. With carvers,
 * those cut the whole slice first, as the game carves before it places features. The blocks remember
 * what changed them: the carvers are the first parts, and the placed features come after them.
 */
export class PlacerDecorator implements SliceDecorator {
	/** The positions that the placement gave, before the features ran there */
	readonly positions: PlacedPosition[] = []
	/** What was met that cannot be generated here */
	readonly unsupported = new Set<string>()
	/** In how many chunks each placed feature of the list placed at least one block */
	readonly placedBy: number[]
	/** How many blocks each placed feature of the list placed */
	readonly blocksBy: number[]
	private world: SliceFeatureWorld | undefined

	/** The part of the decoration that the first placed feature is. The carvers are the parts before it. */
	readonly firstPart: number

	/** `placers` are the JSON of placed features, or their ids */
	constructor(private readonly placers: unknown[], private readonly data: FeatureData, private readonly seed: bigint, private readonly seaLevel: number, readonly carving?: Carving) {
		this.placedBy = placers.map(() => 0)
		this.blocksBy = placers.map(() => 0)
		this.firstPart = (carving?.count ?? 0) + 1
	}

	decorate(slice: WorldSlice, chunkX: number, chunkZ: number) {
		// Does nothing after the first time
		this.carving?.run(slice)
		const world = this.world ??= new SliceFeatureWorld(slice, this.seaLevel)
		this.placers.forEach((placer, index) => {
			// The blocks remember which placed feature they came from, so one of them can be outlined
			world.part = Math.min(255, this.firstPart + index)
			const before = world.placed
			const result = placePlacedFeature(placer, world, createRandom(mix(this.seed, chunkX, chunkZ, index)), chunkX, chunkZ, this.data)
			this.blocksBy[index] += world.placed - before
			for (const [x, y, z] of result.positions) this.positions.push({ x, y, z, placer: index })
			for (const reason of result.unsupported) this.unsupported.add(reason)
			if (result.placed) this.placedBy[index] += 1
		})
	}
}

/** Generates one feature at one position of a slice */
export class FeatureDecorator implements SliceDecorator {
	readonly unsupported = new Set<string>()
	placed: boolean | undefined
	private done = false

	constructor(private readonly feature: unknown, private readonly data: FeatureData, private readonly seed: bigint, private readonly seaLevel: number, private readonly origin: [number, number, number]) {}

	decorate(slice: WorldSlice) {
		if (this.done) return
		this.done = true
		const result = placeFeature(this.feature, new SliceFeatureWorld(slice, this.seaLevel), createRandom(this.seed), this.origin[0], this.origin[1], this.origin[2], this.data)
		this.placed = result.placed
		for (const reason of result.unsupported) this.unsupported.add(reason)
	}
}

/** Where a single feature is shown: on the ground, inside of it, under water, or between a floor and a ceiling */
export type StageScene = 'ground' | 'inside' | 'water' | 'cave'

export const STAGE_SCENES: { value: StageScene, label: string }[] = [
	{ value: 'ground', label: 'On the ground' },
	{ value: 'inside', label: 'Inside the ground' },
	{ value: 'water', label: 'Under water' },
	{ value: 'cave', label: 'In a cave' },
]

/** A scene and the block that its ground is made of */
export interface Stage {
	scene: StageScene
	ground: string
}

const GRASS = 'minecraft:grass_block'

/** The block that the ground of a scene is made of when none is chosen */
export function defaultGround(scene: StageScene) {
	return scene === 'ground' ? GRASS : scene === 'water' ? 'minecraft:sand' : 'minecraft:stone'
}

const STAGE_MIN_Y = 48
const STAGE_HEIGHT = 80
/** The first open height above the ground of a stage */
const STAGE_SURFACE = 64
const STAGE_CHUNKS = 3

const UNDERGROUND = ['ore', 'scattered_ore', 'geode', 'underwater_magma', 'monster_room', 'fossil']
const UNDERWATER = ['seagrass', 'kelp', 'sea_pickle', 'coral_claw', 'coral_tree', 'coral_mushroom']
const NETHER = ['huge_fungus', 'nether_forest_vegetation', 'twisting_vines', 'weeping_vines', 'glowstone_blob', 'basalt_columns', 'basalt_pillar', 'delta_feature', 'netherrack_replace_blobs']
const END = ['end_island', 'end_spike', 'end_platform', 'end_podium', 'end_gateway', 'chorus_plant', 'void_start_platform']
const CAVE = ['dripstone_cluster', 'large_dripstone', 'pointed_dripstone', 'speleothem', 'speleothem_cluster', 'sculk_patch', 'vegetation_patch', 'waterlogged_vegetation_patch', 'root_system', 'multiface_growth']

/** The stage that suits a feature, going by its type alone */
export function stageFor(feature: unknown): Stage {
	const type = typeof (feature as { type?: unknown })?.type === 'string' ? (feature as { type: string }).type.replace(/^minecraft:/, '') : ''
	if (UNDERGROUND.includes(type)) return { scene: 'inside', ground: 'minecraft:stone' }
	if (UNDERWATER.includes(type)) return { scene: 'water', ground: 'minecraft:sand' }
	if (NETHER.includes(type)) return { scene: 'cave', ground: 'minecraft:netherrack' }
	if (END.includes(type)) return { scene: 'ground', ground: 'minecraft:end_stone' }
	if (CAVE.includes(type)) return { scene: 'cave', ground: 'minecraft:stone' }
	return { scene: 'ground', ground: GRASS }
}

/** The stages that are tried, in this order, to find one where a feature places something */
const STAGES_TO_TRY: Stage[] = [
	{ scene: 'ground', ground: GRASS },
	{ scene: 'water', ground: 'minecraft:sand' },
	{ scene: 'cave', ground: 'minecraft:stone' },
	{ scene: 'cave', ground: 'minecraft:netherrack' },
	{ scene: 'inside', ground: 'minecraft:stone' },
	{ scene: 'ground', ground: 'minecraft:snow_block' },
	{ scene: 'ground', ground: 'minecraft:sand' },
	{ scene: 'ground', ground: 'minecraft:crimson_nylium' },
	{ scene: 'ground', ground: 'minecraft:warped_nylium' },
	{ scene: 'ground', ground: 'minecraft:soul_sand' },
	{ scene: 'ground', ground: 'minecraft:end_stone' },
	{ scene: 'ground', ground: 'minecraft:netherrack' },
	{ scene: 'ground', ground: 'minecraft:mud' },
	{ scene: 'ground', ground: 'minecraft:moss_block' },
	{ scene: 'ground', ground: 'minecraft:stone' },
	{ scene: 'water', ground: 'minecraft:gravel' },
	{ scene: 'cave', ground: 'minecraft:dripstone_block' },
	{ scene: 'cave', ground: 'minecraft:deepslate' },
	{ scene: 'inside', ground: 'minecraft:deepslate' },
	{ scene: 'inside', ground: 'minecraft:netherrack' },
]

/** A small piece of ground to show a single feature on */
export class StageVolume implements SliceVolume {
	readonly minY = STAGE_MIN_Y
	readonly height = STAGE_HEIGHT
	readonly palette: VolumeBlock[] = [{ name: 'minecraft:air', properties: {}, fluid: false }]
	/** The level of the sea, which only the stage under water has */
	readonly seaLevel: number
	/** Where a feature is generated: in the middle, on the ground or inside of it */
	readonly origin: [number, number, number]
	/** The blocks of every column, as indices in the palette */
	readonly column: Uint16Array
	private readonly keys = new Map<string, number>([['minecraft:air', 0]])

	constructor(readonly stage: Stage) {
		const { scene, ground } = stage
		const column = new Uint16Array(STAGE_HEIGHT)
		const fill = (name: string, from: number, to: number) => {
			const index = this.indexOf(name, {})
			for (let y = from; y <= to; y += 1) column[y - STAGE_MIN_Y] = index
		}
		let surface = STAGE_SURFACE
		this.seaLevel = STAGE_MIN_Y
		if (scene === 'ground') {
			fill('minecraft:stone', 48, 59)
			// Grass grows on dirt. Any other ground is a few blocks deep itself.
			fill(ground === GRASS ? 'minecraft:dirt' : ground, 60, 62)
			fill(ground, 63, 63)
		} else if (scene === 'inside') {
			fill(ground, 48, 111)
			surface = 80
		} else if (scene === 'water') {
			fill('minecraft:stone', 48, 52)
			fill(ground, 53, 55)
			fill('minecraft:water', 56, 62)
			this.seaLevel = 63
			surface = 56
		} else {
			fill(ground, 48, 63)
			fill(ground, 80, 95)
		}
		this.column = column
		this.origin = [8, surface, 8]
	}

	indexOf(name: string, properties: Record<string, string>): number {
		const names = Object.keys(properties).sort()
		const key = names.length === 0 ? name : `${name}[${names.map(k => `${k}=${properties[k]}`).join(',')}]`
		let index = this.keys.get(key)
		if (index === undefined) {
			index = this.palette.length
			this.palette.push({ name, properties: { ...properties }, fluid: name === 'minecraft:water' || name === 'minecraft:lava' })
			this.keys.set(key, index)
		}
		return index
	}

	generate(): Uint16Array {
		const chunk = new Uint16Array(256 * STAGE_HEIGHT)
		for (let i = 0; i < 256; i += 1) chunk.set(this.column, i * STAGE_HEIGHT)
		return chunk
	}

	/** A slice of this stage for a feature to be generated on */
	slice(): WorldSlice {
		return new WorldSlice(this, STAGE_CHUNKS, STAGE_CHUNKS)
	}
}

/** A stage that only remembers what is placed on it, to find out quickly whether a feature places anything */
class ProbeWorld implements FeatureWorld {
	readonly minY = STAGE_MIN_Y
	readonly maxY = STAGE_MIN_Y + STAGE_HEIGHT
	readonly seaLevel: number
	private readonly blocks: FBlock[]
	private readonly changed = new Map<number, FBlock>()

	constructor(private readonly volume: StageVolume) {
		this.seaLevel = volume.seaLevel
		this.blocks = volume.palette.map(kind => ({ name: kind.name, properties: kind.properties }))
	}

	isLoaded(x: number, z: number): boolean {
		return x >= -16 && x < 32 && z >= -16 && z < 32
	}

	getBlock(x: number, y: number, z: number): FBlock {
		if (y < this.minY || y >= this.maxY || !this.isLoaded(x, z)) return AIR
		return this.changed.get(((x + 16) * 48 + z + 16) * STAGE_HEIGHT + y - this.minY) ?? this.blocks[this.volume.column[y - this.minY]]
	}

	setBlock(x: number, y: number, z: number, block: FBlock): boolean {
		if (y < this.minY || y >= this.maxY || !this.isLoaded(x, z)) return false
		this.changed.set(((x + 16) * 48 + z + 16) * STAGE_HEIGHT + y - this.minY, block)
		return true
	}
}

/** Whether a feature places something on a stage, for one of a few tries */
function placesOn(stage: Stage, feature: unknown, data: FeatureData, seed: bigint) {
	const volume = new StageVolume(stage)
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const [x, y, z] = volume.origin
		if (placeFeature(feature, new ProbeWorld(volume), createRandom(seed + BigInt(attempt)), x, y, z, data).placed) return true
	}
	return false
}

/** Looks for a stage on which a feature places something. Many features only work on the ground that they are made for. */
export function findStage(feature: unknown, data: FeatureData, seed: bigint): Stage | undefined {
	return STAGES_TO_TRY.find(stage => placesOn(stage, feature, data, seed))
}
