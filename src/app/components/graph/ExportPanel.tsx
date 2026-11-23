import { useEffect, useMemo, useState } from 'preact/hooks'
import type { Finding } from './check.js'
import { checkFormat, fileIdentity, lintFiles, mergeFindings } from './check.js'
import type { PackFile, PackSource } from './datapack.js'
import { downloadPack, fileName, loadPackSource, packFiles } from './datapack.js'
import type { Sub } from './dimensions.js'
import { MAIN } from './dimensions.js'
import { Ico } from './icons.jsx'
import type { AnyDimension } from './items.js'
import { ruleName } from './material/schema.js'
import type { GraphVersion } from './presets.js'
import { useService } from './TreeEditor.jsx'
import { Button, CopyButton } from './ui.jsx'

/** A place in the editor: a view of the dimension, and the thing that is open in it when the view has several */
export interface OpenTarget {
	sub: Sub
	item?: string
}

/** The registries whose things are edited on a tab of their own */
const TAB_OF: Record<string, Sub> = {
	'worldgen/noise': 'noise',
	'worldgen/density_function': 'density',
	'worldgen/material_rule': 'material',
	'worldgen/carver': 'carver',
	'worldgen/configured_carver': 'carver',
	'worldgen/feature': 'feature',
	'worldgen/configured_feature': 'feature',
	'worldgen/placed_feature': 'placer',
}

/** Where what a finding is about is edited */
function targetOf(finding: Finding, data: AnyDimension): OpenTarget | undefined {
	const identity = fileIdentity(finding.path)
	if (!identity) return undefined
	if (identity.registry === 'worldgen/noise_settings') {
		// The noise settings are the final density, before 26.3 the surface rule, and the facts on the Dimension tab
		if (finding.where.startsWith('noise_router')) return { sub: 'density', item: MAIN }
		if (finding.where.startsWith('surface_rule')) return { sub: 'material', item: MAIN }
		return { sub: 'dimension' }
	}
	const sub = TAB_OF[identity.registry]
	if (sub === undefined) return { sub: 'dimension' }
	if (sub === 'density') return { sub, item: identity.id in data.densityFunctions ? identity.id : MAIN }
	if (sub === 'material') return { sub, item: identity.id in data.rules ? identity.id : MAIN }
	return { sub, item: identity.id }
}

function count(n: number, one: string, many: string) {
	return `${n} ${n === 1 ? one : many}`
}

