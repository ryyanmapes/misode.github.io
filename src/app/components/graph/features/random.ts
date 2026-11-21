import type { FeatureRandom } from './types.js'

const TWO_32 = 4294967296

/** A small and fast seeded generator (sfc32). It does not match the game's. */
class Sfc32 implements FeatureRandom {
	private a: number
	private b: number
	private c: number
	private d: number
	private spare: number | undefined

	constructor(lo: number, hi: number) {
		this.a = 0x9E3779B9 | 0
		this.b = lo | 0
		this.c = hi | 0
		this.d = 1
		for (let i = 0; i < 15; i += 1) this.next()
	}

	/** The next 32 bits, unsigned */
	private next() {
		const t = (this.a + this.b | 0) + this.d | 0
		this.d = this.d + 1 | 0
		this.a = this.b ^ this.b >>> 9
		this.b = this.c + (this.c << 3) | 0
		this.c = this.c << 21 | this.c >>> 11
		this.c = this.c + t | 0
		return t >>> 0
	}

	nextInt(bound: number) {
		if (!(bound > 0)) return 0
		const whole = Math.floor(bound)
		if (whole <= 1) return 0
		return Math.min(whole - 1, Math.floor(this.nextDouble() * whole))
	}

	nextFloat() {
		return (this.next() >>> 8) / 16777216
	}

	nextDouble() {
		return ((this.next() >>> 5) * 67108864 + (this.next() >>> 6)) / 9007199254740992
	}

	nextBoolean() {
		return (this.next() & 1) === 1
	}

	nextGaussian() {
		if (this.spare !== undefined) {
			const spare = this.spare
			this.spare = undefined
			return spare
		}
		for (let i = 0; i < 64; i += 1) {
			const u = 2 * this.nextDouble() - 1
			const v = 2 * this.nextDouble() - 1
			const s = u * u + v * v
			if (s > 0 && s < 1) {
				const f = Math.sqrt(-2 * Math.log(s) / s)
				this.spare = v * f
				return u * f
			}
		}
		return 0
	}

	fork(): FeatureRandom {
		return new Sfc32(this.next(), this.next())
	}
}

/** A seeded random source. Does not need to match the game's. */
export function createRandom(seed: number | bigint): FeatureRandom {
	if (typeof seed === 'bigint') {
		const lo = Number(BigInt.asUintN(32, seed))
		const hi = Number(BigInt.asUintN(32, seed >> BigInt(32)))
		return new Sfc32(lo, hi)
	}
	const whole = Number.isFinite(seed) ? Math.floor(seed) : 0
	const lo = ((whole % TWO_32) + TWO_32) % TWO_32
	const hi = Math.floor(whole / TWO_32)
	return new Sfc32(lo, hi)
}

/** min <= n <= max */
export function between(random: FeatureRandom, min: number, max: number) {
	if (max <= min) return min
	return min + random.nextInt(max - min + 1)
}

export function pick<T>(random: FeatureRandom, items: readonly T[]): T | undefined {
	if (items.length === 0) return undefined
	return items[random.nextInt(items.length)]
}

export function shuffled<T>(random: FeatureRandom, items: readonly T[]): T[] {
	const result = items.slice()
	for (let i = result.length - 1; i > 0; i -= 1) {
		const j = random.nextInt(i + 1)
		const t = result[i]
		result[i] = result[j]
		result[j] = t
	}
	return result
}
