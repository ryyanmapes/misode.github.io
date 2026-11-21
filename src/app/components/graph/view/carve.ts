import type { FeatureData, FeatureRandom } from '../features/index.js'
import { createRandom } from '../features/index.js'
import { anchorY, holderSet, sampleFloat, sampleHeight, sampleInt } from '../features/providers.js'
import type { Ctx } from '../features/types.js'
import type { WorldSlice } from './slice.js'

/** What of the noise settings decides what a carver leaves behind where it cuts */
export interface CarveSettings {
	seaLevel: number
	/** Whether the dimension has aquifers, which is when caves below the sea are not flooded */
	aquifers: boolean
	/** The id of the fluid of the dimension */
	defaultFluid: string
}

function fullId(id: string) {
	return id.includes(':') ? id : `minecraft:${id}`
}

function isObj(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function carveSettingsOf(settings: unknown): CarveSettings {
	const json = isObj(settings) ? settings : {}
	const fluid = json.default_fluid
	const name = typeof fluid === 'string' ? fluid : isObj(fluid) && typeof fluid.Name === 'string' ? fluid.Name : isObj(fluid) && typeof fluid.id === 'string' ? fluid.id : 'minecraft:water'
	return {
		seaLevel: typeof json.sea_level === 'number' ? json.sea_level : 63,
		// 1.19.2 has a switch for aquifers, 26.3 has them when the noise settings describe them
		aquifers: json.aquifers_enabled === true || isObj(json.aquifers),
		defaultFluid: fullId(name),
	}
}

/** How many chunks away a carver can start and still reach a chunk */
const REACH = 8
/** How many steps a tunnel is long at most, which is the same distance in blocks */
const LENGTH = (REACH - 1) * 16
/** How many blocks all carvers together may look at, so that broken JSON cannot hang the page */
const BUDGET = 60_000_000

const GRASS = 'minecraft:grass_block'
const MYCELIUM = 'minecraft:mycelium'
const DIRT = 'minecraft:dirt'

/** A number that differs for every chunk and every carver, from one seed */
function mix(seed: bigint, chunkX: number, chunkZ: number, index: number) {
	return BigInt.asIntN(64, seed * BigInt(2862933555777941757) + BigInt(chunkX) * BigInt(3129871) + BigInt(chunkZ) * BigInt(116129781) + BigInt(index) * BigInt(40503) + BigInt(3037000493))
}

type Skip = (dx: number, dy: number, dz: number, y: number) => boolean

/**
 * Cuts caves and canyons out of a slice, the way the carvers of the game do after the terrain is shaped:
 * every chunk in reach can start a carver, which then tunnels through the chunks around it. The blocks
 * that a carver cut remember which carver it was. This follows the game closely, but not block for block.
 */
export class Carving {
	/** How many blocks each carver of the list cut */
	readonly blocksBy: number[]
	/** How many chunks started each carver of the list */
	readonly startsBy: number[]
	/** What was met that cannot be carved here */
	readonly unsupported = new Set<string>()
	private done = false

	/** `carvers` are the JSON of carvers, or their ids */
	constructor(private readonly carvers: unknown[], private readonly data: FeatureData, private readonly seed: bigint, private readonly settings: CarveSettings) {
		this.blocksBy = carvers.map(() => 0)
		this.startsBy = carvers.map(() => 0)
	}

	/** How many carvers there are, which is how many parts of the decoration they take up */
	get count() {
		return this.carvers.length
	}

	/** Carves the whole slice, once. The chunks of the slice have to be generated. */
	run(slice: WorldSlice) {
		if (this.done) return
		this.done = true
		this.carvers.forEach((carver, index) => {
			try {
				this.carve(slice, carver, index)
			} catch (e) {
				// Broken JSON carves nothing, or stops where it broke
				this.unsupported.add(e instanceof Error && e.message === 'budget' ? 'a carver that cuts more than the editor can show' : `carver ${index + 1}`)
			}
		})
	}

	private carve(slice: WorldSlice, ref: unknown, index: number) {
		const { data, settings, unsupported } = this
		const json = typeof ref === 'string' ? data.carver?.(fullId(ref)) : ref
		if (!isObj(json)) {
			unsupported.add(`carver ${typeof ref === 'string' ? ref : '(no JSON)'}`)
			return
		}
		const type = typeof json.type === 'string' ? json.type.replace(/^minecraft:/, '') : ''
		if (type !== 'cave' && type !== 'nether_cave' && type !== 'canyon') {
			unsupported.add(`carver type ${type === '' ? '(none)' : type}`)
			return
		}
		// 1.19.2 keeps the fields in `config`, 26.3 next to `type`
		const config = isObj(json.config) ? json.config : json
		const shape = isObj(config.shape) ? config.shape : {}
		const part = Math.min(255, index + 1)
		const { minY, height, minX, minZ } = slice
		const maxY = minY + height
		const maxX = minX + slice.sizeX
		const maxZ = minZ + slice.sizeZ
		const { palette } = slice.volume

		// What the providers of the carver are sampled with
		const ctx = {
			random: createRandom(0),
			minY,
			maxY,
			world: { seaLevel: settings.seaLevel },
			unsupportedType: (kind: string, name: string) => unsupported.add(`${kind} ${name === '' ? '(no type)' : name}`),
			tag: (id: string) => data.blockTag(id),
		}
		const sampling = ctx as unknown as Ctx

		// 1.19.2 lists what a carver may cut. 26.3 lets it cut everything but what is in a tag.
		const listed = config.replaceable !== undefined ? holderSet(sampling, config.replaceable) : undefined
		const uncarvable = data.blockTag('minecraft:uncarvable')
		const replaceable: (boolean | undefined)[] = []
		const canReplace = (id: number) => {
			let known = replaceable[id]
			if (known === undefined) {
				const block = palette[id]
				known = id !== 0 && !block.fluid && (listed ? listed(block.name) : block.name !== 'minecraft:bedrock' && !uncarvable.has(block.name))
				replaceable[id] = known
			}
			return known
		}

		// What is left where a block is cut: lava at the bottom, the fluid of the dimension below a sea without aquifers, and air
		const netherCave = type === 'nether_cave'
		const lavaLevel = netherCave ? minY + 31
			: config.lava_level !== undefined ? anchorY(sampling, config.lava_level, minY + 8)
				: settings.aquifers ? minY + 8 : -Infinity
		const floods = !netherCave && !settings.aquifers
		let lava: number | undefined
		let fluid: number | undefined
		const stateAt = (y: number) => {
			if (y <= lavaLevel) return lava ??= slice.volume.indexOf('minecraft:lava', {})
			if (floods && y < settings.seaLevel) return fluid ??= slice.volume.indexOf(settings.defaultFluid, {})
			return 0
		}

		let budget = BUDGET
		let carved = 0
		const ellipsoid = (x: number, y: number, z: number, horizontal: number, vertical: number, skip: Skip) => {
			const x0 = Math.max(Math.floor(x - horizontal) - 1, minX)
			const x1 = Math.min(Math.floor(x + horizontal), maxX - 1)
			const z0 = Math.max(Math.floor(z - horizontal) - 1, minZ)
			const z1 = Math.min(Math.floor(z + horizontal), maxZ - 1)
			const y0 = Math.max(Math.floor(y - vertical) - 1, minY + 1)
			// The game leaves the top of the world alone
			const y1 = Math.min(Math.floor(y + vertical) + 1, maxY - 8)
			if (x0 > x1 || z0 > z1 || y0 >= y1 || !(horizontal > 0) || !(vertical > 0)) return
			budget -= (x1 - x0 + 1) * (z1 - z0 + 1) * (y1 - y0)
			if (budget < 0) throw new Error('budget')
			for (let wx = x0; wx <= x1; wx += 1) {
				const dx = (wx + 0.5 - x) / horizontal
				for (let wz = z0; wz <= z1; wz += 1) {
					const dz = (wz + 0.5 - z) / horizontal
					if (dx * dx + dz * dz >= 1) continue
					// The grass that a carver cuts through grows back on the dirt that it lays bare
					let surface = 0
					for (let wy = y1; wy > y0; wy -= 1) {
						const dy = (wy - 0.5 - y) / vertical
						if (skip(dx, dy, dz, wy)) continue
						const id = slice.blockAt(wx, wy, wz)
						const name = palette[id].name
						if (name === GRASS || name === MYCELIUM) surface = id
						if (!canReplace(id)) continue
						const state = stateAt(wy)
						slice.place(wx, wy, wz, state, part)
						carved += 1
						if (surface !== 0 && palette[slice.blockAt(wx, wy - 1, wz)].name === DIRT) slice.place(wx, wy - 1, wz, surface, 0)
					}
				}
			}
		}

		/** Whether a tunnel can still get to the slice with the steps that it has left */
		const canReach = (x: number, z: number, step: number, steps: number, thickness: number) => {
			const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0
			const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0
			const left = steps - step
			const reach = thickness + 2 + 16
			return dx * dx + dz * dz - left * left <= reach * reach
		}

		const tunnel = (random: FeatureRandom, x: number, y: number, z: number, hMul: number, vMul: number, thickness: number, yaw: number, pitch: number, from: number, steps: number, yScale: number, skip: Skip) => {
			const split = random.nextInt(Math.floor(steps / 2)) + Math.floor(steps / 4)
			const steep = random.nextInt(6) === 0
			let yawChange = 0
			let pitchChange = 0
			for (let step = from; step < steps; step += 1) {
				const horizontal = 1.5 + Math.sin(Math.PI * step / steps) * thickness
				const vertical = horizontal * yScale
				const flat = Math.cos(pitch)
				x += Math.cos(yaw) * flat
				y += Math.sin(pitch)
				z += Math.sin(yaw) * flat
				pitch *= steep ? 0.92 : 0.7
				pitch += pitchChange * 0.1
				yaw += yawChange * 0.1
				pitchChange *= 0.9
				yawChange *= 0.75
				pitchChange += (random.nextFloat() - random.nextFloat()) * random.nextFloat() * 2
				yawChange += (random.nextFloat() - random.nextFloat()) * random.nextFloat() * 4
				if (step === split && thickness > 1) {
					// A wide tunnel forks into two narrower ones, to the left and to the right
					tunnel(random.fork(), x, y, z, hMul, vMul, random.nextFloat() * 0.5 + 0.5, yaw - Math.PI / 2, pitch / 3, step, steps, 1, skip)
					tunnel(random.fork(), x, y, z, hMul, vMul, random.nextFloat() * 0.5 + 0.5, yaw + Math.PI / 2, pitch / 3, step, steps, 1, skip)
					return
				}
				if (random.nextInt(4) === 0) continue
				if (!canReach(x, z, step, steps, thickness)) return
				ellipsoid(x, y, z, horizontal * hMul, vertical * vMul, skip)
			}
		}

		const cave = (random: FeatureRandom, chunkX: number, chunkZ: number) => {
			const bound = netherCave ? 10 : 15
			const count = config.count !== undefined ? sampleInt(sampling, config.count, 0) : random.nextInt(random.nextInt(random.nextInt(bound) + 1) + 1)
			for (let n = 0; n < count; n += 1) {
				const x = chunkX * 16 + random.nextInt(16)
				const y = sampleHeight(sampling, config.y)
				const z = chunkZ * 16 + random.nextInt(16)
				const hMul = sampleFloat(sampling, config.horizontal_radius_multiplier, 1)
				const vMul = sampleFloat(sampling, config.vertical_radius_multiplier, 1)
				const floor = sampleFloat(sampling, config.floor_level, -0.7)
				const skip: Skip = (dx, dy, dz) => dy <= floor || dx * dx + dy * dy + dz * dz >= 1
				let tunnels = 1
				if (random.nextInt(4) === 0) {
					// A round room, from which more tunnels leave
					const yScale = sampleFloat(sampling, config.yScale ?? config.room_vertical_radius_multiplier, 1)
					const radius = 2.5 + random.nextFloat() * 6
					ellipsoid(x + 1, y, z, radius, radius * yScale, skip)
					tunnels += random.nextInt(4)
				}
				for (let t = 0; t < tunnels; t += 1) {
					const yaw = random.nextFloat() * Math.PI * 2
					const pitch = (random.nextFloat() - 0.5) / 4
					let thickness: number
					if (config.thickness !== undefined) {
						thickness = sampleFloat(sampling, config.thickness, 1)
						if (config.weird_thickness_bias === true && random.nextInt(10) === 0) thickness *= random.nextFloat() * random.nextFloat() * 3 + 1
					} else {
						thickness = random.nextFloat() * 2 + random.nextFloat()
						if (netherCave) thickness *= 2
						else if (random.nextInt(10) === 0) thickness *= random.nextFloat() * random.nextFloat() * 3 + 1
					}
					const steps = LENGTH - random.nextInt(LENGTH / 4)
					const yScale = config.start_vertical_radius_multiplier !== undefined ? sampleFloat(sampling, config.start_vertical_radius_multiplier, 1) : netherCave ? 5 : 1
					tunnel(random.fork(), x, y, z, hMul, vMul, thickness, yaw, pitch, 0, steps, yScale, skip)
				}
			}
		}

		const canyon = (start: FeatureRandom, chunkX: number, chunkZ: number) => {
			let x = chunkX * 16 + start.nextInt(16)
			let y = sampleHeight(sampling, config.y)
			let z = chunkZ * 16 + start.nextInt(16)
			let yaw = start.nextFloat() * Math.PI * 2
			let pitch = sampleFloat(sampling, config.vertical_rotation, 0)
			const yScale = sampleFloat(sampling, config.yScale ?? shape.y_scale, 3)
			const thickness = sampleFloat(sampling, shape.thickness, 3)
			const steps = Math.floor(LENGTH * sampleFloat(sampling, shape.distance_factor, 1))
			const random = start.fork()
			ctx.random = random
			// A canyon is wider at some heights than at others
			const smoothness = Math.max(1, Math.floor(typeof shape.width_smoothness === 'number' ? shape.width_smoothness : 3))
			const widths = new Float32Array(height)
			let width = 1
			for (let i = 0; i < height; i += 1) {
				if (i === 0 || random.nextInt(smoothness) === 0) width = 1 + random.nextFloat() * random.nextFloat()
				widths[i] = width * width
			}
			const skip: Skip = (dx, dy, dz, wy) => (dx * dx + dz * dz) * widths[wy - minY - 1] + dy * dy / 6 >= 1
			const defaultFactor = typeof shape.vertical_radius_default_factor === 'number' ? shape.vertical_radius_default_factor : 1
			const centerFactor = typeof shape.vertical_radius_center_factor === 'number' ? shape.vertical_radius_center_factor : 0
			let yawChange = 0
			let pitchChange = 0
			for (let step = 0; step < steps; step += 1) {
				let horizontal = 1.5 + Math.sin(step * Math.PI / steps) * thickness
				let vertical = horizontal * yScale
				horizontal *= sampleFloat(sampling, shape.horizontal_radius_factor, 1)
				// Deepest in the middle of its length
				vertical *= (defaultFactor + centerFactor * (1 - Math.abs(0.5 - step / steps) * 2)) * (0.75 + random.nextFloat() * 0.25)
				const flat = Math.cos(pitch)
				x += Math.cos(yaw) * flat
				y += Math.sin(pitch)
				z += Math.sin(yaw) * flat
				pitch *= 0.7
				pitch += pitchChange * 0.05
				yaw += yawChange * 0.05
				pitchChange *= 0.8
				yawChange *= 0.5
				pitchChange += (random.nextFloat() - random.nextFloat()) * random.nextFloat() * 2
				yawChange += (random.nextFloat() - random.nextFloat()) * random.nextFloat() * 4
				if (random.nextInt(4) === 0) continue
				if (!canReach(x, z, step, steps, thickness)) return
				ellipsoid(x, y, z, horizontal, vertical, skip)
			}
		}

		const probability = typeof config.probability === 'number' ? config.probability : 0
		const chunkX0 = (minX >> 4) - REACH
		const chunkX1 = ((maxX - 1) >> 4) + REACH
		const chunkZ0 = (minZ >> 4) - REACH
		const chunkZ1 = ((maxZ - 1) >> 4) + REACH
		for (let chunkX = chunkX0; chunkX <= chunkX1; chunkX += 1) {
			for (let chunkZ = chunkZ0; chunkZ <= chunkZ1; chunkZ += 1) {
				const random = createRandom(mix(this.seed, chunkX, chunkZ, index))
				if (random.nextFloat() > probability) continue
				ctx.random = random
				// Only the chunks of the slice are counted, so the number tells how often the carver starts
				if (chunkX >= minX >> 4 && chunkX <= (maxX - 1) >> 4 && chunkZ >= minZ >> 4 && chunkZ <= (maxZ - 1) >> 4) this.startsBy[index] += 1
				try {
					if (type === 'canyon') canyon(random, chunkX, chunkZ)
					else cave(random, chunkX, chunkZ)
				} finally {
					this.blocksBy[index] = carved
				}
			}
		}
	}
}
