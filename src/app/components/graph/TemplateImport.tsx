import { useState } from 'preact/hooks'
import { FileImport } from './FileImport.jsx'
import { Ico } from './icons.jsx'
import { copyId, freeItemId } from './items.js'
import type { GraphVersion } from './presets.js'
import type { TemplateMeta } from './templates.js'
import { addTemplateFile, describeTemplate, fetchVanillaTemplate, parseTemplate } from './templates.js'
import { prettyId } from './ui.jsx'

/** How many templates of the game are listed at once. There are over a thousand. */
const VANILLA_ROWS = 30

interface Props {
	version: GraphVersion
	dimensionId: string
	/** The templates that the dimension has */
	here: Record<string, TemplateMeta>
	/** The ids of the templates of the game */
	vanilla: string[]
	onCreate: (id: string, meta: TemplateMeta) => void
}

/** Adds templates to a dimension: from structure files, or as copies of the templates of the game */
export function NewTemplates(props: Props) {
	const { dimensionId, here, vanilla, onCreate } = props
	return <>
		<FileImport<Uint8Array> noun="template" heading="Import your own" extension=".nbt" choose="Choose structure files"
			hint={<>or drop them here. These are the <span class="gx-mono">.nbt</span> files that a structure block saves.</>}
			help={<>
				To make one, build something in the game, save it with a structure block, and take the file from the <span class="gx-mono">generated</span> folder of the world.
				A template keeps what is inside of its blocks, such as the command of a command block.
			</>}
			idNote="The id is how a feature refers to the template, and where its file goes in the data pack."
			dimensionId={dimensionId} here={here} vanilla={vanilla}
			read={async file => {
				const bytes = new Uint8Array(await file.arrayBuffer())
				return { value: bytes, about: describeTemplate(parseTemplate(bytes)) }
			}}
			onImport={async (id, bytes, file) => onCreate(id, await addTemplateFile(bytes, file))} />
		<CopyVanilla {...props} />
	</>
}

function CopyVanilla({ version, dimensionId, here, vanilla, onCreate }: Props) {
	const [query, setQuery] = useState('')
	const [busy, setBusy] = useState<string>()
	const [failure, setFailure] = useState<string>()
	const namespace = dimensionId.slice(0, dimensionId.indexOf(':'))

	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	const matches = words.length === 0 ? vanilla : vanilla.filter(id => words.every(word => id.includes(word)))
	const shown = matches.slice(0, VANILLA_ROWS)

	const copy = async (id: string) => {
		if (busy) return
		setBusy(id)
		setFailure(undefined)
		try {
			const meta = await addTemplateFile(await fetchVanillaTemplate(version, id), id)
			onCreate(freeItemId(copyId(id, namespace), other => other in here), meta)
		} catch (e) {
			setFailure(`${prettyId(id)} could not be copied: ${e instanceof Error ? e.message : String(e)}`)
		}
		setBusy(undefined)
	}

	return <section class="gx-card" aria-label="Copy templates of the game">
		<h3>Copy from Minecraft</h3>
		{vanilla.length === 0
			? <p class="gx-muted" role="status">Loading the templates of the game…</p>
			: <>
				<div class="gx-filter">
					{Ico.search}
					<input class="gx-input" type="text" autocomplete="off" spellcheck={false} aria-label="Search the templates of the game" placeholder="Search the templates of the game, for example igloo"
						value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} />
					<span class="gx-filter-count" role="status">{words.length === 0 ? vanilla.length : `${matches.length} of ${vanilla.length}`}</span>
				</div>
				<ul class="gx-import-list">
					{shown.map(id => {
						const as = freeItemId(copyId(id, namespace), other => other in here)
						return <li key={id}>
							<span class="gx-import-text">
								<strong class="gx-mono">{prettyId(id)}</strong>
								<span class="gx-muted">Becomes {as}</span>
							</span>
							<button type="button" class="gx-btn gx-btn-tonal" disabled={busy !== undefined} onClick={() => copy(id)}>
								{Ico.copy}
								<span>{busy === id ? 'Copying…' : 'Copy'}</span>
							</button>
						</li>
					})}
				</ul>
				{matches.length === 0 && <p class="gx-muted" role="status">The game has no template with “{query.trim()}” in its id.</p>}
				{matches.length > shown.length && <p class="gx-muted">These are the first {shown.length} of {matches.length}. Search to find the others.</p>}
			</>}
		{failure && <p class="gx-field-error" role="alert">{failure}</p>}
		<p class="gx-muted">The game uses these for its structures, such as villages and shipwrecks. A copy is a template of this dimension, under an id of its own.</p>
	</section>
}
