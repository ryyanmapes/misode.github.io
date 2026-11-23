import type { CheckerContext, DocAndNode, Range } from '@spyglassmc/core'
import type { JsonNode } from '@spyglassmc/json'
import { JsonArrayNode, JsonFileNode, JsonObjectNode, JsonStringNode } from '@spyglassmc/json'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useSpyglass } from '../../contexts/Spyglass.jsx'
import { useVersion } from '../../contexts/Version.jsx'
import type { SpyglassService } from '../../services/Spyglass.js'
import type { VersionId } from '../../services/Versions.js'
import { getRootType, simplifyType } from '../generator/McdocHelpers.js'
import type { McdocContext, McdocEmbed } from '../generator/McdocRenderer.jsx'
import { knownKeys, McdocEmbedContext, McdocRoot } from '../generator/McdocRenderer.jsx'
import { blockPicture, loadedBlockPicture } from './blockPicture.js'
import { blockCss } from './material/blocks.js'

// The generators of the site have one service for the version that the site is set to.
// A dimension can be of another version, which then gets a service of its own, made once.
const services = new Map<VersionId, Promise<SpyglassService>>()

/** The service that checks JSON against the format of a version of the game. It takes a moment to be there. */
export function useService(version: VersionId) {
	const { client, service: shared, serviceLoading } = useSpyglass()
	const { version: siteVersion } = useVersion()
	const [state, setState] = useState<{ version: VersionId, service?: SpyglassService, error?: string }>({ version })
	useEffect(() => {
		// Keeping the same state when nothing changed means this never causes another render
		const done = (service: SpyglassService) => setState(prev => prev.version === version && prev.service === service ? prev : { version, service })
		if (shared?.version === version) {
			done(shared)
			return
		}
		// The service of the site is on its way. A second one for the same version would be swapped for it in the middle of editing.
		if (siteVersion === version && serviceLoading) return
		let promise = services.get(version)
		if (!promise) {
			promise = client.createService(version)
			promise.catch(() => services.delete(version))
			services.set(version, promise)
		}
		let cancelled = false
		promise.then(service => {
			if (!cancelled) done(service)
		}, e => {
			if (!cancelled) setState({ version, error: e instanceof Error ? e.message : String(e) })
		})
		return () => {
			cancelled = true
		}
	}, [client, shared, serviceLoading, siteVersion, version])
	return state.version === version ? state : { version }
}

/** The picture of a block, as the game shows it in the inventory. Until it is drawn, and for blocks without one, the color of the block. */
function BlockPicture({ version, id }: { version: VersionId, id: string }) {
	const [picture, setPicture] = useState<{ of: string, src: string | undefined }>(() => ({ of: id, src: loadedBlockPicture(version, id) }))
	useEffect(() => {
		let cancelled = false
		blockPicture(version, id).then(src => {
			// Keeping the same state when nothing changed means this never causes another render
			if (!cancelled) setPicture(prev => prev.of === id && prev.src === src ? prev : { of: id, src })
		})
		return () => {
			cancelled = true
		}
	}, [version, id])
	const src = picture.of === id ? picture.src : loadedBlockPicture(version, id)
	return <label class="gx-tree-picture">
		{src
			? <img src={src} alt="" draggable={false} />
			: <span class="gx-swatch" style={{ background: blockCss(id) }} />}
	</label>
}

type Path = (string | number)[]

/** What the form made of an object: its keys in their order, its texts, and which keys its type has a field for */
interface Seen {
	path: Path
	keys: string[]
	texts: Map<string, string>
	known: { keys: Set<string>, open: boolean } | undefined
}

/** Every object of a checked document, by where it is */
function seeObjects(node: JsonNode | undefined, ctx: CheckerContext, path: Path = [], into = new Map<string, Seen>()) {
	if (JsonObjectNode.is(node)) {
		const seen: Seen = { path, keys: [], texts: new Map(), known: knownKeys(node, ctx) }
		into.set(JSON.stringify(path), seen)
		for (const pair of node.children) {
			if (!pair.key) continue
			seen.keys.push(pair.key.value)
			if (JsonStringNode.is(pair.value)) seen.texts.set(pair.key.value, pair.value.value)
			seeObjects(pair.value, ctx, [...path, pair.key.value], into)
		}
	} else if (JsonArrayNode.is(node)) {
		node.children.forEach((item, i) => seeObjects(item.value, ctx, [...path, i], into))
	}
	return into
}

