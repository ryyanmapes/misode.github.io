import { memo } from 'preact/compat'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { CanvasApi, ViewMemo } from '../GraphCanvas.jsx'
import { GraphCanvas } from '../GraphCanvas.jsx'
import { Ico } from '../icons.jsx'
import type { GraphStore } from '../store.js'
import { connect, indexLinks, removeNodes, useStore, useStructure, wouldCycle } from '../store.js'
import { Toolbar } from '../Toolbar.jsx'
import type { GDoc, GNode, GraphFormat, GraphKind, PreviewBounds, ViewOptions } from '../types.js'
import { NO_LINKS } from '../types.js'
import { sessionObject, useSessionState } from '../session.js'
import { CopyButton, Field, IconButton, IdSelect, JsonField, Lockable, NumberField, prettyId, Section, Select, Switch, TextField } from '../ui.jsx'
import type { HoverInfo, RasterSource, ViewportApi, ViewportMemo } from '../Viewport2D.jsx'
import { Viewport2D } from '../Viewport2D.jsx'
import type { WorldgenEnv } from '../worldgen.js'
import { HIGHLIGHT_FLAG, TerrainSlice } from '../worldgen.js'
import { blockColor, blockCss } from './blocks.js'
import { layoutMaterial, materialFromJson, materialSerializer } from './convert.js'
import { materialKinds, materialTitle } from './MaterialKind.jsx'
import type { CField } from './schema.js'
import { ANCHOR_KINDS, anchorParts, biomeList, blockLabel, blockName, conditionText, conditionType, conditionTypes, createCondition, NAMED, ruleName } from './schema.js'

const HIGHLIGHT: [number, number, number] = [0, 229, 255]
const HIGHLIGHT_CSS = 'rgb(0, 229, 255)'

interface Props {
	store: GraphStore
	format: GraphFormat
	env: WorldgenEnv | undefined
	registries: Map<string, string[]> | undefined
	/** The id of the rule when it has one, which the rule of the noise settings does not */
	ruleId?: string
	/** The noise settings as a JSON string, with the final density of the other tab */
	settings: string | undefined
	seed: bigint
	onNewSeed: () => void
	/** The rule that the graph started as, used when resetting */
	preset: unknown
	/** What resetting is called */
	resetLabel: string
	/** The biome that the preview starts with */
	defaultBiome: string
	options: ViewOptions
	onOptions: (patch: Partial<ViewOptions>) => void
	bounds: PreviewBounds
	dark: boolean
	viewMemo: ViewMemo
}
export function MaterialEditor({ store, format, env, registries, ruleId, settings, seed, onNewSeed, preset, resetLabel, defaultBiome, options, onOptions, bounds, dark, viewMemo }: Props) {
	useStore(store)
	const kind = materialKinds[format]
	const name = ruleId ?? ruleName(format)
	const api = useRef<CanvasApi>()
	// Moving steps around should not recompute the rule or the inspector
	const doc = useStructure(store.doc)
	const serializer = useMemo(() => materialSerializer(doc), [doc])
	const start = doc.nodes.find(n => n.type === 'start')
	const primaryId = store.selection[store.selection.length - 1]
	const primary = doc.nodes.find(n => n.id === primaryId)
	const active = primary ?? start

	return <div class="gx-editor">
		<Toolbar store={store} kind={kind} api={api} jsonName={name} clipType={`material:${format}`} resetLabel={resetLabel} options={options} onOptions={onOptions}
			getJson={() => JSON.stringify(serializer.root(), null, 2)}
			onTidy={() => {
				store.setDoc(layoutMaterial(store.doc))
				requestAnimationFrame(() => api.current?.fit())
			}}
			onReset={() => store.load(materialFromJson(preset))} />
		<div class="gx-work">
			<div class="gx-stage">
				<GraphCanvas store={store} kind={kind} label={`Flowchart of ${ruleId ?? `the ${name}`}`} clipType={`material:${format}`} apiRef={api} viewMemo={viewMemo} snap={options.snap} minInitialZoom={0.62} anchor="start" />
			</div>
			<aside class="gx-side" aria-label="Inspector">
				{active && <Inspector node={active} isFallback={primary === undefined} count={store.selection.length} doc={doc} store={store} serializer={serializer}
					kind={kind} format={format} defaultBiome={defaultBiome} bounds={bounds}
					registries={registries} env={env} settings={settings} seed={seed} onNewSeed={onNewSeed} dark={dark} />}
			</aside>
		</div>
	</div>
}

