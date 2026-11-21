import type * as Modern from 'deepslate'
import type * as Legacy from 'deepslate-1.19'
import type { VersionId } from '../../services/index.js'
import { checkVersion } from '../../services/index.js'
import { Deepslate } from '../previews/Deepslate.js'
import type { Own } from './items.js'
import type { GraphFormat } from './types.js'

/**
 * The library that simulates world generation, loaded for one version of the game.
 * 26.3 and 1.19.2 use different releases of it, with different data formats.
 */
export type WorldgenEnv = (
	| { format: 'modern', version: VersionId, d: typeof Modern }
	| { format: 'legacy', version: VersionId, d: typeof Legacy }
) & {
	/**
	 * Tells apart what was registered of a dimension when something was computed. Results that
	 * depend on references are only valid for the same value.
	 */
	rev: string,
}

export interface NoiseShape {
	minY: number
	height: number
	legacyRandom: boolean
	/** The size of noise cells, which older versions use for interpolation */
	xzSize: number
	ySize: number
}

export function formatOf(version: VersionId): GraphFormat {
	return checkVersion(version, '26.3') ? 'modern' : 'legacy'
}

const envs = new Map<VersionId, Promise<WorldgenEnv>>()

/** Loads deepslate and fills its registries with the vanilla data of this version */
export function loadEnv(version: VersionId): Promise<WorldgenEnv> {
	let env = envs.get(version)
	if (!env) {
		env = (async (): Promise<WorldgenEnv> => {
			await Deepslate.load(version)
			if (formatOf(version) === 'modern') {
				return { format: 'modern', version, d: await import('deepslate'), rev: '' }
			}
			return { format: 'legacy', version, d: await import('deepslate-1.19'), rev: '' }
		})()
		env.catch(() => envs.delete(version))
		envs.set(version, env)
	}
	return env
}

/** What is registered of the dimension that is open, for one version of the game */
interface Registered {
	/** The JSON that each thing was registered with */
	json: Map<string, unknown>
	/** Goes up every time a thing is registered again */
	version: Map<string, number>
	/** What the game does not have itself, which is taken away again when another dimension is opened */
	added: Set<string>
}

const registered = new Map<VersionId, Registered>()

/** The rules of the open dimension that are run by their id. 1.19.2 has no registry of rules. */
const legacyRules = new Map<string, unknown>()

interface AnyRegistry {
	has(id: unknown): boolean
	register(id: unknown, value: unknown): unknown
	delete(id: unknown): boolean
}

/**
 * Makes the noises, density functions and rules of a dimension available to references, and takes
 * away those of the dimension that was open before. Returns a number for each of them that goes up
 * whenever it changes, under the keys `noise:id`, `density:id` and `rule:id`.
 */
