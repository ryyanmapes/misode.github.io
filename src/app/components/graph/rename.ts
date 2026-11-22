import { densitySchema } from './density/schema.js'
import type { CustomDimension, ItemKind } from './dimensions.js'
import { fullId } from './items.js'
import type { GDoc, GraphFormat } from './types.js'

/**
 * Giving something of a dimension another id, another place in its list, or a copy.
 *
 * An id is only unique among things of the same kind: a feature and the placed feature that places it
 * often share one, and so can a noise and a density function. So what refers to a renamed thing is
 * found by where an id stands, not by looking for the same text everywhere.
 */

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mapValues<T>(items: Record<string, T> | undefined, change: (value: T) => T): Record<string, T> {
	return Object.fromEntries(Object.entries(items ?? {}).map(([key, value]) => [key, change(value)]))
}

function shortType(json: Json) {
	return typeof json.type === 'string' ? json.type.replace(/^minecraft:/, '') : ''
}

/** A list by id in which one id is another, at the same place */
export function rekey<T>(items: Record<string, T> | undefined, from: string, to: string): Record<string, T> {
	return Object.fromEntries(Object.entries(items ?? {}).map(([key, value]) => [key === from ? to : key, value]))
}

/** A list by id in which the entry at `from` is at the place `to` */
export function moveKey<T>(items: Record<string, T>, from: number, to: number): Record<string, T> {
	const entries = Object.entries(items)
	if (from < 0 || from >= entries.length || to < 0 || to >= entries.length) return items
	entries.splice(to, 0, ...entries.splice(from, 1))
	return Object.fromEntries(entries)
}

/** A list by id with a new entry right after another one */
export function insertAfter<T>(items: Record<string, T>, after: string, id: string, value: T): Record<string, T> {
	const entries = Object.entries(items)
	const at = entries.findIndex(([key]) => key === after)
	entries.splice(at === -1 ? entries.length : at + 1, 0, [id, value])
	return Object.fromEntries(entries)
}

interface Rename {
	from: string
	to: string
}

const swap = (value: unknown, { from, to }: Rename) => typeof value === 'string' && fullId(value) === from ? to : value

/** The density functions that take the id of a noise as their `argument`, which everywhere else is a density function */
const SHIFTS = ['shift', 'shift_a', 'shift_b']

/**
 * A density function in which a noise or a named density function has another id.
 * Noises stand at `noise`, and at the `argument` of the shifts of 1.19.2. Any other id is a density function.
 */
function inDensity(json: unknown, kind: 'noise' | 'density', rename: Rename): unknown {
	if (typeof json === 'string') return kind === 'density' ? swap(json, rename) : json
	if (Array.isArray(json)) return json.map(item => inDensity(item, kind, rename))
	if (!isObject(json)) return json
	const shift = SHIFTS.includes(shortType(json))
	return Object.fromEntries(Object.entries(json).map(([key, value]) => {
		if (key === 'type') return [key, value]
		if (key === 'noise' || (key === 'argument' && shift && typeof value === 'string')) return [key, kind === 'noise' ? swap(value, rename) : value]
		return [key, inDensity(value, kind, rename)]
	}))
}

/** Anything in which the noises that stand at `noise` have another id: a condition, a rule, a feature */
function noiseIn(json: unknown, rename: Rename): unknown {
	if (Array.isArray(json)) return json.map(item => noiseIn(item, rename))
	if (!isObject(json)) return json
	return Object.fromEntries(Object.entries(json).map(([key, value]) => [key, key === 'noise' || key === 'slow_noise' ? (typeof value === 'string' ? swap(value, rename) : noiseIn(value, rename)) : noiseIn(value, rename)]))
}

/** A rule in which a rule that is run by its id has another id. Ids stand where a rule is expected: in a sequence, or after a condition. */
function ruleIn(json: unknown, rename: Rename): unknown {
	if (typeof json === 'string') return swap(json, rename)
	if (!isObject(json)) return json
	const type = shortType(json)
	if (type === 'sequence' && Array.isArray(json.sequence)) return { ...json, sequence: json.sequence.map(item => ruleIn(item, rename)) }
	if (type === 'condition') return { ...json, then_run: ruleIn(json.then_run, rename) }
	return json
}

/** The fields of a feature that name another feature, or a list of them */
const FEATURE_KEYS = new Set(['feature', 'features', 'default', 'feature_true', 'feature_false', 'vegetation_feature'])

/**
 * A feature or placed feature in which a feature, a placed feature or a template has another id.
 * A feature inside of another is named by the id of a placed feature, and since 26.3 by the id of a feature when
 * no placed feature has that id. Only a placed feature that is written out names a feature and nothing else.
 */
function inFeature(json: unknown, kind: 'feature' | 'placer' | 'template', rename: Rename, nested: boolean, named = false, templates = false): unknown {
	if (typeof json === 'string') return named && kind !== 'template' && (kind === 'placer' || nested) ? swap(json, rename) : json
	if (Array.isArray(json)) return json.map(item => inFeature(item, kind, rename, nested, named, templates))
	if (!isObject(json)) return json
	// Written out as a placed feature: a feature with where it is placed
	const placed = json.type === undefined && json.placement !== undefined
	return Object.fromEntries(Object.entries(json).map(([key, value]) => {
		if (key === 'type') return [key, value]
		if (key === 'templates') return [key, inFeature(value, kind, rename, nested, false, true)]
		if (templates && key === 'id') return [key, kind === 'template' ? swap(value, rename) : value]
		if (placed && key === 'feature' && typeof value === 'string') return [key, kind === 'feature' ? swap(value, rename) : value]
		// The entries of a weighted list keep their feature under `data`
		const names = FEATURE_KEYS.has(key) || (key === 'data' && named)
		return [key, inFeature(value, kind, rename, nested, names, templates)]
	}))
}

