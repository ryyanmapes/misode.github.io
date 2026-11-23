import type { LanguageError } from '@spyglassmc/core'
import type { JsonNode } from '@spyglassmc/json'
import { JsonArrayNode, JsonFileNode, JsonObjectNode, JsonStringNode } from '@spyglassmc/json'
import type { SpyglassService } from '../../services/Spyglass.js'
import { idRegistryOf } from '../generator/McdocRenderer.jsx'
import type { PackFile } from './datapack.js'
import type { GraphVersion } from './presets.js'

/** Something in a file of a data pack that the game refuses, or that is worth a look */
export interface Finding {
	/** An error keeps the pack from loading or crashes the game. A warning is something that the game accepts and that may not be meant. */
	level: 'error' | 'warning'
	/** The file of the data pack */
	path: string
	/** Where in the file, as the keys that lead there. Empty for the file as a whole. */
	where: string
	message: string
}

type Path = (string | number)[]

function isObj(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fullId(id: string) {
	return id.includes(':') ? id : `minecraft:${id}`
}

function shortId(value: unknown) {
	return typeof value === 'string' ? value.replace(/^minecraft:/, '') : ''
}

function whereOf(path: Path) {
	return path.map((step, i) => typeof step === 'number' ? `[${step}]` : i === 0 ? step : `.${step}`).join('')
}

/** The folders of a data pack that the editor writes, with the registry that each stands for. A longer name comes before a name that it starts with. */
const FOLDERS: [string, string][] = [
	['dimension_type', 'dimension_type'],
	['dimension', 'dimension'],
	['worldgen/noise_settings', 'worldgen/noise_settings'],
	['worldgen/material_rule', 'worldgen/material_rule'],
	['worldgen/density_function', 'worldgen/density_function'],
	['worldgen/noise', 'worldgen/noise'],
	['worldgen/configured_carver', 'worldgen/configured_carver'],
	['worldgen/carver', 'worldgen/carver'],
	['worldgen/configured_feature', 'worldgen/configured_feature'],
	['worldgen/feature', 'worldgen/feature'],
	['worldgen/placed_feature', 'worldgen/placed_feature'],
	['worldgen/biome', 'worldgen/biome'],
	['structures', 'structure'],
	['structure', 'structure'],
]

/** Which thing of which registry a file of a data pack is, going by where it is */
export function fileIdentity(path: string): { registry: string, id: string } | undefined {
	const match = /^data\/([^/]+)\/(.+)\.(?:json|nbt)$/.exec(path)
	if (!match) return undefined
	for (const [folder, registry] of FOLDERS) {
		if (match[2].startsWith(`${folder}/`)) return { registry, id: `${match[1]}:${match[2].slice(folder.length + 1)}` }
	}
	return undefined
}

/**
 * Whether the lowest of two heights is above the highest. Heights can only be compared when they are measured
 * from the same place: both as a Y, both from the bottom of the world or both from its top.
 */
function upsideDown(min: unknown, max: unknown): boolean {
	if (!isObj(min) || !isObj(max)) return false
	for (const anchor of ['absolute', 'above_bottom', 'below_top']) {
		const low = min[anchor]
		const high = max[anchor]
		if (typeof low !== 'number' || typeof high !== 'number') continue
		// Further below the top is lower
		return anchor === 'below_top' ? low < high : low > high
	}
	return false
}

/**
 * What the format of the game allows and the game still refuses, in one file. These are the mistakes that are easy
 * to make in a form: an empty list where the game picks from it, a text where it wants an object, a range the wrong way round.
 */
function lint(value: unknown, path: Path, modern: boolean, report: (level: Finding['level'], path: Path, message: string) => void) {
	if (Array.isArray(value)) {
		value.forEach((item, i) => lint(item, [...path, i], modern, report))
		return
	}
	if (!isObj(value)) return
	const type = shortId(value.type)

	if (type === 'template' && Array.isArray(value.templates)) {
		if (value.templates.length === 0) {
			report('warning', [...path, 'templates'], 'This feature lists no templates, so it has nothing to place.')
		}
		value.templates.forEach((entry, i) => {
			// An entry of a weighted list keeps what it is in "data"
			const wrapped = isObj(entry) && isObj(entry.data)
			const data = wrapped ? entry.data : entry
			if (isObj(data) && Array.isArray(data.rotations) && data.rotations.length === 0) {
				report('error', [...path, 'templates', i, ...(wrapped ? ['data'] : []), 'rotations'],
					'An empty list of rotations crashes the game when the feature is placed, because it picks one of them at random. Take the list away to allow every rotation, or add "none" to never turn the template.')
			}
		})
	}
	if (modern && type === 'spring_feature' && typeof value.state === 'string') {
		report('error', [...path, 'state'],
			`The game does not take the fluid of a spring as a text, and refuses the pack. Choose the form with an id and properties, as the springs of the game have: { "id": "${fullId(value.state)}", "properties": { "falling": "true" } }`)
	}
	if (type === 'simple_random_selector' && Array.isArray(value.features) && value.features.length === 0) {
		report('error', [...path, 'features'], 'A selector without features has nothing to pick from, which crashes the game when it is placed.')
	}

	const min = value.min_inclusive
	if (typeof min === 'number' && typeof value.max_inclusive === 'number' && min > value.max_inclusive) {
		report('error', path, `The minimum (${min}) is above the maximum (${value.max_inclusive}). The game refuses a range like that, and with it the pack.`)
	} else if (typeof min === 'number' && typeof value.max_exclusive === 'number' && min >= value.max_exclusive) {
		report('error', path, `The minimum (${min}) is not below the maximum (${value.max_exclusive}). The game refuses a range like that, and with it the pack.`)
	} else if (upsideDown(min, value.max_inclusive)) {
		report('warning', path, 'The lowest height is above the highest one. The game logs "Empty height range" and then always uses the lowest height.')
	}

	for (const [key, child] of Object.entries(value)) {
		lint(child, [...path, key], modern, report)
	}
}

/** The findings that need nothing but the files themselves */
export function lintFiles(version: GraphVersion, files: PackFile[]): Finding[] {
	const findings: Finding[] = []
	for (const file of files) {
		if (file.json === undefined || !file.path.startsWith('data/')) continue
		lint(file.json, [], version.format === 'modern', (level, path, message) => findings.push({ level, path: file.path, where: whereOf(path), message }))
	}
	return findings
}

/** The value that an error is about, with the keys that lead to it */
function locate(node: JsonNode | undefined, offset: number, path: Path = []): { path: Path, node: JsonNode | undefined } {
	if (JsonObjectNode.is(node)) {
		for (const pair of node.children) {
			if (offset < pair.range.start || offset >= pair.range.end || !pair.key) continue
			const here = [...path, pair.key.value]
			return pair.value && offset >= pair.value.range.start && offset < pair.value.range.end ? locate(pair.value, offset, here) : { path: here, node: pair.value }
		}
	} else if (JsonArrayNode.is(node)) {
		for (let i = 0; i < node.children.length; i += 1) {
			const item = node.children[i]
			if (offset < item.range.start || offset >= item.range.end) continue
			return item.value ? locate(item.value, offset, [...path, i]) : { path: [...path, i], node: undefined }
		}
	}
	return { path, node }
}

/** The registries that a data pack fills. Something of these that is referred to and is not there keeps the whole pack from loading. */
function isFilledByPacks(registry: string) {
	return registry.startsWith('worldgen/') || registry === 'dimension_type'
}

/** Every text of a checked file that is the id of something in a registry */
function references(node: JsonNode | undefined, path: Path, found: (registry: string, id: string, path: Path) => void) {
	if (JsonObjectNode.is(node)) {
		for (const pair of node.children) {
			if (pair.key) references(pair.value, [...path, pair.key.value], found)
		}
	} else if (JsonArrayNode.is(node)) {
		node.children.forEach((item, i) => references(item.value, [...path, i], found))
	} else if (JsonStringNode.is(node) && node.typeDef?.kind === 'string' && node.value !== '' && !node.value.startsWith('#')) {
		const registry = idRegistryOf(node.typeDef)
		if (registry !== undefined) found(registry, fullId(node.value), path)
	}
}

/** What the checker adds to a message to say which of its rules it is from */
const RULE_SUFFIX = / \(rule: \w+\)$/

/** What the checker says, in the words of the editor where it is one of the things that it says most */
function plain(message: string) {
	const text = message.replace(RULE_SUFFIX, '')
	const length = /^Expected collection length to be at least (\d+)$/.exec(text)
	if (length) return `This list needs at least ${length[1]} ${length[1] === '1' ? 'item' : 'items'}.`
	const number = /^Expected numeric value to be (.+)$/.exec(text)
	if (number) return `This number has to be ${number[1]}.`
	const missing = /^Missing key (.+)$/.exec(text)
	if (missing) return `The field ${missing[1]} is missing.`
	return text
}

const SEVERITY_WARNING = 2
const SEVERITY_ERROR = 3

/**
 * Checks every JSON file of a data pack against the format of the game, which is what the forms of the editor
 * show their errors from, and whether what it refers to exists: in the pack itself, or in the game, whose ids are in `game` by registry.
 */
export async function checkFormat(service: SpyglassService, version: GraphVersion, files: PackFile[], game: Map<string, string[]>, cancelled: () => boolean): Promise<Finding[]> {
	const brought = new Map<string, Set<string>>()
	for (const file of files) {
		const identity = fileIdentity(file.path)
		if (!identity) continue
		let ids = brought.get(identity.registry)
		if (!ids) brought.set(identity.registry, ids = new Set())
		ids.add(identity.id)
	}

	const ofGame = new Map<string, Set<string>>()
	const exists = (registry: string, id: string) => {
		if (brought.get(registry)?.has(id)) return true
		let ids = ofGame.get(registry)
		if (!ids) ofGame.set(registry, ids = new Set((game.get(registry) ?? []).map(fullId)))
		return ids.has(id)
	}

	const findings: Finding[] = []
	for (const file of files) {
		if (cancelled()) return findings
		if (file.json === undefined || fileIdentity(file.path) === undefined) continue
		// The address has the shape of a file in a data pack, which is how the kind of JSON is recognised
		const checked = await service.checkContent(`file:///root/graph-check/${version.id}/${file.path}`, JSON.stringify(file.json, null, 2))
		if (!checked) continue
		const jsonFile = checked.node.children[0]
		const root = JsonFileNode.is(jsonFile) ? jsonFile.children[0] : undefined
		const errors: readonly LanguageError[] = [...checked.node.binderErrors ?? [], ...checked.node.checkerErrors ?? [], ...checked.node.linterErrors ?? []]
		const seen = new Set<string>()
		for (const error of errors) {
			if (error.severity < SEVERITY_WARNING) continue
			const { path, node } = locate(root, error.range.start)
			const where = whereOf(path)
			if (seen.has(`${where}\n${error.message}`)) continue
			seen.add(`${where}\n${error.message}`)
			const level: Finding['level'] = error.severity >= SEVERITY_ERROR ? 'error' : 'warning'
			let message = plain(error.message)
			if (level === 'warning' && JsonStringNode.is(node) && node.typeDef?.kind === 'string' && !node.value.startsWith('#')) {
				const registry = idRegistryOf(node.typeDef)
				if (registry !== undefined) {
					// The checker does not know what the pack brings. What a pack fills is looked at below.
					if (isFilledByPacks(registry) || exists(registry, fullId(node.value))) continue
					if (registry === 'structure') message = `${message}. Neither the pack nor the game has it, so the feature has nothing to place.`
				}
			}
			findings.push({ level, path: file.path, where, message })
		}

		// The checker says nothing about most ids that do not exist, and the game refuses the whole pack for one of them
		references(root, [], (registry, id, path) => {
			if (!isFilledByPacks(registry) || !game.has(registry) && !brought.has(registry) || exists(registry, id)) return
			const what = registry.replace(/^worldgen\//, '').replace(/_/g, ' ')
			findings.push({
				level: 'error',
				path: file.path,
				where: whereOf(path),
				message: registry === 'worldgen/block_state_provider'
					? `A text here is the id of a block state provider, and neither the pack nor the game has one called ${id}. The pack does not load like this. To place the block ${id}, choose the form of a block state: { "id": "${id}" }`
					: `Neither the pack nor the game has a ${what} called ${id}. A pack that refers to something that is missing does not load.`,
			})
		})
	}
	return findings
}

/** Findings without the ones that say the same about the same place, errors first within a file */
export function mergeFindings(...lists: Finding[][]): Finding[] {
	const seen = new Set<string>()
	const merged: Finding[] = []
	for (const finding of lists.flat()) {
		const key = `${finding.path}\n${finding.where}\n${finding.message}`
		if (seen.has(key)) continue
		seen.add(key)
		merged.push(finding)
	}
	return merged
}
