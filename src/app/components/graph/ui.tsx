import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { Ico } from './icons.jsx'

let uidCounter = 0
/** A stable unique id for linking labels and controls */
export function useUid() {
	return useState(() => `gx-${uidCounter += 1}`)[0]
}

interface IconButtonProps {
	icon: ComponentChildren
	label: string
	onClick?: (e: MouseEvent) => void
	disabled?: boolean
	active?: boolean
	shortcut?: string
	tipSide?: 'top' | 'bottom' | 'left'
	class?: string
}
export function IconButton({ icon, label, onClick, disabled, active, shortcut, tipSide = 'bottom', class: clazz }: IconButtonProps) {
	return <button type="button" class={`gx-iconbtn${active ? ' is-active' : ''}${clazz ? ` ${clazz}` : ''}`}
		aria-label={label} aria-pressed={active === undefined ? undefined : active} aria-keyshortcuts={shortcut}
		data-tip={shortcut ? `${label} (${shortcut})` : label} data-tip-side={tipSide}
		disabled={disabled} onClick={onClick}>
		{icon}
	</button>
}

interface ButtonProps {
	icon?: ComponentChildren
	label: string
	onClick?: (e: MouseEvent) => void
	variant?: 'text' | 'tonal' | 'outlined'
	disabled?: boolean
	tip?: string
	shortcut?: string
}
export function Button({ icon, label, onClick, variant = 'text', disabled, tip, shortcut }: ButtonProps) {
	return <button type="button" class={`gx-btn gx-btn-${variant}`} disabled={disabled} onClick={onClick}
		aria-keyshortcuts={shortcut} data-tip={tip} data-tip-side="bottom">
		{icon}
		<span>{label}</span>
	</button>
}

export function formatNumber(value: number) {
	if (!Number.isFinite(value)) return String(value)
	if (Math.abs(value) >= 1e21) return value.toExponential()
	// Avoid floating point noise such as 0.30000000000000004
	return String(Number(value.toPrecision(12)))
}

interface NumberFieldProps {
	value: number | undefined
	onChange: (value: number) => void
	/** Called when the field is cleared, if the value is optional */
	onClear?: () => void
	int?: boolean
	placeholder?: string
	label: string
	id?: string
	class?: string
	step?: number
}
/**
 * A number input that keeps the text you type while it is not yet a valid number.
 * Arrow up and down change the value, with shift for bigger and alt for smaller steps.
 */
export function NumberField({ value, onChange, onClear, int, placeholder, label, id, class: clazz, step = 1 }: NumberFieldProps) {
	const [text, setText] = useState(value === undefined ? '' : formatNumber(value))
	const focused = useRef(false)

	useEffect(() => {
		if (!focused.current) {
			setText(value === undefined ? '' : formatNumber(value))
		}
	}, [value])

	const commit = (raw: string) => {
		setText(raw)
		if (raw.trim() === '') {
			onClear?.()
			return
		}
		const parsed = Number(raw)
		if (!Number.isFinite(parsed)) return
		const next = int ? Math.round(parsed) : parsed
		if (next !== value) onChange(next)
	}

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault()
			const amount = (e.shiftKey ? 10 : e.altKey && !int ? 0.1 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1)
			const next = Number(((value ?? 0) + amount).toPrecision(12))
			setText(formatNumber(next))
			onChange(next)
		} else if (e.key === 'Enter') {
			(e.target as HTMLInputElement).blur()
		}
	}

	return <input id={id} class={`gx-input gx-number${clazz ? ` ${clazz}` : ''}`} type="text" inputMode="decimal" autocomplete="off" spellcheck={false}
		aria-label={label} value={text} placeholder={placeholder}
		onInput={e => commit((e.target as HTMLInputElement).value)}
		onFocus={e => {
			focused.current = true;
			(e.target as HTMLInputElement).select()
		}}
		onBlur={() => {
			focused.current = false
			setText(value === undefined ? '' : formatNumber(value))
		}}
		onKeyDown={onKeyDown} />
}

interface TextFieldProps {
	value: string
	onChange: (value: string) => void
	options?: string[]
	label: string
	id?: string
	placeholder?: string
	mono?: boolean
}
export function TextField({ value, onChange, options, label, id, placeholder, mono }: TextFieldProps) {
	const listId = useUid()
	const [text, setText] = useState(value)
	const focused = useRef(false)
	useEffect(() => {
		if (!focused.current) setText(value)
	}, [value])
	return <>
		<input id={id} class={`gx-input${mono ? ' gx-mono' : ''}`} type="text" autocomplete="off" spellcheck={false}
			aria-label={label} value={text} placeholder={placeholder} list={options ? listId : undefined}
			onInput={e => {
				const next = (e.target as HTMLInputElement).value
				setText(next)
				onChange(next)
			}}
			onFocus={() => focused.current = true}
			onBlur={() => {
				focused.current = false
				setText(value)
			}}
			onKeyDown={e => {
				if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
			}} />
		{options && <datalist id={listId}>
			{options.map(o => <option key={o} value={o} />)}
		</datalist>}
	</>
}

