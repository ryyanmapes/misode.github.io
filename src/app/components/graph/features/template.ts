import { AIR, blk } from './blocks.js'
import { pickWeighted } from './providers.js'
import { pick } from './random.js'
import type { Ctx, FBlock, FeatureFn, FeatureTemplate } from './types.js'
import type { Dir } from './util.js'
import { CLOCKWISE, fullId, HORIZONTAL, isObj, list, num, shortId } from './util.js'

/** The rotations of the game, by how many quarter turns clockwise each is */
const ROTATIONS = ['none', 'clockwise_90', '180', 'counterclockwise_90']

/** Blocks of a template that stand for open space */
const OPEN = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])

function turned(dir: string, turns: number): string {
	let result = dir
	for (let i = 0; i < turns; i += 1) result = CLOCKWISE[result as Dir] ?? result
	return result
}

const isHorizontal = (word: string) => (HORIZONTAL as readonly string[]).includes(word)

/** A block as it is after quarter turns clockwise: what it faces, what it lies along and what it connects to turn with it */
function turnBlock(name: string, properties: Record<string, string>, turns: number): FBlock {
	if (turns === 0) return blk(name, properties)
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(properties)) {
		if (isHorizontal(key)) {
			// The sides that a fence, a wall or a vine connects to
			result[turned(key, turns)] = value
		} else if (key === 'facing') {
			result[key] = turned(value, turns)
		} else if (key === 'axis') {
			result[key] = turns % 2 === 1 && value !== 'y' ? (value === 'x' ? 'z' : 'x') : value
		} else if (key === 'rotation' && /^\d+$/.test(value)) {
			// Signs and heads stand in sixteen directions
			result[key] = String((Number(value) + 4 * turns) % 16)
		} else if (key === 'shape' || key === 'orientation') {
			// Rails and jigsaws name directions, such as south_east and up_north. The shapes of stairs name none.
			let words = value.split('_').map(word => turned(word, turns))
			if (key === 'shape' && words.length === 2 && words.every(isHorizontal)) {
				// A straight rail is north_south or east_west, and a curved one names north or south first
				const alongZ = (word: string) => word === 'north' || word === 'south'
				if (alongZ(words[0]) && alongZ(words[1])) words = ['north', 'south']
				else if (!alongZ(words[0]) && !alongZ(words[1])) words = ['east', 'west']
				else if (!alongZ(words[0])) words.reverse()
			}
			result[key] = words.join('_')
		} else {
			result[key] = value
		}
	}
	return blk(name, result)
}

// The blocks of a template for each rotation. Placing the same block again uses the same object, which the world can recognise.
const turnedBlocks = new WeakMap<FeatureTemplate, (FBlock | undefined)[][]>()

function blocksOf(template: FeatureTemplate, turns: number): (FBlock | undefined)[] {
	let all = turnedBlocks.get(template)
	if (!all) {
		all = []
		turnedBlocks.set(template, all)
	}
	all[turns] ??= template.palette.map(kind => {
		const name = fullId(kind.name)
		// A structure void leaves what is there, open space takes it away
		if (name === 'minecraft:structure_void') return undefined
		return OPEN.has(name) ? AIR : turnBlock(name, kind.properties, turns)
	})
	return all[turns]
}

/** A block as a template or a rule names it: before the template is turned */
interface State {
	name: string
	properties: Record<string, string>
}

