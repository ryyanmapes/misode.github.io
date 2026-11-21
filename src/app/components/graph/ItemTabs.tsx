import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { Ico } from './icons.jsx'

export interface ItemTab {
	id: string
	label: string
	/** A tab that is always there, like the final density of a dimension */
	pinned?: boolean
	/** Explains the tab when the pointer rests on it */
	hint?: string
}

interface Props {
	/** What the tabs are, for screen readers */
	label: string
	icon: ComponentChildren
	tabs: ItemTab[]
	/** The id of the tab that is shown, or nothing when the home tab is */
	active: string | null
	onSelect: (id: string | null) => void
	onClose: (id: string) => void
}
/** The home tab of a view and what is open in it, like the tabs of the dimensions above */
export function ItemTabs({ label, icon, tabs, active, onSelect, onClose }: Props) {
	const strip = useRef<HTMLDivElement>(null)

	// With many tabs the strip scrolls, the open one should not be out of sight
	useEffect(() => {
		strip.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [active, tabs.length])

	return <div ref={strip} class="gx-itabs" role="tablist" aria-label={label}
		onWheel={e => {
			if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY
		}}>
		<div class={`gx-itab gx-itab-home${active === null ? ' is-active' : ''}`}>
			<button type="button" role="tab" class="gx-itab-open" aria-selected={active === null} onClick={() => onSelect(null)}>
				{Ico.home}
				<span class="gx-itab-name">Home</span>
			</button>
		</div>
		{tabs.map(tab => <div key={tab.id} class={`gx-itab${tab.id === active ? ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''}`} title={tab.hint ?? tab.label}
			onMouseDown={e => {
				// The middle button closes the tab instead of starting to scroll
				if (e.button === 1) e.preventDefault()
			}}
			onMouseUp={e => {
				if (e.button === 1 && !tab.pinned) onClose(tab.id)
			}}>
			<button type="button" role="tab" class="gx-itab-open" aria-selected={tab.id === active} onClick={() => onSelect(tab.id)}>
				{tab.pinned ? Ico.pin : icon}
				<span class="gx-itab-name">{tab.label}</span>
			</button>
			{!tab.pinned && <button type="button" class="gx-itab-close" aria-label={`Close ${tab.label}`} onClick={() => onClose(tab.id)}>
				{Ico.close}
			</button>}
		</div>)}
	</div>
}
