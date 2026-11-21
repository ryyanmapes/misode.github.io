import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { ItemKind, TabRef } from './dimensions.js'
import { customTabId, exampleTabId, loadCustom, MAIN, resolveTab, useCustomList } from './dimensions.js'
import { Ico } from './icons.jsx'
import type { ItemSource, Own } from './items.js'
import { blankItem, copyId, countOwn, fetchVanillaItem, freeItemId, fullId, mainImportId, ownField, planImport, sourceOf } from './items.js'
import type { GraphVersion } from './presets.js'
import { isValidId, loadedPreset, loadPreset } from './presets.js'
import { IconButton, prettyId, Select } from './ui.jsx'

const BLANK = 'blank'
const OWN_PREFIX = 'own:'
const VANILLA_PREFIX = 'vanilla:'
const NONE = ''

/** From how many rows on a list can be searched */
const FILTER_FROM = 9

/** The last part of an id, which is what a copy is named after */
function nameOf(id: string) {
	return id.slice(id.indexOf(':') + 1).split('/').pop() ?? ''
}

/** The ids that have every word of what was typed in them */
function matching<T>(rows: T[], idOf: (row: T) => string, query: string): T[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	return words.length === 0 ? rows : rows.filter(row => words.every(word => idOf(row).toLowerCase().includes(word)))
}

/** A field to search a long list with */
function Filter({ label, value, shown, total, onChange }: { label: string, value: string, shown: number, total: number, onChange: (value: string) => void }) {
	return <div class="gx-filter">
		{Ico.search}
		<input class="gx-input" type="text" autocomplete="off" spellcheck={false} aria-label={label} placeholder={label} value={value}
			onInput={e => onChange((e.target as HTMLInputElement).value)} />
		<span class="gx-filter-count" role="status">{value.trim() === '' ? total : `${shown} of ${total}`}</span>
	</div>
}