interface InspectorProps {
	node: GNode
	isFallback: boolean
	count: number
	doc: GDoc
	store: GraphStore
	serializer: ReturnType<typeof materialSerializer>
	kind: GraphKind
	format: GraphFormat
	defaultBiome: string
	bounds: PreviewBounds
	registries: Map<string, string[]> | undefined
	env: WorldgenEnv | undefined
	settings: string | undefined
	seed: bigint
	onNewSeed: () => void
	dark: boolean
}
const Inspector = memo(function Inspector({ node, isFallback, count, doc, store, serializer, kind, format, defaultBiome, bounds, registries, env, settings, seed, onNewSeed, dark }: InspectorProps) {
	const name = ruleName(format)
	const kindLabel = node.type === 'start' ? `${name[0].toUpperCase()}${name.slice(1)}`
		: node.type === 'condition' ? 'Condition'
			: node.type === 'block' ? 'Place block'
				: node.type === 'reference' ? 'Run rule'
					: node.type === 'bandlands' ? 'Bandlands'
						: node.type === 'ore_vein' ? 'Ore vein' : 'Custom rule'
	const description = isFallback ? 'Nothing selected, showing the whole rule'
		: count > 1 ? `${count} steps selected`
			: node.type === 'start' ? 'Steps are tried from top to bottom'
				: materialTitle(node)
	const json = useMemo(() => JSON.stringify(serializer.step(node.id), null, 2), [serializer, node.id])

	return <>
		<div class="gx-side-head">
			<span class="gx-dot gx-dot-lg" style={{ background: kind.color(node) }} />
			<div class="gx-side-title">
				<h2>{kindLabel}</h2>
				<p>{description}</p>
			</div>
			{kind.deletable(node) && !store.readOnly && <>
				<IconButton icon={Ico.duplicate} label="Duplicate step" tipSide="left" onClick={() => store.duplicateSelection(kind)} />
				<IconButton icon={Ico.trash} label="Delete step" tipSide="left" onClick={() => store.deleteSelection(kind)} />
			</>}
		</div>
		<Preview node={node} doc={doc} serializer={serializer} defaultBiome={defaultBiome} bounds={bounds} registries={registries} env={env} settings={settings} seed={seed} onNewSeed={onNewSeed} dark={dark} />
		{node.type !== 'start' && <Section title="Properties">
			<Lockable locked={store.readOnly}>
				<Properties node={node} store={store} format={format} registries={registries} />
			</Lockable>
		</Section>}
		{node.type !== 'start' && <Section title="Connections">
			<Lockable locked={store.readOnly}>
				<Connections node={node} doc={doc} store={store} kind={kind} />
			</Lockable>
		</Section>}
		<Section title="JSON" collapsible defaultOpen={false} actions={<CopyButton getText={() => json} />}>
			<pre class="gx-json" tabIndex={0}>{json}</pre>
		</Section>
	</>
})

interface Stats {
	marked: number
	solid: number
	blocks: string[]
}

