import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { randomSeed } from '../../Utils.js'
import type { FeatureData } from './features/index.js'
import { documentName } from './FeatureEditor.jsx'
import { Ico } from './icons.jsx'
import { blockColor } from './material/blocks.js'
import type { GraphVersion } from './presets.js'
import { useSessionState } from './session.js'
import { TreeEditor } from './TreeEditor.jsx'
import { CopyButton, Field, IconButton, Lockable, prettyId, Section, Segmented, Switch } from './ui.jsx'
import type { ViewportApi } from './Viewport2D.jsx'
import type { PlacedPosition } from './view/decorate.js'
import { Diorama, useSliceWork } from './view/Diorama.jsx'
import type { WorldSlice } from './view/slice.js'
import type { TerrainInput, TerrainMemory } from './view/terrain.js'
import { cameraOf, placeText, TERRAIN_CHUNKS, useDecoratedTerrain } from './view/terrain.js'

type Mode = 'map' | '3d'
const MODES: { value: Mode, label: string }[] = [{ value: 'map', label: 'Map' }, { value: '3d', label: '3D' }]

/** How many pixels a block is wide on the map */
const MAP_SCALE = 6
const MARK = 'rgb(0, 229, 255)'

/** What was found out about a placer by running it on the terrain */
export interface PlacerOutcome {
	positions: PlacedPosition[]
	/** In how many chunks at least one block was placed */
	chunksPlaced: number
	/** How many blocks were placed */
	blocks: number
	unsupported: string[]
}

interface MapProps {
	slice: WorldSlice | undefined
	/** Changes when the map has to be drawn again */
	revision: unknown
	positions: PlacedPosition[]
	/** Whether blocks that features placed are tinted */
	highlight: boolean
	/** The part of the decoration that the placer is. What the carvers of the dimension cut comes before it. */
	part: number
	label: string
	onHover: (text: string | undefined) => void
}
/** The terrain from above, with a mark at every position where the placer placed its feature */
export function PlacerMap({ slice, revision, positions, highlight, part, label, onHover }: MapProps) {
	const canvas = useRef<HTMLCanvasElement>(null)
	const size = TERRAIN_CHUNKS * 16

	useEffect(() => {
		const context = canvas.current?.getContext('2d')
		if (!context || !slice) return
		const { minX, minZ, minY, height } = slice
		const image = context.createImageData(size, size)
		for (let z = 0; z < size; z += 1) {
			for (let x = 0; x < size; x += 1) {
				const top = slice.topAt(minX + x, minZ + z) - 1
				const at = (z * size + x) * 4
				let color = [0, 0, 0]
				let alpha = 0
				if (top >= minY) {
					color = blockColor(slice.volume.palette[slice.blockAt(minX + x, top, minZ + z)].name)
					// Higher ground is lighter, which gives the terrain its shape
					const shade = 0.72 + 0.28 * (top - minY) / height
					color = color.map(c => c * shade)
					if (highlight && slice.partAt(minX + x, top, minZ + z) >= part) color = [color[0] * 0.6, color[1] * 0.6 + 92, color[2] * 0.6 + 102]
					alpha = 255
				}
				image.data[at] = color[0]
				image.data[at + 1] = color[1]
				image.data[at + 2] = color[2]
				image.data[at + 3] = alpha
			}
		}
		const small = document.createElement('canvas')
		small.width = size
		small.height = size
		small.getContext('2d')?.putImageData(image, 0, 0)
		context.imageSmoothingEnabled = false
		context.clearRect(0, 0, size * MAP_SCALE, size * MAP_SCALE)
		context.drawImage(small, 0, 0, size * MAP_SCALE, size * MAP_SCALE)
		// The borders of the chunks
		context.strokeStyle = 'rgba(128, 128, 128, 0.55)'
		context.lineWidth = 1
		for (let c = 1; c < TERRAIN_CHUNKS; c += 1) {
			context.beginPath()
			context.moveTo(c * 16 * MAP_SCALE + 0.5, 0)
			context.lineTo(c * 16 * MAP_SCALE + 0.5, size * MAP_SCALE)
			context.moveTo(0, c * 16 * MAP_SCALE + 0.5)
			context.lineTo(size * MAP_SCALE, c * 16 * MAP_SCALE + 0.5)
			context.stroke()
		}
		for (const position of positions) {
			if (!slice.contains(position.x, position.z)) continue
			const cx = (position.x - minX + 0.5) * MAP_SCALE
			const cy = (position.z - minZ + 0.5) * MAP_SCALE
			context.beginPath()
			context.arc(cx, cy, MAP_SCALE * 0.62, 0, Math.PI * 2)
			context.fillStyle = MARK
			context.fill()
			context.lineWidth = 1.5
			context.strokeStyle = 'rgba(0, 0, 0, 0.75)'
			context.stroke()
		}
	}, [slice, revision, positions, highlight, part, size])

	return <canvas ref={canvas} class="gx-placer-map" width={size * MAP_SCALE} height={size * MAP_SCALE} role="img" aria-label={label}
		onMouseMove={e => {
			if (!slice) return
			// The map is a square in the middle of the room that it has
			const rect = e.currentTarget.getBoundingClientRect()
			const side = Math.min(rect.width, rect.height)
			const px = (e.clientX - rect.left - (rect.width - side) / 2) / side
			const pz = (e.clientY - rect.top - (rect.height - side) / 2) / side
			if (px < 0 || px >= 1 || pz < 0 || pz >= 1) {
				onHover(undefined)
				return
			}
			const x = slice.minX + Math.floor(px * size)
			const z = slice.minZ + Math.floor(pz * size)
			const here = positions.filter(p => p.x === x && p.z === z)
			onHover(`X ${x} · Z ${z}${here.length > 0 ? ` · placed at Y ${here.map(p => p.y).join(', ')}` : ''}`)
		}}
		onMouseLeave={() => onHover(undefined)} />
}

