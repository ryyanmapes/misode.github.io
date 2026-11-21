import { canSurvive, fluidOf, isReplaceable, isSolidIn, isSturdy, parseBlock } from './blocks.js'
import { anchorY, holderSet } from './providers.js'
import type { Ctx, FBlock } from './types.js'
import { dirOf, fullId, isObj, list, num, offsetOf, shortId } from './util.js'

const MAX_VOLUME = 4096

function matchesFluid(fluids: unknown, fluid: string): boolean {
	for (const entry of list(fluids)) {
		if (typeof entry !== 'string') continue
		const name = fullId(entry.startsWith('#') ? entry.slice(1) : entry).replace('flowing_', '')
		if (name === fluid) return true
	}
	return false
}

/** Tests a block predicate of either format at a position. No predicate at all passes. */
export function testPredicate(ctx: Ctx, predicate: unknown, x: number, y: number, z: number, depth = 0): boolean {
	if (!isObj(predicate)) return true
	if (depth > 32) return false
	const offset = offsetOf(predicate.offset)
	const px = x + offset[0]
	const py = y + offset[1]
	const pz = z + offset[2]
	const type = shortId(predicate.type)
	switch (type) {
		case 'true':
			return true
		case 'all_of':
			return list(predicate.predicates).every(p => testPredicate(ctx, p, x, y, z, depth + 1))
		case 'any_of':
			return list(predicate.predicates).some(p => testPredicate(ctx, p, x, y, z, depth + 1))
		case 'not':
			return !testPredicate(ctx, predicate.predicate, x, y, z, depth + 1)
		case 'matching_blocks':
			return holderSet(ctx, predicate.blocks)(ctx.get(px, py, pz).name)
		case 'matching_block_tag':
			return typeof predicate.tag === 'string' && ctx.tag(predicate.tag).has(ctx.get(px, py, pz).name)
		case 'matching_fluids':
			return matchesFluid(predicate.fluids, fluidOf(ctx.get(px, py, pz)))
		case 'has_sturdy_face':
			return isSturdy(ctx.get(px, py, pz), dirOf(predicate.direction, 'down'), ctx)
		case 'solid':
			return isSolidIn(ctx.get(px, py, pz), ctx)
		case 'replaceable':
			return isReplaceable(ctx.get(px, py, pz), ctx)
		case 'would_survive': {
			const state = parseBlock(predicate.state)
			return state !== undefined && canSurvive(ctx, state, px, py, pz)
		}
		case 'inside_world_bounds':
			return !ctx.outside(py)
		case 'height_range':
			return py >= anchorY(ctx, predicate.min_inclusive, -Infinity) && py <= anchorY(ctx, predicate.max_inclusive, Infinity)
		case 'volume_match': {
			const min = offsetOf(predicate.min)
			const max = offsetOf(predicate.max)
			const size = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1)
			if (!(size > 0) || size > MAX_VOLUME) return false
			for (let dx = min[0]; dx <= max[0]; dx += 1) {
				for (let dy = min[1]; dy <= max[1]; dy += 1) {
					for (let dz = min[2]; dz <= max[2]; dz += 1) {
						if (!testPredicate(ctx, predicate.match, px + dx, py + dy, pz + dz, depth + 1)) return false
					}
				}
			}
			return true
		}
		case 'unobstructed':
		case 'matching_biomes':
			// There are no entities and no biomes here
			return true
		default:
			ctx.unsupportedType('block predicate', type)
			return false
	}
}

function sameState(block: FBlock, wanted: FBlock | undefined): boolean {
	if (wanted === undefined || wanted.name !== block.name) return false
	return Object.entries(wanted.properties).every(([k, v]) => block.properties[k] === undefined || block.properties[k] === v)
}

/** Tests a rule test, which is what the targets of ores are */
export function testRule(ctx: Ctx, rule: unknown, block: FBlock, y: number, depth = 0): boolean {
	if (!isObj(rule) || depth > 32) return false
	const type = shortId(rule.predicate_type)
	switch (type) {
		case 'always_true':
			return true
		case 'block_match':
			return typeof rule.block === 'string' && fullId(rule.block) === block.name
		case 'blockstate_match':
			return sameState(block, parseBlock(rule.block_state))
		case 'tag_match':
			return typeof rule.tag === 'string' && ctx.tag(rule.tag).has(block.name)
		case 'random_block_match':
			return typeof rule.block === 'string' && fullId(rule.block) === block.name && ctx.random.nextFloat() < num(rule.probability, 0)
		case 'random_blockstate_match':
			return sameState(block, parseBlock(rule.block_state)) && ctx.random.nextFloat() < num(rule.probability, 0)
		case 'any_of':
			return list(rule.rules).some(r => testRule(ctx, r, block, y, depth + 1))
		case 'all_of':
			return list(rule.rules).every(r => testRule(ctx, r, block, y, depth + 1))
		case 'not':
			return !testRule(ctx, rule.rule, block, y, depth + 1)
		case 'height_match':
			return y >= num(rule.min_inclusive, -Infinity) && y <= num(rule.max_inclusive, Infinity)
		default:
			ctx.unsupportedType('rule test', type)
			return false
	}
}
