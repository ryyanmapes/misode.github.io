import type { GNode, GraphFormat, GraphKind, NodeLinks, NodeRenderProps, PaletteItem } from '../types.js'
import { prettyId } from '../ui.jsx'
import { blockCss } from './blocks.js'
import { RULE_H, RULE_W, ruleSize, START_H, START_W } from './convert.js'
import { blockLabel, blockName, conditionText, conditionTypes, createCondition, ruleLabel } from './schema.js'

const COLORS: Record<string, string> = {
	start: 'var(--gx-primary)',
	condition: 'var(--gx-fc-cond-line)',
	block: 'var(--gx-fc-block-dot)',
	reference: 'var(--gx-fc-ref-line)',
	bandlands: 'var(--gx-fc-block-dot)',
	ore_vein: 'var(--gx-fc-block-dot)',
	raw: 'var(--gx-cat-sampling)',
}

const HEX_INSET = 16
const HEX_POINTS = `${HEX_INSET},1 ${RULE_W - HEX_INSET},1 ${RULE_W - 1},${RULE_H / 2} ${RULE_W - HEX_INSET},${RULE_H - 1} ${HEX_INSET},${RULE_H - 1} 1,${RULE_H / 2}`

export function materialTitle(node: GNode) {
	switch (node.type) {
		case 'start': return 'Start'
		case 'condition': {
			const { text, folded } = conditionText(node.data.cond, !!node.data.negate)
			return `If ${node.data.negate && !folded ? 'not ' : ''}${text}`
		}
		case 'block': return `Place ${blockLabel(node.data.state)}`
		case 'reference': return `Run ${ruleLabel(node.data.id)}`
		case 'bandlands': return 'Place bandlands'
		case 'ore_vein': return `Place a vein of ${blockLabel(node.data.json?.ore_block)}`
		default: return `Custom rule ${typeof node.data.json?.type === 'string' ? prettyId(node.data.json.type) : ''}`.trim()
	}
}

function Port({ name, connected, hot, title }: { name: string, connected: boolean, hot: boolean, title: string }) {
	return <>
		<span class={`gx-port gx-port-${name}${connected ? ' is-connected' : ''}${hot ? ' is-hot' : ''}`} data-port={name} data-dir="out" title={title} />
		{name !== 'next' && <span class={`gx-fc-portlabel gx-fc-portlabel-${name}`} aria-hidden="true">{name}</span>}
	</>
}

function MaterialNodeView({ node, links }: NodeRenderProps) {
	const has = (port: string) => (links.outs[port]?.length ?? 0) > 0
	const elsePort = <Port name="else" connected={has('else')} hot={false}
		title="Else: drag to the step that is tried when this one does not place a block" />

	if (node.type === 'start') {
		return <div class="gx-fc gx-fc-start">
			<span class="gx-fc-name">Start</span>
			<Port name="next" connected={has('next')} hot={false} title="Drag to the first step" />
		</div>
	}
	if (node.type === 'condition') {
		const { text, folded } = conditionText(node.data.cond, !!node.data.negate)
		const negated = !!node.data.negate && !folded
		return <div class="gx-fc gx-fc-cond">
			<svg class="gx-fc-shape" viewBox={`0 0 ${RULE_W} ${RULE_H}`} aria-hidden="true">
				<polygon points={HEX_POINTS} />
			</svg>
			<div class="gx-fc-content">
				<span class="gx-fc-tag">{negated ? 'If not' : 'If'}</span>
				<span class="gx-fc-name" title={text}>{text}</span>
			</div>
			<Port name="then" connected={has('then')} hot={false} title="Then: drag to the step that runs when this is true" />
			{elsePort}
		</div>
	}
	if (node.type === 'block') {
		const name = blockName(node.data.state)
		return <div class="gx-fc gx-fc-block">
			<span class="gx-fc-swatch" style={{ background: blockCss(name) }} />
			<div class="gx-fc-lines">
				<span class="gx-fc-over">Place block</span>
				<span class="gx-fc-name" title={name}>{blockLabel(node.data.state)}</span>
			</div>
			{has('else') && elsePort}
		</div>
	}
	if (node.type === 'bandlands') {
		return <div class="gx-fc gx-fc-block">
			<span class="gx-fc-swatch gx-fc-bands" />
			<div class="gx-fc-lines">
				<span class="gx-fc-over">Place</span>
				<span class="gx-fc-name">Bandlands</span>
			</div>
			{elsePort}
		</div>
	}
	if (node.type === 'ore_vein') {
		const ore = blockName(node.data.json?.ore_block)
		return <div class="gx-fc gx-fc-block">
			<span class="gx-fc-swatch" style={{ background: blockCss(ore) }} />
			<div class="gx-fc-lines">
				<span class="gx-fc-over">Ore vein</span>
				<span class="gx-fc-name" title={ore}>{blockLabel(node.data.json?.ore_block)}</span>
			</div>
			{elsePort}
		</div>
	}
	if (node.type === 'reference') {
		return <div class="gx-fc gx-fc-ref">
			<div class="gx-fc-lines">
				<span class="gx-fc-over">Run rule</span>
				<span class="gx-fc-name" title={String(node.data.id)}>{ruleLabel(node.data.id)}</span>
			</div>
			{elsePort}
		</div>
	}
	return <div class="gx-fc gx-fc-raw">
		<div class="gx-fc-lines">
			<span class="gx-fc-over">Custom rule</span>
			<span class="gx-fc-name">{typeof node.data.json?.type === 'string' ? prettyId(node.data.json.type) : 'JSON'}</span>
		</div>
		{elsePort}
	</div>
}

