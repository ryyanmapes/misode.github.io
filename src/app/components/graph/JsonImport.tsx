import type { ItemKind } from './dimensions.js'
import { FileImport } from './FileImport.jsx'
import { ruleName } from './material/schema.js'
import type { GraphVersion } from './presets.js'
import type { GraphFormat } from './types.js'
import { prettyId } from './ui.jsx'

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeOf(json: Record<string, unknown>) {
	return typeof json.type === 'string' ? prettyId(json.type).replace(/_/g, ' ') : undefined
}

/**
 * What a file of a data pack is, in a few words. Throws with the reason when it cannot be a thing of this kind,
 * or when it is written for the other version of the game: 26.3 keeps the fields of a feature and of a carver
 * next to its type, and the versions before it in `config`.
 */
export function describeJson(kind: Exclude<ItemKind, 'template'>, json: unknown, format: GraphFormat, types?: string[]): string {
	const modern = format === 'modern'
	// A file of another kind has a type as well, but not one that this kind has
	const known = (value: Record<string, unknown>, what: string) => {
		const type = typeof value.type === 'string' ? (value.type.includes(':') ? value.type : `minecraft:${value.type}`) : undefined
		if (type !== undefined && types && types.length > 0 && !types.includes(type)) throw new Error(`This is not a ${what}: the game has no ${what} of the type ${typeOf(value)}`)
	}
	if (kind === 'density') {
		if (typeof json === 'number') return `The constant ${json}`
		if (typeof json === 'string') return `The density function ${json}, by its id`
		if (isObject(json) && typeOf(json)) {
			known(json, 'density function')
			return `A density function of the type ${typeOf(json)}`
		}
		throw new Error('This is not a density function: that is a number, an id, or an object with a type')
	}
	if (kind === 'material') {
		if (modern && typeof json === 'string') return `The rule ${json}, by its id`
		if (isObject(json) && typeOf(json)) {
			known(json, ruleName(format))
			return `A ${ruleName(format)} of the type ${typeOf(json)}`
		}
		throw new Error(`This is not a ${ruleName(format)}: that is an object with a type`)
	}
	if (!isObject(json)) throw new Error(`This is not a ${kind === 'placer' ? 'placed feature' : kind}: that is an object`)
	if (kind === 'noise') {
		const old = json.firstOctave !== undefined
		const recent = json.base_octave !== undefined || json.octave_count !== undefined
		if (modern && old && !recent) throw new Error('This noise is written for a version before 26.3, which lists its amplitudes')
		if (!modern && recent && !old) throw new Error('This noise is written for 26.3 or later, which counts its octaves')
		if (!old && !recent) throw new Error('This is not a noise: it does not say which octaves it has')
		return 'A noise'
	}
	if (kind === 'placer') {
		if (json.feature === undefined) throw new Error('This is not a placed feature: it names no feature')
		return typeof json.feature === 'string' ? `Places ${json.feature}` : `Places a feature${isObject(json.feature) && typeOf(json.feature) ? ` of the type ${typeOf(json.feature)}` : ''} that is written out in it`
	}
	const type = typeOf(json)
	if (!type) throw new Error(`This is not a ${kind}: it has no type`)
	known(json, kind)
	if (modern && isObject(json.config)) throw new Error(`This ${kind} is written for a version before 26.3, which keeps its fields in "config"`)
	if (!modern && json.config === undefined) throw new Error(`This ${kind} is written for 26.3 or later. Before that its fields are in "config".`)
	return `A ${kind} of the type ${type}`
}

interface Props {
	kind: Exclude<ItemKind, 'template'>
	version: GraphVersion
	dimensionId: string
	/** What one of these is called in a sentence */
	noun: string
	/** What the dimension has of this kind, by id */
	here: Record<string, unknown>
	/** The ids that the game has of this kind */
	vanilla: string[]
	/** The types that the game has for this kind, when it is a kind with types and they are known */
	types?: string[]
	onCreate: (id: string, json: unknown) => void
}
/** Brings the JSON files of a data pack into a dimension */
export function JsonImport({ kind, version, dimensionId, noun, here, vanilla, types, onCreate }: Props) {
	const read = async (file: File) => {
		let json: unknown
		try {
			json = JSON.parse(await file.text())
		} catch (e) {
			throw new Error('This file is not JSON')
		}
		return { value: json, about: describeJson(kind, json, version.format, types) }
	}
	return <FileImport noun={noun} heading="Import from files" extension=".json" choose="Choose JSON files"
		hint={<>or drop them here. These are the <span class="gx-mono">.json</span> files of a data pack for Minecraft {version.label}.</>}
		help={`A file becomes a ${noun} of this dimension. What it refers to is not brought along: that has to be in the dimension or in the game.`}
		idNote={`The id is how the ${noun} is referred to, and where its file goes in the data pack.`}
		dimensionId={dimensionId} here={here} vanilla={vanilla} read={read} onImport={onCreate} />
}
