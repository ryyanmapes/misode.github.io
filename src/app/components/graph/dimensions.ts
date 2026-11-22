import { useEffect, useState } from 'preact/hooks'
import type { VersionId } from '../../services/index.js'
import type { DimensionData, GraphPreset, GraphVersion } from './presets.js'
import { asOneBiome, blankDimension, findVersion, GRAPH_VERSIONS } from './presets.js'
import { dropSession } from './session.js'
import { newId } from './store.js'
import type { GDoc } from './types.js'

/** The list of dimensions that people made themselves, without their contents */
const INDEX_KEY = 'misode_graph_dimensions'
/** Each dimension is stored on its own, so saving one does not rewrite the others */
const RECORD_PREFIX = 'misode_graph_dimension:'
const TABS_KEY = 'misode_graph_tabs'
/** The graphs of the single "Custom" entry that each version had before there were dimensions */
const OLD_GRAPHS_KEY = 'misode_graph_v2'

/** What the lists show of a dimension of your own */
export interface CustomMeta {
	/** Stays the same when the dimension gets another id */
	key: string
	id: string
	version: VersionId
	/** What the dimension was started from, for example "Nether" */
	template: string
	created: number
	modified: number
}

/** A dimension of your own. The graphs are only stored once they are changed. */
export interface CustomDimension extends CustomMeta, DimensionData {
	/** The graph of the final density */
	density?: GDoc
	/** The graph of the rule of the noise settings */
	material?: GDoc
	/** The graphs of the named density functions, by their id */
	densityDocs?: Record<string, GDoc>
	/** The graphs of the named rules, by their id */
	ruleDocs?: Record<string, GDoc>
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

function isDoc(value: unknown, required: string): value is GDoc {
	const doc = value as GDoc | undefined
	return Array.isArray(doc?.nodes) && Array.isArray(doc?.edges) && doc!.nodes.some(n => n.type === required)
}

function docsOf(value: unknown, required: string): Record<string, GDoc> {
	const result: Record<string, GDoc> = {}
	for (const [id, doc] of Object.entries(typeof value === 'object' && value !== null ? value : {})) {
		if (isDoc(doc, required)) result[id] = doc
	}
	return result
}

function metaOf({ key, id, version, template, created, modified }: CustomMeta): CustomMeta {
	return { key, id, version, template, created, modified }
}

let index: CustomMeta[] | undefined
const records = new Map<string, CustomDimension | undefined>()
const listeners = new Set<() => void>()

function emit() {
	for (const fn of [...listeners]) fn()
}

function store(record: CustomDimension) {
	records.set(record.key, record)
	writeJson(RECORD_PREFIX + record.key, record)
	const list = listCustom()
	const meta = metaOf(record)
	index = list.some(m => m.key === record.key) ? list.map(m => m.key === record.key ? meta : m) : [...list, meta]
	writeJson(INDEX_KEY, index)
	emit()
}

/** Turns the graphs of the old "Custom" entries into dimensions, so nothing that was made is lost */
function migrate() {
	const old = readJson(OLD_GRAPHS_KEY) ?? {}
	const now = Date.now()
	for (const version of GRAPH_VERSIONS) {
		const saved = old[`${version.id}/custom`]
		const density = isDoc(saved?.density, 'output') ? saved.density : undefined
		const material = isDoc(saved?.material, 'start') ? saved.material : undefined
		if (!density && !material) continue
		store({
			...blankDimension(version.format, 'custom:custom'),
			key: newId('d'),
			version: version.id,
			template: 'Blank',
			created: now,
			modified: now,
			density,
			material,
		})
	}
}

/** The dimensions that people made themselves, oldest first */
export function listCustom(): CustomMeta[] {
	if (!index) {
		const stored = readJson(INDEX_KEY)
		index = Array.isArray(stored)
			? stored.filter((m: CustomMeta) => typeof m?.key === 'string' && typeof m.id === 'string' && findVersion(m.version) !== undefined)
			: []
		if (stored === undefined) migrate()
	}
	return index!
}

export function loadCustom(key: string): CustomDimension | undefined {
	if (!listCustom().some(m => m.key === key)) return undefined
	if (!records.has(key)) {
		const stored = readJson(RECORD_PREFIX + key)
		const valid = stored !== undefined && stored.key === key && typeof stored.dimension === 'object' && typeof stored.settings === 'object'
		records.set(key, valid ? asOneBiome({
			...stored,
			biomes: Array.isArray(stored.biomes) && stored.biomes.length > 0 ? stored.biomes : ['minecraft:plains'],
			densityFunctions: stored.densityFunctions ?? {},
			noises: stored.noises ?? {},
			rules: stored.rules ?? {},
			features: stored.features ?? {},
			placers: stored.placers ?? {},
			decoration: Array.isArray(stored.decoration) ? stored.decoration.filter((id: unknown) => typeof id === 'string') : [],
			carvers: stored.carvers ?? {},
			carving: Array.isArray(stored.carving) ? stored.carving.filter((id: unknown) => typeof id === 'string') : [],
			templates: Object.fromEntries(Object.entries(stored.templates ?? {}).filter(([, meta]) => typeof (meta as any)?.hash === 'string' && Array.isArray((meta as any).size))),
			// Only the examples are dimensions of the game
			fromGame: undefined,
			densityDocs: docsOf(stored.densityDocs, 'output'),
			ruleDocs: docsOf(stored.ruleDocs, 'start'),
			biomeFiles: stored.biomeFiles ?? {},
			density: isDoc(stored.density, 'output') ? stored.density : undefined,
			material: isDoc(stored.material, 'start') ? stored.material : undefined,
		}) : undefined)
	}
	return records.get(key)
}

/** Stores a new dimension of your own */
export function createCustom(version: GraphVersion, template: string, data: DimensionData & Pick<CustomDimension, 'density' | 'material' | 'densityDocs' | 'ruleDocs'>): CustomDimension {
	const now = Date.now()
	const record: CustomDimension = { ...data, key: newId('d'), version: version.id, template, created: now, modified: now }
	store(record)
	return record
}

/** Changes a dimension of your own and remembers it. The change can depend on what the dimension is now. */
export function updateCustom(key: string, patch: Partial<CustomDimension> | ((record: CustomDimension) => Partial<CustomDimension>)) {
	const record = loadCustom(key)
	if (!record) return
	store({ ...record, ...(typeof patch === 'function' ? patch(record) : patch), key, modified: Date.now() })
}

export function deleteCustom(key: string) {
	records.delete(key)
	index = listCustom().filter(m => m.key !== key)
	writeJson(INDEX_KEY, index)
	try {
		localStorage.removeItem(RECORD_PREFIX + key)
	} catch (e) {
		// Nothing to remove when storage is disabled
	}
	dropSession(`tab:${customTabId(key)}`)
	dropItemTabs(customTabId(key))
	emit()
}

/** Whether another dimension of your own already has this id in this version, which would make their files collide */
export function isIdTaken(version: VersionId, id: string, exceptKey?: string) {
	return listCustom().some(m => m.version === version && m.id === id && m.key !== exceptKey)
}

/** An id that no dimension of your own has yet in this version */
export function freeId(version: VersionId, wanted: string) {
	if (!isIdTaken(version, wanted)) return wanted
	for (let n = 2; ; n += 1) {
		if (!isIdTaken(version, `${wanted}_${n}`)) return `${wanted}_${n}`
	}
}

function useStorage<T>(read: () => T): T {
	const [, setTick] = useState(0)
	useEffect(() => {
		const listener = () => setTick(t => t + 1)
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}, [])
	return read()
}

export function useCustomList() {
	return useStorage(listCustom)
}

export function useCustom(key: string) {
	return useStorage(() => loadCustom(key))
}

/** A dimension that can be open in a tab: an example, or one of your own */
export type TabRef =
	| { kind: 'example', id: string, version: GraphVersion, preset: GraphPreset }
	| { kind: 'custom', id: string, version: GraphVersion, meta: CustomMeta }

export function exampleTabId(version: GraphVersion, preset: GraphPreset) {
	return `x/${version.id}/${preset.id}`
}

export function customTabId(key: string) {
	return `c/${key}`
}

/** Finds what a tab shows. Returns nothing when it no longer exists. */
export function resolveTab(id: string): TabRef | undefined {
	const [kind, first, ...rest] = id.split('/')
	if (kind === 'c') {
		const meta = listCustom().find(m => m.key === first)
		const version = findVersion(meta?.version)
		return meta && version ? { kind: 'custom', id, version, meta } : undefined
	}
	if (kind === 'x') {
		const version = GRAPH_VERSIONS.find(v => v.id === first)
		const preset = version?.presets.find(p => p.id === rest.join('/'))
		return version && preset ? { kind: 'example', id, version, preset } : undefined
	}
	return undefined
}

const VERSION_KEY = 'misode_graph_version'

/** The version of the game that the editor was last used for. Each version has an editor of its own. */
export function recentVersion(): GraphVersion {
	try {
		return findVersion(localStorage.getItem(VERSION_KEY) ?? undefined) ?? GRAPH_VERSIONS[0]
	} catch (e) {
		return GRAPH_VERSIONS[0]
	}
}

/** What each version was last showing, so going back to a version goes back to what was open there */
const lastPlace = new Map<VersionId, { tab: string | undefined, sub: Sub }>()

/** The address of the home tab of a version */
export function homeHref(version: GraphVersion) {
	return `/graph/?version=${version.label}`
}

/** Remembers the tab that a version shows, which is the home tab when there is none */
export function rememberPlace(version: GraphVersion, tab: string | undefined, sub: Sub) {
	lastPlace.set(version.id, { tab, sub })
	try {
		localStorage.setItem(VERSION_KEY, version.id)
	} catch (e) {
		// The version is still remembered until the page is closed
	}
}

/** Where the editor of a version opens: what was open there last, or its home tab */
export function versionHref(version: GraphVersion) {
	const place = lastPlace.get(version.id)
	// The dimension can be gone by now
	const tab = place?.tab === undefined ? undefined : resolveTab(place.tab)
	return tab && place ? tabHref(tab, place.sub) : homeHref(version)
}

/** The part of the address that opens a tab */
export function tabQuery(tab: TabRef) {
	return tab.kind === 'custom' ? `?custom=${tab.meta.key}` : `?version=${tab.version.label}&preset=${tab.preset.id}`
}

/** The tabs that were open when the editor was last used */
export function readTabs(): string[] {
	try {
		const stored = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]')
		return Array.isArray(stored) ? [...new Set(stored.filter((id): id is string => typeof id === 'string' && resolveTab(id) !== undefined))] : []
	} catch (e) {
		return []
	}
}

