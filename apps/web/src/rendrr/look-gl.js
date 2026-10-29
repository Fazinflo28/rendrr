// The player's look (Phase 6): a clip's picture drawn through WebGL2 with the render's own numbers, in the render's
// order: the fit (cover, `fitY` down, turned), the key's alpha (FFmpeg's colorkey) and despill, the grade (the shared
// 3D LUT, trilinear like lut3d), blur, pixelate and sharpen mixed in by their areas, the masks into the alpha. The canvas is the
// plan's size, so block sizes, blur sigmas and mask pictures are the render's pixels.

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
const HEAD = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform vec2 size;
out vec4 o;
// The pixel centre in picture coordinates (top-left origin), and where a point is in a pass's output (bottom-up rows)
// or in an uploaded picture (rows top first).
vec2 img() { return vec2(gl_FragCoord.x, size.y - gl_FragCoord.y); }
vec2 fboUV(vec2 q) { return vec2(q.x / size.x, 1.0 - q.y / size.y); }
vec2 picUV(vec2 q) { return q / size; }
`;
const FS = {
  // The video turned and fitted like the render's fit: scale to cover, crop centred across and fitY down.
  fit: `uniform sampler2D src; uniform vec2 vsize; uniform int rot; uniform float fitY;
void main() {
  vec2 q = img();
  vec2 t = (rot == 90 || rot == 270) ? vec2(vsize.y, vsize.x) : vsize;
  float s = max(size.x / t.x, size.y / t.y);
  vec2 off = vec2((t.x * s - size.x) * 0.5, (t.y * s - size.y) * fitY);
  vec2 u = (q + off) / s;
  vec2 v = rot == 90 ? vec2(u.y, vsize.y - u.x) : rot == 270 ? vec2(vsize.x - u.y, u.x) : rot == 180 ? vsize - u : u;
  o = vec4(texture(src, v / vsize).rgb, 1.0);
}`,
  // Key (alpha from the fitted 8-bit colours), despill, the grade's LUT.
  look: `uniform sampler2D pic; uniform sampler3D lut; uniform float lutN; uniform bool hasLut;
uniform bool hasKey; uniform vec3 keyRgb; uniform float sim; uniform float blend; uniform float spill; uniform bool blueKey;
float q8(float v) { return floor(clamp(v, 0.0, 1.0) * 255.0) / 255.0; }
void main() {
  vec3 c = texture(pic, fboUV(img())).rgb;
  vec3 c8 = floor(c * 255.0 + 0.5);
  float a = 1.0;
  if (hasKey) {
    vec3 d = c8 - keyRgb * 255.0;
    float diff = sqrt(dot(d, d) / (255.0 * 255.0 * 3.0));
    a = blend > 0.0001 ? floor(clamp((diff - sim) / blend, 0.0, 1.0) * 255.0) / 255.0 : (diff > sim ? 1.0 : 0.0);
    if (spill > 0.0) {
      vec3 n = c8 / 255.0;
      float m = blueKey ? max(n.b - (n.r * 0.5 + n.g * 0.5), 0.0) : max(n.g - (n.r * 0.5 + n.b * 0.5), 0.0);
      if (blueKey) n.b = max(n.b - m * spill, 0.0); else n.g = max(n.g - m * spill, 0.0);
      c = vec3(q8(n.r), q8(n.g), q8(n.b));
    }
  }
  if (hasLut) c = texture(lut, c * ((lutN - 1.0) / lutN) + 0.5 / lutN).rgb;
  o = vec4(c, a);
}`,
  // One direction of a Gaussian (sigma in pixels), edges clamped; the alpha is kept.
  blur: `uniform sampler2D pic; uniform vec2 dir; uniform float sigma; uniform int radius;
void main() {
  vec2 q = img();
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -radius; i <= radius; i++) {
    float w = exp(-0.5 * float(i * i) / (sigma * sigma));
    acc += texture(pic, fboUV(clamp(q + dir * float(i), vec2(0.5), size - 0.5))).rgb * w; ws += w;
  }
  o = vec4(acc / ws, texture(pic, fboUV(q)).a);
}`,
  // Sharpen: x + k (x - blur(x)), the blur the render's binomial kernel (n 3 or 5, sharpenKernel), edges clamped.
  sharp: `uniform sampler2D pic; uniform float k; uniform float n;
