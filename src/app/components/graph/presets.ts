import type { VersionId } from '../../services/index.js'
import { fetchPreset } from '../../services/index.js'
import { loadGameUse } from './gameUse.js'
import type { TemplateMeta } from './templates.js'
import type { GDoc, GraphFormat } from './types.js'

/** Everything that the editor knows about one dimension, as the JSON files of a data pack */
export interface DimensionData {
	/** The id of the dimension, for example `minecraft:the_nether` */
	id: string
	/** The dimension file, which names the dimension type, the noise settings and the biome source */
	dimension: any
	/** The dimension type, which has the heights at which blocks can exist */
	dimensionType: any
	/** The whole noise settings */
	settings: any
	/** The material rule (26.3) or surface rule (1.19.2) of the settings */
	rule: unknown
	/** Density functions of the data pack that the settings can refer to */
	densityFunctions: Record<string, unknown>
	/** Noises of the data pack, which density functions and rules sample */
	noises: Record<string, unknown>
	/** Rules of the data pack besides the one of the settings, which rules can run by name */
	rules: Record<string, unknown>
	/** Features of the data pack: what the game calls a feature since 26.3, and a configured feature before that */
	features: Record<string, unknown>
	/** Placed features of the data pack, which the editor calls placers: a feature with where and how often it is placed */
	placers: Record<string, unknown>
	/** The ids of the placed features that the dimension generates, in the order in which they are placed */
	decoration: string[]
	/** Carvers of the data pack, which cut caves and canyons out of the terrain: a carver since 26.3, and a configured carver before that */
	carvers: Record<string, unknown>
	/** The ids of the carvers that the dimension uses, in the order in which they carve */
	carving: string[]
	/** Templates of the data pack: builds that were saved as structure files. Their files are kept apart, this is what is known about each. */
	templates: Record<string, TemplateMeta>
	/**
	 * Set for a dimension of the game itself. What it lists as its noises, density functions, rules, carvers,
	 * features and placers are then the ones of the game that it uses, which need no files in a data pack.
	 */
	fromGame?: boolean
	/** The file of the biome of the dimension, by its id. Its carvers and features are not used: the lists of the dimension are. */
	biomeFiles: Record<string, unknown>
	/** The biome of the dimension. In the editor every dimension is one biome, so this is a single id. */
	biomes: string[]
}

/** The graphs of a dimension of your own, which are only there once they were changed */
export interface Graphs {
	/** The graph of the final density */
	density?: GDoc
	/** The graph of the rule of the noise settings */
	material?: GDoc
	/** The graphs of the named density functions, by their id */
	densityDocs?: Record<string, GDoc>
	/** The graphs of the named rules, by their id */
	ruleDocs?: Record<string, GDoc>
}

/** A dimension that comes with the editor. It is there to look at and to copy from, and cannot be changed. */
export interface GraphPreset {
	/** Used in the address of the page */
	id: string
	label: string
	/** Presets of the same group are listed together */
	group: string
	/** The id of the dimension, known before it is loaded */
	dimensionId: string
	/** The id of the vanilla noise settings, when the preset can be opened in the generator */
	vanilla?: string
	load(version: VersionId, format: GraphFormat): Promise<DimensionData>
}

export interface GraphVersion {
	id: VersionId
	/** The name of the version as players know it */
	label: string
	format: GraphFormat
	presets: GraphPreset[]
}

function strip(id: unknown) {
	return typeof id === 'string' ? id.replace(/^minecraft:/, '') : ''
}

