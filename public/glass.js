/*
 * Browser adaptation of heonny/egui-glass's MIT-licensed glass.wgsl:
 * https://github.com/heonny/egui-glass/blob/63b467e68327c54ad17dbc9550d306d2ea1d17cd/crates/egui_glass/src/glass.wgsl
 * Copyright (c) 2026 heonny. See EGUI_GLASS_LICENSE.txt.
 * The lens profile, sampling ring, vibrancy and specular rim are adapted to GLSL.
 * Uses circular rounded-box geometry, no chromatic taps, CSS shadows, and a
 * single static texture. This is a shader port, not an egui Rust integration.
 */
(() => {
  const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const forcedColors = matchMedia('(forced-colors: active)');
  // Capture glass samples a frozen image, independently of Windows acrylic.
  // Its own material control can switch to opaque without changing OS settings.
  const opaque = () => document.body.classList.contains('opaque') || forcedColors.matches
    || (document.body.dataset.view === 'library' && reducedTransparency.matches);
  const surfaces = [...document.querySelectorAll('.glass')];
  const parents = new Set();
  for (const surface of surfaces) for (let node = surface; node; node = node.parentElement) parents.add(node);
  const layers = new Map();
  const source = document.querySelector('[data-glass-backdrop]');
  if (!source || !surfaces.length) return;
  const gpuCanvas = document.createElement('canvas');
  let gl, program, locations, frame = 0, animateUntil = 0, lastDraw = 0, ready = false, failed = false, initializing = false;

  const vertex = `#version 300 es
    void main() {
      gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
    }`;
  const fragment = `#version 300 es
    precision highp float;
    uniform sampler2D backdrop;
    uniform vec2 origin, size, screen;
    uniform float scale, radius, blur, refraction, edgeWidth, tintAlpha;
    out vec4 outputColor;

    float roundedBox(vec2 p, vec2 halfSize, float r) {
      vec2 q = abs(p) - halfSize + r;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }
    vec2 roundedNormal(vec2 p, vec2 halfSize, float r) {
      vec2 q = abs(p) - (halfSize - r);
      vec2 n = q.x > 0.0 && q.y > 0.0 ? normalize(q + vec2(0.00001, 0.0))
        : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
      return n * mix(vec2(-1.0), vec2(1.0), step(vec2(0.0), p));
    }
    vec3 tap(vec2 p, float lod) {
      // Sample the original screen. The selection's dimming veil is not part
      // of the glass: applying it here made every floating control nearly black.
      return textureLod(backdrop, clamp(p / screen, 0.0, 1.0), lod).rgb;
    }
    vec3 sampleBackdrop(vec2 p, float lod) {
      vec3 sum = tap(p, lod) * 2.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853982 + 0.3927;
        sum += tap(p + blur * 0.5 * vec2(cos(a), sin(a)), lod);
      }
      return sum / 10.0;
    }
    void main() {
      vec2 local = vec2(gl_FragCoord.x, size.y * scale - gl_FragCoord.y) / scale;
      vec2 halfSize = size * 0.5;
      float d = roundedBox(local - halfSize, halfSize, min(radius, min(halfSize.x, halfSize.y)));
      float mask = 1.0 - smoothstep(-0.5, 0.5, d);
      if (mask <= 0.0) discard;
      vec2 n = roundedNormal(local - halfSize, halfSize, radius);
      float t = clamp((d + edgeWidth) / max(edgeWidth, 1.0), 0.0, 1.0);
      float lens = 1.0 - sqrt(max(1.0 - t * t, 0.0));
      vec2 displaced = origin + local + n * refraction * lens;
      float backdropScale = float(textureSize(backdrop, 0).x) / screen.x;
      float lod = max(log2(max(blur * backdropScale * 0.5, 1.0)), 0.0);
      vec3 color = sampleBackdrop(displaced, lod);
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(lum), color, 1.14) * 0.97;
      color = mix(color, vec3(0.20, 0.25, 0.32), tintAlpha);
      // A little reflected ambient light keeps glass visible on dark desktops.
      float bodyLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color += vec3(0.08, 0.10, 0.12) * (1.0 - smoothstep(0.10, 0.60, bodyLum));
      color += vec3(0.028, 0.034, 0.042) * pow(1.0 - local.y / size.y, 3.0);
      // Bound the face brightness so white text stays readable over white apps.
      float faceLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color *= min(1.0, 0.42 / max(faceLum, 0.001));
      float ndl = dot(n, normalize(vec2(-0.6, -0.8)));
      float curved = 4.0 * n.x * n.x * n.y * n.y;
      float rim = pow(t, 10.0) * (0.3 + 0.7 * curved) * (max(ndl, 0.0) + 0.6 * max(-ndl, 0.0));
      color += 0.62 * rim;
      color *= 1.0 - 0.18 * pow(t, 8.0) * (0.6 + 0.4 * (1.0 - max(ndl, 0.0)));
      float ring = 1.0 - smoothstep(0.0, 1.2, abs(d + 0.7));
      color = mix(color, vec3(1.0), 0.4 * ring * (0.32 + 0.4 * max(ndl, 0.0) + 0.18 * max(-ndl, 0.0)));
      outputColor = vec4(clamp(color, 0.0, 1.0) * mask, mask);
    }`;

  function fallback() {
    for (const [surface, layer] of layers) {
      surface.classList.remove('glass-rendered'); layer.canvas.hidden = true; layer.key = '';
    }
    document.documentElement.dataset.glassRenderer = 'css';
    document.dispatchEvent(new Event('glass-ready'));
  }
  function compile(type, code) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, code); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(error);
    }
    return shader;
  }
  async function init() {
    if (ready || failed || initializing || opaque()) return;
    initializing = true;
    try {
      await source.decode();
      gl = gpuCanvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      if (!gl) { failed = true; fallback(); return; }
      const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment);
      program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      locations = Object.fromEntries(['origin', 'size', 'screen', 'scale', 'radius', 'blur', 'refraction', 'edgeWidth', 'tintAlpha'].map(name => [name, gl.getUniformLocation(program, name)]));
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
      // Blur texture is uploaded once, with a longest edge of 1024 pixels.
      // DOM text and the visible screenshot retain their original resolution.
      const upload = document.createElement('canvas'), ratio = Math.min(1, 1024 / Math.max(source.naturalWidth, source.naturalHeight));
      upload.width = Math.max(1, Math.round(source.naturalWidth * ratio)); upload.height = Math.max(1, Math.round(source.naturalHeight * ratio));
      upload.getContext('2d').drawImage(source, 0, 0, upload.width, upload.height);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, upload);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      ready = true; draw(performance.now(), true);
    } catch (error) { failed = true; fallback(); console.warn('Glass shader unavailable; using CSS glass.', error); }
    finally { initializing = false; }
  }
  function requestDraw(animate = false) {
    if (animate && !reducedMotion.matches) animateUntil = performance.now() + 700;
    if (!frame && !document.hidden && !failed) frame = requestAnimationFrame(draw);
  }
  function draw(now, warm = false) {
    frame = 0;
    if (!ready || failed || (document.hidden && !warm)) return;
    if (opaque()) { fallback(); return; }
    if (!warm && now - lastDraw < 30) { requestDraw(); return; }
    lastDraw = now;
    const scale = Math.min(devicePixelRatio || 1, 1.25);
    const scene = [innerWidth, innerHeight, scale].join(',');
    for (const surface of surfaces) {
      if (!surface.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const rect = surface.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.right < 0 || rect.left > innerWidth) continue;
      const style = getComputedStyle(surface), radius = parseFloat(style.borderTopLeftRadius) || 0;
      const key = scene + [rect.x, rect.y, rect.width, rect.height, radius].map(n => n.toFixed(1)).join(',');
      let layer = layers.get(surface);
      if (layer?.key === key) continue;
      if (!layer) {
        const canvas = document.createElement('canvas'); canvas.className = 'glass-material'; canvas.setAttribute('aria-hidden', 'true');
        surface.prepend(canvas); layer = { canvas, context: canvas.getContext('2d'), key: '' }; layers.set(surface, layer);
      }
      const width = Math.ceil(rect.width * scale), height = Math.ceil(rect.height * scale);
      if (gpuCanvas.width !== width || gpuCanvas.height !== height) { gpuCanvas.width = width; gpuCanvas.height = height; }
      gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(locations.origin, rect.x, rect.y); gl.uniform2f(locations.size, rect.width, rect.height);
      gl.uniform2f(locations.screen, innerWidth, innerHeight);
      gl.uniform1f(locations.scale, scale); gl.uniform1f(locations.radius, radius);
      const panel = surface.matches('.project-menu, .capture-menu, .inline-note');
      gl.uniform1f(locations.blur, panel ? 16 : 8); gl.uniform1f(locations.refraction, panel ? 16 : 24);
      gl.uniform1f(locations.edgeWidth, panel ? 13 : 16); gl.uniform1f(locations.tintAlpha, panel ? 0.48 : 0.32);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      layer.canvas.width = width; layer.canvas.height = height;
      layer.context.drawImage(gpuCanvas, 0, 0); layer.canvas.hidden = false; layer.key = key;
      surface.classList.add('glass-rendered');
    }
    document.documentElement.dataset.glassRenderer = 'egui-glass-shader-port';
    if (warm) document.dispatchEvent(new Event('glass-ready'));
    if (now < animateUntil) requestDraw();
  }
  gpuCanvas.addEventListener('webglcontextlost', event => { event.preventDefault(); ready = false; failed = true; fallback(); });
  const sizeObserver = new ResizeObserver(() => requestDraw());
  surfaces.forEach(surface => sizeObserver.observe(surface));
  new MutationObserver(records => {
    if (records.some(record => parents.has(record.target))) requestDraw(true);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  document.addEventListener('transitionrun', event => { if (parents.has(event.target)) requestDraw(true); });
  window.addEventListener('resize', () => requestDraw(true));
  document.addEventListener('visibilitychange', () => requestDraw());
  function materialChanged() { fallback(); if (!opaque()) { if (!ready) init(); else requestDraw(); } }
  reducedTransparency.addEventListener('change', materialChanged);
  forcedColors.addEventListener('change', materialChanged);
  document.addEventListener('glass-material-change', materialChanged);
  if (opaque()) fallback(); else init();
})();
