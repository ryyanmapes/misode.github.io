import { Link, route } from 'preact-router'
import { useEffect, useState } from 'preact/hooks'
import { downloadPack, loadPackSource, packFiles } from './datapack.js'
import { createCustom, customTabId, deleteCustom, exampleTabId, freeId, isIdTaken, loadCustom, resolveTab, tabHref, useCustomList } from './dimensions.js'
import { Ico } from './icons.jsx'
import type { GraphVersion } from './presets.js'
import { blankDimension, fromTemplate, isValidId, loadPreset } from './presets.js'
import { IconButton, Select } from './ui.jsx'

const BLANK = 'blank'

/** How long ago something happened, in words */
function ago(time: number) {
	const minutes = Math.round((Date.now() - time) / 60000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
	const days = Math.round(hours / 24)
	if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
	return `on ${new Date(time).toLocaleDateString()}`
}

/** The last part of an id, which is what a copy is named after */
function nameOf(id: string) {
	return id.slice(id.indexOf(':') + 1).split('/').pop() ?? 'dimension'
}

/** The home tab of a version: start a dimension, come back to one of your own, or open an example */
export function HomePage({ version }: { version: GraphVersion }) {
	// Each version has an editor of its own, so only the dimensions of this version are here
	const customs = useCustomList().filter(meta => meta.version === version.id)
	const [busy, setBusy] = useState<string>()
	const [failure, setFailure] = useState<string>()
	const [confirming, setConfirming] = useState<string>()

	const download = async (name: string, what: string, list: typeof customs) => {
		setBusy(name)
		setFailure(undefined)
		try {
			const records = list.map(meta => loadCustom(meta.key)).filter(record => record !== undefined)
			await downloadPack(name, packFiles(version, what, await Promise.all(records.map(record => loadPackSource(version, record!)))))
		} catch (e) {
			setFailure(`The data pack could not be made: ${e instanceof Error ? e.message : String(e)}`)
		}
		setBusy(undefined)
	}

	// Examples of the same kind are listed together: those of the game first
	const groups = [...new Set(version.presets.map(preset => preset.group))]

	return <div class="gx-home-page">
		<div class="gx-home-inner">
			<div class="gx-home-head">
				<h1>Worldgen graph editor</h1>
				<p>Shape the terrain of a dimension as a graph, choose its blocks with a flowchart, look at the result in 3D and take it into the game as a data pack.</p>
			</div>

			<NewDimension version={version} />

			<section class="gx-home-section" aria-labelledby="gx-home-own">
				<div class="gx-home-section-head">
					<h2 id="gx-home-own">Your dimensions</h2>
					{customs.length > 0 && <button type="button" class="gx-btn gx-btn-tonal" disabled={busy !== undefined}
						onClick={() => download(`dimensions_${version.label}`, `Dimensions made with the worldgen graph editor, for Minecraft ${version.label}`, customs)}>
						{Ico.download}
						<span>Download all as a data pack</span>
					</button>}
				</div>
				{failure && <p class="gx-field-error" role="alert">{failure}</p>}
				{customs.length === 0
					? <p class="gx-home-empty">Dimensions that you create for Minecraft {version.label} are kept here, in this browser, so you can come back to them after closing their tab.</p>
					: <ul class="gx-dim-list">
						{[...customs].sort((a, b) => b.modified - a.modified).map(meta => {
							const tab = resolveTab(customTabId(meta.key))!
							return <li key={meta.key} class="gx-dim-row">
								<Link class="gx-dim-open" href={tabHref(tab)}>
									<span class="gx-dim-icon">{Ico.globe}</span>
									<span class="gx-dim-text">
										<strong>{meta.id}</strong>
										<span>Started from {meta.template} · changed {ago(meta.modified)}</span>
									</span>
								</Link>
								{confirming === meta.key
									? <div class="gx-dim-confirm" role="group" aria-label={`Delete ${meta.id}?`}>
										<span>Delete for good?</span>
										<button type="button" class="gx-btn gx-btn-danger" onClick={() => {
											deleteCustom(meta.key)
											setConfirming(undefined)
										}}>
											<span>Delete</span>
										</button>
										<button type="button" class="gx-btn gx-btn-text" onClick={() => setConfirming(undefined)}>
											<span>Keep</span>
										</button>
									</div>
									: <div class="gx-dim-actions">
										<IconButton icon={Ico.download} label={`Download ${meta.id} as a data pack`} tipSide="left" disabled={busy !== undefined}
											onClick={() => download(meta.id, `${meta.id}, made with the worldgen graph editor`, [meta])} />
										<IconButton icon={Ico.trash} label={`Delete ${meta.id}`} tipSide="left" onClick={() => setConfirming(meta.key)} />
									</div>}
							</li>
						})}
					</ul>}
			</section>

			<section class="gx-home-section" aria-labelledby="gx-home-examples">
				<div class="gx-home-section-head">
					<h2 id="gx-home-examples">Examples</h2>
				</div>
				<p class="gx-muted">Examples cannot be changed. Look around in them, copy nodes out of them, or pick one as the template of a new dimension.</p>
				{groups.map(group => <div key={group} class="gx-example-group">
					<h3>{group === 'Vanilla' ? 'Dimensions of the game' : `${group} data pack`}</h3>
					<ul class="gx-example-grid">
						{version.presets.filter(preset => preset.group === group).map(preset => {
							const tab = resolveTab(exampleTabId(version, preset))!
							return <li key={preset.id}>
								<Link class="gx-example" href={tabHref(tab)}>
									<span class="gx-example-lock" title="Read-only">{Ico.lock}</span>
									<strong>{preset.label}</strong>
									<span class="gx-mono">{preset.dimensionId}</span>
									<span>{preset.group === 'Vanilla' ? 'Vanilla' : `${preset.group} data pack`}</span>
								</Link>
							</li>
						})}
					</ul>
				</div>)}
			</section>
		</div>
	</div>
}

/** Where a new dimension gets what it starts from and its id */
function NewDimension({ version }: { version: GraphVersion }) {
	const customs = useCustomList()
	const [template, setTemplate] = useState(BLANK)
	const [typed, setTyped] = useState<string>()
	const [creating, setCreating] = useState(false)
	const [failure, setFailure] = useState<string>()

	const own = customs.filter(meta => meta.version === version.id)
	const options = [
		{ value: BLANK, label: 'Blank' },
		...version.presets.map(preset => ({ value: exampleTabId(version, preset), label: preset.label, group: `${preset.group} examples` })),
		...own.map(meta => ({ value: customTabId(meta.key), label: meta.id, group: 'Your dimensions' })),
	]
	// A template of another version is not offered, so the choice falls back to a blank dimension
	const chosen = options.some(option => option.value === template) ? template : BLANK
	useEffect(() => {
		if (chosen !== template) setTemplate(chosen)
	}, [chosen, template])

	const source = chosen === BLANK ? undefined : resolveTab(chosen)
	const suggested = freeId(version.id, `custom:${source?.kind === 'example' ? nameOf(source.preset.dimensionId) : source?.kind === 'custom' ? nameOf(source.meta.id) : 'dimension'}`)
	const id = (typed ?? suggested).trim()
	const problem = !isValidId(id) ? 'An id is a namespace and a name with a colon in between, in lowercase letters, digits and underscores. For example custom:floating_islands'
		: isIdTaken(version.id, id) ? `You already have a dimension ${id} for Minecraft ${version.label}. Two dimensions with the same id cannot be in one data pack.`
			: undefined

	const create = async () => {
		if (problem || creating) return
		setCreating(true)
		setFailure(undefined)
		try {
			let record
			if (source?.kind === 'example') {
				record = createCustom(version, source.preset.label, fromTemplate(await loadPreset(version, source.preset), version.format, id))
			} else if (source?.kind === 'custom') {
				const original = loadCustom(source.meta.key)
				if (!original) throw new Error(`${source.meta.id} could not be read`)
				// A copy of your own dimension keeps its graphs as they are laid out
				record = createCustom(version, original.id, fromTemplate(original, version.format, id))
			} else {
				record = createCustom(version, 'Blank', blankDimension(version.format, id))
			}
			setTyped(undefined)
			route(tabHref(resolveTab(customTabId(record.key))!, 'dimension'))
		} catch (e) {
			setFailure(`The dimension could not be created: ${e instanceof Error ? e.message : String(e)}`)
			setCreating(false)
		}
	}

	return <section class="gx-home-section gx-card" aria-labelledby="gx-home-new">
		<h2 id="gx-home-new">New dimension</h2>
		<form class="gx-new" onSubmit={e => {
			e.preventDefault()
			create()
		}}>
			<label class="gx-new-field gx-new-template">
				<span>Template</span>
				<Select label="What the new dimension starts from" value={chosen} onChange={setTemplate} options={options} />
			</label>
			<label class="gx-new-field gx-new-id">
				<span>Dimension ID</span>
				<input class={`gx-input gx-mono${typed !== undefined && problem ? ' is-invalid' : ''}`} type="text" autocomplete="off" spellcheck={false}
					aria-label="Id of the new dimension" aria-invalid={problem !== undefined} value={typed ?? suggested}
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
					? `A dimension for Minecraft ${version.label}, in which the final density, the rule and the biome start empty. The id is what the game calls the dimension, and where its files go in the data pack.`
					: `A dimension for Minecraft ${version.label} that starts as a copy that you can change. The id is what the game calls the dimension, and where its files go in the data pack.`}</p>}
	</section>
}
