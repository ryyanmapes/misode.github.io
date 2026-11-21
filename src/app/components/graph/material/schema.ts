import type { GraphFormat } from '../types.js'
import { formatNumber, prettyId } from '../ui.jsx'

/**
 * The conditions of material rules (26.3) and surface rules (1.19.2) and how they are edited.
 * Conditions of other types are kept as JSON so nothing is lost.
 */

export type CField =
	| { kind: 'number', name: string, label: string, int?: boolean, def: number, hint?: string }
	| { kind: 'bool', name: string, label: string, def: boolean, optional?: boolean, hint?: string }
	| { kind: 'enum', name: string, label: string, options: string[], def: string, hint?: string }
	| { kind: 'id', name: string, label: string, registry: string, def: string, hint?: string }
	| { kind: 'text', name: string, label: string, def: string, hint?: string }
	| { kind: 'anchor', name: string, label: string, def: Record<string, number>, hint?: string }
	/** With `list` the biomes are always written as a list, which older versions require */
	| { kind: 'biomes', name: string, label: string, def: string, list?: boolean, hint?: string }

export interface CType {
	type: string
	label: string
	description: string
	fields: CField[]
	keywords?: string
}

/** The type that stands for a condition that is referenced by its id */
export const NAMED = 'named'

const MODERN_CONDITIONS: CType[] = [
	{
		type: NAMED, label: 'Named condition', description: 'A condition from the registry, like on_floor', keywords: 'reference floor ceiling under on',
		fields: [{ kind: 'id', name: 'id', label: 'Name', registry: 'worldgen/material_condition', def: 'minecraft:on_floor' }],
	},
	{
		type: 'biome', label: 'Biome', description: 'The block is in one of these biomes',
		fields: [{ kind: 'biomes', name: 'biome_is', label: 'Biomes', def: 'minecraft:nether_wastes', hint: 'One biome, several separated by commas, or a #tag' }],
	},
	{
		type: 'y_above', label: 'Height', description: 'The block is at or above a height', keywords: 'y above level',
		fields: [
			{ kind: 'anchor', name: 'anchor', label: 'Height', def: { absolute: 32 } },
			{ kind: 'bool', name: 'add_stone_depth', label: 'Add stone depth', def: false, hint: 'Counts the blocks of stone above this block as extra height' },
			{ kind: 'number', name: 'surface_depth_multiplier', label: 'Surface depth ×', int: true, def: 0, hint: 'Raises the height by the surface depth times this number (−20 to 20)' },
		],
	},
	{
		type: 'noise_threshold', label: 'Noise threshold', description: 'A noise is within a range', keywords: 'patch random',
		fields: [
			{ kind: 'id', name: 'noise', label: 'Noise', registry: 'worldgen/noise', def: 'minecraft:surface' },
			{ kind: 'number', name: 'min_threshold', label: 'Min', def: 0 },
			{ kind: 'number', name: 'max_threshold', label: 'Max', def: Number.MAX_VALUE },
			{ kind: 'bool', name: 'is_3d', label: '3D noise', def: false, optional: true, hint: 'Sample the noise at the height of the block too' },
		],
	},
	{
		type: 'stone_depth', label: 'Stone depth', description: 'The block is close to a floor or ceiling', keywords: 'floor ceiling surface',
		fields: [
			{ kind: 'enum', name: 'surface_type', label: 'Surface', options: ['floor', 'ceiling'], def: 'floor' },
			{ kind: 'number', name: 'offset', label: 'Offset', int: true, def: 0, hint: 'How many extra blocks deep this reaches' },
			{ kind: 'bool', name: 'add_surface_depth', label: 'Add surface depth', def: false, hint: 'Reaches as deep as the surface layer, which varies by position' },
			{ kind: 'number', name: 'secondary_depth_range', label: 'Secondary depth', int: true, def: 0, hint: 'Extra depth of up to this many blocks, based on a noise' },
		],
	},
	{
		type: 'water', label: 'Water level', description: 'The block is not too far under water', keywords: 'underwater fluid',
		fields: [
			{ kind: 'number', name: 'offset', label: 'Offset', int: true, def: 0 },
			{ kind: 'number', name: 'surface_depth_multiplier', label: 'Surface depth ×', int: true, def: 0 },
			{ kind: 'bool', name: 'add_stone_depth', label: 'Add stone depth', def: false },
		],
	},
	{
		type: 'vertical_gradient', label: 'Vertical gradient', description: 'A random chance that fades out with height', keywords: 'random bedrock deepslate',
		fields: [
			{ kind: 'text', name: 'random_name', label: 'Random name', def: 'minecraft:bedrock_floor', hint: 'Seeds the randomness' },
			{ kind: 'anchor', name: 'true_at_and_below', label: 'Always below', def: { above_bottom: 0 } },
			{ kind: 'anchor', name: 'false_at_and_above', label: 'Never above', def: { above_bottom: 5 } },
		],
	},
	{ type: 'hole', label: 'Hole', description: 'The surface layer has no depth here', fields: [] },
	{ type: 'steep', label: 'Steep', description: 'The terrain is a steep slope', fields: [] },
	{ type: 'temperature', label: 'Freezing', description: 'It is cold enough to snow', fields: [], keywords: 'temperature snow cold' },
	{ type: 'above_preliminary_surface', label: 'Above surface', description: 'The block is near the terrain surface', fields: [], keywords: 'preliminary' },
]

