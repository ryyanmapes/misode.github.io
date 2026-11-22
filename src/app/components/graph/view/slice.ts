import type { VolumeBlock } from '../worldgen.js'
import type { BlockLook, LookProvider, LookQuad } from './looks.js'
import { flatLooks } from './looks.js'

/** The bytes of one corner of a quad: three floats for the position, two for the texture and four bytes of color */
export const VERTEX_BYTES = 24

export interface MeshPart {
	/** The corners of the quads, four for each quad */
	data: ArrayBuffer
	quads: number
}

export interface ChunkMesh {
	opaque: MeshPart
	/** Quads that are blended over what is behind them, such as water */
	translucent: MeshPart
	/** All sides of the blocks that are highlighted, which are drawn as an outline through whatever hides them. Blocks that were cut away are among them, as the space that they left. */
	marked: MeshPart
}

/** What a slice is made of: chunks of blocks, as indices in a list of the kinds of blocks that occur */
export interface SliceVolume {
	readonly minY: number
	readonly height: number
	/** The kinds of blocks. The first one is always air. */
	readonly palette: VolumeBlock[]
	/** Generates a chunk. The result has indices in the palette, at (x * 16 + z) * height + y. */
	generate(chunkX: number, chunkZ: number): Uint16Array
	/** The index of a kind of block in the palette, which grows when the block is new */
	indexOf(name: string, properties: Record<string, string>): number
}

/** Changes the blocks of a slice once all of its chunks are there, for example by placing features */
export interface SliceDecorator {
	/** Called once for every chunk of the slice, with the position of the chunk in the world */
	decorate(slice: WorldSlice, chunkX: number, chunkZ: number): void
}

/** Receives the meshes of chunks as they are made. Nothing is passed when a chunk has nothing to draw. */
export interface MeshTarget {
	setChunk(key: number, mesh: ChunkMesh | undefined): void
}

export interface Hit {
	/** The block that was hit, in the coordinates of the world */
	x: number
	y: number
	z: number
	name: string
	/** How far along the ray the block was hit */
	distance: number
}

/** The sides of a whole block, which is the shape that a block has that was cut away and is outlined */
const CUT_SIDES = flatLooks().get({ name: 'minecraft:stone', properties: {}, fluid: false })!.sides

const DX = [0, 0, 0, 0, -1, 1]
const DY = [-1, 1, 0, 0, 0, 0]
const DZ = [0, 0, -1, 1, 0, 0]
/** How bright a corner is, by how many of the blocks around it are open */
const CORNER_LIGHT = [0.48, 0.66, 0.84, 1]

class MeshWriter {
	private buffer = new ArrayBuffer(VERTEX_BYTES * 4 * 512)
	private floats = new Float32Array(this.buffer)
	private bytes = new Uint8Array(this.buffer)
	quads = 0

	/** Adds a quad of a block at a position. The light of the corners is given in the order of the corners. */
	add(quad: LookQuad, x: number, y: number, z: number, l0: number, l1: number, l2: number, l3: number, flip: boolean) {
		if ((this.quads + 1) * 4 * VERTEX_BYTES > this.buffer.byteLength) {
			const next = new ArrayBuffer(this.buffer.byteLength * 2)
			new Uint8Array(next).set(this.bytes)
			this.buffer = next
			this.floats = new Float32Array(next)
			this.bytes = new Uint8Array(next)
		}
		const { corners, tint } = quad
		const alpha = Math.round(quad.alpha * 255)
		for (let i = 0; i < 4; i += 1) {
			// Starting at the next corner makes the quad fold along its other diagonal
			const c = flip ? (i + 1) & 3 : i
			const light = (c === 0 ? l0 : c === 1 ? l1 : c === 2 ? l2 : l3) * 255
			const vertex = this.quads * 4 + i
			const f = vertex * 6
			this.floats[f] = corners[c * 5] + x
			this.floats[f + 1] = corners[c * 5 + 1] + y
			this.floats[f + 2] = corners[c * 5 + 2] + z
			this.floats[f + 3] = corners[c * 5 + 3]
			this.floats[f + 4] = corners[c * 5 + 4]
			const b = vertex * VERTEX_BYTES + 20
			this.bytes[b] = tint[0] * light
			this.bytes[b + 1] = tint[1] * light
			this.bytes[b + 2] = tint[2] * light
			this.bytes[b + 3] = alpha
		}
		this.quads += 1
	}

	finish(): MeshPart {
		return { data: this.buffer.slice(0, this.quads * 4 * VERTEX_BYTES), quads: this.quads }
	}
}

