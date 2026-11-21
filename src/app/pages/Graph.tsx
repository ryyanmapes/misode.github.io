import type { ComponentChildren } from 'preact'
import { Component } from 'preact'
import { Link, route } from 'preact-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import '../../styles/graph.css'
import { densityFromJson, densityToJson } from '../components/graph/density/convert.js'
import { DensityEditor } from '../components/graph/density/DensityEditor.jsx'
import { CarverEditor } from '../components/graph/CarverEditor.jsx'
import { densitySchema } from '../components/graph/density/schema.js'
import { DimensionEditor } from '../components/graph/DimensionEditor.jsx'
import type { CustomDimension, ItemKind, ItemTabs as ItemTabList, Sub, TabRef } from '../components/graph/dimensions.js'
import { customTabId, exampleTabId, homeHref, MAIN, readItemTabs, readTabs, recentSub, recentVersion, rememberPlace, rememberSub, resolveTab, subOfSlug, tabHref, updateCustom, useCustom, useCustomList, versionHref, writeItemTabs, writeTabs } from '../components/graph/dimensions.js'
import { ExportPanel } from '../components/graph/ExportPanel.jsx'
import { FeatureEditor } from '../components/graph/FeatureEditor.jsx'
import type { ViewMemo } from '../components/graph/GraphCanvas.jsx'
import { HomePage } from '../components/graph/HomePage.jsx'
import { Ico } from '../components/graph/icons.jsx'
import type { Own } from '../components/graph/items.js'
import { circularFor, NO_OWN, ownOf, registryOf } from '../components/graph/items.js'
import { ItemsHome } from '../components/graph/ItemsHome.jsx'
import { ItemTabs } from '../components/graph/ItemTabs.jsx'
import { materialFromJson, materialToJson, upgradeMaterial } from '../components/graph/material/convert.js'
import { MaterialEditor } from '../components/graph/material/MaterialEditor.jsx'
import { blockName, ruleName } from '../components/graph/material/schema.js'
import { NoiseEditor } from '../components/graph/NoiseEditor.jsx'
import { PlacerEditor } from '../components/graph/PlacerEditor.jsx'
import type { DimensionData } from '../components/graph/presets.js'
import { adoptBiome, biomeOf, fetchGameBiome, findVersion, GRAPH_VERSIONS, loadedPreset, loadPreset, needsBiome } from '../components/graph/presets.js'
import { dropSession, sessionObject, useSessionState } from '../components/graph/session.js'
import { GraphStore, useStore, useStructure } from '../components/graph/store.js'
import { TabStrip } from '../components/graph/TabStrip.jsx'
import type { GDoc, GraphFormat, HeightRange, PreviewBounds, ViewOptions } from '../components/graph/types.js'
import { IconButton, Select, useStoredFlag } from '../components/graph/ui.jsx'
import { featureDataOf, loadVanillaFeatures } from '../components/graph/view/decorate.js'
import type { TerrainInput, TerrainMemory } from '../components/graph/view/terrain.js'
import { cameraOf, createTerrainMemory } from '../components/graph/view/terrain.js'
import { createViewMemory, ViewEditor } from '../components/graph/view/ViewEditor.jsx'
import type { NoiseShape, WorldgenEnv } from '../components/graph/worldgen.js'
import { loadEnv, registerOwn } from '../components/graph/worldgen.js'
import { Icons } from '../components/index.js'
import { useLocale, useTheme, useTitle } from '../contexts/index.js'
import { fetchRegistries } from '../services/index.js'
import { randomSeed } from '../Utils.js'

const SNAP_KEY = 'misode_graph_snap'
const LIMIT_KEY = 'misode_graph_height_limit'
const SLIDER_KEY = 'misode_graph_slider_range'

/** A range that includes both of its ends, as one that excludes the upper end */
function span(a: number, b: number): HeightRange {
	return { min: Math.min(a, b), max: Math.max(a, b) + 1 }
}

function readJson(key: string): any {
	try {
		const value = JSON.parse(localStorage.getItem(key) ?? 'null')
		return typeof value === 'object' && value !== null ? value : undefined
	} catch (e) {
		return undefined
	}
}

function writeJson(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value))
	} catch (e) {
		// Storage can be full or disabled, the editor still works without it
	}
}

/** Loads something for a key, and never returns what was loaded for another key */
function useLoaded<T>(key: string, load: () => Promise<T>, initial?: T): { value?: T, error?: Error } {
	const [state, setState] = useState<{ key: string, value?: T, error?: Error }>({ key, value: initial })
	useEffect(() => {
		let cancelled = false
		load().then(value => {
			// Keeping the same state when nothing changed means this never causes another render
			if (!cancelled) setState(prev => prev.key === key && prev.value === value ? prev : { key, value })
		}, error => {
			if (!cancelled) setState({ key, error: error instanceof Error ? error : new Error(String(error)) })
		})
		return () => {
			cancelled = true
		}
	}, [key])
	return state.key === key ? state : {}
}