interface PreviewProps {
	node: GNode
	doc: GDoc
	serializer: ReturnType<typeof materialSerializer>
	defaultBiome: string
	bounds: PreviewBounds
	registries: Map<string, string[]> | undefined
	env: WorldgenEnv | undefined
	settings: string | undefined
	seed: bigint
	onNewSeed: () => void
	dark: boolean
}
function Preview({ node, doc, serializer, defaultBiome, bounds, registries, env, settings, seed, onNewSeed, dark }: PreviewProps) {
	const [biome, setBiome] = useState(defaultBiome)
	const [highlight, setHighlight] = useSessionState('material.highlight', true)
	const memo = sessionObject<ViewportMemo>('material.preview', () => ({}))
	const [hover, setHover] = useState<HoverInfo>()
	const [stats, setStats] = useState<Stats>()
	const [error, setError] = useState<Error>()
	const viewport = useRef<ViewportApi>()
	const marking = highlight && node.type !== 'start'

	const terrain = useMemo(() => {
		if (!env || !settings) return undefined
		try {
			return { slice: new TerrainSlice(env, JSON.parse(settings), seed, biome) }
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) }
		}
	}, [env, settings, seed])

	const ruleKey = useMemo(() => JSON.stringify(serializer.root()), [serializer])
	const markKey = useMemo(() => marking ? JSON.stringify(serializer.marked(node.id)) : undefined, [serializer, marking, node.id])

	const source = useMemo<RasterSource | undefined>(() => {
		const slice = terrain?.slice
		if (!slice) return undefined
		slice.configure(ruleKey, markKey, biome)
		const background = dark ? [27, 27, 28] : [248, 250, 253]
		const air = dark ? [52, 54, 58] : [225, 229, 234]
		return {
			key: {},
			sample: (x, y) => slice.sample(x, y),
			colorize: (values, rgba) => {
				const colors = slice.palette.map(name => name === 'minecraft:air' ? air : blockColor(name))
				const seen = new Set<number>()
				let marked = 0
				let solid = 0
				for (let i = 0; i < values.length; i += 1) {
					const value = values[i]
					let color = background
					if (value >= 0) {
						const isMarked = value >= HIGHLIGHT_FLAG
						const index = isMarked ? value - HIGHLIGHT_FLAG : value
						const name = slice.palette[index]
						color = isMarked ? HIGHLIGHT : colors[index] ?? background
						if (name !== 'minecraft:air' && name !== 'minecraft:lava' && name !== 'minecraft:water') {
							solid += 1
							if (isMarked) marked += 1
						}
						seen.add(index)
					}
					rgba[i * 4] = color[0]
					rgba[i * 4 + 1] = color[1]
					rgba[i * 4 + 2] = color[2]
					rgba[i * 4 + 3] = 255
				}
				setStats({
					marked,
					solid,
					blocks: [...seen].map(i => slice.palette[i]).filter(name => name !== 'minecraft:air').sort(),
				})
			},
		}
	}, [terrain, ruleKey, markKey, biome, dark])

	useEffect(() => {
		setError(undefined)
	}, [source])

	const frame = useMemo(() => {
		const slice = terrain?.slice
		return { centerX: 0, minY: slice?.minY ?? 0, maxY: (slice?.minY ?? 0) + (slice?.height ?? 128) }
	}, [terrain])

	// Only the biomes of the dimension are offered. The ones that the rule looks at come first, since those change the result.
	const biomeOptions = useMemo(() => {
		const checked = new Set<string>()
		for (const n of doc.nodes) {
			if (n.type !== 'condition' || typeof n.data.cond !== 'object' || n.data.cond === null) continue
			if (String(n.data.cond.type).replace(/^minecraft:/, '') !== 'biome') continue
			for (const id of biomeList(n.data.cond.biome_is)) {
				if (!id.startsWith('#')) checked.add(id.includes(':') ? id : `minecraft:${id}`)
			}
		}
		// The biome of the dimension, and the biomes that the rule asks about: a rule of the game still tells what it does elsewhere
		const ids = [...new Set([...(registries?.get('worldgen/biome') ?? [defaultBiome]), ...checked, biome])]
		const first = ids.filter(id => checked.has(id))
		const others = ids.filter(id => !checked.has(id))
		return [
			...first.map(id => ({ value: id, label: prettyId(id).replace(/_/g, ' ') })),
			...(first.length > 0 && others.length > 0 ? [{ value: '', label: '──────────', disabled: true }] : []),
			...others.map(id => ({ value: id, label: prettyId(id).replace(/_/g, ' ') })),
		]
	}, [doc, registries, biome, defaultBiome])

	const hovered = useMemo(() => {
		const slice = terrain?.slice
		if (!hover || !slice || hover.value < 0) return undefined
		const marked = hover.value >= HIGHLIGHT_FLAG
		return { name: slice.palette[marked ? hover.value - HIGHLIGHT_FLAG : hover.value], marked }
	}, [hover, terrain])

	const message = terrain?.error ?? error?.message
	const share = stats && stats.solid > 0 ? stats.marked / stats.solid * 100 : 0

	return <Section title="Preview" actions={<>
		<IconButton icon={Ico.dice} label="New random seed" tipSide="left" onClick={onNewSeed} />
		<IconButton icon={Ico.target} label="Reset the view" tipSide="left" onClick={() => viewport.current?.reset()} />
	</>}>
		<div class="gx-preview-controls">
			<label class="gx-inline-field gx-inline-grow">
				<span>Biome</span>
				<Select label="Biome of the preview" value={biome} onChange={setBiome} options={biomeOptions} />
			</label>
		</div>
		<div class="gx-preview">
			{(!env || !settings) && <div class="gx-preview-message">Loading world generation…</div>}
			{message && <div class="gx-preview-message is-error" role="alert">
				<strong>Cannot preview this rule</strong>
				<span>{message}</span>
			</div>}
			{source && !terrain?.error && <Viewport2D source={source} frame={frame} apiRef={viewport} memo={memo} axes={['X', 'Y']} limitX={bounds.x} limitY={bounds.y} fillLimitY
				label={`Side view of the terrain in ${prettyId(biome).replace(/_/g, ' ')}`}
				onHover={setHover} onError={setError} />}
		</div>
		<div class="gx-readout">
			{hover && hovered
				? <>
					<span>X {hover.x}</span>
					<span>Y {hover.y}</span>
					<span class="gx-readout-value">
						<span class="gx-swatch" style={{ background: hovered.marked ? HIGHLIGHT_CSS : hovered.name === 'minecraft:air' ? 'transparent' : blockCss(hovered.name) }} />
						{prettyId(hovered.name).replace(/_/g, ' ')}{hovered.marked ? ' · this step' : ''}
					</span>
				</>
				: <span class="gx-muted">Hover over the preview to see the blocks</span>}
		</div>
		{node.type !== 'start' && <div class="gx-highlight">
			<Switch label="Highlight where this step applies" checked={highlight} onChange={setHighlight} />
			<div>
				<span class="gx-highlight-title">
					<span class="gx-swatch" style={{ background: HIGHLIGHT_CSS }} />
					Highlight where this step applies
				</span>
				<span class="gx-muted" aria-live="polite">
					{!highlight ? 'Turned off'
						: !stats ? 'Computing…'
							: stats.marked === 0 ? 'It does not apply anywhere in view'
								: `${node.type === 'condition' ? 'True and reached' : 'Places a block'} for ${share < 0.1 ? 'less than 0.1' : share.toFixed(1)}% of the solid blocks in view`}
				</span>
			</div>
		</div>}
		{stats && stats.blocks.length > 0 && <ul class="gx-chips" aria-label="Blocks in view">
			{stats.blocks.slice(0, 10).map(name => <li key={name}>
				<span class="gx-swatch" style={{ background: blockCss(name) }} />
				{prettyId(name).replace(/_/g, ' ')}
			</li>)}
		</ul>}
	</Section>
}