/**
 * A box of the world that is generated chunk by chunk, from the middle outwards,
 * and turned into meshes. Positions inside the box count from its lowest corner,
 * except for heights, which are those of the world.
 */
export class WorldSlice {
	readonly minX: number
	readonly minZ: number
	readonly sizeX: number
	readonly sizeZ: number
	readonly minY: number
	readonly height: number
	readonly chunksX: number
	readonly chunksZ: number
	readonly total: number
	/** How many chunks are generated */
	generated = 0
	/** How many quads the meshes have together */
	quads = 0
	/** How often each block of the palette occurs in the generated chunks */
	readonly counts: number[] = []

	/** Indices in the palette of the volume, at (x * sizeZ + z) * height + y. Air where nothing is generated yet. */
	private readonly blocks: Uint16Array
	private readonly ready: Uint8Array
	private readonly meshQuads: Int32Array
	/** The chunks that have a mesh which is out of date, or none yet */
	private readonly dirty = new Set<number>()
	private readonly order: number[]
	private provider: LookProvider | undefined
	private looks: (BlockLook | undefined)[] = []
	private occludes = new Uint8Array(64)
	/** Blocks at this height and above are left out */
	private top: number
	/** How many chunks the decorator has been called for */
	decorated = 0
	/** Which part of the decoration placed each block, from 1 on. Zero where the decorator placed nothing. */
	private readonly marks: Uint8Array
	/** The blocks and their counts as they were before the decorator changed them */
	private base: { blocks: Uint16Array, counts: number[] } | undefined
	/** The part of the decoration that is outlined, or true for all of it */
	private highlight: number | boolean = false
	private onlyMarked = false

	/** `middle` is the chunk of the world that the box is around, which is the one at the origin when nothing is given */
	constructor(readonly volume: SliceVolume, chunksX: number, chunksZ: number, private decorator?: SliceDecorator, middle: readonly [number, number] = [0, 0]) {
		this.chunksX = chunksX
		this.chunksZ = chunksZ
		this.total = chunksX * chunksZ
		this.minX = (middle[0] - Math.floor(chunksX / 2)) * 16
		this.minZ = (middle[1] - Math.floor(chunksZ / 2)) * 16
		this.sizeX = chunksX * 16
		this.sizeZ = chunksZ * 16
		this.minY = volume.minY
		this.height = volume.height
		this.top = this.minY + this.height
		this.blocks = new Uint16Array(this.sizeX * this.sizeZ * this.height)
		this.marks = new Uint8Array(this.blocks.length)
		this.ready = new Uint8Array(this.total)
		this.meshQuads = new Int32Array(this.total)
		const distance = (key: number) => Math.hypot(Math.floor(key / chunksZ) + 0.5 - chunksX / 2, key % chunksZ + 0.5 - chunksZ / 2)
		this.order = Array.from({ length: this.total }, (_, key) => key).sort((a, b) => distance(b) - distance(a))
	}

	get done() {
		return this.generated === this.total && this.dirty.size === 0 && this.undecorated === 0
	}

	/** How many chunks the decorator still has to be called for */
	get undecorated() {
		return this.decorator ? this.total - this.decorated : 0
	}

	/**
	 * Which blocks that the decorator placed are outlined through what hides them:
	 * all of them, none of them, or the ones of one part of the decoration.
	 */
	setHighlight(which: number | boolean) {
		if (which === this.highlight) return
		this.highlight = which
		this.remesh()
	}

	/** Whether only the blocks that the decorator placed are drawn */
	setOnlyMarked(on: boolean) {
		if (on === this.onlyMarked) return
		this.onlyMarked = on
		this.remesh()
	}

	/** Takes away what the decorator placed and lets another one do its work. The chunks are not generated again. */
	redecorate(decorator: SliceDecorator | undefined) {
		if (this.base) {
			this.blocks.set(this.base.blocks)
			this.counts.length = 0
			this.base.counts.forEach((count, i) => this.counts[i] = count)
			this.base = undefined
			this.marks.fill(0)
			this.remesh()
		}
		this.decorator = decorator
		this.decorated = 0
	}

	/** Whether a column of the world is part of the slice */
	contains(x: number, z: number) {
		return x >= this.minX && x < this.minX + this.sizeX && z >= this.minZ && z < this.minZ + this.sizeZ
	}

	/** The index in the palette of the block at a position in the world. Air outside of the slice. */
	blockAt(x: number, y: number, z: number): number {
		const i = y - this.minY
		if (i < 0 || i >= this.height || !this.contains(x, z)) return 0
		return this.blocks[((x - this.minX) * this.sizeZ + z - this.minZ) * this.height + i]
	}

