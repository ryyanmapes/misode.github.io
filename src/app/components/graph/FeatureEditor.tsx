import { useMemo, useRef, useState } from 'preact/hooks'
import { randomSeed } from '../../Utils.js'
import type { FeatureData } from './features/index.js'
import { Ico } from './icons.jsx'
import { blockCss } from './material/blocks.js'
import type { GraphVersion } from './presets.js'
import { useSessionState } from './session.js'
import { TreeEditor } from './TreeEditor.jsx'
import { CopyButton, Field, IconButton, Lockable, prettyId, Section, Select, Switch, TextField } from './ui.jsx'
import type { ViewportApi } from './Viewport2D.jsx'
import type { Stage, StageScene } from './view/decorate.js'
import { defaultGround, FeatureDecorator, findStage, STAGE_SCENES, stageFor, StageVolume } from './view/decorate.js'
import { Diorama } from './view/Diorama.jsx'
import type { WorldSlice } from './view/slice.js'
import type { CameraMemo } from './view/Viewport3D.jsx'

/** What was found out about a feature by generating it */
interface Outcome {
	placed: boolean
	unsupported: string[]
	/** The blocks that the feature placed, most common first */
	blocks: { name: string, count: number }[]
	/** Where the camera looks to show all of the feature: the height of its middle, and how far it reaches from there */
	focus: { y: number, reach: number } | undefined
}

/** A name that can be part of the address of a document */
export function documentName(id: string) {
	return id.replace(/[^a-z0-9]+/gi, '_')
}