function withNamespace(id: string) {
	return id.includes(':') ? id : `minecraft:${id}`
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The ids in a field of a biome that is one id or a list of them, possibly in lists by step */
function idsIn(value: unknown): string[] {
	if (typeof value === 'string') return [withNamespace(value)]
	if (Array.isArray(value)) return value.flatMap(idsIn)
	return []
}

/**
 * What a biome file cuts out of the terrain and places on it, as the lists of a dimension: its carvers,
 * which before 26.3 are listed by what they carve into, and its placed features in the order of their steps.
 */
export function biomeLists(biome: unknown): { carving: string[], decoration: string[] } {
	const file = isObject(biome) ? biome : {}
	const carving = isObject(file.carvers) ? Object.values(file.carvers).flatMap(idsIn) : idsIn(file.carvers)
	return { carving: [...new Set(carving)], decoration: [...new Set(idsIn(file.features))] }
}

/** A biome in which nothing lives and nothing is placed, with the looks of the plains */
export function blankBiome(format: GraphFormat): Record<string, unknown> {
	if (format === 'modern') {
		return {
			has_precipitation: true,
			temperature: 0.8,
			downfall: 0.4,
			attributes: { 'minecraft:visual/sky_color': '#78a7ff' },
			effects: { water_color: '#3f76e4' },
			carvers: [],
			features: [],
		}
	}
	return {
		precipitation: 'rain',
		temperature: 0.8,
		downfall: 0.4,
		effects: { sky_color: 7907327, fog_color: 12638463, water_color: 4159204, water_fog_color: 329011 },
		spawners: {},
		spawn_costs: {},
		carvers: {},
		features: [],
	}
}

/** The one biome of a dimension: its id, and its file once the dimension has it */
export function biomeOf(data: DimensionData): { id: string, file: Record<string, unknown> | undefined } {
	const id = data.biomes[0]
	const file = data.biomeFiles[id]
	return { id, file: isObject(file) ? file : undefined }
}

/** The file of a biome of the game. A biome that cannot be read is a blank one, so the dimension still opens. */
export async function fetchGameBiome(version: VersionId, format: GraphFormat, id: string): Promise<Record<string, unknown>> {
	try {
		const file = JSON.parse(await fetchPreset(version, 'worldgen/biome', strip(withNamespace(id))))
		if (isObject(file)) return file
	} catch (e) {
		console.warn(`[graph] The biome ${id} of ${version} could not be read`, e)
	}
	return blankBiome(format)
}

function replaceIds(json: unknown, from: string, to: string): unknown {
	if (typeof json === 'string') return withNamespace(json) === from ? to : json
	if (Array.isArray(json)) return json.map(item => replaceIds(item, from, to))
	if (isObject(json)) return Object.fromEntries(Object.entries(json).map(([key, value]) => [key, key === 'type' ? value : replaceIds(value, from, to)]))
	return json
}

/**
 * Gives the biome of a dimension another id, or another file. The rules of the dimension that look
 * at the biome follow, so they keep placing the same blocks.
 */
export function withBiome<T extends DimensionData>(data: T, id: string, file: unknown): T {
	const old = data.biomes[0]
	const renamed = old !== undefined && old !== id
	const rename = <V>(json: V): V => renamed && json !== undefined ? replaceIds(json, old, id) as V : json
	const graphs = data as T & { material?: unknown, ruleDocs?: unknown }
	return {
		...data,
		biomes: [id],
		biomeFiles: { [id]: file },
		dimension: { ...data.dimension, generator: { ...data.dimension?.generator, biome_source: { type: 'minecraft:fixed', biome: id } } },
		rule: rename(data.rule),
		rules: rename(data.rules),
		// The graphs of a dimension of your own hold the same rules, as they are laid out
		...(graphs.material !== undefined ? { material: rename(graphs.material) } : {}),
		...(graphs.ruleDocs !== undefined ? { ruleDocs: rename(graphs.ruleDocs) } : {}),
	}
}

/**
 * A dimension as the editor sees every dimension: one biome all over. A dimension that was stored
 * with more biomes keeps the first one, and a biome of a data pack becomes the biome of the dimension.
 */
export function asOneBiome<T extends DimensionData>(data: T): T {
	const first = data.biomes[0] ?? 'minecraft:plains'
	const file = data.biomeFiles[first]
	if (file === undefined) {
		// A biome of the game, whose file comes later: see adoptBiome
		return { ...data, biomes: [first], biomeFiles: {}, dimension: { ...data.dimension, generator: { ...data.dimension?.generator, biome_source: { type: 'minecraft:fixed', biome: first } } } }
	}
	if (first === data.id && data.biomes.length === 1 && Object.keys(data.biomeFiles).length === 1) return data
	return withBiome({ ...data, biomes: [first] }, data.id, file)
}

/** Whether a dimension still waits for the file of its biome, which is when its biome is one of the game */
export function needsBiome(data: DimensionData) {
	return !data.fromGame && biomeOf(data).file === undefined
}

/**
 * Makes a biome of the game the biome of a dimension of your own, under the id of the dimension.
 * A dimension that listed no carvers and no placed features used the biome as it was, so it takes those over.
 */
export function adoptBiome<T extends DimensionData>(data: T, file: Record<string, unknown>): T {
	const lists = data.carving.length === 0 && data.decoration.length === 0 ? biomeLists(file) : { carving: data.carving, decoration: data.decoration }
	return { ...withBiome(data, data.id, file), ...lists }
}

/** A dimension with a biome of its own. One that still has a biome of the game gets the file of that biome. */
export async function withOwnBiome<T extends DimensionData>(version: GraphVersion, data: T): Promise<T> {
	if (!needsBiome(data)) return data
	return adoptBiome(data, await fetchGameBiome(version.id, version.format, data.biomes[0]))
}

function vanilla(id: string, dimension: string, label: string, biome: string): GraphPreset {
	return {
		id,
		label,
		group: 'Vanilla',
		dimensionId: `minecraft:${dimension}`,
		vanilla: id,
		load: async (version, format) => {
			const [settings, dimensionJson, dimensionType] = (await Promise.all([
				fetchPreset(version, 'worldgen/noise_settings', id),
				fetchPreset(version, 'dimension', dimension),
				fetchPreset(version, 'dimension_type', dimension),
			])).map(text => JSON.parse(text))
			let rule = format === 'legacy' ? settings.surface_rule : settings.material_rule
			if (typeof rule === 'string') {
				// The rule is a reference, load what it points to so it can be edited
				rule = JSON.parse(await fetchPreset(version, 'worldgen/material_rule', rule.replace(/^minecraft:/, '')))
			}
			// Every dimension is one biome in the editor. Of a dimension of the game that is its most common one.
			const file = await fetchGameBiome(version, format, biome)
			// The tabs list what the dimension uses of the game, so it can be looked at and copied from
			const used = await loadGameUse(version, format, settings, rule, [biome])
			return {
				id: `minecraft:${dimension}`,
				dimension: { ...dimensionJson, generator: { ...dimensionJson?.generator, biome_source: { type: 'minecraft:fixed', biome } } },
				dimensionType,
				settings,
				rule,
				...used,
				templates: {},
				...biomeLists(file),
				biomeFiles: { [biome]: file },
				biomes: [biome],
				fromGame: true,
			}
		},
	}
}

type Json = { default: unknown }

/** The noise settings of the Compact data pack, which is made for 1.19.2 */
const COMPACT_SETTINGS: Record<string, () => Promise<Json>> = {
	cliff: () => import('./presets/compact/noise_settings/cliff.json'),
	hollow: () => import('./presets/compact/noise_settings/hollow.json'),
	rim: () => import('./presets/compact/noise_settings/rim.json'),
	sunken: () => import('./presets/compact/noise_settings/sunken.json'),
}

const COMPACT_DIMENSIONS: Record<string, () => Promise<Json>> = {
	cliff: () => import('./presets/compact/dimension/cliff.json'),
	hollow: () => import('./presets/compact/dimension/hollow.json'),
	rim: () => import('./presets/compact/dimension/rim.json'),
	sunken: () => import('./presets/compact/dimension/sunken.json'),
}

const COMPACT_TYPES: Record<string, () => Promise<Json>> = {
	cliff: () => import('./presets/compact/dimension_type/cliff.json'),
	hollow: () => import('./presets/compact/dimension_type/hollow.json'),
	rim: () => import('./presets/compact/dimension_type/rim.json'),
	sunken: () => import('./presets/compact/dimension_type/sunken.json'),
}

const COMPACT_BIOMES: Record<string, () => Promise<Json>> = {
	'compact:cliff': () => import('./presets/compact/biome/cliff.json'),
	'compact:hollow': () => import('./presets/compact/biome/hollow.json'),
	'compact:rim': () => import('./presets/compact/biome/rim.json'),
	'compact:all_sunken': () => import('./presets/compact/biome/all_sunken.json'),
}

const COMPACT_CARVERS: Record<string, () => Promise<Json>> = {
	'compact:cliff_caves': () => import('./presets/compact/configured_carver/cliff_caves.json'),
	'compact:hollow_caves': () => import('./presets/compact/configured_carver/hollow_caves.json'),
	'compact:rim_deep_caves': () => import('./presets/compact/configured_carver/rim_deep_caves.json'),
}

/**
 * A biome without what it places in the world. The carvers of a biome become the carvers of the
 * dimension, and its features are left out, since the editor does not have the files of the pack for them.
 */
function withoutPlacers(biome: unknown) {
	return { ...(biome as Record<string, unknown>), carvers: {}, features: [] }
}

function compact(name: string, label: string, biome: string): GraphPreset {
	return {
		id: `compact/${name}`,
		label,
		group: 'Compact',
		dimensionId: `compact:${name}`,
		load: async () => {
			const [settings, dimension, dimensionType, rimContinents] = await Promise.all([
				COMPACT_SETTINGS[name](),
				COMPACT_DIMENSIONS[name](),
				COMPACT_TYPES[name](),
				import('./presets/compact/density_function/rim_continents.json') as Promise<Json>,
			])
			// The editor never changes the preset, but a copy keeps that certain
			const copy = structuredClone(settings.default) as any
			const dimensionJson = structuredClone(dimension.default) as any
			// Every dimension of the pack has one biome, which is how the editor sees all dimensions
			const file = await COMPACT_BIOMES[biome]()
			const { carving } = biomeLists(file.default)
			const carvers: Record<string, unknown> = {}
			for (const id of carving) {
				const file = await COMPACT_CARVERS[id]?.()
				if (file) carvers[id] = structuredClone(file.default)
			}
			return {
				id: `compact:${name}`,
				dimension: dimensionJson,
				dimensionType: structuredClone(dimensionType.default),
				settings: copy,
				rule: copy.surface_rule,
				densityFunctions: { 'compact:rim_continents': rimContinents.default },
				noises: {},
				rules: {},
				features: {},
				placers: {},
				decoration: [],
				carvers,
				carving,
				templates: {},
				biomeFiles: { [biome]: withoutPlacers(file.default) },
				biomes: [biome],
			}
		},
	}
}

const EMPTY_RULE = { type: 'minecraft:sequence', sequence: [] }

/** Noise settings in which nothing is decided yet: no terrain and no blocks */
function blankSettings(format: GraphFormat) {
	if (format === 'modern') {
		return {
			default_block: 'minecraft:stone',
			default_fluid: 'minecraft:water',
			disable_mob_generation: false,
			legacy_random_source: false,
			material_rule: EMPTY_RULE,
			noise: { height: 128, min_y: 0 },
			noise_router: { chunk_surface_level: 0, continents: 0, depth: 0, erosion: 0, final_density: 0, ridges: 0, temperature: 0, vegetation: 0 },
			// A sea would fill the empty world with water
			sea_level: 0,
			spawn_target: [],
		}
	}
	return {
		aquifers_enabled: false,
		default_block: { Name: 'minecraft:stone' },
		default_fluid: { Name: 'minecraft:water', Properties: { level: '0' } },
		disable_mob_generation: false,
		legacy_random_source: false,
		noise: { height: 128, min_y: 0, size_horizontal: 1, size_vertical: 2 },
		noise_router: {
			barrier: 0, continents: 0, depth: 0, erosion: 0, final_density: 0, fluid_level_floodedness: 0, fluid_level_spread: 0,
			initial_density_without_jaggedness: 0, lava: 0, ridges: 0, temperature: 0, vegetation: 0, vein_gap: 0, vein_ridged: 0, vein_toggle: 0,
		},
		ore_veins_enabled: false,
		sea_level: 0,
		spawn_target: [],
		surface_rule: EMPTY_RULE,
	}
}

/** The dimension type of the vanilla overworld in each format, with room for 128 blocks from the bottom of the world */
function blankType(format: GraphFormat) {
	if (format === 'modern') {
		return {
			ambient_light: 0,
			attributes: {
				'minecraft:gameplay/bed_rule': { can_set_spawn: 'always', can_sleep: 'when_dark', error_message: { translate: 'block.minecraft.bed.no_sleep' } },
				'minecraft:gameplay/respawn_anchor_works': false,
				'minecraft:visual/ambient_light_color': '#0a0a0a',
				'minecraft:visual/cloud_color': '#ccffffff',
				'minecraft:visual/cloud_height': 192.33,
				'minecraft:visual/fog_color': '#c0d8ff',
				'minecraft:visual/sky_color': '#78a7ff',
			},
			coordinate_scale: 1,
			default_clock: 'minecraft:overworld',
			has_ceiling: false,
			has_ender_dragon_fight: false,
			has_skylight: true,
			height: 128,
			infiniburn: '#minecraft:infiniburn_overworld',
			logical_height: 128,
			min_y: 0,
			monster_spawn_block_light_limit: 0,
			monster_spawn_light_level: { type: 'minecraft:uniform', max_inclusive: 7, min_inclusive: 0 },
			timelines: '#minecraft:in_overworld',
		}
	}
	return {
		ambient_light: 0,
		bed_works: true,
		coordinate_scale: 1,
		effects: 'minecraft:overworld',
		has_ceiling: false,
		has_raids: true,
		has_skylight: true,
		height: 128,
		infiniburn: '#minecraft:infiniburn_overworld',
		logical_height: 128,
		min_y: 0,
		monster_spawn_block_light_limit: 0,
		monster_spawn_light_level: { type: 'minecraft:uniform', value: { max_inclusive: 7, min_inclusive: 0 } },
		natural: true,
		piglin_safe: false,
		respawn_anchor_works: false,
		ultrawarm: false,
	}
}

/** A dimension in which both graphs start empty */
export function blankDimension(format: GraphFormat, id: string): DimensionData {
	return withDimensionId({
		id,
		dimension: {
			type: id,
			generator: {
				type: 'minecraft:noise',
				settings: id,
				biome_source: { type: 'minecraft:fixed', biome: id },
			},
		},
		dimensionType: blankType(format),
		settings: blankSettings(format),
		rule: EMPTY_RULE,
		densityFunctions: {},
		noises: {},
		rules: {},
		features: {},
		placers: {},
		decoration: [],
		carvers: {},
		carving: [],
		templates: {},
		biomeFiles: { [id]: blankBiome(format) },
		biomes: [id],
	}, format, id)
}

/** What an id of a data pack looks like: a namespace and a path, both in lowercase */
const ID_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_.-]+(\/[a-z0-9_.-]+)*$/