	/** Whether the decorator placed the block at a position in the world */
	markedAt(x: number, y: number, z: number): boolean {
		const i = y - this.minY
		if (i < 0 || i >= this.height || !this.contains(x, z)) return false
		return this.marks[((x - this.minX) * this.sizeZ + z - this.minZ) * this.height + i] !== 0
	}

	/** Which part of the decoration changed the block at a position in the world, from 1 on. Zero when none did. */
	partAt(x: number, y: number, z: number): number {
		const i = y - this.minY
		if (i < 0 || i >= this.height || !this.contains(x, z)) return 0
		return this.marks[((x - this.minX) * this.sizeZ + z - this.minZ) * this.height + i]
	}

	/**
	 * Places a block for the decorator, at a position in the world. Returns false outside of the slice.
	 * `part` tells which part of the decoration the block belongs to, from 1 to 255.
	 */
	place(x: number, y: number, z: number, index: number, part = 1): boolean {
		const i = y - this.minY
		if (i < 0 || i >= this.height || !this.contains(x, z)) return false
		const lx = x - this.minX
		const lz = z - this.minZ
		const at = (lx * this.sizeZ + lz) * this.height + i
		const old = this.blocks[at]
		this.counts[old] = (this.counts[old] ?? 1) - 1
		this.counts[index] = (this.counts[index] ?? 0) + 1
		this.blocks[at] = index
		this.marks[at] = part
		// The chunks next to a block at an edge show other sides and shadows because of it
		for (let cx = (lx - 1) >> 4; cx <= (lx + 1) >> 4; cx += 1) {
			for (let cz = (lz - 1) >> 4; cz <= (lz + 1) >> 4; cz += 1) {
				if (cx >= 0 && cx < this.chunksX && cz >= 0 && cz < this.chunksZ) this.dirty.add(cx * this.chunksZ + cz)
			}
		}
		return true
	}

	/** The y of the first open block above the highest block of a column of the world, or the bottom of the world */
	topAt(x: number, z: number): number {
		if (!this.contains(x, z)) return this.minY
		const column = ((x - this.minX) * this.sizeZ + z - this.minZ) * this.height
		for (let i = this.height - 1; i >= 0; i -= 1) {
			if (this.blocks[column + i] !== 0) return this.minY + i + 1
		}
		return this.minY
	}

	setLooks(provider: LookProvider) {
		if (this.provider?.id === provider.id) return
		this.provider = provider
		this.looks = []
		this.occludes.fill(0)
		this.remesh()
	}

	setTop(top: number) {
		if (top === this.top) return
		this.top = top
		this.remesh()
	}

	/** Makes all meshes again, for example to hand them to another target */
	remesh() {
		for (let key = 0; key < this.total; key += 1) {
			if (this.ready[key]) this.dirty.add(key)
		}
	}

	/**
	 * Does a part of the remaining work, for about as long as the budget in milliseconds.
	 * Returns whether there is more to do.
	 */
	work(budget: number, target: MeshTarget): boolean {
		const start = performance.now()
		do {
			// Meshes are quick and what the eye waits for, so those go first. Only while the decorator
			// is at work they wait, since every chunk that it touches would be meshed over and over.
			const midway = this.undecorated > 0 && this.decorated > 0
			const key = midway ? undefined : this.nextMesh()
			if (key !== undefined) {
				this.dirty.delete(key)
				const mesh = this.mesh(key)
				const quads = mesh.opaque.quads + mesh.translucent.quads + mesh.marked.quads
				this.quads += quads - this.meshQuads[key]
				this.meshQuads[key] = quads
				target.setChunk(key, quads > 0 ? mesh : undefined)
			} else if (this.order.length > 0) {
				this.generate(this.order.pop()!)
			} else if (this.decorator && this.decorated < this.total) {
				if (!this.base) this.base = { blocks: this.blocks.slice(), counts: [...this.counts] }
				const chunk = this.decorated
				// Counted first, so a chunk that fails is not tried forever
				this.decorated += 1
				this.decorator.decorate(this, (this.minX >> 4) + Math.floor(chunk / this.chunksZ), (this.minZ >> 4) + chunk % this.chunksZ)
			} else {
				return false
			}
		} while (performance.now() - start < budget)
		return this.order.length > 0 || this.dirty.size > 0 || this.undecorated > 0
	}

	/** A chunk can only be meshed once the chunks around it are known, since those hide some of its sides */
	private nextMesh(): number | undefined {
		for (const key of this.dirty) {
			const cx = Math.floor(key / this.chunksZ)
			const cz = key % this.chunksZ
			let known = true
			for (let x = Math.max(0, cx - 1); x <= Math.min(this.chunksX - 1, cx + 1) && known; x += 1) {
				for (let z = Math.max(0, cz - 1); z <= Math.min(this.chunksZ - 1, cz + 1); z += 1) {
					if (!this.ready[x * this.chunksZ + z]) {
						known = false
						break
					}
				}
			}
			if (known) return key
		}
		return undefined
	}

