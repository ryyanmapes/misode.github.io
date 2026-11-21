import { useEffect, useRef, useState } from 'preact/hooks'
import { GRID } from './geometry.js'
import type { GDoc, GEdge, GNode, GraphKind, NodeLinks } from './types.js'

const MAX_HISTORY = 200
const COALESCE_WINDOW = 1200

export function newId(prefix = 'n') {
	return `${prefix}${Math.random().toString(36).slice(2, 10)}`
}

export function indexLinks(doc: GDoc): Map<string, NodeLinks> {
	const map = new Map<string, NodeLinks>()
	const get = (id: string) => {
		let links = map.get(id)
		if (!links) {
			links = { ins: {}, outs: {} }
			map.set(id, links)
		}
		return links
	}
	for (const edge of doc.edges) {
		(get(edge.to).ins[edge.toPort] ??= []).push(edge);
		(get(edge.from).outs[edge.fromPort] ??= []).push(edge)
	}
	return map
}

/** Whether adding an edge from -> to would create a cycle */
export function wouldCycle(doc: GDoc, from: string, to: string) {
	if (from === to) return true
	const next = new Map<string, string[]>()
	for (const edge of doc.edges) {
		const list = next.get(edge.from)
		if (list) list.push(edge.to)
		else next.set(edge.from, [edge.to])
	}
	const seen = new Set<string>()
	const stack = [to]
	while (stack.length > 0) {
		const id = stack.pop()!
		if (id === from) return true
		if (seen.has(id)) continue
		seen.add(id)
		for (const n of next.get(id) ?? []) stack.push(n)
	}
	return false
}

export function connect(doc: GDoc, kind: GraphKind, from: string, fromPort: string, to: string, toPort: string): GDoc {
	if (wouldCycle(doc, from, to)) return doc
	let edges = doc.edges.filter(e => !(e.from === from && e.fromPort === fromPort && e.to === to && e.toPort === toPort))
	if (kind.maxOut === 1) {
		edges = edges.filter(e => !(e.from === from && e.fromPort === fromPort))
	}
	if (kind.maxIn === 1) {
		edges = edges.filter(e => !(e.to === to && e.toPort === toPort))
	}
	edges.push({ id: newId('e'), from, fromPort, to, toPort })
	return { nodes: doc.nodes, edges }
}

export function removeNodes(doc: GDoc, ids: Iterable<string>, edgeIds: Iterable<string> = []): GDoc {
	const nodeSet = new Set(ids)
	const edgeSet = new Set(edgeIds)
	if (nodeSet.size === 0 && edgeSet.size === 0) return doc
	return {
		nodes: nodeSet.size === 0 ? doc.nodes : doc.nodes.filter(n => !nodeSet.has(n.id)),
		edges: doc.edges.filter(e => !edgeSet.has(e.id) && !nodeSet.has(e.from) && !nodeSet.has(e.to)),
	}
}

export function updateNode(doc: GDoc, id: string, update: (node: GNode) => GNode): GDoc {
	return { nodes: doc.nodes.map(n => n.id === id ? update(n) : n), edges: doc.edges }
}

export function setNodeData(doc: GDoc, id: string, patch: Record<string, any>): GDoc {
	return updateNode(doc, id, n => ({ ...n, data: { ...n.data, ...patch } }))
}

export class GraphStore {
	doc: GDoc
	selection: string[] = []
	edgeSelection: string[] = []
	/** Increases every time the document is replaced as a whole (load, reset) */
	epoch = 0

	private readonly past: GDoc[] = []
	private future: GDoc[] = []
	private lastCoalesce: string | undefined
	private lastCoalesceTime = 0
	private transientBase: GDoc | undefined
	private readonly listeners = new Set<() => void>()

	/**
	 * A graph that is read-only keeps its document as it is. It can still be looked
	 * at and selected, which is what copying needs.
	 */
	constructor(doc: GDoc, readonly readOnly = false) {
		this.doc = doc
	}

	subscribe(fn: () => void) {
		this.listeners.add(fn)
		return () => {
			this.listeners.delete(fn)
		}
	}

	private emit() {
		for (const fn of [...this.listeners]) fn()
	}

	get canUndo() {
		return this.past.length > 0
	}

	get canRedo() {
		return this.future.length > 0
	}

	node(id: string | undefined) {
		return id === undefined ? undefined : this.doc.nodes.find(n => n.id === id)
	}

	/** The node that the inspector should show */
	get primary() {
		return this.node(this.selection[this.selection.length - 1])
	}

	private pruneSelection() {
		const nodes = new Set(this.doc.nodes.map(n => n.id))
		const edges = new Set(this.doc.edges.map(e => e.id))
		if (this.selection.some(id => !nodes.has(id))) {
			this.selection = this.selection.filter(id => nodes.has(id))
		}
		if (this.edgeSelection.some(id => !edges.has(id))) {
			this.edgeSelection = this.edgeSelection.filter(id => edges.has(id))
		}
	}