export function registerOwn(env: WorldgenEnv, own: Own): Record<string, number> {
	let state = registered.get(env.version)
	if (!state) {
		state = { json: new Map(), version: new Map(), added: new Set() }
		registered.set(env.version, state)
	}
	const { d } = env
	const registries = d.WorldgenRegistries as unknown as Record<string, AnyRegistry | undefined>
	const groups: { prefix: string, items: Record<string, unknown>, registry: AnyRegistry | undefined, parse: (json: unknown) => unknown }[] = [
		{ prefix: 'noise:', items: own.noises, registry: registries.NOISE, parse: json => env.format === 'modern' ? env.d.NormalNoise.fromJson(json) : env.d.NoiseParameters.fromJson(json) },
		{ prefix: 'density:', items: own.densities, registry: registries.DENSITY_FUNCTION, parse: json => env.format === 'modern' ? env.d.DensityFunction.fromJson(json) : env.d.DensityFunction.fromJson(json) },
		// Before 26.3 rules have no registry. There, the rules that are run by their id are looked up when a rule is parsed.
		{ prefix: 'rule:', items: own.rules, registry: env.format === 'modern' ? registries.MATERIAL_RULE : undefined, parse: json => env.format === 'modern' ? env.d.MaterialRule.fromJson(patchRule(json)) : json },
	]
	const result: Record<string, number> = {}
	const present = new Set<string>()
	for (const { prefix, items, registry, parse } of groups) {
		for (const [id, json] of Object.entries(items)) {
			const key = prefix + id
			present.add(key)
			if (state.json.get(key) !== json || !state.json.has(key)) {
				try {
					const identifier = d.Identifier.parse(id)
					if (registry) {
						if (!state.json.has(key) && !registry.has(identifier)) state.added.add(key)
						registry.register(identifier, parse(json))
					}
				} catch (e) {
					// What cannot be read is left as it was, and shows as an error where it is used
				}
				state.json.set(key, json)
				state.version.set(key, (state.version.get(key) ?? 0) + 1)
			}
			result[key] = state.version.get(key) ?? 0
		}
	}
	for (const key of [...state.json.keys()]) {
		if (present.has(key)) continue
		state.json.delete(key)
		if (!state.added.delete(key)) continue
		const group = groups.find(g => key.startsWith(g.prefix))
		try {
			group?.registry?.delete(d.Identifier.parse(key.slice(group.prefix.length)))
		} catch (e) {
			// An id that cannot be read was never registered
		}
	}
	if (env.format === 'legacy') {
		legacyRules.clear()
		for (const [id, json] of Object.entries(own.rules)) legacyRules.set(withNamespace(id), json)
	}
	return result
}

export type DensitySampler = (x: number, y: number, z: number) => number

export function createDensitySampler(env: WorldgenEnv, json: unknown, seed: bigint, shape: NoiseShape): DensitySampler {
	if (env.format === 'modern') {
		const { d } = env
		const settings = d.NoiseGeneratorSettings.create({
			noise: { minY: shape.minY, height: shape.height },
			legacyRandomSource: shape.legacyRandom,
			noiseRouter: d.NoiseRouter.create({
				finalDensity: d.DensityFunction.fromJson(json),
			}),
		})
		const fn = new d.RandomState(settings, seed).router.finalDensity
		return (x, y, z) => fn.compute(d.DensityFunction.context(x, y, z))
	}
	const { d } = env
	const settings = d.NoiseGeneratorSettings.create({
		noise: { minY: shape.minY, height: shape.height, xzSize: shape.xzSize, ySize: shape.ySize },
		legacyRandomSource: shape.legacyRandom,
		noiseRouter: d.NoiseRouter.create({
			finalDensity: d.DensityFunction.fromJson(json),
		}),
	})
	const fn = new d.RandomState(settings, seed).router.finalDensity
	return (x, y, z) => fn.compute(d.DensityFunction.context(x, y, z))
}

/** The block that marks where a selected step of a rule applies */
export const HIGHLIGHT_BLOCK = 'graph:highlight'
/** Added to the palette index of blocks that are highlighted */
export const HIGHLIGHT_FLAG = 4096

interface BlockLike {
	getName(): { toString(): string }
	getProperties(): Record<string, string>
	isFluid(): boolean
}

interface BuiltChunk {
	/** The blocks before any rule is applied, indexed by x * height + y */
	base: BlockLike[]
	/** Runs a rule on top of the terrain and returns the blocks that it placed */
	run(rule: unknown, biome: string): (BlockLike | undefined)[]
}

/** A rule that is ready to run on the columns of one chunk, from the top of each column down */
interface RuleRun {
	updateXZ(x: number, z: number): void
	updateY(stoneDepthAbove: number, stoneDepthBelow: number, waterHeight: number, y: number): void
	apply(x: number, y: number, z: number): BlockLike | undefined
}

/** The terrain of a whole chunk before any rule is applied */
interface FilledChunk {
	/** The block at a position in the world */
	get(x: number, y: number, z: number): BlockLike
	rule(rule: unknown, biome: string): RuleRun
}

