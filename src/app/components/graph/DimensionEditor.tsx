import { useMemo, useRef, useState } from 'preact/hooks'
import { randomSeed } from '../../Utils.js'
import type { CustomDimension } from './dimensions.js'
import { isIdTaken, updateCustom } from './dimensions.js'
import type { FeatureData } from './features/index.js'
import { documentName } from './FeatureEditor.jsx'
import { Ico } from './icons.jsx'
import { fullId } from './items.js'
import { blockLabel, ruleName } from './material/schema.js'
import type { DimensionData, GraphVersion } from './presets.js'
import { biomeOf, isValidId, withDimensionId } from './presets.js'
import { useSessionState } from './session.js'
import { SortableList } from './SortableList.jsx'
import { TreeEditor } from './TreeEditor.jsx'
import { Field, IconButton, IdSelect, Lockable, NumberField, prettyId, Section, Select } from './ui.jsx'
import type { ViewportApi } from './Viewport2D.jsx'
import { carveSettingsOf } from './view/carve.js'
import { Diorama } from './view/Diorama.jsx'
import type { TerrainInput, TerrainMemory } from './view/terrain.js'
import { cameraOf, placeText, TERRAIN_CHUNKS, useDecoratedTerrain } from './view/terrain.js'

/** The game only accepts heights in whole chunk sections, between these limits */
const SECTION = 16
const LOWEST = -2032
const HIGHEST = 2032

const WATER = 'minecraft:water'
const LAVA = 'minecraft:lava'
/** Below this height the game fills open space with lava, whatever the fluid of the dimension is */
const LAVA_BELOW = -54

/** What of a biome the lists of the dimension stand for, which the form of the biome leaves out */
const BIOME_LISTS = ['carvers', 'features']

/** What is selected in the lists of the dimension, which is what shows through the terrain in the preview */
interface Selection {
	kind: 'carver' | 'placer'
	id: string
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value))
}

function toSection(value: number) {
	return Math.round(value / SECTION) * SECTION
}

/** A lowest height and a height that the game accepts, after one of them was changed */
function fitRange(minY: number, height: number) {
	const min = clamp(toSection(minY), LOWEST, HIGHEST - SECTION)
	return { min, height: clamp(toSection(height), SECTION, HIGHEST - min) }
}

