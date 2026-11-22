import { AIR, blk } from './blocks.js'
import { pickWeighted } from './providers.js'
import { pick } from './random.js'
import type { FBlock, FeatureFn, FeatureTemplate } from './types.js'
import type { Dir } from './util.js'
import { CLOCKWISE, fullId, HORIZONTAL, isObj, list } from './util.js'

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

/**
 * `minecraft:template` (26.3): places one of a list of structure files. The game's own desert well shows how:
 * the template stands with its middle on the position and its lowest layer at that height, and turns around its middle.
 * Processors are not applied, and where the middle of an even size is, is a guess.
 */
export const template: FeatureFn = (ctx, config, x, y, z) => {
	const entry = pickWeighted(ctx, config.templates)
	if (!isObj(entry) || typeof entry.id !== 'string') return false
	const allowed = list(entry.rotations).filter((r): r is string => typeof r === 'string' && ROTATIONS.includes(r))
	const turns = ROTATIONS.indexOf(pick(ctx.random, allowed.length > 0 ? allowed : ROTATIONS) ?? 'none')
	const found = ctx.data.template?.(fullId(entry.id))
	// A file that is still being read is there the next time. One that does not exist places nothing, as in the game.
	if (found === 'loading' || found === undefined) return false
	if (config.processors !== undefined) ctx.unsupported.add('the processors of a template')

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
				const block = cell === 0 ? undefined : blocks[cell - 1]
				if (block === undefined) continue
				// Open space only counts where it takes something away
				if (block === AIR && ctx.get(px, y + ty, pz).name === AIR.name) continue
				if (ctx.set(px, y + ty, pz, block) && block !== AIR) any = true
			}
		}
	}
	return any
}