/** What differs between versions when generating terrain and applying rules to it */
interface TerrainBackend {
	minY: number
	height: number
	/** A parsed rule that places nothing */
	noop: unknown
	/** Rules of 1.19.2 only replace this block, later versions replace any solid block */
	defaultBlock: BlockLike
	onlyDefault: boolean
	parse(json: unknown): unknown
	build(chunkX: number): BuiltChunk
	fill(chunkX: number, chunkZ: number): FilledChunk
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strip(type: unknown) {
	return typeof type === 'string' ? type.replace(/^minecraft:/, '') : ''
}

function withNamespace(id: string) {
	return id.includes(':') ? id : `minecraft:${id}`
}

function readNumber(value: unknown, fallback = 0) {
	return typeof value === 'number' ? value : fallback
}

/** The parts of a chunk that rules read and write, backed by the cached terrain */
function chunkView<S extends BlockLike>(pos: unknown, minY: number, height: number, base: S[], air: S, placed: (S | undefined)[]) {
	return {
		pos,
		minY,
		height,
		maxY: minY + height,
		getBlockState: (blockPos: number[]) => {
			const y = blockPos[1] - minY
			if (y < 0 || y >= height) return air
			return base[(blockPos[0] & 15) * height + y]
		},
		setBlockState: (blockPos: number[], state: S) => {
			const y = blockPos[1] - minY
			if (y >= 0 && y < height) {
				placed[(blockPos[0] & 15) * height + y] = state
			}
		},
	}
}

/**
 * Deepslate reads `add_surface_depth` for the y_above and water conditions,
 * while the game calls this field `add_stone_depth`.
 */
function patchRule(json: unknown): unknown {
	if (Array.isArray(json)) return json.map(patchRule)
	if (typeof json !== 'object' || json === null) return json
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(json)) {
		result[key] = patchRule(value)
	}
	const type = strip(result.type)
	if ((type === 'y_above' || type === 'water') && result.add_stone_depth !== undefined) {
		result.add_surface_depth = result.add_stone_depth
	}
	return result
}

interface ModernInternals {
	createNoiseChunk(randomState: Modern.RandomState, chunk: Modern.Chunk, onlyFirstZ: boolean): Modern.NoiseChunk
	doFill(chunk: Modern.Chunk, noiseChunk: Modern.NoiseChunk): void
}

function modernBackend(d: typeof Modern, settingsJson: unknown, seed: bigint, biome: string): TerrainBackend {
	const settings = d.NoiseGeneratorSettings.fromJson(settingsJson)
	const { minY, height } = settings.noise
	const randomState = new d.RandomState(settings, seed)
	const generator = new d.NoiseChunkGenerator(new d.FixedBiomeSource(d.Identifier.parse(biome)), settings)
	const internals = generator as unknown as ModernInternals
	const biomeIds = new Map<string, Modern.Identifier>()

	const biomeId = (name: string) => {
		let id = biomeIds.get(name)
		if (!id) {
			id = d.Identifier.parse(name)
			biomeIds.set(name, id)
		}
		return id
	}

	return {
		minY,
		height,
		noop: d.MaterialRule.NOOP,
		defaultBlock: settings.defaultBlock,
		onlyDefault: false,
		parse: json => d.MaterialRule.fromJson(patchRule(json)),
		fill: (chunkX, chunkZ) => {
			const chunk = new d.Chunk(minY, height, d.ChunkPos.create(chunkX, chunkZ))
			const noiseChunk = internals.createNoiseChunk(randomState, chunk, false)
			internals.doFill(chunk, noiseChunk)
			return {
				get: (x, y, z) => chunk.getBlockState(d.BlockPos.create(x, y, z)),
				rule: (rule, biomeName) => {
					const id = biomeId(biomeName)
					const context = new d.MaterialRuleContext(randomState.surfaceSystem, randomState, chunk, noiseChunk, generator.getWorldgenContext(), () => id)
					const apply = (rule as Modern.MaterialRule).compile(context)
					return {
						updateXZ: (x, z) => context.updateXZ(x, z),
						updateY: (above, below, water, y) => context.updateY(above, below, water, y),
						apply,
					}
				},
			}
		},
		build: chunkX => {
			const chunk = new d.Chunk(minY, height, d.ChunkPos.create(chunkX, 0))
			const noiseChunk = internals.createNoiseChunk(randomState, chunk, true)
			internals.doFill(chunk, noiseChunk)
			const base: Modern.BlockState[] = Array(16 * height)
			const minX = chunkX << 4
			for (let x = 0; x < 16; x += 1) {
				for (let y = 0; y < height; y += 1) {
					base[x * height + y] = chunk.getBlockState(d.BlockPos.create(minX + x, minY + y, 0))
				}
			}
			return {
				base,
				run: (rule, biomeName) => {
					const id = biomeId(biomeName)
					const placed: (Modern.BlockState | undefined)[] = Array(16 * height)
					const view = chunkView(chunk.pos, minY, height, base, d.BlockState.AIR, placed)
					randomState.surfaceSystem.buildSurface(view as unknown as Modern.Chunk, noiseChunk, rule as Modern.MaterialRule, generator.getWorldgenContext(), () => id)
					return placed
				},
			}
		},
	}
}