export function isValidId(id: string) {
	return ID_PATTERN.test(id)
}

/**
 * Gives a dimension another id. Its dimension type, noise settings, rule and biome get the same id,
 * so every dimension of your own has files of its own. A biome of the game that the dimension still
 * waits for the file of keeps its id until then.
 */
export function withDimensionId<T extends DimensionData>(data: T, format: GraphFormat, id: string): T {
	const { file } = biomeOf(data)
	return {
		...(file === undefined ? data : withBiome(data, id, file)),
		id,
		dimension: { ...data.dimension, type: id, generator: { ...data.dimension?.generator, settings: id, biome_source: { type: 'minecraft:fixed', biome: file === undefined ? data.biomes[0] : id } } },
		// In 26.3 the rule is a file of its own that the noise settings refer to
		settings: format === 'modern' ? { ...data.settings, material_rule: id } : data.settings,
	}
}

/**
 * A copy of a dimension to start a new one from, under another id. What a dimension of the game
 * uses of the game is not copied: the new dimension refers to it just the same, and a copy under
 * the same id would replace it for every dimension.
 */
export function fromTemplate(template: DimensionData & Graphs, format: GraphFormat, id: string): DimensionData & Graphs {
	const { dimension, dimensionType, settings, rule, decoration, carving, biomeFiles, biomes } = template
	// A copy of your own dimension keeps its graphs as they are laid out
	const graphs: Graphs = {}
	for (const key of ['density', 'material', 'densityDocs', 'ruleDocs'] as const) {
		if (template[key] !== undefined) Object.assign(graphs, { [key]: template[key] })
	}
	const { densityFunctions, noises, rules, features, placers, carvers, templates } = template.fromGame
		? { densityFunctions: {}, noises: {}, rules: {}, features: {}, placers: {}, carvers: {}, templates: {} }
		: template
	return withDimensionId(structuredClone({ id, dimension, dimensionType, settings, rule, densityFunctions, noises, rules, features, placers, decoration, carvers, carving, templates, biomeFiles, biomes, ...graphs }), format, id)
}

