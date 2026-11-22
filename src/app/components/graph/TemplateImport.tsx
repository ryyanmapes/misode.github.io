import { useRef, useState } from 'preact/hooks'
import { Ico } from './icons.jsx'
import { copyId, freeItemId } from './items.js'
import type { GraphVersion } from './presets.js'
import { isValidId } from './presets.js'
import type { TemplateMeta } from './templates.js'
import { addTemplateFile, describeTemplate, fetchVanillaTemplate, parseTemplate } from './templates.js'
import { IconButton, prettyId } from './ui.jsx'

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

/** A file that was chosen and waits to be imported */
interface Chosen {
	key: number
	file: string
	bytes?: Uint8Array
	/** What the file is, or why it cannot be read */
	about: string
	readable: boolean
	id: string
}

/** A name of a file as the name of a template: lowercase, without what an id cannot have */
function nameOfFile(file: string) {
	return file.replace(/\.nbt$/i, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '') || 'template'
}

let nextKey = 1

/** Adds templates to a dimension: from structure files, or as copies of the templates of the game */
export function NewTemplates(props: Props) {
	return <>
		<ImportFiles {...props} />
		<CopyVanilla {...props} />
	</>
}

function ImportFiles({ dimensionId, here, vanilla, onCreate }: Props) {
	const [chosen, setChosen] = useState<Chosen[]>([])
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string>()
	const [over, setOver] = useState(false)
	const input = useRef<HTMLInputElement>(null)
	const namespace = dimensionId.slice(0, dimensionId.indexOf(':'))
	const prefix = namespace === 'minecraft' ? 'custom' : namespace

	const add = async (list: File[]) => {
		const rows: Chosen[] = []
		for (const file of list) {
			const key = nextKey
			nextKey += 1
			try {
				const bytes = new Uint8Array(await file.arrayBuffer())
				rows.push({ key, file: file.name, bytes, about: describeTemplate(parseTemplate(bytes)), readable: true, id: '' })
			} catch (e) {
				rows.push({ key, file: file.name, about: e instanceof Error ? e.message : String(e), readable: false, id: '' })
			}
		}
		setFailure(undefined)
		setChosen(prev => {
			const next = [...prev]
			for (const row of rows) {
				// Each file gets an id that nothing else has, also not the files next to it
				const taken = (id: string) => id in here || vanilla.includes(id) || next.some(other => other.id === id)
				next.push({ ...row, id: row.readable ? freeItemId(`${prefix}:${nameOfFile(row.file)}`, taken) : '' })
			}
			return next
		})
	}

	const problemOf = (row: Chosen) => !row.readable ? row.about
		: !isValidId(row.id) ? `An id is a namespace and a name with a colon in between, in lowercase letters, digits and underscores. For example ${prefix}:${nameOfFile(row.file)}`
			: row.id in here ? `This dimension already has a template ${row.id}.`
				: vanilla.includes(row.id) ? `The game already has a template ${row.id}. Yours would replace it for every dimension, so pick another id.`
					: chosen.some(other => other !== row && other.id === row.id) ? 'Another file in this list has the same id.'
						: undefined
	const ready = chosen.filter(row => row.readable)
	const blocked = ready.length === 0 || ready.some(row => problemOf(row) !== undefined)

	const importAll = async () => {
		if (blocked || busy) return
		setBusy(true)
		setFailure(undefined)
		try {
			for (const row of ready) {
				onCreate(row.id, await addTemplateFile(row.bytes!, row.file))
				setChosen(prev => prev.filter(other => other.key !== row.key))
			}
		} catch (e) {
			setFailure(`The template could not be imported: ${e instanceof Error ? e.message : String(e)}`)
		}
		setBusy(false)
	}

	return <section class="gx-card" aria-label="Import templates from files">
		<h3>Import your own</h3>
		<div class={`gx-drop${over ? ' is-over' : ''}`}
			onDragOver={e => {
				e.preventDefault()
				setOver(true)
			}}
			onDragLeave={() => setOver(false)}
			onDrop={e => {
				e.preventDefault()
				setOver(false)
				void add(Array.from(e.dataTransfer?.files ?? []))
			}}>
			<input ref={input} type="file" accept=".nbt" multiple hidden onChange={e => {
				const field = e.target as HTMLInputElement
				void add(Array.from(field.files ?? []))
				// Choosing the same file again is noticed too
				field.value = ''
			}} />
			<button type="button" class="gx-btn gx-btn-tonal" onClick={() => input.current?.click()}>
				{Ico.file}
				<span>Choose structure files</span>
			</button>
			<span class="gx-muted">or drop them here. These are the <span class="gx-mono">.nbt</span> files that a structure block saves.</span>
		</div>
		{chosen.length > 0 && <ul class="gx-import-list gx-chosen">
			{chosen.map(row => {
				const problem = problemOf(row)
				return <li key={row.key}>
					<span class="gx-import-text">
						<strong class="gx-mono">{row.file}</strong>
						<span class={row.readable ? 'gx-muted' : 'gx-field-error'}>{row.about}</span>
					</span>
					{row.readable && <label class="gx-chosen-id">
						<span>ID</span>
						<input class={`gx-input gx-mono${problem ? ' is-invalid' : ''}`} type="text" autocomplete="off" spellcheck={false}
							aria-label={`Id of the template from ${row.file}`} aria-invalid={problem !== undefined} title={problem} value={row.id}
							onInput={e => {
								const id = (e.target as HTMLInputElement).value.trim()
								setChosen(prev => prev.map(other => other.key === row.key ? { ...other, id } : other))
							}} />
					</label>}
					<IconButton icon={Ico.close} label={`Leave out ${row.file}`} tipSide="left" onClick={() => setChosen(prev => prev.filter(other => other.key !== row.key))} />
				</li>
			})}
		</ul>}
		{chosen.length > 0 && <div class="gx-chosen-foot">
			{failure
				? <p class="gx-field-error" role="alert">{failure}</p>
				: <p class={ready.some(row => problemOf(row)) ? 'gx-field-error' : 'gx-muted'} role={ready.some(row => problemOf(row)) ? 'alert' : undefined}>
					{ready.map(problemOf).find(problem => problem !== undefined)
						?? (ready.length === 0 ? 'None of these files can be read as a template.'
							: 'The id is how a feature refers to the template, and where its file goes in the data pack.')}
				</p>}
			<button type="button" class="gx-btn gx-btn-filled" disabled={blocked || busy} onClick={importAll}>
				{Ico.plus}
				<span>{ready.length > 1 ? `Import ${ready.length} templates` : 'Import'}</span>
			</button>
		</div>}
		{chosen.length === 0 && <p class="gx-muted">
			To make one, build something in the game, save it with a structure block, and take the file from the <span class="gx-mono">generated</span> folder of the world.
			A template keeps what is inside of its blocks, such as the command of a command block.
		</p>}
	</section>
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