void main() {
  vec2 q = img();
  vec4 c = texture(pic, fboUV(q));
  float r = floor(n / 2.0);
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (float y = -2.0; y <= 2.0; y += 1.0) for (float x = -2.0; x <= 2.0; x += 1.0) {
    if (abs(x) > r || abs(y) > r) continue;
    float wx = r < 1.5 ? 2.0 - abs(x) : (abs(x) < 0.5 ? 6.0 : abs(x) < 1.5 ? 4.0 : 1.0);
    float wy = r < 1.5 ? 2.0 - abs(y) : (abs(y) < 0.5 ? 6.0 : abs(y) < 1.5 ? 4.0 : 1.0);
    acc += texture(pic, fboUV(clamp(q + vec2(x, y), vec2(0.5), size - 0.5))).rgb * wx * wy; ws += wx * wy;
  }
  o = vec4(clamp(c.rgb + k * (c.rgb - acc / ws), 0.0, 1.0), c.a);
}`,
  // Pixelate, step 1: each fragment of a small target is the mean of its block (the grid starts top left, like pixelize).
  pxavg: `uniform sampler2D pic; uniform float B; uniform vec2 blocks;
void main() {
  vec2 bi = vec2(floor(gl_FragCoord.x), blocks.y - 1.0 - floor(gl_FragCoord.y));
  vec2 p0 = bi * B, p1 = min(p0 + B, size);
  vec3 acc = vec3(0.0); float n = 0.0;
  for (float y = p0.y; y < p1.y; y += 1.0) for (float x = p0.x; x < p1.x; x += 1.0) { acc += texture(pic, fboUV(vec2(x + 0.5, y + 0.5))).rgb; n += 1.0; }
  o = vec4(acc / n, 1.0);
}`,
  // Pixelate, step 2: every pixel shows its block's mean.
  pxshow: `uniform sampler2D pic; uniform sampler2D small; uniform float B; uniform vec2 blocks;
void main() {
  vec2 q = img(); vec2 bi = floor(q / B);
  o = vec4(texelFetch(small, ivec2(int(bi.x), int(blocks.y - 1.0 - bi.y)), 0).rgb, texture(pic, fboUV(q)).a);
}`,
  // An effect mixed in by its area (maskedmerge).
  mix: `uniform sampler2D base; uniform sampler2D fx; uniform sampler2D area;
void main() { vec2 q = img(); vec4 b = texture(base, fboUV(q)); o = vec4(mix(b.rgb, texture(fx, fboUV(q)).rgb, texture(area, picUV(q)).r), b.a); }`,
  // To the canvas: the masks multiply the key's alpha (premultiplied for the page).
  out: `uniform sampler2D pic; uniform sampler2D mask; uniform bool hasMask;