interface SelectProps {
	value: string
	onChange: (value: string) => void
	/** Options that follow each other with the same group are shown under that heading */
	options: { value: string, label: string, disabled?: boolean, group?: string }[]
	label: string
	id?: string
	class?: string
}
export function Select({ value, onChange, options, label, id, class: clazz }: SelectProps) {
	const groups: { group: string | undefined, options: SelectProps['options'] }[] = []
	for (const option of options) {
		const last = groups[groups.length - 1]
		if (last && last.group === option.group) last.options.push(option)
		else groups.push({ group: option.group, options: [option] })
	}
	const render = (list: SelectProps['options']) => list.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)
	return <div class={`gx-select${clazz ? ` ${clazz}` : ''}`}>
		<select id={id} aria-label={label} value={value} onChange={e => onChange((e.target as HTMLSelectElement).value)}>
			{groups.map(g => g.group === undefined ? render(g.options) : <optgroup key={g.group} label={g.group}>{render(g.options)}</optgroup>)}
		</select>
		{Ico.chevronDown}
	</div>
}

const ID_OPTIONS = new WeakMap<string[], SelectProps['options']>()

function fullId(id: string) {
	return id.includes(':') ? id : `minecraft:${id}`
}

/** The ids of a registry as options, in alphabetical order. What does not come with the game is first and under its own heading. */
function idOptions(ids: string[]): SelectProps['options'] {
	let options = ID_OPTIONS.get(ids)
	if (!options) {
		const parts = [...new Set(ids.map(fullId))].map(id => ({ id, namespace: id.slice(0, id.indexOf(':')), path: id.slice(id.indexOf(':') + 1) }))
		const grouped = new Set(parts.map(p => p.namespace)).size > 1
		const rank = (namespace: string) => namespace === 'minecraft' ? 1 : 0
		parts.sort((a, b) => rank(a.namespace) - rank(b.namespace) || a.namespace.localeCompare(b.namespace) || a.path.localeCompare(b.path))
		options = parts.map(p => ({ value: p.id, label: prettyId(p.id), group: grouped ? p.namespace : undefined }))
		ID_OPTIONS.set(ids, options)
	}
	return options
}

interface IdSelectProps {
	value: string
	onChange: (value: string) => void
	/** The ids that exist. While they are not known the id is typed instead. */
	options: string[] | undefined
	label: string
	id?: string
	class?: string
}
/** Chooses one of the ids that exist, for example a noise or a named density function */
export function IdSelect({ value, onChange, options, label, id, class: clazz }: IdSelectProps) {
	if (!options || options.length === 0) {
		return <TextField id={id} label={label} mono value={value} placeholder="minecraft:…" onChange={onChange} />
	}
	const known = idOptions(options)
	const current = value === '' ? '' : fullId(value)
	const found = known.some(o => o.value === current)
	return <Select id={id} label={label} class={clazz} value={found ? current : value} onChange={onChange}
		options={found ? known : [
			// What is there stays there, also when it does not exist
			value === '' ? { value: '', label: 'Choose…', disabled: true } : { value, label: `${prettyId(value)} (not found)` },
			...known,
		]} />
}

interface SliderProps {
	value: number | undefined
	onChange: (value: number) => void
	min: number
	max: number
	step: number
	label: string
	class?: string
}
/** A slider between two ends. A value outside of them rests at the nearest end. */
export function Slider({ value, onChange, min, max, step, label, class: clazz }: SliderProps) {
	const shown = Math.min(max, Math.max(min, value ?? 0))
	const fraction = max > min ? (shown - min) / (max - min) : 0
	return <input type="range" class={`gx-slider${clazz ? ` ${clazz}` : ''}`} aria-label={label} min={min} max={max} step={step} value={shown}
		style={{ '--fill': `${(fraction * 100).toFixed(2)}%` }}
		onInput={e => {
			const next = Number((e.target as HTMLInputElement).value)
			if (Number.isFinite(next) && next !== value) onChange(Number(next.toPrecision(12)))
		}} />
}

/** A step for a slider that gives a few hundred positions with round values */
export function sliderStep(min: number, max: number) {
	const range = Math.abs(max - min)
	if (!(range > 0)) return 1
	return Math.pow(10, Math.floor(Math.log10(range / 100)))
}

interface CheckboxProps {
	checked: boolean
	onChange: (checked: boolean) => void
	label: string
	/** Explains the checkbox when the label is short */
	hint?: string
}
export function Checkbox({ checked, onChange, label, hint }: CheckboxProps) {
	return <label class="gx-check" title={hint}>
		<input type="checkbox" checked={checked} onChange={e => onChange((e.target as HTMLInputElement).checked)} />
		<span>{label}</span>
	</label>
}

