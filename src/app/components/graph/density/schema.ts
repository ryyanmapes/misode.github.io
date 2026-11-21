/**
 * The density function types and how they appear as nodes. The JSON format changed
 * between versions, so there is one schema for 26.3 and one for 1.19.2.
 * Types that are not listed here are kept as a "Custom JSON" node so nothing is lost.
 */

import type { GraphFormat } from '../types.js'

export type DField =
	/** Another density function, shown as a port. Holds a constant when nothing is connected. */
	| { kind: 'input', name: string, label?: string, optional?: boolean, hint?: string }
	/** Numbers get a slider unless they are whole numbers or `slider` is false. The slider has the range of the editor, or its own. */
	| { kind: 'number', name: string, label?: string, int?: boolean, def: number, hint?: string, slider?: boolean | { min: number, max: number } }
	| { kind: 'enum', name: string, label?: string, options: string[], def: string, optional?: boolean, hint?: string }
	| { kind: 'id', name: string, label?: string, registry: string, def: string, hint?: string }
	| { kind: 'json', name: string, label?: string, def: unknown, hint?: string }

export type DCategory = 'value' | 'math' | 'noise' | 'shape' | 'logic' | 'sampling' | 'output'

export interface DType {
	type: string
	label: string
	category: DCategory
	description: string
	fields: DField[]
	keywords?: string
	/**
	 * For gradients: the fields that hold the coordinates where it starts and ends,
	 * and the axis they are on. The axis is the name of a field, or fixed when there is no choice.
	 */
	gradient?: { from: string, to: string, axisField?: string, axis?: 'x' | 'y' | 'z' }
}

export const CATEGORIES: Record<DCategory, { label: string, color: string }> = {
	value: { label: 'Values', color: 'var(--gx-cat-value)' },
	math: { label: 'Math', color: 'var(--gx-cat-math)' },
	noise: { label: 'Noise', color: 'var(--gx-cat-noise)' },
	shape: { label: 'Shapes', color: 'var(--gx-cat-shape)' },
	logic: { label: 'Logic', color: 'var(--gx-cat-logic)' },
	sampling: { label: 'Sampling', color: 'var(--gx-cat-sampling)' },
	output: { label: 'Output', color: 'var(--gx-primary)' },
}

const input = (name: string, extra: Partial<Extract<DField, { kind: 'input' }>> = {}): DField => ({ kind: 'input', name, ...extra })
const num = (name: string, def: number, extra: Partial<Extract<DField, { kind: 'number' }>> = {}): DField => ({ kind: 'number', name, def, ...extra })

function unary(type: string, label: string, description: string, keywords?: string): DType {
	return { type, label, category: 'math', description, fields: [input('input')], keywords }
}

function binary(type: string, label: string, description: string, keywords?: string): DType {
	return { type, label, category: 'math', description, fields: [input('left'), input('right')], keywords }
}

function rounding(type: string, label: string, description: string): DType {
	return { type, label, category: 'math', description, fields: [input('input'), input('multiple', { optional: true, hint: 'Rounds to a multiple of this. Defaults to 1.' })] }
}

const AXES = ['x', 'y', 'z']

const scale = (name: string, def: number, label: string): DField => ({ kind: 'number', name, def, label, slider: false })

/** How much a noise is stretched. Most are between a quarter and a few times their size, and larger numbers can still be typed. */
const noiseScale = (name: string, label: string, hint: string): DField => ({ kind: 'number', name, def: 1, label, hint, slider: { min: 0, max: 4 } })
const NOISE_SCALES = [
	noiseScale('xz_scale', 'XZ scale', 'Multiplies X and Z before the noise is sampled. Higher makes the noise finer, 0 makes it the same everywhere along X and Z.'),
	noiseScale('y_scale', 'Y scale', 'Multiplies Y before the noise is sampled. Higher makes the noise finer, 0 makes it the same at every height.'),
]

