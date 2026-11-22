import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Store } from '../../Store.js'
import { colorizeDensity, colormapGradient } from './density/render.js'
import { Ico } from './icons.jsx'
import { useSessionState } from './session.js'
import type { GraphFormat } from './types.js'
import { CopyButton, Field, formatNumber, IconButton, Lockable, NumberField, Section, Select, Slider } from './ui.jsx'
import type { NoiseShape, WorldgenEnv } from './worldgen.js'
import { createDensitySampler } from './worldgen.js'

/** A noise the way the editor shows it, whatever the version calls its fields */
interface NoiseModel {
	/** The octave of the largest features. Each next octave has features of half the size. */
	first: number
	/** How strong each octave is, starting at the first one */
	amplitudes: number[]
	/** Since 26.3: scales the whole noise */
	base: number
	/** Since 26.3: whether and how the strength is evened out. Empty when the file does not say. */
	normalize: string
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numbers(value: unknown): number[] {
	return Array.isArray(value) ? value.map(v => typeof v === 'number' ? v : 0) : []
}

/** Before 26.3 a noise is its first octave and a list of amplitudes. Since then, the amplitudes are optional factors for a number of octaves. */
function readNoise(json: unknown, format: GraphFormat): NoiseModel {
	const root = isObject(json) ? json : {}
	if (format === 'legacy') {
		return { first: typeof root.firstOctave === 'number' ? root.firstOctave : 0, amplitudes: numbers(root.amplitudes), base: 1, normalize: '' }
	}
	const count = typeof root.octave_count === 'number' ? Math.max(0, Math.round(root.octave_count)) : 1
	const modifiers = numbers(root.amplitude_modifiers)
	return {
		first: typeof root.base_octave === 'number' ? root.base_octave : 0,
		amplitudes: Array.from({ length: count }, (_, i) => modifiers[i] ?? 1),
		base: typeof root.base_amplitude === 'number' ? root.base_amplitude : 1,
		normalize: typeof root.normalize === 'boolean' ? (root.normalize ? 'enabled' : 'disabled') : typeof root.normalize === 'string' ? root.normalize : '',
	}
}

/** The file of a noise. Fields that the editor does not know are kept. */
function writeNoise(model: NoiseModel, format: GraphFormat, previous: unknown): unknown {
	const rest = isObject(previous) ? previous : {}
	if (format === 'legacy') {
		return { ...rest, firstOctave: model.first, amplitudes: model.amplitudes }
	}
	const { amplitude_modifiers: _modifiers, normalize: _normalize, ...kept } = rest
	return {
		...kept,
		// The game takes every octave at full strength when the factors are left out
		...(model.amplitudes.some(a => a !== 1) ? { amplitude_modifiers: model.amplitudes } : {}),
		base_amplitude: model.base,
		base_octave: model.first,
		octave_count: model.amplitudes.length,
		...(model.normalize !== '' ? { normalize: model.normalize } : {}),
	}
}

/** How large the features of an octave are, in blocks */
function featureSize(octave: number) {
	const size = Math.pow(2, -octave)
	return size >= 1 ? `${formatNumber(size)} block${size === 1 ? '' : 's'}` : `1/${formatNumber(1 / size)} block`
}

const PREVIEW = 192
const ZOOMS = [1, 2, 4, 8, 16, 32]

interface Props {
	id: string
	/** The noise file */
	json: unknown
	format: GraphFormat
	/** Whether the noise is part of a dimension of your own, which can be changed */
	editable: boolean
	env: WorldgenEnv | undefined
	shape: NoiseShape
	seed: bigint
	onNewSeed: () => void
	onChange: (json: unknown) => void
}
/** A noise as a list of octaves, with a look at what it gives */
export function NoiseEditor({ id, json, format, editable, env, shape, seed, onNewSeed, onChange }: Props) {
	const model = useMemo(() => readNoise(json, format), [json, format])
	const change = (patch: Partial<NoiseModel>) => onChange(writeNoise({ ...model, ...patch }, format, json))
	const text = useMemo(() => JSON.stringify(json, null, 2), [json])
	const modern = format === 'modern'
	const amount = modern ? 'Strength' : 'Amplitude'

	return <div class="gx-editor gx-page">
		<div class="gx-page-inner gx-noise">
			<div class="gx-page-head">
				<span class="gx-page-icon">{Ico.wave}</span>
				<div>
					<h2 class="gx-mono">{id}</h2>
					<p>A noise is a sum of octaves. The first octave has the largest features, and each next one has features of half the size.</p>
				</div>
			</div>

			<section class="gx-card gx-noise-preview">
				<NoisePreview id={id} json={json} env={env} shape={shape} seed={seed} onNewSeed={onNewSeed} />
			</section>

			<section class="gx-card">
				<h3>Octaves</h3>
				<Lockable locked={!editable}>
					<Field label="First octave" hint="The octave with the largest features. Octave −6 has features of about 64 blocks, −7 of about 128 blocks.">
						{fieldId => <>
							<NumberField id={fieldId} label="First octave" int value={model.first} onChange={first => change({ first })} />
							<span class="gx-muted">Features of about {featureSize(model.first)}</span>
						</>}
					</Field>
					{modern && <Field label="Base amplitude" hint="Makes the whole noise stronger or weaker">
						{fieldId => <>
							<NumberField id={fieldId} label="Base amplitude" value={model.base} onChange={base => change({ base })} />
							<Slider class="gx-field-slider" label="Base amplitude" min={0} max={2} step={0.01} value={model.base} onChange={base => change({ base })} />
						</>}
					</Field>}
					{modern && <Field label="Normalize" hint="Whether the octaves are evened out so the noise stays in about the same range, however many octaves it has">
						{fieldId => <Select id={fieldId} label="Normalize" value={model.normalize} onChange={normalize => change({ normalize })}
							options={[
								{ value: '', label: 'Default (enabled)' },
								{ value: 'enabled', label: 'Enabled' },
								{ value: 'disabled', label: 'Disabled' },
								{ value: 'legacy', label: 'Legacy' },
							]} />}
					</Field>}
					<ol class="gx-octaves" aria-label="Octaves">
						{model.amplitudes.map((amplitude, i) => {
							const label = `${amount} of octave ${model.first + i}`
							const set = (value: number) => change({ amplitudes: model.amplitudes.map((a, j) => j === i ? value : a) })
							return <li key={i} class={amplitude === 0 ? 'is-off' : ''}>
								<span class="gx-octave-name">
									<strong>Octave {model.first + i}</strong>
									<span class="gx-muted">{amplitude === 0 ? 'Left out' : featureSize(model.first + i)}</span>
								</span>
								<NumberField label={label} value={amplitude} onChange={set} />
								<Slider class="gx-field-slider" label={label} min={0} max={2} step={0.01} value={amplitude} onChange={set} />
								<IconButton icon={Ico.trash} label={`Remove octave ${model.first + i}`} tipSide="left"
									onClick={() => change({ amplitudes: model.amplitudes.filter((_, j) => j !== i) })} />
							</li>
						})}
					</ol>
					{model.amplitudes.length === 0 && <p class="gx-muted">A noise without octaves is 0 everywhere.</p>}
					<div class="gx-octave-add">
						<button type="button" class="gx-btn gx-btn-tonal" onClick={() => change({ amplitudes: [...model.amplitudes, 1] })}>
							{Ico.plus}
							<span>Add octave</span>
						</button>
						<span class="gx-muted">{amount} 0 leaves an octave out, which is how a noise skips sizes.</span>
					</div>
				</Lockable>
			</section>

			<section class="gx-card">
				<Section title="JSON" collapsible defaultOpen={false} actions={<CopyButton getText={() => text} />}>
					<pre class="gx-json" tabIndex={0}>{text}</pre>
				</Section>
			</section>
		</div>
	</div>
}

interface PreviewProps {
	id: string
	json: unknown
	env: WorldgenEnv | undefined
	shape: NoiseShape
	seed: bigint
	onNewSeed: () => void
}
/** The noise from above, at the bottom of the world */
function NoisePreview({ id, json, env, shape, seed, onNewSeed }: PreviewProps) {
	const canvas = useRef<HTMLCanvasElement>(null)
	const [zoom, setZoom] = useSessionState('noise.zoom', 2)
	const [result, setResult] = useState<{ min: number, max: number } | { error: string }>()
	const colormap = Store.getColormap() ?? 'viridis'

	useEffect(() => {
		if (!env) return
		// The preview follows a moment after typing or dragging a slider stops
		const timeout = setTimeout(() => {
			const el = canvas.current
			if (!el) return
			try {
				// The noise is read by its id, the same way as a density function of the dimension reads it
				const sample = createDensitySampler(env, { type: 'minecraft:noise', noise: id, xz_scale: 1, y_scale: 1 }, seed, shape)
				const values = new Float32Array(PREVIEW * PREVIEW)
				const half = PREVIEW / 2
				for (let z = 0; z < PREVIEW; z += 1) {
					for (let x = 0; x < PREVIEW; x += 1) {
						values[z * PREVIEW + x] = sample((x - half) * zoom, 0, (z - half) * zoom)
					}
				}
				const image = new ImageData(PREVIEW, PREVIEW)
				const range = colorizeDensity(values, image.data, colormap)
				el.getContext('2d')?.putImageData(image, 0, 0)
				setResult({ min: range.min, max: range.max })
			} catch (e) {
				setResult({ error: e instanceof Error ? e.message : String(e) })
			}
		}, 60)
		return () => clearTimeout(timeout)
	}, [env, id, json, seed, shape, zoom, colormap])

	const failed = result && 'error' in result ? result.error : undefined
	const span = PREVIEW * zoom

	return <>
		<div class="gx-noise-preview-head">
			<h3>Preview</h3>
			<label class="gx-inline-field">
				<span>Blocks per pixel</span>
				<Select label="Blocks per pixel of the preview" class="gx-select-compact" value={String(zoom)} onChange={value => setZoom(Number(value))}
					options={ZOOMS.map(z => ({ value: String(z), label: String(z) }))} />
			</label>
			<IconButton icon={Ico.seed} label="New random seed" tipSide="left" onClick={onNewSeed} />
		</div>
		<div class="gx-noise-canvas">
			<canvas ref={canvas} width={PREVIEW} height={PREVIEW} role="img" aria-label={`${id} seen from above, ${span} by ${span} blocks`} />
			{!env && <div class="gx-preview-message">Loading world generation…</div>}
			{failed && <div class="gx-preview-message is-error" role="alert">
				<strong>Cannot preview this noise</strong>
				<span>{failed}</span>
			</div>}
		</div>
		<div class="gx-noise-legend">
			<span class="gx-noise-scale" style={{ background: colormapGradient(colormap) }} />
			<span class="gx-muted">
				{result && !('error' in result)
					? `${span} by ${span} blocks seen from above. Values from ${formatNumber(Number(result.min.toFixed(3)))} to ${formatNumber(Number(result.max.toFixed(3)))}.`
					: `${span} by ${span} blocks seen from above.`}
			</span>
		</div>
	</>
}