void main() { vec2 q = img(); vec4 c = texture(pic, fboUV(q)); float a = c.a * (hasMask ? texture(mask, picUV(q)).r : 1.0); o = vec4(c.rgb * a, a); }`,
};

/** A renderer on one canvas, or null when the browser has no WebGL2. */
export function createLookRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const deep = !!gl.getExtension("EXT_color_buffer_float");
  const progs = {};
  for (const [k, src] of Object.entries(FS)) {
    const p = gl.createProgram();
    for (const [type, s] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, HEAD + src]]) {
      const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`look shader ${k}: ${gl.getShaderInfoLog(sh)}`);
      gl.attachShader(p, sh);
    }
    gl.bindAttribLocation(p, 0, "p"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`look program ${k}: ${gl.getProgramInfoLog(p)}`);
    progs[k] = p;
  }
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const tex = (filter = gl.LINEAR) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; };
  const target = (w, h, eight = false) => {
    const t = tex(gl.NEAREST);
    if (deep && !eight) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  };
  const src = tex();
  let W = 0, H = 0, fit = null, buf = [], small = null, smallB = 0;
  const lut3 = gl.createTexture(); let lutId = null, lutN = 0;
  // A complete 3D texture from the start (an identity), so the look pass never samples an empty one.
  gl.bindTexture(gl.TEXTURE_3D, lut3);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, 2, 2, 2, 0, gl.RGB, gl.FLOAT, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]));
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
  const pics = new Map(); // grey pictures (masks, areas) by key; the ones a draw did not use are freed after it
  let used = new Set();
  const grey = (key, px, w, h) => {
    used.add(key);
    let t = pics.get(key);
    if (t) return t;
    t = tex(gl.LINEAR); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, px);
    pics.set(key, t);
    return t;
  };
  const use = (name, uniforms, textures = []) => {
    const p = progs[name]; gl.useProgram(p);
    gl.uniform2f(gl.getUniformLocation(p, "size"), W, H);
    textures.forEach(([u, t, kind], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(kind === 3 ? gl.TEXTURE_3D : gl.TEXTURE_2D, t); gl.uniform1i(gl.getUniformLocation(p, u), i); });
    for (const [k, v] of Object.entries(uniforms)) {
      const l = gl.getUniformLocation(p, k);
      if (Array.isArray(v)) (v.length === 2 ? gl.uniform2f : gl.uniform3f).call(gl, l, ...v);
      else if (typeof v === "boolean") gl.uniform1i(l, v ? 1 : 0);
      else if (k === "rot" || k === "radius") gl.uniform1i(l, v);
      else gl.uniform1f(l, v);
    }
  };
  const run = (to) => { gl.bindFramebuffer(gl.FRAMEBUFFER, to ? to.f : null); gl.viewport(0, 0, to ? to.w : W, to ? to.h : H); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };

  return {
    /**
     * Draws the video's current frame. spec: { W, H, rotate, fitY, lut: {id, n, data} | null, key: {rgb, sim, blend,
     * spill, blue} | null, mask: {key, px} | null, effects: [{type, px, amount, area: {key, px} | null}] }.
     */
    draw(video, spec) {
      if (spec.W !== W || spec.H !== H) {
        W = spec.W; H = spec.H; canvas.width = W; canvas.height = H;
        fit = target(W, H, true); buf = [target(W, H), target(W, H), target(W, H)]; small = null;
      }
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      use("fit", { vsize: [video.videoWidth || W, video.videoHeight || H], rot: spec.rotate || 0, fitY: spec.fitY ?? 0.4 }, [["src", src]]);
      run(fit);
      if (spec.lut && spec.lut.id !== lutId) {
        gl.bindTexture(gl.TEXTURE_3D, lut3);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, spec.lut.n, spec.lut.n, spec.lut.n, 0, gl.RGB, gl.FLOAT, spec.lut.data);
        lutId = spec.lut.id; lutN = spec.lut.n;
      }
      const k = spec.key;
      use("look", { lutN: lutN || 2, hasLut: !!spec.lut, hasKey: !!k, keyRgb: k ? k.rgb : [0, 0, 0], sim: k ? k.sim : 0, blend: k ? k.blend : 0, spill: k ? k.spill : 0, blueKey: !!k?.blue }, [["pic", fit.t], ["lut", lut3, 3]]);
      run(buf[0]);
      let cur = 0;
      for (const e of spec.effects || []) {
        const a = (cur + 1) % 3, b = (cur + 2) % 3;
        if (e.type === "blur") {
          const radius = Math.min(200, Math.ceil(e.px * 3));
          use("blur", { dir: [1, 0], sigma: e.px, radius }, [["pic", buf[cur].t]]); run(buf[a]);
          use("blur", { dir: [0, 1], sigma: e.px, radius }, [["pic", buf[a].t]]); run(buf[b]);
        } else if (e.type === "sharpen") {
          use("sharp", { k: Math.round(e.amount * 2) / 100, n: e.px }, [["pic", buf[cur].t]]); run(buf[b]);
        } else {
          const B = e.px, blocks = [Math.ceil(W / B), Math.ceil(H / B)];
          if (!small || smallB !== B) { small = target(blocks[0], blocks[1]); smallB = B; }
          use("pxavg", { B, blocks }, [["pic", buf[cur].t]]); run(small);
          use("pxshow", { B, blocks }, [["pic", buf[cur].t], ["small", small.t]]); run(buf[b]);
        }
        if (e.area) {
          use("mix", {}, [["base", buf[cur].t], ["fx", buf[b].t], ["area", grey(e.area.key, e.area.px, W, H)]]); run(buf[a]);
          cur = a;
        } else cur = b;
      }
      use("out", { hasMask: !!spec.mask }, [["pic", buf[cur].t], ["mask", spec.mask ? grey(spec.mask.key, spec.mask.px, W, H) : src]]);
      gl.clearColor(0, 0, 0, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT);
      run(null);
      for (const [key, t] of pics) if (!used.has(key)) { gl.deleteTexture(t); pics.delete(key); }
      used = new Set();
    },
    dispose() { const lose = gl.getExtension("WEBGL_lose_context"); lose?.loseContext(); },
  };
}
