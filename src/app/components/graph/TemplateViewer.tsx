import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { VersionId } from '../../services/index.js'
import { fetchVersions } from '../../services/index.js'
import { blockPicture, loadedBlockPicture } from './blockPicture.js'
import { Ico } from './icons.jsx'
import { blockCss } from './material/blocks.js'
import type { GraphVersion } from './presets.js'
import type { TemplateMeta } from './templates.js'
import { formatBytes, templateBytes, templatePath, TemplateVolume, useTemplate } from './templates.js'
import { CopyButton, Field, IconButton, prettyId, Section, Slider } from './ui.jsx'
import type { ViewportApi } from './Viewport2D.jsx'
import { Diorama } from './view/Diorama.jsx'
import type { CameraMemo } from './view/Viewport3D.jsx'

/** How many blocks with data are listed before the rest is only counted */
const DATA_ROWS = 40

/** The version of the game that gives its saved files a certain number */
let versionNames: Promise<Map<number, string>> | undefined

function loadVersionNames() {
	if (!versionNames) {
		const loading = fetchVersions().then(versions => new Map(versions.map(v => [v.data_version, v.name])))
		// Another try can work when this one did not
		loading.catch(() => {
			if (versionNames === loading) versionNames = undefined
		})
		versionNames = loading
	}
	return versionNames
}

/** The name of the version of the game that saved a file, once the list of versions is downloaded */
function useSavedIn(dataVersion: number | undefined) {
	const [found, setFound] = useState<{ of: number, name: string }>()
	useEffect(() => {
		if (dataVersion === undefined) return
		let cancelled = false
		loadVersionNames().then(names => {
			const name = names.get(dataVersion)
			if (cancelled || name === undefined) return
			// Keeping the same state when nothing changed means this never causes another render
			setFound(prev => prev?.of === dataVersion && prev.name === name ? prev : { of: dataVersion, name })
		}, () => {})
		return () => {
			cancelled = true
		}
	}, [dataVersion])
	return found !== undefined && found.of === dataVersion ? found.name : undefined
}

/** A block as the game shows it in the inventory. Until that is drawn, and for blocks without one, the color of the block. */
function BlockIcon({ version, id }: { version: VersionId, id: string }) {
	const [picture, setPicture] = useState<{ of: string, src: string | undefined }>(() => ({ of: id, src: loadedBlockPicture(version, id) }))
	useEffect(() => {
		let cancelled = false
		blockPicture(version, id).then(src => {
			// Keeping the same state when nothing changed means this never causes another render
			if (!cancelled) setPicture(prev => prev.of === id && prev.src === src ? prev : { of: id, src })
		}, () => {})
		return () => {
			cancelled = true
		}
	}, [version, id])
	const src = picture.of === id ? picture.src : loadedBlockPicture(version, id)
	return src
		? <img class="gx-block-icon" src={src} alt="" draggable={false} />
		: <span class="gx-swatch" style={{ background: blockCss(id) }} />
}

function blockLabel(name: string) {
	return prettyId(name).replace(/_/g, ' ')
}

