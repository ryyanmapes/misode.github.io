import type { ComponentChildren } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { Ico } from './icons.jsx'
import { freeItemId } from './items.js'
import { isValidId } from './presets.js'
import { IconButton } from './ui.jsx'

/** A file that was chosen and waits to be imported */
interface Chosen<T> {
	key: number
	file: string
	value?: T
	/** What the file is, or why it cannot be read */
	about: string
	readable: boolean
	id: string
}

interface Props<T> {
	/** What one of the things is called that the files are, for example "feature" */
	noun: string
	heading: string
	/** The ending of the files, with its dot: .json */
	extension: string
	/** What the button says that opens the files of the computer */
	choose: string
	/** Said next to that button: what kind of files these are */
	hint: ComponentChildren
	/** Said while no file is chosen: where such files come from */
	help: ComponentChildren
	/** Said below the files that were chosen: what their id is for */
	idNote: string
	/** The id of the dimension, whose namespace the ids start with */
	dimensionId: string
	/** What the dimension has of this kind, by id */
	here: Record<string, unknown>
	/** The ids that the game has of this kind */
	vanilla: string[]
	/** Reads a file and tells what it is. Throws with the reason when it is not what is asked for. */
	read: (file: File) => Promise<{ value: T, about: string }>
	/** Adds what a file holds to the dimension under an id */
	onImport: (id: string, value: T, file: string) => void | Promise<void>
}

let nextKey = 1

/**
 * Brings files of the computer into a dimension. They are chosen or dropped, each gets an id
 * that is made from its name and can be changed, and then they are imported together.
 */
export function FileImport<T>({ noun, heading, extension, choose, hint, help, idNote, dimensionId, here, vanilla, read, onImport }: Props<T>) {
	const [chosen, setChosen] = useState<Chosen<T>[]>([])
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string>()
	const [over, setOver] = useState(false)
	const input = useRef<HTMLInputElement>(null)
	const namespace = dimensionId.slice(0, dimensionId.indexOf(':'))
	const prefix = namespace === 'minecraft' ? 'custom' : namespace

	/** The name of a file as the name of a thing: lowercase, without what an id cannot have */
	const nameOf = (file: string) => {
		const name = file.toLowerCase().endsWith(extension) ? file.slice(0, -extension.length) : file
		return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '') || noun.replace(/ /g, '_')
	}

	const add = async (list: File[]) => {
		const rows: Chosen<T>[] = []
		for (const file of list) {
			const key = nextKey
			nextKey += 1
			try {
				const { value, about } = await read(file)
				rows.push({ key, file: file.name, value, about, readable: true, id: '' })
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
				next.push({ ...row, id: row.readable ? freeItemId(`${prefix}:${nameOf(row.file)}`, taken) : '' })
			}
			return next
		})
	}

	const problemOf = (row: Chosen<T>) => !row.readable ? row.about
		: !isValidId(row.id) ? `An id is a namespace and a name with a colon in between, in lowercase letters, digits and underscores. For example ${prefix}:${nameOf(row.file)}`
			: row.id in here ? `This dimension already has a ${noun} ${row.id}.`
				: vanilla.includes(row.id) ? `The game already has a ${noun} ${row.id}. Yours would replace it for every dimension, so pick another id.`
					: chosen.some(other => other !== row && other.id === row.id) ? 'Another file in this list has the same id.'
						: undefined
	const ready = chosen.filter(row => row.readable)
	const problem = ready.map(problemOf).find(found => found !== undefined)
	const blocked = ready.length === 0 || problem !== undefined

	const importAll = async () => {
		if (blocked || busy) return
		setBusy(true)
		setFailure(undefined)
		try {
			for (const row of ready) {
				await onImport(row.id, row.value as T, row.file)
				setChosen(prev => prev.filter(other => other.key !== row.key))
			}
		} catch (e) {
			setFailure(`The ${noun} could not be imported: ${e instanceof Error ? e.message : String(e)}`)
		}
		setBusy(false)
	}

	return <section class="gx-card" aria-label={`Import ${noun}s from files`}>
		<h3>{heading}</h3>
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
			<input ref={input} type="file" accept={extension} multiple hidden onChange={e => {
				const field = e.target as HTMLInputElement
				void add(Array.from(field.files ?? []))
				// Choosing the same file again is noticed too
				field.value = ''
			}} />
			<button type="button" class="gx-btn gx-btn-tonal" onClick={() => input.current?.click()}>
				{Ico.file}
				<span>{choose}</span>
			</button>
			<span class="gx-muted">{hint}</span>
		</div>
		{chosen.length > 0 && <ul class="gx-import-list gx-chosen">
			{chosen.map(row => {
				const wrong = problemOf(row)
				return <li key={row.key}>
					<span class="gx-import-text">
						<strong class="gx-mono">{row.file}</strong>
						<span class={row.readable ? 'gx-muted' : 'gx-field-error'}>{row.about}</span>
					</span>
					{row.readable && <label class="gx-chosen-id">
						<span>ID</span>
						<input class={`gx-input gx-mono${wrong ? ' is-invalid' : ''}`} type="text" autocomplete="off" spellcheck={false}
							aria-label={`Id of the ${noun} from ${row.file}`} aria-invalid={wrong !== undefined} title={wrong} value={row.id}
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
				: <p class={problem ? 'gx-field-error' : 'gx-muted'} role={problem ? 'alert' : undefined}>
					{problem ?? (ready.length === 0 ? `None of these files can be read as a ${noun}.` : idNote)}
				</p>}
			<button type="button" class="gx-btn gx-btn-filled" disabled={blocked || busy} onClick={importAll}>
				{Ico.plus}
				<span>{ready.length > 1 ? `Import ${ready.length} ${noun}s` : 'Import'}</span>
			</button>
		</div>}
		{chosen.length === 0 && <p class="gx-muted">{help}</p>}
	</section>
}