interface PropertiesProps {
	node: GNode
	store: GraphStore
	format: GraphFormat
	registries: Map<string, string[]> | undefined
}
function Properties({ node, store, format, registries }: PropertiesProps) {
	if (node.type === 'block') {
		const state = node.data.state
		const name = blockName(state)
		return <div class="gx-fields">
			<Field label="Block" wide>
				{id => <div class="gx-with-swatch">
					<span class="gx-swatch gx-swatch-lg" style={{ background: blockCss(name) }} />
					<TextField id={id} label="Block" mono value={name} options={registries?.get('block')} placeholder="minecraft:…"
						onChange={value => {
							const next = typeof state === 'object' && state !== null
								? { ...state, ['id' in state ? 'id' : 'Name']: value }
								: value
							store.setData(node.id, { state: next }, 'state')
						}} />
				</div>}
			</Field>
			{typeof state === 'object' && state !== null && (state.Properties ?? state.properties) !== undefined && <p class="gx-muted">The properties of this block state are kept. Edit them in the JSON below.</p>}
			<p class="gx-muted">{blockLabel(state)} is placed and no more steps are tried.</p>
		</div>
	}
	if (node.type === 'reference') {
		return <div class="gx-fields">
			<Field label="Rule" wide hint="A material rule from the registry">
				{id => <IdSelect id={id} label="Rule" value={typeof node.data.id === 'string' ? node.data.id : ''}
					options={registries?.get('worldgen/material_rule')}
					onChange={value => store.setData(node.id, { id: value }, 'id')} />}
			</Field>
			<p class="gx-muted">When this rule does not place a block, the else step is tried.</p>
		</div>
	}
	if (node.type === 'bandlands') {
		return <div class="gx-fields">
			<p class="gx-muted">Places the bands of terracotta that the badlands are made of. It has no settings.</p>
			<p class="gx-muted">The previews cannot show this step. The game places it.</p>
		</div>
	}
	if (node.type === 'ore_vein') {
		const json: Record<string, unknown> = typeof node.data.json === 'object' && node.data.json !== null ? node.data.json : {}
		const set = (name: string, value: unknown) => store.setData(node.id, { json: { ...json, [name]: value } }, name)
		const block = (name: string, label: string, hint: string) => {
			const state = json[name]
			const current = blockName(state)
			return <Field key={name} label={label} hint={hint} wide>
				{id => <div class="gx-with-swatch">
					<span class="gx-swatch gx-swatch-lg" style={{ background: blockCss(current) }} />
					<TextField id={id} label={label} mono value={current} options={registries?.get('block')} placeholder="minecraft:…"
						onChange={value => set(name, typeof state === 'object' && state !== null ? { ...state, ['id' in state ? 'id' : 'Name']: value } : value)} />
				</div>}
			</Field>
		}
		// These are density functions. One with an id is chosen from a list, anything else is edited as JSON.
		const density = (name: string, label: string, hint: string) => typeof json[name] === 'string'
			? <Field key={name} label={label} hint={hint} wide>
				{id => <IdSelect id={id} label={label} value={json[name] as string} options={registries?.get('worldgen/density_function')} onChange={value => set(name, value)} />}
			</Field>
			: <JsonField key={name} label={label} value={json[name] ?? 0} rows={2} onChange={value => set(name, value)} />
		return <div class="gx-fields">
			{block('ore_block', 'Ore block', 'The ore of the vein')}
			{block('raw_ore_block', 'Raw ore block', 'Now and then placed instead of the ore')}
			<Field label="Raw ore chance" hint="How often the raw ore block is placed instead of the ore, from 0 to 1">
				{id => <NumberField id={id} label="Raw ore chance" value={typeof json.raw_ore_chance === 'number' ? json.raw_ore_chance : 0} onChange={value => set('raw_ore_chance', Math.min(1, Math.max(0, value)))} />}
			</Field>
			{block('filler_block', 'Filler block', 'The stone between the ore')}
			{density('density', 'Density', 'A density function: the chance from 0 to 1 that the vein replaces a block. At 0 or lower nothing is replaced.')}
			{density('richness', 'Richness', 'A density function: the chance from 0 to 1 that ore is placed and not the filler block. At 0 or lower it is all filler, at 1 or higher all ore.')}
			{density('filler_gap', 'Filler gap', 'A density function that overrules the richness: where it is positive, the filler block is always placed.')}
			<p class="gx-muted">The previews cannot show this step. The game places it.</p>
		</div>
	}
	if (node.type === 'raw') {
		return <JsonField label="Rule" value={node.data.json} rows={8} onChange={json => store.setData(node.id, { json }, 'json')} />
	}

	const cond = node.data.cond
	const def = conditionType(cond, format)
	const setCond = (next: unknown, coalesce?: string) => store.setData(node.id, { cond: next }, coalesce)
	const setField = (name: string, value: unknown) => {
		if (def?.type === NAMED) {
			setCond(value, name)
		} else {
			const next = { ...(cond as Record<string, unknown>) }
			if (value === undefined) delete next[name]
			else next[name] = value
			setCond(next, name)
		}
	}
	const { folded } = conditionText(cond, !!node.data.negate)

	return <div class="gx-fields">
		<Field label="Type">
			{id => <Select id={id} label="Condition type" value={def?.type ?? ''}
				options={[
					...(def ? [] : [{ value: '', label: 'Custom' }]),
					...conditionTypes(format).map(t => ({ value: t.type, label: t.label })),
				]}
				onChange={type => {
					if (type !== '') setCond(createCondition(type, format))
				}} />}
		</Field>
		{def
			? def.fields.map(field => <ConditionField key={`${def.type}:${field.name}`} field={field}
				value={def.type === NAMED ? cond : (cond as Record<string, unknown>)[field.name]}
				registries={registries} onChange={value => setField(field.name, value)} />)
			: <JsonField label="Condition" value={cond} rows={6} onChange={value => setCond(value, 'json')} />}
		<Field label="Invert" hint="Continue with then when the condition is false">
			{id => <div class="gx-switch-row">
				<Switch id={id} label="Invert the condition" checked={!!node.data.negate}
					onChange={negate => store.setData(node.id, { negate })} />
				<span class="gx-muted">{node.data.negate ? (folded ? 'Inverted' : 'Runs when this is false') : 'Off'}</span>
			</div>}
		</Field>
	</div>
}

