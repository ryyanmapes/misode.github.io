import { createContext } from 'preact'
import { memo } from 'preact/compat'
import { useContext, useEffect, useRef, useState } from 'preact/hooks'
import type { ColormapType } from '../../previews/Colormap.js'
import type { GraphStore } from '../store.js'
import type { GNode, GraphKind, NodeLinks, NodeRenderProps } from '../types.js'
import { formatNumber, IdSelect, NumberField, prettyId } from '../ui.jsx'
import type { NoiseShape, WorldgenEnv } from '../worldgen.js'
import { createDensitySampler } from '../worldgen.js'
import { hasThumb, HEADER_H, NODE_W, nodeHeight, PAD_TOP, ROW_H } from './convert.js'
import type { ThumbResult, ThumbView } from './render.js'
import { colorizeDensity, deltaSampler, requestThumb, sliceSampler, THUMB_COLS, THUMB_ROWS } from './render.js'
import type { DensitySchema, DField } from './schema.js'
import { CATEGORIES, fieldLabel } from './schema.js'

export interface DensityContextValue {
	env: WorldgenEnv | undefined
	seed: bigint
	shape: NoiseShape
	colormap: ColormapType
	/** Whether only the sign of the density is shown */
	binary: boolean
	/** The density at the ends of the colormap when the scale of the colors is fixed */
	scale: number | undefined
	/** What the previews on nodes show */
	view: ThumbView
	/** The JSON of what a node outputs, as a string */
	keyOf: (id: string) => string | undefined
	/** The JSON of the input that a node is compared with when the previews show deltas. Nothing for a node without inputs. */
	deltaOf: (id: string) => string | undefined
	/** Reports whether the function of a node could be evaluated */
	onStatus?: (id: string, error: string | undefined) => void
	/** The ids that exist, for the nodes that refer to one */
	registries?: Map<string, string[]>
}

export const DensityContext = createContext<DensityContextValue>({
	env: undefined,
	seed: BigInt(0),
	shape: { minY: 0, height: 128, legacyRandom: false, xzSize: 1, ySize: 2 },
	colormap: 'viridis',
	binary: false,
	scale: undefined,
	view: { mode: 'x', layer: 0, delta: false, centerH: 0, minV: 0, maxV: 128 },
	keyOf: () => undefined,
	deltaOf: () => undefined,
})

function Thumb({ id }: { id: string }) {
	const ctx = useContext(DensityContext)
	const canvas = useRef<HTMLCanvasElement>(null)
	const [result, setResult] = useState<ThumbResult>()
	// The previous image stays until the new one is computed
	const [pending, setPending] = useState(false)
	const key = ctx.keyOf(id)
	const { env, seed, shape, view } = ctx
	// With deltas the preview is what the node changed about one of its inputs
	const base = view.delta ? ctx.deltaOf(id) : undefined

	useEffect(() => {
		if (!env || key === undefined) return
		const cacheKey = `${env.version}|${env.rev}|${seed}|${shape.minY}|${shape.height}|${shape.legacyRandom}|${shape.xzSize}|${shape.ySize}|${view.mode}|${view.layer}|${view.delta}|${view.centerH}|${view.minV}|${view.maxV}|${key}|${base}`
		let done = false
		const sampler = () => {
			const fn = createDensitySampler(env, JSON.parse(key), seed, shape)
			if (!view.delta) return sliceSampler(fn, view.mode, view.layer)
			return sliceSampler(deltaSampler(fn, base === undefined ? undefined : createDensitySampler(env, JSON.parse(base), seed, shape)), view.mode, view.layer)
		}
		const cancel = requestThumb(cacheKey, sampler, view, next => {
			done = true
			setResult(next)
			setPending(false)
		})
		if (!done) setPending(true)
		return cancel
	}, [env, key, base, seed, shape.minY, shape.height, shape.legacyRandom, shape.xzSize, shape.ySize, view])

	const error = result && 'error' in result ? result.error : undefined
	useEffect(() => {
		ctx.onStatus?.(id, error)
	}, [id, error])

	useEffect(() => {
		const el = canvas.current
		if (!el || !result || 'error' in result) return
		const image = new ImageData(THUMB_COLS, THUMB_ROWS)
		colorizeDensity(result.values, image.data, ctx.colormap, ctx.binary, ctx.scale === undefined ? undefined : { limit: ctx.scale, min: 0, max: 0 })
		el.getContext('2d')?.putImageData(image, 0, 0)
	}, [result, ctx.colormap, ctx.binary, ctx.scale])

	return <div class={`gx-dn-thumb${result ? '' : ' is-loading'}${error ? ' is-error' : ''}`} aria-hidden="true" data-pending={pending ? 'true' : undefined}>
		<canvas ref={canvas} width={THUMB_COLS} height={THUMB_ROWS} />
		{error && <span class="gx-dn-thumb-error" title={error}>Cannot preview</span>}
	</div>
}

