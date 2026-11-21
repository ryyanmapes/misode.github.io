import type { Json, Pos } from './types.js'

export function isObj(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value as an object, or an empty object */
export function obj(value: unknown): Json {
	return isObj(value) ? value : {}
}

/** The value as a list: a list stays, nothing is empty and anything else is a list of one */
export function list(value: unknown): unknown[] {
	if (Array.isArray(value)) return value
	if (value === undefined || value === null) return []
	return [value]
}

export function num(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function int(value: unknown, fallback: number): number {
	return Math.trunc(num(value, fallback))
}

export function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback
}

export function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback
}

/** A full id: ids without a namespace are in `minecraft:` */
export function fullId(value: string): string {
	return value.includes(':') ? value : `minecraft:${value}`
}

/** An id without the `minecraft:` namespace, which is how types are compared */
export function shortId(value: unknown): string {
	const text = str(value)
	return text.startsWith('minecraft:') ? text.slice(10) : text
}

/** The config of a feature: next to `type` (modern) or in `config` (legacy) */
export function configOf(feature: Json): Json {
	return isObj(feature.config) ? feature.config : feature
}

export function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value))
}

export function lerp(t: number, a: number, b: number) {
	return a + t * (b - a)
}

/** Maps a value from one range to another, staying inside of the second */
export function clampedMap(value: number, fromMin: number, fromMax: number, toMin: number, toMax: number) {
	if (fromMax === fromMin) return toMin
	return lerp(clamp((value - fromMin) / (fromMax - fromMin), 0, 1), toMin, toMax)
}

export type Dir = 'down' | 'up' | 'north' | 'south' | 'west' | 'east'

export const STEP: Readonly<Record<Dir, Readonly<Pos>>> = {
	down: [0, -1, 0],
	up: [0, 1, 0],
	north: [0, 0, -1],
	south: [0, 0, 1],
	west: [-1, 0, 0],
	east: [1, 0, 0],
}

export const OPPOSITE: Readonly<Record<Dir, Dir>> = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' }

export const CLOCKWISE: Readonly<Record<Dir, Dir>> = { down: 'down', up: 'up', north: 'east', east: 'south', south: 'west', west: 'north' }

export const HORIZONTAL: readonly Dir[] = ['north', 'east', 'south', 'west']

export const DIRECTIONS: readonly Dir[] = ['down', 'up', 'north', 'south', 'west', 'east']

export function dirOf(value: unknown, fallback: Dir): Dir {
	const text = str(value).toLowerCase()
	return text in STEP ? text as Dir : fallback
}

export function axisOf(dir: Dir): 'x' | 'y' | 'z' {
	return dir === 'up' || dir === 'down' ? 'y' : dir === 'east' || dir === 'west' ? 'x' : 'z'
}

/** A position as a key of a map */
export function key(x: number, y: number, z: number) {
	return `${x},${y},${z}`
}

/** An offset given as `[x, y, z]` */
export function offsetOf(value: unknown): Pos {
	if (!Array.isArray(value)) return [0, 0, 0]
	return [int(value[0], 0), int(value[1], 0), int(value[2], 0)]
}

/** The positions of a box with the given reach around a center, nearest first, the way the game walks `withinManhattan` */
export function withinManhattan(reachX: number, reachY: number, reachZ: number): Pos[] {
	const result: Pos[] = []
	for (let x = -reachX; x <= reachX; x += 1) {
		for (let y = -reachY; y <= reachY; y += 1) {
			for (let z = -reachZ; z <= reachZ; z += 1) {
				result.push([x, y, z])
			}
		}
	}
	const dist = (p: Pos) => Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2])
	return result.sort((a, b) => dist(a) - dist(b))
}
