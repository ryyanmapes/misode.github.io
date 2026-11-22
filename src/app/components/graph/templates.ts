import type { NbtCompound, NbtTag } from 'deepslate/nbt'
import { NbtFile, NbtType } from 'deepslate/nbt'
import { useEffect, useState } from 'preact/hooks'
import sparkmd5 from 'spark-md5'
import { fetchStructureTemplate } from '../../services/index.js'
import { listCustom, loadCustom } from './dimensions.js'
import type { GraphVersion } from './presets.js'
import type { GraphFormat } from './types.js'
import type { SliceVolume } from './view/slice.js'
import { WorldSlice } from './view/slice.js'
import type { VolumeBlock } from './worldgen.js'

/**
 * What a dimension remembers of a template: which file it is, and what the lists show of it.
 * The file itself is a structure file of the game, which is kept in the browser apart from the dimension.
 */
export interface TemplateMeta {
	/** Tells the file apart from every other file. Dimensions with the same template share one file. */
	hash: string
	/** How many blocks the template is wide (X), high (Y) and deep (Z) */
	size: [number, number, number]
	/** How many blocks it places, not counting air */
	blocks: number
	/** How large the file is */
	bytes: number
	/** Where the file came from: the name of a file, or the id of a template of the game */
	source: string
}

export interface TemplateBlock {
	name: string
	properties: Record<string, string>
}

/** A block of a template that has more than its state, such as a chest with its items or a command block with its command */
export interface TemplateBlockData {
	x: number
	y: number
	z: number
	block: string
	/** What is worth knowing about it, as names and values */
	facts: [string, string][]
}

/** A template as it is read from its file */
export interface ParsedTemplate {
	size: [number, number, number]
	/** The kinds of blocks */
	palette: TemplateBlock[]
	/** For every position the index in the palette plus one, at (x * sizeZ + z) * sizeY + y. Zero where the template has nothing. */
	cells: Uint16Array
	/** How many blocks the template places, not counting air */
	blocks: number
	/** How often each block occurs, most common first */
	counts: { name: string, count: number }[]
	blockData: TemplateBlockData[]
	/** The entities that are saved with it, most common first */
	entities: { id: string, count: number }[]
	/** How many variants of its blocks the file has. Only the first is read. */
	variants: number
	/** The version of the game that saved the file, as the number that the game gives its versions */
	dataVersion: number | undefined
}

/** The folder of a data pack that templates are in. Before 1.21 folders had plural names. */
export function templateFolder(format: GraphFormat) {
	return format === 'modern' ? 'structure' : 'structures'
}

/** Where the file of a template goes in a data pack */
export function templatePath(format: GraphFormat, id: string) {
	const [namespace, path] = id.includes(':') ? id.split(':') : ['minecraft', id]
	return `data/${namespace}/${templateFolder(format)}/${path}.nbt`
}

/** Blocks that stand for nothing being there */
const NOTHING = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void'])

function fullId(id: string) {
	return id.includes(':') ? id : `minecraft:${id}`
}

function text(tag: NbtTag | undefined): string | undefined {
	return tag?.isString() ? tag.getAsString() : undefined
}

function numbers(tag: NbtTag | undefined): number[] {
	return tag?.isListOrArray() ? tag.getItems().map(item => item.isNumber() ? item.getAsNumber() : NaN) : []
}

/** What is worth showing of the data of a block. Everything else stays in the file. */
function factsOf(nbt: NbtCompound): [string, string][] {
	const facts: [string, string][] = []
	const add = (label: string, value: string | undefined) => {
		if (value !== undefined && value !== '') facts.push([label, value])
	}
	// The names of these fields have changed between versions of the game before, so both ways of writing them are read
	const command = nbt.has('Command') ? 'Command' : nbt.has('command') ? 'command' : undefined
	if (command) {
		add('Command', nbt.getString(command) || '(empty)')
		add('Runs', nbt.getBoolean('auto') ? 'Always active' : 'When powered by redstone')
	}
	add('Loot table', text(nbt.get('LootTable')) ?? text(nbt.get('loot_table')))
	const spawn = nbt.getCompound('SpawnData')
	add('Spawns', text(spawn.getCompound('entity').get('id')) ?? text(spawn.get('id')))
	// A jigsaw block joins pieces of a structure
	add('Pool', text(nbt.get('pool')))
	add('Name', text(nbt.get('name')))
	add('Target', text(nbt.get('target')))
	add('Turns into', text(nbt.get('final_state')))
	// A structure block in data mode marks a place for the game to fill in
	add('Mode', text(nbt.get('mode')))
	add('Marker', text(nbt.get('metadata')))
	const items = nbt.get('Items')
	if (items?.isListOrArray() && items.length > 0) add('Items', `${items.length} stack${items.length === 1 ? '' : 's'}`)
	return facts
}

