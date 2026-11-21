import type { vec3 } from 'gl-matrix'
import type { ComponentChildren } from 'preact'
import type { MutableRef } from 'preact/hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { VersionId } from '../../../services/index.js'
import { blockCss } from '../material/blocks.js'
import { prettyId, useStoredFlag } from '../ui.jsx'
import type { ViewportApi } from '../Viewport2D.jsx'
import type { LoadedLooks, LookProvider } from './looks.js'
import { flatLooks, loadedTexturedLooks, loadTexturedLooks } from './looks.js'
import type { SliceRenderer } from './renderer.js'
import type { Hit, MeshTarget } from './slice.js'
import type { WorldSlice } from './slice.js'
import type { Box, CameraMemo } from './Viewport3D.jsx'
import { Viewport3D } from './Viewport3D.jsx'

const TEXTURES_KEY = 'misode_graph_view_textures'
/** How long the page may be busy before it gets to respond again, in milliseconds */
const WORK_BUDGET = 12
const FLAT: { looks: LookProvider, atlas?: ImageData } = { looks: flatLooks() }

interface Textured {
	version: string
	loaded?: LoadedLooks
	failed?: boolean
}

/** Takes the meshes of a slice that nobody looks at */
const NOWHERE: MeshTarget = { setChunk: () => {} }

/** Does the work of a slice that is not drawn, for example to know where its features are */
export function useSliceWork(slice: WorldSlice | undefined, active: boolean, revision: unknown, onDone: (slice: WorldSlice) => void) {
	const latest = useRef(onDone)
	latest.current = onDone
	useEffect(() => {
		if (!slice || !active) return
		let timer: number | undefined
		const step = () => {
			let busy = false
			try {
				busy = slice.work(WORK_BUDGET, NOWHERE)
			} catch (e) {
				// What fails here shows when the slice is drawn
			}
			if (busy) timer = window.setTimeout(step, 0)
			else latest.current(slice)
		}
		timer = window.setTimeout(step, 0)
		return () => {
			if (timer !== undefined) clearTimeout(timer)
		}
	}, [slice, active, revision])
}

export interface DioramaProgress {
	generated: number
	total: number
	/** Whether features are being placed */
	decorating: boolean
	busy: boolean
	quads: number
}

