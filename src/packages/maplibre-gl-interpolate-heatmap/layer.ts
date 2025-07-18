import earcut from 'earcut'
import maplibregl, { CustomLayerInterface } from 'maplibre-gl'

type Pt = { lat: number; lon: number; val: number }

type Opts = {
  id: string
  data: Pt[]
  framebufferFactor?: number
  maxValue?: number
  minValue?: number
  opacity?: number
  p?: number
  aoi?: { lat: number; lon: number }[]
  valueToColor?: string
  valueToColor4?: string
  textureCoverSameAreaAsROI?: boolean
  debug?: boolean
}

class MaplibreInterpolateHeatmapLayer implements CustomLayerInterface {
  /* ---------- user ---------- */
  id: string
  data: Pt[]
  framebufferFactor: number
  maxValue: number
  minValue: number
  opacity: number
  p: number
  aoi?: { lat: number; lon: number }[]
  valueToColor: string
  valueToColor4: string
  textureCoverSameAreaAsROI: boolean
  debug = false

  /* ---------- runtime ---------- */
  type: 'custom' = 'custom' as const
  canvas?: HTMLCanvasElement
  renderingMode: '2d' | '3d' = '2d'
  points: number[][] = []
  frame = 0

  /* ---------- GL handles (same list) ---------- */
  aPositionComputation = -1
  aPositionDraw = -1
  uMatrixComputation: WebGLUniformLocation | null = null
  uUi: WebGLUniformLocation | null = null
  uXi: WebGLUniformLocation | null = null
  uP: WebGLUniformLocation | null = null
  uFramebufferSize: WebGLUniformLocation | null = null
  uMatrixDraw: WebGLUniformLocation | null = null
  uComputationTexture: WebGLUniformLocation | null = null
  uScreenSizeDraw: WebGLUniformLocation | null = null
  uOpacity: WebGLUniformLocation | null = null
  computationProgram: WebGLProgram | null = null
  drawProgram: WebGLProgram | null = null
  computationVerticesBuffer: WebGLBuffer | null = null
  drawingVerticesBuffer: WebGLBuffer | null = null
  indicesBuffer: WebGLBuffer | null = null
  computationFramebuffer: WebGLFramebuffer | null = null
  computationTexture: WebGLTexture | null = null
  framebufferWidth = 0
  framebufferHeight = 0
  indicesNumber = 0
  resizeFramebuffer?: () => void

  /* ---------- logger ---------- */
  private log = (...a: unknown[]) =>
    this.debug && console.log('[Heatmap]', ...a)
  private err = (...a: unknown[]) =>
    this.debug && console.error('[Heatmap‑ERR]', ...a)

  private chk = (gl: WebGL2RenderingContext, stage: string) => {
    if (!this.debug) return
    const e = gl.getError()
    if (e !== gl.NO_ERROR) this.err('gl err 0x' + e.toString(16), '@', stage)
  }