	private generate(key: number) {
		const cx = Math.floor(key / this.chunksZ)
		const cz = key % this.chunksZ
		const chunk = this.volume.generate((this.minX >> 4) + cx, (this.minZ >> 4) + cz)
		const { height } = this
		for (let x = 0; x < 16; x += 1) {
			for (let z = 0; z < 16; z += 1) {
				const from = (x * 16 + z) * height
				this.blocks.set(chunk.subarray(from, from + height), ((cx * 16 + x) * this.sizeZ + cz * 16 + z) * height)
			}
		}
		for (let i = 0; i < chunk.length; i += 1) {
			this.counts[chunk[i]] = (this.counts[chunk[i]] ?? 0) + 1
		}
		this.ready[key] = 1
		this.generated += 1
		this.dirty.add(key)
	}

	/** Finds out how the blocks are drawn that were not seen before */
	private updateLooks() {
		const { palette } = this.volume
		if (palette.length > this.occludes.length) {
			const next = new Uint8Array(palette.length * 2)
			next.set(this.occludes)
			this.occludes = next
		}
		for (let i = this.looks.length; i < palette.length; i += 1) {
			const look = this.provider?.get(palette[i])
			this.looks.push(look)
			this.occludes[i] = look?.occludes ? 1 : 0
		}
	}

	private mesh(key: number): ChunkMesh {
		this.updateLooks()
		const { blocks, marks, looks, occludes, sizeX, sizeZ, height, minY, highlight, onlyMarked } = this
		const limit = Math.min(height, this.top - minY)
		// Everything outside of the box and above the cut counts as air
		const at = (x: number, i: number, z: number) => {
			if (x < 0 || x >= sizeX || z < 0 || z >= sizeZ || i < 0 || i >= limit) return 0
			const index = (x * sizeZ + z) * height + i
			return onlyMarked && !marks[index] ? 0 : blocks[index]
		}
		// Whether a block is one of those that are outlined
		const glows = (mark: number) => mark !== 0 && (highlight === true || mark === highlight)
		const glowsAt = (x: number, i: number, z: number) => {
			if (x < 0 || x >= sizeX || z < 0 || z >= sizeZ || i < 0 || i >= limit) return false
			return glows(marks[(x * sizeZ + z) * height + i])
		}
		const opaque = new MeshWriter()
		const translucent = new MeshWriter()
		const marked = new MeshWriter()
		const x0 = Math.floor(key / this.chunksZ) * 16
		const z0 = (key % this.chunksZ) * 16
		const light = [0, 0, 0, 0]
		const open = [0, 0, 0, 0]

		for (let x = x0; x < x0 + 16; x += 1) {
			for (let z = z0; z < z0 + 16; z += 1) {
				const column = (x * sizeZ + z) * height
				for (let i = 0; i < limit; i += 1) {
					const id = blocks[column + i]
					if (id === 0) {
						// Where a highlighted carver cut a block away, the edge of the space that it left is outlined
						if (highlight !== false && glows(marks[column + i])) {
							for (let side = 0; side < 6; side += 1) {
								if (glowsAt(x + DX[side], i + DY[side], z + DZ[side])) continue
								marked.add(CUT_SIDES[side][0], x, minY + i, z, 1, 1, 1, 1, false)
							}
						}
						continue
					}
					if (onlyMarked && !marks[column + i]) continue
					let look = looks[id]
					if (!look) continue
					if (look.covered) {
						const above = at(x, i + 1, z)
						if (above === id || occludes[above]) look = look.covered
					}
					if (highlight !== false && glows(marks[column + i])) {
						// Every side that is not between two outlined blocks, also the ones that the terrain hides
						for (let side = 0; side < 6; side += 1) {
							if (glowsAt(x + DX[side], i + DY[side], z + DZ[side]) && occludes[at(x + DX[side], i + DY[side], z + DZ[side])]) continue
							for (const quad of look.sides[side]) marked.add(quad, x, minY + i, z, 1, 1, 1, 1, false)
						}
						for (const quad of look.inner) marked.add(quad, x, minY + i, z, 1, 1, 1, 1, false)
					}
					const writer = look.translucent ? translucent : opaque
					const y = minY + i
					let visible = false
					for (let side = 0; side < 6; side += 1) {
						const nx = x + DX[side]
						const ni = i + DY[side]
						const nz = z + DZ[side]
						const neighbour = at(nx, ni, nz)
						if (occludes[neighbour] || (look.selfCull && neighbour === id)) continue
						visible = true
						const quads = look.sides[side]
						for (let q = 0; q < quads.length; q += 1) {
							const quad = quads[q]
							if (!quad.full) {
								writer.add(quad, x, y, z, quad.shade, quad.shade, quad.shade, quad.shade, false)
								continue
							}
							// Corners are darker when the blocks next to them close them in
							for (let c = 0; c < 4; c += 1) {
								const sx = quad.corners[c * 5] > 0.5 ? 1 : -1
								const sy = quad.corners[c * 5 + 1] > 0.5 ? 1 : -1
								const sz = quad.corners[c * 5 + 2] > 0.5 ? 1 : -1
								let a: number, b: number, corner: number
								if (side < 2) {
									a = occludes[at(nx + sx, ni, nz)]
									b = occludes[at(nx, ni, nz + sz)]
									corner = occludes[at(nx + sx, ni, nz + sz)]
								} else if (side < 4) {
									a = occludes[at(nx + sx, ni, nz)]
									b = occludes[at(nx, ni + sy, nz)]
									corner = occludes[at(nx + sx, ni + sy, nz)]
								} else {
									a = occludes[at(nx, ni + sy, nz)]
									b = occludes[at(nx, ni, nz + sz)]
									corner = occludes[at(nx, ni + sy, nz + sz)]
								}
								open[c] = a && b ? 0 : 3 - a - b - corner
								light[c] = quad.shade * CORNER_LIGHT[open[c]]
							}
							writer.add(quad, x, y, z, light[0], light[1], light[2], light[3], open[0] + open[2] < open[1] + open[3])
						}
					}
					if (visible) {
						for (let q = 0; q < look.inner.length; q += 1) {
							const quad = look.inner[q]
							writer.add(quad, x, y, z, quad.shade, quad.shade, quad.shade, quad.shade, false)
						}
					}
				}
			}
		}
		return { opaque: opaque.finish(), translucent: translucent.finish(), marked: marked.finish() }
	}