/** A graph of a density function in which a noise or a named density function has another id */
function inDensityDoc(doc: GDoc | undefined, format: GraphFormat, kind: 'noise' | 'density', rename: Rename): GDoc | undefined {
	if (!doc) return doc
	const schema = densitySchema(format, true)
	const registry = kind === 'noise' ? 'worldgen/noise' : 'worldgen/density_function'
	return {
		...doc,
		nodes: doc.nodes.map(node => {
			const data = { ...node.data }
			// A node that the editor has no type for holds its JSON as it is
			if (node.type === 'raw') {
				if (data.json !== undefined) data.json = inDensity(data.json, kind, rename)
				return { ...node, data }
			}
			const values: Record<string, unknown> = { ...data.values }
			for (const field of schema.get(node.type).fields) {
				if (field.kind === 'id' && field.registry === registry) values[field.name] = swap(values[field.name], rename)
				// Splines name density functions inside of their JSON
				if (field.kind === 'json' && values[field.name] !== undefined) values[field.name] = inDensity(values[field.name], kind, rename)
			}
			data.values = values
			// Fields that the editor does not know are kept next to the ones that it does
			if (data.extra !== undefined) data.extra = inDensity(data.extra, kind, rename)
			return { ...node, data }
		}),
	}
}

/** A flowchart of a rule in which a noise or a rule that is run by its id has another id */
function inRuleDoc(doc: GDoc | undefined, kind: 'noise' | 'material', rename: Rename): GDoc | undefined {
	if (!doc) return doc
	return {
		...doc,
		nodes: doc.nodes.map(node => {
			const data = { ...node.data }
			if (node.type === 'condition') {
				if (kind === 'noise') data.cond = noiseIn(data.cond, rename)
			} else if (node.type === 'reference') {
				if (kind === 'material') data.id = swap(data.id, rename)
			} else if (data.json !== undefined) {
				data.json = kind === 'noise' ? noiseIn(data.json, rename) : ruleIn(data.json, rename)
			}
			return { ...node, data }
		}),
	}
}

/**
 * What changes about a dimension when one of its things gets another id: the thing itself, and everything of
 * the dimension that refers to it. Both ids are whole ids, with their namespace.
 */
export function renameItem(record: CustomDimension, kind: ItemKind, from: string, to: string, format: GraphFormat): Partial<CustomDimension> {
	const rename: Rename = { from, to }
	switch (kind) {
		case 'noise': return {
			noises: rekey(record.noises, from, to),
			settings: { ...record.settings, noise_router: inDensity(record.settings?.noise_router, 'noise', rename) },
			densityFunctions: mapValues(record.densityFunctions, json => inDensity(json, 'noise', rename)),
			density: inDensityDoc(record.density, format, 'noise', rename),
			densityDocs: mapValues(record.densityDocs, doc => inDensityDoc(doc, format, 'noise', rename)!),
			rule: noiseIn(record.rule, rename),
			rules: mapValues(record.rules, json => noiseIn(json, rename)),
			material: inRuleDoc(record.material, 'noise', rename),
			ruleDocs: mapValues(record.ruleDocs, doc => inRuleDoc(doc, 'noise', rename)!),
			features: mapValues(record.features, json => noiseIn(json, rename)),
		}
		case 'density': return {
			settings: { ...record.settings, noise_router: inDensity(record.settings?.noise_router, 'density', rename) },
			densityFunctions: mapValues(rekey(record.densityFunctions, from, to), json => inDensity(json, 'density', rename)),
			density: inDensityDoc(record.density, format, 'density', rename),
			densityDocs: mapValues(rekey(record.densityDocs, from, to), doc => inDensityDoc(doc, format, 'density', rename)!),
		}
		case 'material': return {
			rule: ruleIn(record.rule, rename),
			rules: mapValues(rekey(record.rules, from, to), json => ruleIn(json, rename)),
			material: inRuleDoc(record.material, 'material', rename),
			ruleDocs: mapValues(rekey(record.ruleDocs, from, to), doc => inRuleDoc(doc, 'material', rename)!),
		}
		case 'carver': return {
			carvers: rekey(record.carvers, from, to),
			carving: record.carving.map(id => id === from ? to : id),
		}
		case 'template': return {
			templates: rekey(record.templates, from, to),
			features: mapValues(record.features, json => inFeature(json, 'template', rename, false)),
			placers: mapValues(record.placers, json => inFeature(json, 'template', rename, false)),
		}
		case 'feature': {
			// Inside of a feature the id means the placed feature, when there is one
			const nested = !(from in record.placers)
			return {
				features: mapValues(rekey(record.features, from, to), json => inFeature(json, 'feature', rename, nested)),
				placers: mapValues(record.placers, json => inFeature(json, 'feature', rename, nested)),
			}
		}
		case 'placer': return {
			placers: mapValues(rekey(record.placers, from, to), json => inFeature(json, 'placer', rename, true)),
			features: mapValues(record.features, json => inFeature(json, 'placer', rename, true)),
			decoration: record.decoration.map(id => id === from ? to : id),
		}
	}
}
