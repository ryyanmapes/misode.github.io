import { memo } from 'preact/compat'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Store } from '../../../Store.js'
import type { ColormapType } from '../../previews/Colormap.js'
import { ColormapTypes } from '../../previews/Colormap.js'
import { clamp } from '../geometry.js'
import type { CanvasApi, ViewMemo } from '../GraphCanvas.jsx'
import { GraphCanvas } from '../GraphCanvas.jsx'
import { Ico } from '../icons.jsx'
import type { GraphStore } from '../store.js'
import { connect, indexLinks, removeNodes, useStore, useStructure, wouldCycle } from '../store.js'
import { Toolbar } from '../Toolbar.jsx'
import type { GDoc, GNode, GraphKind, HeightRange, PreviewBounds, ViewOptions } from '../types.js'
import { NO_LINKS } from '../types.js'
import { sessionObject, useSessionState } from '../session.js'
import type { GraphFormat } from '../types.js'
import { Checkbox, CopyButton, Field, formatNumber, IconButton, IdSelect, JsonField, Lockable, NumberField, Section, Segmented, Select, Slider, sliderStep, useStoredFlag } from '../ui.jsx'
import type { Guide, HoverInfo, RasterSource, ViewportApi, ViewportMemo, VisibleArea } from '../Viewport2D.jsx'
import { Viewport2D } from '../Viewport2D.jsx'
import type { NoiseShape, WorldgenEnv } from '../worldgen.js'
import { createDensitySampler } from '../worldgen.js'
import { densityFromJson, densitySerializer, layoutDensity } from './convert.js'
import type { DensityContextValue } from './DensityKind.jsx'
import { createDensityKind, DensityContext, densityTitle } from './DensityKind.jsx'
import type { DensityRange, ThumbView, ViewMode } from './render.js'
import { AIR_COLOR, colorizeDensity, colormapGradient, deltaSampler, measureRegion, sliceSampler, SOLID_COLOR } from './render.js'
import type { DensitySchema, DField } from './schema.js'
import { CATEGORIES, fieldLabel } from './schema.js'

const THUMBS_KEY = 'misode_graph_thumbnails'
const BINARY_KEY = 'misode_graph_binary'
const SHOW_KEY = 'misode_graph_show'
const FOLLOW_KEY = 'misode_graph_follow_view'
const HEAT_KEY = 'misode_graph_heat'

/**
 * What the preview shows: the selected node, what that node changed about one of
 * its inputs, or the final density that the whole graph ends in.
 */
type Show = 'standard' | 'delta' | 'final'

const SHOWS: { value: Show, label: string }[] = [
	{ value: 'standard', label: 'Standard' },
	{ value: 'delta', label: 'Delta' },
	{ value: 'final', label: 'Final output' },
]

/**
 * How densities become colors. Adaptive spreads the colors over the values of the
 * node, fixed uses the same scale for every node so they can be compared.
 */
type Heat = 'adaptive' | 'fixed'

const HEATS: { value: Heat, label: string }[] = [
	{ value: 'adaptive', label: 'Adaptive' },
	{ value: 'fixed', label: 'Fixed' },
]

/** The scale slider is logarithmic, from 0.01 to 100 */
const SCALE_EXPONENT = 2

function storedChoice<T extends string>(key: string, options: { value: T }[], fallback: T): T {
	try {
		const stored = localStorage.getItem(key)
		return options.find(o => o.value === stored)?.value ?? fallback
	} catch (e) {
		return fallback
	}
}

function storeChoice(key: string, value: string) {
	try {
		localStorage.setItem(key, value)
	} catch (e) {
		// The choice still applies until the page is closed
	}
}

type Axis = 'x' | 'y' | 'z'

/** An input of a node that Delta can compare the node with */
interface DeltaInput {
	/** The name of the field of the node */
	name: string
	label: string
	/** The label with what is connected to the input, or the number that it holds */
	text: string
	/** The JSON of what the input is, as a string */
	json: string
	/** Whether nothing is connected, so the input is a number */
	constant: boolean
	/** Whether a noise is somewhere in what is connected */
	noisy: boolean
}

const NO_INPUTS: DeltaInput[] = []

/** The coordinates where a gradient starts and ends, shown as lines in the preview */
interface GradientLines {
	axis: Axis
	from: number
	to: number
	/** Missing when the gradient cannot be changed */
	onChange?: (which: 'from' | 'to', value: number) => void
}

/** How the density is turned into an image */
interface Display {
	colormap: ColormapType
	binary: boolean
	show: Show
	heat: Heat
	/** The density at the ends of the colormap when the heatmap is fixed */
	scale: number
	onChange: (patch: { colormap?: ColormapType, binary?: boolean, show?: Show, heat?: Heat, scale?: number }) => void
}