interface Props {
	/** What is shown, or nothing while it cannot be made yet */
	slice: WorldSlice | undefined
	version: VersionId
	/** What the picture is of, for screen readers */
	label: string
	dark: boolean
	/** Where the camera was, kept while the diorama is away */
	memo: CameraMemo
	/** Changes when the slice was given other things to place, which is when its work starts again */
	revision?: unknown
	/** The camera goes back to its start when this changes */
	frameKey?: unknown
	/** What the camera shows at first: the height of its middle and how far it reaches from there. Without it, the camera shows everything up to the highest block. */
	focus?: { y: number, reach: number }
	/** What of the decoration shows through what hides it: all of it, or one part of it by its number from 1 on */
	highlight?: boolean | number
	/** Whether only what the decorator placed is drawn */
	onlyMarked?: boolean
	/** Shown in place of the picture, for example why there is none */
	message?: { title: string, text: string }
	/** Shown while there is no slice yet */
	loading?: string
	/** Called when the work on the slice is done, and when it is done again */
	onDone?: (slice: WorldSlice) => void
	apiRef?: MutableRef<ViewportApi | undefined>
	children?: ComponentChildren
}
/** A piece of the world that can be turned around like a model */
export function Diorama({ slice, version, label, dark, memo, revision, frameKey, focus, highlight = false, onlyMarked = false, message, loading, onDone, apiRef, children }: Props) {
	const [textures] = useStoredFlag(TEXTURES_KEY, true)
	const [textured, setTextured] = useState<Textured | undefined>(() => {
		const loaded = loadedTexturedLooks(version)
		return loaded ? { version, loaded } : undefined
	})
	const [renderer, setRenderer] = useState<SliceRenderer>()
	const [progress, setProgress] = useState<DioramaProgress>()
	const [hover, setHover] = useState<Hit>()
	const [error, setError] = useState<string>()
	// The highest block, in steps of 8, so the camera does not look at the empty height above the terrain
	const [reached, setReached] = useState<{ of: WorldSlice, top: number }>()
	const latest = useRef(onDone)
	latest.current = onDone

	// The models and textures of the game are only downloaded when they are wanted
	useEffect(() => {
		if (!textures) return
		let cancelled = false
		const done = (next: Textured) => {
			// Keeping the same state when nothing changed means this never causes another render
			if (!cancelled) setTextured(prev => prev?.version === next.version && prev.loaded === next.loaded && prev.failed === next.failed ? prev : next)
		}
		loadTexturedLooks(version).then(loaded => done({ version, loaded }), () => done({ version, failed: true }))
		return () => {
			cancelled = true
		}
	}, [textures, version])
	const look = textures && textured?.version === version && textured.loaded ? textured.loaded : FLAT

	// Generates and meshes in small steps, so the diorama can be turned while it appears
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
		slice.setHighlight(highlight)
		slice.setOnlyMarked(onlyMarked)
		setError(undefined)
		let timer: number | undefined
		const step = () => {
			let busy = false
			try {
				busy = slice.work(WORK_BUDGET, renderer)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
			const next: DioramaProgress = { generated: slice.generated, total: slice.total, decorating: slice.generated === slice.total && slice.undecorated > 0, busy, quads: slice.quads }
			setProgress(prev => prev && prev.generated === next.generated && prev.total === next.total && prev.decorating === next.decorating && prev.busy === next.busy && prev.quads === next.quads ? prev : next)
			if (busy) {
				timer = window.setTimeout(step, 0)
				return
			}
			let top = slice.minY
			for (let x = slice.minX; x < slice.minX + slice.sizeX; x += 1) {
				for (let z = slice.minZ; z < slice.minZ + slice.sizeZ; z += 1) top = Math.max(top, slice.topAt(x, z))
			}
			top = Math.min(slice.minY + slice.height, Math.ceil((top + 2) / 8) * 8)
			setReached(prev => prev && prev.of === slice && prev.top === top ? prev : { of: slice, top })
			latest.current?.(slice)
		}
		timer = window.setTimeout(step, 0)
		return () => {
			if (timer !== undefined) clearTimeout(timer)
		}
	}, [slice, renderer, look, highlight, onlyMarked, revision])
	const top = slice && reached?.of === slice ? reached.top : undefined

	const box = useMemo<Box>(() => ({
		sizeX: slice?.sizeX ?? 16,
		sizeZ: slice?.sizeZ ?? 16,
		minY: slice?.minY ?? 0,
		maxY: slice ? top ?? slice.minY + slice.height : 16,
		focusY: focus?.y,
		fit: focus?.reach,
	}), [slice?.sizeX, slice?.sizeZ, slice?.minY, slice?.height, top, focus?.y, focus?.reach])

	const pick = useCallback((origin: vec3, direction: vec3) => {
		return slice?.raycast(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2])
	}, [slice])

	const background = useMemo<[number, number, number]>(() => dark ? [27 / 255, 27 / 255, 28 / 255] : [248 / 255, 250 / 255, 253 / 255], [dark])
	const shown = message ?? (error ? { title: 'Cannot show this', text: error } : undefined)

	return <div class="gx-diorama">
		<Viewport3D label={label} box={box} frameKey={slice ? `${frameKey ?? `${slice.chunksX}x${slice.chunksZ}`} ${focus ? `${focus.y} ${focus.reach}` : top}` : undefined} memo={memo}
			mode="orbit" speed={24} background={background} busy={progress?.busy} pick={pick} onHover={setHover} onRenderer={setRenderer}
			onError={e => setError(e.message)} apiRef={apiRef} />
		{!slice && !shown && loading && <div class="gx-preview-message">{loading}</div>}
		{shown && <div class="gx-preview-message is-error" role="alert">
			<strong>{shown.title}</strong>
			<span>{shown.text}</span>
		</div>}
		{slice && progress && progress.busy && !shown && (progress.generated < progress.total || progress.decorating) && <div class="gx-view-pill gx-view-progress" role="status">
			<span class="gx-spinner" aria-hidden="true" />
			{progress.generated < progress.total ? `Generating chunk ${Math.min(progress.total, progress.generated + 1)} of ${progress.total}` : 'Placing features'}
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
				: <span class="gx-muted">Drag to turn · Right-drag to move · Scroll to zoom</span>}
		</div>
		{children}
	</div>
}
