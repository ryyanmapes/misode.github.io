import { useMemo } from 'preact/hooks'
import type { FeatureData } from '../features/index.js'
import type { GraphVersion } from '../presets.js'
import type { WorldgenEnv } from '../worldgen.js'
import { TerrainVolume } from '../worldgen.js'
import { Carving, carveSettingsOf } from './carve.js'
import { PlacerDecorator } from './decorate.js'
import { WorldSlice } from './slice.js'
import type { CameraMemo } from './Viewport3D.jsx'

/** How many chunks wide and long the piece of a dimension is that features are shown on */
export const TERRAIN_CHUNKS = 4

/** The terrain of a dimension that was generated to show features on, kept so it is not generated again for every change */
export interface TerrainMemory {
	key?: string
	slice?: WorldSlice
	/** Where the camera of each diorama was */
	cameras: Record<string, CameraMemo>
}

export function createTerrainMemory(): TerrainMemory {
	return { cameras: {} }
}

export function cameraOf(memory: TerrainMemory, name: string): CameraMemo {
	memory.cameras[name] ??= {}
	return memory.cameras[name]
}

const NO_CARVERS: unknown[] = []

export interface TerrainInput {
	version: GraphVersion
	env: WorldgenEnv | undefined
	/** The noise settings as a JSON string, with the final density as it is now */
	settings: string | undefined
	/** The rule of the dimension as a JSON string */
	rule: string
	seed: bigint
	biome: string
}

/**
 * A piece of the terrain of a dimension, with caves cut out of it and placed features on it. The terrain
 * is only made again when the dimension changes. When only the carvers or the features change, they do
 * their work again on the same terrain. `placers` and `carvers` are the JSON of placed features and of
 * carvers, or their ids. The carvers follow the seed of the terrain, unless they get one of their own.
 */
export function useDecoratedTerrain({ version, env, settings, rule, seed, biome }: TerrainInput, memory: TerrainMemory, placers: unknown[], data: FeatureData | undefined, featureSeed: bigint, carvers: unknown[] = NO_CARVERS, carveSeed: bigint = seed) {
	// What the terrain refers to by id is part of what it is
	const key = `${version.id}\n${env?.rev}\n${seed}\n${biome}\n${rule}\n${settings}`
	const built = useMemo(() => {
		if (!env || !settings) return undefined
		if (memory.key === key && memory.slice) return { slice: memory.slice }
		try {
			const slice = new WorldSlice(new TerrainVolume(env, JSON.parse(settings), JSON.parse(rule), seed, biome), TERRAIN_CHUNKS, TERRAIN_CHUNKS)
			memory.key = key
			memory.slice = slice
			return { slice }
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) }
		}
	}, [env, key])
	const slice = built?.slice

	// What of the noise settings carvers and features look at. The same object while it says the same.
	const carveKey = useMemo(() => {
		try {
			return JSON.stringify(carveSettingsOf(JSON.parse(settings ?? '{}')))
		} catch (e) {
			return JSON.stringify(carveSettingsOf(undefined))
		}
	}, [settings])

	const placersKey = JSON.stringify(placers)
	const carversKey = JSON.stringify(carvers)
	const decoration = useMemo(() => {
		if (!slice || !data) return undefined
		const carveSettings = JSON.parse(carveKey)
		// The same seed carves the same caves, whatever is placed after them
		const carving = carvers.length > 0 ? new Carving(carvers, data, carveSeed, carveSettings) : undefined
		const decorator = new PlacerDecorator(placers, data, featureSeed, carveSettings.seaLevel, carving)
		slice.redecorate(decorator)
		// A new object every time, so whoever draws the slice knows that it changed
		return { decorator, revision: {} }
	}, [slice, placersKey, carversKey, data, featureSeed, carveSeed, carveKey])

	return { slice, error: built?.error, decorator: decoration?.decorator, revision: decoration?.revision }
}