interface Props {
	store: GraphStore
	schema: DensitySchema
	format: GraphFormat
	env: WorldgenEnv | undefined
	registries: Map<string, string[]> | undefined
	/** What the graph is in a sentence: the final density, or the id of a density function */
	name: string
	shape: NoiseShape
	seed: bigint
	onNewSeed: () => void
	/** The density function that the graph started as, used when resetting */
	preset: unknown
	/** What resetting is called */
	resetLabel: string
	options: ViewOptions
	onOptions: (patch: Partial<ViewOptions>) => void
	bounds: PreviewBounds
	viewMemo: ViewMemo
}
export function DensityEditor({ store, schema, format, env, registries, name, shape, seed, onNewSeed, preset, resetLabel, options, onOptions, bounds, viewMemo }: Props) {
	useStore(store)
	const [thumbs, setThumbs] = useStoredFlag(THUMBS_KEY, true)
	const [binary, setBinary] = useStoredFlag(BINARY_KEY, false)
	const [follow, setFollow] = useStoredFlag(FOLLOW_KEY, true)
	const [show, setShow] = useState<Show>(() => storedChoice(SHOW_KEY, SHOWS, 'standard'))
	const [heat, setHeat] = useState<Heat>(() => storedChoice(HEAT_KEY, HEATS, 'adaptive'))
	const [scale, setScale] = useSessionState('density.scale', 1)
	const [look, setLook] = useState<ThumbView>()
	const [colormap, setColormap] = useState<ColormapType>(Store.getColormap() ?? 'viridis')
	const [errors, setErrors] = useState<Record<string, string>>({})
	const api = useRef<CanvasApi>()
	const kind = useMemo(() => createDensityKind(schema, thumbs), [schema, thumbs])
	// Moving nodes around should not recompute the functions, thumbnails or inspector
	const doc = useStructure(store.doc)

	const serializer = useMemo(() => densitySerializer(doc, schema), [doc, schema])
	const keyOf = useMemo(() => {
		const keys = new Map<string, string>()
		return (id: string) => {
			let key = keys.get(id)
			if (key === undefined) {
				key = JSON.stringify(serializer(id))
				keys.set(id, key)
			}
			return key
		}
	}, [serializer])

	// Delta shows what a node changed about one of its inputs. These are the inputs of each node that it can be compared with.
	const deltaInputsOf = useMemo(() => {
		const links = indexLinks(doc)
		const nodes = new Map(doc.nodes.map(n => [n.id, n]))
		const noisy = new Map<string, boolean>()
		const hasNoise = (id: string): boolean => {
			const known = noisy.get(id)
			if (known !== undefined) return known
			// Counts as without noise while it is looked at, so a circle ends
			noisy.set(id, false)
			const node = nodes.get(id)
			let result = false
			if (node) {
				const def = schema.get(node.type)
				// What a reference, a spline or custom JSON leads to is not in the graph, so those count as noise
				result = def.category === 'noise' || node.type === 'reference' || node.type === 'raw' || node.type === 'spline'
					|| def.fields.some(field => field.kind === 'input' && (links.get(id)?.ins[field.name] ?? []).some(edge => hasNoise(edge.from)))
			}
			noisy.set(id, result)
			return result
		}
		const cache = new Map<string, DeltaInput[]>()
		return (id: string): DeltaInput[] => {
			let inputs = cache.get(id)
			if (inputs) return inputs
			inputs = []
			const node = nodes.get(id)
			for (const field of node ? schema.get(node.type).fields : []) {
				if (field.kind !== 'input') continue
				const label = fieldLabel(field)
				const edge = links.get(id)?.ins[field.name]?.[0]
				const source = edge ? nodes.get(edge.from) : undefined
				const value = node?.data.values?.[field.name]
				if (edge && source) {
					inputs.push({ name: field.name, label, text: `${label} · ${densityTitle(source, schema)}`, json: JSON.stringify(serializer(edge.from)), constant: false, noisy: hasNoise(edge.from) })
				} else if (typeof value === 'number' || !field.optional) {
					// An input that is left out is not there to compare with
					const constant = typeof value === 'number' ? value : 0
					inputs.push({ name: field.name, label, text: `${label} · ${formatNumber(constant)}`, json: JSON.stringify(constant), constant: true, noisy: false })
				}
			}
			cache.set(id, inputs)
			return inputs
		}
	}, [doc, schema, serializer])
	// The input that was chosen for a node, by the id of the node. Without a choice it is the first input that noise flows into.
	const [chosenInputs, setChosenInputs] = useState<Record<string, string>>({})
	const deltaInputOf = useCallback((id: string) => {
		const inputs = deltaInputsOf(id)
		return inputs.find(input => input.name === chosenInputs[id])
			?? inputs.find(input => !input.constant && input.noisy)
			?? inputs.find(input => !input.constant)
			?? inputs[0]
	}, [deltaInputsOf, chosenInputs])
	const deltaOf = useCallback((id: string) => deltaInputOf(id)?.json, [deltaInputOf])

	const onStatus = useCallback((id: string, error: string | undefined) => {
		setErrors(prev => {
			if (prev[id] === error) return prev
			const next = { ...prev }
			if (error === undefined) delete next[id]
			else next[id] = error
			return next
		})
	}, [])

	// The previews on nodes show the same as the big preview, a moment after it stops moving
	const lookTimer = useRef<number>()
	const onLook = useCallback((next: ThumbView) => {
		if (lookTimer.current !== undefined) clearTimeout(lookTimer.current)
		lookTimer.current = window.setTimeout(() => {
			setLook(prev => prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
		}, 250)
	}, [])
	useEffect(() => () => {
		if (lookTimer.current !== undefined) clearTimeout(lookTimer.current)
	}, [])
	const view = useMemo<ThumbView>(() => {
		if (follow && look) return look
		const heights = bounds.y ?? { min: shape.minY, max: shape.minY + shape.height }
		return { mode: 'x', layer: 0, delta: false, centerH: 0, minV: heights.min, maxV: heights.max }
	}, [follow, look, bounds.y, shape])
	const fixedScale = heat === 'fixed' ? scale : undefined
	const context = useMemo<DensityContextValue>(() => ({ env, seed, shape, colormap, binary, scale: fixedScale, view, keyOf, deltaOf, onStatus, registries }), [env, seed, shape, colormap, binary, fixedScale, view, keyOf, deltaOf, onStatus, registries])

	const output = doc.nodes.find(n => n.type === 'output')
	const primaryId = store.selection[store.selection.length - 1]
	const primary = doc.nodes.find(n => n.id === primaryId)
	const active = primary ?? output
	const activeId = active?.id
	const onDeltaInput = useCallback((name: string) => {
		if (activeId !== undefined) setChosenInputs(prev => prev[activeId] === name ? prev : { ...prev, [activeId]: name })
	}, [activeId])

	const display = useMemo<Display>(() => ({
		colormap,
		binary,
		show,
		heat,
		scale,
		onChange: patch => {
			if (patch.heat !== undefined) {
				setHeat(patch.heat)
				storeChoice(HEAT_KEY, patch.heat)
			}
			if (patch.scale !== undefined && patch.scale > 0) setScale(patch.scale)
			if (patch.colormap !== undefined) {
				Store.setColormap(patch.colormap)
				setColormap(patch.colormap)
			}
			if (patch.binary !== undefined) setBinary(patch.binary)
			if (patch.show !== undefined) {
				setShow(patch.show)
				storeChoice(SHOW_KEY, patch.show)
			}
		},
	}), [colormap, binary, show, heat, scale, setBinary])

	return <DensityContext.Provider value={context}>
		<div class="gx-editor">
			<Toolbar store={store} kind={kind} api={api} jsonName={name} clipType={`density:${format}`} resetLabel={resetLabel} options={options} onOptions={onOptions}
				getJson={() => JSON.stringify(output ? serializer(output.id) : 0, null, 2)}
				onTidy={() => {
					store.setDoc(layoutDensity(store.doc, schema, thumbs))
					requestAnimationFrame(() => api.current?.fit())
				}}
				onReset={() => store.load(densityFromJson(preset, schema, thumbs))}>
				<IconButton icon={Ico.image} label="Previews on nodes" active={thumbs} onClick={() => setThumbs(!thumbs)} />
				<IconButton icon={Ico.eye} label="Previews on nodes follow the view" active={follow && thumbs} disabled={!thumbs} onClick={() => setFollow(!follow)} />
			</Toolbar>
			<div class="gx-work">
				<div class="gx-stage">
					<GraphCanvas store={store} kind={kind} label={`Graph of ${name}`} clipType={`density:${format}`} apiRef={api} viewMemo={viewMemo} snap={options.snap} />
				</div>
				<aside class="gx-side" aria-label="Inspector">
					{active && <Inspector node={active} isFallback={primary === undefined} count={store.selection.length} doc={doc} store={store} kind={kind} schema={schema}
						json={keyOf(active.id)} registries={registries} env={env} shape={shape} seed={seed} onNewSeed={onNewSeed}
						finalJson={output ? keyOf(output.id) : undefined} onLook={onLook}
						deltaInputs={deltaInputsOf(active.id)} deltaInput={deltaInputOf(active.id)} onDeltaInput={onDeltaInput}
						display={display} bounds={bounds} error={errors[active.id]} />}
				</aside>
			</div>
		</div>
	</DensityContext.Provider>
}

interface InspectorProps {
	node: GNode
	/** Whether this node is shown because nothing is selected */
	isFallback: boolean
	count: number
	doc: GDoc
	store: GraphStore
	kind: GraphKind
	schema: DensitySchema
	json: string
	registries: Map<string, string[]> | undefined
	env: WorldgenEnv | undefined
	shape: NoiseShape
	seed: bigint
	onNewSeed: () => void
	/** The final density of the whole graph */
	finalJson: string | undefined
	onLook: (look: ThumbView) => void
	/** The inputs of the node that Delta can compare it with, and the one that it does */
	deltaInputs: DeltaInput[]
	deltaInput: DeltaInput | undefined
	onDeltaInput: (name: string) => void
	display: Display
	bounds: PreviewBounds
	error: string | undefined
}
const Inspector = memo(function Inspector({ node, isFallback, count, doc, store, kind, schema, json, registries, env, shape, seed, onNewSeed, finalJson, onLook, deltaInputs, deltaInput, onDeltaInput, display, bounds, error }: InspectorProps) {
	const def = schema.get(node.type)
	const category = CATEGORIES[def.category]

	// A gradient shows where it starts and ends in the preview
	const lines = useMemo<GradientLines | undefined>(() => {
		const gradient = def.gradient
		const values: Record<string, unknown> = node.data.values ?? {}
		if (!gradient) return undefined
		const from = values[gradient.from]
		const to = values[gradient.to]
		const axis = gradient.axis ?? (gradient.axisField ? values[gradient.axisField] : undefined)
		if (typeof from !== 'number' || typeof to !== 'number' || (axis !== 'x' && axis !== 'y' && axis !== 'z')) return undefined
		return {
			axis,
			from,
			to,
			onChange: store.readOnly ? undefined : (which, value) => {
				const name = which === 'from' ? gradient.from : gradient.to
				store.setData(node.id, { values: { ...store.node(node.id)?.data.values, [name]: value } }, name)
			},
		}
	}, [def, node, store])

	return <>
		<div class="gx-side-head">
			<span class="gx-dot gx-dot-lg" style={{ background: category.color }} />
			<div class="gx-side-title">
				<h2>{def.label}</h2>
				<p>{isFallback ? 'Nothing selected, showing the output' : count > 1 ? `${count} nodes selected` : def.description}</p>
			</div>
			{kind.deletable(node) && !store.readOnly && <>
				<IconButton icon={Ico.duplicate} label="Duplicate node" tipSide="left" onClick={() => store.duplicateSelection(kind)} />
				<IconButton icon={Ico.trash} label="Delete node" tipSide="left" onClick={() => store.deleteSelection(kind)} />
			</>}
		</div>
		<Preview nodeId={node.id} json={json} finalJson={finalJson} onLook={onLook} deltaInputs={deltaInputs} deltaInput={deltaInput} onDeltaInput={onDeltaInput} env={env} shape={shape} seed={seed} onNewSeed={onNewSeed} display={display} bounds={bounds} lines={lines}
			title={node.type === 'output' ? 'Final density' : densityTitle(node, schema)} thumbError={error} />
		{(def.fields.length > 0 || node.type === 'raw') && <Section title="Properties">
			<Lockable locked={store.readOnly}>
				<Properties node={node} doc={doc} store={store} kind={kind} schema={schema} registries={registries} slider={bounds.slider} />
			</Lockable>
		</Section>}
		<Section title="JSON" collapsible defaultOpen={false} actions={<CopyButton getText={() => JSON.stringify(JSON.parse(json), null, 2)} />}>
			<pre class="gx-json" tabIndex={0}>{JSON.stringify(JSON.parse(json), null, 2)}</pre>
		</Section>
	</>
})

type Mode = ViewMode

const MODES: { value: Mode, label: string }[] = [
	{ value: 'x', label: 'Side X' },
	{ value: 'z', label: 'Side Z' },
	{ value: 'top', label: 'Top' },
]

const VIEW: Record<Mode, { name: string, horizontal: 'x' | 'z', vertical: Axis, layer: Axis }> = {
	x: { name: 'Side', horizontal: 'x', vertical: 'y', layer: 'z' },
	z: { name: 'Side', horizontal: 'z', vertical: 'y', layer: 'x' },
	top: { name: 'Top', horizontal: 'x', vertical: 'z', layer: 'y' },
}

/** The views in which the lines of a gradient on this axis are visible */
const LINE_VIEWS: Record<Axis, string> = {
	x: 'Side X and Top',
	y: 'Side X and Side Z',
	z: 'Side Z and Top',
}

interface PreviewProps {
	nodeId: string
	json: string
	finalJson: string | undefined
	/** Reports what is visible, so the previews on nodes can show the same */
	onLook: (look: ThumbView) => void
	deltaInputs: DeltaInput[]
	deltaInput: DeltaInput | undefined
	onDeltaInput: (name: string) => void
	title: string
	env: WorldgenEnv | undefined
	shape: NoiseShape
	seed: bigint
	onNewSeed: () => void
	display: Display
	bounds: PreviewBounds
	lines: GradientLines | undefined
	thumbError: string | undefined
}
function Preview({ nodeId, json: nodeJson, finalJson, onLook, deltaInputs = NO_INPUTS, deltaInput, onDeltaInput, title: nodeTitle, env, shape, seed, onNewSeed, display, bounds, lines, thumbError }: PreviewProps) {
	const { colormap, binary, show, heat, scale } = display
	const delta = show === 'delta'
	// Choosing the final output leaves the previews on nodes as they were
	const nodeDelta = useRef(delta)
	if (show !== 'final') nodeDelta.current = delta
	const thumbDelta = nodeDelta.current
	// The final output can be watched while another node is selected and edited
	const showsFinal = show === 'final' && finalJson !== undefined
	const json = showsFinal ? finalJson : nodeJson
	const title = showsFinal ? 'Final density' : nodeTitle
	const [area, setArea] = useState<VisibleArea>()
	// The side that is looked from and the layer stay the same when another preset is opened
	const [mode, setMode] = useSessionState<Mode>('density.mode', 'x')
	const [layers, setLayers] = useSessionState<Record<Axis, number>>('density.layers', () => ({ x: 0, y: shape.minY + Math.floor(shape.height / 2), z: 0 }))
	const memo = sessionObject<ViewportMemo>('density.preview', () => ({}))
	const [hover, setHover] = useState<HoverInfo>()
	const [range, setRange] = useState<DensityRange>()
	const [fixed, setFixed] = useState<{ scope: string, range: DensityRange }>()
	const [renderError, setRenderError] = useState<Error>()
	const viewport = useRef<ViewportApi>()
	const view = VIEW[mode]

	// The layer that is shown has to stay inside the bounds, like the view itself
	const heights = bounds.y ?? { min: shape.minY, max: shape.minY + shape.height }
	const layerRange = view.layer === 'y' ? heights : bounds[view.layer]
	const layer = clamp(layers[view.layer], layerRange.min, layerRange.max - 1)
	const setLayer = (value: number) => setLayers(prev => ({ ...prev, [view.layer]: clamp(Math.round(value), layerRange.min, layerRange.max - 1) }))

	// With Delta the preview is what the node changed about one of its inputs: its value minus that of the input
	const base = delta ? deltaInput?.json : undefined
	const sampler = useMemo(() => {
		if (!env) return undefined
		try {
			const fn = createDensitySampler(env, JSON.parse(json), seed, shape)
			if (!delta) return { fn }
			return { fn: deltaSampler(fn, base === undefined ? undefined : createDensitySampler(env, JSON.parse(base), seed, shape)) }
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) }
		}
	}, [env, json, seed, shape, delta, base])

	const sample = useMemo(() => {
		const fn = sampler?.fn
		return fn ? sliceSampler(fn, mode, layer) : undefined
	}, [sampler, mode, layer])

	useEffect(() => {
		if (!area) return
		onLook({ mode, layer, delta: thumbDelta, centerH: Math.round(area.centerX), minV: Math.floor(area.minY), maxV: Math.ceil(area.maxY) })
	}, [mode, layer, thumbDelta, area])

	// The whole area that the view can be moved over
	const horizontal = bounds[view.horizontal]
	const vertical = useMemo<HeightRange>(() => mode === 'top'
		? { min: 1 - bounds.z.max, max: 1 - bounds.z.min }
		: heights, [mode, bounds.z.min, bounds.z.max, heights.min, heights.max])

	// Colors are based on that whole area, so they do not shift when zooming in
	const scope = `${showsFinal ? 'final' : nodeId}|${mode}|${delta}|${delta ? deltaInput?.name : ''}`
	useEffect(() => {
		if (!sample) return
		return measureRegion(sample, horizontal, vertical, measured => {
			if (measured) setFixed({ scope, range: measured })
		})
	}, [sample, horizontal.min, horizontal.max, vertical])
	const fixedRange = fixed?.scope === scope ? fixed.range : undefined
	// With a fixed heatmap the ends of the colormap are the same for every node
	const colorRange = useMemo<DensityRange | undefined>(() => heat === 'fixed'
		? { limit: scale, min: fixedRange?.min ?? 0, max: fixedRange?.max ?? 0 }
		: fixedRange, [heat, scale, fixedRange])

	const source = useMemo<RasterSource | undefined>(() => {
		if (!sample) return undefined
		return {
			key: sample,
			colorKey: {},
			sample,
			colorize: (values, rgba) => setRange(colorizeDensity(values, rgba, colormap, binary, colorRange)),
		}
	}, [sample, colormap, binary, colorRange])

	useEffect(() => {
		setRenderError(undefined)
	}, [sample])

	const frame = useMemo(() => mode === 'top'
		? { centerX: 0, minY: -96, maxY: 96 }
		: { centerX: 0, minY: shape.minY, maxY: shape.minY + shape.height }, [mode, shape.minY, shape.height])

	// The lines of a gradient, in the views that show its axis
	const lineOrientation = !lines ? undefined
		: lines.axis === view.horizontal ? 'v' as const
			: lines.axis === view.vertical ? 'h' as const : undefined
	// In the top view Z grows downwards, and a line marks the edge where its block starts
	const flipped = mode === 'top' && lines?.axis === 'z'
	const guides = useMemo<Guide[] | undefined>(() => {
		if (!lines || !lineOrientation) return undefined
		const position = (coordinate: number) => flipped ? 1 - coordinate : coordinate
		return [
			// The handles are on opposite ends, so both can be grabbed when the lines are on top of each other
			{ id: 'from', end: 'start', orientation: lineOrientation, value: position(lines.from), label: `From ${lines.from}` },
			{ id: 'to', end: 'end', orientation: lineOrientation, value: position(lines.to), label: `To ${lines.to}` },
		]
	}, [lines?.from, lines?.to, lineOrientation, flipped])
	const onGuideDrag = (id: string, value: number) => {
		if (!lines) return
		// Dragging keeps the lines on whole blocks
		const coordinate = Math.round(flipped ? 1 - value : value)
		const which = id === 'from' ? 'from' : 'to'
		if (coordinate !== lines[which]) lines.onChange?.(which, coordinate)
	}

	const error = sampler?.error ?? renderError?.message ?? thumbError
	const gradient = useMemo(() => colormapGradient(colormap), [colormap])
	const layerName = view.layer.toUpperCase()
	const low = delta ? 'lowered' : 'air'
	const high = delta ? 'raised' : 'solid'

	return <Section title="Preview" actions={<>
		<IconButton icon={Ico.seed} label="New random seed" tipSide="left" onClick={onNewSeed} />
		<IconButton icon={Ico.target} label="Reset the view" tipSide="left" onClick={() => viewport.current?.reset()} />
	</>}>
		<div class="gx-preview-controls">
			<Segmented label="View" value={mode} onChange={setMode} options={MODES} />
			<label class="gx-inline-field">
				<span>{layerName}</span>
				<NumberField label={`${layerName} of the layer that is shown`} int value={layer} onChange={setLayer} />
			</label>
			<Slider class="gx-layer-slider" label={`${layerName} of the layer that is shown`} min={layerRange.min} max={layerRange.max - 1} step={1} value={layer} onChange={setLayer} />
		</div>
		<div class="gx-preview-controls gx-preview-display">
			<Select class="gx-select-compact gx-select-heat" label="How the colors are scaled" value={heat} onChange={v => display.onChange({ heat: v as Heat })} options={HEATS} />
			<Select class="gx-select-compact gx-select-show" label="What the preview shows" value={show} onChange={v => display.onChange({ show: v as Show })} options={SHOWS} />
			<Checkbox label="Binary" hint={delta ? 'Show only whether the node raised its input or not' : 'Show only whether the density is solid or air'}
				checked={binary} onChange={next => display.onChange({ binary: next })} />
			<Select class="gx-select-compact" label="Colors" value={colormap} onChange={v => display.onChange({ colormap: v as ColormapType })}
				options={ColormapTypes.map(c => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))} />
		</div>
		{delta && <div class="gx-preview-controls gx-preview-delta">
			{deltaInput
				? <label class="gx-inline-field gx-inline-grow">
					<span>Relative to</span>
					<Select label="The input that the node is compared with" value={deltaInput.name} onChange={onDeltaInput}
						options={deltaInputs.map(input => ({ value: input.name, label: input.text }))} />
				</label>
				: <span class="gx-muted">This node has no inputs, so it changed nothing: its delta is zero everywhere.</span>}
		</div>}
		{heat === 'fixed' && <div class="gx-preview-controls gx-preview-scale">
			<label class="gx-inline-field">
				<span>Scale</span>
				<NumberField label="Density at the ends of the colors" value={scale} onChange={next => display.onChange({ scale: next })} />
			</label>
			<Slider label="Scale of the colors, logarithmic" min={-SCALE_EXPONENT} max={SCALE_EXPONENT} step={0.01}
				value={clamp(Math.log10(scale), -SCALE_EXPONENT, SCALE_EXPONENT)}
				onChange={exponent => display.onChange({ scale: Number(Math.pow(10, exponent).toPrecision(3)) })} />
		</div>}
		<div class="gx-preview">
			{!env && <div class="gx-preview-message">Loading world generation…</div>}
			{env && error && !source && <div class="gx-preview-message is-error" role="alert">
				<strong>Cannot preview this node</strong>
				<span>{error}</span>
			</div>}
			{source && <Viewport2D source={source} frame={frame} frameKey={mode} apiRef={viewport}
				label={`${view.name} view of ${title}`}
				axes={[view.horizontal.toUpperCase(), view.vertical.toUpperCase()]} invertY={mode === 'top'}
				limitX={horizontal} limitY={mode === 'top' ? vertical : bounds.y} fillLimitY={mode !== 'top'}
				guides={guides} onGuideDrag={lines?.onChange ? onGuideDrag : undefined} memo={memo}
				onHover={setHover} onError={setRenderError} onView={setArea} />}
		</div>
		<div class="gx-readout" aria-live="off">
			{hover
				? <>
					<span>{view.horizontal.toUpperCase()} {hover.x}</span>
					<span>{view.vertical.toUpperCase()} {hover.y}</span>
					<span class="gx-readout-value">{delta ? 'change' : hover.value > 0 ? 'solid' : 'air'} · {formatDensity(hover.value)}</span>
				</>
				: <span class="gx-muted">{lines && !guides
					? `The from and to lines of this gradient show in ${LINE_VIEWS[lines.axis]}`
					: guides ? (lines?.onChange ? 'Drag the handles of the lines to move where the gradient starts and ends' : 'The lines show where the gradient starts and ends')
						: delta ? (deltaInput ? `Showing what ${title} changed: its value minus its input, ${deltaInput.text}` : 'A node without inputs has nothing to be compared with')
							: showsFinal && title !== nodeTitle ? `Showing the final output while editing ${nodeTitle}`
								: 'Hover over the preview to read values'}</span>}
		</div>
		<div class="gx-legend" aria-label={binary ? `Two colors: ${low} and ${high}` : range ? `Colors range from ${formatDensity(-range.limit)} to ${formatDensity(range.limit)}` : undefined}>
			{binary
				? <div class="gx-legend-binary">
					<span><span class="gx-swatch" style={{ background: `rgb(${AIR_COLOR.join(', ')})` }} />{delta ? 'Lowered or left the same' : 'Air, zero or below'}</span>
					<span><span class="gx-swatch" style={{ background: `rgb(${SOLID_COLOR.join(', ')})` }} />{delta ? 'Raised' : 'Solid, above zero'}</span>
				</div>
				: <>
					<div class="gx-legend-bar" style={{ background: gradient }} />
					<div class="gx-legend-labels">
						<span>{range ? formatDensity(-range.limit) : ''} {low}</span>
						<span>0</span>
						<span>{high} {range ? formatDensity(range.limit) : ''}</span>
					</div>
				</>}
			{range && <p class="gx-muted">
				{heat === 'fixed'
					? `Colors span ${formatDensity(-scale)} to ${formatDensity(scale)} on every node.${fixedRange ? ` In the whole area ${delta ? 'the change' : 'the density'} goes from ${formatDensity(range.min)} to ${formatDensity(range.max)}.` : ''}`
					: fixedRange
						? `Colors stay the same when zooming. In the whole area ${delta ? 'the change' : 'the density'} goes from ${formatDensity(range.min)} to ${formatDensity(range.max)}.`
						: `Values in view range from ${formatDensity(range.min)} to ${formatDensity(range.max)}`}
			</p>}
		</div>
	</Section>
}