export interface ItemsHomeProps {
	kind: ItemKind
	version: GraphVersion
	/** The dimension that is open */
	tab: TabRef
	dimensionId: string
	title: string
	intro: string
	/** What one of these is called in a sentence, for example "density function" */
	noun: string
	/** What the list says below each one: what it is used for */
	caption: string
	/** The name that a new one is given when it does not start from anything */
	base: string
	icon: ComponentChildren
	/** The one that every dimension has and that cannot be deleted */
	main?: { label: string, caption: string }
	/** The ids of the ones that the dimension has besides that */
	items: string[]
	/** Whether the dimension is one of your own, which can be changed */
	editable: boolean
	/** Whether the dimension is one of the game, which lists what it uses of the game */
	fromGame: boolean
	/** Everything with an id that the dimension has, as it is now */
	here: Own
	/** What the main one is now, to start something new from */
	mainJson: unknown
	/** The ids that the game has, which something new can start from and cannot be called */
	vanilla: string[]
	onOpen: (id: string) => void
	onCreate: (id: string, json: unknown) => void
	onDelete: (id: string) => void
	/** Adds what was planned to bring over from another dimension, and opens the thing with this id */
	onImport: (add: Own, id: string) => void
}
/** The home tab of a view: what the dimension has of it, and ways to add more */
export function ItemsHome(props: ItemsHomeProps) {
	const { title, intro, noun, caption, icon, main, items, editable, fromGame, onOpen, onDelete } = props
	const [confirming, setConfirming] = useState<string>()
	const [query, setQuery] = useState('')
	const shown = matching(items, id => id, query)

	return <div class="gx-editor gx-page">
		<div class="gx-page-inner">
			<div class="gx-items-head">
				<h2>{title}</h2>
				<p>{intro}</p>
				{fromGame && items.length > 0 && <p>
					These are the {items.length === 1 ? `${noun} of the game that this dimension uses` : `${items.length} ${noun}s of the game that this dimension uses`},
					found by following what its noise settings and its biomes refer to.
				</p>}
			</div>

			{items.length >= FILTER_FROM && <Filter label={`Search these ${noun}s`} value={query} shown={shown.length} total={items.length} onChange={setQuery} />}
			{main || items.length > 0
				? <ul class="gx-dim-list" aria-label={`${title} of this dimension`}>
					{main && <li class="gx-dim-row">
						<button type="button" class="gx-dim-open gx-item-open" onClick={() => onOpen(MAIN)}>
							<span class="gx-dim-icon">{Ico.pin}</span>
							<span class="gx-dim-text">
								<strong class="gx-item-main">{main.label}</strong>
								<span>{main.caption}</span>
							</span>
						</button>
						<span class="gx-item-note" title={'Every dimension has one, so it cannot be deleted'}>{Ico.lock}<span>Always there</span></span>
					</li>}
					{shown.map(id => <li key={id} class="gx-dim-row">
						<button type="button" class="gx-dim-open gx-item-open" onClick={() => onOpen(id)}>
							<span class="gx-dim-icon gx-item-icon">{icon}</span>
							<span class="gx-dim-text">
								<strong>{id}</strong>
								<span>{caption}</span>
							</span>
						</button>
						{editable && (confirming === id
							? <div class="gx-dim-confirm" role="group" aria-label={`Delete ${id}?`}>
								<span>Delete for good?</span>
								<button type="button" class="gx-btn gx-btn-danger" onClick={() => {
									onDelete(id)
									setConfirming(undefined)
								}}>
									<span>Delete</span>
								</button>
								<button type="button" class="gx-btn gx-btn-text" onClick={() => setConfirming(undefined)}>
									<span>Keep</span>
								</button>
							</div>
							: <div class="gx-dim-actions">
								<IconButton icon={Ico.trash} label={`Delete ${id}`} tipSide="left" onClick={() => setConfirming(id)} />
							</div>)}
					</li>)}
				</ul>
				: <p class="gx-home-empty">{editable
					? `This dimension has no ${noun}s of its own yet. It can use the ones of the game, or you can add one below.`
					: fromGame ? `This dimension uses no ${noun}s of the game.`
						: `This example has no ${noun}s of its own. It uses the ones of the game.`}</p>}
			{items.length > 0 && shown.length === 0 && <p class="gx-muted" role="status">No {noun} of this dimension has “{query.trim()}” in its id.</p>}

			{editable
				? <>
					<NewItem {...props} />
					<ImportItems {...props} />
				</>
				: <p class="gx-muted">Examples cannot be changed. Make a dimension of your own on the home tab at the top to add {noun}s, or to bring these over.</p>}
		</div>
	</div>
}

