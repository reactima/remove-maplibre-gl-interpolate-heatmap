import earcut from 'earcut'
import maplibregl, { CustomLayerInterface } from 'maplibre-gl'

type MaplibreInterpolateHeatmapLayerOptions = {
  id: string
  data: { lat: number; lon: number; val: number }[]
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
  id: string
  data: { lat: number; lon: number; val: number }[]
  framebufferFactor: number
  maxValue: number
  minValue: number
  opacity: number
  p: number
  aoi?: { lat: number; lon: number }[]
  valueToColor?: string
  valueToColor4?: string
  textureCoverSameAreaAsROI: boolean
  points: number[][] = []
  // Custom Props
  aPositionComputation?: number
  aPositionDraw?: number
  canvas?: HTMLCanvasElement
  computationFramebuffer: WebGLFramebuffer | null = null
  computationProgram: WebGLProgram | null = null
  computationTexture: WebGLTexture | null = null
  computationVerticesBuffer: WebGLBuffer | null = null
  drawingVerticesBuffer: WebGLBuffer | null = null
  drawProgram: WebGLProgram | null = null
  framebufferHeight?: number
  framebufferWidth?: number
  indicesBuffer: WebGLBuffer | null = null
  indicesNumber: number | null = null
  renderingMode: '2d' | '3d' = '2d'
  resizeFramebuffer?: () => void
  type: 'custom' = 'custom' as const
  uComputationTexture: WebGLUniformLocation | null = null
  uFramebufferSize: WebGLUniformLocation | null = null
  uMatrixComputation: WebGLUniformLocation | null = null
  uMatrixDraw: WebGLUniformLocation | null = null
  uOpacity: WebGLUniformLocation | null = null
  uP: WebGLUniformLocation | null = null
  uScreenSizeDraw: WebGLUniformLocation | null = null
  uUi: WebGLUniformLocation | null = null
  uXi: WebGLUniformLocation | null = null
  debug = false

  /* -------------------- helpers -------------------- */
  private checkGlError(gl: WebGLRenderingContext, stage: string) {
    if (!this.debug) return
    const err = gl.getError()
    if (err !== gl.NO_ERROR)
      console.warn(`WebGL error @ ${stage}: 0x${err.toString(16)}`)
  }
  private checkFramebuffer(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    stage: string,
  ) {
    if (!this.debug) return
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      console.warn(
        `Framebuffer incomplete @ ${stage}: 0x${status.toString(16)}`,
      )
  }

  constructor(options: MaplibreInterpolateHeatmapLayerOptions) {
    this.debug = options.debug ?? false
    if (this.debug)
      console.log('MaplibreInterpolateHeatmapLayer:constructor', options)
    this.id = options.id || ''
    this.data = options.data || []
    this.aoi = options.aoi || []
    this.valueToColor =
      options.valueToColor ||
      `
      vec3 valueToColor(float value) {
          return vec3(max((value-0.5)*2.0, 0.0), 1.0 - 2.0*abs(value - 0.5), max((0.5-value)*2.0, 0.0));
      }
  `
    this.valueToColor4 =
      options.valueToColor4 ||
      `
      vec4 valueToColor4(float value, float defaultOpacity) {
          return vec4(valueToColor(value), defaultOpacity);
      }
  `
    this.opacity = options.opacity || 0.5
    this.minValue = options.minValue || Infinity
    this.maxValue = options.maxValue || -Infinity
    this.p = options.p || 3
    this.framebufferFactor = options.framebufferFactor || 0.3
    // Having a framebufferFactor < 1 and a texture that don't cover the entire map results in visual artifacts, so we prevent this situation
    this.textureCoverSameAreaAsROI = this.framebufferFactor === 1
  }

  onAdd(
    map: maplibregl.Map,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.debug)
      console.log('MaplibreInterpolateHeatmapLayer:onAdd', {
        points: this.data.length,
        framebufferFactor: this.framebufferFactor,
      })
    const isWebGL2 =
      typeof WebGL2RenderingContext !== 'undefined' &&
      gl instanceof WebGL2RenderingContext
    if (
      !isWebGL2 &&
      (!gl.getExtension('OES_texture_float') ||
        !gl.getExtension('WEBGL_color_buffer_float') ||
        !gl.getExtension('EXT_float_blend'))
    ) {
      throw new Error('WebGL extension not supported')
    }
    if (isWebGL2 && !gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float not supported')
    }
    if (this.debug) console.log('WebGL extensions validated')
    this.checkGlError(gl, 'extension check')
    this.canvas = map.getCanvas()
    const vertexSource = `
              #version 300 es
              precision highp float;
              in vec2 a_Position;
              uniform mat4 u_Matrix;
              void main() {
                  gl_Position = u_Matrix * vec4(a_Position, 0.0, 1.0);
              }
          `
    const fragmentSource = `
              #version 300 es
              precision highp float;
              ${this.valueToColor}
              ${this.valueToColor4}
              uniform sampler2D u_ComputationTexture;
              uniform vec2 u_ScreenSize;
              uniform float u_Opacity;
              out vec4 fragColor;
              void main() {
                  vec4 data = texture(
                      u_ComputationTexture,
                      vec2(gl_FragCoord.x/u_ScreenSize.x,
                           gl_FragCoord.y/u_ScreenSize.y)
                  );
                  float denom = max(data.y, 1e-6);
                  float u = data.x / denom;
                  fragColor = valueToColor4(clamp(u, 0., 1.), u_Opacity);
              }
          `
    const computationVertexSource = `
              #version 300 es
              precision highp float;
              uniform mat4 u_Matrix;
              uniform vec2 xi;
              out vec2 xiNormalized;
              in vec2 a_Position;
              void main() {
                  vec4 xiProjected = u_Matrix * vec4(xi, 0.0, 1.0);
                  xiNormalized = vec2(xiProjected.x / xiProjected.w, xiProjected.y / xiProjected.w);
                  gl_Position = u_Matrix * vec4(a_Position, 0.0, 1.0);
              }
          `
    const computationFragmentSource = `
              #version 300 es
              precision highp float;
              uniform float ui;
              in vec2 xiNormalized;
              uniform float p;
              uniform vec2 u_FramebufferSize;
              out vec4 fragColor;
              void main() {
                  vec2 x = vec2(gl_FragCoord.x/u_FramebufferSize.x, gl_FragCoord.y/u_FramebufferSize.y);
                  vec2 xi = vec2((xiNormalized.x + 1.)/2., (xiNormalized.y + 1.)/2.);
                  float dist = max(distance(x, xi), 1e-4);
                  float wi = 1.0 / pow(dist, p);
                  fragColor = vec4(ui*wi, wi, 0.0, 1.0);
              }
          `
    const computationVertexShader = createVertexShader(
      gl,
      computationVertexSource,
    )
    if (!computationVertexShader)
      throw new Error('error: computation vertex shader not created')
    if (this.debug) console.log('Computation vertex shader created')
    const computationFragmentShader = createFragmentShader(
      gl,
      computationFragmentSource,
    )
    if (!computationFragmentShader)
      throw new Error('error: computation fragment shader not created')
    if (this.debug) console.log('Computation fragment shader created')
    this.computationProgram = createProgram(
      gl,
      computationVertexShader,
      computationFragmentShader,
    )
    if (!this.computationProgram)
      throw new Error('error: computation fragment shader not created')
    if (this.debug) console.log('Computation program linked')
    this.checkGlError(gl, 'program link')
    this.aPositionComputation = gl.getAttribLocation(
      this.computationProgram,
      'a_Position',
    )
    this.uMatrixComputation = gl.getUniformLocation(
      this.computationProgram,
      'u_Matrix',
    )
    this.uUi = gl.getUniformLocation(this.computationProgram, 'ui')
    this.uXi = gl.getUniformLocation(this.computationProgram, 'xi')
    this.uP = gl.getUniformLocation(this.computationProgram, 'p')
    this.uFramebufferSize = gl.getUniformLocation(
      this.computationProgram,
      'u_FramebufferSize',
    )
    if (
      this.aPositionComputation < 0 ||
      !this.uMatrixComputation ||
      !this.uUi ||
      !this.uXi ||
      !this.uP ||
      !this.uFramebufferSize
    ) {
      throw 'WebGL error: Failed to get the storage location of computation variable'
    }
    const drawingVertexShader = createVertexShader(gl, vertexSource)
    if (!drawingVertexShader)
      throw new Error('error: drawing vertex shader not created')
    if (this.debug) console.log('Drawing vertex shader created')
    const drawingFragmentShader = createFragmentShader(gl, fragmentSource)
    if (!drawingFragmentShader)
      throw new Error('error: drawing fragment shader not created')
    if (this.debug) console.log('Drawing fragment shader created')
    this.drawProgram = createProgram(
      gl,
      drawingVertexShader,
      drawingFragmentShader,
    )
    if (!this.drawProgram) throw new Error('error: drawing program not created')
    if (this.debug) console.log('Drawing program linked')
    this.checkGlError(gl, 'program link')
    this.aPositionDraw = gl.getAttribLocation(this.drawProgram, 'a_Position')
    this.uMatrixDraw = gl.getUniformLocation(this.drawProgram, 'u_Matrix')
    this.uComputationTexture = gl.getUniformLocation(
      this.drawProgram,
      'u_ComputationTexture',
    )
    this.uScreenSizeDraw = gl.getUniformLocation(
      this.drawProgram,
      'u_ScreenSize',
    )
    this.uOpacity = gl.getUniformLocation(this.drawProgram, 'u_Opacity')
    if (
      this.aPositionDraw < 0 ||
      !this.uMatrixDraw ||
      !this.uComputationTexture ||
      !this.uScreenSizeDraw ||
      !this.uOpacity
    ) {
      throw 'WebGL error: Failed to get the storage location of drawing variable'
    }
    if (this.debug) {
      const isFiniteTex = gl.getUniformLocation(
        this.drawProgram,
        'u_ComputationTexture',
      )
      console.log('Draw uniforms ready, tex loc:', isFiniteTex)
    }
    const fullScreenQuad = [
      maplibregl.MercatorCoordinate.fromLngLat({ lng: -180, lat: -85 }).x,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: -180, lat: -85 }).y,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: -180, lat: 85 }).x,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: -180, lat: 85 }).y,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: 180, lat: 85 }).x,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: 180, lat: 85 }).y,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: 180, lat: -85 }).x,
      maplibregl.MercatorCoordinate.fromLngLat({ lng: 180, lat: -85 }).y,
    ]
    const drawingVertices = this.aoi?.length
      ? this.aoi.flatMap((p) => {
          const c = maplibregl.MercatorCoordinate.fromLngLat(p)
          return [c.x, c.y]
        })
      : fullScreenQuad
    if (this.debug)
      console.log('Drawing vertices', drawingVertices.length, drawingVertices)
    this.drawingVerticesBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.drawingVerticesBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(drawingVertices),
      gl.STATIC_DRAW,
    )
    const computationVertices = this.textureCoverSameAreaAsROI
      ? drawingVertices
      : fullScreenQuad
    this.computationVerticesBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.computationVerticesBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(computationVertices),
      gl.STATIC_DRAW,
    )
    const indices = earcut(drawingVertices)
    if (this.debug) console.log('Indices', indices.length, indices)
    this.indicesBuffer = gl.createBuffer()
    if (!this.indicesBuffer)
      throw new Error('error: indices buffer not created')
    this.indicesNumber = indices.length
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indicesBuffer)
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint8Array(indices),
      gl.STATIC_DRAW,
    )
    this.framebufferWidth = Math.ceil(
      this.canvas.width * this.framebufferFactor,
    )
    this.framebufferHeight = Math.ceil(
      this.canvas.height * this.framebufferFactor,
    )
    if (this.debug)
      console.log(
        'Initial framebuffer',
        this.framebufferWidth,
        this.framebufferHeight,
      )
    this.computationTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.computationTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      isWebGL2 ? (gl as WebGL2RenderingContext).RGBA32F : gl.RGBA,
      this.framebufferWidth,
      this.framebufferHeight,
      0,
      gl.RGBA,
      gl.FLOAT,
      null,
    )
    this.computationFramebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.computationFramebuffer)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.computationTexture,
      0,
    )
    this.checkFramebuffer(gl, 'FBO init')
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.checkGlError(gl, 'FBO init')
    this.points = []
    let minValue = Infinity
    let maxValue = -Infinity
    this.data.forEach((rawPoint) => {
      const mercatorCoordinates = maplibregl.MercatorCoordinate.fromLngLat({
        lng: rawPoint.lon,
        lat: rawPoint.lat,
      })
      this.points.push([
        mercatorCoordinates.x,
        mercatorCoordinates.y,
        rawPoint.val,
      ])
      if (rawPoint.val < minValue) {
        minValue = rawPoint.val
      }
      if (rawPoint.val > maxValue) {
        maxValue = rawPoint.val
      }
    })
    if (this.debug) console.log('Raw min/max', { minValue, maxValue })
    if (this.debug) console.log('Points processed', this.points.length)
    minValue = minValue < this.minValue ? minValue : this.minValue
    maxValue = maxValue > this.maxValue ? maxValue : this.maxValue
    if (this.debug) console.log('Normalized min/max', { minValue, maxValue })
    this.points.forEach((point) => {
      point[2] = (point[2] - minValue) / (maxValue - minValue)
    })
    this.resizeFramebuffer = () => {
      if (this.debug) console.log('Resizing framebuffer')
      if (!this.canvas || !this.canvas.width || !this.canvas.height)
        throw new Error('error: required canvas `width` & `height`')
      this.framebufferWidth = Math.ceil(
        this.canvas.width * this.framebufferFactor,
      )
      this.framebufferHeight = Math.ceil(
        this.canvas.height * this.framebufferFactor,
      )
      gl.bindTexture(gl.TEXTURE_2D, this.computationTexture)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        isWebGL2 ? (gl as WebGL2RenderingContext).RGBA32F : gl.RGBA,
        this.framebufferWidth,
        this.framebufferHeight,
        0,
        gl.RGBA,
        gl.FLOAT,
        null,
      )
      this.checkGlError(gl, 'FBO resize')
      this.checkFramebuffer(gl, 'FBO resize')
      if (this.debug)
        console.log(
          'Framebuffer resized',
          this.framebufferWidth,
          this.framebufferHeight,
        )
    }
    map.on('resize', this.resizeFramebuffer)
    if (this.debug) console.log('Resize handler attached')
  }
  onRemove(
    map: maplibregl.Map,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.debug) console.log('MaplibreInterpolateHeatmapLayer:onRemove')
    if (!this.resizeFramebuffer)
      throw new Error('error: required resize frame buffer callback')
    map.off('resize', this.resizeFramebuffer)
    gl.deleteTexture(this.computationTexture)
    gl.deleteBuffer(this.drawingVerticesBuffer)
    gl.deleteBuffer(this.computationVerticesBuffer)
    gl.deleteBuffer(this.indicesBuffer)
    gl.deleteFramebuffer(this.computationFramebuffer)
    this.checkGlError(gl, 'cleanup')
  }
  prerender(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    { projectionMatrix }: maplibregl.CustomRenderMethodInput,
  ): void {
    if (this.debug) console.log('MaplibreInterpolateHeatmapLayer:prerender')
    if (
      !this.framebufferWidth ||
      !this.framebufferHeight ||
      this.aPositionComputation === undefined ||
      !this.indicesNumber ||
      !this.canvas ||
      !this.canvas.width ||
      !this.canvas.height
    ) {
      if (this.debug)
        console.warn('Skipping prerender: missing framebuffer or canvas data')
      return
    }
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.clearColor(0.0, 0.0, 0.0, 1.0)
    gl.useProgram(this.computationProgram)
    gl.uniformMatrix4fv(this.uMatrixComputation, false, projectionMatrix)
    gl.uniform1f(this.uP, this.p)
    gl.uniform2f(
      this.uFramebufferSize,
      this.framebufferWidth,
      this.framebufferHeight,
    )
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.computationFramebuffer)
    gl.viewport(0, 0, this.framebufferWidth, this.framebufferHeight)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indicesBuffer)
    for (let i = 0; i < this.points.length; i += 1) {
      const point = this.points.at(i)
      if (!point) throw new Error(`error: point not found at index: ${i}`)
      if (this.debug) console.log('Prerender point', i, point)
      gl.uniform1f(this.uUi, point[2])
      gl.uniform2f(this.uXi, point[0], point[1])
      gl.bindBuffer(gl.ARRAY_BUFFER, this.computationVerticesBuffer)
      gl.enableVertexAttribArray(this.aPositionComputation)
      gl.vertexAttribPointer(
        this.aPositionComputation,
        2,
        gl.FLOAT,
        false,
        0,
        0,
      )
      if (this.textureCoverSameAreaAsROI) {
        gl.drawElements(gl.TRIANGLES, this.indicesNumber, gl.UNSIGNED_BYTE, 0)
      } else {
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    }
    this.checkGlError(gl, 'prerender')
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    if (this.debug) console.log('Prerender finished')
  }
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    { projectionMatrix }: maplibregl.CustomRenderMethodInput,
  ): void {
    if (this.debug) console.log('MaplibreInterpolateHeatmapLayer:render')
    if (
      this.aPositionDraw === undefined ||
      !this.canvas ||
      !this.canvas.width ||
      !this.canvas.height ||
      !this.indicesNumber
    ) {
      if (this.debug)
        console.warn('Skipping render: missing framebuffer or canvas data')
      return
    }

    gl.disable(gl.DEPTH_TEST) // ← add (kills depth test)
    gl.depthMask(false) // ← add (do not overwrite depth)

    gl.useProgram(this.drawProgram)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.drawingVerticesBuffer)
    gl.enableVertexAttribArray(this.aPositionDraw)
    gl.vertexAttribPointer(this.aPositionDraw, 2, gl.FLOAT, false, 0, 0)
    gl.uniformMatrix4fv(this.uMatrixDraw, false, projectionMatrix)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.computationTexture)
    gl.uniform1i(this.uComputationTexture, 0)
    gl.uniform2f(this.uScreenSizeDraw, this.canvas.width, this.canvas.height)
    gl.uniform1f(this.uOpacity, this.opacity)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indicesBuffer)
    gl.drawElements(gl.TRIANGLES, this.indicesNumber, gl.UNSIGNED_BYTE, 0)
    this.checkGlError(gl, 'render')
    if (this.debug) console.log('Render finished')

    gl.depthMask(true) // ← restore (optional)

    if (this.debug) {
      // optional sanity‑check
      const px = new Uint8Array(4)
      gl.readPixels(
        this.canvas!.width >> 1,
        this.canvas!.height >> 1,
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        px,
      )
      console.log('Center pixel post‑draw', px)
    }
    if (this.debug) console.log('Render finished')
  }
}
/**
 * @param {WebGLRenderingContext} gl - WebGL context
 * @param {string } source - source of the shader
 * @returns {WebGLShader | undefined} - compiled shader
 */