/** The names of the blocks that a dimension uses, so blocks of mods are suggested too */
function collectBlocks(value: unknown, blocks: Set<string>) {
	if (Array.isArray(value)) {
		value.forEach(v => collectBlocks(v, blocks))
	} else if (typeof value === 'object' && value !== null) {
		for (const [key, child] of Object.entries(value)) {
			if (key === 'result_state' || key === 'default_block' || key === 'default_fluid') {
				blocks.add(blockName(child))
			} else {
				collectBlocks(child, blocks)
			}
		}
	}
}

interface Props {
	path?: string
	/** The view of the dimension, for example densities. Without it the home tab is open. */
	demo?: string
	/** From the address of the page: ?version=1.19.2&preset=compact/rim opens an example, and ?version=1.19.2 alone the home tab of that version */
	version?: string
	preset?: string
	/** From the address of the page: ?custom=… opens a dimension of your own */
	custom?: string
}
export function Graph({ demo, version: versionParam, preset: presetParam, custom: customParam }: Props) {
	const { locale } = useLocale()
	const { actualTheme, changeTheme } = useTheme()
	useTitle(locale('title.graph'), GRAPH_VERSIONS.map(v => v.id))
	const dark = actualTheme === 'dark'
	// The names on the tabs follow the dimensions of your own
	useCustomList()

	let active: TabRef | undefined
	if (customParam) {
		active = resolveTab(customTabId(customParam))
	} else if (presetParam) {
		const version = findVersion(versionParam) ?? GRAPH_VERSIONS.find(v => v.presets.some(p => p.id === presetParam))
		const preset = version?.presets.find(p => p.id === presetParam)
		active = version && preset ? resolveTab(exampleTabId(version, preset)) : undefined
	}
	// Every version of the game has an editor of its own, with its own dimensions and tabs. The dimension
	// that is open tells which one this is, and the home tab has it in its address.
	const version = active?.version ?? findVersion(versionParam) ?? recentVersion()
	// From the home tab a dimension opens in the view that was open last
	const sub: Sub = subOfSlug(demo) ?? (active ? 'density' : recentSub())
	const activeId = active?.id

	const [stored, setStored] = useState(readTabs)
	// A tab that the address opens is there right away, and is remembered just after
	const ids = activeId !== undefined && !stored.includes(activeId) ? [...stored, activeId] : stored
	// The dimensions of the other versions stay open in the editors of those versions
	const tabs = ids.map(resolveTab).filter((tab): tab is TabRef => tab !== undefined && tab.version.id === version.id)
	const mine = tabs.map(tab => tab.id)
	useEffect(() => {
		if (activeId === undefined) return
		setStored(prev => {
			if (prev.includes(activeId)) return prev
			const next = [...prev, activeId]
			writeTabs(next)
			return next
		})
	}, [activeId])

	useEffect(() => {
		if (active) {
			rememberSub(sub)
			rememberPlace(version, activeId, sub)
		} else if (demo || presetParam || customParam) {
			// What the address asks for is gone, for example a dimension that was deleted
			route(homeHref(version), true)
		} else {
			rememberPlace(version, undefined, sub)
		}
	}, [activeId, sub, demo, presetParam, customParam, version.id])

	const close = useCallback((id: string) => {
		const at = mine.indexOf(id)
		const next = ids.filter(other => other !== id && resolveTab(other) !== undefined)
		setStored(next)
		writeTabs(next)
		// Closing forgets the undo history and where the graphs were looked at, like closing a document
		dropSession(`tab:${id}`)
		if (id === activeId) {
			const left = mine.filter(other => other !== id)
			const neighbour = resolveTab(left[Math.min(at, left.length - 1)] ?? '')
			route(neighbour ? tabHref(neighbour, sub) : homeHref(version))
		}
	}, [ids.join('\n'), activeId, sub, version.id])

	const move = useCallback((id: string, to: number) => {
		const order = [...mine]
		const from = order.indexOf(id)
		if (from < 0 || to === from || to < 0 || to >= order.length) return
		order.splice(to, 0, ...order.splice(from, 1))
		// The tabs of the other versions keep their order
		const all = [...ids.filter(other => !order.includes(other) && resolveTab(other) !== undefined), ...order]
		setStored(all)
		writeTabs(all)
	}, [ids.join('\n'), version.id])

	const changeVersion = (id: string) => {
		const next = findVersion(id)
		if (next && next.id !== version.id) route(versionHref(next))
	}

	// Deepslate and the ids of the game are shared by all dimensions of a version
	const versionId = active?.version.id
	const { value: env, error: envError } = useLoaded(versionId ?? '', async () => versionId ? loadEnv(versionId) : undefined)
	const { value: vanillaIds } = useLoaded(versionId ?? '', async () => versionId ? fetchRegistries(versionId) : undefined)

	return <main class="gx">
		<div class="gx-appbar" role="banner">
			<Link class="gx-home" href="/" aria-label="Back to all generators" data-tip="Back to all generators" data-tip-side="bottom">
				{Icons.home}
			</Link>
			<TabStrip tabs={tabs} active={activeId} sub={sub} home={homeHref(version)} onClose={close} onMove={move} />
			<div class="gx-appbar-actions">
				<Select class="gx-version" label="Version of Minecraft. Each version has its own dimensions and tabs." value={version.id} onChange={changeVersion}
					options={GRAPH_VERSIONS.map(v => ({ value: v.id, label: `Minecraft ${v.label}` }))} />
				<IconButton icon={dark ? Ico.sun : Ico.moon} label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
					onClick={() => changeTheme(dark ? 'light' : 'dark')} />
			</div>
		</div>
		{!active
			? <HomePage key={version.id} version={version} />
			: active.kind === 'example'
				? <ExampleTab key={active.id} tab={active} sub={sub} env={env} envError={envError} vanillaIds={vanillaIds} dark={dark} />
				: <CustomTab key={active.id} tab={active} sub={sub} env={env} envError={envError} vanillaIds={vanillaIds} dark={dark} />}
	</main>
}

