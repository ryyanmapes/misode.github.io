import { useEffect, useMemo, useState } from 'preact/hooks'
import type { PackSource } from './datapack.js'
import { downloadPack, fileName, loadPackSource, packFiles } from './datapack.js'
import { Ico } from './icons.jsx'
import type { AnyDimension } from './items.js'
import { ruleName } from './material/schema.js'
import type { GraphVersion } from './presets.js'
import { CopyButton } from './ui.jsx'

interface Props {
	version: GraphVersion
	/** The dimension as it is now, with its graphs, which is what the data pack gets */
	data: AnyDimension
	editable: boolean
}
/** Offers the dimension as a data pack, and tells what is in it */
export function ExportPanel({ version, data, editable }: Props) {
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
			</section>

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