/** Reads a structure file of the game. Throws when the file is something else. */
export function parseTemplate(bytes: Uint8Array): ParsedTemplate {
	let root: NbtCompound
	try {
		root = NbtFile.read(bytes).root
	} catch (e) {
		throw new Error('This is not a structure file of the game')
	}
	const size = numbers(root.get('size'))
	if (size.length !== 3 || size.some(n => !Number.isInteger(n) || n < 0 || n > 1024) || !root.hasList('blocks')) {
		throw new Error('This file is not a structure that was saved with a structure block')
	}
	const [sizeX, sizeY, sizeZ] = size
	// Some structures of the game come in several variants that differ in their blocks, of which the game picks one
	const variants = root.getList('palettes', NbtType.List)
	const paletteTag = variants.length > 0 ? variants.get(0)! : root.getList('palette', NbtType.Compound)
	const palette: TemplateBlock[] = paletteTag.getItems().map(tag => {
		const entry = tag as NbtCompound
		const properties: Record<string, string> = {}
		// Since 26.3 a block is written with `id` and `properties`, before that with `Name` and `Properties`
		entry.getCompound(entry.has('Properties') ? 'Properties' : 'properties').forEach((key, value) => {
			properties[key] = value.isString() ? value.getAsString() : value.toString()
		})
		return { name: fullId(entry.getString('Name') || entry.getString('id') || 'air'), properties }
	})

	const cells = new Uint16Array(sizeX * sizeY * sizeZ)
	const counts = new Map<string, number>()
	const blockData: TemplateBlockData[] = []
	let blocks = 0
	root.getList('blocks', NbtType.Compound).forEach(block => {
		const [x, y, z] = numbers(block.get('pos'))
		const state = block.getNumber('state')
		const kind = palette[state]
		if (!kind || !(x >= 0 && x < sizeX && y >= 0 && y < sizeY && z >= 0 && z < sizeZ)) return
		cells[(x * sizeZ + z) * sizeY + y] = state + 1
		if (NOTHING.has(kind.name)) return
		blocks += 1
		counts.set(kind.name, (counts.get(kind.name) ?? 0) + 1)
		if (block.hasCompound('nbt')) blockData.push({ x, y, z, block: kind.name, facts: factsOf(block.getCompound('nbt')) })
	})

	const entities = new Map<string, number>()
	root.getList('entities', NbtType.Compound).forEach(entity => {
		const id = fullId(entity.getCompound('nbt').getString('id') || 'unknown')
		entities.set(id, (entities.get(id) ?? 0) + 1)
	})
	const byCount = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

	return {
		size: [sizeX, sizeY, sizeZ],
		palette,
		cells,
		blocks,
		counts: byCount(counts).map(([name, count]) => ({ name, count })),
		blockData: blockData.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z),
		entities: byCount(entities).map(([id, count]) => ({ id, count })),
		variants: Math.max(1, variants.length),
		dataVersion: root.hasNumber('DataVersion') ? root.getNumber('DataVersion') : undefined,
	}
}

// === Where the files are kept ===
// A dimension is remembered as text, which a file would make large and slow. The files are kept
// in a database of the browser instead, each under a number that is worked out from its contents.

const DB_NAME = 'misode_graph_templates'
const STORE = 'files'

/** The files that were read or added since the page opened, which also works when the browser has no database */
const files = new Map<string, Uint8Array>()
/** The files that were added since the page opened */
const added = new Set<string>()
const parsed = new Map<string, ParsedTemplate>()

let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
	database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1)
		request.onupgradeneeded = () => request.result.createObjectStore(STORE)
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
	return database
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return openDatabase().then(db => new Promise<T>((resolve, reject) => {
		const pending = run(db.transaction(STORE, mode).objectStore(STORE))
		pending.onsuccess = () => resolve(pending.result)
		pending.onerror = () => reject(pending.error)
	}))
}

