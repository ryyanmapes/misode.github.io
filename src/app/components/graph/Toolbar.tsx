import type { ComponentChildren } from 'preact'
import type { MutableRef } from 'preact/hooks'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useClipCount } from './clipboard.js'
import type { CanvasApi } from './GraphCanvas.jsx'
import { Ico } from './icons.jsx'
import type { GraphStore } from './store.js'
import type { GraphKind, ViewOptions } from './types.js'
import { Button, IconButton, NumberField, Switch } from './ui.jsx'

interface ToolbarProps {
	store: GraphStore
	kind: GraphKind
	api: MutableRef<CanvasApi | undefined>
	onTidy: () => void
	onReset: () => void
	getJson: () => string
	/** What the copy button copies, for example "final density" */
	jsonName: string
	/** Which graphs nodes can be copied from and to */
	clipType: string
	/** What going back to how the graph started is called */
	resetLabel: string
	options: ViewOptions
	onOptions: (patch: Partial<ViewOptions>) => void
	children?: ComponentChildren
}
export function Toolbar({ store, kind, api, onTidy, onReset, getJson, jsonName, clipType, resetLabel, options, onOptions, children }: ToolbarProps) {
	const { readOnly } = store
	const pasteable = useClipCount(clipType)
	const [copied, setCopied] = useState(false)
	useEffect(() => {
		if (!copied) return
		const timeout = setTimeout(() => setCopied(false), 1800)
		return () => clearTimeout(timeout)
	}, [copied])

	const canDelete = !readOnly && (store.edgeSelection.length > 0 || store.selection.some(id => {
		const node = store.node(id)
		return node !== undefined && kind.deletable(node)
	}))
	// What can be duplicated can also be copied, which works in presets too
	const canDuplicate = store.selection.some(id => {
		const node = store.node(id)
		return node !== undefined && kind.deletable(node)
	})

	return <div class="gx-toolbar" role="toolbar" aria-label="Graph tools">
		<IconButton icon={Ico.undo} label="Undo" shortcut="Ctrl+Z" disabled={readOnly || !store.canUndo} onClick={() => store.undo()} />
		<IconButton icon={Ico.redo} label="Redo" shortcut="Ctrl+Y" disabled={readOnly || !store.canRedo} onClick={() => store.redo()} />
		<span class="gx-divider" />
		{readOnly
			? <span class="gx-lock-chip" data-tip="Examples cannot be changed. Copy nodes into a dimension of your own, or pick this example as a template on the home tab." data-tip-side="bottom">
				{Ico.lock}
				<span>Read-only example</span>
			</span>
			: <Button icon={Ico.plus} label="Add node" variant="tonal" tip="Add node (A), or double-click the canvas" shortcut="A" onClick={() => api.current?.openPalette()} />}
		<span class="gx-divider" />
		<IconButton icon={Ico.tidy} label="Tidy up layout" disabled={readOnly} onClick={onTidy} />
		<IconButton icon={Ico.grid} label="Snap to grid" active={options.snap} onClick={() => onOptions({ snap: !options.snap })} />
		{children}
		<span class="gx-divider" />
		<IconButton icon={Ico.height} label="Limit previews to a height range" active={options.limit} onClick={() => onOptions({ limit: !options.limit })} />
		<RangesButton options={options} onOptions={onOptions} />
		<span class="gx-divider" />
		<IconButton icon={Ico.copy} label={canDuplicate ? 'Copy the selected nodes' : 'Copy: select nodes first'} shortcut="Ctrl+C" disabled={!canDuplicate} onClick={() => api.current?.copy()} />
		<IconButton icon={Ico.paste} shortcut="Ctrl+V" disabled={readOnly || pasteable === 0}
			label={readOnly ? 'Paste: examples cannot be changed' : pasteable === 0 ? 'Paste: copy nodes of this kind of graph first' : `Paste ${pasteable} node${pasteable === 1 ? '' : 's'}`}
			onClick={() => api.current?.paste()} />
		<IconButton icon={Ico.duplicate} label="Duplicate" shortcut="Ctrl+D" disabled={readOnly || !canDuplicate} onClick={() => store.duplicateSelection(kind)} />
		<IconButton icon={Ico.trash} label="Delete" shortcut="Del" disabled={!canDelete} onClick={() => store.deleteSelection(kind)} />
		<span class="gx-spacer" />
		<Button icon={copied ? Ico.check : Ico.braces} label={copied ? 'Copied' : 'Copy JSON'} tip={`Copy the ${jsonName} as JSON`}
			onClick={() => {
				navigator.clipboard?.writeText(getJson()).then(() => setCopied(true)).catch(() => {})
			}} />
		{!readOnly && <IconButton icon={Ico.restore} label={resetLabel} onClick={onReset} />}
		<HelpButton />
	</div>
}

