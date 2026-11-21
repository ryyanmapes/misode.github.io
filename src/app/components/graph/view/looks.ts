import type { BlockDefinitionProvider, BlockModelProvider, Mesh, TextureAtlasProvider } from 'deepslate/render'
import { BlockState, Cull, Identifier, SpecialRenderers } from 'deepslate/render'
import type { VersionId } from '../../../services/index.js'
import { fetchBlockStates, fetchItemComponents } from '../../../services/index.js'
import { getResources } from '../../../services/Resources.js'
import { blockColor } from '../material/blocks.js'
import type { VolumeBlock } from '../worldgen.js'

/** The sides of a block, in the order that looks and the mesher use */
export const DOWN = 0
export const UP = 1
export const NORTH = 2
export const SOUTH = 3
export const WEST = 4
export const EAST = 5

/** How much light each side gets, so the shape of the terrain reads without shadows */
export const SIDE_SHADE = [0.5, 1, 0.8, 0.8, 0.62, 0.62]

/** A rectangle of a block */
export interface LookQuad {
	/** Four corners, each as x, y, z inside the block and u, v in the atlas. A negative u means no texture. */
	corners: Float32Array
	/** The color that the texture is multiplied with, from 0 to 1 */
	tint: [number, number, number]
	alpha: number
	shade: number
	/** Whether the quad covers a whole side of the block, which is when corners can be darkened */
	full: boolean
}

/** How a kind of block is drawn */
export interface BlockLook {
	/** The quads on each side of the block, which are left out when a neighbour hides that side */
	sides: LookQuad[][]
	/** The quads inside of the block, drawn whenever a side of the block can be seen */
	inner: LookQuad[]
	/** Whether the block hides the sides of its neighbours that touch it */
	occludes: boolean
	/** Whether sides between two of these blocks are left out, as for fluids */
	selfCull: boolean
	translucent: boolean
	/** The look when the top is hidden. Fluids are only lower than a block at their surface. */
	covered?: BlockLook
}

/** Decides how blocks are drawn. Returns nothing for blocks that are not drawn. */
export interface LookProvider {
	/** Changes when the same blocks get another look */
	id: string
	get(block: VolumeBlock): BlockLook | undefined
}

export interface BlockResources extends BlockDefinitionProvider, BlockModelProvider, TextureAtlasProvider {}

const EPSILON = 0.001

