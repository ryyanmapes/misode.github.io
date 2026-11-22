import type { VersionId } from '../../services/index.js'
import { fetchPreset } from '../../services/index.js'
import { densityToJson } from './density/convert.js'
import { densitySchema } from './density/schema.js'
import type { CustomDimension, ItemKind } from './dimensions.js'
import { MAIN } from './dimensions.js'
import { materialToJson } from './material/convert.js'
import type { DimensionData } from './presets.js'
import type { TemplateMeta } from './templates.js'
import type { GDoc, GraphFormat } from './types.js'

/**
 * What a dimension has besides its final density and the rule of its noise settings:
 * noises, density functions and rules with an id, which others refer to by that id.
 * This is what they are now, as the JSON of their files.
 */
export interface Own {
	noises: Record<string, unknown>
	densities: Record<string, unknown>
	rules: Record<string, unknown>
	carvers: Record<string, unknown>
	features: Record<string, unknown>
	placers: Record<string, unknown>
	/** Which file each template is, and what is known about it. The files themselves are kept apart. */
	templates: Record<string, TemplateMeta>
}

const GROUPS = ['noises', 'densities', 'rules', 'carvers', 'templates', 'features', 'placers'] as const

/** A dimension that brings nothing of its own */
export const NO_OWN: Own = { noises: {}, densities: {}, rules: {}, carvers: {}, templates: {}, features: {}, placers: {} }

/** A dimension as it is stored: an example, or one of your own with the graphs that were changed */
export type AnyDimension = DimensionData & Partial<Pick<CustomDimension, 'density' | 'material' | 'densityDocs' | 'ruleDocs'>>

export const EMPTY_RULE = { type: 'minecraft:sequence', sequence: [] }

const OWN_FIELD: Record<ItemKind, keyof Own> = { noise: 'noises', density: 'densities', material: 'rules', carver: 'carvers', template: 'templates', feature: 'features', placer: 'placers' }

export function ownField(kind: ItemKind) {
	return OWN_FIELD[kind]
}

/** The folder of a data pack, and the registry of the game, that each kind of thing is in. 26.3 calls a configured feature a feature, and a configured carver a carver. */
export function registryOf(kind: ItemKind, format: GraphFormat) {
	switch (kind) {
		case 'noise': return 'worldgen/noise'
		case 'density': return 'worldgen/density_function'
		case 'material': return 'worldgen/material_rule'
		case 'carver': return format === 'modern' ? 'worldgen/carver' : 'worldgen/configured_carver'
		// The game calls a template a structure. Its files are in another folder than this before 1.21.
		case 'template': return 'structure'
		case 'feature': return format === 'modern' ? 'worldgen/feature' : 'worldgen/configured_feature'
		case 'placer': return 'worldgen/placed_feature'
	}
}

