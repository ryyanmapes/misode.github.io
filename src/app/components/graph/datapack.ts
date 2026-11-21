import config from '../../Config.js'
import { writeZip } from '../../Utils.js'
import type { AnyDimension, Own } from './items.js'
import { inlineRules, mainDensityOf, mainRuleOf, NO_OWN, ownOf, registryOf } from './items.js'
import type { DimensionData, GraphVersion } from './presets.js'
import { biomeOf, withOwnBiome } from './presets.js'

/** One file of a data pack */
export interface PackFile {
	path: string
	/** What the file is, for people who read the list of files */
	what: string
	json: unknown
}

/** A dimension with what its graphs stand for */
export interface PackSource {
	data: DimensionData
	finalDensity: unknown
	rule: unknown
	/** The noises, density functions, rules, carvers, features and placed features that the dimension brings */
	own: Own
}

function filePath(folder: string, id: string) {
	const [namespace, path] = id.includes(':') ? id.split(':') : ['minecraft', id]
	return `data/${namespace}/${folder}/${path}.json`
}

/** The step of generating a chunk in which the placed features of a dimension are placed: the one for plants, which is among the last */
const FEATURE_STEP = 9

/**
 * The file of the biome of a dimension. The game carves and places features through biomes, so the
 * biome lists the carvers and the placed features of the dimension. A dimension of the game has
 * a biome of the game, which needs no file.
 */
function biomeFile(version: GraphVersion, data: DimensionData): { id: string, json: unknown } | undefined {
	const { id, file } = biomeOf(data)
	if (data.fromGame || file === undefined) return undefined
	const features: string[][] = data.decoration.length === 0 ? [] : Array.from({ length: FEATURE_STEP + 1 }, () => [])
	if (data.decoration.length > 0) features[FEATURE_STEP] = data.decoration
	// Before 26.3 a biome lists its carvers by what they carve into
	const carvers = version.format === 'modern' ? data.carving : data.carving.length > 0 ? { air: data.carving } : {}
	return { id, json: { ...file, carvers, features } }
}

/** The files that make a dimension work in the game, without the pack.mcmeta */
export function dimensionFiles(version: GraphVersion, source: PackSource): PackFile[] {
	const { data, finalDensity, rule, own } = source
	const files: PackFile[] = []
	const settingsId = typeof data.dimension?.generator?.settings === 'string' ? data.dimension.generator.settings as string : data.id
	const settings = { ...data.settings, noise_router: { ...data.settings?.noise_router, final_density: finalDensity } }
	const biome = biomeFile(version, data)

	files.push({ path: filePath('dimension', data.id), what: 'The dimension', json: data.dimension })
	if (typeof data.dimension?.type === 'string') {
		files.push({ path: filePath('dimension_type', data.dimension.type), what: 'Dimension type, with the height of the world', json: data.dimensionType })
	}
	if (version.format === 'modern') {
		// In 26.3 the rule is a file of its own that the noise settings refer to
		const ruleId = typeof settings.material_rule === 'string' ? settings.material_rule as string : settingsId
		settings.material_rule = ruleId
		files.push({ path: filePath('worldgen/noise_settings', settingsId), what: 'Noise settings, with the final density', json: settings })
		files.push({ path: filePath('worldgen/material_rule', ruleId), what: 'Material rule of the dimension', json: rule })
		for (const [id, json] of Object.entries(own.rules)) {
			files.push({ path: filePath('worldgen/material_rule', id), what: 'Material rule that other rules run', json })
		}
	} else {
		// 1.19.2 has no rules with an id, so the rules that are run by their id are copied in place
		settings.surface_rule = inlineRules(rule, own.rules)
		files.push({ path: filePath('worldgen/noise_settings', settingsId), what: 'Noise settings, with the final density and the surface rule', json: settings })
	}
	for (const [id, json] of Object.entries(own.densities)) {
		files.push({ path: filePath('worldgen/density_function', id), what: 'Density function', json })
	}
	for (const [id, json] of Object.entries(own.noises)) {
		files.push({ path: filePath('worldgen/noise', id), what: 'Noise', json })
	}
	for (const [id, json] of Object.entries(own.carvers)) {
		files.push({ path: filePath(registryOf('carver', version.format), id), what: version.format === 'modern' ? 'Carver' : 'Configured carver', json })
	}
	for (const [id, json] of Object.entries(own.features)) {
		files.push({ path: filePath(registryOf('feature', version.format), id), what: version.format === 'modern' ? 'Feature' : 'Configured feature', json })
	}
	for (const [id, json] of Object.entries(own.placers)) {
		files.push({ path: filePath('worldgen/placed_feature', id), what: 'Placed feature', json })
	}
	if (biome) {
		files.push({ path: filePath('worldgen/biome', biome.id), what: 'The biome of the dimension, with its carvers and placed features', json: biome.json })
	}
	return files
}

/** What a dimension generates: its graphs once they were changed, and otherwise what it started from */
export async function loadPackSource(version: GraphVersion, dimension: AnyDimension): Promise<PackSource> {
	// A dimension from before every dimension had a biome of its own gets the biome of the game that it used
	const data = await withOwnBiome(version, dimension)
	return {
		data,
		finalDensity: mainDensityOf(data, version.format),
		rule: mainRuleOf(data),
		// A dimension of the game uses what the game has, which needs no files
		own: data.fromGame ? NO_OWN : ownOf(data, version.format),
	}
}

/** Since format 82 a pack tells the range of formats that it supports, before that a single number */
const RANGED_FORMAT = 82

/** The files of several dimensions as one data pack. Files that dimensions share are only included once. */
export function packFiles(version: GraphVersion, description: string, sources: PackSource[]): PackFile[] {
	const format = config.versions.find(v => v.id === version.id)!.pack_format
	const files = new Map<string, PackFile>([['pack.mcmeta', {
		path: 'pack.mcmeta',
		what: `Tells the game that this is a data pack for ${version.label}`,
		// The same fields as the pack of the game itself has
		json: { pack: format >= RANGED_FORMAT ? { description, pack_format: format, min_format: [format, 0], max_format: [format, 0] } : { description, pack_format: format } },
	}]])
	for (const source of sources) {
		for (const file of dimensionFiles(version, source)) {
			if (!files.has(file.path)) files.set(file.path, file)
		}
	}
	return [...files.values()]
}

/** A name for a file that every system accepts */
export function fileName(name: string) {
	return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'dimension'
}

/** Offers the files as a zip to save */
export async function downloadPack(name: string, files: PackFile[]) {
	const encoder = new TextEncoder()
	const url = await writeZip(files.map(file => [file.path, encoder.encode(`${JSON.stringify(file.json, null, 2)}\n`)]))
	const link = document.createElement('a')
	link.href = url
	link.download = `${fileName(name)}.zip`
	document.body.appendChild(link)
	link.click()
	link.remove()
}