/** 1.19.2 has no registry of conditions, no 3D noise thresholds and no biome tags */
const LEGACY_CONDITIONS: CType[] = MODERN_CONDITIONS.filter(t => t.type !== NAMED).map(t => {
	if (t.type === 'noise_threshold') {
		return { ...t, fields: t.fields.filter(f => f.name !== 'is_3d') }
	}
	if (t.type === 'biome') {
		return { ...t, fields: [{ kind: 'biomes', name: 'biome_is', label: 'Biomes', def: 'minecraft:nether_wastes', list: true, hint: 'One biome, or several separated by commas' }] }
	}
	return t
})

const CONDITIONS: Record<GraphFormat, { list: CType[], byType: Map<string, CType> }> = {
	modern: { list: MODERN_CONDITIONS, byType: new Map(MODERN_CONDITIONS.map(t => [t.type, t])) },
	legacy: { list: LEGACY_CONDITIONS, byType: new Map(LEGACY_CONDITIONS.map(t => [t.type, t])) },
}

/** The conditions that can be added in this format */
export function conditionTypes(format: GraphFormat): CType[] {
	return CONDITIONS[format].list
}

/** What the rule is called in this format */
export function ruleName(format: GraphFormat) {
	return format === 'legacy' ? 'surface rule' : 'material rule'
}

function strip(type: unknown) {
	return typeof type === 'string' ? type.replace(/^minecraft:/, '') : ''
}

/** The type of a condition, or undefined when this editor does not know it */
export function conditionType(cond: unknown, format: GraphFormat): CType | undefined {
	const { byType } = CONDITIONS[format]
	if (typeof cond === 'string') return byType.get(NAMED)
	if (typeof cond !== 'object' || cond === null) return undefined
	const type = strip((cond as Record<string, unknown>).type)
	return type === NAMED ? undefined : byType.get(type)
}

export function createCondition(type: string, format: GraphFormat): unknown {
	const def = CONDITIONS[format].byType.get(type)
	if (!def) return { type: `minecraft:${type}` }
	if (type === NAMED) return 'minecraft:on_floor'
	const cond: Record<string, unknown> = { type: `minecraft:${type}` }
	for (const field of def.fields) {
		if (field.kind === 'bool' && field.optional) continue
		cond[field.name] = field.kind === 'biomes' && field.list ? [field.def] : structuredClone(field.def)
	}
	return cond
}

export const ANCHOR_KINDS = [
	{ value: 'absolute', label: 'Y' },
	{ value: 'above_bottom', label: 'Above bottom' },
	{ value: 'below_top', label: 'Below top' },
]

export function anchorParts(anchor: unknown): { kind: string, value: number } {
	if (typeof anchor === 'object' && anchor !== null) {
		for (const { value: kind } of ANCHOR_KINDS) {
			const value = (anchor as Record<string, unknown>)[kind]
			if (typeof value === 'number') return { kind, value }
		}
	}
	return { kind: 'absolute', value: 0 }
}

function signed(value: number) {
	return value === 0 ? '' : value > 0 ? ` + ${formatNumber(value)}` : ` − ${formatNumber(-value)}`
}

export function anchorText(anchor: unknown) {
	const { kind, value } = anchorParts(anchor)
	if (kind === 'above_bottom') return `bottom${signed(value)}`
	if (kind === 'below_top') return `top${signed(-value)}`
	return formatNumber(value).replace('-', '−')
}