interface LegacyInternals {
	getOrCreateNoiseChunk(randomState: Legacy.RandomState, chunk: Legacy.Chunk): Legacy.NoiseChunk
	noiseChunkCache: Map<bigint, Legacy.NoiseChunk>
}

/**
 * The surface rules of 1.19.2. The conditions are implemented here, because the
 * library of that version leaves out noise thresholds and holes.
 */
function legacyBackend(d: typeof Legacy, settingsJson: unknown, seed: bigint, biome: string): TerrainBackend {
	// The rule is applied separately, so the terrain can be reused when the rule changes
	const settings = d.NoiseGeneratorSettings.fromJson({ ...(isObject(settingsJson) ? settingsJson : {}), surface_rule: undefined })
	const { minY, height } = settings.noise
	const randomState = new d.RandomState(settings, seed)
	const generator = new d.NoiseChunkGenerator(new d.FixedBiomeSource(d.Identifier.parse(biome)), settings)
	const internals = generator as unknown as LegacyInternals

	const parseCondition = (json: unknown): Legacy.SurfaceCondition => {
		if (!isObject(json)) return d.SurfaceCondition.FALSE
		switch (strip(json.type)) {
			case 'not': {
				const inner = parseCondition(json.invert)
				return context => !inner(context)
			}
			case 'biome': {
				const list = Array.isArray(json.biome_is) ? json.biome_is : [json.biome_is]
				const biomes = new Set(list.filter((b): b is string => typeof b === 'string').map(withNamespace))
				return context => biomes.has(withNamespace(context.biome()))
			}
			case 'noise_threshold': {
				const noise = randomState.getOrCreateNoise(d.Identifier.parse(String(json.noise)))
				const min = readNumber(json.min_threshold)
				const max = readNumber(json.max_threshold)
				return context => {
					const value = noise.sample(context.blockX, 0, context.blockZ)
					return value >= min && value <= max
				}
			}
			case 'vertical_gradient': {
				const random = randomState.getOrCreateRandom(d.Identifier.parse(String(json.random_name)))
				const trueAtAndBelow = d.VerticalAnchor.fromJson(json.true_at_and_below)
				const falseAtAndAbove = d.VerticalAnchor.fromJson(json.false_at_and_above)
				return context => {
					const low = trueAtAndBelow(context.context)
					const high = falseAtAndAbove(context.context)
					if (context.blockY <= low) return true
					if (context.blockY >= high) return false
					const chance = 1 - (context.blockY - low) / (high - low)
					return random.at(context.blockX, context.blockY, context.blockZ).nextFloat() < chance
				}
			}
			case 'water':
				return d.SurfaceCondition.water(readNumber(json.offset), readNumber(json.surface_depth_multiplier), json.add_stone_depth === true)
			case 'y_above':
				return d.SurfaceCondition.yAbove(d.VerticalAnchor.fromJson(json.anchor), readNumber(json.surface_depth_multiplier), json.add_stone_depth === true)
			case 'hole':
				// The game rounds the surface depth down before comparing it
				return context => context.surfaceDepth < 1
			case 'stone_depth':
			case 'above_preliminary_surface':
				return d.SurfaceCondition.fromJson(json)
		}
		// Steep and temperature need the neighbouring terrain and the biome climate
		return d.SurfaceCondition.FALSE
	}

	const parseRule = (json: unknown, running: string[] = []): Legacy.SurfaceRule => {
		if (typeof json === 'string') {
			// A rule of the dimension that is run by its id. A rule that runs itself would never end.
			const id = withNamespace(json)
			return running.includes(id) ? d.SurfaceRule.NOOP : parseRule(legacyRules.get(id), [...running, id])
		}
		if (!isObject(json)) return d.SurfaceRule.NOOP
		switch (strip(json.type)) {
			case 'block': {
				const state = json.result_state
				return d.SurfaceRule.block(d.BlockState.fromJson(typeof state === 'string' ? { Name: state } : state))
			}
			case 'sequence':
				return d.SurfaceRule.sequence((Array.isArray(json.sequence) ? json.sequence : []).map(item => parseRule(item, running)))
			case 'condition':
				return d.SurfaceRule.condition(parseCondition(json.if_true), parseRule(json.then_run, running))
		}
		return d.SurfaceRule.NOOP
	}

	return {
		minY,
		height,
		noop: new d.SurfaceSystem(d.SurfaceRule.NOOP, settings.defaultBlock, seed),
		defaultBlock: settings.defaultBlock,
		onlyDefault: true,
		parse: json => new d.SurfaceSystem(parseRule(json), settings.defaultBlock, seed),
		fill: (chunkX, chunkZ) => {
			const chunk = new d.Chunk(minY, height, d.ChunkPos.create(chunkX, chunkZ))
			generator.fill(randomState, chunk)
			const noiseChunk = internals.getOrCreateNoiseChunk(randomState, chunk)
			// The generator would otherwise remember every chunk that it ever filled
			internals.noiseChunkCache.delete(d.ChunkPos.toLong(chunk.pos))
			return {
				get: (x, y, z) => chunk.getBlockState(d.BlockPos.create(x, y, z)),
				rule: (rule, biomeName) => {
					const system = rule as Legacy.SurfaceSystem
					const context = new d.SurfaceContext(system, chunk, noiseChunk, settings.noise, () => biomeName)
					const apply = (system as unknown as { rule: Legacy.SurfaceRule }).rule(context)
					return {
						updateXZ: (x, z) => context.updateXZ(x, z),
						updateY: (above, below, water, y) => context.updateY(above, below, water, y),
						apply,
					}
				},
			}
		},
		build: chunkX => {
			const chunk = new d.Chunk(minY, height, d.ChunkPos.create(chunkX, 0))
			generator.fill(randomState, chunk, true)
			const noiseChunk = internals.getOrCreateNoiseChunk(randomState, chunk)
			const base: Legacy.BlockState[] = Array(16 * height)
			const minX = chunkX << 4
			for (let x = 0; x < 16; x += 1) {
				for (let y = 0; y < height; y += 1) {
					base[x * height + y] = chunk.getBlockState(d.BlockPos.create(minX + x, minY + y, 0))
				}
			}
			return {
				base,
				run: (rule, biomeName) => {
					const placed: (Legacy.BlockState | undefined)[] = Array(16 * height)
					const view = chunkView(chunk.pos, minY, height, base, d.BlockState.AIR, placed)
					;(rule as Legacy.SurfaceSystem).buildSurface(view as unknown as Legacy.Chunk, noiseChunk, settings.noise, () => biomeName)
					return placed
				},
			}
		},
	}
}