function fieldText(field: DField, value: unknown) {
	if (field.kind === 'id') {
		return typeof value === 'string' ? prettyId(value) : '—'
	}
	if (field.kind === 'enum') {
		return typeof value === 'string' ? value.replace(/_/g, ' ') : field.def.replace(/_/g, ' ')
	}
	if (field.kind === 'json') {
		const text = JSON.stringify(value)
		return text === undefined ? '—' : text.length > 18 ? `${text.slice(0, 16)}…` : text
	}
	return String(value)
}

interface NodeIdProps {
	store: GraphStore
	nodeId: string
	name: string
	label: string
	value: string
	options: string[]
}
/** The choice of an id on a node. It only draws again when the id or what can be chosen changes, since the lists are long. */
const NodeId = memo(function NodeId({ store, nodeId, name, label, value, options }: NodeIdProps) {
	return <IdSelect class="gx-dn-select" label={label} value={value} options={options}
		onChange={next => {
			const values = store.doc.nodes.find(n => n.id === nodeId)?.data.values ?? {}
			store.setData(nodeId, { values: { ...values, [name]: next } }, name)
		}} />
})

function DensityNodeView({ node, links, store, dropPort, readOnly, schema, thumbs }: NodeRenderProps & { schema: DensitySchema, thumbs: boolean }) {
	const { registries } = useContext(DensityContext)
	const def = schema.get(node.type)
	const category = CATEGORIES[def.category]
	const values: Record<string, any> = node.data.values ?? {}
	const setValue = (name: string, value: unknown) => {
		store.setData(node.id, { values: { ...values, [name]: value } }, name)
	}
	const rawType = node.type === 'raw' && typeof node.data.json?.type === 'string' ? prettyId(node.data.json.type) : undefined

	return <div class={`gx-dn gx-dn-cat-${def.category}`} style={{ '--cat': category.color }}>
		<div class="gx-dn-head" style={{ height: `${HEADER_H}px` }}>
			<span class="gx-dot" />
			<span class="gx-dn-title">{def.label}</span>
			{node.type !== 'output' && <span class={`gx-port gx-port-out${(links.outs.out?.length ?? 0) > 0 ? ' is-connected' : ''}${dropPort === 'out' ? ' is-hot' : ''}`}
				data-port="out" data-dir="out" title="Output: drag to connect" />}
		</div>
		{(def.fields.length > 0 || node.type === 'raw') && <div class="gx-dn-body" style={{ paddingTop: `${PAD_TOP}px` }}>
			{node.type === 'raw' && <div class="gx-dn-row" style={{ height: `${ROW_H}px` }}>
				<span class="gx-dn-label">Type</span>
				<span class="gx-dn-value" title="Edit the JSON in the panel on the right">{rawType ?? 'JSON'}</span>
			</div>}
			{def.fields.map(field => {
				const label = fieldLabel(field)
				if (field.kind === 'input') {
					const connected = (links.ins[field.name]?.length ?? 0) > 0
					return <div key={field.name} class="gx-dn-row" style={{ height: `${ROW_H}px` }} title={field.hint}>
						<span class={`gx-port gx-port-in${connected ? ' is-connected' : ''}${dropPort === field.name ? ' is-hot' : ''}`}
							data-port={field.name} data-dir="in" title={connected ? `${label}: drag to reconnect` : `${label}: drag to connect`} />
						<span class="gx-dn-label">{label}</span>
						{!connected && readOnly && <span class="gx-dn-value">{typeof values[field.name] === 'number' ? formatNumber(values[field.name]) : field.optional ? '—' : '0'}</span>}
						{!connected && !readOnly && <NumberField class="gx-dn-number" label={`${label} constant`}
							value={typeof values[field.name] === 'number' ? values[field.name] : undefined}
							placeholder={field.optional ? '—' : '0'}
							onChange={v => setValue(field.name, v)}
							onClear={() => setValue(field.name, undefined)} />}
					</div>
				}
				if (field.kind === 'number') {
					return <div key={field.name} class="gx-dn-row" style={{ height: `${ROW_H}px` }} title={field.hint}>
						<span class="gx-dn-label">{label}</span>
						{readOnly
							? <span class="gx-dn-value">{formatNumber(typeof values[field.name] === 'number' ? values[field.name] : field.def)}</span>
							: <NumberField class="gx-dn-number" label={label} int={field.int} value={typeof values[field.name] === 'number' ? values[field.name] : field.def}
								onChange={v => setValue(field.name, v)} />}
					</div>
				}
				const ids = field.kind === 'id' && !readOnly ? registries?.get(field.registry) : undefined
				if (ids && ids.length > 0) {
					const value = typeof values[field.name] === 'string' ? values[field.name] as string : ''
					return <div key={field.name} class={`gx-dn-row${def.fields.length === 1 ? ' gx-dn-row-wide' : ''}`} style={{ height: `${ROW_H}px` }} title={value === '' ? field.hint : value}>
						<span class="gx-dn-label">{label}</span>
						<NodeId store={store} nodeId={node.id} name={field.name} label={label} value={value} options={ids} />
					</div>
				}
				return <div key={field.name} class="gx-dn-row" style={{ height: `${ROW_H}px` }} title={field.hint}>
					<span class="gx-dn-label">{label}</span>
					<span class="gx-dn-value" title={typeof values[field.name] === 'string' ? values[field.name] : undefined}>{fieldText(field, values[field.name])}</span>
				</div>
			})}
		</div>}
		{thumbs && hasThumb(node) && <Thumb id={node.id} />}
	</div>
}