function words(id: unknown) {
	return typeof id === 'string' ? prettyId(id).replace(/^#/, '').replace(/[_/]/g, ' ') : '?'
}

function sentence(text: string) {
	return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text
}

export function biomeList(value: unknown): string[] {
	if (typeof value === 'string') return [value]
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
	return []
}

function numberText(value: unknown) {
	return typeof value === 'number' ? formatNumber(value).replace('-', '−') : '?'
}

const HUGE = 1e300

/**
 * Describes a condition in a few words.
 * When `folded` is true the negation is already part of the text, otherwise the caller should show "not".
 */
export function conditionText(cond: unknown, negate: boolean): { text: string, folded: boolean } {
	if (typeof cond === 'string') {
		return { text: sentence(words(cond)), folded: false }
	}
	const c = (typeof cond === 'object' && cond !== null ? cond : {}) as Record<string, any>
	switch (strip(c.type)) {
		case 'biome': {
			const biomes = biomeList(c.biome_is)
			const isTag = biomes.length === 1 && biomes[0].startsWith('#')
			const names = biomes.length > 3 ? `${biomes.slice(0, 2).map(words).join(', ')} or ${biomes.length - 2} more` : biomes.map(words).join(' or ')
			return { text: `Biome is ${negate ? 'not ' : ''}${isTag ? 'in ' : ''}${names || '?'}`, folded: true }
		}
		case 'y_above': {
			const extras = `${c.add_stone_depth ? ' + depth' : ''}`
			const surface = typeof c.surface_depth_multiplier === 'number' && c.surface_depth_multiplier !== 0 ? `${signed(c.surface_depth_multiplier)} × surface` : ''
			return { text: `Y${extras} ${negate ? '<' : '≥'} ${anchorText(c.anchor)}${surface}`, folded: true }
		}
		case 'noise_threshold': {
			const name = sentence(words(c.noise))
			const min = typeof c.min_threshold === 'number' ? c.min_threshold : 0
			const max = typeof c.max_threshold === 'number' ? c.max_threshold : 0
			if (max >= HUGE) return { text: `${name} noise ${negate ? '<' : '≥'} ${numberText(min)}`, folded: true }
			if (min <= -HUGE) return { text: `${name} noise ${negate ? '>' : '≤'} ${numberText(max)}`, folded: true }
			return { text: `${name} noise in ${numberText(min)} … ${numberText(max)}`, folded: false }
		}
		case 'stone_depth': {
			const ceiling = c.surface_type === 'ceiling'
			const simple = (c.offset ?? 0) === 0 && (c.secondary_depth_range ?? 0) === 0
			if (simple && !c.add_surface_depth) return { text: ceiling ? 'On ceiling' : 'On floor', folded: false }
			if (simple) return { text: ceiling ? 'Under ceiling' : 'Under floor', folded: false }
			const depth = `${formatNumber(1 + (c.offset ?? 0))}${c.add_surface_depth ? ' + surface' : ''}${c.secondary_depth_range ? ` + 0…${c.secondary_depth_range}` : ''}`
			return { text: `${ceiling ? 'Ceiling' : 'Floor'} depth ≤ ${depth}`, folded: false }
		}
		case 'water': {
			const offset = typeof c.offset === 'number' ? c.offset : 0
			return { text: offset >= -1 && !c.add_stone_depth ? 'Not underwater' : `Under at most ${formatNumber(-offset)} of water`, folded: false }
		}
		case 'vertical_gradient':
			return { text: `Fading chance, ${anchorText(c.true_at_and_below)} to ${anchorText(c.false_at_and_above)}`, folded: false }
		case 'hole': return { text: 'Surface is a hole', folded: false }
		case 'steep': return { text: 'Terrain is steep', folded: false }
		case 'temperature': return { text: 'Cold enough to snow', folded: false }
		case 'above_preliminary_surface': return { text: 'Above the surface', folded: false }
	}
	return { text: sentence(words(c.type) || 'Custom condition'), folded: false }
}

export function blockName(state: unknown): string {
	if (typeof state === 'string') return state
	if (typeof state === 'object' && state !== null) {
		const s = state as Record<string, unknown>
		const name = s.Name ?? s.id
		if (typeof name === 'string') return name
	}
	return 'minecraft:stone'
}

/** The name of a block without its namespace, so blocks of mods read the same as vanilla ones */
export function blockLabel(state: unknown) {
	return sentence(words(blockName(state).replace(/^[^:]*:/, '')))
}

export function ruleLabel(id: unknown) {
	if (id === '') return 'no rule yet'
	// A rule of a data pack is shown by its id, a rule of the game by its name
	return typeof id === 'string' && id.includes(':') && !id.startsWith('minecraft:') ? id : sentence(words(id))
}
