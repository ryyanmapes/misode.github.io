import { Identifier as LegacyIdentifier, ItemStack as LegacyItemStack } from 'deepslate-1.20.4/core'
import { ItemRenderer as LegacyItemRenderer } from 'deepslate-1.20.4/render'
import { Identifier, ItemStack } from 'deepslate/core'
import { ItemRenderer } from 'deepslate/render'
import type { VersionId } from '../../services/index.js'
import { checkVersion, fetchItemComponents } from '../../services/index.js'
import { ResolvedItem } from '../../services/ResolvedItem.js'
import { getResources } from '../../services/Resources.js'
import { getResources as getLegacyResources } from '../../services/Resources1204.js'
import { jsonToNbt } from '../../Utils.js'

const SIZE = 64

/** Draws the picture of a block and returns it as the address of an image, or nothing when the block has no picture */
type Painter = (id: string) => string | undefined

/**
 * One canvas for all pictures of a version. A browser only keeps a few WebGL contexts alive, so a context
 * for each picture would take away those of the pictures before it, and that of the 3D previews.
 */
function sharedCanvas() {
	const canvas = document.createElement('canvas')
	canvas.width = SIZE
	canvas.height = SIZE
	const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
	if (!gl) throw new Error('WebGL 2 is not available')
	return { canvas, gl }
}

/** Whether anything was drawn. A block without an item, such as water, leaves the canvas empty. */
function drewSomething(gl: WebGL2RenderingContext) {
	const pixels = new Uint8Array(SIZE * SIZE * 4)
	gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
	for (let i = 3; i < pixels.length; i += 4) {
		if (pixels[i] !== 0) return true
	}
	return false
}

async function createPainter(version: VersionId): Promise<Painter> {
	const { canvas, gl } = sharedCanvas()
	const clear = () => {
		gl.clearColor(0, 0, 0, 0)
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
	}
	if (checkVersion(version, '1.20.5')) {
		const components = await fetchItemComponents(version)
		const resources = await getResources(version, components)
		const resolve = (id: string) => {
			const base = components.get(id) ?? new Map<string, unknown>()
			return new ResolvedItem(new ItemStack(Identifier.parse(id), 1), new Map([...base.entries()].map(([key, value]) => [key, jsonToNbt(value)])))
		}
		return id => {
			clear()
			// A renderer for each picture: one that is given another item keeps drawing nothing after an item without a model
			new ItemRenderer(gl, resolve(id), resources, { display_context: 'gui' }).drawItem()
			return drewSomething(gl) ? canvas.toDataURL() : undefined
		}
	}
	// Before 1.20.5 items had no components, and the library of that time draws them
	const resources = await getLegacyResources(version)
	let renderer: LegacyItemRenderer | undefined
	return id => {
		const item = new LegacyItemStack(LegacyIdentifier.parse(id), 1)
		clear()
		if (renderer) renderer.setItem(item)
		else renderer = new LegacyItemRenderer(gl, item, resources)
		renderer.drawItem()
		return drewSomething(gl) ? canvas.toDataURL() : undefined
	}
}

const painters = new Map<VersionId, Promise<Painter>>()
const pictures = new Map<string, string | undefined>()

/** The picture of a block that was drawn before, when there is one */
export function loadedBlockPicture(version: VersionId, id: string): string | undefined {
	return pictures.get(`${version} ${id}`)
}

/**
 * The picture of a block the way the game shows it in the inventory, as the address of an image.
 * Nothing for blocks that have no item, and when the pictures cannot be drawn.
 */
export async function blockPicture(version: VersionId, id: string): Promise<string | undefined> {
	const key = `${version} ${id}`
	if (pictures.has(key)) return pictures.get(key)
	let painter = painters.get(version)
	if (!painter) {
		painter = createPainter(version)
		painter.catch(() => painters.delete(version))
		painters.set(version, painter)
	}
	let picture: string | undefined
	try {
		picture = (await painter)(id)
	} catch (e) {
		// A block that cannot be drawn gets its color instead
		picture = undefined
	}
	pictures.set(key, picture)
	return picture
}