/**
 * Keeps a structure file and tells what it is. Throws when the file cannot be read as a template.
 * `source` is where it came from, for people to recognise it by.
 */
export async function addTemplateFile(bytes: Uint8Array, source: string): Promise<TemplateMeta> {
	const template = parseTemplate(bytes)
	const hash = sparkmd5.ArrayBuffer.hash(bytes.slice().buffer)
	files.set(hash, bytes)
	parsed.set(hash, template)
	added.add(hash)
	try {
		await request('readwrite', store => store.put(bytes, hash))
	} catch (e) {
		// Without a database the file is there until the page is closed
	}
	return { hash, size: template.size, blocks: template.blocks, bytes: bytes.length, source }
}

/** The file of a template, or nothing when this browser no longer has it */
export async function templateBytes(hash: string): Promise<Uint8Array | undefined> {
	const known = files.get(hash)
	if (known) return known
	try {
		const stored = await request<unknown>('readonly', store => store.get(hash))
		if (stored instanceof Uint8Array) {
			files.set(hash, stored)
			return stored
		}
	} catch (e) {
		// No database, so no file
	}
	return undefined
}

export const MISSING_FILE = 'This browser no longer has the file of this template. Delete the template and import the file again.'

/** A template as it is in its file */
export async function loadTemplate(hash: string): Promise<ParsedTemplate> {
	const known = parsed.get(hash)
	if (known) return known
	const bytes = await templateBytes(hash)
	if (!bytes) throw new Error(MISSING_FILE)
	const template = parseTemplate(bytes)
	parsed.set(hash, template)
	return template
}

/** The template of a file, once it is read */
export function useTemplate(hash: string): { template?: ParsedTemplate, error?: string } {
	const [state, setState] = useState<{ hash: string, template?: ParsedTemplate, error?: string }>(() => ({ hash, template: parsed.get(hash) }))
	useEffect(() => {
		let cancelled = false
		loadTemplate(hash).then(template => {
			// Keeping the same state when nothing changed means this never causes another render
			if (!cancelled) setState(prev => prev.hash === hash && prev.template === template ? prev : { hash, template })
		}, e => {
			if (!cancelled) setState({ hash, error: e instanceof Error ? e.message : String(e) })
		})
		return () => {
			cancelled = true
		}
	}, [hash])
	return state.hash === hash ? state : { template: parsed.get(hash) }
}

// === Templates for the previews of features ===
// A preview is made in one go, and a file takes a moment to read. A template that is asked for
// before its file is read is `loading`, and everyone who listens is told when it is there.

const loadListeners = new Set<() => void>()
/** The templates of the game that were asked for, by version and id. Nothing for one that could not be downloaded. */
const vanillaTemplates = new Map<string, ParsedTemplate | 'loading' | undefined>()
/** The files of the dimension that are being read, or could not be */
const ownLoads = new Map<string, 'loading' | 'failed'>()

function templateLoaded() {
	for (const listener of [...loadListeners]) listener()
}

/** A number that changes when a template that a preview asked for has been read, which is when the preview can be made again */
export function useTemplateLoads(): number {
	const [count, setCount] = useState(0)
	useEffect(() => {
		const listener = () => setCount(n => n + 1)
		loadListeners.add(listener)
		return () => {
			loadListeners.delete(listener)
		}
	}, [])
	return count
}

/**
 * The templates that the features of a dimension can place: its own first, then those of the game.
 * `vanilla` are the ids of the templates of the game, once they are known.
 */
export function templateSource(version: GraphVersion, own: Record<string, TemplateMeta>, vanilla: string[] | undefined): (id: string) => ParsedTemplate | 'loading' | undefined {
	return wanted => {
		const id = fullId(wanted)
		const meta = own[id]
		if (meta) {
			const known = parsed.get(meta.hash)
			if (known) return known
			const state = ownLoads.get(meta.hash)
			// A file that could not be read is not tried again and again
			if (state === 'failed') return undefined
			if (state === undefined) {
				ownLoads.set(meta.hash, 'loading')
				loadTemplate(meta.hash).then(() => ownLoads.delete(meta.hash), () => ownLoads.set(meta.hash, 'failed')).then(templateLoaded)
			}
			return 'loading'
		}
		if (!id.startsWith('minecraft:') || (vanilla && !vanilla.includes(id))) return undefined
		const key = `${version.id} ${id}`
		if (!vanillaTemplates.has(key)) {
			vanillaTemplates.set(key, 'loading')
			fetchVanillaTemplate(version, id).then(parseTemplate).then(template => vanillaTemplates.set(key, template), () => vanillaTemplates.set(key, undefined)).then(templateLoaded)
		}
		return vanillaTemplates.get(key)
	}
}