/**
 * The fields that an edit left behind. When a text of an object changes, such as its type or the id of its block, the object
 * and what is inside of it can stop having fields that they had before. Those would stay as unknown keys.
 * Keys that were unknown before, and objects whose keys changed, are left alone.
 */
function leftBehind(before: Map<string, Seen>, after: Map<string, Seen>): { path: Path, keys: string[] }[] {
	const same = (id: string, now: Seen) => {
		const was = before.get(id)
		return was !== undefined && was.keys.length === now.keys.length && was.keys.every((key, i) => key === now.keys[i]) ? was : undefined
	}
	const changed = new Set<string>()
	for (const [id, now] of after) {
		const was = same(id, now)
		if (was && [...now.texts].some(([key, text]) => was.texts.has(key) && was.texts.get(key) !== text)) changed.add(id)
	}
	if (changed.size === 0) return []
	const result: { path: Path, keys: string[] }[] = []
	for (const [id, now] of after) {
		const was = same(id, now)
		const had = was?.known
		const has = now.known
		if (!had || !has || has.open) continue
		if (!changed.has(id) && !now.path.some((_, i) => changed.has(JSON.stringify(now.path.slice(0, i))))) continue
		const keys = now.keys.filter(key => (had.open || had.keys.has(key)) && !has.keys.has(key))
		if (keys.length > 0) result.push({ path: now.path, keys })
	}
	return result
}

function rootOf(file: DocAndNode['node'] | undefined): JsonNode | undefined {
	const jsonFile = file?.children[0]
	return JsonFileNode.is(jsonFile) ? jsonFile.children[0] : undefined
}

/** What an id of a block looks like, so the pictures are only asked for once an id is typed in full */
const BLOCK_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/

interface Props {
	/** What the JSON is, as the generators of the site call it: for example worldgen/placed_feature */
	generator: string
	version: VersionId
	/** Tells apart the things that are edited, so each has its own document. Only letters, digits and underscores. */
	name: string
	value: unknown
	onChange: (value: unknown) => void
	/** The ids that exist, by registry. A field that refers to one of these registries is a dropdown of them. */
	options?: Record<string, string[]>
	/** The blocks of a block tag, to show what a tag stands for */
	blockTag?: (id: string) => ReadonlySet<string>
	/** Fields at the top of the form that are left out, because they are edited somewhere else. The same list every time. */
	hide?: string[]
}
/**
 * The form of the generators of this site, for a piece of JSON that the graph editor holds.
 * It shows every field that the game knows, with its choices and its errors.
 */