export function writeTabs(tabs: string[]) {
	writeJson(TABS_KEY, tabs)
}

/** The views of a dimension, which are the tabs below the dimension tabs */
export type Sub = 'noise' | 'density' | 'material' | 'carver' | 'template' | 'feature' | 'placer' | 'dimension' | 'view' | 'export'

/** The part of the address that opens each view */
export const SLUGS: Record<Sub, string> = { noise: 'noise', density: 'densities', material: 'material-rules', carver: 'carvers', template: 'templates', feature: 'features', placer: 'placers', dimension: 'dimension', view: 'view', export: 'export' }

/** What the views were called before a dimension could have more than one density function and rule */
const OLD_SLUGS: Record<string, Sub> = { 'final-density': 'density', 'material-rule': 'material' }

export function subOfSlug(slug: string | undefined): Sub | undefined {
	if (slug === undefined) return undefined
	return (Object.keys(SLUGS) as Sub[]).find(sub => SLUGS[sub] === slug) ?? OLD_SLUGS[slug]
}

/** The views in which a dimension has several things that each open in a tab of their own */
export type ItemKind = 'noise' | 'density' | 'material' | 'carver' | 'template' | 'feature' | 'placer'

/** Stands for the final density or the rule of the noise settings, which every dimension has and which have no id of their own */
export const MAIN = ''