export function densityTitle(node: GNode, schema: DensitySchema) {
	const def = schema.get(node.type)
	if (node.type === 'reference' && typeof node.data.values?.id === 'string') {
		return `${def.label} ${prettyId(node.data.values.id)}`
	}
	const constant = node.type === 'constant' ? node.data.values?.[def.fields[0]?.name] : undefined
	if (typeof constant === 'number') {
		return `${def.label} ${formatNumber(constant)}`
	}
	if (node.type === 'raw' && typeof node.data.json?.type === 'string') {
		return `${def.label} ${prettyId(node.data.json.type)}`
	}
	return def.label
}

function inputNames(node: GNode, schema: DensitySchema) {
	return schema.get(node.type).fields.filter(f => f.kind === 'input').map(f => f.name)
}

export function createDensityKind(schema: DensitySchema, thumbs: boolean): GraphKind {
	const title = (node: GNode) => densityTitle(node, schema)
	return {
		edgeStyle: 'bezier',
		maxOut: Infinity,
		maxIn: 1,
		palette: schema.addable.map(def => ({
			type: def.type,
			label: def.label,
			category: CATEGORIES[def.category].label,
			description: def.description,
			color: CATEGORIES[def.category].color,
			keywords: def.keywords,
			hasInputs: def.fields.some(f => f.kind === 'input'),
			hasOutput: true,
		})),
		size: node => ({ w: NODE_W, h: nodeHeight(node, schema, thumbs) }),
		inPorts: node => inputNames(node, schema),
		outPorts: node => node.type === 'output' ? [] : ['out'],
		inPos: (node, port) => {
			const index = Math.max(0, schema.get(node.type).fields.findIndex(f => f.name === port))
			return { x: 0, y: HEADER_H + PAD_TOP + index * ROW_H + ROW_H / 2, side: 'left' }
		},
		outPos: () => ({ x: NODE_W, y: HEADER_H / 2, side: 'right' }),
		defaultIn: (node: GNode, links: NodeLinks) => {
			const names = inputNames(node, schema)
			return names.find(name => (links.ins[name]?.length ?? 0) === 0) ?? names[0]
		},
		defaultOut: node => node.type === 'output' ? undefined : 'out',
		create: type => {
			if (type === 'raw') {
				return { type, data: { json: structuredClone(schema.rawExample) } }
			}
			const values: Record<string, unknown> = {}
			for (const field of schema.get(type).fields) {
				if (field.kind === 'input') {
					if (!field.optional) values[field.name] = 0
				} else if (!(field.kind === 'enum' && field.optional)) {
					values[field.name] = structuredClone(field.def)
				}
			}
			return { type, data: { values } }
		},
		deletable: node => node.type !== 'output',
		title,
		color: node => CATEGORIES[schema.get(node.type).category].color,
		describe: (node, links, doc) => {
			const def = schema.get(node.type)
			const parts = def.fields.map(field => {
				const label = fieldLabel(field)
				if (field.kind !== 'input') {
					return `${label} ${fieldText(field, node.data.values?.[field.name])}`
				}
				const edge = links.ins[field.name]?.[0]
				if (edge) {
					const source = doc.nodes.find(n => n.id === edge.from)
					return `${label} from ${source ? title(source) : 'a node'}`
				}
				const value = node.data.values?.[field.name]
				return `${label} ${typeof value === 'number' ? formatNumber(value) : field.optional ? 'not set' : '0'}`
			})
			const uses = links.outs.out?.length ?? 0
			return `${title(node)}. ${parts.join(', ')}${parts.length > 0 ? '. ' : ''}${node.type === 'output' ? '' : uses === 0 ? 'Output not connected.' : `Output used ${uses} time${uses === 1 ? '' : 's'}.`}`
		},
		render: props => <DensityNodeView {...props} schema={schema} thumbs={thumbs} />,
	}
}
