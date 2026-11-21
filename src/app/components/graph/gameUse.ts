import type { VersionId } from '../../services/index.js'
import { fetchAllPresets } from '../../services/index.js'
import type { GraphFormat } from './types.js'

/** What a dimension of the game uses of the game, as the JSON of the files, by id */
export interface GameUse {
	noises: Record<string, unknown>
	densityFunctions: Record<string, unknown>
	rules: Record<string, unknown>
	carvers: Record<string, unknown>
	features: Record<string, unknown>
	placers: Record<string, unknown>
}

type Registry = Map<string, unknown>

function fullId(id: string) {
	return id.includes(':') ? id : `minecraft:${id}`
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shortType(json: Record<string, unknown>) {
	return typeof json.type === 'string' ? json.type.replace(/^minecraft:/, '') : ''
}

/** A whole registry of the game. One that cannot be read is empty, so the rest of the dimension still opens. */
async function registry(version: VersionId, name: string): Promise<Registry> {
	try {
		return new Map([...await fetchAllPresets(version, name)].map(([id, json]) => [fullId(id), json]))
	} catch (e) {
		console.warn(`[graph] ${name} of ${version} could not be read`, e)
		return new Map()
	}
}

/** The ids that were found to be used, and the ones whose JSON still has to be looked at */
class Found {
	readonly ids = new Set<string>()
	readonly pending: string[] = []

	constructor(readonly registry: Registry) {}

	/** Adds an id when the game has it. Returns whether it has. */
	add(id: string) {
		const full = fullId(id)
		if (!this.registry.has(full)) return false
		if (!this.ids.has(full)) {
			this.ids.add(full)
			this.pending.push(full)
		}
		return true
	}

	/** The JSON of what was found, in the order of the ids */
	files(): Record<string, unknown> {
		return Object.fromEntries([...this.ids].sort().map(id => [id, this.registry.get(id)]))
	}
}

/** Fields of a density function that hold a word and not an id */
const DENSITY_WORDS = new Set(['type', 'axis', 'metric', 'tiling', 'rarity_value_mapper', 'label'])

/** Finds the density functions and noises that a density function, or anything made of them, refers to */
function scanDensity(json: unknown, key: string, densities: Found, noises: Found) {
	if (typeof json === 'string') {
		if (DENSITY_WORDS.has(key)) return
		if (key === 'noise' || !densities.add(json)) noises.add(json)
	} else if (Array.isArray(json)) {
		for (const item of json) scanDensity(item, key, densities, noises)
	} else if (isObject(json)) {
		for (const [name, value] of Object.entries(json)) scanDensity(value, name, densities, noises)
	}
}

/** Finds the noises that the conditions of a rule look at, and tells the types of the rules in it */
function scanRuleNoises(json: unknown, key: string, noises: Found, types: Set<string>) {
	if (typeof json === 'string') {
		if (key === 'noise') noises.add(json)
		if (key === 'type') types.add(json.replace(/^minecraft:/, ''))
	} else if (Array.isArray(json)) {
		for (const item of json) scanRuleNoises(item, key, noises, types)
	} else if (isObject(json)) {
		for (const [name, value] of Object.entries(json)) scanRuleNoises(value, name, noises, types)
	}
}

/** Finds the rules that a rule runs by their id */
function scanRule(json: unknown, rules: Found) {
	if (typeof json === 'string') {
		rules.add(json)
	} else if (isObject(json)) {
		const type = shortType(json)
		if (type === 'sequence' && Array.isArray(json.sequence)) {
			for (const item of json.sequence) scanRule(item, rules)
		} else if (type === 'condition') {
			scanRule(json.then_run, rules)
		}
	}
}

/** The fields of a feature that hold another feature: its id, or the feature itself */
const FEATURE_FIELDS = new Set(['feature', 'default', 'feature_true', 'feature_false', 'vegetation_feature'])

/**
 * Finds the features and placed features that a feature refers to. Inside of a feature the game means
 * a placed feature; 26.3 also accepts a feature there, and has both with the same id.
 */
function scanFeature(json: unknown, features: Found, placers: Found) {
	const refer = (value: unknown) => {
		if (typeof value === 'string') {
			if (!placers.add(value)) features.add(value)
		} else {
			scanFeature(value, features, placers)
		}
	}
	if (Array.isArray(json)) {
		for (const item of json) scanFeature(item, features, placers)
	} else if (isObject(json)) {
		for (const [key, value] of Object.entries(json)) {
			if (FEATURE_FIELDS.has(key)) {
				refer(value)
			} else if (key === 'features') {
				for (const entry of Array.isArray(value) ? value : [value]) {
					// A choice between features: the feature itself, or the feature with a chance or a weight
					if (isObject(entry) && entry.data !== undefined && entry.weight !== undefined) refer(entry.data)
					else refer(entry)
				}
			} else {
				scanFeature(value, features, placers)
			}
		}
	}
}

/** The ids in a field of a biome that is one id or a list of them, possibly in lists by step */
function idsIn(value: unknown): string[] {
	if (typeof value === 'string') return [value]
	if (Array.isArray(value)) return value.flatMap(idsIn)
	return []
}

/**
 * What a dimension of the game uses: the density functions and noises that its noise settings lead to,
 * the rules that its rule runs, and the carvers, placed features and features of its biomes.
 */
export async function loadGameUse(version: VersionId, format: GraphFormat, settings: any, rule: unknown, biomes: string[]): Promise<GameUse> {
	const modern = format === 'modern'
	const [densityFiles, noiseFiles, ruleFiles, biomeFiles, carverFiles, featureFiles, placerFiles] = await Promise.all([
		registry(version, 'worldgen/density_function'),
		registry(version, 'worldgen/noise'),
		// Before 26.3 the game has no rules with an id
		modern ? registry(version, 'worldgen/material_rule') : new Map<string, unknown>(),
		registry(version, 'worldgen/biome'),
		registry(version, modern ? 'worldgen/carver' : 'worldgen/configured_carver'),
		registry(version, modern ? 'worldgen/feature' : 'worldgen/configured_feature'),
		registry(version, 'worldgen/placed_feature'),
	])
	const densities = new Found(densityFiles)
	const noises = new Found(noiseFiles)
	const rules = new Found(ruleFiles)
	const carvers = new Found(carverFiles)
	const features = new Found(featureFiles)
	const placers = new Found(placerFiles)

	// The terrain: everything in the noise settings but the rule and the blocks
	for (const [key, value] of Object.entries(isObject(settings) ? settings : {})) {
		if (key === 'material_rule' || key === 'surface_rule' || key === 'default_block' || key === 'default_fluid') continue
		scanDensity(value, key, densities, noises)
	}
	while (densities.pending.length > 0) {
		scanDensity(densityFiles.get(densities.pending.pop()!), '', densities, noises)
	}

	// The blocks: the rule of the noise settings, and the rules that it runs
	const ruleTypes = new Set<string>()
	scanRule(rule, rules)
	scanRuleNoises(rule, '', noises, ruleTypes)
	while (rules.pending.length > 0) {
		const json = ruleFiles.get(rules.pending.pop()!)
		scanRule(json, rules)
		scanRuleNoises(json, '', noises, ruleTypes)
	}
	// Noises that the game samples without the files saying so: how deep the surface is, the bands of
	// the badlands, and the pillars of eroded badlands and of icebergs
	noises.add('minecraft:surface')
	noises.add('minecraft:surface_secondary')
	if (ruleTypes.has('bandlands')) noises.add('minecraft:clay_bands_offset')
	if (biomes.includes('minecraft:eroded_badlands')) {
		for (const name of ['badlands_pillar', 'badlands_pillar_roof', 'badlands_surface']) noises.add(`minecraft:${name}`)
	}
	if (biomes.includes('minecraft:frozen_ocean') || biomes.includes('minecraft:deep_frozen_ocean')) {
		for (const name of ['iceberg_pillar', 'iceberg_pillar_roof', 'iceberg_surface']) noises.add(`minecraft:${name}`)
	}

	// What the biomes cut out of the terrain and place on it
	for (const id of biomes) {
		const biome = biomeFiles.get(fullId(id))
		if (!isObject(biome)) continue
		// Before 26.3 the carvers are listed by what they carve into: air or liquid
		const carving = isObject(biome.carvers) ? Object.values(biome.carvers) : biome.carvers
		for (const carver of idsIn(carving)) carvers.add(carver)
		for (const placer of idsIn(biome.features)) placers.add(placer)
	}
	while (placers.pending.length > 0 || features.pending.length > 0) {
		while (placers.pending.length > 0) {
			const json = placerFiles.get(placers.pending.pop()!)
			if (!isObject(json)) continue
			// A placed feature names a feature
			if (typeof json.feature === 'string') {
				if (!features.add(json.feature)) placers.add(json.feature)
			} else {
				scanFeature(json.feature, features, placers)
			}
		}
		while (features.pending.length > 0) {
			scanFeature(featureFiles.get(features.pending.pop()!), features, placers)
		}
	}

	return {
		noises: noises.files(),
		densityFunctions: densities.files(),
		rules: rules.files(),
		carvers: carvers.files(),
		features: features.files(),
		placers: placers.files(),
	}
}