interface ConditionFieldProps {
	field: CField
	value: unknown
	registries: Map<string, string[]> | undefined
	onChange: (value: unknown) => void
}
function ConditionField({ field, value, registries, onChange }: ConditionFieldProps) {
	if (field.kind === 'number') {
		return <Field label={field.label} hint={field.hint}>
			{id => <NumberField id={id} label={field.label} int={field.int} value={typeof value === 'number' ? value : field.def} onChange={onChange} />}
		</Field>
	}
	if (field.kind === 'bool') {
		const checked = typeof value === 'boolean' ? value : field.def
		return <Field label={field.label} hint={field.hint}>
			{id => <div class="gx-switch-row">
				<Switch id={id} label={field.label} checked={checked} onChange={next => onChange(field.optional && !next ? undefined : next)} />
				<span class="gx-muted">{checked ? 'On' : 'Off'}</span>
			</div>}
		</Field>
	}
	if (field.kind === 'enum') {
		return <Field label={field.label} hint={field.hint}>
			{id => <Select id={id} label={field.label} value={typeof value === 'string' ? value : field.def}
				options={field.options.map(o => ({ value: o, label: o[0].toUpperCase() + o.slice(1) }))} onChange={onChange} />}
		</Field>
	}
	if (field.kind === 'anchor') {
		const parts = anchorParts(value)
		return <Field label={field.label} hint={field.hint}>
			{id => <>
				<Select id={id} label={`${field.label} is measured from`} value={parts.kind} options={ANCHOR_KINDS}
					onChange={kind => onChange({ [kind]: parts.value })} />
				<NumberField label={field.label} int value={parts.value} onChange={next => onChange({ [parts.kind]: next })} />
			</>}
		</Field>
	}
	if (field.kind === 'biomes') {
		const list = biomeList(value)
		return <Field label={field.label} hint={field.hint} wide>
			{id => <TextField id={id} label={field.label} mono value={list.join(', ')} options={registries?.get('worldgen/biome')}
				placeholder="minecraft:…"
				onChange={text => {
					const ids = text.split(',').map(s => s.trim()).filter(Boolean)
					onChange(ids.length === 1 && !field.list ? ids[0] : ids)
				}} />}
		</Field>
	}
	return <Field label={field.label} hint={field.hint} wide>
		{id => <IdSelect id={id} label={field.label} value={typeof value === 'string' ? value : ''}
			options={field.kind === 'id' ? registries?.get(field.registry) : undefined} onChange={onChange} />}
	</Field>
}