/** Where something new gets its id and what it starts from */
function NewItem({ kind, version, dimensionId, noun, base: baseName, main, items, here, mainJson, vanilla, onCreate }: ItemsHomeProps) {
	const [template, setTemplate] = useState(BLANK)
	const [typed, setTyped] = useState<string>()
	const [creating, setCreating] = useState(false)
	const [failure, setFailure] = useState<string>()
	const field = ownField(kind)

	const options = [
		{ value: BLANK, label: 'Blank' },
		...(main ? [{ value: OWN_PREFIX + MAIN, label: main.label, group: 'This dimension' }] : []),
		...items.map(id => ({ value: OWN_PREFIX + id, label: id, group: 'This dimension' })),
		...[...vanilla].sort().map(id => ({ value: VANILLA_PREFIX + id, label: prettyId(id), group: 'Minecraft' })),
	]
	// What was chosen can be deleted in the meantime
	const chosen = options.some(option => option.value === template) ? template : BLANK
	useEffect(() => {
		if (chosen !== template) setTemplate(chosen)
	}, [chosen, template])

	const taken = (id: string) => id in here[field] || vanilla.includes(id)
	const namespace = dimensionId.slice(0, dimensionId.indexOf(':'))
	const base = chosen.startsWith(VANILLA_PREFIX) ? nameOf(chosen.slice(VANILLA_PREFIX.length))
		: chosen.startsWith(OWN_PREFIX) && chosen !== OWN_PREFIX + MAIN ? nameOf(chosen.slice(OWN_PREFIX.length))
			: baseName
	const suggested = freeItemId(`${namespace === 'minecraft' ? 'custom' : namespace}:${base}`, taken)
	const id = (typed ?? suggested).trim()
	const problem = !isValidId(id) ? `An id is a namespace and a name with a colon in between, in lowercase letters, digits and underscores. For example ${namespace === 'minecraft' ? 'custom' : namespace}:${base}`
		: id in here[field] ? `This dimension already has a ${noun} ${id}.`
			: vanilla.includes(id) ? `The game already has a ${noun} ${id}. Yours would replace it for every dimension, so pick another id.`
				: undefined

	const create = async () => {
		if (problem || creating) return
		setCreating(true)
		setFailure(undefined)
		try {
			const json = chosen === BLANK ? blankItem(kind, version.format)
				: chosen.startsWith(VANILLA_PREFIX) ? await fetchVanillaItem(version.id, version.format, kind, chosen.slice(VANILLA_PREFIX.length))
					: structuredClone(chosen === OWN_PREFIX + MAIN ? mainJson : here[field][chosen.slice(OWN_PREFIX.length)])
			setTyped(undefined)
			onCreate(id, json)
		} catch (e) {
			setFailure(`The ${noun} could not be created: ${e instanceof Error ? e.message : String(e)}`)
		}
		setCreating(false)
	}

	return <section class="gx-card" aria-label={`New ${noun}`}>
		<h3>New {noun}</h3>
		<form class="gx-new" onSubmit={e => {
			e.preventDefault()
			create()
		}}>
			<label class="gx-new-field gx-new-template">
				<span>Template</span>
				<Select label={`What the new ${noun} starts from`} value={chosen} onChange={setTemplate} options={options} />
			</label>
			<label class="gx-new-field gx-new-id">
				<span>ID</span>
				<input class={`gx-input gx-mono${typed !== undefined && problem ? ' is-invalid' : ''}`} type="text" autocomplete="off" spellcheck={false}
					aria-label={`Id of the new ${noun}`} aria-invalid={problem !== undefined} value={typed ?? suggested}
					onInput={e => setTyped((e.target as HTMLInputElement).value)} />
			</label>
			<button type="submit" class="gx-btn gx-btn-filled" disabled={problem !== undefined || creating}>
				{Ico.plus}
				<span>Create</span>
			</button>
		</form>
		{failure
			? <p class="gx-field-error" role="alert">{failure}</p>
			: problem
				? <p class="gx-field-error" role="alert">{problem}</p>
				: <p class="gx-muted">{chosen === BLANK
					? `The id is how the ${noun} is referred to, and where its file goes in the data pack.`
					: `The new ${noun} starts as a copy that you can change. The id is how it is referred to, and where its file goes in the data pack.`}</p>}
	</section>
}