const CUBE: number[][] = [
	[0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1],
	[0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0],
	[1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0],
	[0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
	[0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0],
	[1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1],
]

const WATER = 'minecraft:water'
const LAVA = 'minecraft:lava'
const INVISIBLE = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:barrier', 'minecraft:structure_void', 'minecraft:light'])

function flatQuad(side: number, color: [number, number, number], alpha: number): LookQuad {
	const corners = new Float32Array(20)
	for (let i = 0; i < 4; i += 1) {
		corners[i * 5] = CUBE[side][i * 3]
		corners[i * 5 + 1] = CUBE[side][i * 3 + 1]
		corners[i * 5 + 2] = CUBE[side][i * 3 + 2]
		corners[i * 5 + 3] = -1
		corners[i * 5 + 4] = -1
	}
	return { corners, tint: color, alpha, shade: SIDE_SHADE[side], full: true }
}

function flatLook(block: VolumeBlock): BlockLook {
	const [r, g, b] = blockColor(block.name)
	const color: [number, number, number] = [r / 255, g / 255, b / 255]
	const water = block.name === WATER
	return {
		sides: CUBE.map((_, side) => [flatQuad(side, color, water ? 0.72 : 1)]),
		inner: [],
		occludes: !block.fluid,
		selfCull: block.fluid,
		translucent: water,
	}
}

/** Draws every block as a cube in the color that the other previews use for it */
export function flatLooks(): LookProvider {
	const cache = new Map<string, BlockLook>()
	return {
		id: 'flat',
		get: block => {
			if (INVISIBLE.has(block.name)) return undefined
			let look = cache.get(block.name)
			if (!look) {
				look = flatLook(block)
				cache.set(block.name, look)
			}
			return look
		},
	}
}

interface Opacity {
	/** Whether some pixels can be seen through completely or partly */
	holes: boolean
	/** Whether some pixels are partly see-through, which needs blending */
	blended: boolean
}

/**
 * Draws blocks with the models and textures of the game. Blocks that the
 * resources do not know, such as those of mods, are drawn in a flat color.
 */
export function texturedLooks(id: string, resources: BlockResources, defaults: Map<string, Record<string, string>>): LookProvider {
	const cache = new Map<string, BlockLook | undefined>()
	const atlas = resources.getTextureAtlas()
	const flat = flatLooks()

	/** Looks at the pixels of the texture that a quad shows */
	const opacityOf = (corners: Float32Array): Opacity => {
		let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
		for (let i = 0; i < 4; i += 1) {
			minU = Math.min(minU, corners[i * 5 + 3])
			maxU = Math.max(maxU, corners[i * 5 + 3])
			minV = Math.min(minV, corners[i * 5 + 4])
			maxV = Math.max(maxV, corners[i * 5 + 4])
		}
		const x0 = Math.max(0, Math.round(minU * atlas.width))
		const x1 = Math.min(atlas.width, Math.round(maxU * atlas.width))
		const y0 = Math.max(0, Math.round(minV * atlas.height))
		const y1 = Math.min(atlas.height, Math.round(maxV * atlas.height))
		const result = { holes: false, blended: false }
		for (let y = y0; y < y1; y += 1) {
			for (let x = x0; x < x1; x += 1) {
				const alpha = atlas.data[(y * atlas.width + x) * 4 + 3]
				if (alpha < 255) result.holes = true
				if (alpha > 24 && alpha < 232) result.blended = true
			}
		}
		return result
	}

	const fromMesh = (mesh: Mesh, fluid: boolean): BlockLook | undefined => {
		if (mesh.quads.length === 0) return undefined
		const sides: LookQuad[][] = [[], [], [], [], [], []]
		const inner: LookQuad[] = []
		const covers = [false, false, false, false, false, false]
		let holes = false
		let blended = false
		for (const quad of mesh.quads) {
			const vertices = quad.vertices()
			const corners = new Float32Array(20)
			let centerU = 0
			let centerV = 0
			vertices.forEach((vertex, i) => {
				corners[i * 5] = vertex.pos.x
				corners[i * 5 + 1] = vertex.pos.y
				corners[i * 5 + 2] = vertex.pos.z
				corners[i * 5 + 3] = vertex.texture?.[0] ?? -1
				corners[i * 5 + 4] = vertex.texture?.[1] ?? -1
				centerU += corners[i * 5 + 3] / 4
				centerV += corners[i * 5 + 4] / 4
			})
			const textured = vertices.every(v => v.texture !== undefined)
			if (textured) {
				const opacity = opacityOf(corners)
				holes ||= opacity.holes
				blended ||= opacity.blended
				// Stay just inside of the texture, so its neighbours in the atlas never show at the edges
				for (let i = 0; i < 4; i += 1) {
					corners[i * 5 + 3] += Math.sign(centerU - corners[i * 5 + 3]) * 0.02 / atlas.width
					corners[i * 5 + 4] += Math.sign(centerV - corners[i * 5 + 4]) * 0.02 / atlas.height
				}
			}

			// A quad belongs to a side when it lies in the plane of that side and faces outwards
			const normal = quad.normal()
			const axis = Math.abs(normal.y) > 0.99 ? 1 : Math.abs(normal.z) > 0.99 ? 2 : Math.abs(normal.x) > 0.99 ? 0 : -1
			let side = -1
			let full = false
			if (axis >= 0) {
				const positive = [normal.x, normal.y, normal.z][axis] > 0
				const plane = positive ? 1 : 0
				let onPlane = true
				full = true
				for (let i = 0; i < 4; i += 1) {
					if (Math.abs(corners[i * 5 + axis] - plane) > EPSILON) onPlane = false
					for (let j = 0; j < 3; j += 1) {
						const value = corners[i * 5 + j]
						if (Math.abs(value) > EPSILON && Math.abs(value - 1) > EPSILON) full = false
					}
				}
				if (onPlane) side = axis === 1 ? (positive ? UP : DOWN) : axis === 2 ? (positive ? SOUTH : NORTH) : (positive ? EAST : WEST)
			}
			const color = vertices[0].color
			const look: LookQuad = {
				corners,
				tint: [color[0], color[1], color[2]],
				alpha: 1,
				shade: side >= 0 ? SIDE_SHADE[side] : 0.62 + 0.38 * Math.max(0, normal.y) - 0.12 * Math.max(0, -normal.y) + 0.18 * Math.abs(normal.z),
				full: side >= 0 && full,
			}
			if (side >= 0) {
				sides[side].push(look)
				if (full) covers[side] = true
			} else {
				inner.push(look)
			}
		}
		return {
			sides,
			inner,
			occludes: !fluid && !holes && covers.every(Boolean),
			selfCull: fluid,
			translucent: blended,
		}
	}

	const build = (block: VolumeBlock): BlockLook | undefined => {
		const name = Identifier.parse(block.name)
		const properties = { ...defaults.get(block.name), ...block.properties }
		try {
			if (block.name === WATER || block.name === LAVA) {
				const state = new BlockState(name, properties)
				const look = fromMesh(SpecialRenderers.getBlockMesh(state, undefined as never, resources, Cull.none()), true)
				const covered = fromMesh(SpecialRenderers.getBlockMesh(state, undefined as never, resources, { up: true }), true)
				if (look && covered) return { ...look, covered }
			}
			const definition = resources.getBlockDefinition(name)
			if (definition) {
				const look = fromMesh(definition.getMesh(name, properties, resources, resources, Cull.none()), block.fluid)
				if (look) return look
			}
		} catch (e) {
			// A model that cannot be read is no reason to leave the block out
		}
		return flat.get(block)
	}

	return {
		id,
		get: block => {
			if (INVISIBLE.has(block.name)) return undefined
			const keys = Object.keys(block.properties).sort()
			const key = `${block.name}[${keys.map(k => `${k}=${block.properties[k]}`).join(',')}]`
			if (!cache.has(key)) cache.set(key, build(block))
			return cache.get(key)
		},
	}
}

export interface LoadedLooks {
	looks: LookProvider
	/** The image that the texture coordinates of the looks refer to */
	atlas: ImageData
}

const loading = new Map<VersionId, Promise<LoadedLooks>>()
const loaded = new Map<VersionId, LoadedLooks>()

/** The looks of a version when they were downloaded before, so they can be used right away */
export function loadedTexturedLooks(version: VersionId): LoadedLooks | undefined {
	return loaded.get(version)
}

/** Downloads the models and textures of a version of the game, once */
export function loadTexturedLooks(version: VersionId): Promise<LoadedLooks> {
	let result = loading.get(version)
	if (!result) {
		result = (async () => {
			// The resources of a version are loaded once for the whole site, with what items are made of. Leaving that
			// out here would leave it out for the pictures of blocks in the forms as well.
			const [resources, states] = await Promise.all([fetchItemComponents(version).then(components => getResources(version, components)), fetchBlockStates(version)])
			// A rule may leave out properties of a block, and models are chosen by all of them
			const defaults = new Map<string, Record<string, string>>()
			for (const [id, [, values]] of states) {
				defaults.set(id.includes(':') ? id : `minecraft:${id}`, values)
			}
			const looks = { looks: texturedLooks(`textured ${version}`, resources, defaults), atlas: resources.getTextureAtlas() }
			loaded.set(version, looks)
			return looks
		})()
		result.catch(() => loading.delete(version))
		loading.set(version, result)
	}
	return result
}