function createVertexShader(
  gl: WebGLRenderingContext,
  source: string,
): WebGLShader | undefined {
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)
  if (vertexShader) return compileShader(gl, vertexShader, source)
}
/**
 * @param {WebGLRenderingContext} gl - WebGL context
 * @param {string } source - source of the shader
 * @returns {WebGLShader | undefined} - compiled shader
 */
function createFragmentShader(
  gl: WebGLRenderingContext,
  source: string,
): WebGLShader | undefined {
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)
  if (fragmentShader) return compileShader(gl, fragmentShader, source)
}
/**
 * @param {WebGLRenderingContext} gl - WebGL context
 * @param {WebGLShader} shader - shader to compile
 * @param {string} source - source of the shader
 * @returns {WebGLShader | undefined} - compiled shader
 */
function compileShader(
  gl: WebGLRenderingContext,
  shader: WebGLShader,
  source: string,
): WebGLShader | undefined {
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw gl.getShaderInfoLog(shader)
  }
  return shader
}

/**
 * @param {WebGLRenderingContext} gl - WebGL context
 * @param {WebGLShader} vertexShader - vertext shader
 * @param {WebGLShader} fragmentShader - fragment shader
 * @returns {WebGLProgram | null} - compiled program
 */
function createProgram(
  gl: WebGLRenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader,
): WebGLProgram | null {
  const program = gl.createProgram()
  if (program) {
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw gl.getProgramInfoLog(program)
    }
  }
  return program
}
export { MaplibreInterpolateHeatmapLayer }