interface Props {
	version: GraphVersion
	/** The dimension as it is now, with its graphs, which is what the data pack gets */
	data: AnyDimension
	editable: boolean
	/** The ids that the game has, by registry, once they are downloaded */
	registries: Map<string, string[]> | undefined
	/** Goes to where something of the dimension is edited */
	onOpen: (target: OpenTarget) => void
}
/** Offers the dimension as a data pack, tells what is in it, and what the game would refuse of it */
export function ExportPanel({ version, data, editable, registries, onOpen }: Props) {
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string>()

	// A dimension from before dimensions had a biome of their own gets the file of its biome first, which is downloaded
	const [loaded, setLoaded] = useState<{ of: AnyDimension, source?: PackSource, error?: string }>()
	useEffect(() => {
		let cancelled = false
		loadPackSource(version, data).then(source => {
			if (!cancelled) setLoaded({ of: data, source })
		}, e => {
			if (!cancelled) setLoaded({ of: data, error: e instanceof Error ? e.message : String(e) })
		})
		return () => {
			cancelled = true
		}
	}, [version, data])
	const source = loaded?.of === data ? loaded.source : undefined
	const files = useMemo(() => source ? packFiles(version, `${data.id}, made with the worldgen graph editor`, [source]) : [], [version, data, source])

	// The files are checked as they are: by the editor itself at once, and against the format of the game when that is loaded
	const { service, error: serviceError } = useService(version.id)
	const own = useMemo(() => lintFiles(version, files), [version, files])
	const [format, setFormat] = useState<{ of: PackFile[], findings?: Finding[], error?: string }>()
	useEffect(() => {
		if (!service || !registries || files.length === 0) return
		let cancelled = false
		checkFormat(service, version, files, registries, () => cancelled).then(findings => {
			if (!cancelled) setFormat({ of: files, findings })
		}, e => {
			if (!cancelled) setFormat({ of: files, error: e instanceof Error ? e.message : String(e) })
		})
		return () => {
			cancelled = true
		}
	}, [service, registries, version, files])
	const checked = format?.of === files ? format : undefined
	const checkError = serviceError ?? checked?.error
	const checking = files.length > 0 && checked === undefined && checkError === undefined
	const groups = useMemo(() => {
		const byFile = new Map<string, Finding[]>()
		for (const finding of mergeFindings(own, checked?.findings ?? [])) {
			const list = byFile.get(finding.path)
			if (list) list.push(finding)
			else byFile.set(finding.path, [finding])
		}
		const isError = (finding: Finding) => finding.level === 'error'
		// What keeps the pack from loading comes first
		return [...byFile].map(([path, findings]) => ({ path, findings: [...findings.filter(isError), ...findings.filter(f => !isError(f))] }))
			.sort((a, b) => Number(b.findings.some(isError)) - Number(a.findings.some(isError)))
	}, [own, checked])
	const errors = groups.reduce((n, group) => n + group.findings.filter(f => f.level === 'error').length, 0)
	const warnings = groups.reduce((n, group) => n + group.findings.length, 0) - errors
	const checkedFiles = files.filter(file => file.json !== undefined && fileIdentity(file.path) !== undefined).length

	const name = fileName(data.id)
	const rule = ruleName(version.format)
	const inlined = version.format === 'legacy' && Object.keys(data.rules).length > 0
	const replaces = data.id.startsWith('minecraft:')
	const top = Number(data.settings?.noise?.min_y ?? 0) + Number(data.settings?.noise?.height ?? 256)
	const command = `/execute in ${data.id} run tp @s 0 ${top} 0`

	const download = async () => {
		setBusy(true)
		setFailure(undefined)
		try {
			if (!source) return
			await downloadPack(name, files)
		} catch (e) {
			setFailure(`The data pack could not be made: ${e instanceof Error ? e.message : String(e)}`)
		}
		setBusy(false)
	}

	return <div class="gx-editor gx-page">
		<div class="gx-page-inner">
			<section class="gx-card gx-export">
				<div>
					<h2>Download as a data pack</h2>
					<p>
						{data.id} for Minecraft {version.label}, with its biome, noises, densities, {rule}s, carvers, templates, features and placers as {editable ? 'they are in the editor now' : 'they are in this example'}.
					</p>
				</div>
				<button type="button" class="gx-btn gx-btn-filled" disabled={busy || !source} onClick={download}>
					{Ico.download}
					<span>Download {name}.zip</span>
				</button>
				{(failure ?? (loaded?.of === data ? loaded.error : undefined)) && <p class="gx-field-error" role="alert">{failure ?? loaded?.error}</p>}
				{errors > 0 && <p class="gx-note gx-export-note" role="note">
					<strong>The game is likely to refuse this pack</strong>
					<span>The checks below found {count(errors, 'problem', 'problems')}. {errors === 1 ? 'It' : 'Each of them'} can keep the pack from loading or crash the game. The pack can still be downloaded.</span>
				</p>}
			</section>

			{files.length > 0 && <section class="gx-card" aria-live="polite">
				<h3>Checks</h3>
				{errors + warnings === 0
					? (checking
						? <p class="gx-check-status" role="status"><span class="gx-spinner" aria-hidden="true" />Checking the files against the format of Minecraft {version.label}…</p>
						: <p class="gx-check-status gx-check-ok">{Ico.check}No problems found in the {count(checkedFiles, 'file', 'files')} of the pack.</p>)
					: <p class="gx-check-status">
						{errors > 0 && <strong>{count(errors, 'problem', 'problems')}</strong>}
						{errors > 0 && warnings > 0 && ' and '}
						{warnings > 0 && <span>{count(warnings, 'thing', 'things')} worth a look</span>}
						{checking && <span class="gx-muted"> · still checking against the format of the game…</span>}
					</p>}
				{groups.length > 0 && <ul class="gx-findings">
					{groups.map(group => {
						const target = targetOf(group.findings[0], data)
						return <li key={group.path}>
							<div class="gx-finding-file">
								{Ico.file}
								<span class="gx-mono">{group.path}</span>
								{target && <Button label="Open" onClick={() => onOpen(target)} />}
							</div>
							<ul>
								{group.findings.map((finding, i) => <li key={i} class={`gx-finding gx-finding-${finding.level}`}>
									<span class="gx-finding-level">{finding.level === 'error' ? 'Problem' : 'Worth a look'}</span>
									<span class="gx-finding-text">
										{finding.where !== '' && <span class="gx-mono">{finding.where}</span>}
										<span>{finding.message}</span>
									</span>
								</li>)}
							</ul>
						</li>
					})}
				</ul>}
				{checkError !== undefined && <p class="gx-note" role="note">
					<strong>The files could not be checked against the format of the game</strong>
					<span>{checkError} Only the checks of the editor itself were done.</span>
				</p>}
				<p class="gx-muted">
					Every file is checked against the format of Minecraft {version.label}, which is the check that the forms show their errors from, for ids of things that do not exist, and for a few things that the format allows and the game still refuses.
					The format is written by the community of the game, so now and then it is stricter than the game. And a pack without findings can still fail: not everything can be told from the files.
				</p>
			</section>}

			<section class="gx-card">
				<h3>In the data pack</h3>
				<ul class="gx-files">
					{files.map(file => <li key={file.path}>
						{Ico.file}
						<span class="gx-mono">{file.path}</span>
						<span class="gx-muted">{file.what}</span>
					</li>)}
				</ul>
				<p class="gx-muted">
					The pack has what the editor shows: the terrain of the final density with the blocks of the {rule}.
					{inlined && ' This version of the game has no surface rules with an id, so the rules that your surface rule runs are copied into it.'}
					{data.fromGame
						? ` The dimension is one biome all over, ${data.biomes[0]}, as the editor shows it. That biome and what this dimension uses of the game are in the game already, so the pack has no files for them.`
						: ' The dimension is one biome all over. The game carves and places features through biomes, so the biome lists the carvers and the placed features of the dimension.'}
					{replaces && ' Because the id is in the minecraft namespace, the pack replaces that dimension of the game.'}
				</p>
			</section>

			<section class="gx-card">
				<h3>Using it in the game</h3>
				<ol class="gx-steps">
					<li>Add the zip on the Data Packs screen while creating a world, or put it in the <span class="gx-mono">datapacks</span> folder of a world.</li>
					<li>The game only adds dimensions when a world is opened, so leave and open the world again if it was running.</li>
					<li>
						Go to the dimension with this command:
						<span class="gx-command">
							<code class="gx-mono">{command}</code>
							<CopyButton getText={() => command} label="Copy the command" />
						</span>
					</li>
				</ol>
			</section>
		</div>
	</div>
}