interface ChunkEntry extends BuiltChunk {
	blocks: Uint16Array
	blocksVersion: number
	marks: Uint8Array
	marksVersion: number
}

const MAX_CHUNKS = 600

/**
 * A vertical slice of terrain at z = 0. The shape of the terrain is cached, so
 * changing the rule only needs to run the rule again.
 */
export class TerrainSlice {
	readonly minY: number
	readonly height: number
	/** The names of the blocks that sample() refers to */
	readonly palette: string[] = []

	private readonly backend: TerrainBackend
	private readonly chunks = new Map<number, ChunkEntry>()
	private readonly paletteIndex = new Map<string, number>()
	private rule: unknown
	private mark: unknown | undefined
	private version = 1
	private markVersion = 1
	private ruleKey: string | undefined
	private markKey: string | undefined
	private biome: string

	constructor(env: WorldgenEnv, settingsJson: unknown, seed: bigint, biome: string) {
		this.backend = env.format === 'modern'
			? modernBackend(env.d, settingsJson, seed, biome)
			: legacyBackend(env.d, settingsJson, seed, biome)
		this.minY = this.backend.minY
		this.height = this.backend.height
		this.rule = this.backend.noop
		this.biome = biome
	}

	/** Applies the rule, highlight and biome, and only recomputes what changed. The rules are given as JSON strings. */
	configure(rule: string, mark: string | undefined, biome: string) {
		if (biome !== this.biome) {
			this.biome = biome
			this.version += 1
			this.markVersion += 1
		}
		if (rule !== this.ruleKey) {
			this.ruleKey = rule
			this.rule = this.backend.parse(JSON.parse(rule))
			this.version += 1
		}
		if (mark !== this.markKey) {
			this.markKey = mark
			// The mark rule places the highlight block where the selected step applies
			this.mark = mark === undefined ? undefined : this.backend.parse(JSON.parse(mark))
			this.markVersion += 1
		}
	}