/** The dimensions of the game, which every version has */
const VANILLA = [
	vanilla('overworld', 'overworld', 'Overworld', 'minecraft:plains'),
	vanilla('nether', 'the_nether', 'Nether', 'minecraft:nether_wastes'),
	vanilla('end', 'the_end', 'End', 'minecraft:the_end'),
]

/** The versions and example dimensions of the graph editor, newest version first */
export const GRAPH_VERSIONS: GraphVersion[] = [
	{
		id: '26.3',
		label: '26.3',
		format: 'modern',
		presets: VANILLA,
	},
	{
		id: '1.19',
		label: '1.19.2',
		format: 'legacy',
		presets: [
			...VANILLA,
			compact('cliff', 'Cliff', 'compact:cliff'),
			compact('hollow', 'Hollow', 'compact:hollow'),
			compact('rim', 'Rim', 'compact:rim'),
			compact('sunken', 'Sunken', 'compact:all_sunken'),
		],
	},
]

export function findVersion(idOrLabel: string | undefined) {
	return GRAPH_VERSIONS.find(v => v.id === idOrLabel || v.label === idOrLabel)
}

const loading = new Map<string, Promise<DimensionData>>()
const loaded = new Map<string, DimensionData>()

/** Loads an example. It is only loaded once, since nothing can change it. */
export function loadPreset(version: GraphVersion, preset: GraphPreset): Promise<DimensionData> {
	const key = `${version.id}/${preset.id}`
	let promise = loading.get(key)
	if (!promise) {
		promise = preset.load(version.id, version.format)
		promise.then(data => loaded.set(key, data), () => loading.delete(key))
		loading.set(key, promise)
	}
	return promise
}

/** An example that was loaded before, so opening it again does not have to wait */
export function loadedPreset(version: GraphVersion, preset: GraphPreset) {
	return loaded.get(`${version.id}/${preset.id}`)
}
