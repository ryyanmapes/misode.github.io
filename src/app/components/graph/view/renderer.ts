import type { ChunkMesh, MeshPart, MeshTarget } from './slice.js'
import { VERTEX_BYTES } from './slice.js'

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
uniform mat4 uViewProj;
centroid out highp vec2 vUv;
out lowp vec4 vColor;

void main() {
	gl_Position = uViewProj * vec4(aPos, 1.0);
	vUv = aUv;
	vColor = aColor;
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
uniform vec4 uOverlay;
centroid in highp vec2 vUv;
in lowp vec4 vColor;
out vec4 outColor;

void main() {
	// Quads without a texture have a negative coordinate and only use their color
	vec4 texel = mix(vec4(1.0), texture(uAtlas, vUv), step(0.0, vUv.x));
	vec4 color = texel * vColor;
	if (color.a < 0.1) discard;
	// An overlay draws the shape in one color, for outlines
	outColor = uOverlay.a > 0.0 ? uOverlay : color;
}
`

interface Part {
	vao: WebGLVertexArrayObject
	buffer: WebGLBuffer
	quads: number
}

interface Chunk {
	opaque?: Part
	translucent?: Part
	marked?: Part
}

/** The color of the outline of highlighted blocks, where something hides them */
const OUTLINE = [0, 0.9, 1, 0.62]

/** Draws the meshes of a world slice with WebGL */
export class SliceRenderer implements MeshTarget {
	/** Called when what is drawn has changed */
	onChange: (() => void) | undefined

	private readonly gl: WebGL2RenderingContext
	private readonly program: WebGLProgram
	private readonly viewProj: WebGLUniformLocation | null
	private readonly overlay: WebGLUniformLocation | null
	private readonly indices: WebGLBuffer
	private indexedQuads = 0
	private readonly white: WebGLTexture
	private atlas: WebGLTexture | undefined
	private readonly chunks = new Map<number, Chunk>()

	constructor(canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, stencil: true })
		if (!gl) throw new Error('This browser cannot show the 3D view, because WebGL 2 is not available')
		this.gl = gl
		this.program = this.createProgram()
		this.viewProj = gl.getUniformLocation(this.program, 'uViewProj')
		this.overlay = gl.getUniformLocation(this.program, 'uOverlay')
		this.indices = gl.createBuffer()!
		this.white = gl.createTexture()!
		gl.bindTexture(gl.TEXTURE_2D, this.white)
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
	}

	private createProgram() {
		const { gl } = this
		const program = gl.createProgram()!
		for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
			const shader = gl.createShader(type)!
			gl.shaderSource(shader, source)
			gl.compileShader(shader)
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				throw new Error(`The 3D view could not start: ${gl.getShaderInfoLog(shader)}`)
			}
			gl.attachShader(program, shader)
		}
		gl.linkProgram(program)
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			throw new Error(`The 3D view could not start: ${gl.getProgramInfoLog(program)}`)
		}
		return program
	}

	/** The image with all block textures, or nothing to draw blocks in their colors only */
	setAtlas(image: ImageData | undefined) {
		const { gl } = this
		if (this.atlas) gl.deleteTexture(this.atlas)
		this.atlas = undefined
		if (image) {
			this.atlas = gl.createTexture()!
			gl.bindTexture(gl.TEXTURE_2D, this.atlas)
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
			// Block textures are 16 pixels wide, so smaller versions than one pixel for each would mix neighbours
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 4)
			gl.generateMipmap(gl.TEXTURE_2D)
		}
		this.onChange?.()
	}

	private deletePart(part: Part | undefined) {
		if (!part) return
		this.gl.deleteVertexArray(part.vao)
		this.gl.deleteBuffer(part.buffer)
	}

	/** All quads use the same indices, two triangles for each four corners */
	private growIndices(quads: number) {
		if (quads <= this.indexedQuads) return
		const { gl } = this
		const count = Math.max(quads, this.indexedQuads * 2, 4096)
		const data = new Uint32Array(count * 6)
		for (let i = 0; i < count; i += 1) {
			data.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6)
		}
		gl.bindVertexArray(null)
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices)
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW)
		this.indexedQuads = count
	}

	private createPart(mesh: MeshPart): Part | undefined {
		if (mesh.quads === 0) return undefined
		const { gl } = this
		this.growIndices(mesh.quads)
		const vao = gl.createVertexArray()!
		const buffer = gl.createBuffer()!
		gl.bindVertexArray(vao)
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
		gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW)
		gl.enableVertexAttribArray(0)
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_BYTES, 0)
		gl.enableVertexAttribArray(1)
		gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_BYTES, 12)
		gl.enableVertexAttribArray(2)
		gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 20)
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices)
		gl.bindVertexArray(null)
		return { vao, buffer, quads: mesh.quads }
	}

	setChunk(key: number, mesh: ChunkMesh | undefined) {
		const old = this.chunks.get(key)
		this.deletePart(old?.opaque)
		this.deletePart(old?.translucent)
		this.deletePart(old?.marked)
		if (mesh) {
			this.chunks.set(key, { opaque: this.createPart(mesh.opaque), translucent: this.createPart(mesh.translucent), marked: this.createPart(mesh.marked) })
		} else {
			this.chunks.delete(key)
		}
		this.onChange?.()
	}

	clear() {
		for (const chunk of this.chunks.values()) {
			this.deletePart(chunk.opaque)
			this.deletePart(chunk.translucent)
			this.deletePart(chunk.marked)
		}
		this.chunks.clear()
		this.onChange?.()
	}

	draw(viewProj: Float32Array, background: [number, number, number]) {
		const { gl } = this
		gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
		gl.clearColor(background[0], background[1], background[2], 1)
		gl.depthMask(true)
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
		gl.useProgram(this.program)
		gl.uniformMatrix4fv(this.viewProj, false, viewProj)
		gl.uniform4f(this.overlay, 0, 0, 0, 0)
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, this.atlas ?? this.white)
		gl.enable(gl.DEPTH_TEST)
		gl.depthFunc(gl.LEQUAL)
		gl.enable(gl.CULL_FACE)
		gl.disable(gl.BLEND)
		for (const chunk of this.chunks.values()) {
			this.drawPart(chunk.opaque)
		}
		// What can be seen through comes last and leaves the depth alone, so it never hides what is behind it
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
		gl.depthMask(false)
		for (const chunk of this.chunks.values()) {
			this.drawPart(chunk.translucent)
		}
		this.drawOutlines()
		gl.depthMask(true)
		gl.bindVertexArray(null)
	}

	/**
	 * Shows the highlighted blocks through what hides them. Where they can be seen they stay as they are,
	 * and where they are hidden every pixel of them gets the outline color once.
	 */
	private drawOutlines() {
		const { gl } = this
		let any = false
		for (const chunk of this.chunks.values()) {
			if (chunk.marked) any = true
		}
		if (!any) return
		gl.enable(gl.STENCIL_TEST)
		gl.clearStencil(0)
		gl.clear(gl.STENCIL_BUFFER_BIT)
		gl.uniform4f(this.overlay, OUTLINE[0], OUTLINE[1], OUTLINE[2], OUTLINE[3])
		// The outlined blocks are drawn a second time here. Pulled a little towards the camera, a side that is in
		// front never counts as hidden because of how its depth was rounded, which showed as specks on blocks in the open.
		gl.enable(gl.POLYGON_OFFSET_FILL)
		gl.polygonOffset(-2, -6)
		// First remember where the highlighted blocks are in front
		gl.colorMask(false, false, false, false)
		gl.depthFunc(gl.LEQUAL)
		gl.stencilFunc(gl.ALWAYS, 1, 0xff)
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
		for (const chunk of this.chunks.values()) {
			this.drawPart(chunk.marked)
		}
		// Then color the rest of them, which is behind something
		gl.colorMask(true, true, true, true)
		gl.depthFunc(gl.GREATER)
		gl.stencilFunc(gl.EQUAL, 0, 0xff)
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR)
		for (const chunk of this.chunks.values()) {
			this.drawPart(chunk.marked)
		}
		gl.disable(gl.POLYGON_OFFSET_FILL)
		gl.disable(gl.STENCIL_TEST)
		gl.depthFunc(gl.LEQUAL)
		gl.uniform4f(this.overlay, 0, 0, 0, 0)
	}

	private drawPart(part: Part | undefined) {
		if (!part) return
		this.gl.bindVertexArray(part.vao)
		this.gl.drawElements(this.gl.TRIANGLES, part.quads * 6, this.gl.UNSIGNED_INT, 0)
	}

	dispose() {
		this.onChange = undefined
		this.clear()
		const { gl } = this
		if (this.atlas) gl.deleteTexture(this.atlas)
		gl.deleteTexture(this.white)
		gl.deleteBuffer(this.indices)
		gl.deleteProgram(this.program)
	}
}