interface TabProps<T extends TabRef> {
	tab: T
	sub: Sub
	env: WorldgenEnv | undefined
	envError: Error | undefined
	vanillaIds: Map<string, string[]> | undefined
	dark: boolean
}

/** A dimension that comes with the editor. It is loaded when it is first opened. */
function ExampleTab({ tab, sub, env, envError, vanillaIds, dark }: TabProps<TabRef & { kind: 'example' }>) {
	const { version, preset } = tab
	const { value: data, error } = useLoaded(tab.id, () => loadPreset(version, preset), loadedPreset(version, preset))
	const failed = error ?? envError
	return <>
		<SubTabs tab={tab} sub={sub}>
			<span>{preset.group === 'Vanilla' ? 'Vanilla example' : `Example of the ${preset.group} data pack`}</span>
			{preset.vanilla && <Link href={`/worldgen/noise-settings/?version=${version.id}&preset=${preset.vanilla}`}>Open in the generator</Link>}
		</SubTabs>
		{failed
			? <Status title={`The ${preset.label} example could not be loaded`} message={failed.message} />
			: !data
				? <div class="gx-status" role="status">
					<span class="gx-spinner" aria-hidden="true" />
					<p>Loading the {preset.label} example…</p>
				</div>
				: <ViewBoundary view={sub}>
					<Workspace tab={tab} sub={sub} label={preset.label} data={data} env={env} vanillaIds={vanillaIds} dark={dark} />
				</ViewBoundary>}
	</>
}

/** A dimension of your own, which this browser remembers */
function CustomTab({ tab, sub, env, envError, vanillaIds, dark }: TabProps<TabRef & { kind: 'custom' }>) {
	const record = useCustom(tab.meta.key)
	return <>
		<SubTabs tab={tab} sub={sub}>
			<span>Your dimension, remembered by this browser</span>
		</SubTabs>
		{envError
			? <Status title={`${tab.meta.id} could not be loaded`} message={envError.message} />
			: !record
				? <Status title={`${tab.meta.id} could not be read`} message="What this browser stored of the dimension is missing or damaged." />
				: <ViewBoundary view={sub}>
					<Workspace tab={tab} sub={sub} label={record.id} data={record} custom={record} env={env} vanillaIds={vanillaIds} dark={dark} />
				</ViewBoundary>}
	</>
}

/**
 * Shows what went wrong when a view cannot be drawn. Without it, a view that fails is left half-drawn
 * on the page, on top of the view that was open before.
 */
class ViewBoundary extends Component<{ view: Sub, children: ComponentChildren }, { error?: Error }> {
	static getDerivedStateFromError(error: unknown) {
		return { error: error instanceof Error ? error : new Error(String(error)) }
	}

	componentDidUpdate(previous: { view: Sub }) {
		// Another view gets its own chance
		if (previous.view !== this.props.view && this.state.error) this.setState({ error: undefined })
	}

	componentDidCatch(error: unknown) {
		console.error(error)
	}

	render() {
		const { error } = this.state
		return error ? <Status title="This view could not be shown" message={error.message} /> : this.props.children
	}
}

function Status({ title, message }: { title: string, message: string }) {
	return <div class="gx-status" role="alert">
		<h2>{title}</h2>
		<p>{message}</p>
		<button type="button" class="gx-btn gx-btn-tonal" onClick={() => location.reload()}>
			<span>Try again</span>
		</button>
	</div>
}

const SUB_TABS: { sub: Sub, label: (rule: string) => string, icon: keyof typeof Ico }[] = [
	{ sub: 'noise', label: () => 'Noise', icon: 'wave' },
	{ sub: 'density', label: () => 'Densities', icon: 'graph' },
	{ sub: 'material', label: rule => `${titleOf(rule)}s`, icon: 'flow' },
	{ sub: 'carver', label: () => 'Carvers', icon: 'cave' },
	{ sub: 'feature', label: () => 'Features', icon: 'tree' },
	{ sub: 'placer', label: () => 'Placers', icon: 'scatter' },
	{ sub: 'dimension', label: () => 'Dimension', icon: 'globe' },
	{ sub: 'view', label: () => 'View', icon: 'cube' },
	{ sub: 'export', label: () => 'Export', icon: 'download' },
]

/** "material rule" as the name of a tab: Material Rule */
function titleOf(text: string) {
	return text.split(' ').map(word => `${word[0].toUpperCase()}${word.slice(1)}`).join(' ')
}