interface Props {
	id: string
	/** The JSON of the feature */
	json: unknown
	version: GraphVersion
	/** Whether the feature is part of a dimension of your own, which can be changed */
	editable: boolean
	/** What features can refer to, once the features of the game are downloaded */
	data: FeatureData | undefined
	/** Why the features of the game could not be downloaded */
	dataError: string | undefined
	/** The ids of the blocks that exist, to choose a ground from */
	blocks: string[] | undefined
	/** The ids of the features and placed features that exist, by registry, which is what the form lets a feature refer to */
	known: Record<string, string[]> | undefined
	dark: boolean
	camera: CameraMemo
	onChange: (json: unknown) => void
}
/** A feature as the form of this site, next to an example of what it generates */
export function FeatureEditor({ id, json, version, editable, data, dataError, blocks, known, dark, camera, onChange }: Props) {
	const [seed, setSeed] = useSessionState('feature.seed', BigInt(1))
	// The scene and its ground follow the feature until they are chosen by hand: first by the kind of
	// feature, and when that places nothing, by trying the grounds that features are made for
	const [chosen, setChosen] = useState<Partial<Stage>>({})
	const [found, setFound] = useState<{ of: string, stage: Stage }>()
	const type = String((json as { type?: unknown })?.type)
	const guess = useMemo(() => stageFor(json), [type])
	const auto = found?.of === type ? found.stage : guess
	const scene = chosen.scene ?? auto.scene
	const ground = chosen.ground ?? (chosen.scene ? defaultGround(chosen.scene) : auto.ground)
	const searched = useRef<string>()
	// The ground is left out at first, so the feature is seen whole
	const [hidden, setHidden] = useSessionState('feature.onlyFeature', true)
	// Where the camera looks is decided once for a ground, by the first example on it. After that the camera
	// stays where it was put, also when another example is larger or smaller.
	const stageKey = `${scene} ${ground}`
	const [framed, setFramed] = useState<{ of: string, focus: { y: number, reach: number } }>()
	const [through, setThrough] = useSessionState('feature.through', true)
	const [outcome, setOutcome] = useState<Outcome>()
	const viewport = useRef<ViewportApi>()

	const stage = useMemo(() => {
		const volume = new StageVolume({ scene, ground })
		return { volume, slice: volume.slice() }
	}, [scene, ground])

	const text = useMemo(() => JSON.stringify(json, null, 2), [json])
	const decoration = useMemo(() => {
		if (!data) return undefined
		const decorator = new FeatureDecorator(json, data, seed, stage.volume.seaLevel, stage.volume.origin)
		stage.slice.redecorate(decorator)
		return { decorator, revision: {} }
	}, [stage, text, data, seed])

	const onDone = (slice: WorldSlice) => {
		const decorator = decoration?.decorator
		if (!decorator || decorator.placed === undefined) return
		const counts = new Map<string, number>()
		const { minX, minZ, sizeX, sizeZ, minY, height } = slice
		const [originX, , originZ] = stage.volume.origin
		let low = Infinity
		let high = -Infinity
		let wide = 0
		for (let x = minX; x < minX + sizeX; x += 1) {
			for (let z = minZ; z < minZ + sizeZ; z += 1) {
				for (let y = minY; y < minY + height; y += 1) {
					if (!slice.markedAt(x, y, z)) continue
					low = Math.min(low, y)
					high = Math.max(high, y + 1)
					wide = Math.max(wide, Math.abs(x + 0.5 - originX - 0.5), Math.abs(z + 0.5 - originZ - 0.5))
					const name = slice.volume.palette[slice.blockAt(x, y, z)].name
					counts.set(name, (counts.get(name) ?? 0) + 1)
				}
			}
		}
		const next: Outcome = {
			placed: decorator.placed,
			unsupported: [...decorator.unsupported].sort(),
			blocks: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
			// In steps, so the camera only moves when the feature is much larger or smaller than the one before
			focus: counts.size === 0 ? undefined : {
				y: Math.round((low + high) / 2 / 4) * 4,
				reach: Math.min(40, Math.ceil((Math.hypot(wide + 1, wide + 1, (high - low) / 2) + 3) / 6) * 6),
			},
		}
		// Keeping the same state when nothing changed means this never causes another render
		setOutcome(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
		const { focus } = next
		if (focus) setFramed(prev => prev?.of === stageKey ? prev : { of: stageKey, focus })
		// Nothing was placed and no ground was chosen: look once for a ground where the feature does place something
		if (!next.placed && next.unsupported.length === 0 && data && chosen.scene === undefined && chosen.ground === undefined && searched.current !== text) {
			searched.current = text
			const better = findStage(json, data, seed)
			if (better && (better.scene !== scene || better.ground !== ground)) setFound({ of: type, stage: better })
		}
	}

	const generator = version.format === 'modern' ? 'worldgen/feature' : 'worldgen/configured_feature'
	const empty = outcome && !outcome.placed && outcome.unsupported.length === 0

	return <div class="gx-editor">
		<div class="gx-work gx-work-form">
			<div class="gx-stage gx-form">
				<Lockable locked={!editable}>
					<TreeEditor generator={generator} version={version.id} name={documentName(id)} value={json} onChange={onChange} options={known} blockTag={data?.blockTag} />
				</Lockable>
			</div>
			<aside class="gx-side gx-side-wide" aria-label="Preview">
				<div class="gx-side-head">
					<span class="gx-dot gx-dot-lg" style={{ background: 'var(--gx-cat-shape)' }} />
					<div class="gx-side-title">
						<h2>Example</h2>
						<p>One way that {id} can turn out</p>
					</div>
					<IconButton icon={Ico.dice} label="Generate another example" tipSide="left" onClick={() => setSeed(randomSeed())} />
					<IconButton icon={Ico.target} label="Reset the view" tipSide="left" onClick={() => {
						// Resetting looks at the example that is there now
						if (outcome?.focus) setFramed({ of: stageKey, focus: outcome.focus })
						viewport.current?.reset()
					}} />
				</div>
				<div class="gx-diorama-frame">
					<Diorama slice={data ? stage.slice : undefined} revision={decoration?.revision} version={version.id} label={`An example of ${id} in 3D`} dark={dark} memo={camera}
						frameKey={stageKey} focus={framed?.of === stageKey ? framed.focus : { y: stage.volume.origin[1] + 4, reach: 18 }} highlight={through && !hidden} onlyMarked={hidden}
						loading={dataError ? undefined : 'Loading the features of the game…'}
						message={dataError ? { title: 'The features of the game could not be loaded', text: dataError } : undefined}
						onDone={onDone} apiRef={viewport} />
				</div>
				<Section title="Scene">
					<div class="gx-fields">
						<Field label="Where" hint="Where the feature is generated. The editor picks what suits the feature until you choose.">
							{fieldId => <Select id={fieldId} label="Where the feature is generated" value={scene} options={STAGE_SCENES} onChange={value => setChosen({ scene: value as StageScene })} />}
						</Field>
						<Field label="Ground block" hint="The block that the ground is made of. Many features only work on the ground that they are made for.">
							{fieldId => <TextField id={fieldId} label="The block that the ground is made of" mono value={ground} options={blocks} placeholder="minecraft:…"
								onChange={value => {
									if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value)) setChosen({ scene, ground: value })
								}} />}
						</Field>
						<Field label="Only the feature" hint="Leaves out the ground, which shows features that are inside of it">
							{fieldId => <div class="gx-switch-row">
								<Switch id={fieldId} label="Show only the blocks of the feature" checked={hidden} onChange={setHidden} />
								<span class="gx-muted">{hidden ? 'The ground is left out' : 'Off'}</span>
							</div>}
						</Field>
						{!hidden && <Field label="See through" hint="Outlines the parts of the feature that the ground hides">
							{fieldId => <div class="gx-switch-row">
								<Switch id={fieldId} label="Show the feature through the ground" checked={through} onChange={setThrough} />
								<span class="gx-muted">{through ? 'Hidden parts are outlined' : 'Off'}</span>
							</div>}
						</Field>}
					</div>
				</Section>
				<Section title="What was generated">
					{!outcome && <p class="gx-muted">Generating…</p>}
					{outcome && outcome.blocks.length > 0 && <ul class="gx-chips" aria-label="Blocks of the feature">
						{outcome.blocks.slice(0, 12).map(block => <li key={block.name}>
							<span class="gx-swatch" style={{ background: blockCss(block.name) }} />
							{prettyId(block.name).replace(/_/g, ' ')}
							<span class="gx-muted">{block.count}</span>
						</li>)}
					</ul>}
					{empty && <p class="gx-muted">Nothing was placed this time. Features can need a certain ground or just fail now and then: try another ground block, or generate another example.</p>}
					{outcome && outcome.unsupported.length > 0 && <div class="gx-note" role="note">
						<strong>Not everything can be shown here</strong>
						<span>The game generates this, but the editor cannot yet: {outcome.unsupported.map(reason => prettyId(reason)).join(', ')}.</span>
					</div>}
					<p class="gx-muted">The example is made by the editor, which follows the game closely but not block for block.</p>
				</Section>
				<Section title="JSON" collapsible defaultOpen={false} actions={<CopyButton getText={() => text} />}>
					<pre class="gx-json" tabIndex={0}>{text}</pre>
				</Section>
			</aside>
		</div>
	</div>
}
