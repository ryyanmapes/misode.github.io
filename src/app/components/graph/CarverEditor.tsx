import { useMemo, useRef, useState } from 'preact/hooks'
import { randomSeed } from '../../Utils.js'
import type { FeatureData } from './features/index.js'
import { documentName } from './FeatureEditor.jsx'
import { Ico } from './icons.jsx'
import { registryOf } from './items.js'
import type { GraphVersion } from './presets.js'
import { useSessionState } from './session.js'
import { TreeEditor } from './TreeEditor.jsx'
import { CopyButton, Field, IconButton, Lockable, prettyId, Section, Switch } from './ui.jsx'
import type { ViewportApi } from './Viewport2D.jsx'
import { Diorama } from './view/Diorama.jsx'
import type { TerrainInput, TerrainMemory } from './view/terrain.js'
import { cameraOf, TERRAIN_CHUNKS, useDecoratedTerrain } from './view/terrain.js'

/** What each type of carver cuts out of the terrain */
const SHAPES: Record<string, string> = {
	cave: 'Tunnels that wind through the terrain and fork, with a round room here and there.',
	nether_cave: 'The caves of the Nether: tunnels like those of a cave carver, wider and much higher where they start.',
	canyon: 'A long and narrow ravine with steep walls.',
}

const NO_PLACERS: unknown[] = []

/** What was found out about a carver by letting it cut the terrain */
interface Outcome {
	of: unknown
	blocks: number
	starts: number
	unsupported: string[]
}

interface Props {
	id: string
	/** The JSON of the carver */
	json: unknown
	version: GraphVersion
	/** Whether the carver is part of a dimension of your own, which can be changed */
	editable: boolean
	/** Whether the dimension has the carver in its list */
	used: boolean
	/** The block tags of the game, which tell what a carver may cut */
	data: FeatureData | undefined
	dataError: string | undefined
	terrain: TerrainInput
	memory: TerrainMemory
	dark: boolean
	onChange: (json: unknown) => void
}
/** A carver as the form of this site, next to what it cuts out of the terrain of the dimension */
export function CarverEditor({ id, json, version, editable, used, data, dataError, terrain, memory, dark, onChange }: Props) {
	const [seed, setSeed] = useSessionState('carver.seed', BigInt(1))
	const [highlight, setHighlight] = useSessionState('carver.highlight', true)
	const [outcome, setOutcome] = useState<Outcome>()
	const viewport = useRef<ViewportApi>()
	const text = useMemo(() => JSON.stringify(json, null, 2), [json])
	const carvers = useMemo(() => [json], [text])
	// Another seed cuts other caves out of the same terrain
	const { slice, error, decorator, revision } = useDecoratedTerrain(terrain, memory, NO_PLACERS, data, seed, carvers, seed)
	const type = typeof (json as { type?: unknown })?.type === 'string' ? prettyId((json as { type: string }).type) : ''
	const generator = registryOf('carver', version.format)

	const onDone = () => {
		const carving = decorator?.carving
		if (!carving) return
		const next: Outcome = { of: decorator, blocks: carving.blocksBy[0] ?? 0, starts: carving.startsBy[0] ?? 0, unsupported: [...carving.unsupported].sort() }
		// Keeping the same state when nothing changed means this never causes another render
		setOutcome(prev => prev && prev.of === next.of && prev.blocks === next.blocks && prev.starts === next.starts && prev.unsupported.join() === next.unsupported.join() ? prev : next)
	}
	const current = outcome && outcome.of === decorator ? outcome : undefined
	const chunks = TERRAIN_CHUNKS * TERRAIN_CHUNKS
	const problem = error ? { title: 'Cannot show the terrain', text: error }
		: dataError ? { title: 'The block tags of the game could not be loaded', text: dataError } : undefined

	return <div class="gx-editor">
		<div class="gx-work gx-work-form">
			<div class="gx-stage gx-form">
				<Lockable locked={!editable}>
					<TreeEditor generator={generator} version={version.id} name={documentName(id)} value={json} onChange={onChange} blockTag={data?.blockTag} />
				</Lockable>
			</div>
			<aside class="gx-side gx-side-wide" aria-label="Preview">
				<div class="gx-side-head">
					<span class="gx-dot gx-dot-lg" style={{ background: 'var(--gx-cat-shape)' }} />
					<div class="gx-side-title">
						<h2>Carved terrain</h2>
						<p>What {id} cuts out of {TERRAIN_CHUNKS} by {TERRAIN_CHUNKS} chunks of the dimension</p>
					</div>
					<IconButton icon={Ico.dice} label="Carve again at random" tipSide="left" onClick={() => setSeed(randomSeed())} />
					<IconButton icon={Ico.target} label="Reset the view" tipSide="left" onClick={() => viewport.current?.reset()} />
				</div>
				<div class="gx-diorama-frame">
					<Diorama slice={data ? slice : undefined} revision={revision} version={version.id} label={`The terrain of the dimension with what ${id} cut out of it, in 3D`} dark={dark}
						memo={cameraOf(memory, 'carver')} highlight={highlight} loading="Loading world generation…" message={problem} onDone={onDone} apiRef={viewport} />
				</div>
				<Section title="View">
					<div class="gx-fields">
						<Field label="Highlight" hint="Outlines what was cut away where the terrain hides it">
							{fieldId => <div class="gx-switch-row">
								<Switch id={fieldId} label="Highlight what the carver cut away" checked={highlight} onChange={setHighlight} />
								<span class="gx-muted">{highlight ? 'Caves show through the ground' : 'Off'}</span>
							</div>}
						</Field>
					</div>
				</Section>
				<Section title="What was cut">
					<p class="gx-muted">{SHAPES[type] ?? 'A type of carver that the editor does not know.'}</p>
					{!current
						? <p class="gx-muted">Carving…</p>
						: <p class="gx-muted">
							{current.blocks === 0
								? `Nothing was cut out of these chunks${current.starts === 0 ? ', and the carver started in none of them' : ''}. A carver with a low probability starts in few chunks: carve again, or check that its heights are inside of the terrain and that it may replace the blocks there.`
								: `${current.blocks.toLocaleString('en')} block${current.blocks === 1 ? ' was' : 's were'} cut away. The carver started in ${current.starts} of the ${chunks} chunks, and tunnels from chunks around them reach in as well.`}
						</p>}
					{current && current.unsupported.length > 0 && <div class="gx-note" role="note">
						<strong>Not everything can be shown here</strong>
						<span>The game does this, but the editor cannot yet: {current.unsupported.map(reason => prettyId(reason)).join(', ')}.</span>
					</div>}
					<p class="gx-muted">
						The game runs carvers after the terrain is shaped and its blocks are chosen, and before features are placed.
						{used
							? ' The dimension uses this carver: it is in the list on the Dimension tab.'
							: ' A carver only does something once the dimension uses it. Add it to the list on the Dimension tab.'}
						{' '}The editor carves by itself, which follows the game closely but not block for block.
					</p>
				</Section>
				<Section title="JSON" collapsible defaultOpen={false} actions={<CopyButton getText={() => text} />}>
					<pre class="gx-json" tabIndex={0}>{text}</pre>
				</Section>
			</aside>
		</div>
	</div>
}