interface Props {
	version: GraphVersion
	data: DimensionData
	/** The dimension when it is one of your own, which is the only kind that can be changed */
	custom?: CustomDimension
	/** The ids of the placed features that exist: those of the dimension first, then those of the game */
	placerIds: string[]
	/** The ids of the carvers that exist: those of the dimension first, then those of the game */
	carverIds: string[]
	/** What features can refer to, once the features of the game are downloaded */
	features: FeatureData | undefined
	featuresError: string | undefined
	terrain: TerrainInput
	memory: TerrainMemory
	dark: boolean
	/** Gives the world another seed, which makes other terrain */
	onNewSeed: () => void
}
/** The basic facts of a dimension: what it is called, how high it is, and its biome with the carvers and placed features of that */
export function DimensionEditor({ version, data, custom, placerIds, carverIds, features, featuresError, terrain: terrainInput, memory, dark, onNewSeed }: Props) {
	const editable = custom !== undefined
	const [seed, setSeed] = useSessionState('placer.seed', BigInt(1))
	// The carver or placed feature of the lists that is selected, which is the one that shows through the ground
	const [selection, setSelection] = useState<Selection>()
	const select = (kind: Selection['kind'], id: string) => setSelection(prev => prev?.kind === kind && prev.id === id ? undefined : { kind, id })
	const [adding, setAdding] = useState('')
	const [placed, setPlaced] = useState<{ of: unknown, tries: number[], blocks: number[], carved: number[], starts: number[], unsupported: string[] }>()
	const viewport = useRef<ViewportApi>()
	const { decoration, carving } = data
	const biome = biomeOf(data)
	const { slice, error, decorator, revision } = useDecoratedTerrain(terrainInput, memory, decoration, features, seed, carving)
	const known = useMemo(() => new Set(placerIds.map(fullId)), [placerIds])
	const candidates = useMemo(() => placerIds.filter(id => !decoration.includes(fullId(id))), [placerIds, decoration])
	const next = candidates.includes(adding) ? adding : candidates[0] ?? ''

	const setDecoration = (list: string[]) => {
		if (custom) updateCustom(custom.key, { decoration: list })
	}

	const [addingCarver, setAddingCarver] = useState('')
	const knownCarvers = useMemo(() => new Set(carverIds.map(fullId)), [carverIds])
	const carverCandidates = useMemo(() => carverIds.filter(id => !carving.includes(fullId(id))), [carverIds, carving])
	const nextCarver = carverCandidates.includes(addingCarver) ? addingCarver : carverCandidates[0] ?? ''
	const setCarving = (list: string[]) => {
		if (custom) updateCustom(custom.key, { carving: list })
	}
	const onDone = () => {
		if (!decorator) return
		// A try is a position that the placement gave. The feature can still fail there, for example for lack of room.
		const tries = decoration.map(() => 0)
		for (const position of decorator.positions) tries[position.placer] += 1
		const result = {
			of: decorator,
			tries,
			blocks: [...decorator.blocksBy],
			carved: [...decorator.carving?.blocksBy ?? []],
			starts: [...decorator.carving?.startsBy ?? []],
			unsupported: [...new Set([...decorator.unsupported, ...decorator.carving?.unsupported ?? []])].sort(),
		}
		// Keeping the same state when nothing changed means this never causes another render
		setPlaced(prev => prev && prev.of === result.of && prev.tries.join() === result.tries.join() && prev.blocks.join() === result.blocks.join()
			&& prev.carved.join() === result.carved.join() && prev.starts.join() === result.starts.join() && prev.unsupported.join() === result.unsupported.join() ? prev : result)
	}
	const selectedIndex = selection?.kind === 'placer' ? decoration.indexOf(selection.id) : -1
	const selectedCarver = selection?.kind === 'carver' ? carving.indexOf(selection.id) : -1
	// The blocks remember what changed them: the carvers are the first parts, the placed features come after them
	const highlight = selectedCarver >= 0 ? selectedCarver + 1 : selectedIndex >= 0 ? carving.length + selectedIndex + 1 : false
	/** The heights at which a placed feature was tried, which tells when it aims outside of the world or the terrain */
	const triedAt = (index: number) => {
		if (!decorator || !counted) return ''
		let low = Infinity
		let high = -Infinity
		for (const position of decorator.positions) {
			if (position.placer !== index) continue
			low = Math.min(low, position.y)
			high = Math.max(high, position.y)
		}
		if (low > high) return ''
		const bottom = Number(data.dimensionType?.min_y ?? 0)
		const top = bottom + Number(data.dimensionType?.height ?? 256) - 1
		const outside = low > top || high < bottom ? ' That is outside of the world, so nothing can be placed.' : ''
		return ` Its tries were ${low === high ? `at Y ${low}` : `between Y ${low} and Y ${high}`}; blocks can exist from Y ${bottom} to Y ${top}.${outside}`
	}
	const outcomeOf = (index: number) => {
		if (!counted) return ''
		const tries = counted.tries[index]
		const blocks = counted.blocks[index]
		if (tries === 0) return ' · no tries in these chunks'
		const times = `${tries.toLocaleString('en')} ${tries === 1 ? 'try' : 'tries'}`
		return blocks === 0 ? ` · placed nothing in ${times}` : ` · placed ${blocks.toLocaleString('en')} block${blocks === 1 ? '' : 's'} in ${times}`
	}
	/** What a carver cut out of the chunks of the preview */
	const carvedBy = (index: number) => {
		if (!counted || counted.carved.length <= index) return ''
		const blocks = counted.carved[index]
		const starts = counted.starts[index]
		const where = starts === 0 ? 'started in none of these chunks' : `started in ${starts} of these ${TERRAIN_CHUNKS * TERRAIN_CHUNKS} chunks`
		return blocks === 0 ? ` · cut nothing here, ${where}` : ` · cut ${blocks.toLocaleString('en')} block${blocks === 1 ? '' : 's'}, ${where}`
	}
	const counted = placed && placed.of === decorator ? placed : undefined
	const previewProblem = error ? { title: 'Cannot show the terrain', text: error }
		: featuresError ? { title: 'The features of the game could not be loaded', text: featuresError } : undefined
	const [typed, setTyped] = useState<string>()
	const [problem, setProblem] = useState<string>()
	const rule = ruleName(version.format)

	const world = { min: Number(data.dimensionType?.min_y ?? 0), height: Number(data.dimensionType?.height ?? 256) }
	const terrain = { min: Number(data.settings?.noise?.min_y ?? 0), height: Number(data.settings?.noise?.height ?? 256) }
	const cut = terrain.min < world.min || terrain.min + terrain.height > world.min + world.height

	const rename = (text: string) => {
		setTyped(text)
		if (!custom) return
		const id = text.trim()
		if (id === custom.id) {
			setProblem(undefined)
		} else if (!isValidId(id)) {
			setProblem('An id is a namespace and a name with a colon in between, in lowercase letters, digits and underscores. For example custom:floating_islands')
		} else if (isIdTaken(custom.version, id, custom.key)) {
			setProblem(`You already have a dimension ${id} for Minecraft ${version.label}.`)
		} else {
			setProblem(undefined)
			updateCustom(custom.key, withDimensionId(custom, version.format, id))
		}
	}

	const setWorld = (minY: number, height: number) => {
		if (!custom) return
		const next = fitRange(minY, height)
		const type = custom.dimensionType ?? {}
		// Where portals and chorus fruit can take players follows the height, unless the template had it lower
		const logical = Number(type.logical_height ?? world.height)
		updateCustom(custom.key, {
			dimensionType: { ...type, min_y: next.min, height: next.height, logical_height: logical >= world.height ? next.height : Math.min(logical, next.height) },
		})
	}

	const setTerrain = (minY: number, height: number) => {
		if (!custom) return
		const next = fitRange(minY, height)
		updateCustom(custom.key, { settings: { ...custom.settings, noise: { ...custom.settings?.noise, min_y: next.min, height: next.height } } })
	}

	const sea = carveSettingsOf(data.settings)
	const fluidLabel = blockLabel(sea.defaultFluid).toLowerCase()
	const open = `Where the final density leaves the terrain open below Y ${sea.seaLevel}, there is`
	// The game has lava below a fixed height, or below the sea when that is lower still
	const seaText = sea.seaLevel <= terrain.min ? 'The sea level is not above the bottom of the terrain, so this dimension has no sea.'
		: sea.defaultFluid === LAVA || terrain.min >= Math.min(LAVA_BELOW, sea.seaLevel) ? `${open} ${fluidLabel}.`
			: sea.seaLevel <= LAVA_BELOW ? `${open} lava and not ${fluidLabel}: the game puts lava in what is open below Y ${LAVA_BELOW}, whatever the fluid is.`
				: `${open} ${fluidLabel}, and below Y ${LAVA_BELOW} lava: the game puts lava there whatever the fluid is. To have none of it, start the terrain at Y ${Math.ceil(LAVA_BELOW / SECTION) * SECTION} or higher, or put the sea level at the bottom of the terrain.`
	const fluids = [{ value: WATER, label: 'Water' }, { value: LAVA, label: 'Lava' }]
	if (sea.defaultFluid !== WATER && sea.defaultFluid !== LAVA) fluids.push({ value: sea.defaultFluid, label: prettyId(sea.defaultFluid) })

	const setSea = (level: number, fluid: string) => {
		if (!custom) return
		const settings = { ...custom.settings, sea_level: clamp(Math.round(level), LOWEST, HIGHEST) }
		if (fluid !== sea.defaultFluid) {
			// The fluid is written the way that it was: by its id alone, or as a block state in the spelling of the version
			const state = custom.settings?.default_fluid
			const modern = version.format === 'modern'
			const lower = typeof state === 'object' && state !== null ? 'id' in state : modern
			settings.default_fluid = typeof state === 'string' || (state === undefined && modern) ? fluid
				: lower ? { id: fluid, properties: { level: '0' } } : { Name: fluid, Properties: { level: '0' } }
		}
		updateCustom(custom.key, { settings })
	}

	return <div class="gx-editor">
		<div class="gx-work gx-work-form">
			<div class="gx-stage gx-form gx-form-page">
				<div class="gx-page-inner">
					<div class="gx-page-head">
						<span class="gx-page-icon">{editable ? Ico.globe : Ico.lock}</span>
						<div>
							<h2>{data.id}</h2>
							<p>{editable
								? `Your dimension for Minecraft ${version.label}, started from ${custom.template}`
								: `${data.fromGame ? 'A dimension of the game' : 'An example'} for Minecraft ${version.label}. It cannot be changed, but it can be the template of a new dimension on the home tab.`}</p>
						</div>
					</div>
					<Lockable locked={!editable}>
						<section class="gx-card">
							<h3>Identity</h3>
							<div class="gx-fields">
								<Field label="ID" hint="What the game calls the dimension, and where its files go in the data pack">
									{id => <input id={id} class={`gx-input gx-mono${problem ? ' is-invalid' : ''}`} type="text" autocomplete="off" spellcheck={false}
										aria-invalid={problem !== undefined} value={typed ?? data.id}
										onInput={e => rename((e.target as HTMLInputElement).value)}
										onBlur={() => {
											// What was typed and not accepted goes back to the id that the dimension has
											setTyped(undefined)
											setProblem(undefined)
										}}
										onKeyDown={e => {
											if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
										}} />}
								</Field>
								<Field label="Version">
									{id => <output id={id} class="gx-static">Minecraft {version.label}</output>}
								</Field>
							</div>
							{problem
								? <p class="gx-field-error" role="alert">{problem}</p>
								: <p class="gx-muted">{editable
									? 'The dimension type, the noise settings, the rule and the biome are stored under the same id.'
									: 'The id of this example in its data pack.'}</p>}
						</section>

						<section class="gx-card">
							<h3>World height</h3>
							<div class="gx-fields">
								<Field label="Lowest Y" hint="The lowest height at which blocks can exist, in steps of 16">
									{id => <NumberField id={id} label="Lowest height at which blocks can exist" int step={SECTION} value={world.min} onChange={v => setWorld(v, world.height)} />}
								</Field>
								<Field label="Height" hint="How many blocks high the world is, in steps of 16">
									{id => <NumberField id={id} label="Height of the world in blocks" int step={SECTION} value={world.height} onChange={v => setWorld(world.min, v)} />}
								</Field>
							</div>
							<p class="gx-muted">Blocks can exist from Y {world.min} up to Y {world.min + world.height - 1}. This is part of the dimension type.</p>
						</section>

						<section class="gx-card">
							<h3>Terrain height</h3>
							<div class="gx-fields">
								<Field label="Lowest Y" hint="The lowest height at which the final density shapes terrain, in steps of 16">
									{id => <NumberField id={id} label="Lowest height of the terrain" int step={SECTION} value={terrain.min} onChange={v => setTerrain(v, terrain.height)} />}
								</Field>
								<Field label="Height" hint="How many blocks high the terrain can be, in steps of 16">
									{id => <NumberField id={id} label="Height of the terrain in blocks" int step={SECTION} value={terrain.height} onChange={v => setTerrain(terrain.min, v)} />}
								</Field>
							</div>
							<p class="gx-muted">
						The final density and the {rule} make terrain from Y {terrain.min} up to Y {terrain.min + terrain.height - 1}. This is part of the noise settings.
								{cut && ' The part of it outside of the world height is cut off by the game.'}
							</p>
						</section>

						<section class="gx-card">
							<h3>Sea</h3>
							<div class="gx-fields">
								<Field label="Fluid" hint="What fills the open space below the sea level">
									{id => <Select id={id} label="Fluid of the sea" value={sea.defaultFluid} options={fluids} onChange={v => setSea(sea.seaLevel, v)} />}
								</Field>
								<Field label="Sea level" hint="The height of the surface of the sea. At or below the lowest Y of the terrain there is no sea.">
									{id => <NumberField id={id} label="Sea level" int value={sea.seaLevel} onChange={v => setSea(v, sea.defaultFluid)} />}
								</Field>
							</div>
							<p class="gx-muted">
								{seaText}
								{sea.aquifers && ' This dimension has aquifers, which decide for every cave below the surface how high its water or lava stands.'}
								{' '}This is part of the noise settings.
							</p>
						</section>
					</Lockable>

					<section class="gx-card">
						<h3>Carvers</h3>
						{carving.length === 0
							? <p class="gx-home-empty">{editable
								? 'No caves or canyons are cut out of the terrain yet. Make a carver on the Carvers tab, or pick one of the game below, and add it here.'
								: `This ${data.fromGame ? 'dimension' : 'example'} has no carvers.`}</p>
							: <SortableList items={carving} keyOf={id => id} nameOf={id => id} label="Carvers of the dimension, in the order in which they carve" locked={!editable}
								selected={id => selection?.kind === 'carver' && selection.id === id}
								onMove={(from, to) => {
									const list = [...carving]
									list.splice(to, 0, ...list.splice(from, 1))
									setCarving(list)
								}}
								render={(id, index) => <>
									<button type="button" class="gx-sort-select" aria-pressed={selection?.kind === 'carver' && selection.id === id} title="Select to see what it cut out of the terrain in the preview"
										onClick={() => select('carver', id)}>
										<span class="gx-sort-number">{index + 1}</span>
										<span class="gx-sort-text">
											<strong class="gx-mono">{id}</strong>
											<span class="gx-muted">
												{!knownCarvers.has(id) && carverIds.length > 0 ? 'Not found: it was deleted, or the game does not have it'
													: `${id in data.carvers && !data.fromGame ? 'A carver of this dimension' : 'A carver of the game'}${carvedBy(index)}`}
											</span>
										</span>
									</button>
									{editable && <IconButton icon={Ico.trash} label={`Remove ${id} from the dimension`} tipSide="left" onClick={() => setCarving(carving.filter(other => other !== id))} />}
								</>} />}
						{editable && <div class="gx-sort-add">
							<IdSelect label="The carver to add" value={nextCarver} options={carverCandidates} onChange={setAddingCarver} />
							<button type="button" class="gx-btn gx-btn-tonal" disabled={nextCarver === ''} onClick={() => setCarving([...carving, fullId(nextCarver)])}>
								{Ico.plus}
								<span>Add</span>
							</button>
						</div>}
						<p class="gx-muted">
							Carvers cut caves and canyons out of the terrain, in this order, before features are placed.
							Select a row to see what it cut in the preview, also behind the terrain.
							The game carves through biomes, so in the data pack the biome of the dimension lists them.
						</p>
					</section>

					<section class="gx-card">
						<h3>Placed features</h3>
						{decoration.length === 0
							? <p class="gx-home-empty">{editable
								? 'Nothing is placed on the terrain yet. Make a placer on the Placers tab, or pick one of the game below, and add it here.'
								: `This ${data.fromGame ? 'dimension' : 'example'} places no features on its terrain.`}</p>
							: <SortableList items={decoration} keyOf={id => id} nameOf={id => id} label="Placed features of the dimension, in the order in which they are placed" locked={!editable}
								selected={id => selection?.kind === 'placer' && selection.id === id}
								onMove={(from, to) => {
									const list = [...decoration]
									list.splice(to, 0, ...list.splice(from, 1))
									setDecoration(list)
								}}
								render={(id, index) => <>
									<button type="button" class="gx-sort-select" aria-pressed={selection?.kind === 'placer' && selection.id === id} title="Select to see its blocks through the ground in the preview"
										onClick={() => select('placer', id)}>
										<span class="gx-sort-number">{index + 1}</span>
										<span class="gx-sort-text">
											<strong class="gx-mono">{id}</strong>
											<span class="gx-muted">
												{!known.has(id) && placerIds.length > 0 ? 'Not found: it was deleted, or the game does not have it'
													: `${id in data.placers && !data.fromGame ? 'A placer of this dimension' : 'A placed feature of the game'}${outcomeOf(index)}`}
											</span>
										</span>
									</button>
									{editable && <IconButton icon={Ico.trash} label={`Remove ${id} from the dimension`} tipSide="left" onClick={() => setDecoration(decoration.filter(other => other !== id))} />}
								</>} />}
						{editable && <div class="gx-sort-add">
							<IdSelect label="The placed feature to add" value={next} options={candidates} onChange={setAdding} />
							<button type="button" class="gx-btn gx-btn-tonal" disabled={next === ''} onClick={() => setDecoration([...decoration, fullId(next)])}>
								{Ico.plus}
								<span>Add</span>
							</button>
						</div>}
						<p class="gx-muted">
					Features are placed chunk by chunk, in this order, so a later one can build on an earlier one. Drag the handle of a row to change the order.
					Select a row to see where its blocks are in the preview, also behind the terrain.
					The game places features through biomes, so in the data pack the biome of the dimension lists them.
						</p>
					</section>

					<section class="gx-card">
						<h3>Biome</h3>
						<p class="gx-muted">
							In the editor a dimension is one biome all over, here <span class="gx-mono">{biome.id}</span>.
							This is everything else that the biome decides: its climate, how it looks and sounds, and what lives in it. Its carvers and placed features are the two lists above.
							{data.fromGame && ' In the game this dimension has more biomes; the editor shows it as the one that covers most of it.'}
						</p>
						{biome.file === undefined
							? <p class="gx-home-empty" role="status">Loading the biome…</p>
							: <div class="gx-biome-form">
								<Lockable locked={!editable}>
									<TreeEditor generator="worldgen/biome" version={version.id} name={documentName(`${data.id}_biome`)} value={biome.file} hide={BIOME_LISTS}
										onChange={json => custom && updateCustom(custom.key, record => ({ biomeFiles: { [record.biomes[0]]: json } }))} />
								</Lockable>
							</div>}
					</section>
				</div>
			</div>
			<aside class="gx-side gx-side-wide" aria-label="Preview">
				<div class="gx-side-head">
					<span class="gx-dot gx-dot-lg" style={{ background: 'var(--gx-cat-shape)' }} />
					<div class="gx-side-title">
						<h2>Preview</h2>
						<p>{TERRAIN_CHUNKS} by {TERRAIN_CHUNKS} chunks of {data.id} around {placeText(terrainInput.chunk)}, with its carvers and placed features</p>
					</div>
					<IconButton icon={Ico.dice} label="Place the features again, on the same terrain" tipSide="left" onClick={() => setSeed(randomSeed())} />
					<IconButton icon={Ico.seed} label="New seed, at another place of the world" tipSide="left" onClick={() => {
						onNewSeed()
						setSeed(randomSeed())
					}} />
					<IconButton icon={Ico.target} label="Reset the view" tipSide="left" onClick={() => viewport.current?.reset()} />
				</div>
				<div class="gx-diorama-frame">
					<Diorama slice={features || (decoration.length === 0 && carving.length === 0) ? slice : undefined} revision={revision} version={version.id} label={`The terrain of ${data.id} with its carvers and placed features, in 3D`} dark={dark}
						memo={cameraOf(memory, 'dimension')} highlight={highlight} loading="Loading world generation…" message={previewProblem} onDone={onDone} apiRef={viewport} />
				</div>
				<Section title="Selection">
					<p class="gx-muted" aria-live="polite">{selectedCarver >= 0
						? `What ${selection?.id} cut away is outlined, also where the terrain hides it${counted ? `: it${carvedBy(selectedCarver).replace(' · ', ' ')}` : ''}.`
						: selectedIndex >= 0
							? `The blocks of ${selection?.id} show through the terrain${counted ? `: it${outcomeOf(selectedIndex).replace(' · ', ' ')}` : ''}.${triedAt(selectedIndex)}`
							: decoration.length > 0 || carving.length > 0 ? 'Select a carver or a placed feature in its list to see through the terrain what it did.' : 'The dimension has no carvers and places no features yet.'}</p>
					{counted && counted.unsupported.length > 0 && <div class="gx-note" role="note">
						<strong>Not everything can be shown here</strong>
						<span>The game generates this, but the editor cannot yet: {counted.unsupported.map(reason => prettyId(reason)).join(', ')}.</span>
					</div>}
					<p class="gx-muted">The terrain is the final density with the {rule}. The editor carves and places the features itself, which follows the game closely but not block for block.</p>
				</Section>
			</aside>
		</div>
	</div>
}
