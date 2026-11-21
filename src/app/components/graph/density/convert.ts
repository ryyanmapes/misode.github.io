import { nextOnGrid, snapToGrid } from '../geometry.js'
import { indexLinks, newId } from '../store.js'
import type { GDoc, GEdge, GNode } from '../types.js'
import type { DensitySchema } from './schema.js'

export const NODE_W = 196
export const HEADER_H = 36
export const ROW_H = 26
export const PAD_TOP = 6
export const PAD_BOTTOM = 8
export const THUMB_H = 64
export const THUMB_GAP = 6
const GAP_X = 44
const GAP_Y = 22

export function hasThumb(node: GNode) {
	return node.type !== 'constant'
}

export function rowCount(node: GNode, schema: DensitySchema) {
	if (node.type === 'raw') return 1
	return schema.get(node.type).fields.length
}

export function nodeHeight(node: GNode, schema: DensitySchema, thumbs: boolean) {
	const rows = rowCount(node, schema)
	return HEADER_H + (rows > 0 ? PAD_TOP + rows * ROW_H : 0) + PAD_BOTTOM + (thumbs && hasThumb(node) ? THUMB_H + THUMB_GAP : 0)
}

function stripNamespace(type: unknown) {
	return typeof type === 'string' ? type.replace(/^minecraft:/, '') : ''
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Turns the JSON of a density function into a graph that ends in an output node */
export function densityFromJson(json: unknown, schema: DensitySchema, thumbs = true): GDoc {
	const nodes: GNode[] = []
	const edges: GEdge[] = []

	const add = (type: string, data: Record<string, any>) => {
		const node: GNode = { id: newId(), type, x: 0, y: 0, data }
		nodes.push(node)
		return node
	}

	// Returns either a node id, or a number that can be stored inline
	const build = (value: unknown): { id: string } | { constant: number } => {
		if (typeof value === 'number') {
			return { constant: value }
		}
		if (typeof value === 'string') {
			return { id: add('reference', { values: { id: value } }).id }
		}
		if (!isObject(value)) {
			return { constant: 0 }
		}
		const type = stripNamespace(value.type)
		if (!schema.has(type)) {
			return { id: add('raw', { json: value }).id }
		}
		const def = schema.get(type)
		const values: Record<string, unknown> = {}
		const node = add(type, { values })
		const known = new Set(['type'])
		for (const field of def.fields) {
			known.add(field.name)
			const raw = value[field.name]
			if (field.kind === 'input') {
				if (raw === undefined) continue
				const result = build(raw)
				if ('constant' in result) {
					values[field.name] = result.constant
				} else {
					edges.push({ id: newId('e'), from: result.id, fromPort: 'out', to: node.id, toPort: field.name })
				}
			} else if (raw !== undefined) {
				values[field.name] = raw
			} else if (!(field.kind === 'enum' && field.optional)) {
				values[field.name] = field.def
			}
		}
		// Keep fields that this editor does not know about
		const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)))
		if (Object.keys(extra).length > 0) {
			node.data.extra = extra
		}
		return { id: node.id }
	}

	const root = build(json)
	const output = add('output', { values: {} })
	if ('constant' in root) {
		output.data.values.input = root.constant
	} else {
		edges.push({ id: newId('e'), from: root.id, fromPort: 'out', to: output.id, toPort: 'input' })
	}
	return layoutDensity({ nodes, edges }, schema, thumbs)
}

function sorted(obj: Record<string, unknown>) {
	const { type, ...rest } = obj
	const result: Record<string, unknown> = { type }
	for (const key of Object.keys(rest).sort()) {
		result[key] = rest[key]
	}
	return result
}