const MODERN_TYPES: DType[] = [
	{ type: 'constant', label: 'Constant', category: 'value', description: 'The same value everywhere', fields: [num('value', 0)], keywords: 'number' },
	{ type: 'reference', label: 'Reference', category: 'value', description: 'A named density function', fields: [{ kind: 'id', name: 'id', label: 'Function', registry: 'worldgen/density_function', def: 'minecraft:zero' }], keywords: 'named registry' },

	binary('add', 'Add', 'Left + right', 'plus sum'),
	binary('sub', 'Subtract', 'Left − right', 'minus difference'),
	binary('mul', 'Multiply', 'Left × right', 'times product scale'),
	binary('div', 'Divide', 'Left ÷ right'),
	binary('min', 'Minimum', 'The smaller of two inputs'),
	binary('max', 'Maximum', 'The larger of two inputs'),
	{ type: 'lerp', label: 'Lerp', category: 'math', description: 'Blend first into second by alpha', fields: [input('alpha', { hint: '0 gives first, 1 gives second' }), input('first'), input('second')], keywords: 'mix blend interpolate' },
	{ type: 'clamp', label: 'Clamp', category: 'math', description: 'Limit the input to a range', fields: [input('input'), num('min', -1), num('max', 1)] },
	{ type: 'pow', label: 'Power', category: 'math', description: 'Base raised to an exponent', fields: [input('base'), input('exponent')], keywords: 'exponent' },
	unary('abs', 'Absolute', 'Removes the sign'),
	unary('negate', 'Negate', 'Flips the sign', 'invert'),
	unary('square', 'Square', 'Input × input'),
	unary('cube', 'Cube', 'Input × input × input'),
	unary('sqrt', 'Square Root', 'The square root of the input'),
	unary('reciprocal', 'Reciprocal', '1 ÷ input', 'inverse'),
	unary('log', 'Logarithm', 'The natural logarithm of the input'),
	unary('sign', 'Sign', '−1, 0 or 1 depending on the sign'),
	unary('half_negative', 'Half Negative', 'Halves negative values'),
	unary('quarter_negative', 'Quarter Negative', 'Quarters negative values'),
	unary('squeeze', 'Squeeze', 'Clamps to ±1, then x/2 − x³/24'),
	rounding('floor', 'Floor', 'Rounds down'),
	rounding('ceil', 'Ceil', 'Rounds up'),
	rounding('round', 'Round', 'Rounds to the nearest'),
	rounding('truncate', 'Truncate', 'Rounds towards zero'),

	{
		type: 'noise', label: 'Noise', category: 'noise', description: 'Samples a noise, at a position that other inputs can shift', keywords: 'perlin shifted shift warp',
		fields: [
			{ kind: 'id', name: 'noise', registry: 'worldgen/noise', def: 'minecraft:cave_cheese' },
			...NOISE_SCALES,
			// What Shifted Noise did until 26.3: any density function can move where the noise is sampled
			input('shift_x', { label: 'Shift X', optional: true, hint: 'Moves where the noise is sampled along X. Takes any input, not only a Shift node.' }),
			input('shift_y', { label: 'Shift Y', optional: true, hint: 'Moves where the noise is sampled along Y. Takes any input, not only a Shift node.' }),
			input('shift_z', { label: 'Shift Z', optional: true, hint: 'Moves where the noise is sampled along Z. Takes any input, not only a Shift node.' }),
		],
	},
	{
		type: 'old_blended_noise', label: 'Old Blended Noise', category: 'noise', description: 'The classic 3D terrain noise', keywords: 'base 3d terrain',
		fields: [
			scale('xz_scale', 0.25, 'XZ scale'),
			scale('y_scale', 0.125, 'Y scale'),
			scale('xz_factor', 80, 'XZ factor'),
			scale('y_factor', 160, 'Y factor'),
			scale('smear_scale_multiplier', 8, 'Smear'),
		],
	},
	{ type: 'shift', label: 'Shift', category: 'noise', description: 'Noise offset on all axes', fields: [{ kind: 'id', name: 'noise', registry: 'worldgen/noise', def: 'minecraft:offset' }] },
	{ type: 'shift_a', label: 'Shift A', category: 'noise', description: 'Noise offset for the X axis', fields: [{ kind: 'id', name: 'noise', registry: 'worldgen/noise', def: 'minecraft:offset' }] },
	{ type: 'shift_b', label: 'Shift B', category: 'noise', description: 'Noise offset for the Z axis', fields: [{ kind: 'id', name: 'noise', registry: 'worldgen/noise', def: 'minecraft:offset' }] },
	{ type: 'end_outer_islands', label: 'End Outer Islands', category: 'noise', description: 'The islands of the outer End', fields: [] },

	{
		type: 'gradient', label: 'Gradient', category: 'shape', description: 'A value that changes along an axis', keywords: 'y clamped gradient height',
		fields: [
			{ kind: 'enum', name: 'axis', options: AXES, def: 'y' },
			num('from_coordinate', 0, { label: 'From', int: true, hint: 'The coordinate where the gradient starts' }),
			num('to_coordinate', 64, { label: 'To', int: true, hint: 'The coordinate where the gradient ends' }),
			num('from_value', 0, { label: 'From value', hint: 'The value at the start' }),
			num('to_value', 1, { label: 'To value', hint: 'The value at the end' }),
			{ kind: 'enum', name: 'tiling', options: ['clamp_to_edge', 'repeat', 'mirrored_repeat'], def: 'clamp_to_edge', optional: true },
		],
		gradient: { from: 'from_coordinate', to: 'to_coordinate', axisField: 'axis' },
	},
	{
		type: 'distance_to_point', label: 'Distance to Point', category: 'shape', description: 'How far away a position is', keywords: 'sphere radius',
		fields: [
			{ kind: 'json', name: 'point', def: [0, 64, 0], hint: 'A list of [x, y, z]' },
			{ kind: 'enum', name: 'metric', options: ['euclidean', 'euclidean_squared', 'manhattan', 'chebyshev'], def: 'euclidean' },
		],
	},
	{
		type: 'slice', label: 'Slice', category: 'shape', description: 'The input at a fixed coordinate',
		fields: [input('input'), { kind: 'enum', name: 'axis', options: AXES, def: 'y' }, num('coordinate', 0, { int: true })],
	},

	{
		type: 'range_choice', label: 'Range Choice', category: 'logic', description: 'Picks an input based on a range', keywords: 'if condition switch',
		fields: [
			input('input'),
			num('min_inclusive', 0, { label: 'Min' }),
			num('max_exclusive', 1, { label: 'Max' }),
			input('when_in_range', { label: 'In range' }),
			input('when_out_of_range', { label: 'Out of range' }),
		],
	},
	{
		type: 'find_top_surface', label: 'Find Top Surface', category: 'logic', description: 'The highest Y where the density is solid',
		fields: [
			input('density'),
			input('upper_bound', { label: 'Upper bound' }),
			num('lower_bound', -64, { label: 'Lower bound', int: true }),
			num('cell_height', 8, { label: 'Cell height', int: true }),
		],
	},
	{ type: 'spline', label: 'Spline', category: 'logic', description: 'A cubic spline', fields: [{ kind: 'json', name: 'spline', def: 0 }] },

	{
		type: 'interpolated', label: 'Interpolated', category: 'sampling', description: 'Samples per cell and blends in between', keywords: 'smooth cell',
		fields: [input('input'), num('cell_size_xz', 4, { label: 'Cell XZ', int: true }), num('cell_size_y', 8, { label: 'Cell Y', int: true })],
	},
	{ type: 'cache', label: 'Cache', category: 'sampling', description: 'Remembers the input to save time', fields: [input('input')] },
	{ type: 'blend_density', label: 'Blend Density', category: 'sampling', description: 'Blends with terrain from old chunks', fields: [input('input')] },
	{ type: 'blend_alpha', label: 'Blend Alpha', category: 'sampling', description: 'How much old chunks are blended in', fields: [] },
	{ type: 'blend_offset', label: 'Blend Offset', category: 'sampling', description: 'The offset used for blending old chunks', fields: [] },
	{ type: 'beardifier', label: 'Beardifier', category: 'sampling', description: 'Adds terrain around structures', fields: [], keywords: 'structure' },
]

