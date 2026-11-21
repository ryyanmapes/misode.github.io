/** A block with its full id (with namespace) and its properties */
export interface FBlock { readonly name: string, readonly properties: Readonly<Record<string, string>> }

export type HeightmapType = 'WORLD_SURFACE_WG' | 'WORLD_SURFACE' | 'OCEAN_FLOOR_WG' | 'OCEAN_FLOOR' | 'MOTION_BLOCKING' | 'MOTION_BLOCKING_NO_LEAVES'

/** The piece of world that features read and write. Implemented by the caller. */
export interface FeatureWorld {
	/** The lowest height that has blocks, and the first height above the highest one */
	readonly minY: number
	readonly maxY: number
	readonly seaLevel: number
	/** The block at a position. Air outside of the heights and outside of what is loaded. */
	getBlock(x: number, y: number, z: number): FBlock
	/** Places a block. Returns false, and does nothing, outside of what can be changed. */
	setBlock(x: number, y: number, z: number, block: FBlock): boolean
	/** Whether this column can be read and changed */
	isLoaded(x: number, z: number): boolean
}

/** Everything that features can refer to by id. Ids are full ids such as `minecraft:oak`; ids without a namespace are accepted as `minecraft:`. */
export interface FeatureData {
	format: 'modern' | 'legacy'
	/** The JSON of a configured feature (legacy) or feature (modern), or undefined when there is none */
	feature(id: string): unknown
	/** The JSON of a placed feature */
	placed(id: string): unknown
	/** The temperature of the biome that everything is in, which decides whether water freezes and snow falls. Without it everywhere is cold. */
	temperature?: number
	/** The JSON of a carver, for the previews that cut caves before features are placed. Features themselves do not use it. */
	carver?(id: string): unknown
	/** modern: an entry of the block state provider registry */
	stateProvider(id: string): unknown
	/** The ids of the blocks in a block tag, with nested tags already resolved. An empty set when the tag is unknown. The id comes without `#`. */
	blockTag(id: string): ReadonlySet<string>
}

export interface FeatureRandom {
	/** 0 <= n < bound, 0 when bound <= 0 */
	nextInt(bound: number): number
	/** 0 <= n < 1 */
	nextFloat(): number
	nextDouble(): number
	nextBoolean(): boolean
	nextGaussian(): number
	fork(): FeatureRandom
}

export interface PlaceResult {
	/** Whether at least one block was placed */
	placed: boolean
	/** The feature types, placement modifier types, placers etc. that were met and that the engine cannot do, as readable strings such as "feature minecraft:geode" */
	unsupported: string[]
}

export interface PlacedResult extends PlaceResult {
	/** Where the placement modifiers ended up, before the feature ran at each of them */
	positions: [number, number, number][]
}

export type Pos = [number, number, number]

export type Json = Record<string, unknown>

/** What is passed around while one feature generates. Made by `createContext`. */
export interface Ctx {
	readonly world: FeatureWorld
	readonly random: FeatureRandom
	readonly data: FeatureData
	readonly modern: boolean
	readonly minY: number
	readonly maxY: number
	readonly unsupported: Set<string>
	/** How deep features are nested, to stop features that refer to themselves */
	depth: number
	/** How many blocks were placed so far */
	placed: number
	/** How many block reads and writes are left, so that broken JSON cannot hang the page */
	budget: number
	/** The blocks of a tag, looked up once per context */
	tag(id: string): ReadonlySet<string>
	get(x: number, y: number, z: number): FBlock
	set(x: number, y: number, z: number, block: FBlock): boolean
	/** The y above the highest block that a heightmap counts in a column. Remembered until a block of the column changes. */
	height(type: HeightmapType, x: number, z: number): number
	/** Whether a height is outside of the world */
	outside(y: number): boolean
	/** Notes something that the engine cannot do */
	unsupportedType(kind: string, type: string): void
	/** Generates a configured feature, given as JSON or as id, and returns whether it reported success */
	feature(ref: unknown, x: number, y: number, z: number): boolean
	/** Generates a feature that is nested in another: an id, an inline feature or an inline placed feature */
	nested(ref: unknown, x: number, y: number, z: number): boolean
	/** Runs placement modifiers and returns the positions that are left */
	positions(modifiers: unknown, x: number, y: number, z: number): Pos[]
}

/** Generates one type of feature from its config at a position and returns whether it reported success */
export type FeatureFn = (ctx: Ctx, config: Json, x: number, y: number, z: number) => boolean