/** Downloads the file of a template of the game */
export function fetchVanillaTemplate(version: GraphVersion, id: string): Promise<Uint8Array> {
	return fetchStructureTemplate(version.id, templateFolder(version.format), fullId(id).replace(/^minecraft:/, ''))
}

/**
 * Throws away the files that no dimension has a template of any more. Files that were added
 * since the page opened stay, since the dimension that they are for may not be stored yet.
 */
export async function sweepTemplates() {
	try {
		const used = new Set<string>(added)
		for (const meta of listCustom()) {
			for (const template of Object.values(loadCustom(meta.key)?.templates ?? {})) used.add(template.hash)
		}
		const stored = await request('readonly', store => store.getAllKeys())
		for (const key of stored) {
			if (typeof key === 'string' && !used.has(key)) await request('readwrite', store => store.delete(key))
		}
	} catch (e) {
		// Files that stay take up room, and nothing else
	}
}

/** What the lists say about a template: its size and how many blocks it has */
export function describeTemplate(meta: Pick<TemplateMeta, 'size' | 'blocks'>) {
	return `${meta.size.join(' × ')} · ${meta.blocks.toLocaleString('en')} block${meta.blocks === 1 ? '' : 's'}`
}

export function formatBytes(bytes: number) {
	return bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A template as a piece of world to look at, standing in the middle of its chunks */
export class TemplateVolume implements SliceVolume {
	readonly minY = 0
	readonly height: number
	readonly palette: VolumeBlock[] = [{ name: 'minecraft:air', properties: {}, fluid: false }]
	readonly chunksX: number
	readonly chunksZ: number
	/** Where the corner of the template is in the world of the slice */
	readonly origin: [number, number, number]
	/** For every kind of block of the template its index in the palette of the volume */
	private readonly kinds: number[]

	constructor(readonly template: ParsedTemplate) {
		const [sizeX, sizeY, sizeZ] = template.size
		this.height = Math.max(1, sizeY)
		this.chunksX = Math.max(1, Math.ceil(sizeX / 16))
		this.chunksZ = Math.max(1, Math.ceil(sizeZ / 16))
		// A slice starts half of its chunks before the middle of the world
		this.origin = [
			-Math.floor(this.chunksX / 2) * 16 + Math.floor((this.chunksX * 16 - sizeX) / 2),
			0,
			-Math.floor(this.chunksZ / 2) * 16 + Math.floor((this.chunksZ * 16 - sizeZ) / 2),
		]
		this.kinds = template.palette.map(kind => NOTHING.has(kind.name) ? 0 : this.indexOf(kind.name, kind.properties))
	}

	indexOf(name: string, properties: Record<string, string>): number {
		const names = Object.keys(properties).sort()
		const found = this.palette.findIndex(kind => kind.name === name && Object.keys(kind.properties).length === names.length && names.every(key => kind.properties[key] === properties[key]))
		if (found !== -1) return found
		this.palette.push({ name, properties: { ...properties }, fluid: name === 'minecraft:water' || name === 'minecraft:lava' })
		return this.palette.length - 1
	}

	generate(chunkX: number, chunkZ: number): Uint16Array {
		const { height, template } = this
		const [sizeX, sizeY, sizeZ] = template.size
		const chunk = new Uint16Array(256 * height)
		for (let x = 0; x < 16; x += 1) {
			const tx = chunkX * 16 + x - this.origin[0]
			if (tx < 0 || tx >= sizeX) continue
			for (let z = 0; z < 16; z += 1) {
				const tz = chunkZ * 16 + z - this.origin[2]
				if (tz < 0 || tz >= sizeZ) continue
				for (let y = 0; y < sizeY; y += 1) {
					const cell = template.cells[(tx * sizeZ + tz) * sizeY + y]
					if (cell !== 0) chunk[(x * 16 + z) * height + y] = this.kinds[cell - 1]
				}
			}
		}
		return chunk
	}

	slice(): WorldSlice {
		return new WorldSlice(this, this.chunksX, this.chunksZ)
	}
}