/** Creates a function that returns the JSON of the density function that a node outputs */
export function densitySerializer(doc: GDoc, schema: DensitySchema) {
	const links = indexLinks(doc)
	const nodes = new Map(doc.nodes.map(n => [n.id, n]))
	const cache = new Map<string, unknown>()
	const visiting = new Set<string>()

	const serialize = (id: string): unknown => {
		if (cache.has(id)) return cache.get(id)
		const node = nodes.get(id)
		if (!node || visiting.has(id)) return 0
		visiting.add(id)
		let result: unknown
		const values: Record<string, unknown> = node.data.values ?? {}
		if (node.type === 'raw') {
			result = node.data.json ?? 0
		} else if (node.type === 'reference') {
			result = typeof values.id === 'string' && values.id !== '' ? values.id : 'minecraft:zero'
		} else {
			const def = schema.get(node.type)
			const obj: Record<string, unknown> = { type: `minecraft:${node.type}`, ...(node.data.extra ?? {}) }
			for (const field of def.fields) {
				if (field.kind === 'input') {
					const edge = links.get(id)?.ins[field.name]?.[0]
					if (edge) {
						obj[field.name] = serialize(edge.from)
					} else if (typeof values[field.name] === 'number') {
						obj[field.name] = values[field.name]
					} else if (!field.optional) {
						obj[field.name] = 0
					}
				} else if (values[field.name] !== undefined && values[field.name] !== '') {
					obj[field.name] = values[field.name]
				} else if (!(field.kind === 'enum' && field.optional)) {
					obj[field.name] = field.def
				}
			}
			result = node.type === 'output' ? obj.input : sorted(obj)
		}
		visiting.delete(id)
		cache.set(id, result)
		return result
	}
	return serialize
}

export function densityToJson(doc: GDoc, schema: DensitySchema): unknown {
	const output = doc.nodes.find(n => n.type === 'output')
	return output ? densitySerializer(doc, schema)(output.id) : 0
}

/**
 * Arranges the graph from right to left: the output on the right, and every
 * input in the column to the left of the node that uses it. Every node ends up
 * on a dot of the background, so the graph lines up with nodes that snap to it.
 */
export function layoutDensity(doc: GDoc, schema: DensitySchema, thumbs: boolean): GDoc {
	const links = indexLinks(doc)
	const nodes = new Map(doc.nodes.map(n => [n.id, n]))
	const placed = new Map<string, { x: number, y: number }>()
	const columnStep = NODE_W + GAP_X

	const place = (id: string, depth: number, top: number): number => {
		const node = nodes.get(id)!
		const height = nodeHeight(node, schema, thumbs)
		// Reserve the spot so shared inputs are only placed once
		placed.set(id, { x: -depth * columnStep, y: top })
		const sources: string[] = []
		for (const field of schema.get(node.type).fields) {
			if (field.kind !== 'input') continue
			const edge = links.get(id)?.ins[field.name]?.[0]
			if (edge && !placed.has(edge.from) && !sources.includes(edge.from)) {
				sources.push(edge.from)
			}
		}
		if (sources.length === 0) {
			return top + height
		}
		let cursor = top
		let lowest = top
		let first = 0
		let last = 0
		sources.forEach((source, i) => {
			lowest = place(source, depth + 1, cursor)
			const pos = placed.get(source)!
			const center = pos.y + nodeHeight(nodes.get(source)!, schema, thumbs) / 2
			if (i === 0) first = center
			last = center
			cursor = nextOnGrid(lowest + GAP_Y)
		})
		const y = Math.max(top, snapToGrid((first + last) / 2 - height / 2))
		placed.set(id, { x: -depth * columnStep, y })
		return Math.max(lowest, y + height)
	}

	let top = 0
	const output = doc.nodes.find(n => n.type === 'output')
	if (output) {
		top = nextOnGrid(place(output.id, 0, 0) + GAP_Y * 3)
	}
	// Nodes that are not connected to the output go below
	const consumed = new Set(doc.edges.map(e => e.from))
	for (const node of doc.nodes) {
		if (!placed.has(node.id) && !consumed.has(node.id)) {
			top = nextOnGrid(place(node.id, 1, top) + GAP_Y * 2)
		}
	}
	for (const node of doc.nodes) {
		if (!placed.has(node.id)) {
			top = nextOnGrid(place(node.id, 1, top) + GAP_Y * 2)
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
