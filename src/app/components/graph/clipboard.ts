import { useEffect, useState } from 'preact/hooks'
import type { GEdge, GNode } from './types.js'

/** Nodes that were copied, with the connections between them */
export interface Clip {
	/** The kind of graph and the format of its nodes. Nodes can only be pasted into a graph of the same type. */
	type: string
	nodes: GNode[]
	edges: GEdge[]
	/** How often this was pasted, so the next copy does not land exactly on the last one */
	pastes: number
}

const STORAGE_KEY = 'misode_graph_clipboard'

let clip: Clip | undefined
let restored = false
const listeners = new Set<() => void>()

/** What was copied last, also in another preset or before the page was reloaded */
export function readClip(): Clip | undefined {
	if (!restored) {
		restored = true
		try {
			const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')
			if (typeof stored?.type === 'string' && Array.isArray(stored.nodes) && Array.isArray(stored.edges)) {
				clip = { type: stored.type, nodes: stored.nodes, edges: stored.edges, pastes: 0 }
			}
		} catch (e) {
			// Without storage, copies last until the page is closed
		}
	}
	return clip
}

export function writeClip(type: string, nodes: GNode[], edges: GEdge[]) {
	restored = true
	clip = { type, nodes: structuredClone(nodes), edges: structuredClone(edges), pastes: 0 }
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ type, nodes: clip.nodes, edges: clip.edges }))
	} catch (e) {
		// Without storage, copies last until the page is closed
	}
	for (const fn of [...listeners]) fn()
}

/** How many nodes can be pasted into a graph of this type */
export function useClipCount(type: string): number {
	const [, setTick] = useState(0)
	useEffect(() => {
		const fn = () => setTick(t => t + 1)
		listeners.add(fn)
		return () => {
			listeners.delete(fn)
		}
	}, [])
	const current = readClip()
	return current?.type === type ? current.nodes.length : 0
}