/** A setting that is remembered in this browser */
export function useStoredFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
	const [value, setValue] = useState(() => {
		try {
			const stored = localStorage.getItem(key)
			return stored === null ? initial : stored === 'true'
		} catch (e) {
			return initial
		}
	})
	const change = useCallback((next: boolean) => {
		setValue(next)
		try {
			localStorage.setItem(key, String(next))
		} catch (e) {
			// The setting still applies until the page is closed
		}
	}, [key])
	return [value, change]
}

interface SwitchProps {
	checked: boolean
	onChange: (checked: boolean) => void
	label: string
	id?: string
}
export function Switch({ checked, onChange, label, id }: SwitchProps) {
	return <button id={id} type="button" role="switch" class="gx-switch" aria-checked={checked} aria-label={label}
		onClick={() => onChange(!checked)}>
		<span class="gx-switch-thumb" />
	</button>
}

interface SegmentedProps<T extends string> {
	value: T
	onChange: (value: T) => void
	options: { value: T, label: string }[]
	label: string
}
export function Segmented<T extends string>({ value, onChange, options, label }: SegmentedProps<T>) {
	return <div class="gx-segmented" role="radiogroup" aria-label={label}>
		{options.map(o => <button key={o.value} type="button" role="radio" aria-checked={o.value === value}
			class={o.value === value ? 'is-active' : ''} onClick={() => onChange(o.value)}>
			{o.label}
		</button>)}
	</div>
}

interface FieldProps {
	label: string
	hint?: string
	children: (id: string) => ComponentChildren
	wide?: boolean
}
export function Field({ label, hint, children, wide }: FieldProps) {
	const id = useUid()
	return <div class={`gx-field${wide ? ' gx-field-wide' : ''}`}>
		<label for={id} title={hint}>{label}</label>
		<div class="gx-field-control">{children(id)}</div>
	</div>
}

/**
 * Makes everything inside impossible to change while it is locked, but still readable.
 * This is how the values of a preset are shown.
 */
export function Lockable({ locked, children }: { locked: boolean, children: ComponentChildren }) {
	return <fieldset class="gx-lockable" disabled={locked}>{children}</fieldset>
}

interface JsonFieldProps {
	label: string
	value: unknown
	onChange: (value: unknown) => void
	rows: number
}
export function JsonField({ label, value, onChange, rows }: JsonFieldProps) {
	const [text, setText] = useState(() => JSON.stringify(value, null, 2) ?? '')
	const [invalid, setInvalid] = useState(false)
	const focused = useRef(false)
	useEffect(() => {
		if (!focused.current) {
			setText(JSON.stringify(value, null, 2) ?? '')
			setInvalid(false)
		}
	}, [value])
	return <Field label={label} wide>
		{id => <>
			<textarea id={id} class={`gx-input gx-mono gx-textarea${invalid ? ' is-invalid' : ''}`} rows={rows} spellcheck={false}
				aria-invalid={invalid} value={text}
				onFocus={() => focused.current = true}
				onBlur={() => focused.current = false}
				onInput={e => {
					const next = (e.target as HTMLTextAreaElement).value
					setText(next)
					try {
						onChange(JSON.parse(next))
						setInvalid(false)
					} catch (e) {
						setInvalid(true)
					}
				}} />
			{invalid && <span class="gx-field-error" role="alert">This is not valid JSON yet</span>}
		</>}
	</Field>
}

interface SectionProps {
	title: string
	children: ComponentChildren
	actions?: ComponentChildren
	collapsible?: boolean
	defaultOpen?: boolean
}
export function Section({ title, children, actions, collapsible, defaultOpen = true }: SectionProps) {
	const [open, setOpen] = useState(defaultOpen)
	const id = useUid()
	return <section class="gx-section">
		<div class="gx-section-head">
			{collapsible
				? <button type="button" class="gx-section-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
					<span class={`gx-caret${open ? ' is-open' : ''}`}>{Ico.chevronRight}</span>
					<h3>{title}</h3>
				</button>
				: <h3>{title}</h3>}
			{(open || !collapsible) && actions && <div class="gx-section-actions">{actions}</div>}
		</div>
		{(open || !collapsible) && <div id={id} class="gx-section-body">{children}</div>}
	</section>
}

/** A button that copies text and briefly shows a confirmation */
export function CopyButton({ getText, label = 'Copy JSON' }: { getText: () => string, label?: string }) {
	const [copied, setCopied] = useState(false)
	useEffect(() => {
		if (!copied) return
		const timeout = setTimeout(() => setCopied(false), 1800)
		return () => clearTimeout(timeout)
	}, [copied])
	return <IconButton icon={copied ? Ico.check : Ico.copy} label={copied ? 'Copied' : label} tipSide="left"
		onClick={() => {
			navigator.clipboard?.writeText(getText()).then(() => setCopied(true)).catch(() => {})
		}} />
}

export function prettyId(id: string) {
	return id.replace(/^minecraft:/, '')
}

export function titleCase(name: string) {
	return name.replace(/^minecraft:/, '').split(/[_/]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
}
