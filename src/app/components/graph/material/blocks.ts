import { hexToRgb } from '../../../Utils.js'
import { BlockColors } from '../../previews/NoiseSettingsPreview.jsx'

type Rgb = [number, number, number]

const EXTRA: Record<string, Rgb> = {
	'minecraft:nether_wart_block': hexToRgb('#730a09'),
	'minecraft:warped_wart_block': hexToRgb('#167779'),
	'minecraft:magma_block': hexToRgb('#8e3f20'),
	'minecraft:obsidian': hexToRgb('#100c1c'),
	'minecraft:glowstone': hexToRgb('#ab8354'),
	'minecraft:andesite': hexToRgb('#888889'),
	'minecraft:diorite': hexToRgb('#bcbcbd'),
	'minecraft:granite': hexToRgb('#956755'),
	'minecraft:tuff': hexToRgb('#6c6d66'),
	'minecraft:clay': hexToRgb('#a0a6b3'),
	'minecraft:snow': hexToRgb('#f9fefe'),
	'minecraft:moss_block': hexToRgb('#596d2d'),
}

const cache = new Map<string, Rgb>()

/** The color that represents a block in previews. Unknown blocks get a color based on their name. */
export function blockColor(name: string): Rgb {
	const id = name.includes(':') ? name : `minecraft:${name}`
	let color = cache.get(id)
	if (!color) {
		color = BlockColors[id] ?? EXTRA[id]
		if (!color) {
			let hash = 0
			for (let i = 0; i < id.length; i += 1) {
				hash = (hash * 31 + id.charCodeAt(i)) | 0
			}
			const hue = Math.abs(hash) % 360
			color = hslToRgb(hue, 0.35, 0.5)
		}
		cache.set(id, color)
	}
	return color
}

export function blockCss(name: string) {
	const [r, g, b] = blockColor(name)
	return `rgb(${r}, ${g}, ${b})`
}

function hslToRgb(h: number, s: number, l: number): Rgb {
	const a = s * Math.min(l, 1 - l)
	const f = (n: number) => {
		const k = (n + h / 30) % 12
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
	}
	return [f(0), f(8), f(4)]
}