export function fullId(id: string) {
	return id.includes(':') ? id : `minecraft:${id}`
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Graphs do not change in place, so what one stands for only has to be worked out once
const densityJson = new WeakMap<GDoc, unknown>()
const ruleJson = new WeakMap<GDoc, unknown>()

function densityOf(doc: GDoc, format: GraphFormat) {
	if (!densityJson.has(doc)) densityJson.set(doc, densityToJson(doc, densitySchema(format)))
	return densityJson.get(doc)
}

function ruleOf(doc: GDoc) {
	if (!ruleJson.has(doc)) ruleJson.set(doc, materialToJson(doc))
	return ruleJson.get(doc)
}

/** The final density of a dimension: its graph once that was changed, and otherwise what it started as */
export function mainDensityOf(data: AnyDimension, format: GraphFormat): unknown {
	return data.density ? densityOf(data.density, format) : data.settings?.noise_router?.final_density ?? 0
}

/** The rule of the noise settings of a dimension */
export function mainRuleOf(data: AnyDimension): unknown {
	return data.material ? ruleOf(data.material) : data.rule
}

/** Everything with an id that a dimension has, as it is now */
export function ownOf(data: AnyDimension, format: GraphFormat): Own {
	const densities: Record<string, unknown> = {}
	for (const [id, json] of Object.entries(data.densityFunctions)) {
		const doc = data.densityDocs?.[id]
		densities[id] = doc ? densityOf(doc, format) : json
	}
	const rules: Record<string, unknown> = {}
	for (const [id, json] of Object.entries(data.rules)) {
		const doc = data.ruleDocs?.[id]
		rules[id] = doc ? ruleOf(doc) : json
	}
	return { noises: data.noises, densities, rules, carvers: data.carvers, templates: data.templates, features: data.features, placers: data.placers }
}

/** Every text in a piece of JSON, which is where ids are */
function collectStrings(json: unknown, into: Set<string>) {
	if (typeof json === 'string') {
		into.add(fullId(json))
	} else if (Array.isArray(json)) {
		for (const item of json) collectStrings(item, into)
	} else if (isObject(json)) {
		for (const value of Object.values(json)) collectStrings(value, into)
	}
}

/** The ids among `items` that this JSON mentions */
function mentioned(json: unknown, items: Record<string, unknown>): string[] {
	const strings = new Set<string>()
	collectStrings(json, strings)
	return Object.keys(items).filter(id => strings.has(fullId(id)))
}

/**
 * The things that cannot be referred to from `id` without going in a circle:
 * itself, and everything that already leads back to it.
 */
export function circularFor(items: Record<string, unknown>, id: string): Set<string> {
	const result = new Set<string>([id])
	let grew = true
	while (grew) {
		grew = false
		for (const [other, json] of Object.entries(items)) {
			if (result.has(other)) continue
			if (mentioned(json, items).some(ref => result.has(ref))) {
				result.add(other)
				grew = true
			}
		}
	}
	return result
}

/**
 * A rule in which the rules that are run by their id are copied in place. Before 26.3 the game
 * has no rules with an id, so this is how they get into the noise settings.
 */
export function inlineRules(rule: unknown, rules: Record<string, unknown>, stack: string[] = []): unknown {
	if (typeof rule === 'string') {
		const id = fullId(rule)
		// A rule that runs itself would never end, and one that does not exist places nothing
		if (stack.includes(id) || !(id in rules)) return EMPTY_RULE
		return inlineRules(rules[id], rules, [...stack, id])
	}
	if (!isObject(rule)) return rule
	const type = typeof rule.type === 'string' ? rule.type.replace(/^minecraft:/, '') : ''
	if (type === 'sequence' && Array.isArray(rule.sequence)) {
		return { ...rule, sequence: rule.sequence.map(item => inlineRules(item, rules, stack)) }
	}
	if (type === 'condition') {
		return { ...rule, then_run: inlineRules(rule.then_run, rules, stack) }
	}
	return rule
}

/** What a new noise, density function or rule is when it does not start from anything */
export function blankItem(kind: ItemKind, format: GraphFormat): unknown {
	if (kind === 'density') return 0
	if (kind === 'material') return EMPTY_RULE
	if (kind === 'carver') {
		// The caves of the game, a little less often
		const y = { type: 'minecraft:uniform', min_inclusive: { above_bottom: 8 }, max_inclusive: { absolute: 180 } }
		return format === 'modern'
			? {
				type: 'minecraft:cave',
				probability: 0.1,
				y,
				count: { type: 'minecraft:very_biased_to_bottom', min_inclusive: 0, max_inclusive: 14 },
				thickness: { type: 'minecraft:trapezoid', min: 0, max: 3, plateau: 1 },
				horizontal_radius_multiplier: { type: 'minecraft:uniform', min_inclusive: 0.7, max_exclusive: 1.4 },
				vertical_radius_multiplier: { type: 'minecraft:uniform', min_inclusive: 0.8, max_exclusive: 1.3 },
				room_vertical_radius_multiplier: { type: 'minecraft:uniform', min_inclusive: 0.1, max_exclusive: 0.9 },
				floor_level: { type: 'minecraft:uniform', min_inclusive: -1, max_exclusive: -0.4 },
				weird_thickness_bias: true,
			}
			: {
				type: 'minecraft:cave',
				config: {
					probability: 0.1,
					y,
					yScale: { type: 'minecraft:uniform', value: { min_inclusive: 0.1, max_exclusive: 0.9 } },
					lava_level: { above_bottom: 8 },
					replaceable: '#minecraft:overworld_carver_replaceables',
					horizontal_radius_multiplier: { type: 'minecraft:uniform', value: { min_inclusive: 0.7, max_exclusive: 1.4 } },
					vertical_radius_multiplier: { type: 'minecraft:uniform', value: { min_inclusive: 0.8, max_exclusive: 1.3 } },
					floor_level: { type: 'minecraft:uniform', value: { min_inclusive: -1, max_exclusive: -0.4 } },
				},
			}
	}
	if (kind === 'feature') {
		// A single flower, which is about the simplest thing that a feature can be
		return format === 'modern'
			? { type: 'minecraft:simple_block', to_place: { id: 'minecraft:poppy' } }
			: { type: 'minecraft:simple_block', config: { to_place: { type: 'minecraft:simple_state_provider', state: { Name: 'minecraft:poppy' } } } }
	}
	if (kind === 'placer') {
		// A few times in every chunk, on top of the terrain
		return {
			feature: 'minecraft:oak',
			placement: [
				{ type: 'minecraft:count', count: 2 },
				{ type: 'minecraft:in_square' },
				{ type: 'minecraft:heightmap', heightmap: 'WORLD_SURFACE_WG' },
				{ type: 'minecraft:biome' },
			],
		}
	}
	return format === 'modern'
		? { base_amplitude: 1, base_octave: -6, octave_count: 3 }
		: { firstOctave: -6, amplitudes: [1, 1, 1] }
}

/** The file of the game for an id, to start something new from */
export async function fetchVanillaItem(version: VersionId, format: GraphFormat, kind: ItemKind, id: string): Promise<unknown> {
	return JSON.parse(await fetchPreset(version, registryOf(kind, format), fullId(id).replace(/^minecraft:/, '')))
}

/** Another dimension, as a place to bring things over from */
export interface ItemSource {
	/** The id of the dimension */
	id: string
	own: Own
	mainDensity: unknown
	mainRule: unknown
	/** Whether this is a dimension of the game, whose things are the game's and cannot be brought over under their own id */
	fromGame: boolean
}

export function sourceOf(data: AnyDimension, format: GraphFormat): ItemSource {
	return { id: data.id, own: ownOf(data, format), mainDensity: mainDensityOf(data, format), mainRule: mainRuleOf(data), fromGame: data.fromGame === true }
}

/** The id that a copy of something of the game gets in a dimension: the same path in the namespace of the dimension */
export function copyId(id: string, namespace: string) {
	const full = fullId(id)
	return `${namespace === 'minecraft' ? 'custom' : namespace}:${full.slice(full.indexOf(':') + 1)}`
}

/** The id that the final density or the rule of another dimension gets when it is brought over */
export function mainImportId(dimensionId: string, kind: ItemKind) {
	return `${dimensionId}/${kind === 'density' ? 'final_density' : 'rule'}`
}

/** An id that is not in use yet, made by adding a number when needed */
export function freeItemId(wanted: string, taken: (id: string) => boolean) {
	if (!taken(wanted)) return wanted
	for (let n = 2; ; n += 1) {
		if (!taken(`${wanted}_${n}`)) return `${wanted}_${n}`
	}
}

/**
 * What to add to a dimension to bring something over from another one: the thing itself
 * and everything of the other dimension that it refers to and that is not here yet.
 * `item` is an id, or MAIN for the final density or the rule of the other dimension.
 * From a dimension of the game only the thing itself comes over, as a copy in `namespace`:
 * what it refers to is in the game, and stays there.
 */
export function planImport(source: ItemSource, kind: ItemKind, item: string, here: Own, namespace: string): { id: string, add: Own } {
	const add: Own = { noises: {}, densities: {}, rules: {}, carvers: {}, templates: {}, features: {}, placers: {} }
	const field = OWN_FIELD[kind]
	const root = item !== MAIN ? source.own[field][item] : kind === 'density' ? source.mainDensity : source.mainRule
	const taken = (wanted: string) => wanted in here[field]
	const id = item === MAIN ? freeItemId(mainImportId(source.id, kind), taken)
		: source.fromGame ? freeItemId(copyId(item, namespace), taken) : item
	add[field][id] = structuredClone(root)
	if (source.fromGame) return { id, add }

	const pending: unknown[] = [root]
	while (pending.length > 0) {
		const json = pending.pop()
		for (const group of GROUPS) {
			for (const ref of mentioned(json, source.own[group])) {
				if (ref in here[group] || ref in add[group]) continue
				add[group][ref] = structuredClone(source.own[group][ref])
				pending.push(source.own[group][ref])
			}
		}
	}
	return { id, add }
}

/** How many things come along with what is brought over */
export function countOwn(own: Own) {
	return GROUPS.reduce((sum, group) => sum + Object.keys(own[group]).length, 0)
}