/** The tabs of one view: the ids of what is open, and the one that is shown. Nothing shown means its home tab. */
export interface ItemTabs {
	open: string[]
	active: string | null
}

export type ItemTabState = Record<ItemKind, ItemTabs>

const ITEMS_PREFIX = 'misode_graph_items:'

function itemTabs(value: any, fallback: ItemTabs): ItemTabs {
	if (!Array.isArray(value?.open)) return fallback
	const open = [...new Set((value.open as unknown[]).filter((id): id is string => typeof id === 'string'))]
	return { open, active: typeof value.active === 'string' && open.includes(value.active) ? value.active : null }
}

/** The tabs that were open inside the views of a dimension. A dimension starts with its final density and its rule open. */
export function readItemTabs(tabId: string): ItemTabState {
	const stored = readJson(ITEMS_PREFIX + tabId)
	return {
		noise: itemTabs(stored?.noise, { open: [], active: null }),
		density: itemTabs(stored?.density, { open: [MAIN], active: MAIN }),
		material: itemTabs(stored?.material, { open: [MAIN], active: MAIN }),
		carver: itemTabs(stored?.carver, { open: [], active: null }),
		template: itemTabs(stored?.template, { open: [], active: null }),
		feature: itemTabs(stored?.feature, { open: [], active: null }),
		placer: itemTabs(stored?.placer, { open: [], active: null }),
	}
}

export function writeItemTabs(tabId: string, state: ItemTabState) {
	writeJson(ITEMS_PREFIX + tabId, state)
}

export function dropItemTabs(tabId: string) {
	try {
		localStorage.removeItem(ITEMS_PREFIX + tabId)
	} catch (e) {
		// Nothing to remove when storage is disabled
	}
}

let lastSub: Sub = 'density'

/** The view that was open last, which is where another dimension opens too */
export function recentSub() {
	return lastSub
}

export function rememberSub(sub: Sub) {
	lastSub = sub
}

export function tabHref(tab: TabRef, sub: Sub = lastSub) {
	return `/graph/${SLUGS[sub]}/${tabQuery(tab)}`
}