	private blockIndex(state: BlockLike) {
		const name = state.getName().toString()
		let index = this.paletteIndex.get(name)
		if (index === undefined) {
			index = this.palette.length
			this.palette.push(name)
			this.paletteIndex.set(name, index)
		}
		return index
	}

	/**
	 * Returns the index in the palette of the block at this position, or -1 outside of the world.
	 * The highlight flag is added when the marked rule applies here.
	 */
	sample(x: number, y: number): number {
		const localY = y - this.minY
		if (localY < 0 || localY >= this.height) return -1
		const chunkX = x >> 4
		let entry = this.chunks.get(chunkX)
		if (!entry) {
			if (this.chunks.size >= MAX_CHUNKS) this.chunks.clear()
			entry = {
				...this.backend.build(chunkX),
				blocks: new Uint16Array(16 * this.height),
				blocksVersion: 0,
				marks: new Uint8Array(16 * this.height),
				marksVersion: 0,
			}
			this.chunks.set(chunkX, entry)
		}
		if (entry.blocksVersion !== this.version) {
			const placed = entry.run(this.rule, this.biome)
			for (let i = 0; i < placed.length; i += 1) {
				entry.blocks[i] = this.blockIndex(placed[i] ?? entry.base[i])
			}
			entry.blocksVersion = this.version
		}
		const index = (x & 15) * this.height + localY
		if (!this.mark) return entry.blocks[index]
		if (entry.marksVersion !== this.markVersion) {
			const placed = entry.run(this.mark, this.biome)
			for (let i = 0; i < placed.length; i += 1) {
				entry.marks[i] = placed[i]?.getName().toString() === HIGHLIGHT_BLOCK ? 1 : 0
			}
			entry.marksVersion = this.markVersion
		}
		return entry.blocks[index] + (entry.marks[index] ? HIGHLIGHT_FLAG : 0)
	}
}

/** A kind of block that occurs in a volume */
export interface VolumeBlock {
	name: string
	properties: Record<string, string>
	fluid: boolean
}

const AIR = 'minecraft:air'

/**
 * Whole chunks of the world as the game has them after the terrain is shaped
 * and the rule is applied, so before carvers and features.
 */
export class TerrainVolume {
	readonly minY: number
	readonly height: number
	/** The kinds of blocks that generate() refers to. The first one is always air. */
	readonly palette: VolumeBlock[] = [{ name: AIR, properties: {}, fluid: false }]

	private readonly backend: TerrainBackend
	private readonly rule: unknown
	private readonly biome: string
	private readonly byState = new Map<BlockLike, number>()
	private readonly byKey = new Map<string, number>([[AIR, 0]])
	private readonly defaultIndex: number

