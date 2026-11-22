// WebGL2 colour-grading pass used by the preview. The maths mirrors the FFmpeg filter chain
// in server/renderGraph.ts (exposure -> eq -> colortemperature -> colorbalance -> curves ->
// lut3d -> unsharp -> vignette -> noise) closely enough for grading decisions.
import type { ColorGrade, VisualFx } from "../../shared/types";

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2((p.x+1.0)/2.0, 1.0-(p.y+1.0)/2.0); gl_Position = vec4(p,0.0,1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D src; uniform sampler2D curve; uniform sampler3D lut;
uniform float exposure, contrast, saturation, temperature, tint, lutMix, vignette, grain, sharpen, time;
uniform vec3 lift, gammaC, gain; uniform vec2 texel; uniform bool hasLut;
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
float rnd(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233)) + time*43.0) * 43758.5453); }
void main(){
  vec3 c = texture(src, uv).rgb;
  if (sharpen > 0.0) {
    vec3 n = texture(src, uv+vec2(texel.x,0.)).rgb + texture(src, uv-vec2(texel.x,0.)).rgb + texture(src, uv+vec2(0.,texel.y)).rgb + texture(src, uv-vec2(0.,texel.y)).rgb;
    c += (c - n*0.25) * sharpen * 1.2;
  }
  c *= exp2(exposure);
  c = (c - 0.5) * (1.0 + contrast) + 0.5;
  float l = luma(c);
  c = mix(vec3(l), c, saturation);
  if (temperature > 0.0) { c.g *= 1.0 - 0.16*temperature; c.b *= 1.0 - 0.29*temperature; }
  else { float t = -temperature; c.r *= 1.0 - 0.105*t; c.g *= 1.0 - 0.074*t; }
  l = clamp(luma(c), 0.0, 1.0);
  float ws = 1.0 - smoothstep(0.0, 0.5, l);
  float wh = smoothstep(0.5, 1.0, l);
  float wm = 1.0 - ws - wh;
  vec3 tv = vec3(0.06, -0.1, 0.06) * tint;
  c += lift*0.6*ws*0.5 + (gammaC*0.6 + tv)*wm*0.5 + gain*0.6*wh*0.5;
  c = clamp(c, 0.0, 1.0);
  c = vec3(texture(curve, vec2(c.r, 0.5)).r, texture(curve, vec2(c.g, 0.5)).r, texture(curve, vec2(c.b, 0.5)).r);
  if (hasLut) c = mix(c, texture(lut, c).rgb, lutMix);
  if (vignette > 0.0) {
    vec2 d = (uv - 0.5) * 2.0;
    float dist = length(d) / 1.4142;
    float a = 0.25 + vignette * 0.85;
    float f = pow(cos(clamp(dist * a * 1.6, 0.0, 1.5707)), 4.0);
    c *= f;
  }
  if (grain > 0.0) c += (rnd(uv*1000.0) - 0.5) * grain * 0.22;
  o = vec4(clamp(c,0.0,1.0), 1.0);
}`;

export function isNeutral(g: ColorGrade, fx: VisualFx) {
  return (
    Math.abs(g.exposure) < 1e-3 &&
    Math.abs(g.contrast) < 1e-3 &&
    Math.abs(g.saturation - 1) < 1e-3 &&
    Math.abs(g.temperature) < 1e-3 &&
    Math.abs(g.tint) < 1e-3 &&
    Math.abs(g.highlights) < 1e-3 &&
    Math.abs(g.shadows) < 1e-3 &&
    [g.lift, g.gamma, g.gain].every((v) => Math.abs(v.r) + Math.abs(v.g) + Math.abs(v.b) < 1e-3) &&
    g.curve.every((v, i) => Math.abs(v - i * 0.25) < 1e-3) &&
    !g.lutId &&
    fx.sharpen < 0.01 &&
    fx.vignette < 0.01 &&
    fx.grain < 0.01
  );
}

/** Monotone cubic interpolation through 5 evenly spaced points -> 256 entries. */
export function curveTable(points: number[]): Uint8Array {
  const xs = points.map((_, i) => i / (points.length - 1));
  const ys = points;
  const n = xs.length;
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  const out = new Uint8Array(256);
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let i = Math.min(n - 2, Math.floor(x * (n - 1)));
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    out[k] = Math.round(Math.max(0, Math.min(1, y)) * 255);
  }
  return out;
}

interface LutData {
  size: number;
  data: Uint8Array;
}
const lutCache = new Map<string, Promise<LutData | null>>();
export function loadLut(id: string): Promise<LutData | null> {
  if (!lutCache.has(id))
    lutCache.set(
      id,
      fetch(`/files/luts/${id}.cube`)
        .then((r) => (r.ok ? r.text() : null))
        .then((txt) => {
          if (!txt) return null;
          let size = 0;
          const vals: number[] = [];
          for (const line of txt.split("\n")) {
            const l = line.trim();
            if (!l || l.startsWith("#") || l.startsWith("TITLE")) continue;
            const m = /^LUT_3D_SIZE\s+(\d+)/.exec(l);
            if (m) {
              size = Number(m[1]);
              continue;
            }
            if (/^(DOMAIN|LUT_1D)/.test(l)) continue;
            const p = l.split(/\s+/).map(Number);
            if (p.length === 3 && p.every((v) => isFinite(v))) vals.push(...p);
          }
          if (!size || vals.length < size * size * size * 3) return null;
          const data = new Uint8Array(size * size * size * 4);
          for (let i = 0; i < size * size * size; i++) {
            data[i * 4] = Math.round(Math.max(0, Math.min(1, vals[i * 3])) * 255);
            data[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, vals[i * 3 + 1])) * 255);
            data[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, vals[i * 3 + 2])) * 255);
            data[i * 4 + 3] = 255;
          }
          return { size, data };
        })
        .catch(() => null)
    );
  return lutCache.get(id)!;
}

export class Grader {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext | null;
  prog!: WebGLProgram;
  srcTex!: WebGLTexture;
  curveTex!: WebGLTexture;
  lutTex!: WebGLTexture;
  loadedLut: string | null = null;
  lutReady = new Map<string, LutData | null>();
  u: Record<string, WebGLUniformLocation | null> = {};
  onChange: () => void = () => {};

  constructor() {
    this.canvas = document.createElement("canvas");
    this.gl = this.canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (this.gl) this.init(this.gl);
  }

  private init(gl: WebGL2RenderingContext) {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    this.prog = p;
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["src", "curve", "lut", "exposure", "contrast", "saturation", "temperature", "tint", "lutMix", "vignette", "grain", "sharpen", "time", "lift", "gammaC", "gain", "texel", "hasLut"]) this.u[n] = gl.getUniformLocation(p, n);
    const mk = () => {
      const t = gl.createTexture()!;
      return t;
    };
    this.srcTex = mk();
    this.curveTex = mk();
    this.lutTex = mk();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.uniform1i(this.u.src, 0);
    gl.uniform1i(this.u.curve, 1);
    gl.uniform1i(this.u.lut, 2);
  }

  /** Grade `source` and return the canvas holding the result (or null if WebGL is unavailable). */
  apply(source: TexImageSource, w: number, h: number, g: ColorGrade, fx: VisualFx, time: number): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return null;
    }
    const c = g.curve.slice();
    c[1] += g.shadows * 0.08;
    c[3] += g.highlights * 0.08;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, curveTable(c));
    let hasLut = false;
    if (g.lutId) {
      const lut = this.lutReady.get(g.lutId);
      if (lut === undefined) {
        this.lutReady.set(g.lutId, null);
        loadLut(g.lutId).then((d) => {
          this.lutReady.set(g.lutId!, d);
          this.onChange();
        });
      } else if (lut) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
        if (this.loadedLut !== g.lutId) {
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
          this.loadedLut = g.lutId;
        }
        hasLut = true;
      }
    }
    const U = this.u;
    gl.uniform1f(U.exposure, g.exposure);
    gl.uniform1f(U.contrast, g.contrast);
    gl.uniform1f(U.saturation, g.saturation);
    gl.uniform1f(U.temperature, Math.max(-2, Math.min(2, g.temperature))); // same mix scaling as the FFmpeg colortemperature filter
    gl.uniform1f(U.tint, g.tint);
    gl.uniform1f(U.lutMix, g.lutIntensity);
    gl.uniform1i(U.hasLut, hasLut ? 1 : 0);
    gl.uniform1f(U.vignette, fx.vignette);
    gl.uniform1f(U.grain, fx.grain);
    gl.uniform1f(U.sharpen, fx.sharpen);
    gl.uniform1f(U.time, time % 100);
    gl.uniform3f(U.lift, g.lift.r, g.lift.g, g.lift.b);
    gl.uniform3f(U.gammaC, g.gamma.r, g.gamma.g, g.gamma.b);
    gl.uniform3f(U.gain, g.gain.r, g.gain.g, g.gain.b);
    gl.uniform2f(U.texel, 1 / w, 1 / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}