const HELP: { title: string, rows: [string, string][] }[] = [
	{
		title: 'Mouse',
		rows: [
			['Scroll', 'Zoom towards the cursor'],
			['Drag the canvas', 'Pan'],
			['Drag a node', 'Move it, onto the dots when snapping is on'],
			['Shift + drag', 'Select with a box'],
			['Drag a port', 'Connect, or drop on empty space to add a node'],
			['Double-click or right-click', 'Add a node at the cursor'],
			['Right-click a node', 'Duplicate, disconnect or delete'],
		],
	},
	{
		title: 'Keyboard',
		rows: [
			['A', 'Add a node'],
			['Tab', 'Move between nodes'],
			['Arrow keys', 'Move the selection, or pan'],
			['Delete', 'Delete the selection'],
			['Ctrl + Z / Ctrl + Y', 'Undo and redo'],
			['Ctrl + D', 'Duplicate'],
			['Ctrl + C / Ctrl + V', 'Copy nodes, also out of an example, and paste them'],
			['Ctrl + A', 'Select everything'],
			['F', 'Fit the graph to the screen'],
			['+ / − / 0', 'Zoom in, out, or to 100%'],
			['Esc', 'Clear the selection'],
		],
	},
]

/** Closes a popover when clicking outside of it or pressing Escape */
function useDismiss(open: boolean, close: () => void) {
	const root = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!open) return
		const onPointerDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) close()
		}
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close()
		}
		document.addEventListener('pointerdown', onPointerDown)
		document.addEventListener('keydown', onKeyDown)
		return () => {
			document.removeEventListener('pointerdown', onPointerDown)
			document.removeEventListener('keydown', onKeyDown)
		}
	}, [open])
	return root
}

type RangeKey = 'X' | 'Y' | 'Z'

/** The ranges of the previews and of the sliders, in a popover of the toolbar */
function RangesButton({ options, onOptions }: { options: ViewOptions, onOptions: (patch: Partial<ViewOptions>) => void }) {
	const [open, setOpen] = useState(false)
	const root = useDismiss(open, () => setOpen(false))

	const row = (axis: RangeKey, what: string) => <div class="gx-range-row" data-range={axis.toLowerCase()} role="group" aria-label={`${axis} range of the previews`}>
		<span class="gx-range-name">{axis}</span>
		<NumberField label={`Lowest ${what} in previews`} int value={options[`min${axis}`]} onChange={v => onOptions({ [`min${axis}`]: v })} />
		<span>to</span>
		<NumberField label={`Highest ${what} in previews`} int value={options[`max${axis}`]} onChange={v => onOptions({ [`max${axis}`]: v })} />
		{axis === 'Y' && <label class="gx-range-switch">
			<Switch label="Limit previews to this height range" checked={options.limit} onChange={limit => onOptions({ limit })} />
			<span>{options.limit ? 'Limited' : 'Free'}</span>
		</label>}
	</div>

	return <div ref={root} class="gx-help gx-ranges">
		<button type="button" class={`gx-btn gx-btn-text${open ? ' is-active' : ''}`} aria-expanded={open} aria-haspopup="dialog"
			data-tip={open ? undefined : 'Ranges of the previews and sliders'} data-tip-side="bottom" onClick={() => setOpen(!open)}>
			{Ico.sliders}
			<span>Ranges</span>
		</button>
		{open && <div class="gx-help-card gx-ranges-card" role="dialog" aria-label="Ranges of the previews and sliders">
			<h4>Preview area</h4>
			<p class="gx-muted">Previews cannot be moved outside of X and Z. Their colors are based on this whole area, so they stay the same when zooming in.</p>
			{row('X', 'X')}
			{row('Z', 'Z')}
			{row('Y', 'height')}
			<h4>Sliders</h4>
			<div class="gx-range-row" data-range="slider" role="group" aria-label="Range of the sliders for constants">
				<span class="gx-range-name gx-range-name-wide">Constants</span>
				<NumberField label="Lowest value of the sliders for constants" value={options.sliderMin} onChange={sliderMin => onOptions({ sliderMin })} />
				<span>to</span>
				<NumberField label="Highest value of the sliders for constants" value={options.sliderMax} onChange={sliderMax => onOptions({ sliderMax })} />
			</div>
		</div>}
	</div>
}

function HelpButton() {
	const [open, setOpen] = useState(false)
	const root = useDismiss(open, () => setOpen(false))

	return <div ref={root} class="gx-help">
		<button type="button" class={`gx-iconbtn${open ? ' is-active' : ''}`} aria-label="Controls and shortcuts" aria-expanded={open} aria-haspopup="dialog"
			data-tip={open ? undefined : 'Controls and shortcuts'} data-tip-side="bottom" onClick={() => setOpen(!open)}>
			{Ico.help}
		</button>
		{open && <div class="gx-help-card" role="dialog" aria-label="Controls and shortcuts">
			{HELP.map(group => <div key={group.title}>
				<h4>{group.title}</h4>
				<dl>
					{group.rows.map(([keys, action]) => <div key={keys}>
						<dt>{keys}</dt>
						<dd>{action}</dd>
					</div>)}
				</dl>
			</div>)}
		</div>}
	</div>
}
