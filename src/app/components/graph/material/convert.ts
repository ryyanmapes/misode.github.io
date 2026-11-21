import { nextOnGrid } from '../geometry.js'
import { newId } from '../store.js'
import type { GDoc, GEdge, GNode } from '../types.js'
import { HIGHLIGHT_BLOCK } from '../worldgen.js'

// The sizes and gaps are chosen so that every step of a laid out rule is on a dot of the
// background, with the start exactly above the middle of the first step
export const RULE_W = 240
export const RULE_H = 58
export const START_W = 96
export const START_H = 40
const GAP_X = 72
const GAP_Y = 34

function strip(type: unknown) {
	return typeof type === 'string' ? type.replace(/^minecraft:/, '') : ''
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The rules of the game besides blocks, conditions and sequences. A step of these holds its JSON. */
export const SPECIAL_RULES = ['bandlands', 'ore_vein']

/** Graphs from before these rules had steps of their own kept them as custom JSON */
export function upgradeMaterial(doc: GDoc): GDoc {
	const special = (node: GNode) => node.type === 'raw' && isObject(node.data.json) && SPECIAL_RULES.includes(strip(node.data.json.type))
	if (!doc.nodes.some(special)) return doc
	return { ...doc, nodes: doc.nodes.map(node => special(node) ? { ...node, type: strip(node.data.json.type) } : node) }
}

export function ruleSize(node: GNode) {
	return node.type === 'start' ? { w: START_W, h: START_H } : { w: RULE_W, h: RULE_H }
}

/**
 * Turns a material rule into a flowchart.
 *
 * A sequence becomes a chain of steps connected by "else", because the game
 * tries each rule in order until one places a block. A condition continues
 * to the right with "then".
 */
export function materialFromJson(json: unknown): GDoc {
	const nodes: GNode[] = []
	const edges: GEdge[] = []

	const add = (type: string, data: Record<string, any>) => {
		const node: GNode = { id: newId(), type, x: 0, y: 0, data }
		nodes.push(node)
		return node.id
	}
	const link = (from: string, fromPort: string, to: string) => {
		edges.push({ id: newId('e'), from, fromPort, to, toPort: 'in' })
	}

	const build = (rule: unknown): { head: string, tail: string } | undefined => {
		if (typeof rule === 'string') {
			const id = add('reference', { id: rule })
			return { head: id, tail: id }
		}
		if (!isObject(rule)) return undefined
		const type = strip(rule.type)
		if (type === 'sequence') {
			let head: string | undefined
			let tail: string | undefined
			for (const item of Array.isArray(rule.sequence) ? rule.sequence : []) {
				const part = build(item)
				if (!part) continue
				if (tail === undefined) head = part.head
				else link(tail, 'else', part.head)
				tail = part.tail
			}
			return head !== undefined && tail !== undefined ? { head, tail } : undefined
		}
		if (type === 'condition') {
			let cond = rule.if_true
			let negate = false
			while (isObject(cond) && strip(cond.type) === 'not' && cond.invert !== undefined) {
				negate = !negate
				cond = cond.invert
			}
			const id = add('condition', { cond, negate })
			const then = build(rule.then_run)
			if (then) link(id, 'then', then.head)
			return { head: id, tail: id }
		}
		if (type === 'block') {
			const id = add('block', { state: rule.result_state })
			return { head: id, tail: id }
		}
		// The other rules of the game are steps of their own. What the editor does not know is kept as it is.
		const id = add(SPECIAL_RULES.includes(type) ? type : 'raw', { json: rule })
		return { head: id, tail: id }
	}

	const start = add('start', {})
	const root = build(json)
	if (root) link(start, 'next', root.head)
	return layoutMaterial({ nodes, edges })
}

const EMPTY_RULE = { type: 'minecraft:sequence', sequence: [] }
const MARK_RULE = { type: 'minecraft:block', result_state: HIGHLIGHT_BLOCK }

export interface MaterialSerializer {
	/** The whole material rule */
	root(): unknown
	/** The rule of a single step, including what follows its "then" */
	step(id: string): unknown
	/**
	 * The whole material rule, but with the highlight block placed where this step applies.
	 * For a condition that is where it is reached and true, for other steps where they place a block.
	 */
	marked(id: string): unknown
}

export function materialSerializer(doc: GDoc): MaterialSerializer {
	const nodes = new Map(doc.nodes.map(n => [n.id, n]))
	const targets = new Map<string, string>()
	for (const edge of doc.edges) {
		targets.set(`${edge.from}:${edge.fromPort}`, edge.to)
	}

	const create = (mark: string | undefined) => {
		const visiting = new Set<string>()

		const single = (id: string): unknown => {
			const node = nodes.get(id)
			if (!node || visiting.has(id)) return EMPTY_RULE
			if (id === mark && node.type !== 'condition') return MARK_RULE
			visiting.add(id)
			let result: unknown
			if (node.type === 'condition') {
				const then = targets.get(`${id}:then`)
				result = {
					type: 'minecraft:condition',
					if_true: node.data.negate ? { type: 'minecraft:not', invert: node.data.cond } : node.data.cond,
					then_run: id === mark ? MARK_RULE : then ? chain(then) : EMPTY_RULE,
				}
			} else if (node.type === 'block') {
				result = { type: 'minecraft:block', result_state: node.data.state }
			} else if (node.type === 'reference') {
				result = node.data.id
			} else {
				result = node.data.json ?? EMPTY_RULE
			}
			visiting.delete(id)
			return result
		}

		const chain = (id: string): unknown => {
			const items: unknown[] = []
			const seen = new Set<string>()
			let current: string | undefined = id
			while (current !== undefined && !seen.has(current) && nodes.has(current)) {
				seen.add(current)
				items.push(single(current))
				current = targets.get(`${current}:else`)
			}
			return items.length === 1 ? items[0] : { type: 'minecraft:sequence', sequence: items }
		}

		const root = () => {
			const start = doc.nodes.find(n => n.type === 'start')
			const first = start ? targets.get(`${start.id}:next`) : undefined
			return first ? chain(first) : EMPTY_RULE
		}

		return { single, root }
	}

	const plain = create(undefined)
	return {
		root: plain.root,
		step: id => nodes.get(id)?.type === 'start' ? plain.root() : plain.single(id),
		marked: id => create(id).root(),
	}
}

export function materialToJson(doc: GDoc): unknown {
	return materialSerializer(doc).root()
}

/**
 * Arranges the flowchart: each chain of steps runs down,
 * and what follows a condition is placed to its right.
 */
export function layoutMaterial(doc: GDoc): GDoc {
	const targets = new Map<string, string>()
	const hasIncoming = new Set<string>()
	for (const edge of doc.edges) {
		targets.set(`${edge.from}:${edge.fromPort}`, edge.to)
		hasIncoming.add(edge.to)
	}
	const placed = new Map<string, { x: number, y: number }>()

	const placeChain = (id: string, x: number, y: number): number => {
		let current: string | undefined = id
		let bottom = y
		while (current !== undefined && !placed.has(current)) {
			placed.set(current, { x, y })
			bottom = y + RULE_H
			const then = targets.get(`${current}:then`)
			if (then !== undefined && !placed.has(then)) {
				bottom = Math.max(bottom, placeChain(then, x + RULE_W + GAP_X, y))
			}
			y = nextOnGrid(bottom + GAP_Y)
			current = targets.get(`${current}:else`)
		}
		return bottom
	}

	let top = 0
	const start = doc.nodes.find(n => n.type === 'start')
	if (start) {
		placed.set(start.id, { x: (RULE_W - START_W) / 2, y: 0 })
		top = nextOnGrid(START_H + GAP_Y / 2)
		const first = targets.get(`${start.id}:next`)
		if (first !== undefined) {
			top = nextOnGrid(placeChain(first, 0, top) + GAP_Y * 3)
		}
	}
	// Steps that are not reachable from the start go below
	for (const node of doc.nodes) {
		if (!placed.has(node.id) && !hasIncoming.has(node.id)) {
			top = nextOnGrid(placeChain(node.id, 0, top) + GAP_Y * 2)
		}
	}
	for (const node of doc.nodes) {
		if (!placed.has(node.id)) {
			top = nextOnGrid(placeChain(node.id, 0, top) + GAP_Y * 2)
		}
	}
	return {
		nodes: doc.nodes.map(n => {
			const pos = placed.get(n.id)!
			return pos.x === n.x && pos.y === n.y ? n : { ...n, x: pos.x, y: pos.y }
		}),
		edges: doc.edges,
	}
}