	constructor(env: WorldgenEnv, settingsJson: unknown, ruleJson: unknown, seed: bigint, biome: string) {
		this.backend = env.format === 'modern'
			? modernBackend(env.d, settingsJson, seed, biome)
			: legacyBackend(env.d, settingsJson, seed, biome)
		this.minY = this.backend.minY
		this.height = this.backend.height
		this.rule = this.backend.parse(ruleJson)
		this.biome = biome
		this.defaultIndex = this.index(this.backend.defaultBlock)
	}

	private index(state: BlockLike): number {
		let index = this.byState.get(state)
		if (index === undefined) {
			const name = state.getName().toString()
			const properties = state.getProperties()
			const keys = Object.keys(properties).sort()
			const key = keys.length === 0 ? name : `${name}[${keys.map(k => `${k}=${properties[k]}`).join(',')}]`
			index = this.byKey.get(key)
			if (index === undefined) {
				index = this.palette.length
				this.palette.push({ name, properties: { ...properties }, fluid: state.isFluid() })
				this.byKey.set(key, index)
			}
			this.byState.set(state, index)
		}
		return index
	}

	/** The index of a kind of block in the palette, which grows when the block is new */
	indexOf(name: string, properties: Record<string, string>): number {
		const keys = Object.keys(properties).sort()
		const key = keys.length === 0 ? name : `${name}[${keys.map(k => `${k}=${properties[k]}`).join(',')}]`
		let index = this.byKey.get(key)
		if (index === undefined) {
			index = this.palette.length
			this.palette.push({ name, properties: { ...properties }, fluid: name === 'minecraft:water' || name === 'minecraft:lava' })
			this.byKey.set(key, index)
		}
		return index
	}

	/** Generates a chunk. The result has indices in the palette, at (x * 16 + z) * height + y. */
	generate(chunkX: number, chunkZ: number): Uint16Array {
		const { minY, height } = this
		const filled = this.backend.fill(chunkX, chunkZ)
		const blocks = new Uint16Array(256 * height)
		const minX = chunkX << 4
		const minZ = chunkZ << 4
		for (let x = 0; x < 16; x += 1) {
			for (let z = 0; z < 16; z += 1) {
				const column = (x * 16 + z) * height
				for (let y = 0; y < height; y += 1) {
					blocks[column + y] = this.index(filled.get(minX + x, minY + y, minZ + z))
				}
			}
		}

		// The same walk down each column as the game does, which tracks how deep a block is below the surface
		const run = filled.rule(this.rule, this.biome)
		const fluid = this.palette.map(b => b.fluid)
		const { onlyDefault } = this.backend
		for (let x = 0; x < 16; x += 1) {
			for (let z = 0; z < 16; z += 1) {
				const column = (x * 16 + z) * height
				run.updateXZ(minX + x, minZ + z)
				let stoneDepthAbove = 0
				let waterHeight = Number.MIN_SAFE_INTEGER
				let nextCeiling = Number.MAX_SAFE_INTEGER
				for (let i = height - 1; i >= 0; i -= 1) {
					const y = minY + i
					const old = blocks[column + i]
					if (old === 0) {
						stoneDepthAbove = 0
						waterHeight = Number.MIN_SAFE_INTEGER
						continue
					}
					if (fluid[old]) {
						if (waterHeight === Number.MIN_SAFE_INTEGER) waterHeight = y + 1
						continue
					}
					if (nextCeiling >= y) {
						nextCeiling = Number.MIN_SAFE_INTEGER
						for (let j = i - 1; j >= 0; j -= 1) {
							const below = blocks[column + j]
							if (below === 0 || fluid[below]) {
								nextCeiling = minY + j + 1
								break
							}
						}
					}
					stoneDepthAbove += 1
					if (onlyDefault && old !== this.defaultIndex) continue
					run.updateY(stoneDepthAbove, y - nextCeiling + 1, waterHeight, y)
					const placed = run.apply(minX + x, y, minZ + z)
					if (placed) blocks[column + i] = this.index(placed)
				}
			}
		}
		return blocks
	}
}