export const OUTPUT_TYPE: DType = {
	type: 'output', label: 'Final Density', category: 'output', description: 'Positive is solid, negative is air',
	fields: [input('input', { label: 'Density' })],
}

/** The end of the graph of a density function that has an id, which is not the terrain itself */
const NAMED_OUTPUT_TYPE: DType = {
	type: 'output', label: 'Output', category: 'output', description: 'What this density function gives where it is referred to',
	fields: [input('input', { label: 'Value' })],
}

export const RAW_TYPE: DType = {
	type: 'raw', label: 'Custom JSON', category: 'logic', description: 'Any density function as JSON',
	fields: [],
}

const NOISE_ID: DField = { kind: 'id', name: 'noise', registry: 'worldgen/noise', def: 'minecraft:cave_cheese' }
const SHIFT_NOISE: DField = { kind: 'id', name: 'argument', label: 'Noise', registry: 'worldgen/noise', def: 'minecraft:offset' }

function legacyUnary(type: string, label: string, category: DCategory, description: string, keywords?: string): DType {
	return { type, label, category, description, fields: [input('argument')], keywords }
}

function legacyBinary(type: string, label: string, description: string, keywords?: string): DType {
	return {
		type, label, category: 'math', description, keywords,
		fields: [input('argument1', { label: 'Argument 1' }), input('argument2', { label: 'Argument 2' })],
	}
}