  /* ---------- matrix util with extra logs ---------- */
  private readonly I4 = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ])
  private toF32 = (
    m: number[] | Float32Array | Float64Array | undefined,
    tag: string,
  ): Float32Array => {
    if (!m) {
      this.err(tag, 'matrix undefined → I4')
      return this.I4
    }

    // Check if it's already a Float32Array
    if (m instanceof Float32Array) {
      if (m.length < 16) {
        this.err(tag, 'matrix len', m.length, '<16 → I4')
        return this.I4
      }
      return m
    }

    // If it's a Float64Array, convert it to Float32Array
    if (m instanceof Float64Array) {
      const arr = new Float32Array(m)
      if (arr.length < 16) {
        this.err(tag, 'matrix len', arr.length, '<16 → I4')
        return this.I4
      }
      return arr
    }

    const arr = new Float32Array(m as any) // clone guarantees accepted buffer
    if (arr.length < 16) {
      this.err(tag, 'matrix len', arr.length, '<16 → I4')
      return this.I4
    }
    return arr
  }

  /* ---------- ctor ---------- */
  constructor(o: Opts) {
    this.debug = !!o.debug
    this.log('ctor opts', o)
    this.id = o.id
    this.data = o.data
    this.framebufferFactor = o.framebufferFactor ?? 0.3
    this.minValue = o.minValue ?? Infinity
    this.maxValue = o.maxValue ?? -Infinity
    this.opacity = o.opacity ?? 0.5
    this.p = o.p ?? 3
    this.aoi = o.aoi
    this.valueToColor =
      o.valueToColor ||
      `vec3 valueToColor(float v){return vec3(max((v-0.5)*2.0,0.),1.-2.*abs(v-0.5),max((0.5-v)*2.0,0.));}`
    this.valueToColor4 =
      o.valueToColor4 ||
      `vec4 valueToColor4(float v,float o){return vec4(valueToColor(v),o);}`
    this.textureCoverSameAreaAsROI = this.framebufferFactor === 1
  }

  /* ---------- onAdd (unchanged except logger lines kept) ---------- */
  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
    const gl2 = gl as unknown as WebGL2RenderingContext
    if (!(gl2 instanceof WebGL2RenderingContext))
      throw new Error('WebGL2 required')
    if (!gl2.getExtension('EXT_color_buffer_float'))
      throw new Error('EXT_color_buffer_float missing')
    this.canvas = map.getCanvas() as HTMLCanvasElement
    this.log('onAdd: canvas', this.canvas.width, this.canvas.height)

    /* ---------- shader src (same as previous) ---------- */
    const vSrc = `#version 300 es
precision highp float;
in vec2 a_Position;
uniform mat4 u_Matrix;
void main(){gl_Position=u_Matrix*vec4(a_Position,0.,1.);}`

    const fSrc = `#version 300 es
precision highp float;
${this.valueToColor}
${this.valueToColor4}
uniform sampler2D u_ComputationTexture;
uniform vec2 u_ScreenSize;
uniform float u_Opacity;
out vec4 fragColor;
void main(){
  vec2 uv=gl_FragCoord.xy/u_ScreenSize;
  vec4 d=texture(u_ComputationTexture,uv);
  float denom=max(d.y,1e-6);
  float u=d.x/denom;
  fragColor=valueToColor4(clamp(u,0.,1.),u_Opacity);
}`

    const cvSrc = `#version 300 es
precision highp float;
uniform mat4 u_Matrix;
uniform vec2 xi;
out vec2 xiN;
in vec2 a_Position;
void main(){
  vec4 p=u_Matrix*vec4(xi,0.,1.);
  xiN=p.xy/p.w;
  gl_Position=u_Matrix*vec4(a_Position,0.,1.);
}`

    const cfSrc = `#version 300 es
precision highp float;
uniform float ui;
uniform float p;
uniform vec2 u_FramebufferSize;
in vec2 xiN;
out vec4 fragColor;
void main(){
  vec2 x=gl_FragCoord.xy/u_FramebufferSize;
  vec2 xi=(xiN+1.)/2.;
  float dist=max(distance(x,xi),1e-4);
  float wi=1./pow(dist,p);
  fragColor=vec4(ui*wi,wi,0.,1.);
}`

    /* ---------- compile/link ---------- */
    const compProg = mkProg(gl2, cvSrc, cfSrc, this.log, this.err)
    const drawProg = mkProg(gl2, vSrc, fSrc, this.log, this.err)
    this.computationProgram = compProg
    this.drawProgram = drawProg

    /* ---------- lookups with warnings ---------- */
    const au = (name: string, prog: WebGLProgram) => {
      const loc = gl2.getUniformLocation(prog, name)
      if (!loc) this.err('uniform', name, 'is null')
      return loc
    }
    const aa = (name: string, prog: WebGLProgram) => {
      const loc = gl2.getAttribLocation(prog, name)
      if (loc === -1) this.err('attrib', name, 'is -1')
      return loc
    }

    this.aPositionComputation = aa('a_Position', compProg)
    this.uMatrixComputation = au('u_Matrix', compProg)
    this.uUi = au('ui', compProg)
    this.uXi = au('xi', compProg)
    this.uP = au('p', compProg)
    this.uFramebufferSize = au('u_FramebufferSize', compProg)

    this.aPositionDraw = aa('a_Position', drawProg)
    this.uMatrixDraw = au('u_Matrix', drawProg)
    this.uComputationTexture = au('u_ComputationTexture', drawProg)
    this.uScreenSizeDraw = au('u_ScreenSize', drawProg)
    this.uOpacity = au('u_Opacity', drawProg)

    /* ---------- buffers, FBO, normalization (same as previous) ---------- */
    const fsQuad = [
      maplibregl.MercatorCoordinate.fromLngLat({ lng: -180, lat: -85 }).x,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: -180, lat: -85 }).y,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: -180, lat: 85 }).x,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: -180, lat: 85 }).y,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: 180, lat: 85 }).x,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: 180, lat: 85 }).y,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: 180, lat: -85 }).x,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: 180, lat: -85 }).y,
    ]
    const drawVerts = this.aoi?.length
      ? this.aoi.flatMap(({ lat, lon }) => {
          const c = maplibregl.MercatorCoordinate.fromLngLat({ lat, lng: lon })
          return [c.x, c.y]
        })
      : fsQuad
    this.drawingVerticesBuffer = gl2.createBuffer()
    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.drawingVerticesBuffer)
    gl2.bufferData(
      gl2.ARRAY_BUFFER,
      new Float32Array(drawVerts),
      gl2.STATIC_DRAW,
    )

    const compVerts = this.textureCoverSameAreaAsROI ? drawVerts : fsQuad
    this.computationVerticesBuffer = gl2.createBuffer()
    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.computationVerticesBuffer)
    gl2.bufferData(
      gl2.ARRAY_BUFFER,
      new Float32Array(compVerts),
      gl2.STATIC_DRAW,
    )

    const inds = earcut(drawVerts)
    this.indicesNumber = inds.length
    this.indicesBuffer = gl2.createBuffer()
    gl2.bindBuffer(gl2.ELEMENT_ARRAY_BUFFER, this.indicesBuffer)
    gl2.bufferData(
      gl2.ELEMENT_ARRAY_BUFFER,
      new Uint8Array(inds),
      gl2.STATIC_DRAW,
    )
    this.log('drawVerts', drawVerts.length / 2, 'indices', this.indicesNumber)

    /* FBO */
    this.framebufferWidth = Math.ceil(
      this.canvas.width * this.framebufferFactor,
    )
    this.framebufferHeight = Math.ceil(
      this.canvas.height * this.framebufferFactor,
    )
    this.log('FBO', this.framebufferWidth, this.framebufferHeight)

    this.computationTexture = gl2.createTexture()
    gl2.bindTexture(gl2.TEXTURE_2D, this.computationTexture)
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE)
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE)
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.NEAREST)
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.NEAREST)
    gl2.texImage2D(
      gl2.TEXTURE_2D,
      0,
      gl2.RGBA32F,
      this.framebufferWidth,
      this.framebufferHeight,
      0,
      gl2.RGBA,
      gl2.FLOAT,
      null,
    )

    this.computationFramebuffer = gl2.createFramebuffer()
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, this.computationFramebuffer)
    gl2.framebufferTexture2D(
      gl2.FRAMEBUFFER,
      gl2.COLOR_ATTACHMENT0,
      gl2.TEXTURE_2D,
      this.computationTexture,
      0,
    )
    this.chk(gl2, 'FBO init')
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, null)

    /* normalize data */
    this.points = []
    let mn = Infinity
    let mx = -Infinity
    this.data.forEach(({ lat, lon, val }) => {
      const c = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat })
      this.points.push([c.x, c.y, val])
      mn = Math.min(mn, val)
      mx = Math.max(mx, val)
    })
    mn = Math.min(mn, this.minValue)
    mx = Math.max(mx, this.maxValue)
    this.points.forEach((p) => (p[2] = (p[2] - mn) / (mx - mn)))
    this.log('normalized', { mn, mx, pts: this.points.length })

    /* resize handler (same) */
    this.resizeFramebuffer = () => {
      this.framebufferWidth = Math.ceil(
        this.canvas!.width * this.framebufferFactor,
      )
      this.framebufferHeight = Math.ceil(
        this.canvas!.height * this.framebufferFactor,
      )
      gl2.bindTexture(gl2.TEXTURE_2D, this.computationTexture)
      gl2.texImage2D(
        gl2.TEXTURE_2D,
        0,
        gl2.RGBA32F,
        this.framebufferWidth,
        this.framebufferHeight,
        0,
        gl2.RGBA,
        gl2.FLOAT,
        null,
      )
      this.log('resize FBO', this.framebufferWidth, this.framebufferHeight)
    }
    map.on('resize', this.resizeFramebuffer)
  }
  /* ---------- prerender ---------- */
  prerender(gl: WebGLRenderingContext, matrix: number[] | Float32Array) {
    const gl2 = gl as unknown as WebGL2RenderingContext
    if (!this.computationProgram) return
    this.frame++

    gl2.useProgram(this.computationProgram)
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, this.computationFramebuffer)
    gl2.viewport(0, 0, this.framebufferWidth, this.framebufferHeight)
    gl2.clearColor(0, 0, 0, 0)
    gl2.clear(gl2.COLOR_BUFFER_BIT)

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.computationVerticesBuffer)
    gl2.enableVertexAttribArray(this.aPositionComputation)
    gl2.vertexAttribPointer(
      this.aPositionComputation,
      2,
      gl2.FLOAT,
      false,
      0,
      0,
    )

    /* ---- NEW detailed uniform debug ---- */
    this.log('u_MatrixComputation matrix before toF32', matrix)
    const mComp = this.toF32(matrix, 'u_MatrixComputation')

    if (this.uMatrixComputation) {
      this.log(
        'u_MatrixComputation',
        'F32?',
        mComp instanceof Float32Array,
        'len',
        mComp.length,
        'first4',
        Array.from(mComp.slice(0, 4)),
      )
      gl2.uniformMatrix4fv(this.uMatrixComputation, false, mComp)
      const e = gl2.getError()
      if (e) this.err('u_MatrixComputation glErr 0x' + e.toString(16))
    } else {
      this.err('skip u_MatrixComputation (null)')
    }

    gl2.uniform2f(
      this.uFramebufferSize!,
      this.framebufferWidth,
      this.framebufferHeight,
    )
    gl2.uniform1f(this.uP!, this.p)

    this.points.forEach(([xi, yi, ui], i) => {
      gl2.uniform2f(this.uXi!, xi, yi)
      gl2.uniform1f(this.uUi!, ui)
      if (i === 0) this.log('draw first point ui', ui)
      gl2.drawArrays(gl2.TRIANGLE_FAN, 0, 4)
    })

    gl2.bindFramebuffer(gl2.FRAMEBUFFER, null)
    this.chk(gl2, 'prerender frame ' + this.frame)
  }

  /* ---------- render ---------- */
  render(gl: WebGLRenderingContext, matrix: number[] | Float32Array) {
    const gl2 = gl as unknown as WebGL2RenderingContext
    if (!this.drawProgram) return
    gl2.useProgram(this.drawProgram)
    gl2.viewport(0, 0, gl2.drawingBufferWidth, gl2.drawingBufferHeight)

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.drawingVerticesBuffer)
    gl2.enableVertexAttribArray(this.aPositionDraw)
    gl2.vertexAttribPointer(this.aPositionDraw, 2, gl2.FLOAT, false, 0, 0)
    gl2.bindBuffer(gl2.ELEMENT_ARRAY_BUFFER, this.indicesBuffer)

    /* ---- Debugging before u_MatrixDraw ---- */
    this.log('u_MatrixDraw matrix before toF32', matrix)

    // Ensure the matrix passed is valid
    if (!matrix || matrix.length < 16) {
      this.err('Invalid matrix passed to render:', matrix)
      return
    }

    // Convert to Float32Array
    const mDraw = this.toF32(matrix, 'u_MatrixDraw')

    // Log detailed matrix information for further debugging
    this.log(
      'u_MatrixDraw matrix after toF32',
      mDraw instanceof Float32Array,
      'len',
      mDraw.length,
      'first4',
      Array.from(mDraw.slice(0, 4)),
    )

    if (this.uMatrixDraw) {
      gl2.uniformMatrix4fv(this.uMatrixDraw, false, mDraw)
      const e = gl2.getError()
      if (e) this.err('u_MatrixDraw glErr 0x' + e.toString(16))
    } else {
      this.err('skip u_MatrixDraw (null)')
    }

    gl2.uniform2f(
      this.uScreenSizeDraw!,
      gl2.drawingBufferWidth,
      gl2.drawingBufferHeight,
    )
    gl2.uniform1f(this.uOpacity!, this.opacity)
    gl2.activeTexture(gl2.TEXTURE0)
    gl2.bindTexture(gl2.TEXTURE_2D, this.computationTexture)
    gl2.uniform1i(this.uComputationTexture!, 0)
    gl2.drawElements(gl2.TRIANGLES, this.indicesNumber, gl2.UNSIGNED_BYTE, 0)

    this.chk(gl2, 'render frame ' + this.frame)
  }

  /* ---------- cleanup (same) ---------- */
  onRemove(map: maplibregl.Map, gl: WebGLRenderingContext) {
    const gl2 = gl as unknown as WebGL2RenderingContext
    map.off('resize', this.resizeFramebuffer!)
    ;[
      this.computationFramebuffer,
      this.computationTexture,
      this.computationVerticesBuffer,
      this.drawingVerticesBuffer,
      this.indicesBuffer,
      this.computationProgram,
      this.drawProgram,
    ].forEach(
      (r) =>
        r &&
        (gl2.deleteBuffer as any) &&
        (gl2.deleteTexture as any) &&
        (gl2.deleteProgram as any),
    )
    this.log('cleanup done')
  }
}

/* ---------- shader utils (unchanged) ---------- */
function mkProg(
  gl: WebGL2RenderingContext,
  v: string,
  f: string,
  log: (...a: unknown[]) => void,
  err: (...a: unknown[]) => void,
) {
  const vs = cmpSh(gl, gl.VERTEX_SHADER, v, log, err)
  const fs = cmpSh(gl, gl.FRAGMENT_SHADER, f, log, err)
  const p = gl.createProgram()!
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    err('link err', gl.getProgramInfoLog(p))
    throw new Error('link failed')
  }
  log('prog linked')
  return p
}

function cmpSh(
  gl: WebGL2RenderingContext,
  t: number,
  src: string,
  log: (...a: unknown[]) => void,
  err: (...a: unknown[]) => void,
) {
  const sh = gl.createShader(t)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    err('compile err', gl.getShaderInfoLog(sh))
    throw new Error('compile failed')
  }
  log(t === gl.VERTEX_SHADER ? 'vs ok' : 'fs ok')
  return sh
}

export { MaplibreInterpolateHeatmapLayer }
