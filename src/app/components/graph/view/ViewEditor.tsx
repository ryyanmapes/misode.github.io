import type { vec3 } from 'gl-matrix'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Ico } from '../icons.jsx'
import { blockCss } from '../material/blocks.js'
import { materialSerializer } from '../material/convert.js'
import type { FeatureData } from '../features/index.js'
import { ruleName } from '../material/schema.js'
import type { GraphVersion } from '../presets.js'
import type { GraphStore } from '../store.js'
import { useStore, useStructure } from '../store.js'
import { Field, IconButton, prettyId, Section, Segmented, Select, Slider, Switch, useStoredFlag } from '../ui.jsx'
import type { ViewportApi } from '../Viewport2D.jsx'
import type { WorldgenEnv } from '../worldgen.js'
import { TerrainVolume } from '../worldgen.js'
import { Carving, carveSettingsOf } from './carve.js'
import { PlacerDecorator } from './decorate.js'
import type { LoadedLooks, LookProvider } from './looks.js'
import { flatLooks, loadedTexturedLooks, loadTexturedLooks } from './looks.js'
import type { SliceRenderer } from './renderer.js'
import type { Hit } from './slice.js'
import { WorldSlice } from './slice.js'
import type { Box, CameraMemo, CameraMode } from './Viewport3D.jsx'
import { Viewport3D } from './Viewport3D.jsx'

const TEXTURES_KEY = 'misode_graph_view_textures'
const FLY_KEY = 'misode_graph_view_fly'
const CAMERA_MODES: { value: CameraMode, label: string }[] = [{ value: 'orbit', label: 'Diorama' }, { value: 'fly', label: 'Free flight' }]
/** How long the page may be busy before it gets to respond again, in milliseconds */
const WORK_BUDGET = 12
const SIZES = [2, 4, 6, 8, 12, 16]
const FLAT: { looks: LookProvider, atlas?: ImageData } = { looks: flatLooks() }

/** What the view keeps while another tab or preset is open, so coming back does not start over */
export interface ViewMemory {
	chunksX: number
	chunksZ: number
	/** The biome that was chosen, and the preset that it was chosen for. Every preset starts with its own biome. */
	biome?: string
	biomeOf?: string
	/** Where the camera is */
	camera: CameraMemo
	/** Blocks at this height and above are cut away */
	top?: number
	/** How fast the camera flies, in blocks for each second */
	speed: number
	key?: string
	slice?: WorldSlice
	/** What the features of the slice referred to when it was made */
	features?: unknown
}

export function createViewMemory(): ViewMemory {
	return { chunksX: 4, chunksZ: 4, speed: 24, camera: {} }
}

/** The textures of a version of the game, once they are loaded or failed to load */
interface TexturedState {
	version: string
	loaded?: LoadedLooks
	failed?: boolean
}

interface Progress {
	generated: number
	total: number
	quads: number
	busy: boolean
	/** The blocks of the slice, most common first */
	blocks: { name: string, count: number }[]
}