const CONDITION_PREFIX = 'condition:'

const palette = (format: GraphFormat): PaletteItem[] => [
	...conditionTypes(format).map(def => ({
		type: `${CONDITION_PREFIX}${def.type}`,
		label: def.label,
		category: 'Conditions',
		description: def.description,
		color: COLORS.condition,
		keywords: `if ${def.keywords ?? ''}`,
		hasInputs: true,
		hasOutput: true,
	})),
	{ type: 'block', label: 'Place block', category: 'Results', description: 'Places a block and stops', color: COLORS.block, keywords: 'result state', hasInputs: true, hasOutput: false },
	// Since 26.3 the game has rules with an id. Before that, the editor copies a rule to where it is run.
	{ type: 'reference', label: 'Run rule', category: 'Results', description: format === 'modern' ? 'Runs a rule by its id' : 'Runs another surface rule of this dimension', color: COLORS.reference, keywords: 'named reference bedrock', hasInputs: true, hasOutput: true },
	{ type: 'bandlands', label: 'Bandlands', category: 'Results', description: 'Places the bands of terracotta of the badlands', color: COLORS.bandlands, keywords: 'badlands terracotta mesa stripes', hasInputs: true, hasOutput: true },
	// Before 26.3 ore veins are a setting of the dimension and not a rule
	...(format === 'modern' ? [{ type: 'ore_vein', label: 'Ore vein', category: 'Results', description: 'Places a large vein of ore with a filler block', color: COLORS.ore_vein, keywords: 'copper iron raw granite tuff', hasInputs: true, hasOutput: true }] : []),
]

const createMaterialKind = (format: GraphFormat): GraphKind => ({
	edgeStyle: 'step',
	// Green for what happens when a condition holds, red for what is tried when a step places nothing
	edgeClass: edge => edge.fromPort === 'then' ? 'gx-edge-then' : edge.fromPort === 'else' ? 'gx-edge-else' : undefined,
	maxOut: 1,
	maxIn: Infinity,
	palette: palette(format),
	size: ruleSize,
	inPorts: node => node.type === 'start' ? [] : ['in'],
	outPorts: node => node.type === 'start' ? ['next'] : node.type === 'condition' ? ['then', 'else'] : ['else'],
	inPos: (_node, _port, fromPort) => fromPort === 'then'
		? { x: 0, y: RULE_H / 2, side: 'left' }
		: { x: RULE_W / 2, y: 0, side: 'top' },
	outPos: (node, port) => {
		if (node.type === 'start') return { x: START_W / 2, y: START_H, side: 'bottom' }
		if (port === 'then') return { x: RULE_W, y: RULE_H / 2, side: 'right' }
		return { x: RULE_W / 2, y: RULE_H, side: 'bottom' }
	},
	defaultIn: node => node.type === 'start' ? undefined : 'in',
	defaultOut: () => undefined,
	create: type => {
		if (type.startsWith(CONDITION_PREFIX)) {
			return { type: 'condition', data: { cond: createCondition(type.slice(CONDITION_PREFIX.length), format), negate: false } }
		}
		if (type === 'block') return { type, data: { state: format === 'modern' ? 'minecraft:netherrack' : { Name: 'minecraft:stone' } } }
		if (type === 'reference') return { type, data: { id: format === 'modern' ? 'minecraft:bedrock_floor' : '' } }
		if (type === 'ore_vein') {
			// The copper vein of the game
			return { type, data: { json: {
				type: 'minecraft:ore_vein',
				density: 'minecraft:overworld/ore_vein/copper_density',
				filler_block: 'minecraft:granite',
				filler_gap: 'minecraft:overworld/ore_vein/gap',
				ore_block: 'minecraft:copper_ore',
				raw_ore_block: 'minecraft:raw_copper_block',
				raw_ore_chance: 0.02,
				richness: 'minecraft:overworld/ore_vein/richness',
			} } }
		}
		return { type: 'bandlands', data: { json: { type: 'minecraft:bandlands' } } }
	},
	deletable: node => node.type !== 'start',
	title: materialTitle,
	color: node => COLORS[node.type] ?? COLORS.raw,
	describe: (node: GNode, links: NodeLinks, doc) => {
		const target = (port: string) => {
			const edge = links.outs[port]?.[0]
			const next = edge ? doc.nodes.find(n => n.id === edge.to) : undefined
			return next ? materialTitle(next) : 'nothing'
		}
		if (node.type === 'start') return `Start. First step: ${target('next')}.`
		if (node.type === 'condition') return `${materialTitle(node)}. Then: ${target('then')}. Else: ${target('else')}.`
		if (node.type === 'block') return `${materialTitle(node)}.`
		return `${materialTitle(node)}. Else: ${target('else')}.`
	},
	render: props => <MaterialNodeView {...props} />,
})

export const materialKinds: Record<GraphFormat, GraphKind> = {
	modern: createMaterialKind('modern'),
	legacy: createMaterialKind('legacy'),
}