/** A block state of a rule: an id, an id with properties in brackets, or an object in the spelling of either format */
function stateOf(value: unknown): State | undefined {
	if (typeof value === 'string') {
		const match = /^([^[]+)(?:\[(.*)\])?$/.exec(value)
		if (!match) return undefined
		const properties: Record<string, string> = {}
		for (const pair of (match[2] ?? '').split(',')) {
			const [key, text] = pair.split('=')
			if (key && text !== undefined) properties[key.trim()] = text.trim()
		}
		return { name: fullId(match[1].trim()), properties }
	}
	if (!isObj(value)) return undefined
	const name = value.id ?? value.Name
	if (typeof name !== 'string') return undefined
	const given = value.properties ?? value.Properties
	const properties: Record<string, string> = {}
	if (isObj(given)) {
		for (const [key, text] of Object.entries(given)) properties[key] = String(text)
	}
	return { name: fullId(name), properties }
}

function isState(state: State, wanted: State | undefined) {
	return wanted !== undefined && state.name === wanted.name && Object.entries(wanted.properties).every(([key, text]) => state.properties[key] === text)
}

/** A test of a rule, on the block of the template or on the block that the world has there */
function passes(ctx: Ctx, test: unknown, state: State): boolean {
	if (!isObj(test)) return true
	const type = shortId(test.predicate_type)
	switch (type) {
		case 'always_true': return true
		case 'block_match': return typeof test.block === 'string' && fullId(test.block) === state.name
		case 'random_block_match': return typeof test.block === 'string' && fullId(test.block) === state.name && ctx.random.nextFloat() < num(test.probability, 0)
		case 'blockstate_match': return isState(state, stateOf(test.block_state))
		case 'random_blockstate_match': return isState(state, stateOf(test.block_state)) && ctx.random.nextFloat() < num(test.probability, 0)
		case 'tag_match': return typeof test.tag === 'string' && ctx.tag(test.tag.replace(/^#/, '')).has(state.name)
		default:
			ctx.unsupported.add(`the test ${type || 'without a type'} of a processor rule`)
			return false
	}
}

/**
 * What the processors make of one block of a template: another block, the same block, or nothing when the block is left out.
 * As in the game, a block is looked at before the template is turned, and the block of the world is the one where it will go.
 */
function process(ctx: Ctx, processors: unknown[], state: State, there: FBlock): State | undefined {
	let now = state
	for (const processor of processors) {
		if (!isObj(processor)) continue
		const type = shortId(processor.processor_type)
		if (type === 'rule') {
			// The first rule that applies decides, and the ones after it are not asked
			for (const rule of list(processor.rules)) {
				if (!isObj(rule) || !passes(ctx, rule.input_predicate, now) || !passes(ctx, rule.location_predicate, there)) continue
				if (rule.position_predicate !== undefined && shortId(isObj(rule.position_predicate) ? rule.position_predicate.predicate_type : '') !== 'always_true') {
					ctx.unsupported.add('the position test of a processor rule')
				}
				now = stateOf(rule.output_state) ?? now
				break
			}
		} else if (type === 'protected_blocks') {
			if (typeof processor.value === 'string' && ctx.tag(processor.value.replace(/^#/, '')).has(there.name)) return undefined
		} else if (type === 'block_ignore') {
			if (list(processor.blocks).some(block => isState(now, stateOf(block)))) return undefined
		} else if (type === 'block_rot') {
			const rots = typeof processor.rottable_blocks !== 'string' || ctx.tag(processor.rottable_blocks.replace(/^#/, '')).has(now.name)
			if (rots && ctx.random.nextFloat() > num(processor.integrity, 1)) return undefined
		} else if (type !== 'nop') {
			ctx.unsupported.add(`the processor ${type || 'without a type'} of a template`)
		}
	}
	return now
}

/** The processors of a template feature: a list, an object that holds the list, or the id of a list that the editor does not have */
function processorsOf(ctx: Ctx, value: unknown): unknown[] {
	if (value === undefined) return []
	if (Array.isArray(value)) return value
	if (isObj(value) && Array.isArray(value.processors)) return value.processors
	ctx.unsupported.add('a processor list by its id')
	return []
}

// The blocks that rules give, turned. The same block is the same object every time, which the world can recognise.
const outputs = new Map<string, FBlock>()

function turnedOutput(state: State, turns: number): FBlock {
	const key = `${turns} ${state.name} ${JSON.stringify(state.properties)}`
	let block = outputs.get(key)
	if (!block) {
		block = OPEN.has(state.name) ? AIR : turnBlock(state.name, state.properties, turns)
		outputs.set(key, block)
	}
	return block
}

/** Whether a rule gives the block that is there. A property that one of the two does not name has the value that the block starts with. */
function sameBlock(a: FBlock, b: FBlock) {
	return a.name === b.name && Object.keys(a.properties).every(key => b.properties[key] === undefined || a.properties[key] === b.properties[key])
}

/**
 * `minecraft:template` (26.3): places one of a list of structure files, as TemplateFeature of the game does:
 * the template stands with its middle on the position and its lowest layer at that height, and turns around its middle.
 * The middle of a size is half of it, rounded down. The rules and the common processors are applied.
 */
export const template: FeatureFn = (ctx, config, x, y, z) => {
	const entry = pickWeighted(ctx, config.templates)
	if (!isObj(entry) || typeof entry.id !== 'string') return false
	const allowed = list(entry.rotations).filter((r): r is string => typeof r === 'string' && ROTATIONS.includes(r))
	const turns = ROTATIONS.indexOf(pick(ctx.random, allowed.length > 0 ? allowed : ROTATIONS) ?? 'none')
	const found = ctx.data.template?.(fullId(entry.id))
	// A file that is still being read is there the next time. One that does not exist places nothing, as in the game.
	if (found === 'loading' || found === undefined) return false
	const processors = processorsOf(ctx, config.processors)

	const [sizeX, sizeY, sizeZ] = found.size
	const blocks = blocksOf(found, turns)
	const middleX = sizeX >> 1
	const middleZ = sizeZ >> 1
	let any = false
	for (let tx = 0; tx < sizeX; tx += 1) {
		for (let tz = 0; tz < sizeZ; tz += 1) {
			const dx = tx - middleX
			const dz = tz - middleZ
			const px = x + (turns === 0 ? dx : turns === 1 ? -dz : turns === 2 ? -dx : dz)
			const pz = z + (turns === 0 ? dz : turns === 1 ? dx : turns === 2 ? -dz : -dx)
			for (let ty = 0; ty < sizeY; ty += 1) {
				const cell = found.cells[(tx * sizeZ + tz) * sizeY + ty]
				let block = cell === 0 ? undefined : blocks[cell - 1]
				if (block === undefined) continue
				if (processors.length > 0) {
					const kind = found.palette[cell - 1]
					const state = { name: OPEN.has(fullId(kind.name)) ? AIR.name : fullId(kind.name), properties: kind.properties }
					const there = ctx.get(px, y + ty, pz)
					const result = process(ctx, processors, state, there)
					if (result === undefined) continue
					if (result !== state) block = turnedOutput(result, turns)
					// A rule that gives the block that is there leaves it as it is
					if (sameBlock(block, there)) continue
				}
				// Open space only counts where it takes something away
				if (block === AIR && ctx.get(px, y + ty, pz).name === AIR.name) continue
				if (ctx.set(px, y + ty, pz, block) && block !== AIR) any = true
			}
		}
	}
	return any
}