/** The views of the dimension that is open, and a note about where it comes from */
function SubTabs({ tab, sub, children }: { tab: TabRef, sub: Sub, children?: ComponentChildren }) {
	const rule = ruleName(tab.version.format)
	return <div class="gx-subbar">
		<nav class="gx-tabs" aria-label="Views of the dimension">
			{SUB_TABS.map(item => <Link key={item.sub} href={tabHref(tab, item.sub)} class={sub === item.sub ? 'is-active' : ''} aria-current={sub === item.sub ? 'page' : undefined}>
				{Ico[item.icon]}
				<span>{item.label(rule)}</span>
			</Link>)}
		</nav>
		<p class="gx-subbar-note">{children}</p>
	</div>
}

/** What stays while a tab is open, also when another tab is looked at in between */
interface TabSession {
	/**
	 * The graphs that were opened, under `density:` or `material:` and their id.
	 * The final density and the rule of the noise settings have an empty id.
	 */
	stores: Map<string, GraphStore>
	/** Where each graph was looked at */
	views: Map<string, ViewMemo>
	/** The terrain that features are shown on */
	terrain: TerrainMemory
}

/** Where the record of a dimension keeps each kind of thing */
const FIELD = { noise: 'noises', density: 'densityFunctions', material: 'rules', carver: 'carvers', feature: 'features', placer: 'placers' } as const

/** How each kind of thing is called and explained */
function describeKind(kind: ItemKind, format: GraphFormat, versionLabel: string) {
	const rule = ruleName(format)
	switch (kind) {
		case 'noise': return {
			noun: 'noise', title: 'Noises', icon: 'wave' as const, base: 'noise', open: 'Open noises',
			caption: 'Sampled by density functions and rules',
			intro: 'Noises are the random patterns that terrain is made of. Density functions sample them, and rules can use them to mix blocks.',
		}
		case 'density': return {
			noun: 'density function', title: 'Densities', icon: 'graph' as const, base: 'density', open: 'Open density functions',
			caption: 'Used through a Reference node',
			intro: 'The final density is the terrain of the dimension. Other density functions have an id, and are used in graphs through a Reference node.',
			main: { label: 'Final density', caption: 'The terrain of the dimension: solid where it is positive, air where it is negative', hint: 'The terrain of the dimension. Always open.' },
		}
		case 'material': return {
			noun: rule, title: `${titleOf(rule)}s`, icon: 'flow' as const, base: 'rule', open: `Open ${rule}s`,
			caption: 'Used through a Run rule step',
			intro: `The ${rule} of the dimension chooses its blocks. Other rules have an id, and are run from a flowchart with a Run rule step.${format === 'modern' ? '' : ` Minecraft ${versionLabel} has no rules with an id, so they are copied into the surface rule when the dimension is exported.`}`,
			main: { label: titleOf(rule), caption: 'Chooses the blocks of the terrain', hint: `The ${rule} of the dimension. Always open.` },
		}
		case 'carver': return {
			noun: 'carver', title: 'Carvers', icon: 'cave' as const, base: 'caves', open: 'Open carvers',
			caption: 'Cuts caves or canyons out of the terrain',
			intro: `A carver cuts caves or canyons out of the terrain after it is shaped, and before features are placed on it.${format === 'modern' ? '' : ` Minecraft ${versionLabel} calls it a configured carver.`} A carver does nothing by itself. A dimension uses the carvers that are in the list on its Dimension tab.`,
		}
		case 'feature': return {
			noun: 'feature', title: 'Features', icon: 'tree' as const, base: 'feature', open: 'Open features',
			caption: 'Generated where a placer puts it',
			intro: `A feature is something that is generated in one spot: a tree, a vein of ore, a patch of flowers.${format === 'modern' ? '' : ` Minecraft ${versionLabel} calls it a configured feature.`} A feature does nothing by itself. A placer decides where and how often it is generated.`,
		}
		case 'placer': return {
			noun: 'placer', title: 'Placers', icon: 'scatter' as const, base: 'placer', open: 'Open placers',
			caption: 'Places a feature in every chunk',
			intro: 'A placer is what the game calls a placed feature: a feature together with where and how often it is placed in every chunk. A dimension generates the placers that are in the list on its Dimension tab.',
		}
	}
}

const EMPTY_RULE = { type: 'minecraft:sequence', sequence: [] }

/** A list of things by id, without one of them */
function without<T>(items: Record<string, T> | undefined, id: string): Record<string, T> {
	return Object.fromEntries(Object.entries(items ?? {}).filter(([other]) => other !== id))
}

function isItemKind(sub: Sub): sub is ItemKind {
	return sub === 'noise' || sub === 'density' || sub === 'material' || sub === 'carver' || sub === 'feature' || sub === 'placer'
}

/** Remembers a graph a moment after it was changed, and right away when it is left */
function useAutosave(store: GraphStore | undefined, save: (doc: GDoc) => void) {
	const latest = useRef(save)
	latest.current = save
	useEffect(() => {
		if (!store || store.readOnly) return
		let timeout: number | undefined
		let saved = store.doc
		const flush = () => {
			timeout = undefined
			if (store.doc === saved) return
			saved = store.doc
			latest.current(saved)
		}
		const unsubscribe = store.subscribe(() => {
			if (store.doc === saved) return
			if (timeout !== undefined) clearTimeout(timeout)
			timeout = window.setTimeout(flush, 400)
		})
		return () => {
			unsubscribe()
			if (timeout !== undefined) {
				clearTimeout(timeout)
				flush()
			}
		}
	}, [store])
}