/** The format of 1.19.2, where inputs are called argument, argument1 and argument2 */
const LEGACY_TYPES: DType[] = [
	{ type: 'constant', label: 'Constant', category: 'value', description: 'The same value everywhere', fields: [num('argument', 0, { label: 'Value' })], keywords: 'number' },
	{ type: 'reference', label: 'Reference', category: 'value', description: 'A named density function', fields: [{ kind: 'id', name: 'id', label: 'Function', registry: 'worldgen/density_function', def: 'minecraft:zero' }], keywords: 'named registry' },

	legacyBinary('add', 'Add', 'Argument 1 + argument 2', 'plus sum'),
	legacyBinary('mul', 'Multiply', 'Argument 1 × argument 2', 'times product scale'),
	legacyBinary('min', 'Minimum', 'The smaller of two inputs'),
	legacyBinary('max', 'Maximum', 'The larger of two inputs'),
	{ type: 'clamp', label: 'Clamp', category: 'math', description: 'Limit the input to a range', fields: [input('input'), num('min', -1), num('max', 1)] },
	legacyUnary('abs', 'Absolute', 'math', 'Removes the sign'),
	legacyUnary('square', 'Square', 'math', 'Argument × argument'),
	legacyUnary('cube', 'Cube', 'math', 'Argument × argument × argument'),
	legacyUnary('half_negative', 'Half Negative', 'math', 'Halves negative values'),
	legacyUnary('quarter_negative', 'Quarter Negative', 'math', 'Quarters negative values'),
	legacyUnary('squeeze', 'Squeeze', 'math', 'Clamps to ±1, then x/2 − x³/24'),

	{
		type: 'noise', label: 'Noise', category: 'noise', description: 'Samples a noise', keywords: 'perlin',
		fields: [NOISE_ID, ...NOISE_SCALES],
	},
	{
		type: 'shifted_noise', label: 'Shifted Noise', category: 'noise', description: 'Samples a noise at an offset position', keywords: 'perlin shift',
		fields: [
			NOISE_ID,
			...NOISE_SCALES,
			input('shift_x', { label: 'Shift X' }),
			input('shift_y', { label: 'Shift Y' }),
			input('shift_z', { label: 'Shift Z' }),
		],
	},
	{
		type: 'old_blended_noise', label: 'Old Blended Noise', category: 'noise', description: 'The classic 3D terrain noise', keywords: 'base 3d terrain',
		fields: [
			scale('xz_scale', 0.25, 'XZ scale'),
			scale('y_scale', 0.125, 'Y scale'),
			scale('xz_factor', 80, 'XZ factor'),
			scale('y_factor', 160, 'Y factor'),
			scale('smear_scale_multiplier', 8, 'Smear'),
		],
	},
	{
		type: 'weird_scaled_sampler', label: 'Weird Scaled Sampler', category: 'noise', description: 'Samples a noise at a scale set by the input', keywords: 'cave rarity',
		fields: [
			input('input'),
			NOISE_ID,
			{ kind: 'enum', name: 'rarity_value_mapper', label: 'Mapper', options: ['type_1', 'type_2'], def: 'type_1' },
		],
	},
	{ type: 'shift', label: 'Shift', category: 'noise', description: 'Noise offset on all axes', fields: [SHIFT_NOISE] },
	{ type: 'shift_a', label: 'Shift A', category: 'noise', description: 'Noise offset for the X axis', fields: [SHIFT_NOISE] },
	{ type: 'shift_b', label: 'Shift B', category: 'noise', description: 'Noise offset for the Z axis', fields: [SHIFT_NOISE] },
	{ type: 'end_islands', label: 'End Islands', category: 'noise', description: 'The islands of the End', fields: [] },

	{
		type: 'y_clamped_gradient', label: 'Y Gradient', category: 'shape', description: 'A value that changes with height', keywords: 'y clamped gradient height',
		fields: [
			num('from_y', 0, { label: 'From Y', int: true, hint: 'The height where the gradient starts' }),
			num('to_y', 64, { label: 'To Y', int: true, hint: 'The height where the gradient ends' }),
			num('from_value', 0, { label: 'From value', hint: 'The value at the start' }),
			num('to_value', 1, { label: 'To value', hint: 'The value at the end' }),
		],
		gradient: { from: 'from_y', to: 'to_y', axis: 'y' },
	},

	{
		type: 'range_choice', label: 'Range Choice', category: 'logic', description: 'Picks an input based on a range', keywords: 'if condition switch',
		fields: [
			input('input'),
			num('min_inclusive', 0, { label: 'Min' }),
			num('max_exclusive', 1, { label: 'Max' }),
			input('when_in_range', { label: 'In range' }),
			input('when_out_of_range', { label: 'Out of range' }),
		],
	},
	{ type: 'spline', label: 'Spline', category: 'logic', description: 'A cubic spline', fields: [{ kind: 'json', name: 'spline', def: 0 }] },

	legacyUnary('interpolated', 'Interpolated', 'sampling', 'Samples per cell and blends in between', 'smooth cell'),
	legacyUnary('flat_cache', 'Flat Cache', 'sampling', 'Remembers the argument per column of 4×4 blocks'),
	legacyUnary('cache_2d', 'Cache 2D', 'sampling', 'Remembers the argument per column'),
	legacyUnary('cache_once', 'Cache Once', 'sampling', 'Remembers the argument per position'),
	legacyUnary('cache_all_in_cell', 'Cache All In Cell', 'sampling', 'Remembers the argument for a whole cell'),
	legacyUnary('blend_density', 'Blend Density', 'sampling', 'Blends with terrain from old chunks'),
	{ type: 'blend_alpha', label: 'Blend Alpha', category: 'sampling', description: 'How much old chunks are blended in', fields: [] },
	{ type: 'blend_offset', label: 'Blend Offset', category: 'sampling', description: 'The offset used for blending old chunks', fields: [] },
	{ type: 'beardifier', label: 'Beardifier', category: 'sampling', description: 'Adds terrain around structures', fields: [], keywords: 'structure' },
]