	/** Replaces the document and records an undo step. Edits with the same coalesce key are merged. */
	setDoc(doc: GDoc, opts: { coalesce?: string } = {}) {
		if (doc === this.doc || this.readOnly) return
		const now = Date.now()
		const merge = opts.coalesce !== undefined
			&& opts.coalesce === this.lastCoalesce
			&& now - this.lastCoalesceTime < COALESCE_WINDOW
			&& this.past.length > 0
		if (!merge) {
			this.past.push(this.doc)
			if (this.past.length > MAX_HISTORY) this.past.shift()
		}
		this.lastCoalesce = opts.coalesce
		this.lastCoalesceTime = now
		this.future = []
		this.doc = doc
		this.pruneSelection()
		this.emit()
	}

	/** Starts a gesture (like dragging) that only records one undo step when it ends */
	beginTransient() {
		this.transientBase = this.doc
	}

	setTransient(doc: GDoc) {
		if (doc === this.doc || this.readOnly) return
		this.doc = doc
		this.emit()
	}

	endTransient() {
		const base = this.transientBase
		this.transientBase = undefined
		if (base && base !== this.doc) {
			this.past.push(base)
			if (this.past.length > MAX_HISTORY) this.past.shift()
			this.future = []
			this.lastCoalesce = undefined
			this.pruneSelection()
			this.emit()
		}
	}

	cancelTransient() {
		const base = this.transientBase
		this.transientBase = undefined
		if (base && base !== this.doc) {
			this.doc = base
			this.emit()
		}
	}

	/** Replaces the whole document, for example when resetting to the preset. Can be undone. */
	load(doc: GDoc) {
		if (this.readOnly) return
		this.epoch += 1
		this.selection = []
		this.edgeSelection = []
		this.setDoc(doc)
	}

	undo() {
		if (this.readOnly) return
		const doc = this.past.pop()
		if (!doc) return
		this.future.push(this.doc)
		this.doc = doc
		this.lastCoalesce = undefined
		this.pruneSelection()
		this.emit()
	}

	redo() {
		if (this.readOnly) return
		const doc = this.future.pop()
		if (!doc) return
		this.past.push(this.doc)
		this.doc = doc
		this.lastCoalesce = undefined
		this.pruneSelection()
		this.emit()
	}

	select(nodes: string[], edges: string[] = []) {
		const same = nodes.length === this.selection.length && nodes.every((id, i) => id === this.selection[i])
			&& edges.length === this.edgeSelection.length && edges.every((id, i) => id === this.edgeSelection[i])
		if (same) return
		this.selection = nodes
		this.edgeSelection = edges
		this.emit()
	}

	toggle(id: string) {
		this.select(this.selection.includes(id) ? this.selection.filter(s => s !== id) : [...this.selection, id], [])
	}

	setData(id: string, patch: Record<string, any>, coalesce?: string) {
		this.setDoc(setNodeData(this.doc, id, patch), { coalesce: coalesce ? `${id}:${coalesce}` : undefined })
	}

	connect(kind: GraphKind, from: string, fromPort: string, to: string, toPort: string) {
		this.setDoc(connect(this.doc, kind, from, fromPort, to, toPort))
	}

	disconnect(edgeIds: string[]) {
		this.setDoc(removeNodes(this.doc, [], edgeIds))
	}

	deleteSelection(kind: GraphKind) {
		const nodes = this.selection.filter(id => {
			const node = this.node(id)
			return node && kind.deletable(node)
		})
		this.setDoc(removeNodes(this.doc, nodes, this.edgeSelection))
	}

	duplicateSelection(kind: GraphKind) {
		const originals = this.selection
			.map(id => this.node(id))
			.filter((n): n is GNode => n !== undefined && kind.deletable(n))
		if (originals.length === 0) return
		const ids = new Map(originals.map(n => [n.id, newId()]))
		const copies = originals.map(n => ({
			...n,
			id: ids.get(n.id)!,
			// One step of the canvas grid, so copies of snapped nodes stay on the grid
			x: n.x + GRID,
			y: n.y + GRID,
			data: structuredClone(n.data),
		}))
		// Keep the connections between the duplicated nodes
		const edges: GEdge[] = this.doc.edges
			.filter(e => ids.has(e.from) && ids.has(e.to))
			.map(e => ({ ...e, id: newId('e'), from: ids.get(e.from)!, to: ids.get(e.to)! }))
		this.setDoc({ nodes: [...this.doc.nodes, ...copies], edges: [...this.doc.edges, ...edges] })
		this.select(copies.map(n => n.id))
	}
}

/**
 * Returns the document, but keeps returning the same object while only positions change.
 * Use this for everything that depends on what the graph means instead of how it is laid out.
 */
export function useStructure(doc: GDoc): GDoc {
	const ref = useRef(doc)
	const prev = ref.current
	if (prev !== doc) {
		const same = prev.edges === doc.edges
			&& prev.nodes.length === doc.nodes.length
			&& prev.nodes.every((n, i) => {
				const other = doc.nodes[i]
				return n === other || (n.id === other.id && n.type === other.type && n.data === other.data)
			})
		if (!same) ref.current = doc
	}
	return ref.current
}

/** Re-renders the component whenever the store changes */
export function useStore(store: GraphStore) {
	const [, setTick] = useState(0)
	useEffect(() => {
		setTick(t => t + 1)
		return store.subscribe(() => setTick(t => t + 1))
	}, [store])
	return store
}