function formatDensity(value: number) {
	if (!Number.isFinite(value)) return String(value)
	const abs = Math.abs(value)
	const text = abs >= 1000 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : abs >= 0.01 || abs === 0 ? value.toFixed(3) : value.toExponential(1)
	return text.replace('-', '−')
}

interface PropertiesProps {
	node: GNode
	doc: GDoc
	store: GraphStore
	kind: GraphKind
	schema: DensitySchema
	registries: Map<string, string[]> | undefined
	/** The ends of the sliders for constant values */
	slider: HeightRange
}
function Properties({ node, doc, store, kind, schema, registries, slider }: PropertiesProps) {
	const def = schema.get(node.type)
	const values: Record<string, any> = node.data.values ?? {}
	const links = useMemo(() => indexLinks(doc), [doc]).get(node.id) ?? NO_LINKS
	const setValue = (name: string, value: unknown) => {
		store.setData(node.id, { values: { ...values, [name]: value } }, name)
	}
	const step = sliderStep(slider.min, slider.max)

	// The nodes that can be connected to an input of this node
	const sources = useMemo(() => {
		const seen = new Map<string, number>()
		return doc.nodes
			.filter(n => n.id !== node.id && n.type !== 'output')
			.map(n => {
				const title = kind.title(n)
				const index = (seen.get(title) ?? 0) + 1
				seen.set(title, index)
				return { node: n, title, index }
			})
			.map(s => ({
				value: s.node.id,
				label: (seen.get(s.title) ?? 0) > 1 ? `${s.title} #${s.index}` : s.title,
				disabled: wouldCycle(doc, s.node.id, node.id),
			}))
	}, [doc, node.id, kind])

	if (node.type === 'raw') {
		return <JsonField label="Density function" value={node.data.json} onChange={json => store.setData(node.id, { json }, 'json')} rows={8} />
	}

	const numberField = (field: Extract<DField, { kind: 'number' }>, id: string) => {
		const label = fieldLabel(field)
		return <NumberField id={id} label={label} int={field.int} value={typeof values[field.name] === 'number' ? values[field.name] : field.def}
			onChange={v => setValue(field.name, v)} />
	}

	const renderField = (field: DField) => {
		const label = fieldLabel(field)
		const gradient = def.gradient
		if (gradient && field.name === gradient.to) {
			// Shown next to the start of the gradient
			return null
		}
		if (gradient && field.name === gradient.from && field.kind === 'number') {
			const to = def.fields.find(f => f.name === gradient.to)
			return <div key={field.name} class="gx-field-pair">
				<Field label={label} hint={field.hint}>{id => numberField(field, id)}</Field>
				{to?.kind === 'number' && <Field label={fieldLabel(to)} hint={to.hint}>{id => numberField(to, id)}</Field>}
			</div>
		}
		if (field.kind === 'input') {
			const edge = links.ins[field.name]?.[0]
			const constant = typeof values[field.name] === 'number' ? values[field.name] as number : undefined
			return <Field key={field.name} label={label} hint={field.hint}>
				{id => <>
					<Select id={id} label={`${label} source`} value={edge ? edge.from : ''}
						options={[{ value: '', label: field.optional ? 'Constant or unset' : 'Constant' }, ...sources]}
						onChange={source => {
							if (source === '') {
								if (edge) store.setDoc(removeNodes(store.doc, [], [edge.id]))
							} else {
								store.setDoc(connect(store.doc, kind, source, 'out', node.id, field.name))
							}
						}} />
					{!edge && <NumberField label={`${label} constant`} value={constant}
						placeholder={field.optional ? 'Unset' : '0'}
						onChange={v => setValue(field.name, v)} onClear={() => setValue(field.name, undefined)} />}
					{!edge && <Slider class="gx-field-slider" label={`${label} constant`} min={slider.min} max={slider.max} step={step}
						value={constant} onChange={v => setValue(field.name, v)} />}
				</>}
			</Field>
		}
		if (field.kind === 'number') {
			const withSlider = !field.int && field.slider !== false
			const range = typeof field.slider === 'object' ? field.slider : slider
			return <Field key={field.name} label={label} hint={field.hint}>
				{id => <>
					{numberField(field, id)}
					{withSlider && <Slider class="gx-field-slider" label={label} min={range.min} max={range.max} step={range === slider ? step : sliderStep(range.min, range.max)}
						value={typeof values[field.name] === 'number' ? values[field.name] : field.def} onChange={v => setValue(field.name, v)} />}
				</>}
			</Field>
		}
		if (field.kind === 'enum') {
			return <Field key={field.name} label={label} hint={field.hint}>
				{id => <Select id={id} label={label} value={typeof values[field.name] === 'string' ? values[field.name] : field.optional ? '' : field.def}
					options={[
						...(field.optional ? [{ value: '', label: `Default (${field.def.replace(/_/g, ' ')})` }] : []),
						...field.options.map(o => ({ value: o, label: o.replace(/_/g, ' ') })),
					]}
					onChange={v => setValue(field.name, v === '' ? undefined : v)} />}
			</Field>
		}
		if (field.kind === 'id') {
			return <Field key={field.name} label={label} hint={field.hint} wide>
				{id => <IdSelect id={id} label={label} value={typeof values[field.name] === 'string' ? values[field.name] : ''}
					options={registries?.get(field.registry)} onChange={v => setValue(field.name, v)} />}
			</Field>
		}
		return <JsonField key={field.name} label={label} value={values[field.name]} onChange={v => setValue(field.name, v)} rows={field.name === 'spline' ? 8 : 2} />
	}

	return <div class="gx-fields">{def.fields.map(renderField)}</div>
}