export interface DensitySchema {
	format: GraphFormat
	/** The types that can be added from the palette */
	addable: DType[]
	/** How a type appears as a node. Unknown types are shown as custom JSON. */
	get(type: string): DType
	/** Whether a type from the JSON has its own kind of node */
	has(type: string): boolean
	/** What a new custom JSON node starts with */
	rawExample: unknown
}

function createSchema(format: GraphFormat, types: DType[], rawExample: unknown, output = OUTPUT_TYPE): DensitySchema {
	const byType = new Map<string, DType>([...types, output, RAW_TYPE].map(t => [t.type, t]))
	return {
		format,
		addable: [...types, RAW_TYPE],
		get: type => byType.get(type) ?? RAW_TYPE,
		has: type => byType.has(type) && type !== 'output' && type !== 'raw' && type !== 'reference',
		rawExample,
	}
}

const SCHEMAS: Record<GraphFormat, DensitySchema> = {
	modern: createSchema('modern', MODERN_TYPES, { type: 'minecraft:interval_select', input: 0, thresholds: [0], functions: [-1, 1] }),
	legacy: createSchema('legacy', LEGACY_TYPES, { type: 'minecraft:constant', argument: 0 }),
}

const NAMED_SCHEMAS: Record<GraphFormat, DensitySchema> = {
	modern: createSchema('modern', MODERN_TYPES, SCHEMAS.modern.rawExample, NAMED_OUTPUT_TYPE),
	legacy: createSchema('legacy', LEGACY_TYPES, SCHEMAS.legacy.rawExample, NAMED_OUTPUT_TYPE),
}

/** The nodes of a version. With `named` the graph is a density function with an id, and not the final density. */
export function densitySchema(format: GraphFormat, named = false): DensitySchema {
	return named ? NAMED_SCHEMAS[format] : SCHEMAS[format]
}

export function fieldLabel(field: DField) {
	if (field.label) return field.label
	const text = field.name.replace(/_/g, ' ')
	return text[0].toUpperCase() + text.slice(1)
}