	/**
	 * Finds the first block that a ray meets. The origin and the direction are in
	 * the coordinates of the box, and the direction has a length of one.
	 */
	raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): Hit | undefined {
		const { sizeX, sizeZ, minY } = this
		const top = Math.min(this.top, minY + this.height)
		// Start where the ray enters the box
		let near = 0
		let far = Infinity
		const slabs = [[ox, dx, 0, sizeX], [oy, dy, minY, top], [oz, dz, 0, sizeZ]]
		for (const [o, d, min, max] of slabs) {
			if (Math.abs(d) < 1e-9) {
				if (o < min || o > max) return undefined
			} else {
				const a = (min - o) / d
				const b = (max - o) / d
				near = Math.max(near, Math.min(a, b))
				far = Math.min(far, Math.max(a, b))
			}
		}
		if (near > far) return undefined
		let t = near + 1e-4
		let x = Math.floor(ox + dx * t)
		let y = Math.floor(oy + dy * t)
		let z = Math.floor(oz + dz * t)
		const stepX = dx > 0 ? 1 : -1
		const stepY = dy > 0 ? 1 : -1
		const stepZ = dz > 0 ? 1 : -1
		const deltaX = Math.abs(1 / dx)
		const deltaY = Math.abs(1 / dy)
		const deltaZ = Math.abs(1 / dz)
		let nextX = dx === 0 ? Infinity : ((dx > 0 ? x + 1 : x) - ox) / dx
		let nextY = dy === 0 ? Infinity : ((dy > 0 ? y + 1 : y) - oy) / dy
		let nextZ = dz === 0 ? Infinity : ((dz > 0 ? z + 1 : z) - oz) / dz
		while (t <= far) {
			if (x >= 0 && x < sizeX && z >= 0 && z < sizeZ && y >= minY && y < top) {
				const at = (x * sizeZ + z) * this.height + y - minY
				const id = this.blocks[at]
				if (id !== 0 && this.looks[id] && !(this.onlyMarked && !this.marks[at])) {
					return { x: this.minX + x, y, z: this.minZ + z, name: this.volume.palette[id].name, distance: t }
				}
			}
			if (nextX <= nextY && nextX <= nextZ) {
				t = nextX
				nextX += deltaX
				x += stepX
			} else if (nextY <= nextZ) {
				t = nextY
				nextY += deltaY
				y += stepY
			} else {
				t = nextZ
				nextZ += deltaZ
				z += stepZ
			}
		}
		return undefined
	}
}
