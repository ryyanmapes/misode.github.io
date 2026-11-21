const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6
const GRAD: readonly (readonly [number, number])[] = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]

let table: Uint8Array | undefined

/** A fixed shuffle of 0..255, twice in a row */
function perm(): Uint8Array {
	if (table) return table
	const p = new Uint8Array(512)
	for (let i = 0; i < 256; i += 1) p[i] = i
	let state = 2345
	for (let i = 255; i > 0; i -= 1) {
		state = Math.imul(state, 1664525) + 1013904223 | 0
		const j = (state >>> 8) % (i + 1)
		const t = p[i]
		p[i] = p[j]
		p[j] = t
	}
	for (let i = 0; i < 256; i += 1) p[i + 256] = p[i]
	table = p
	return p
}

function corner(p: Uint8Array, i: number, j: number, x: number, y: number) {
	let t = 0.5 - x * x - y * y
	if (t < 0) return 0
	const g = GRAD[p[i + p[j]] & 7]
	t *= t
	return t * t * (g[0] * x + g[1] * y)
}

/** Smooth noise of a place, between -1 and 1. It is always the same: it does not depend on the seed of the world, and it is not the noise of the game. */
export function simplex2(x: number, y: number): number {
	const p = perm()
	const s = (x + y) * F2
	const i = Math.floor(x + s)
	const j = Math.floor(y + s)
	const t = (i + j) * G2
	const x0 = x - (i - t)
	const y0 = y - (j - t)
	const i1 = x0 > y0 ? 1 : 0
	const j1 = x0 > y0 ? 0 : 1
	const ii = i & 255
	const jj = j & 255
	const n = corner(p, ii, jj, x0, y0)
		+ corner(p, ii + i1, jj + j1, x0 - i1 + G2, y0 - j1 + G2)
		+ corner(p, ii + 1, jj + 1, x0 - 1 + 2 * G2, y0 - 1 + 2 * G2)
	return Math.max(-1, Math.min(1, 70 * n))
}

/** Smooth noise of a place in space, for the few things that look at the height as well */
export function noise3(x: number, y: number, z: number): number {
	return (simplex2(x + y * 0.71, z - y * 0.71) + simplex2(x * 0.5 - 31.7, y + z * 0.5 + 17.3)) / 2
}