/** Brings things over from the other dimensions of the same version */
function ImportItems({ kind, version, tab, dimensionId, noun, main, here, onImport }: ItemsHomeProps) {
	const customs = useCustomList()
	const [chosen, setChosen] = useState(NONE)
	const [source, setSource] = useState<{ of: string, value?: ItemSource, error?: string }>({ of: NONE })
	const [query, setQuery] = useState('')
	const field = ownField(kind)
	const namespace = dimensionId.slice(0, dimensionId.indexOf(':'))

	const options = [
		{ value: NONE, label: 'Choose a dimension…' },
		...version.presets.map(preset => ({ value: exampleTabId(version, preset), label: preset.label, group: `${preset.group} examples` })),
		...customs.filter(meta => meta.version === version.id).map(meta => ({ value: customTabId(meta.key), label: meta.id, group: 'Your dimensions' })),
	].filter(option => option.value !== tab.id)
	const current = options.some(option => option.value === chosen) ? chosen : NONE

	useEffect(() => {
		if (current === NONE) return
		const other = resolveTab(current)
		let cancelled = false
		// Keeping the same state when nothing changed means this never causes another render
		const done = (next: { of: string, value?: ItemSource, error?: string }) => {
			if (!cancelled) setSource(prev => prev.of === next.of && prev.value !== undefined && next.error === undefined ? prev : next)
		}
		if (other?.kind === 'custom') {
			const record = loadCustom(other.meta.key)
			done(record ? { of: current, value: sourceOf(record, version.format) } : { of: current, error: `${other.meta.id} could not be read` })
		} else if (other?.kind === 'example') {
			const ready = loadedPreset(version, other.preset)
			if (ready) {
				done({ of: current, value: sourceOf(ready, version.format) })
			} else {
				loadPreset(version, other.preset).then(
					data => done({ of: current, value: sourceOf(data, version.format) }),
					e => done({ of: current, error: e instanceof Error ? e.message : String(e) }))
			}
		}
		return () => {
			cancelled = true
		}
	}, [current, version])

	const loaded = source.of === current ? source : undefined
	const other = loaded?.value
	const rows = other ? [
		...(main ? [{ item: MAIN, label: `${main.label} of ${other.id}`, as: mainImportId(other.id, kind) }] : []),
		// Something of the game comes over as a copy under an id of this dimension, since its own id stays the game's
		...Object.keys(other.own[field]).map(id => ({ item: id, label: id, as: other.fromGame ? copyId(id, namespace) : id })),
	] : []
	const shown = matching(rows, row => row.label, query)

	return <section class="gx-card" aria-label={`Import ${noun}s`}>
		<h3>Import from another dimension</h3>
		<label class="gx-new-field gx-import-from">
			<span>Dimension for Minecraft {version.label}</span>
			<Select label={`The dimension to bring ${noun}s over from`} value={current} onChange={setChosen} options={options} />
		</label>
		{options.length === 1 && <p class="gx-muted">There is no other dimension for Minecraft {version.label} yet.</p>}
		{current !== NONE && !loaded && <p class="gx-muted" role="status">Loading…</p>}
		{loaded?.error && <p class="gx-field-error" role="alert">{loaded.error}</p>}
		{other && rows.length === 0 && <p class="gx-muted">{other.id} has no {noun}s of its own.</p>}
		{other && rows.length >= FILTER_FROM && <Filter label={`Search the ${noun}s of ${other.id}`} value={query} shown={shown.length} total={rows.length} onChange={setQuery} />}
		{other && rows.length > 0 && <ul class="gx-import-list">
			{shown.map(row => {
				const present = row.item !== MAIN && !other.fromGame && fullId(row.item) in here[field]
				const plan = present ? undefined : planImport(other, kind, row.item, here, namespace)
				const extra = plan ? countOwn(plan.add) - 1 : 0
				return <li key={row.item}>
					<span class="gx-import-text">
						<strong class={row.item === MAIN ? 'gx-item-main' : 'gx-mono'}>{row.label}</strong>
						<span class="gx-muted">
							{present ? 'This dimension already has one with this id'
								: `${plan!.id !== row.item ? `Becomes ${plan!.id}` : 'Keeps its id'}${extra > 0 ? `, and brings ${extra} thing${extra === 1 ? '' : 's'} that it refers to` : ''}`}
						</span>
					</span>
					<button type="button" class="gx-btn gx-btn-tonal" disabled={!plan} onClick={() => plan && onImport(plan.add, plan.id)}>
						{Ico.download}
						<span>{present ? 'Already here' : 'Import'}</span>
					</button>
				</li>
			})}
		</ul>}
		<p class="gx-muted">What you import is a copy. Changing it here does not change the dimension that it came from{other?.fromGame ? ', or the game. What a copy refers to stays in the game' : ''}.</p>
	</section>
}