interface Props {
	version: GraphVersion
	/** Tells the dimensions apart that the view remembers things for */
	tabKey: string
	/** What the dimension is called */
	label: string
	/** Whether the dimension is one of your own, which can be changed */
	editable: boolean
	/** The biome that the view starts with */
	defaultBiome: string
	env: WorldgenEnv | undefined
	registries: Map<string, string[]> | undefined
	/** The graph of the rule, which is applied on top of the terrain */
	material: GraphStore
	/** The ids of the placed features that the dimension generates */
	decoration: string[]
	/** The ids of the carvers of the dimension, which cut the terrain before features are placed */
	carving: string[]
	/** What carvers and features can refer to. Only needed when the dimension has carvers or places features. */
	features: FeatureData | undefined
	/** The noise settings as a JSON string, with the final density as it is now */
	settings: string | undefined
	seed: bigint
	onNewSeed: () => void
	dark: boolean
	memory: ViewMemory
}
/** Shows a piece of the world in 3D, as it is after the final density and the rule */
export function ViewEditor({ version, tabKey, label, editable, defaultBiome, env, registries, material, decoration, carving, features, settings, seed, onNewSeed, dark, memory }: Props) {
	useStore(material)
	const materialDoc = useStructure(material.doc)
	const rule = useMemo(() => JSON.stringify(materialSerializer(materialDoc).root()), [materialDoc])

	const [chunksX, setChunksX] = useState(memory.chunksX)
	const [chunksZ, setChunksZ] = useState(memory.chunksZ)
	const [chosenBiome, setBiome] = useState(memory.biomeOf === tabKey && memory.biome ? memory.biome : defaultBiome)
	// A biome that the dimension no longer has, for example after its biome got another id, gives way to the one that it has
	const dimensionBiomes = registries?.get('worldgen/biome')
	const biome = dimensionBiomes && !dimensionBiomes.includes(chosenBiome) ? defaultBiome : chosenBiome
	const [top, setTop] = useState(memory.top)
	const [textures, setTextures] = useStoredFlag(TEXTURES_KEY, true)
	const [flying, setFlying] = useStoredFlag(FLY_KEY, false)
	const [speed, setSpeed] = useState(memory.speed)
	const [textured, setTextured] = useState<TexturedState | undefined>(() => {
		const loaded = loadedTexturedLooks(version.id)
		return loaded ? { version: version.id, loaded } : undefined
	})
	const [renderer, setRenderer] = useState<SliceRenderer>()
	const [progress, setProgress] = useState<Progress>()
	const [hover, setHover] = useState<Hit>()
	const [error, setError] = useState<string>()
	const viewport = useRef<ViewportApi>()
	Object.assign(memory, { chunksX, chunksZ, biome, biomeOf: tabKey, top, speed })

	// What the terrain refers to by id is part of what it is, so the view is made again when that changes
	const key = `${version.id}\n${env?.rev}\n${seed}\n${biome}\n${chunksX}x${chunksZ}\n${rule}\n${settings}\n${decoration.join(' ')}\n${carving.join(' ')}`
	// The world waits for what the game has of features and block tags when the dimension has carvers or places features
	const decorated = decoration.length > 0 || carving.length > 0
	const placing = decorated ? features : undefined
	const waiting = decorated && !features
	const built = useMemo(() => {
		if (!env || !settings || waiting) return undefined
		if (memory.key === key && memory.slice && memory.features === placing) return { slice: memory.slice }
		try {
			const parsed = JSON.parse(settings)
			const volume = new TerrainVolume(env, parsed, JSON.parse(rule), seed, biome)
			const carveSettings = carveSettingsOf(parsed)
			const carvers = placing && carving.length > 0 ? new Carving(carving, placing, seed, carveSettings) : undefined
			const decorator = placing ? new PlacerDecorator(decoration, placing, seed, carveSettings.seaLevel, carvers) : undefined
			const slice = new WorldSlice(volume, chunksX, chunksZ, decorator)
			memory.key = key
			memory.slice = slice
			memory.features = placing
			return { slice }
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) }
		}
	}, [env, key, placing, waiting])
	const slice = built?.slice

	// The models and textures of the game are only downloaded when they are wanted
	useEffect(() => {
		if (!textures) return
		let cancelled = false
		const done = (next: TexturedState) => {
			// Keeping the same state when nothing changed means this never causes another render
			if (!cancelled) setTextured(prev => prev?.version === next.version && prev.loaded === next.loaded && prev.failed === next.failed ? prev : next)
		}
		loadTexturedLooks(version.id).then(loaded => done({ version: version.id, loaded }), () => done({ version: version.id, failed: true }))
		return () => {
			cancelled = true
		}
	}, [textures, version.id])
	const look = textures && textured?.version === version.id && textured.loaded ? textured.loaded : FLAT

	const maxY = slice ? slice.minY + slice.height : 0
	const shownTop = slice ? Math.min(maxY, Math.max(slice.minY + 1, top ?? maxY)) : 0

	// Generates and meshes in small steps, so the view can be turned while the world appears
	const drawn = useRef<{ slice?: WorldSlice, renderer?: SliceRenderer, atlas?: ImageData }>({})
	useEffect(() => {
		if (!slice || !renderer) return
		if (drawn.current.slice !== slice || drawn.current.renderer !== renderer) {
			renderer.clear()
			slice.remesh()
			drawn.current = { slice, renderer, atlas: drawn.current.renderer === renderer ? drawn.current.atlas : undefined }
		}
		if (look.atlas && drawn.current.atlas !== look.atlas) {
			renderer.setAtlas(look.atlas)
			drawn.current.atlas = look.atlas
		}
		slice.setLooks(look.looks)
		slice.setTop(shownTop)
		setError(undefined)
		let timer: number | undefined
		const step = () => {
			let busy = false
			try {
				busy = slice.work(WORK_BUDGET, renderer)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
			// A block can be in the palette more than once, with other properties. The list has it once.
			const byName = new Map<string, number>()
			slice.volume.palette.forEach((block, i) => byName.set(block.name, (byName.get(block.name) ?? 0) + (slice.counts[i] ?? 0)))
			setProgress({
				generated: slice.generated,
				total: slice.total,
				quads: slice.quads,
				busy,
				blocks: [...byName].map(([name, count]) => ({ name, count }))
					.filter(block => block.count > 0 && block.name !== 'minecraft:air')
					.sort((a, b) => b.count - a.count),
			})
			timer = busy ? window.setTimeout(step, 0) : undefined
		}
		timer = window.setTimeout(step, 0)
		return () => {
			if (timer !== undefined) clearTimeout(timer)
		}
	}, [slice, renderer, look, shownTop])

	// The box ends where the world is cut away, so what is left turns around its own middle
	const box = useMemo<Box>(() => ({
		sizeX: slice?.sizeX ?? 16,
		sizeZ: slice?.sizeZ ?? 16,
		minY: slice?.minY ?? 0,
		maxY: slice ? shownTop : 16,
	}), [slice?.sizeX, slice?.sizeZ, slice?.minY, shownTop])

	const pick = useCallback((origin: vec3, direction: vec3) => {
		return slice?.raycast(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2])
	}, [slice])

	const biomeOptions = useMemo(() => {
		// Only the biomes of the dimension are offered, with the one that is shown always among them
		const ids = registries?.get('worldgen/biome') ?? [defaultBiome]
		return [...new Set([...ids, biome])].map(id => ({ value: id, label: prettyId(id).replace(/_/g, ' ') }))
	}, [registries, biome, defaultBiome])

	const sizeOptions = SIZES.map(n => ({ value: String(n), label: `${n} chunks · ${n * 16} blocks` }))
	const background = useMemo<[number, number, number]>(() => dark ? [27 / 255, 27 / 255, 28 / 255] : [248 / 255, 250 / 255, 253 / 255], [dark])
	const name = ruleName(version.format)
	const message = built?.error ?? error
	const solid = progress?.blocks.reduce((sum, block) => sum + block.count, 0) ?? 0
	const texturesNote = !textures ? 'Blocks have the colors of the other previews'
		: textured?.failed ? 'The textures could not be loaded, so blocks have plain colors'
			: look === FLAT ? 'Loading the textures of the game…'
				: 'Blocks that the game does not know have plain colors'

	return <div class="gx-editor gx-view">
		<div class="gx-work">
			<div class="gx-stage">
				<Viewport3D label={`The terrain of ${label} in 3D`} box={box} frameKey={slice ? `${chunksX}x${chunksZ}` : undefined} memo={memory.camera}
					mode={flying ? 'fly' : 'orbit'} speed={speed} background={background} busy={progress?.busy} pick={pick} onHover={setHover} onRenderer={setRenderer}
					onError={e => setError(e.message)} apiRef={viewport} />
				{(!env || !settings || waiting) && <div class="gx-preview-message">Loading world generation…</div>}
				{message && <div class="gx-preview-message is-error" role="alert">
					<strong>Cannot show this world</strong>
					<span>{message}</span>
				</div>}
				{progress && progress.generated === progress.total && !progress.busy && progress.quads === 0 && !message && <div class="gx-preview-message">
					<strong>This world is empty</strong>
					<span>{editable ? 'Terrain appears where the final density is above zero.' : 'The final density is not above zero anywhere in this slice.'}</span>
				</div>}
				{progress && progress.generated < progress.total && !message && <div class="gx-view-pill gx-view-progress" role="status">
					<span class="gx-spinner" aria-hidden="true" />
					Generating chunk {Math.min(progress.total, progress.generated + 1)} of {progress.total}
				</div>}
				<div class="gx-view-pill gx-view-readout">
					{hover
						? <>
							<span>X {hover.x}</span>
							<span>Y {hover.y}</span>
							<span>Z {hover.z}</span>
							<span class="gx-readout-value">
								<span class="gx-swatch" style={{ background: blockCss(hover.name) }} />
								{prettyId(hover.name).replace(/_/g, ' ')}
							</span>
						</>
						: <span class="gx-muted">{flying
							? 'Drag to look · W A S D to fly · Space and Shift for up and down · Scroll to move ahead'
							: 'Drag to turn · Right-drag to move · Scroll to zoom'}</span>}
				</div>
			</div>
			<aside class="gx-side" aria-label="World view">
				<div class="gx-side-head">
					<span class="gx-dot gx-dot-lg" style={{ background: 'var(--gx-cat-shape)' }} />
					<div class="gx-side-title">
						<h2>World view</h2>
						<p>{decorated
							? `The terrain after the final density and the ${name}, with the carvers and placed features of the dimension`
							: `The terrain after the final density and the ${name}`}</p>
					</div>
					<IconButton icon={Ico.dice} label="New random seed" tipSide="left" onClick={onNewSeed} />
					<IconButton icon={Ico.target} label="Reset the view" tipSide="left" onClick={() => viewport.current?.reset()} />
				</div>
				<Section title="Camera">
					<div class="gx-fields">
						<Field label="Mode" hint="Turn the world around like a model, or fly through it, also through blocks">
							{() => <Segmented label="How the camera moves" value={flying ? 'fly' : 'orbit'} options={CAMERA_MODES} onChange={value => setFlying(value === 'fly')} />}
						</Field>
						{flying && <Field label="Speed" hint="How fast the camera flies">
							{() => <>
								<Slider label="How fast the camera flies, in blocks for each second" min={4} max={96} step={4} value={speed} onChange={setSpeed} />
								<span class="gx-view-value gx-view-speed">{speed} blocks/s</span>
							</>}
						</Field>}
					</div>
					<p class="gx-muted">{flying
						? <>Click the view, then fly with <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd>, go up with <kbd>Space</kbd> and down with <kbd>Shift</kbd>. Drag to look around.</>
						: 'The world turns around its middle. Scrolling zooms to the block under the pointer.'}</p>
				</Section>
				<Section title="Slice">
					<div class="gx-fields">
						<Field label="Width" hint="How far the slice reaches from west to east, along X">
							{id => <Select id={id} label="Width of the slice" value={String(chunksX)} options={sizeOptions} onChange={v => setChunksX(Number(v))} />}
						</Field>
						<Field label="Depth" hint="How far the slice reaches from north to south, along Z">
							{id => <Select id={id} label="Depth of the slice" value={String(chunksZ)} options={sizeOptions} onChange={v => setChunksZ(Number(v))} />}
						</Field>
						{biomeOptions.length > 1 && <Field label="Biome" hint={`The ${name} can place other blocks in other biomes`}>
							{id => <Select id={id} label="Biome of the slice" value={biome} options={biomeOptions} onChange={setBiome} />}
						</Field>}
					</div>
					{slice && <p class="gx-muted">
						X {slice.minX} to {slice.minX + slice.sizeX - 1}, Y {slice.minY} to {maxY - 1}, Z {slice.minZ} to {slice.minZ + slice.sizeZ - 1}
					</p>}
				</Section>
				<Section title="Display">
					<div class="gx-fields">
						<Field label="Cut away above" hint="Leaves out the top of the world, to look inside from above">
							{() => <>
								<Slider label="The height above which blocks are cut away" min={(slice?.minY ?? 0) + 1} max={maxY} step={1} value={shownTop}
									onChange={value => setTop(value >= maxY ? undefined : value)} />
								<span class="gx-view-value">{!slice || shownTop >= maxY ? 'Off' : `Y ${shownTop - 1}`}</span>
							</>}
						</Field>
						<Field label="Textures">
							{id => <div class="gx-switch-row">
								<Switch id={id} label="Show the textures of the game" checked={textures} onChange={setTextures} />
								<span class="gx-muted">{textures ? 'On' : 'Off'}</span>
							</div>}
						</Field>
					</div>
					<p class="gx-muted">{texturesNote}</p>
				</Section>
				<Section title="Blocks">
					<p class="gx-muted" aria-live="polite">
						{!progress ? 'Nothing generated yet'
							: `${progress.generated} of ${progress.total} chunks · ${progress.quads.toLocaleString('en-US')} faces drawn`}
					</p>
					{progress && progress.blocks.length > 0 && <ul class="gx-chips" aria-label="Blocks in the slice">
						{progress.blocks.slice(0, 16).map(block => {
							const share = block.count / solid * 100
							return <li key={block.name}>
								<span class="gx-swatch" style={{ background: blockCss(block.name) }} />
								{prettyId(block.name).replace(/_/g, ' ')}
								<span class="gx-muted">{share < 0.1 ? '<0.1' : share.toFixed(1)}%</span>
							</li>
						})}
					</ul>}
				</Section>
			</aside>
		</div>
	</div>
}