interface Props {
	id: string
	/** The JSON of the placed feature */
	json: unknown
	version: GraphVersion
	/** Whether the placer is part of a dimension of your own, which can be changed */
	editable: boolean
	data: FeatureData | undefined
	dataError: string | undefined
	/** The ids of the features and placed features that exist, by registry, which is what the form lets a placer refer to */
	known: Record<string, string[]> | undefined
	/** The ids of the carvers of the dimension, which cut the terrain before anything is placed on it */
	carving: string[]
	terrain: TerrainInput
	memory: TerrainMemory
	dark: boolean
	/** Gives the world another seed, which makes other terrain */
	onNewSeed: () => void
	onChange: (json: unknown) => void
}
/** A placed feature as the form of this site, next to where it places its feature on the terrain of the dimension */
export function PlacerEditor({ id, json, version, editable, data, dataError, known, carving, terrain, memory, dark, onNewSeed, onChange }: Props) {
	const [seed, setSeed] = useSessionState('placer.seed', BigInt(1))
	const [mode, setMode] = useSessionState<Mode>('placer.mode', 'map')
	const [highlight, setHighlight] = useSessionState('placer.highlight', true)
	const [outcome, setOutcome] = useState<PlacerOutcome>()
	const [hover, setHover] = useState<string>()
	const viewport = useRef<ViewportApi>()
	const text = useMemo(() => JSON.stringify(json, null, 2), [json])
	const placers = useMemo(() => [json], [text])
	const { slice, error, decorator, revision } = useDecoratedTerrain(terrain, memory, placers, data, seed, carving)

	const onDone = () => {
		if (!decorator) return
		const next: PlacerOutcome = { positions: decorator.positions, chunksPlaced: decorator.placedBy[0] ?? 0, blocks: decorator.blocksBy[0] ?? 0, unsupported: [...decorator.unsupported].sort() }
		// Keeping the same state when nothing changed means this never causes another render
		setOutcome(prev => prev && prev.positions === next.positions && prev.chunksPlaced === next.chunksPlaced && prev.blocks === next.blocks && prev.unsupported.join() === next.unsupported.join() ? prev : next)
	}
	useSliceWork(slice, mode === 'map', revision, onDone)

	const current = outcome && decorator && outcome.positions === decorator.positions ? outcome : undefined
	const chunks = TERRAIN_CHUNKS * TERRAIN_CHUNKS
	const problem = error ? { title: 'Cannot show the terrain', text: error }
		: dataError ? { title: 'The features of the game could not be loaded', text: dataError } : undefined

	return <div class="gx-editor">
		<div class="gx-work gx-work-form">
			<div class="gx-stage gx-form">
				<Lockable locked={!editable}>
					<TreeEditor generator="worldgen/placed_feature" version={version.id} name={documentName(id)} value={json} onChange={onChange} options={known} blockTag={data?.blockTag} />
				</Lockable>
			</div>
			<aside class="gx-side gx-side-wide" aria-label="Preview">
				<div class="gx-side-head">
					<span class="gx-dot gx-dot-lg" style={{ background: 'var(--gx-cat-shape)' }} />
					<div class="gx-side-title">
						<h2>Placement</h2>
						<p>Where {id} places its feature in {TERRAIN_CHUNKS} by {TERRAIN_CHUNKS} chunks of the dimension, around {placeText(terrain.chunk)}</p>
					</div>
					<IconButton icon={Ico.dice} label="Place again, on the same terrain" tipSide="left" onClick={() => setSeed(randomSeed())} />
					<IconButton icon={Ico.seed} label="New seed, at another place of the world" tipSide="left" onClick={() => {
						onNewSeed()
						setSeed(randomSeed())
					}} />
					{mode === '3d' && <IconButton icon={Ico.target} label="Reset the view" tipSide="left" onClick={() => viewport.current?.reset()} />}
				</div>
				<div class="gx-diorama-frame">
					{mode === '3d'
						? <Diorama slice={data ? slice : undefined} revision={revision} version={version.id} label={`The terrain of the dimension with ${id} placed on it, in 3D`} dark={dark}
							memo={cameraOf(memory, 'placer')} highlight={highlight ? decorator?.firstPart ?? true : false} loading="Loading world generation…" message={problem} onDone={onDone} apiRef={viewport} />
						: <div class="gx-placer-map-frame">
							<PlacerMap slice={current ? slice : undefined} revision={revision} positions={current?.positions ?? []} highlight={highlight} part={decorator?.firstPart ?? 1}
								label={`The terrain of the dimension from above, with a mark where ${id} places its feature`} onHover={setHover} />
							{problem && <div class="gx-preview-message is-error" role="alert">
								<strong>{problem.title}</strong>
								<span>{problem.text}</span>
							</div>}
							{!current && !problem && <div class="gx-preview-message" role="status">Generating the terrain and placing features…</div>}
							<div class="gx-view-pill gx-view-readout">
								<span class={hover ? '' : 'gx-muted'}>{hover ?? 'North is up. Every mark is a position where the feature was generated.'}</span>
							</div>
						</div>}
				</div>
				<Section title="View">
					<div class="gx-fields">
						<Field label="Mode" hint="A map from above with the positions, or the terrain in 3D with the features on it">
							{() => <Segmented label="How the placement is shown" value={mode} options={MODES} onChange={setMode} />}
						</Field>
						<Field label="Highlight" hint={mode === '3d' ? 'Outlines the blocks of the features where the terrain hides them' : 'Tints the blocks of the features on the map'}>
							{fieldId => <div class="gx-switch-row">
								<Switch id={fieldId} label="Highlight the blocks that the features placed" checked={highlight} onChange={setHighlight} />
								<span class="gx-muted">{!highlight ? 'Off' : mode === '3d' ? 'Features show through the ground' : 'Blocks of features are tinted'}</span>
							</div>}
						</Field>
					</div>
				</Section>
				<Section title="What was placed">
					{!current
						? <p class="gx-muted">Placing…</p>
						: <p class="gx-muted">
							{current.positions.length === 0
								? 'The placement gave no position in these chunks. Rare features may need another try.'
								: `${current.positions.length} position${current.positions.length === 1 ? '' : 's'} in ${chunks} chunks, about ${(current.positions.length / chunks).toFixed(1)} for each chunk. ${current.blocks === 0
									? 'The feature placed nothing at any of them. It may need another ground, more room, or a height inside of the world.'
									: `The feature placed ${current.blocks.toLocaleString('en')} block${current.blocks === 1 ? '' : 's'}, in ${current.chunksPlaced} of the chunks.`}`}
						</p>}
					{current && current.unsupported.length > 0 && <div class="gx-note" role="note">
						<strong>Not everything can be shown here</strong>
						<span>The game generates this, but the editor cannot yet: {current.unsupported.map(reason => prettyId(reason)).join(', ')}.</span>
					</div>}
					<p class="gx-muted">A placer only does something once the dimension uses it. Add it to the list on the Dimension tab.</p>
				</Section>
				<Section title="JSON" collapsible defaultOpen={false} actions={<CopyButton getText={() => text} />}>
					<pre class="gx-json" tabIndex={0}>{text}</pre>
				</Section>
			</aside>
		</div>
	</div>
}