interface Props {
	id: string
	/** What the dimension remembers of the template */
	meta: TemplateMeta
	version: GraphVersion
	dark: boolean
	camera: CameraMemo
}
/** A template to look at: its blocks in 3D, and what its file says about them */
export function TemplateViewer({ id, meta, version, dark, camera }: Props) {
	const { template, error } = useTemplate(meta.hash)
	const viewport = useRef<ViewportApi>()
	// The height from which blocks are left out, to look inside of a build. Nothing is left out without it.
	const [cut, setCut] = useState<number>()
	const savedIn = useSavedIn(template?.dataVersion)

	const stage = useMemo(() => {
		if (!template) return undefined
		const volume = new TemplateVolume(template)
		return { volume, slice: volume.slice() }
	}, [template])

	const [sizeX, sizeY, sizeZ] = template?.size ?? meta.size
	const top = cut === undefined ? sizeY : Math.min(cut, sizeY)
	// Does nothing when the height is the same as before
	stage?.slice.setTop(top)
	const focus = useMemo(() => ({
		y: Math.round(sizeY / 2),
		reach: Math.max(3, Math.ceil(Math.hypot(sizeX / 2, sizeY / 2, sizeZ / 2) + 1)),
	}), [sizeX, sizeY, sizeZ])

	const path = templatePath(version.format, id)
	const download = async () => {
		const bytes = await templateBytes(meta.hash)
		if (!bytes) return
		const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
		const link = document.createElement('a')
		link.href = url
		link.download = path.slice(path.lastIndexOf('/') + 1)
		document.body.appendChild(link)
		link.click()
		link.remove()
		URL.revokeObjectURL(url)
	}

	const empty = template !== undefined && template.blocks === 0
	const message = error ? { title: 'This template cannot be shown', text: error }
		: empty ? { title: 'This template is empty', text: 'Its file has no blocks, only air.' } : undefined
	const commands = template?.blockData.filter(data => data.facts.some(([label]) => label === 'Command')).length ?? 0

	return <div class="gx-editor gx-view">
		<div class="gx-work">
			<div class="gx-stage">
				<Diorama slice={stage?.slice} revision={top} version={version.id} label={`The template ${id} in 3D`} dark={dark} memo={camera}
					frameKey={meta.hash} focus={focus} origin={stage?.volume.origin} loading="Reading the file…" message={message} apiRef={viewport} />
			</div>
			<aside class="gx-side" aria-label="Template">
				<div class="gx-side-head">
					<span class="gx-dot gx-dot-lg" style={{ background: 'var(--gx-cat-shape)' }} />
					<div class="gx-side-title">
						<h2>Template</h2>
						<p class="gx-mono">{id}</p>
					</div>
					<IconButton icon={Ico.download} label="Download the structure file" tipSide="left" disabled={!template} onClick={download} />
					<IconButton icon={Ico.target} label="Reset the view" tipSide="left" onClick={() => viewport.current?.reset()} />
				</div>
				<Section title="About">
					<dl class="gx-facts">
						<dt>Size</dt>
						<dd>{sizeX} wide (X), {sizeY} high (Y), {sizeZ} deep (Z)</dd>
						<dt>Blocks</dt>
						<dd>{(template?.blocks ?? meta.blocks).toLocaleString('en')}, not counting air</dd>
						<dt>File</dt>
						<dd>{formatBytes(meta.bytes)}{meta.source ? <>, from <span class="gx-mono">{meta.source}</span></> : null}</dd>
						{template?.dataVersion !== undefined && <>
							<dt>Saved in</dt>
							<dd>{savedIn ? `Minecraft ${savedIn}` : `A version of the game with the number ${template.dataVersion}`}</dd>
						</>}
					</dl>
					<p class="gx-muted">A template is only looked at here. To change it, load it in the game with a structure block, save it again and import the new file.</p>
				</Section>
				{sizeY > 1 && <Section title="Display">
					<div class="gx-fields">
						<Field label="Cut away above" hint="Leaves out the top of the template, to look inside from above">
							{() => <>
								<Slider label="The height above which blocks are cut away" min={1} max={sizeY} step={1} value={top} onChange={value => setCut(value >= sizeY ? undefined : value)} />
								<span class="gx-view-value">{top >= sizeY ? 'Off' : `Y ${top - 1}`}</span>
							</>}
						</Field>
					</div>
				</Section>}
				<Section title="Blocks">
					{!template && !error && <p class="gx-muted">Reading the file…</p>}
					{template && template.counts.length > 0 && <ul class="gx-chips" aria-label="Blocks of the template">
						{template.counts.slice(0, 16).map(block => <li key={block.name}>
							<BlockIcon version={version.id} id={block.name} />
							{blockLabel(block.name)}
							<span class="gx-muted">{block.count}</span>
						</li>)}
					</ul>}
					{template && template.counts.length > 16 && <p class="gx-muted">And {template.counts.length - 16} other kinds of blocks.</p>}
					{template && template.variants > 1 && <p class="gx-muted">The file has {template.variants} variants of its blocks, of which the game picks one. The first is shown.</p>}
				</Section>
				{template && template.blockData.length > 0 && <Section title="Blocks with data">
					<p class="gx-muted">
						{template.blockData.length === 1 ? 'One block has' : `${template.blockData.length} blocks have`} more than a state, such as the items of a chest.
						The file keeps that, and the game places it with the block.
						{commands > 0 && ` That includes the command${commands === 1 ? '' : 's'} below.`}
					</p>
					<ul class="gx-blockdata">
						{template.blockData.slice(0, DATA_ROWS).map(data => <li key={`${data.x} ${data.y} ${data.z}`}>
							<span class="gx-blockdata-head">
								<BlockIcon version={version.id} id={data.block} />
								<strong>{blockLabel(data.block)}</strong>
								<span class="gx-muted gx-mono">{data.x} {data.y} {data.z}</span>
							</span>
							{data.facts.length > 0 && <dl class="gx-facts">
								{data.facts.map(([label, value]) => [
									<dt key={`${label} name`}>{label}</dt>,
									<dd key={label} class={label === 'Command' || label === 'Loot table' || label === 'Pool' ? 'gx-mono' : undefined}>{value}</dd>,
								])}
							</dl>}
						</li>)}
					</ul>
					{template.blockData.length > DATA_ROWS && <p class="gx-muted">And {template.blockData.length - DATA_ROWS} more.</p>}
				</Section>}
				{template && template.entities.length > 0 && <Section title="Entities">
					<ul class="gx-chips" aria-label="Entities of the template">
						{template.entities.map(entity => <li key={entity.id}>
							{blockLabel(entity.id)}
							<span class="gx-muted">{entity.count}</span>
						</li>)}
					</ul>
					<p class="gx-muted">Entities are saved with the template and placed with it. They are not drawn here.</p>
				</Section>}
				<Section title="In the data pack" actions={<CopyButton getText={() => id} label="Copy the id" />}>
					<p class="gx-muted">The file is exported as <span class="gx-mono">{path}</span>.</p>
					<p class="gx-muted">{version.format === 'modern'
						? `A feature of the type Template places it: choose ${id} in the list of templates of the feature.`
						: `Minecraft ${version.label} has no feature that places a template. Structures do, which the editor does not make, so the file is there for a structure that you add to the pack yourself.`}</p>
				</Section>
			</aside>
		</div>
	</div>
}