/** Lets you connect steps without dragging, which also works with a keyboard */
function Connections({ node, doc, store, kind }: { node: GNode, doc: GDoc, store: GraphStore, kind: GraphKind }) {
	const links = useMemo(() => indexLinks(doc), [doc]).get(node.id) ?? NO_LINKS
	const targets = useMemo(() => {
		const seen = new Map<string, number>()
		return doc.nodes
			.filter(n => n.id !== node.id && n.type !== 'start')
			.map(n => {
				const title = materialTitle(n)
				const index = (seen.get(title) ?? 0) + 1
				seen.set(title, index)
				return { node: n, title, index }
			})
			.map(t => ({
				value: t.node.id,
				label: (seen.get(t.title) ?? 0) > 1 ? `${t.title} #${t.index}` : t.title,
				disabled: wouldCycle(doc, node.id, t.node.id),
			}))
	}, [doc, node.id])

	const ports = node.type === 'condition'
		? [{ port: 'then', label: 'Then', hint: 'Runs when the condition is true' }, { port: 'else', label: 'Else', hint: 'Tried when no block was placed' }]
		: node.type === 'block' ? [] : [{ port: 'else', label: 'Else', hint: 'Tried when no block was placed' }]

	if (ports.length === 0) {
		return <p class="gx-muted">Placing a block ends the rule, so nothing follows this step.</p>
	}
	return <div class="gx-fields">
		{ports.map(({ port, label, hint }) => {
			const edge = links.outs[port]?.[0]
			return <Field key={port} label={label} hint={hint} wide>
				{id => <Select id={id} label={`${label} goes to`} value={edge?.to ?? ''}
					options={[{ value: '', label: 'Nothing' }, ...targets]}
					onChange={target => {
						if (target === '') {
							if (edge) store.setDoc(removeNodes(store.doc, [], [edge.id]))
						} else {
							store.setDoc(connect(store.doc, kind, node.id, port, target, 'in'))
						}
					}} />}
			</Field>
		})}
	</div>
}
