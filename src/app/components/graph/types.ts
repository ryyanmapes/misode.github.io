import type { ComponentChildren } from 'preact'
import type { GraphStore } from './store.js'

/**
 * Which JSON format a graph reads and writes.
 * `modern` is the format of 26.3, `legacy` the one of 1.19.2.
 */
export type GraphFormat = 'modern' | 'legacy'

/** A range of heights. The top is exclusive, so it is the edge above the highest block. */
export interface HeightRange {
	min: number
	max: number
}

/** Choices about how the editor shows things, shared by both graphs */
export interface ViewOptions {
	/** Whether nodes snap to the dots of the canvas when they are placed or moved */
	snap: boolean
	/** Whether previews are limited to a range of heights */
	limit: boolean
	/** The lowest and highest block that previews show when limited */
	minY: number
	maxY: number
	/** How far previews can be moved sideways, which is also the area that colors are based on */
	minX: number
	maxX: number
	minZ: number
	maxZ: number
	/** The ends of the sliders for constant values */
	sliderMin: number
	sliderMax: number
}

/** The view options as ranges that previews can use directly */
export interface PreviewBounds {
	x: HeightRange
	z: HeightRange
	/** The height limit, when it is turned on */
	y: HeightRange | undefined
	/** The ends of the sliders for constant values, both included */
	slider: HeightRange
}

export interface GNode {
	id: string
	type: string
	x: number
	y: number
	data: Record<string, any>
}

export interface GEdge {
	id: string
	from: string
	fromPort: string
	to: string
	toPort: string
}

export interface GDoc {
	nodes: GNode[]
	edges: GEdge[]
}

export type Side = 'left' | 'right' | 'top' | 'bottom'

export interface PortPos {
	x: number
	y: number
	side: Side
}

export interface Size {
	w: number
	h: number
}

export interface View {
	x: number
	y: number
	k: number
}

/** The connections of a single node, indexed by port */
export interface NodeLinks {
	ins: Record<string, GEdge[]>
	outs: Record<string, GEdge[]>
}

export const NO_LINKS: NodeLinks = { ins: {}, outs: {} }

/** The fixed end of a connection that is being dragged */
export interface LinkEnd {
	node: string
	port: string
	dir: 'in' | 'out'
}

export interface PaletteItem {
	type: string
	label: string
	category: string
	description: string
	color: string
	keywords?: string
	hasInputs: boolean
	hasOutput: boolean
}

export interface NodeRenderProps {
	node: GNode
	links: NodeLinks
	selected: boolean
	store: GraphStore
	/** The port that would be connected if the dragged link is dropped now */
	dropPort?: string
	/** Whether the node shows its values without a way to change them */
	readOnly?: boolean
}

/** Describes how a kind of graph looks and behaves */
export interface GraphKind {
	edgeStyle: 'bezier' | 'step'
	/** How many edges can leave a single output port */
	maxOut: number
	/** How many edges can enter a single input port */
	maxIn: number
	palette: PaletteItem[]
	size(node: GNode): Size
	inPorts(node: GNode): string[]
	outPorts(node: GNode): string[]
	inPos(node: GNode, port: string, fromPort: string): PortPos
	outPos(node: GNode, port: string): PortPos
	/** Which input receives a link that is dropped on the node body */
	defaultIn(node: GNode, links: NodeLinks): string | undefined
	/** Which output is used when a link is dragged from an input to the node body */
	defaultOut(node: GNode, links: NodeLinks): string | undefined
	/** Creates the node type and data for an item of the palette */
	create(type: string): { type: string, data: Record<string, any> }
	deletable(node: GNode): boolean
	title(node: GNode): string
	/** A CSS color to represent the node in the minimap */
	color(node: GNode): string
	describe(node: GNode, links: NodeLinks, doc: GDoc): string
	/** A class for connections that should stand out, for example by the port that they leave from */
	edgeClass?(edge: GEdge): string | undefined
	render(props: NodeRenderProps): ComponentChildren
}