interface WorkspaceProps {
	tab: TabRef
	sub: Sub
	/** What the dimension is called in sentences */
	label: string
	data: DimensionData
	/** The dimension when it is one of your own, which is the only kind that can be changed */
	custom?: CustomDimension
	env: WorldgenEnv | undefined
	vanillaIds: Map<string, string[]> | undefined
	dark: boolean
}
function Workspace({ tab, sub, label, data, custom, env, vanillaIds, dark }: WorkspaceProps) {
	const { version } = tab
	const { format } = version
	// How things are shown stays the same when another dimension is opened, so dimensions can be compared
	const [seed, setSeed] = useSessionState('seed', BigInt(2025))
	const newSeed = useCallback(() => setSeed(randomSeed()), [setSeed])
	const editable = custom !== undefined
	const customKey = custom?.key
	const { settings, rule, dimensionType } = data
	const schema = densitySchema(format)
	const namedSchema = densitySchema(format, true)
	const finalDensity = settings?.noise_router?.final_density ?? 0

	// The tabs inside the views that have several things. What is open is remembered for each dimension.
	const [itemTabs, setItemTabs] = useState(() => readItemTabs(tab.id))
	const changeItemTabs = useCallback((kind: ItemKind, change: (tabs: ItemTabList) => ItemTabList) => {
		setItemTabs(prev => {
			const next = { ...prev, [kind]: change(prev[kind]) }
			writeItemTabs(tab.id, next)
			return next
		})
	}, [tab.id])
	const idsOf = (kind: ItemKind) => Object.keys(data[FIELD[kind]])
	const kind = isItemKind(sub) ? sub : undefined
	const hasMain = kind === 'density' || kind === 'material'
	const exists = (id: string) => kind !== undefined && (id === MAIN ? hasMain : idsOf(kind).includes(id))
	// The final density and the rule of the noise settings are always open, and things that were deleted are not
	const openItems = kind === undefined ? [] : [
		...(hasMain ? [MAIN] : []),
		...itemTabs[kind].open.filter(id => id !== MAIN && exists(id)),
	]
	const wanted = kind === undefined ? null : itemTabs[kind].active
	const activeItem = wanted !== null && exists(wanted) ? wanted : null

	const openItem = (id: string) => kind && changeItemTabs(kind, tabs => ({ open: tabs.open.includes(id) ? tabs.open : [...tabs.open, id], active: id }))
	const closeItem = (id: string) => kind && changeItemTabs(kind, tabs => {
		const open = openItems.filter(other => other !== id)
		const at = openItems.indexOf(id)
		// Closing the tab that is shown goes to the one next to it, like the tabs of the dimensions
		return { open, active: tabs.active !== id ? tabs.active : open[Math.min(at, open.length - 1)] ?? null }
	})

	// Examples are there to look at and to copy from, only dimensions of your own can be changed and are remembered.
	// The graphs stay as they are while the tab is open, with their undo history.
	const [session] = useState(() => sessionObject<TabSession>(`tab:${tab.id}`, () => ({ stores: new Map(), views: new Map(), terrain: createTerrainMemory() })))
	session.terrain ??= createTerrainMemory()
	const graphOf = (graph: 'density' | 'material', id: string) => {
		const key = `${graph}:${id}`
		let store = session.stores.get(key)
		if (!store) {
			const doc = graph === 'density'
				? (id === MAIN ? custom?.density ?? densityFromJson(finalDensity, schema) : custom?.densityDocs?.[id] ?? densityFromJson(data.densityFunctions[id], namedSchema))
				: upgradeMaterial(id === MAIN ? custom?.material ?? materialFromJson(rule) : custom?.ruleDocs?.[id] ?? materialFromJson(data.rules[id]))
			store = new GraphStore(doc, !editable)
			session.stores.set(key, store)
		}
		return store
	}
	const viewOf = (key: string) => {
		let memo = session.views.get(key)
		if (!memo) {
			memo = {}
			session.views.set(key, memo)
		}
		return memo
	}
	const densityStore = graphOf('density', MAIN)
	const materialStore = graphOf('material', MAIN)
	const viewMemory = sessionObject('view', createViewMemory)

	// Remember the graph that is open once it is edited, so a reload does not lose work
	const graph = kind === 'density' || kind === 'material' ? kind : undefined
	const activeStore = graph !== undefined && activeItem !== null ? graphOf(graph, activeItem) : undefined
	useAutosave(customKey === undefined ? undefined : activeStore, doc => {
		if (customKey === undefined || graph === undefined || activeItem === null) return
		const id = activeItem
		updateCustom(customKey, record => {
			if (graph === 'density') {
				if (id === MAIN) return { density: doc }
				// A graph that is still open when its function is deleted is not brought back
				return id in record.densityFunctions ? { densityDocs: { ...record.densityDocs, [id]: doc } } : {}
			}
			if (id === MAIN) return { material: doc }
			return id in record.rules ? { ruleDocs: { ...record.ruleDocs, [id]: doc } } : {}
		})
	})

	// References to the noises, density functions and rules of the dimension only work once they are registered.
	// What an editor shows does not depend on the thing that it edits, so changing that does not compute everything again.
	const own = useMemo(() => ownOf(data, format), [data.noises, data.densityFunctions, data.rules, data.carvers, data.features, data.placers, custom?.densityDocs, custom?.ruleDocs, format])
	// What a dimension of the game lists is what the game has, which is registered already
	const versions = useMemo(() => env ? registerOwn(env, data.fromGame ? NO_OWN : own) : undefined, [env, own, data.fromGame])
	const editedKey = graph === 'density' && activeItem ? `density:${activeItem}` : graph === 'material' && activeItem ? `rule:${activeItem}` : undefined
	const rev = versions === undefined ? undefined
		: Object.entries(versions).filter(([key]) => key !== editedKey).map(([key, n]) => `${key}@${n}`).join(' ')
	const worldgen = useMemo<WorldgenEnv | undefined>(() => env && rev !== undefined ? { ...env, rev } : undefined, [env, rev])

	// What the dropdowns offer: the ids of the game, and those of the dimension. The biomes are only the ones of the dimension.
	const allRegistries = useMemo(() => {
		if (!vanillaIds) return undefined
		const result = new Map(vanillaIds)
		const blocks = new Set<string>()
		collectBlocks(settings, blocks)
		collectBlocks(rule, blocks)
		const extra: Record<string, string[]> = {
			block: [...blocks],
			[registryOf('noise', format)]: Object.keys(data.noises),
			[registryOf('density', format)]: Object.keys(data.densityFunctions),
			[registryOf('material', format)]: Object.keys(data.rules),
		}
		for (const [registry, ids] of Object.entries(extra)) {
			const known = result.get(registry) ?? []
			const added = ids.filter(id => !known.includes(id))
			if (added.length > 0) result.set(registry, [...added, ...known])
		}
		// Before 26.3 the game has no rules with an id, so only the rules of the dimension can be run
		if (format === 'legacy') result.set(registryOf('material', format), Object.keys(data.rules))
		result.set('worldgen/biome', data.biomes)
		return result
	}, [vanillaIds, settings, rule, data.noises, data.densityFunctions, data.rules, data.biomes, format])
	// A density function or rule cannot refer to itself, or to something that leads back to it
	const registries = useMemo(() => {
		if (!allRegistries || graph === undefined || !activeItem) return allRegistries
		const circular = circularFor(graph === 'density' ? own.densities : own.rules, activeItem)
		const registry = registryOf(graph, format)
		const result = new Map(allRegistries)
		result.set(registry, (allRegistries.get(registry) ?? []).filter(id => !circular.has(id)))
		return result
	}, [allRegistries, graph, activeItem, own])

	// How the editor shows things. The height range starts as where blocks can be placed in the dimension.
	const [snap, setSnap] = useStoredFlag(SNAP_KEY, false)
	const [limited, setLimited] = useStoredFlag(LIMIT_KEY, false)
	// Sideways the previews reach about one screen to the left and right of what is visible at first.
	// These ranges follow the dimension until they are changed by hand, after that they stay as they were set.
	const [ranges, setRanges] = useSessionState<Partial<Pick<ViewOptions, 'minX' | 'maxX' | 'minY' | 'maxY' | 'minZ' | 'maxZ'>>>('ranges', {})
	const area = useMemo(() => {
		const side = Math.ceil(2.25 * (settings?.noise?.height ?? 256) / 16) * 16
		const minY: number = dimensionType?.min_y ?? settings?.noise?.min_y ?? 0
		const height: number = dimensionType?.height ?? settings?.noise?.height ?? 256
		return { minY, maxY: minY + height - 1, minX: -side, maxX: side, minZ: -side, maxZ: side, ...ranges }
	}, [settings, dimensionType, ranges])
	const [sliders, setSliders] = useState(() => {
		const stored = readJson(SLIDER_KEY)
		return typeof stored?.sliderMin === 'number' && typeof stored?.sliderMax === 'number'
			? { sliderMin: stored.sliderMin as number, sliderMax: stored.sliderMax as number }
			: { sliderMin: -10, sliderMax: 10 }
	})
	const options = useMemo<ViewOptions>(() => ({ snap, limit: limited, ...area, ...sliders }), [snap, limited, area, sliders])
	const changeOptions = useCallback((patch: Partial<ViewOptions>) => {
		const { snap: nextSnap, limit: nextLimit, sliderMin, sliderMax, ...nextArea } = patch
		if (nextSnap !== undefined) setSnap(nextSnap)
		if (nextLimit !== undefined) setLimited(nextLimit)
		if (Object.keys(nextArea).length > 0) setRanges(prev => ({ ...prev, ...nextArea }))
		if (sliderMin !== undefined || sliderMax !== undefined) {
			setSliders(prev => {
				const next = { sliderMin: sliderMin ?? prev.sliderMin, sliderMax: sliderMax ?? prev.sliderMax }
				writeJson(SLIDER_KEY, next)
				return next
			})
		}
	}, [setSnap, setLimited, setRanges])
	const bounds = useMemo<PreviewBounds>(() => {
		const low = Math.min(sliders.sliderMin, sliders.sliderMax)
		const high = Math.max(sliders.sliderMin, sliders.sliderMax)
		return {
			x: span(area.minX, area.maxX),
			z: span(area.minZ, area.maxZ),
			y: limited ? span(area.minY, area.maxY) : undefined,
			slider: { min: low, max: high > low ? high : low + 1 },
		}
	}, [limited, area, sliders])

	const shape = useMemo<NoiseShape>(() => ({
		minY: settings?.noise?.min_y ?? 0,
		height: settings?.noise?.height ?? 256,
		legacyRandom: settings?.legacy_random_source ?? false,
		xzSize: settings?.noise?.size_horizontal ?? 1,
		ySize: settings?.noise?.size_vertical ?? 2,
	}), [settings])

	// The terrain of the rule preview follows the final density
	useStore(densityStore)
	const densityDoc = useStructure(densityStore.doc)
	const settingsText = useMemo(() => JSON.stringify({
		...settings,
		noise_router: { ...settings?.noise_router, final_density: densityToJson(densityDoc, schema) },
		// The rule of your own dimension is a file that only exists once it is exported. Previews apply the rule separately.
		...(editable && format === 'modern' ? { material_rule: EMPTY_RULE } : {}),
	}), [settings, densityDoc, schema, editable, format])

	// A dimension from before every dimension had a biome of its own gets the biome of the game that it used
	const waitsForBiome = custom !== undefined && needsBiome(custom)
	const gameBiome = data.biomes[0]
	useEffect(() => {
		if (!waitsForBiome || customKey === undefined) return
		let cancelled = false
		void fetchGameBiome(version.id, format, gameBiome).then(file => {
			if (!cancelled) updateCustom(customKey, record => needsBiome(record) ? adoptBiome(record, file) : {})
		})
		return () => {
			cancelled = true
		}
	}, [waitsForBiome, customKey, gameBiome])

	// Carvers and features are generated by the editor itself. What they refer to of the game is only downloaded for the views that show them.
	const showsFeatures = sub === 'carver' || sub === 'feature' || sub === 'placer' || sub === 'dimension' || (sub === 'view' && (data.decoration.length > 0 || data.carving.length > 0))
	const { value: game, error: gameError } = useLoaded(showsFeatures ? `features:${version.id}` : '', async () => showsFeatures ? loadVanillaFeatures(version) : undefined)
	// Whether water freezes and snow falls follows the temperature of the biome of the dimension
	const biomeTemperature = biomeOf(data).file?.temperature
	const temperature = typeof biomeTemperature === 'number' ? biomeTemperature : undefined
	const features = useMemo(() => game ? featureDataOf(version, game, own, temperature) : undefined, [game, own, version, temperature])
	const ruleText = JSON.stringify(materialToJson(materialStore.doc))
	const terrain = useMemo<TerrainInput>(() => ({ version, env: worldgen, settings: settingsText, rule: ruleText, seed, biome: gameBiome }), [version, worldgen, settingsText, ruleText, seed, gameBiome])
	const placerIds = useMemo(() => [
		...Object.keys(data.placers),
		...(game ? [...game.placed.keys()] : []).filter(id => !(id in data.placers)).sort(),
	], [data.placers, game])

	// The carvers that the dimension can use: its own first, then those of the game
	const carverIds = useMemo(() => [
		...Object.keys(data.carvers),
		...(vanillaIds?.get(registryOf('carver', format)) ?? []).filter(id => !(id in data.carvers)).sort(),
	], [data.carvers, vanillaIds, format])

	// What the forms of features and placers let a field refer to: what the dimension has first, then what the game has
	const known = useMemo(() => game ? {
		[registryOf('feature', format)]: [...Object.keys(data.features), ...[...game.features.keys()].filter(id => !(id in data.features)).sort()],
		[registryOf('placer', format)]: placerIds,
	} : undefined, [game, data.features, placerIds, format])

	if (sub === 'dimension') {
		return <DimensionEditor version={version} data={data} custom={custom} placerIds={placerIds} carverIds={carverIds} features={features} featuresError={gameError?.message}
			terrain={terrain} memory={session.terrain} dark={dark} />
	}
	if (sub === 'export') {
		return <ExportPanel version={version} data={data} editable={editable} />
	}
	if (sub === 'view' || kind === undefined) {
		return <ViewEditor version={version} tabKey={tab.id} label={label} editable={editable} defaultBiome={data.biomes[0]} env={worldgen} registries={allRegistries} material={materialStore} decoration={data.decoration} carving={data.carving} features={features} settings={settingsText}
			seed={seed} onNewSeed={newSeed} dark={dark} memory={viewMemory} />
	}

	const field = FIELD[kind]
	const info = describeKind(kind, format, version.label)
	const icon = Ico[info.icon]
	const tabs = openItems.map(id => id === MAIN
		? { id, label: info.main?.label ?? '', pinned: true, hint: info.main?.hint }
		: { id, label: id })

	const create = (id: string, json: unknown) => {
		if (customKey === undefined) return
		updateCustom(customKey, record => ({ [field]: { ...record[field], [id]: json } }))
		openItem(id)
	}
	const remove = (id: string) => {
		if (customKey === undefined) return
		session.stores.delete(`${kind}:${id}`)
		session.views.delete(`${kind}:${id}`)
		updateCustom(customKey, record => {
			return kind === 'noise' ? { noises: without(record.noises, id) }
				: kind === 'density' ? { densityFunctions: without(record.densityFunctions, id), densityDocs: without(record.densityDocs, id) }
					: kind === 'material' ? { rules: without(record.rules, id), ruleDocs: without(record.ruleDocs, id) }
						// A carver or placer that is deleted is also no longer used by the dimension
						: kind === 'carver' ? { carvers: without(record.carvers, id), carving: record.carving.filter(other => other !== id) }
							: kind === 'feature' ? { features: without(record.features, id) }
								: { placers: without(record.placers, id), decoration: record.decoration.filter(other => other !== id) }
		})
		closeItem(id)
	}
	const bringOver = (add: Own, id: string) => {
		if (customKey === undefined) return
		updateCustom(customKey, record => ({
			noises: { ...record.noises, ...add.noises },
			densityFunctions: { ...record.densityFunctions, ...add.densities },
			rules: { ...record.rules, ...add.rules },
			carvers: { ...record.carvers, ...add.carvers },
			features: { ...record.features, ...add.features },
			placers: { ...record.placers, ...add.placers },
		}))
		openItem(id)
	}

	const strip = <ItemTabs label={info.open}
		icon={icon} tabs={tabs} active={activeItem} onSelect={id => id === null ? changeItemTabs(kind, t => ({ ...t, active: null })) : openItem(id)} onClose={closeItem} />

	if (activeItem === null) {
		const ofGame = kind === 'material' && format === 'legacy' ? [] : (vanillaIds?.get(registryOf(kind, format)) ?? [])
		return <>
			{strip}
			<ItemsHome kind={kind} version={version} tab={tab} dimensionId={data.id} noun={info.noun} icon={icon} editable={editable} fromGame={data.fromGame === true}
				title={info.title} intro={info.intro} caption={info.caption} base={info.base} main={info.main}
				items={idsOf(kind)} here={own} mainJson={kind === 'density' ? densityToJson(densityStore.doc, schema) : materialToJson(materialStore.doc)}
				vanilla={ofGame} onOpen={openItem} onCreate={create} onDelete={remove} onImport={bringOver} />
		</>
	}

	const resetLabel = activeItem === MAIN ? 'Reset to how the dimension started' : `Reset to how ${activeItem} started`
	const viewKey = `${kind}:${activeItem}`
	return <>
		{strip}
		{kind === 'noise'
			? <NoiseEditor key={viewKey} id={activeItem} json={data.noises[activeItem]} format={format} editable={editable} env={worldgen} shape={shape} seed={seed} onNewSeed={newSeed}
				onChange={json => customKey !== undefined && updateCustom(customKey, record => ({ noises: { ...record.noises, [activeItem]: json } }))} />
			: kind === 'carver'
				? <CarverEditor key={viewKey} id={activeItem} json={data.carvers[activeItem]} version={version} editable={editable} used={data.carving.includes(activeItem)}
					data={features} dataError={gameError?.message} terrain={terrain} memory={session.terrain} dark={dark}
					onChange={json => customKey !== undefined && updateCustom(customKey, record => ({ carvers: { ...record.carvers, [activeItem]: json } }))} />
				: kind === 'feature'
					? <FeatureEditor key={viewKey} id={activeItem} json={data.features[activeItem]} version={version} editable={editable} data={features} dataError={gameError?.message} blocks={vanillaIds?.get('block')} known={known}
						dark={dark} camera={cameraOf(session.terrain, `feature:${activeItem}`)}
						onChange={json => customKey !== undefined && updateCustom(customKey, record => ({ features: { ...record.features, [activeItem]: json } }))} />
					: kind === 'placer'
						? <PlacerEditor key={viewKey} id={activeItem} json={data.placers[activeItem]} version={version} editable={editable} data={features} dataError={gameError?.message} known={known} carving={data.carving}
							terrain={terrain} memory={session.terrain} dark={dark}
							onChange={json => customKey !== undefined && updateCustom(customKey, record => ({ placers: { ...record.placers, [activeItem]: json } }))} />
						: kind === 'density'
							? <DensityEditor key={viewKey} store={activeStore!} schema={activeItem === MAIN ? schema : namedSchema} format={format} env={worldgen} registries={registries}
								name={activeItem === MAIN ? 'final density' : activeItem} shape={shape} seed={seed} onNewSeed={newSeed}
								preset={activeItem === MAIN ? finalDensity : data.densityFunctions[activeItem]} resetLabel={resetLabel}
								options={options} onOptions={changeOptions} bounds={bounds} viewMemo={viewOf(viewKey)} />
							: <MaterialEditor key={viewKey} store={activeStore!} format={format} env={worldgen} registries={registries} ruleId={activeItem === MAIN ? undefined : activeItem}
								settings={settingsText} seed={seed} onNewSeed={newSeed} preset={activeItem === MAIN ? rule : data.rules[activeItem]} resetLabel={resetLabel}
								defaultBiome={data.biomes[0]} options={options} onOptions={changeOptions} bounds={bounds} dark={dark} viewMemo={viewOf(viewKey)} />}
	</>
}