export function TreeEditor({ generator, version, name, value, onChange, options, blockTag, hide }: Props) {
	// How the form differs here from the generator pages of the site
	const embed = useMemo<McdocEmbed>(() => ({
		options: registry => options?.[registry],
		hideRootFields: hide,
		// A reference is to something of this dimension or of the game, which the generator pages do not have
		noLinks: true,
		preview: (registry, id, tags) => {
			if (registry !== 'block' || tags === 'implicit' || id === '' || id.startsWith('#')) return null
			const full = id.includes(':') ? id : `minecraft:${id}`
			return BLOCK_ID.test(full) ? <BlockPicture version={version} id={full} /> : null
		},
		hint: (registry, text, tags) => {
			if (registry !== 'block' || !blockTag || text === '' || !(text.startsWith('#') || tags === 'implicit')) return undefined
			const blocks = [...blockTag(text.replace(/^#/, ''))].map(id => id.replace(/^minecraft:/, '')).sort()
			return blocks.length > 0
				? `${blocks.length} block${blocks.length === 1 ? '' : 's'} in this tag: ${blocks.join(', ')}`
				: 'This tag has no blocks, or the game does not have it'
		},
	}), [options, blockTag, version, hide])
	const { service, error } = useService(version)
	// The form works on a document. Its address has the shape of a file in a data pack, which is how the kind of JSON is recognised.
	const uri = `file:///root/graph/${version}/data/graph/${generator}/${name}.json`
	const [opened, setOpened] = useState<{ service: SpyglassService, uri: string, docAndNode: DocAndNode }>()
	/** The JSON that the document has, to tell changes of the form from changes of the value */
	const current = useRef<{ service: SpyglassService, uri: string, text: string }>()
	const latest = useRef(onChange)
	latest.current = onChange

	// The value goes into the document
	useEffect(() => {
		if (!service) return
		const text = JSON.stringify(value)
		// Each service has its own documents, so another service has to open this one as well
		if (current.current?.service === service && current.current.uri === uri && current.current.text === text) return
		current.current = { service, uri, text }
		let cancelled = false
		void (async () => {
			await service.writeFile(uri, JSON.stringify(value, null, 2))
			const docAndNode = await service.openFile(uri)
			if (!cancelled && docAndNode) setOpened({ service, uri, docAndNode })
		})()
		return () => {
			cancelled = true
		}
	}, [service, uri, value])

	// What the form changes comes out of the document
	useEffect(() => {
		if (!service) return
		const handler = (updated: DocAndNode) => {
			setOpened({ service, uri, docAndNode: updated })
			let parsed: unknown
			try {
				parsed = JSON.parse(updated.doc.getText())
			} catch (e) {
				return
			}
			const text = JSON.stringify(parsed)
			if (current.current?.uri === uri && current.current.text === text) return
			current.current = { service, uri, text }
			latest.current(parsed)
		}
		service.watchFile(uri, handler)
		return () => service.unwatchFile(uri, handler)
	}, [service, uri])

	const docAndNode = opened?.uri === uri && opened.service === service ? opened.docAndNode : undefined

	const makeEdit = useCallback((edit: (range: Range) => JsonNode | undefined) => {
		if (!service || !docAndNode) return
		const uri = docAndNode.doc.uri
		// The edit changes the document in place, so what it was is noted first
		const before = seeObjects(rootOf(docAndNode.node), service.getCheckerContext(docAndNode.doc))
		void (async () => {
			const checked = await service.applyEdit(uri, fileNode => {
				const jsonFile = fileNode.children[0]
				if (JsonFileNode.is(jsonFile)) {
					const newNode = edit(jsonFile.children[0].range)
					if (newNode !== undefined) {
						newNode.parent = fileNode
						fileNode.children[0] = newNode
					}
				}
			})
			// Another type has other fields. The ones of the old type go, as a part of the same edit.
			const stale = checked ? leftBehind(before, seeObjects(rootOf(checked.node), service.getCheckerContext(checked.doc))) : []
			if (stale.length === 0) return
			await service.applyEdit(uri, fileNode => {
				for (const { path, keys } of stale) {
					let target = rootOf(fileNode)
					for (const step of path) {
						target = JsonObjectNode.is(target) ? target.children.find(pair => pair.key?.value === step)?.value
							: JsonArrayNode.is(target) && typeof step === 'number' ? target.children[step]?.value
								: undefined
					}
					if (!JsonObjectNode.is(target)) continue
					for (let i = target.children.length - 1; i >= 0; i -= 1) {
						const key = target.children[i].key?.value
						if (key !== undefined && keys.includes(key)) target.children.splice(i, 1)
					}
				}
			}, true)
		})()
	}, [service, docAndNode])

	const context = useMemo<McdocContext | undefined>(() => {
		if (!service || !docAndNode) return undefined
		const { node } = docAndNode
		const errors = [...node.binderErrors ?? [], ...node.checkerErrors ?? [], ...node.linterErrors ?? []]
		return { ...service.getCheckerContext(docAndNode.doc, errors), makeEdit }
	}, [service, docAndNode, makeEdit])

	const type = useMemo(() => context && simplifyType(getRootType(generator), context), [context, generator])

	const undo = (e: KeyboardEvent) => {
		if (!service || !(e.ctrlKey || e.metaKey) || e.altKey) return
		const key = e.key.toLowerCase()
		if (key !== 'z' && key !== 'y') return
		// Text fields undo their own typing
		if ((e.target as HTMLElement).matches('input, textarea')) return
		e.preventDefault()
		if (key === 'y' || e.shiftKey) void service.redoEdit(uri)
		else void service.undoEdit(uri)
	}

	if (error) {
		return <div class="gx-status" role="alert">
			<h2>The editor could not be loaded</h2>
			<p>{error}</p>
		</div>
	}
	const fileNode = docAndNode?.node.children[0]
	if (!context || !type || !JsonFileNode.is(fileNode)) {
		return <div class="gx-status" role="status">
			<span class="gx-spinner" aria-hidden="true" />
			<p>Loading the editor…</p>
		</div>
	}
	return <div class="file-view node-root gx-tree" onKeyDown={undo}>
		<McdocEmbedContext.Provider value={embed}>
			<McdocRoot type={type} node={fileNode.children[0]} ctx={context} />
		</McdocEmbedContext.Provider>
	</div>
}
