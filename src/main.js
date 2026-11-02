import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createBottle, LAYER_BOTTLE } from './bottle.js';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STILL = /[?&]still/.test(location.search);
const ASSET = 'assets/';
// Story progress is measured in "scene units": 0–1 covers scenes 01–02, 1–1.62 covers scene 03.
const P02END = 1 / 2.95;

/* ─────────── helpers ─────────── */
const clamp01 = v => Math.min(1, Math.max(0, v));
const seg = (p, a, b) => clamp01((p - a) / (b - a));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = t => 1 - Math.pow(1 - t, 3);
const rand = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

/* ─────────── renderer ─────────── */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const PR = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
renderer.setPixelRatio(PR);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 100);
camera.layers.enable(LAYER_BOTTLE);

const bgRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });

/* ─────────── textures ─────────── */
const loader = new THREE.TextureLoader();
const loaded = {};
let layoutReady = false;
function tex(name, { repeat = false } = {}) {
  const t = loader.load(ASSET + name, () => { loaded[name] = true; if (layoutReady) layout(); });
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const T = {
  ridge: tex('03-distant-ridge.webp'),
  basalt: tex('04-foreground-basalt.webp'),
  mist: tex('05-mist.webp'),
  ribbon: tex('06-mist-low-ribbon.webp'),
  curls: tex('07-mist-open-curls.webp'),
  bokeh: tex('s02_bg_bokeh.webp'),
  arc: tex('s02_wave_s.webp'),
  spray: tex('s02_spray_rgba.webp'),
  drops: tex('s02_drops2_atlas.webp'),
  dropsSoft: tex('s02_drops2_atlas_soft.webp'),
  cond: tex('02-condensation-sparse.webp', { repeat: true }),
  wave: tex('s02_wave_c_blur.webp'),
  sky: tex('s03_sky_trees.webp'),
  trees: tex('s03_canopy.webp'),
  leafAtlas: tex('s03_leaves_atlas.webp'),
  cliffs: tex('s04_cliffs_back.webp'),
  sea: tex('s05_sea.webp'),
  arch: tex('s05_arch.webp'),
  olive: tex('s05_olive.webp'),
  leavesLL: tex('s05_leaves_ll.webp'),
  pedestal: tex('s05_pedestal.webp'),
  oliveLeaves: tex('s05_leaves_atlas.webp'),
  oliveLeavesSoft: tex('s05_leaves_atlas_soft.webp'),
  dust: tex('s04_dust.webp'),
  ledge: tex('s04_ledge_front.webp'),
  rockL: tex('s04_rock_left.webp'),
  rockR: tex('s04_rock_right.webp'),
  streak: tex('s03_light_streak.webp'),
  concrete: tex('s03_concrete.webp', { repeat: true }),
  leafShadow: tex('s03_leaf_shadow.webp', { repeat: true }),
};

/* ─────────── background: scene-01 void + light disc that grows into the scene-02 water world ─────────── */
const bgU = {
  uAspect: { value: 1 }, uTime: { value: 0 },
  uC: { value: new THREE.Vector2(0.4, 0.1) }, uR: { value: 0.62 }, uDiscI: { value: 0 },
  uReveal: { value: 0 }, uInner: { value: 0 },
  uDark1: { value: new THREE.Color('#030a07') }, uDark2: { value: new THREE.Color('#123326') },
  uDisc: { value: new THREE.Color('#bfe6cc') },
  uBokeh: { value: T.bokeh }, uBokehAspect: { value: 1.5 }, uShift: { value: new THREE.Vector2() },
  uSky: { value: T.sky }, uSkyMix: { value: 0 }, uSkyShift: { value: new THREE.Vector2() },
  uCliffs: { value: T.cliffs }, uCliffMix: { value: 0 }, uCliffShift: { value: new THREE.Vector2() },
};
const bgMat = new THREE.ShaderMaterial({
  uniforms: bgU, depthTest: false, depthWrite: false,
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform float uAspect, uTime, uR, uDiscI, uReveal, uInner, uBokehAspect;
    uniform vec2 uC, uShift, uSkyShift; uniform vec3 uDark1, uDark2, uDisc; uniform sampler2D uBokeh, uSky, uCliffs; uniform float uSkyMix, uCliffMix; uniform vec2 uCliffShift;
    float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
    float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=.5; } return s; }
    void main(){
      vec2 p = vUv*2.-1.; p.x *= uAspect;
      // scene 01 void
      float g = smoothstep(1.9, 0.0, length(p - vec2(0.35, 0.15)));
      vec3 col = mix(uDark1, uDark2, g * 0.85);
      float m = fbm(p * 1.3 + vec2(uTime * 0.025, -uTime * 0.01));
      col += uDisc * 0.035 * smoothstep(0.45, 0.9, m) * smoothstep(1.2, -0.6, p.y);
      // disc → water surface
      vec2 q = p - uC; float d = length(q); float ang = atan(q.y, q.x);
      vec2 dirq = q / max(d, 1e-4);
      float wob = ((fbm(dirq * 1.6 + vec2(uTime * 0.25, -uTime * 0.17)) - 0.5) * 0.16 + sin(ang * 23.0 + uTime * 1.3) * 0.006) * uReveal;
      float R = uR + wob * (0.4 + uR * 0.25);
      float inside = 1.0 - smoothstep(R - 0.04 + 0.03 * uReveal, R + 0.015, d);
      float core = 1.0 - smoothstep(0.0, max(R, 0.001), d);
      vec3 disc = uDisc * (0.55 + 0.45 * core);
      // inside: bokeh water world, lensed near the rim
      vec2 buv = vUv - 0.5;
      if (uAspect > uBokehAspect) buv.y *= uBokehAspect / uAspect; else buv.x *= uAspect / uBokehAspect;
      buv = buv * 0.92 + 0.5 + uShift;
      float rimZone = exp(-max(R - d, 0.0) * 7.0) * uReveal;
      buv += normalize(q + 1e-5) * 0.05 * rimZone;
      vec3 bok = texture2D(uBokeh, buv).rgb * vec3(0.74, 0.86, 0.8);
      float blot = smoothstep(0.42, 0.78, fbm(p * 0.85 + vec2(uTime * 0.012, -uTime * 0.008) + 11.0));
      bok = mix(bok, bok * vec3(0.42, 0.66, 0.55), blot * 0.75);
      vec3 inner = mix(disc, bok, uInner);
      float halo = exp(-max(d - R, 0.0) * 3.2) * 0.28 * (1.0 - uInner);
      col += uDisc * uDiscI * halo;
      col = mix(col, inner * mix(uDiscI, 1.0, uInner), inside);
      // the rim itself: a bright meniscus line with a soft glow, only while it is travelling
      float rim = exp(-abs(d - R) * 110.0) * 1.1 + exp(-abs(d - R) * 14.0) * 0.18;
      col += vec3(0.88, 1.0, 0.94) * rim * uReveal * (1.0 - smoothstep(0.85, 1.0, uInner * step(2.2, uR)));
      // caustic web just inside the rim
      float c1 = fbm(p * 3.2 + vec2(uTime * 0.05, uTime * 0.03));
      float c2 = fbm(p * 3.2 - vec2(uTime * 0.04, -uTime * 0.02) + 4.0);
      col += vec3(1.0) * pow(1.0 - abs(c1 - c2) * 2.2, 9.0) * 0.12 * rimZone * inside;
      col *= 1.0 - 0.28 * smoothstep(0.7, 2.0, length(p * vec2(0.8, 1.0))) * (1.0 - 0.7 * uInner);
      if (uSkyMix > 0.001) {
        vec2 suv = vUv - 0.5;
        if (uAspect > 1.5) suv.y *= 1.5 / uAspect; else suv.x *= uAspect / 1.5;
        suv = suv * 0.62 + vec2(0.6, 0.07) + uSkyShift;
        vec3 sky = texture2D(uSky, suv).rgb * vec3(0.96, 1.0, 0.97);
        col = mix(col, sky, uSkyMix);
      }
      if (uCliffMix > 0.001) {
        vec2 cuv = vUv - 0.5;
        if (uAspect > 1.5) cuv.y *= 1.5 / uAspect; else cuv.x *= uAspect / 1.5;
        cuv = cuv * 0.98 + vec2(0.5, 0.53) + uCliffShift;
        vec3 cl = texture2D(uCliffs, cuv).rgb * 1.2;
        col = mix(col, cl, uCliffMix);
      }
      col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
bgMesh.frustumCulled = false; bgMesh.renderOrder = -1000;
scene.add(bgMesh);

/* ─────────── image layers (premultiplied; "behind" ones live in the opaque list so the glass refracts them) ─────────── */
const MODE = { RGBA: 0, GLOW: 1, WATER: 2 };
const SCREEN = { value: new THREE.Vector2(1, 1) };
const layerVS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const layerFS = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D map; uniform float uOpacity, uMode, uLod, uGain, uDark, uFeather, uNavSafe, uPR; uniform vec3 uTint, uShade; uniform vec2 uScreen;
  uniform vec4 uRect; uniform vec4 uMask;
  void main(){
    vec2 uv = uRect.xy + vUv * uRect.zw;
    vec4 t;
    if (uLod < 0.5) t = texture2D(map, uv);
    else {
      // soft defocus: mip bias + a ring of taps, radius in texture space grows with the blur
      float r = 0.0035 * uLod * uRect.z;
      t = texture2D(map, uv, uLod) * 0.2;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398 + 0.39;
        t += texture2D(map, uv + vec2(cos(a), sin(a)) * r, uLod) * 0.1;
      }
    }
    vec3 rgb; float a;
    if (uMode < 0.5) { a = t.a * uOpacity; rgb = t.rgb * uTint * a; }
    else if (uMode < 1.5) { rgb = t.rgb * uTint * uGain * uOpacity; a = 0.0; }
    else {
      float L = max(max(t.r, t.g), t.b);
      float hi = pow(L, 1.25) * uGain;
      float mid = smoothstep(0.004, 0.06, L) * (1.0 - smoothstep(0.3, 0.8, L));
      a = clamp(mid * uDark + L * 0.25, 0.0, 1.0) * uOpacity;
      rgb = vec3(hi) * uTint * uOpacity + uShade * a;
    }
    if (uFeather > 0.0) {
      vec2 e = min(vUv, 1.0 - vUv);
      float f = smoothstep(0.0, uFeather, e.x) * smoothstep(0.0, uFeather, e.y);
      rgb *= f; a *= f;
    }
    if (uMask.w > 0.0) {
      float m = smoothstep(uMask.z - uMask.w, uMask.z + uMask.w, dot(vUv - 0.5, uMask.xy));
      rgb *= m; a *= m;
    }
    if (uNavSafe > 0.5) {
      // keep the header band clean: fade water out under the navigation
      float k = smoothstep(80.0 * uPR, 190.0 * uPR, uScreen.y - gl_FragCoord.y);
      rgb *= k; a *= k;
    }
    gl_FragColor = vec4(rgb, a);
  }`;
function makeLayer(map, { mode = MODE.RGBA, w = 1, h, front = false, order = 0, gain = 1, dark = 0.5,
  tint = '#ffffff', shade = '#0c2a22', rect = [0, 0, 1, 1], mask = [0, 0, 0, 0], feather = 0.12 } = {}) {
  const img = map.image;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map }, uOpacity: { value: 1 }, uMode: { value: mode }, uLod: { value: 0 },
      uGain: { value: gain }, uDark: { value: dark }, uTint: { value: new THREE.Color(tint) },
      uShade: { value: new THREE.Color(shade) }, uRect: { value: new THREE.Vector4(...rect) },
      uMask: { value: new THREE.Vector4(...mask) }, uFeather: { value: feather },
      uNavSafe: { value: 0 }, uPR: { value: PR }, uScreen: SCREEN,
    },
    vertexShader: layerVS, fragmentShader: layerFS,
    transparent: front, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.userData.aspect = h ? w / h : null;
  mesh.scale.set(w, h || w, 1);
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
// plane aspect from the real pixels (fallback until the image arrives)
function imgRatio(mesh) {
  const t = mesh.material.uniforms.map.value, r = mesh.material.uniforms.uRect.value;
  return t.image && t.image.width ? (t.image.width / t.image.height) * (r.z / r.w) : 1.5;
}

/* scene 01 */
const L01 = {
  curls: makeLayer(T.curls, { mode: MODE.GLOW, w: 9, order: -900, gain: 0.35, tint: '#cfeedd' }),
  ridge: makeLayer(T.ridge, { w: 12, order: -880, tint: '#8fa79c' }),
  mist: makeLayer(T.mist, { mode: MODE.GLOW, w: 7, order: -860, gain: 0.45, tint: '#d6f2e2' }),
  basalt: makeLayer(T.basalt, { w: 6.2, order: -300 }),
  ribbon: makeLayer(T.ribbon, { mode: MODE.GLOW, w: 5.5, front: true, order: 200, gain: 0.5, tint: '#d6f2e2' }),
};

/* scene 02 */
const L02 = {
  spray: makeLayer(T.spray, { mode: MODE.RGBA, w: 7.5, order: -700, tint: '#dff2e6', feather: 0.1 }),
  wave: makeLayer(T.wave, { mode: MODE.RGBA, w: 5.2, order: -650, tint: '#dff2e6', feather: 0.04 }),
  arcBack: makeLayer(T.arc, { mode: MODE.RGBA, w: 4.4, order: -500, tint: '#dff2e6', feather: 0.03 }),
};

// drops from the atlas: static "frozen" drops + a few that fly past the lens
const DROPS = { cols: 6, rows: 3, count: 18 };
const drops = [];
function addDrop(o) {
  const i = Math.floor(rand() * DROPS.count);
  const rect = [(i % DROPS.cols) / DROPS.cols, 1 - (Math.floor(i / DROPS.cols) + 1) / DROPS.rows, 1 / DROPS.cols, 1 / DROPS.rows];
  const front = o.front;
  const m = makeLayer(o.soft ? T.dropsSoft : T.drops, { mode: MODE.RGBA, w: o.size * 1.45, h: o.size * 1.45, front, order: front ? 160 + drops.length : -400 + drops.length, tint: '#dff2e6', rect, feather: 0 });
  m.rotation.z = rand() * Math.PI * 2;
  m.material.uniforms.uNavSafe.value = 1;
  if (front) m.material.depthTest = false; // in-front drops never cut into the bottle
  Object.assign(m.userData, o);
  drops.push(m);
}
for (const k in L02) L02[k].material.uniforms.uNavSafe.value = 1;
for (let k = 0; k < 16; k++) {
  const z = lerp(-1.8, 0.9, rand());
  addDrop({ base: new THREE.Vector3(lerp(0.05, 2.1, rand()), lerp(-1.2, 1.1, rand()), z), size: lerp(0.05, 0.16, rand()), front: z > 0.25, fly: false, ph: rand() * 6.28 });
}
for (let k = 0; k < 16; k++) {
  const z = lerp(0.5, 1.9, rand()), soft = rand() < 0.5;
  addDrop({ base: new THREE.Vector3(lerp(-0.3, 2.0, rand()), lerp(-1.1, 1.0, rand()), z), size: soft ? lerp(0.12, 0.24, rand()) : lerp(0.04, 0.1, rand()), front: true, fly: false, ph: rand() * 6.28, soft, lod: 0 });
}
[[0.9, -0.2], [1.3, 0.55], [0.4, -0.75], [1.9, 0.3], [1.6, -0.45]].forEach(([x, y], k) => {
  addDrop({ base: new THREE.Vector3(x, y, -1.2), size: lerp(0.12, 0.2, rand()), front: true, fly: true, soft: true, t0: 0.64 + k * 0.045, ph: rand() * 6.28 });
});

/* ─────────── headline 01 as layered planes, so the bottle can pass between the words ─────────── */
const HEAD = [
  { text: 'OWN', z: 0.9, front: true },
  { text: 'YOUR', z: -0.75, front: false },
  { text: 'PULSE.', z: 0.45, front: true },
];
function wordTexture(text) {
  const size = 320, c = document.createElement('canvas');
  const x = c.getContext('2d');
  const font = `800 semi-expanded ${size}px "Archivo", "Helvetica Neue", Arial, sans-serif`;
  x.font = font; try { x.fontStretch = 'semi-expanded'; x.letterSpacing = `${-0.02 * size}px`; } catch (e) {}
  const w = Math.ceil(x.measureText(text).width + size * 0.12);
  c.width = w; c.height = Math.ceil(size * 1.0);
  x.font = font; try { x.fontStretch = 'semi-expanded'; x.letterSpacing = `${-0.02 * size}px`; } catch (e) {}
  x.fillStyle = '#ffffff'; x.textBaseline = 'alphabetic';
  x.fillText(text, size * 0.02, size * 0.82);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
  return { t, aspect: c.width / c.height };
}
const headMeshes = [];
async function buildHeadline() {
  try { await Promise.race([document.fonts.load('800 semi-expanded 100px "Archivo"'), new Promise(r => setTimeout(r, 3000))]); } catch (e) {}
  HEAD.forEach((h, i) => {
    const { t, aspect } = wordTexture(h.text);
    const m = makeLayer(t, { mode: MODE.RGBA, w: 1, h: 1, front: h.front, order: h.front ? 120 + i : -200 + i, feather: 0 });
    m.material.uniforms.uTint.value.set('#f1f2e9').multiplyScalar(1.25); // compensate the filmic curve so type stays milk-white
    m.userData = { ...h, aspect, line: i };
    headMeshes.push(m);
  });
  layout();
}

/* ─────────── scene 03: sunlit concrete path with court lines, built in 3D ─────────── */
const PATH = new THREE.CatmullRomCurve3([
  [2.4, 46], [2.0, 30], [1.4, 18], [1.0, 14], [0.5, 4], [0, -6], [-1.2, -16], [-4, -28], [-9, -40], [-16, -52], [-25, -62], [-36, -70], [-48, -76],
].map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
// strip along the path between two lateral offsets; vertical=true makes a wall between heights a..b at offset `at`
function ribbon({ a, b, at = 0, vertical = false, y = 0, n = 420 }) {
  const pos = [], uv = [], idx = [], len = PATH.getLength();
  const P = new THREE.Vector3(), Tn = new THREE.Vector3(), N = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const u = i / n; PATH.getPointAt(u, P); PATH.getTangentAt(u, Tn);
    N.set(Tn.z, 0, -Tn.x).normalize(); // left of travel
    for (const side of [0, 1]) {
      if (vertical) { const o = P.clone().addScaledVector(N, at); pos.push(o.x, side ? b : a, o.z); }
      else { const o = P.clone().addScaledVector(N, side ? b : a); pos.push(o.x, y, o.z); }
      uv.push(side * Math.abs(b - a) / 4, u * len / 4);
    }
    if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
const groundU = {
  uShadow: { value: T.leafShadow }, uFog: { value: new THREE.Color('#e3ebe4') }, uVis: { value: 0 },
  uTime: { value: 0 }, uFogNear: { value: 30 }, uFogFar: { value: 140 },
};
function groundMat(map, tint, wall = false) {
  return new THREE.ShaderMaterial({
    uniforms: { ...groundU, uTex: { value: map }, uTint: { value: new THREE.Color(tint) }, uWall: { value: wall ? 1 : 0 } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vLocal; varying float vDist;
      void main(){ vUv = uv; vLocal = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uTex, uShadow; uniform vec3 uTint, uFog; uniform float uVis, uTime, uFogNear, uFogFar, uWall;
      varying vec2 vUv; varying vec3 vLocal; varying float vDist;
      void main(){
        vec3 c = texture2D(uTex, vUv).rgb * uTint;
        vec2 sp = uWall > 0.5 ? vec2(vLocal.x + vLocal.z, vLocal.y * 1.6) * 0.16 : vLocal.xz * 0.075;
        float sh = texture2D(uShadow, sp + vec2(uTime * 0.003, uTime * 0.0015)).r;
        c *= mix(0.58, 1.1, smoothstep(0.2, 0.8, sh));
        if (uWall > 0.5) c *= mix(0.86, 1.0, smoothstep(0.0, 1.2, vLocal.y));
        c = mix(c, uFog, smoothstep(uFogNear, uFogFar, vDist));
        gl_FragColor = vec4(mix(uFog, c, uVis), 1.0);
      }`,
  });
}
const G03 = new THREE.Group(), G03in = new THREE.Group();
G03.add(G03in); scene.add(G03);
const concreteTint = '#f2ede2', courtGreen = '#1f5a3c';
[
  [ribbon({ a: -3.4, b: 6.6, y: 0 }), groundMat(T.concrete, concreteTint)],
  [ribbon({ a: -1.05, b: -0.95, y: 0.004 }), groundMat(T.concrete, courtGreen)],
  [ribbon({ a: 1.55, b: 1.66, y: 0.004 }), groundMat(T.concrete, courtGreen)],
  [ribbon({ a: 3.3, b: 3.62, y: 0.004 }), groundMat(T.concrete, courtGreen)],
  [ribbon({ at: -3.4, a: 0, b: 1.35, vertical: true }), groundMat(T.concrete, '#ece6da', true)],
  [ribbon({ at: -3.39, a: 0.5, b: 0.62, vertical: true }), groundMat(T.concrete, courtGreen, true)],
  [ribbon({ a: -3.75, b: -3.4, y: 1.35 }), groundMat(T.concrete, '#f6f2e9')],
  // left side: matching low wall so the path never ends in a raw edge
  [ribbon({ at: 6.2, a: 0, b: 1.1, vertical: true }), groundMat(T.concrete, '#ece6da', true)],
  [ribbon({ at: 6.19, a: 0.42, b: 0.52, vertical: true }), groundMat(T.concrete, courtGreen, true)],
  [ribbon({ a: 6.2, b: 6.55, y: 1.1 }), groundMat(T.concrete, '#f6f2e9')],
].forEach(([g, m], i) => { const mesh = new THREE.Mesh(g, m); mesh.renderOrder = -950 + i; mesh.frustumCulled = false; G03in.add(mesh); });
G03.visible = false;
const L03 = {
  trees: makeLayer(T.trees, { w: 30, order: -970, feather: 0, tint: '#eef3ea' }),
  streak: makeLayer(T.streak, { mode: MODE.GLOW, w: 12, front: true, order: 220, gain: 1.6, tint: '#fff6e6', feather: 0.08 }),
};

L03.trees.material.depthTest = false;
// left-side shade for scene 03: drawn after the path/trees/backdrop, before the bottle, text and leaves
const shadeU = { uOpacity: { value: 0 } };
const shade03 = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: shadeU, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `precision highp float; varying vec2 vUv; uniform float uOpacity;
    void main(){
      float a = pow(1.0 - smoothstep(0.0, 0.72, vUv.x), 1.25) * 0.4;
      a *= 0.85 + 0.15 * smoothstep(1.0, 0.3, vUv.y);
      a *= uOpacity;
      gl_FragColor = vec4(vec3(0.0) * a, a);
    }`,
}));
shade03.frustumCulled = false; shade03.renderOrder = -900; shade03.visible = false;
scene.add(shade03);
// light flash that hides the 02→03 set change; sits over the backdrop, under the bottle
const flashU = { uA: { value: 0 }, uR: { value: 0 }, uC: { value: new THREE.Vector2(0.5, 0.6) }, uWarm: { value: 0 }, uAsp: { value: 1 } };
const flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: flashU, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `precision highp float; varying vec2 vUv; uniform float uA, uR, uWarm, uAsp; uniform vec2 uC;
    void main(){
      float g = 1.0 - 0.12 * length((vUv - vec2(0.55, 0.5)) * vec2(1.6, 1.0));
      vec3 c = mix(vec3(1.0, 0.985, 0.95), vec3(1.0, 0.86, 0.62), uWarm) * 1.15 * g;
      float a = uA;
      if (uR > 0.0) {
        // burst of light growing from a point: soft hot core, crisp-ish expanding rim
        float d = length((vUv - uC) * vec2(uAsp, 1.0));
        a *= smoothstep(uR + 0.12, uR - 0.05, d);
        c += vec3(1.0, 0.9, 0.7) * exp(-abs(d - uR) * 18.0) * 0.6;
      }
      gl_FragColor = vec4(c * a, a);
    }`,
}));
flash.frustumCulled = false; flash.renderOrder = -880; flash.visible = false;
scene.add(flash);
const PC = new THREE.Vector3(), PT = new THREE.Vector3();
/* scene 05: Mediterranean terrace */
const L05 = {
  sea: makeLayer(T.sea, { w: 1, h: 1, order: -990, feather: 0 }),
  arch: makeLayer(T.arch, { w: 1, h: 1, order: -870, feather: 0 }),
  pedestal: makeLayer(T.pedestal, { w: 1, h: 1, order: -830, feather: 0 }),
  olive: makeLayer(T.olive, { w: 1, h: 1, front: true, order: 240, feather: 0 }),
  leavesLL: makeLayer(T.leavesLL, { w: 1, h: 1, front: true, order: 241, feather: 0 }),
};
for (const k in L05) L05[k].visible = false;
// soft contact shadow under the hovering bottle
const shadowTex = (() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(128, 128, 0, 128, 128, 120);
  g.addColorStop(0, 'rgba(30,22,14,1)'); g.addColorStop(0.4, 'rgba(30,22,14,0.6)'); g.addColorStop(1, 'rgba(40,30,20,0)');
  // squash the radial gradient into an ellipse; fill the whole canvas so no edge of the ellipse is clipped
  x.setTransform(1, 0, 0, 0.25, 0, 0); x.fillStyle = g; x.fillRect(0, -512, 256, 1024);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const shadow05 = makeLayer(shadowTex, { w: 1, h: 1, order: -829, feather: 0 }); shadow05.visible = false;
// scene 03: the bottle's soft shadow lying flat on the concrete
const shadow03 = makeLayer(shadowTex, { w: 1, h: 1, order: -930, feather: 0 });
shadow03.material.depthTest = false;
// scene 04: a faint shadow on the stone ledge (bottle hovers higher here)
const shadow04 = makeLayer(shadowTex, { w: 1, h: 1, front: true, order: 150, feather: 0 });
shadow04.material.depthTest = true; shadow04.visible = false; shadow03.visible = false;
// floating olive leaves: a few sharp near the set, a few soft and close to the lens
const OLIVE = [];
for (let i = 0; i < 9; i++) {
  const soft = i % 3 === 0, k = i % 6;
  const m = makeLayer(soft ? T.oliveLeavesSoft : T.oliveLeaves, { w: 1, h: 1, front: true, order: soft ? 250 + i : 236, feather: 0, rect: [(k % 3) / 3, 1 - (Math.floor(k / 3) + 1) / 2, 1 / 3, 0.5] });
  m.userData = { z: soft ? lerp(2.4, 3.6, rand()) : lerp(-2.6, -0.7, rand()), size: soft ? lerp(0.24, 0.38, rand()) : lerp(0.16, 0.26, rand()),
    ax: soft ? (rand() < 0.5 ? -0.85 : 0.88) : (rand() < 0.5 ? lerp(-0.1, 0.3, rand()) : lerp(0.75, 0.95, rand())), ay: lerp(-0.6, 0.75, rand()), ph: rand() * 6.28, sp: lerp(0.25, 0.5, rand()), rot: rand() * 6.28 };
  m.visible = false; OLIVE.push(m);
}
/* scene 04: basalt gap, layers pinned to the camera frame so edges never show */
const L04 = {
  rockL: makeLayer(T.rockL, { w: 1, h: 1, order: -860, feather: 0 }),
  rockR: makeLayer(T.rockR, { w: 1, h: 1, order: -861, feather: 0 }),
  dustBack: makeLayer(T.dust, { mode: MODE.GLOW, w: 1, h: 1, order: -844, gain: 1.1, tint: '#ffd9a8', feather: 0.3 }),
  beam: makeLayer(T.streak, { mode: MODE.GLOW, w: 1, h: 1, order: -845, gain: 0.55, tint: '#ffb873', feather: 0.1 }),
  ledge: makeLayer(T.ledge, { w: 1, h: 1, order: -840, feather: 0 }),
  dustFront: makeLayer(T.dust, { mode: MODE.GLOW, w: 1, h: 1, front: true, order: 206, gain: 0.7, tint: '#ffd9a8', feather: 0.1 }),
};
for (const k in L04) L04[k].visible = false;
// like pin(), but sets the bottom edge 12% of the frame height below the screen bottom
function pinBottom(m, z, cx, wFrac, ratio, below = 1.12) {
  const { hh, hw } = frameRect(z), w = 2 * hw * wFrac, h = w / ratio;
  m.scale.set(w, h, 1); m.position.set(camera.position.x + cx * hw, camera.position.y - hh * below + h / 2, z);
}
// full-frame layer that covers the viewport at depth z (with overscan for parallax)
function cover(m, z, over, dx = 0, dy = 0) {
  const { hh, hw } = frameRect(z), ratio = imgRatio(m);
  let w = 2 * hw, h = w / ratio;
  if (h < 2 * hh) { h = 2 * hh; w = h * ratio; }
  m.scale.set(w * over, h * over, 1);
  m.position.set(camera.position.x + dx * hw, camera.position.y + dy * hh, z);
}
function frameRect(z) { const d = camera.position.z - z, hh = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)); return { hh, hw: hh * camera.aspect }; }
// place a layer by frame fractions: cx/cy in [-1,1] of the frame at depth z, width as a fraction of frame width
function pin(m, z, cx, cy, wFrac, ratio) {
  const { hh, hw } = frameRect(z), w = 2 * hw * wFrac, h = w / ratio;
  m.scale.set(w, h, 1); m.position.set(camera.position.x + cx * hw, camera.position.y + cy * hh, z);
}
// out-of-focus leaves drifting through the frame (4 cut-outs from a 2x2 atlas, randomized)
const LEAVES = [];
for (let i = 0; i < 11; i++) {
  const k = i % 4;
  const rect = [(k % 2) / 2, 1 - (Math.floor(k / 2) + 1) / 2, 0.5, 0.5];
  const m = makeLayer(T.leafAtlas, { w: 1, h: 1, front: true, order: 230 + i, rect, feather: 0 });
  m.userData = {
    t0: 1.1 + (i / 11) * 0.42 + rand() * 0.03, dur: lerp(0.09, 0.15, rand()),
    D: lerp(1.3, 3.2, rand()), size: lerp(0.16, 0.34, rand()), y0: lerp(-0.85, 0.75, rand()), dy: lerp(-0.5, 0.35, rand()),
    spin: lerp(-3, 3, rand()), rot: rand() * 6.28, flip: rand() < 0.5 ? -1 : 1, ph: rand() * 6.28,
  };
  LEAVES.push(m);
}

/* ─────────── bottle ─────────── */
const bottle = createBottle(renderer, bgRT.texture, T.cond);
scene.add(bottle.root);

/* ─────────── lighting: env blends from the dark studio (01) to the bright water set (02) ─────────── */
const pmrem = new THREE.PMREMGenerator(renderer);
const softTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), img = x.createImageData(256, 256);
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
    const u = Math.abs(i / 255 * 2 - 1), v = Math.abs(j / 255 * 2 - 1);
    const k = Math.max(0, (1 - Math.pow(u, 2.2)) * (1 - Math.pow(v, 6))) * 255, o = (j * 256 + i) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = k; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.LinearSRGBColorSpace; return t;
})();
const softDisc = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, '#fff'); g.addColorStop(0.75, '#ddd'); g.addColorStop(1, '#000');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.LinearSRGBColorSpace; return t;
})();
function makeEnv({ walls, panels }) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), new THREE.MeshBasicMaterial({ color: walls, side: THREE.BackSide })));
  for (const p of panels) {
    if (p.i <= 0.001) continue;
    const geo = p.circle ? new THREE.CircleGeometry(p.r, 64) : new THREE.PlaneGeometry(p.w, p.h);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color).multiplyScalar(p.i), map: p.circle ? softDisc : softTex, side: THREE.DoubleSide }));
    m.position.set(...p.pos); m.lookAt(0, 0, 0); s.add(m);
  }
  const rt = pmrem.fromScene(s, 0.0);
  s.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  return rt.texture;
}
const ENV01 = { walls: '#06100b', panels: [
  { w: 1.6, h: 9, pos: [-6, 1, -2.5], color: '#e9fff1', i: 4 },
  { w: 1.0, h: 9, pos: [6, 1, -2], color: '#cfeedd', i: 6 },
  { w: 2.2, h: 5, pos: [-4.5, 2.5, 4.5], color: '#ffffff', i: 0.55 },
  { w: 5, h: 5, pos: [0, 8, 1], color: '#ffffff', i: 1.4 },
  { w: 5, h: 1.6, pos: [0, 6, 5], color: '#f4fff8', i: 1.1 },
  { circle: true, r: 3.2, pos: [1.2, 1, -7], color: '#bfe6cc', i: 3.5 },
  { w: 9, h: 2.6, pos: [0, -1, 8], color: '#9fc7b0', i: 0.5 },
] };
const ENV02 = { walls: '#7f9b8d', panels: [
  { w: 1.5, h: 10, pos: [-6, 1, 3], color: '#ffffff', i: 6 },
  { w: 1.0, h: 10, pos: [6, 1, 0], color: '#f2fff7', i: 6 },
  { w: 7, h: 7, pos: [0, 9, 0], color: '#ffffff', i: 2.2 },
  { w: 10, h: 6, pos: [0, 0, -9], color: '#dff2e7', i: 1.6 },
  { w: 9, h: 3, pos: [0, -2, 9], color: '#e8f5ee', i: 0.9 },
] };
const ENV03 = { walls: '#93ab9c', panels: [
  { w: 7, h: 7, pos: [6, 7, 4], color: '#fff1d8', i: 6 },
  { w: 9, h: 9, pos: [0, 10, 0], color: '#d6e8f2', i: 1.8 },
  { w: 1.2, h: 10, pos: [-6, 1, 3], color: '#ffffff', i: 3.5 },
  { w: 12, h: 5, pos: [0, 0, -9], color: '#7fa58a', i: 1.0 },
  { w: 12, h: 4, pos: [0, -6, 2], color: '#ece4d0', i: 1.2 },
] };
const ENV04 = { walls: '#0a0806', panels: [
  { w: 0.8, h: 10, pos: [3, 2, -6], color: '#ffb46a', i: 6 },
  { w: 1.2, h: 9, pos: [-6, 1, -2], color: '#d8e6dc', i: 2.2 },
  { w: 6, h: 2, pos: [0, 7, 3], color: '#ffffff', i: 0.8 },
  { w: 3, h: 9, pos: [6, 0, 4], color: '#ffcf98', i: 1.6 },
] };
const ENV05 = { walls: '#3c3a33', panels: [
  { w: 1.4, h: 10, pos: [6, 1, 2], color: '#fff3dc', i: 5 },
  { w: 6, h: 3, pos: [0, 2, -9], color: '#bfe0f2', i: 1.0 },
  { w: 1.0, h: 10, pos: [-6, 1, 0], color: '#ffffff', i: 3.0 },
  { w: 8, h: 2, pos: [0, -6, 2], color: '#efe4cc', i: 0.6 },
] };
const ENVS = [ENV01, ENV02, ENV03, ENV04, ENV05];
const ENV_STEPS = 6, envCache = [];
// t ∈ [0, 2]: 0 = studio (01), 1 = water (02), 2 = sunlit path (03)
function envAt(t) {
  const k = Math.round(Math.min(4, Math.max(0, t)) * ENV_STEPS);
  if (!envCache[k]) {
    const i = Math.min(3, Math.floor(k / ENV_STEPS)), f = k / ENV_STEPS - i;
    const A = ENVS[i], B = ENVS[i + 1];
    envCache[k] = makeEnv({
      walls: new THREE.Color(A.walls).lerp(new THREE.Color(B.walls), f),
      panels: [...A.panels.map(p => ({ ...p, i: p.i * (1 - f) })), ...B.panels.map(p => ({ ...p, i: p.i * f }))],
    });
  }
  return envCache[k];
}
const capStudio = makeEnv({ walls: '#1c2220', panels: [
  { w: 10, h: 4, pos: [0, 6, 3], color: '#ffffff', i: 1.5 },
  { w: 3, h: 9, pos: [-6, 1, 3], color: '#eef6f1', i: 1.8 },
  { w: 2, h: 9, pos: [6, 1, 1], color: '#ffffff', i: 2.0 },
  { w: 10, h: 3, pos: [0, -3, 6], color: '#a9b8b1', i: 0.8 },
] });
const capStudio2 = makeEnv({ walls: '#4d5a55', panels: [
  { w: 10, h: 4, pos: [0, 6, 3], color: '#ffffff', i: 2.4 },
  { w: 3, h: 9, pos: [-6, 1, 3], color: '#f2fbf6', i: 2.6 },
  { w: 2, h: 9, pos: [6, 1, 1], color: '#ffffff', i: 2.4 },
  { w: 6, h: 6, pos: [4, 4, -5], color: '#e8f5ee', i: 1.5 },
  { w: 10, h: 3, pos: [0, -3, 6], color: '#c3d4cc', i: 1.0 },
] });
envAt(0); envAt(1);

/* ─────────── post ─────────── */
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 8 }));
composer.setPixelRatio(PR);
composer.addPass(new RenderPass(scene, camera));
// sanitize HDR before bloom: replaces NaN/Inf and clamps fireflies so nothing spreads into black squares
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      bool bad = !(c.r == c.r) || !(c.g == c.g) || !(c.b == c.b) || c.r > 6e4 || c.g > 6e4 || c.b > 6e4;
      if (bad) {
        vec2 px = vec2(dFdx(vUv.x), dFdy(vUv.y));
        c = vec4(0.0);
        vec4 n1 = texture2D(tDiffuse, vUv + vec2(px.x, 0.0)), n2 = texture2D(tDiffuse, vUv - vec2(px.x, 0.0));
        if (n1.r == n1.r && n1.g == n1.g && n1.b == n1.b) c = n1; else if (n2.r == n2.r && n2.g == n2.g && n2.b == n2.b) c = n2;
      }
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 24.0), 1.0);
    }`,
}));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.55, 1.25);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ─────────── choreography ─────────── */
// Keyframes of the bottle and camera along page progress p ∈ [0, 1]. x/y in world units at z = 0.
let MOBILE = false;
const KEYS = () => MOBILE ? [
  { p: 0.00, x: 0.05, y: -0.42, z: 0, yaw: 0.95, roll: -0.12, pitch: 0.06, cx: 0, cy: 0.05, cd: 6.4 },
  { p: 0.06, x: 0.05, y: -0.42, z: 0, yaw: 0.95, roll: -0.12, pitch: 0.06, cx: 0, cy: 0.05, cd: 6.4 },
  { p: 0.38, x: 0.0, y: -0.15, z: 0.6, yaw: -0.3, roll: -0.05, pitch: 0.0, cx: 0, cy: 0.0, cd: 5.0 },
  { p: 0.56, x: -0.15, y: -1.0, z: 0.2, yaw: -0.8, roll: -0.55, pitch: 0.1, cx: 0, cy: -0.2, cd: 6.0 },
  { p: 0.78, x: 0.1, y: -0.45, z: 0.1, yaw: -1.55, roll: -0.66, pitch: 0.06, cx: 0, cy: 0.0, cd: 6.2 },
  { p: 0.92, x: 0.15, y: -0.4, z: 0, yaw: -1.2, roll: -0.7, pitch: 0.05, cx: 0, cy: 0.0, cd: 6.2 },
  { p: 1.00, x: 0.15, y: -0.4, z: 0, yaw: -1.2, roll: -0.7, pitch: 0.05, cx: 0, cy: 0.0, cd: 6.2 },
  { p: 1.12, x: 0.05, y: -0.3, z: 0.2, yaw: -0.9, roll: -1.2, pitch: 0.12, cx: 0, cy: 0.1, cd: 6.4 },
  { p: 1.50, x: 0.08, y: -0.3, z: 0.08, yaw: -0.42, roll: -0.82, pitch: 0.22, cx: 0, cy: 0.112, cd: 6.52 },
  { p: 1.64, x: 0.08, y: -0.3, z: 0.08, yaw: -0.42, roll: -0.82, pitch: 0.22, cx: 0, cy: 0.112, cd: 6.52 },
  { p: 1.84, x: 0.05, y: -0.4, z: 0.3, yaw: -1.25, roll: -0.1, pitch: 0.06, cx: 0, cy: 0.05, cd: 5.6 },
  { p: 2.14, x: 0.05, y: -0.42, z: 0.4, yaw: -0.18, roll: -0.06, pitch: 0.1, cx: 0, cy: 0.05, cd: 5.3 },
  { p: 2.27, x: 0.05, y: -0.42, z: 0.4, yaw: -0.18, roll: -0.06, pitch: 0.1, cx: 0, cy: 0.05, cd: 5.3 },
  { p: 2.5, x: 0.0, y: -0.5, z: 0, yaw: 6.283, roll: 0, pitch: 0.03, cx: 0, cy: 0, cd: 6.1 },
  { p: 2.95, x: 0.0, y: -0.54, z: 0, yaw: 6.283 + 0.12, roll: 0, pitch: 0.03, cx: 0, cy: 0.02, cd: 6.0 },
] : [
  { p: 0.00, x: 0.62, y: 0.02, z: 0, yaw: 0.95, roll: -0.14, pitch: 0.06, cx: 0, cy: 0.1, cd: 5.6 },
  { p: 0.06, x: 0.62, y: 0.02, z: 0, yaw: 0.95, roll: -0.14, pitch: 0.06, cx: 0, cy: 0.1, cd: 5.6 },
  { p: 0.38, x: 0.16, y: 0.06, z: 0.55, yaw: -0.3, roll: -0.06, pitch: 0.0, cx: 0.12, cy: 0.1, cd: 4.3 },
  { p: 0.56, x: 0.02, y: -0.8, z: 0.2, yaw: -0.8, roll: -0.55, pitch: 0.1, cx: 0.05, cy: -0.15, cd: 5.0 },
  { p: 0.78, x: 0.55, y: -0.12, z: 0.1, yaw: -1.55, roll: -0.68, pitch: 0.06, cx: 0.12, cy: 0.0, cd: 5.0 },
  { p: 0.92, x: 0.86, y: 0.08, z: 0, yaw: -1.2, roll: -0.72, pitch: 0.05, cx: 0.15, cy: 0.05, cd: 5.0 },
  { p: 1.00, x: 0.86, y: 0.08, z: 0, yaw: -1.2, roll: -0.72, pitch: 0.05, cx: 0.15, cy: 0.05, cd: 5.0 },
  { p: 1.12, x: 0.75, y: 0.06, z: 0.1, yaw: -0.9, roll: -1.2, pitch: 0.12, cx: 0.12, cy: 0.14, cd: 5.6 },
  { p: 1.50, x: 0.9, y: 0.1, z: 0.04, yaw: -0.42, roll: -0.82, pitch: 0.22, cx: 0.138, cy: 0.152, cd: 6.02 },
  { p: 1.64, x: 0.9, y: 0.1, z: 0.04, yaw: -0.42, roll: -0.82, pitch: 0.22, cx: 0.138, cy: 0.152, cd: 6.02 },
  { p: 1.84, x: 0.8, y: 0.08, z: 0, yaw: -1.2, roll: 0.02, pitch: 0.04, cx: 0, cy: 0, cd: 5.2 },
  { p: 2.14, x: 0.72, y: 0.1, z: 0, yaw: -0.06, roll: 0.1, pitch: 0.04, cx: 0, cy: 0, cd: 5.15 },
  { p: 2.27, x: 0.72, y: 0.1, z: 0, yaw: -0.06, roll: 0.1, pitch: 0.04, cx: 0, cy: 0, cd: 5.15 },
  // the one full turn of the story: the bottle spins through the light burst and settles on the pedestal
  { p: 2.5, x: 0.7, y: 0.14, z: 0, yaw: 6.283, roll: 0, pitch: 0.03, cx: 0, cy: 0, cd: 5.6 },
  { p: 2.95, x: 0.7, y: 0.1, z: 0, yaw: 6.283 + 0.12, roll: 0, pitch: 0.03, cx: -0.08, cy: 0.02, cd: 5.45 },
];
let keys = KEYS();
function sample(p) {
  let i = 0;
  while (i < keys.length - 2 && p > keys[i + 1].p) i++;
  const a = keys[i], b = keys[i + 1], t = ease(seg(p, a.p, b.p)), o = {};
  for (const k in a) o[k] = lerp(a[k], b[k], t);
  return o;
}

/* ─────────── layout (depends on viewport) ─────────── */
const tmpV = new THREE.Vector3();
let vw = 1, vh = 1;
function setCamera(s) {
  camera.position.set(s.cx, s.cy, s.cd);
  camera.lookAt(s.cx, s.cy * 0.5, 0);
  camera.updateMatrixWorld();
}
// world rect at depth z that maps to pixel box (left, top) with given pixel height, for the hero camera
function placeAt(mesh, pxLeft, pxTop, pxH, z) {
  const ndcX = pxLeft / vw * 2 - 1, ndcY = 1 - pxTop / vh * 2;
  const dist = camera.position.z - z;
  const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / vh;
  const h = pxH * worldPerPx, w = h * mesh.userData.aspect;
  tmpV.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  const k = (z - camera.position.z) / tmpV.z;
  const pt = camera.position.clone().addScaledVector(tmpV, k);
  mesh.scale.set(w, h, 1);
  mesh.position.set(pt.x + w / 2, pt.y - h / 2, z);
  mesh.userData.home = mesh.position.clone();
}
function layout() {
  vw = innerWidth; vh = innerHeight;
  const aspect = vw / vh;
  const wasMobile = MOBILE;
  MOBILE = aspect < 0.8;
  if (wasMobile !== MOBILE || !keys) keys = KEYS();
  camera.aspect = aspect;
  camera.fov = MOBILE ? 34 : 24;
  camera.updateProjectionMatrix();
  renderer.setSize(vw, vh, false);
  composer.setSize(vw, vh);
  bgRT.setSize(Math.round(vw * PR * 0.5), Math.round(vh * PR * 0.5));
  bgU.uAspect.value = aspect;
  SCREEN.value.set(vw * PR, vh * PR);
  // light disc sits behind the hero bottle
  setCamera(keys[0]);
  tmpV.set(keys[0].x, keys[0].y + 0.12, -3).project(camera);
  bgU.uC.value.set(tmpV.x * aspect, tmpV.y);
  // headline lines
  const fs = MOBILE ? Math.min(vw * 0.2, vh * 0.1) : Math.min(vh * 0.165, vw * 0.105);
  const left = MOBILE ? Math.max(16, vw * 0.06) : Math.max(44, vw * 0.06);
  const top0 = MOBILE ? vh * 0.11 : vh * 0.5 - fs * 1.62;
  headMeshes.forEach(m => placeAt(m, left - fs * 0.02, top0 + m.userData.line * fs * 0.86, fs, m.userData.z));
  const cap = document.getElementById('cap01');
  cap.style.left = left + 'px';
  cap.style.top = (top0 + 3 * fs * 0.86 + fs * 0.12) + 'px';
  cap.style.fontSize = Math.max(14, fs * 0.13) + 'px';
  // scene 01 set dressing
  const W = (z, s = keys[0]) => 2 * (s.cd - z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * aspect;
  const fitW = (mesh, z, k) => { const r = imgRatio(mesh); const w = W(z) * k; mesh.scale.set(w, w / r, 1); };
  const halfH = z => (keys[0].cd - z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const viewBottom = z => keys[0].cy - halfH(z);
  // put the image's ridge line (fraction from the top of the picture) at world height y
  const peakAt = (mesh, frac, y) => { mesh.position.y = y - (0.5 - frac) * mesh.scale.y; };
  L01.ridge.position.set(0.2, 0, -5); fitW(L01.ridge, -5, MOBILE ? 2.2 : 1.6);
  peakAt(L01.ridge, 0.36, viewBottom(-5) + halfH(-5) * 2 * (MOBILE ? 0.36 : 0.4));
  L01.curls.position.set(1.4, 0.2, -4); fitW(L01.curls, -4, 0.75);
  L01.mist.position.set(-0.6, -0.45, -1.6); fitW(L01.mist, -1.6, 0.9);
  L01.basalt.position.set(keys[0].x + 0.1, 0, 0.35); fitW(L01.basalt, 0.35, MOBILE ? 2.0 : 1.35);
  peakAt(L01.basalt, 0.44, keys[0].y - 0.75 - 0.16);
  L01.ribbon.position.set(-0.4, -0.95, 1.2); fitW(L01.ribbon, 1.2, 1.1);
  for (const k in L01) L01[k].userData.home = L01[k].position.clone();
  // scene 02 water set
  const mx = MOBILE ? 0.35 : 1;
  L02.arcBack.position.set(0.95 * mx, -0.3, -0.35);
  L02.wave.position.set(1.45 * mx, 0.15, -1.6); L02.wave.rotation.z = Math.PI + 0.25;
  L02.spray.position.set(0.9 * mx, 0.45, -2.6); L02.spray.rotation.z = 0.35;
  for (const k in L02) L02[k].userData.home = L02[k].position.clone();
  // scene 03: tree line sits on the far end of the path
  { const r = imgRatio(L03.streak); L03.streak.scale.set(12, 12 / r, 1); }
}

/* ─────────── scroll progress (smoothed, bidirectional) ─────────── */
let pTarget = 0, prog = 0, forced = null;
function readScroll() {
  const max = document.documentElement.scrollHeight - innerHeight;
  pTarget = max > 0 ? clamp01(scrollY / max) : 0;
}
addEventListener('scroll', readScroll, { passive: true });

/* ─────────── hybrid scroll: user drives inside a scene, transitions play on their own ─────────── */
// In scene units p. Forward: once the headline is fully gone (go), glide to where the next one is fully in (to).
// Backward: once the next headline starts leaving (back), glide to where the previous one is fully in (backTo).
const GAPS = [
  { go: 0.40, to: 0.79, back: 0.68, backTo: 0.27 },
  { go: 1.05, to: 1.32, back: 1.20, backTo: 0.98 },
  { go: 1.66, to: 1.98, back: 1.86, backTo: 1.60 },
  { go: 2.27, to: 2.62, back: 2.52, backTo: 2.2 },
];
let auto = null, lastP = 0;
const maxScroll = () => document.documentElement.scrollHeight - innerHeight;
function glideTo(pTo) {
  const from = scrollY, to = clamp01(pTo * P02END) * maxScroll();
  const dur = Math.min(2600, Math.max(1200, Math.abs(to - from) / innerHeight * 700));
  auto = { from, to, t0: performance.now(), dur };
}
function autoStep(now) {
  if (auto) {
    const k = Math.min(1, (now - auto.t0) / auto.dur);
    window.scrollTo(0, lerp(auto.from, auto.to, ease(k)));
    if (k >= 1) { auto = null; lastP = scrollY / maxScroll() / P02END; }
  }
  requestAnimationFrame(autoStep);
}
requestAnimationFrame(autoStep);
addEventListener('scroll', () => {
  if (auto || REDUCED) return;
  const pNow = scrollY / Math.max(1, maxScroll()) / P02END;
  for (const g of GAPS) {
    if (lastP <= g.go && pNow > g.go && pNow < g.to) { glideTo(g.to); break; }
    if (lastP >= g.back && pNow < g.back && pNow > g.backTo) { glideTo(g.backTo); break; }
  }
  lastP = pNow;
}, { passive: true });
// menu: jump to the point where each scene's headline is fully in
const SCENE_P = [0.0, 0.79, 1.32, 1.98, 2.62];
window.__goScene = i => {
  const to = i < 0 ? 0 : SCENE_P[i];
  auto = null; glideTo(to);
  auto.dur = Math.min(3200, Math.max(900, Math.abs(auto.to - auto.from) / innerHeight * 260));
  lastP = to;
};
const navLinks = [...document.querySelectorAll('.links [data-scene]')];
let navActive = -1;
// while gliding, swallow user input so the transition plays through
const block = e => { if (auto) e.preventDefault(); };
addEventListener('wheel', block, { passive: false });
addEventListener('touchmove', block, { passive: false });
addEventListener('keydown', e => { if (auto && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Home', 'End'].includes(e.key)) e.preventDefault(); });
addEventListener('resize', () => { layout(); readScroll(); });

/* ─────────── DOM hooks ─────────── */
const root = document.documentElement;
const dom = {
  cap01: document.getElementById('cap01'),
  head02: document.getElementById('head02'),
  head03: document.getElementById('head03'),
  head04: document.getElementById('head04'),
  head05: document.getElementById('head05'),
  idx: document.getElementById('idx'),
  cue: document.getElementById('cue'),
};
let uiMode = '', idxText = '';
function updateDom(p, intro) {
  const o1 = clamp01(intro * 1.4 - 0.4) * (1 - seg(p, 0.05, 0.16));
  dom.cap01.style.opacity = o1.toFixed(3);
  dom.cap01.style.transform = `translateY(${(1 - clamp01(intro * 1.4 - 0.4)) * 12 - seg(p, 0.05, 0.16) * 24}px)`;
  // visible while there is story left; dims during the big transition, gone at the end
  const dip = (a, b, c, d) => seg(p, a, b) - seg(p, c, d);
  dom.cue.style.opacity = (clamp01(intro * 2 - 1) * (1 - seg(p, 2.56, 2.62)) * (1 - 0.8 * dip(2.24, 2.28, 2.5, 2.56)) * (1 - 0.8 * dip(1.6, 1.66, 1.8, 1.86)) * (1 - 0.7 * dip(0.40, 0.45, 0.60, 0.66)) * (1 - 0.8 * dip(0.98, 1.03, 1.14, 1.2))).toFixed(3);
  const r02 = seg(p, 0.68, 0.79);
  dom.head02.style.setProperty('--r', r02.toFixed(4));
  const o02 = 1 - seg(p, 0.98, 1.05);
  dom.head02.style.opacity = o02.toFixed(3);
  dom.head02.setAttribute('aria-hidden', r02 < 0.5 || o02 < 0.5 ? 'true' : 'false');
  const r03 = seg(p, 1.2, 1.32);
  dom.head03.style.setProperty('--r', r03.toFixed(4));
  const o03 = 1 - seg(p, 1.6, 1.66);
  dom.head03.style.opacity = o03.toFixed(3);
  dom.head03.setAttribute('aria-hidden', r03 < 0.5 || o03 < 0.5 ? 'true' : 'false');
  const r04 = seg(p, 1.86, 1.98);
  dom.head04.style.setProperty('--r', r04.toFixed(4));
  const o04 = 1 - seg(p, 2.22, 2.27);
  dom.head04.style.opacity = o04.toFixed(3);
  dom.head04.setAttribute('aria-hidden', r04 < 0.5 || o04 < 0.5 ? 'true' : 'false');
  const r05 = seg(p, 2.5, 2.62);
  dom.head05.style.setProperty('--r', r05.toFixed(4));
  dom.head05.setAttribute('aria-hidden', r05 < 0.5 ? 'true' : 'false');
  dom.head05.classList.toggle('live', r05 > 0.9);
  const ui = (p > 0.5 && p < 1.68) || p > 2.36 ? 'light' : 'dark';
  const act = p < 0.5 ? 0 : p < 1.08 ? 1 : p < 1.68 ? 2 : p < 2.33 ? 3 : 4;
  if (act !== navActive) { navActive = act; navLinks.forEach((a, k) => a.setAttribute('aria-current', String(k === act))); }
  if (ui !== uiMode) { uiMode = ui; root.dataset.ui = ui; }
  const t = p > 1.08 ? '03 / 05 — Green velocity' : p > 0.5 ? '02 / 05 — Cold contact' : '01 / 05 — First impulse';
  if (t !== idxText) { idxText = t; dom.idx.textContent = t; }
}

/* ─────────── frame ─────────── */
const clock = new THREE.Clock();
const camLocal = new THREE.Matrix4();
let in04Glob = 0, in05Glob = 0;
let introT = 0, first = true, envK = -1, capStudioOn = null;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  introT = forced !== null ? 1 : Math.min(1, introT + dt / 2.6);
  const intro = REDUCED ? 1 : easeOut(introT);
  if (forced !== null) prog = forced; else prog += (pTarget - prog) * (1 - Math.exp(-dt * 7));
  const p = prog / P02END;
  const s = sample(p);
  const live = REDUCED ? 0 : 1;

  /* transition parameters */
  const tr = ease(seg(p, 0.40, 0.60));               // disc grows into the water world
  const reveal = seg(p, 0.39, 0.46);                 // rim becomes a water surface
  const inner = ease(seg(p, 0.42, 0.56));            // disc interior becomes scene 02
  const w02 = ease(seg(p, 0.47, 0.64));              // water set forms
  const out01 = ease(seg(p, 0.40, 0.56));            // scene 01 set leaves
  const out02 = ease(seg(p, 0.99, 1.10));            // water set stretches into a light streak and leaves
  const sky = ease(seg(p, 1.02, 1.12));              // air and sunlight come in
  const out03 = ease(seg(p, 1.66, 1.72));            // 03 set leaves under the second flash
  const out04 = ease(seg(p, 2.33, 2.38));
  const in05 = ease(seg(p, 2.33, 2.38)); in05Glob = in05;
  const in04 = ease(seg(p, 1.66, 1.72)) * (1 - out04); in04Glob = in04;
  const in03 = ease(seg(p, 1.04, 1.16)) * (1 - out03); // path fades out of the haze

  bgU.uTime.value = time * live;
  bgU.uR.value = lerp(lerp(0.3, 0.62, intro), 3.4, tr);
  bgU.uDiscI.value = intro;
  bgU.uReveal.value = reveal;
  bgU.uInner.value = inner;
  bgU.uShift.value.set(-(p - 0.6) * 0.05, (p - 0.6) * 0.03);
  bgU.uSkyMix.value = sky * (1 - out03) * (loaded['s03_sky_trees.webp'] ? 1 : 0);
  bgU.uCliffMix.value = in04 * (loaded['s04_cliffs_back.webp'] ? 1 : 0);
  // (scene 05 sea plate covers the background as an opaque layer)
  bgU.uCliffShift.value.set((p - 2.0) * 0.02, 0);

  /* bottle */
  const fl = live * Math.sin(time * 0.7) * 0.03;
  bottle.root.position.set(s.x, s.y + fl, s.z);
  bottle.root.rotation.set(s.pitch, 0, s.roll + live * Math.sin(time * 0.45) * 0.012, 'XYZ');
  bottle.spin.rotation.y = s.yaw;
  bottle.root.scale.setScalar(lerp(1, 0.88, in04Glob) * lerp(1, 0.94, in05)); // scene 04: a touch smaller, less in-your-face
  bottle.condUniforms.uOpacity.value = ease(seg(p, 0.5, 0.64)) * (1 - seg(p, 1.08, 1.22));
  const ek = Math.round((seg(p, 0.42, 0.58) + seg(p, 1.02, 1.14) + seg(p, 1.68, 1.78) + seg(p, 2.34, 2.44)) * ENV_STEPS);
  if (ek !== envK) { envK = ek; scene.environment = envAt(ek / ENV_STEPS); }
  const studio = p < 0.49;
  if (studio !== capStudioOn) { capStudioOn = studio; bottle.capMat.envMap = studio ? capStudio : capStudio2; bottle.capMat.needsUpdate = true; }
  bottle.capMat.envMapIntensity = 1.0;
  bottle.glassMat.envMapIntensity = lerp(1.1, 1.0, tr) * lerp(0.25, 1, intro);
  bottle.capMat.envMapIntensity *= lerp(0.2, 1, intro);
  bottle.liquidUniforms.uGlow.value = lerp(lerp(0.6, 0.85, tr), 0.95, sky) * lerp(0.3, 1, intro);
  renderer.toneMappingExposure = lerp(lerp(lerp(lerp(1.0, 0.95, tr), 1.0, sky), 1.18, in04Glob), 1.05, in05Glob);
  bottle.liquidUniforms.uGlow.value *= lerp(1, 4.5, in04Glob);

  /* camera */
  setCamera(s);

  /* scene 01 set */
  const head = clamp01(intro * 1.25 - 0.25) * (1 - seg(p, 0.27, 0.4));
  headMeshes.forEach(m => { m.material.uniforms.uOpacity.value = head; m.visible = head > 0.001; });
  L01.ridge.material.uniforms.uOpacity.value = (1 - out01) * lerp(0.0, 1, intro);
  L01.curls.material.uniforms.uOpacity.value = (1 - out01) * intro;
  L01.mist.material.uniforms.uOpacity.value = (1 - out01) * intro;
  L01.ribbon.material.uniforms.uOpacity.value = (1 - out01) * intro * (0.6 + 0.4 * (1 - seg(p, 0.1, 0.3)));
  L01.basalt.material.uniforms.uOpacity.value = 1 - seg(p, 0.5, 0.58);
  L01.basalt.position.y = L01.basalt.userData.home.y - out01 * 1.8;
  L01.ridge.position.y = L01.ridge.userData.home.y - out01 * 0.8;
  L01.mist.position.x = L01.mist.userData.home.x + live * Math.sin(time * 0.05) * 0.4;
  L01.curls.position.x = L01.curls.userData.home.x + live * Math.sin(time * 0.04 + 1) * 0.3;
  L01.ribbon.position.x = L01.ribbon.userData.home.x + live * Math.sin(time * 0.07 + 2) * 0.35 - p * 1.2;
  for (const k in L01) L01[k].visible = L01[k].material.uniforms.uOpacity.value > 0.002;

  /* scene 02 set */
  const grow = lerp(0.75, 1, w02);
  for (const k of ['arcBack', 'wave', 'spray']) {
    const m = L02[k];
    m.material.uniforms.uOpacity.value = ({ spray: 0.18, wave: 0.85, arcBack: 1 })[k] * w02 * (1 - out02) * (loaded[{ arcBack: 's02_wave_s.webp', wave: 's02_wave_c_blur.webp', spray: 's02_spray_rgba.webp' }[k]] ? 1 : 0);
    m.visible = w02 * (1 - out02) > 0.002;
    m.position.copy(m.userData.home);
    m.position.x += (p - 0.78) * (k === 'spray' ? -0.6 : -0.25);
  }
  L02.arcBack.scale.setScalar(1); L02.arcBack.scale.set(4.4 * grow, 4.4 * grow / (1536 / 1024), 1);
  L02.wave.scale.set(5.2 * grow, 5.2 * grow / 1.5, 1);
  // the water arc stretches out along its own direction into a streak of light
  L02.arcBack.scale.x *= 1 + out02 * 3.5; L02.arcBack.scale.y *= 1 - out02 * 0.75;
  L02.arcBack.rotation.z = -0.1 * out02;
  const dropsOn = w02 * (1 - out02) * (loaded['s02_drops2_atlas.webp'] && loaded['s02_drops2_atlas_soft.webp'] ? 1 : 0);
  for (const d of drops) {
    const u = d.material.uniforms, o = d.userData;
    if (o.fly) {
      const k = seg(p, o.t0, o.t0 + 0.2);
      d.position.set(o.base.x * (1 + k * 0.6), o.base.y * (1 + k * 0.4), lerp(-1.2, s.cd - 0.15, Math.pow(k, 1.6)));
      const near = s.cd - d.position.z;
      u.uOpacity.value = dropsOn * (k > 0 && k < 1 ? 1 : 0) * clamp01((near - 0.25) * 3);
      u.uLod.value = 0;
    } else {
      d.position.set(o.base.x - (p - 0.78) * (0.2 + o.base.z * 0.3), o.base.y + live * Math.sin(time * 0.3 + o.ph) * 0.01, o.base.z);
      u.uOpacity.value = dropsOn;
      u.uLod.value = o.lod ?? Math.max(0, (o.base.z - 0.4) * 2);
    }
    d.visible = u.uOpacity.value > 0.002;
  }

  /* scene 03 */
  // soft shadow on the concrete just below the bottle, follows it at a short distance
  shadow03.visible = in03 > 0.001;
  if (shadow03.visible) {
    const sc = bottle.root.scale.x;
    shadow03.position.set(bottle.root.position.x + 0.05, bottle.root.position.y - 1.1 * sc, bottle.root.position.z - 0.3);
    shadow03.scale.set(3.4 * sc, 0.95 * sc, 1);
    shadow03.material.uniforms.uOpacity.value = in03 * groundU.uVis.value * 0.8;
  }
  shadeU.uOpacity.value = MOBILE ? 0 : in03; shade03.visible = !MOBILE && in03 > 0.001;
  // flash: up with the streak, holds while the new set settles, then dissolves together with the streak
  const fl03 = ease(seg(p, 0.99, 1.04)) * (1 - ease(seg(p, 1.15, 1.22)));
  // second flash 03→04: the bright strip crosses, the dark stone opens behind it and the pace drops
  const fl04 = ease(seg(p, 1.63, 1.67)) * (1 - ease(seg(p, 1.72, 1.82)));
  const burst = seg(p, 2.27, 2.37), fl05 = ease(seg(p, 2.27, 2.33)) * (1 - ease(seg(p, 2.38, 2.5)));
  const flA = Math.max(fl03, fl04, fl05);
  flashU.uA.value = flA; flash.visible = flA > 0.001;
  flashU.uR.value = fl05 > fl03 && fl05 > fl04 ? lerp(0.02, 2.4, Math.pow(burst, 1.6)) : 0;
  flashU.uWarm.value = fl05 > fl04 ? 0.8 * (1 - seg(p, 2.36, 2.5)) : 0;
  flashU.uAsp.value = camera.aspect; flashU.uC.value.set(0.56, 0.82);
  G03.visible = in03 > 0.001;
  if (G03.visible) {
    groundU.uVis.value = in03; groundU.uTime.value = time * live;
    // travel along the path: the curve point under the camera is pinned, the world turns to follow it
    const u = lerp(0.2, 0.44, seg(p, 1.04, 1.62));
    PATH.getPointAt(u, PC); PATH.getTangentAt(u, PT);
    G03in.position.set(-PC.x, 0, -PC.z);
    G03.position.set(MOBILE ? 0.2 : 0.9, -1.35, s.cd - 6.5);
    G03.rotation.y = Math.atan(-PT.x / PT.z);
  }
  // one canopy band across the whole frame, tops at ~18% from the top, foot hidden behind the wall
  {
    const m = L03.trees, z = -26, d = camera.position.z - z;
    const hh = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), r = imgRatio(m);
    const w = 2 * hh * camera.aspect * 1.6, h = w / r;
    m.scale.set(w, h, 1);
    const top = camera.position.y + hh * (1 - 2 * (MOBILE ? 0.3 : 0.17));
    // gentle parallax: drifts right by ~10% of the frame over the whole scene, well inside the 30% side margin
    m.position.set(camera.position.x + hh * camera.aspect * 0.2 * (seg(p, 1.04, 1.62) - 0.5), top - (0.5 - 0.11) * h, z);
    m.material.uniforms.uOpacity.value = in03; m.visible = in03 > 0.001;
  }
  // light streak: born from the stretched arc, sweeps across the frame
  const st1 = seg(p, 0.99, 1.22), st2 = seg(p, 1.62, 1.82);
  const st = st2 > 0 ? st2 : st1, stB = Math.sin(Math.PI * st);
  L03.streak.visible = stB > 0.002;
  L03.streak.material.uniforms.uOpacity.value = stB * (loaded['s03_light_streak.webp'] ? 1 : 0);
  L03.streak.position.set(camera.position.x + lerp(-2.5, 3.5, ease(st)), camera.position.y + lerp(-0.6, 0.35, ease(st)) - 0.1, camera.position.z - 3.8);
  L03.streak.rotation.z = st2 > 0 ? -0.18 : 0.22;
  /* scene 05 */
  {
    const on = in05 > 0.001;
    for (const k in L05) L05[k].visible = on;
    shadow05.visible = on;
    if (on) {
      const ok = n => (loaded[n] ? 1 : 0), settle = ease(seg(p, 2.36, 2.56)), dr = (p - 2.7) * 0.04;
      cover(L05.sea, -9, 1.08, -dr * 0.4, 0.02);
      cover(L05.arch, -4, 1.06, (1 - settle) * 0.35 - dr, 0);
      { // olive branch: smaller, soft, tucked into the top-left corner
        const { hh, hw } = frameRect(1.8), w = 2 * hw * (MOBILE ? 0.7 : 0.42), h = w / imgRatio(L05.olive);
        L05.olive.scale.set(w, h, 1);
        L05.olive.position.set(camera.position.x - hw + w / 2 - w * 0.04 - (1 - settle) * 0.4, camera.position.y + hh - h / 2 + h * 0.04 + (1 - settle) * 0.4 + live * Math.sin(time * 0.6) * 0.006, 1.8);
      }
      cover(L05.leavesLL, 3.0, 1.1, -(1 - settle) * 0.6 + dr * 2, -(1 - settle) * 0.5);
      // pedestal: locked under the bottle, rises into place
      // pedestal belongs to the floor: placed once under the bottle's resting pose (final camera),
      // then pinned to the frame exactly like the terrace layer, so it never slides on its own
      const kEnd = keys[keys.length - 1], zp = -0.25;
      const dEnd = kEnd.cd - zp, hhE = dEnd * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), hwE = hhE * camera.aspect;
      const bx = kEnd.x, by = kEnd.y - 0.75 * 0.94 - 0.16;
      const pwE = MOBILE ? 2.2 : 2.4, fW = pwE / (2 * hwE), fx = (bx - kEnd.cx) / hwE, fy = (by - kEnd.cy) / hhE;
      const { hh: hhP, hw: hwP } = frameRect(zp), pw = fW * 2 * hwP, ph = pw / imgRatio(L05.pedestal);
      const px = camera.position.x + (fx - dr) * hwP, py = camera.position.y + fy * hhP;
      L05.pedestal.scale.set(pw, ph, 1);
      L05.pedestal.position.set(px - (0.63 - 0.5) * pw, py + (0.70 - 0.5) * ph, zp);
      shadow05.scale.set(pw * 0.62, pw * 0.14, 1);
      shadow05.position.set(px, py + 0.02, zp + 0.05);
      L05.sea.material.uniforms.uOpacity.value = in05 * ok('s05_sea.webp');
      L05.arch.material.uniforms.uOpacity.value = in05 * ok('s05_arch.webp');
      L05.pedestal.material.uniforms.uOpacity.value = in05 * ok('s05_pedestal.webp');
      L05.olive.material.uniforms.uOpacity.value = in05 * ok('s05_olive.webp');
      L05.leavesLL.material.uniforms.uOpacity.value = in05 * ok('s05_leaves_ll.webp');
      shadow05.material.uniforms.uOpacity.value = in05 * settle * (0.95 + 0.05 * live * Math.sin(time * 0.7));
    }
    const lok = loaded['s05_leaves_atlas.webp'] && loaded['s05_leaves_atlas_soft.webp'] ? 1 : 0;
    for (const m of OLIVE) {
      const o = m.userData; m.visible = on && lok;
      if (!m.visible) continue;
      const { hh, hw } = frameRect(o.z);
      const t = time * o.sp * live + o.ph;
      m.position.set(camera.position.x + (o.ax + Math.sin(t * 0.7) * 0.03 + (p - 2.7) * 0.05) * hw, camera.position.y + (o.ay + Math.sin(t) * 0.04) * hh, o.z);
      m.scale.set(o.size, o.size, 1);
      m.rotation.z = o.rot + Math.sin(t * 0.8) * 0.25;
      m.material.uniforms.uOpacity.value = ease(seg(p, 2.4, 2.55));
    }
  }
  /* scene 04 */
  {
    const on = in04 > 0.001;
    for (const k in L04) L04[k].visible = on;
    shadow04.visible = false; // scene 04 shadow disabled
    if (on) {
      const r = m => imgRatio(m), drift = (p - 2.0) * 0.12, sway = live * Math.sin(time * 0.25) * 0.01;
      pinBottom(L04.rockL, -5, MOBILE ? -1.12 : -1.06 + drift * 0.3, MOBILE ? 0.38 : 0.22, r(L04.rockL), MOBILE ? 1.12 : 0.98);
      pinBottom(L04.rockR, -5, MOBILE ? 1.08 : 0.98 + drift * 0.5, MOBILE ? 0.5 : 0.3, r(L04.rockR), MOBILE ? 1.12 : 0.98);
      pin(L04.dustBack, -4.1, 0.14 + drift * 0.5, 0.31, 0.36, 0.79);
      L04.dustBack.material.uniforms.uRect.value.set(0.24, 0, 0.79 / 1.5, 1); // crop a portrait slice instead of squashing the image // a tall column of dust in the light gap, behind the bottle
      pin(L04.beam, -4, 0.35 + drift, MOBILE ? 0.62 : 0.25, 1.6, imgRatio(L04.beam));
      L04.beam.rotation.z = -0.95;
      pin(L04.ledge, 0.9, drift * 0.3, MOBILE ? -0.98 : -0.89, MOBILE ? 1.8 : 1.1, r(L04.ledge));
      pin(L04.dustFront, 2.2, -sway * 2 - drift * 0.8, 0.05, 1.3, 1.5);
      const ok = n => (loaded[n] ? 1 : 0);
      L04.rockL.material.uniforms.uOpacity.value = in04 * ok('s04_rock_left.webp');
      L04.rockR.material.uniforms.uOpacity.value = in04 * ok('s04_rock_right.webp');
      L04.ledge.material.uniforms.uOpacity.value = in04 * ok('s04_ledge_front.webp');
      L04.dustBack.material.uniforms.uOpacity.value = in04 * ok('s04_dust.webp');
      L04.dustFront.material.uniforms.uOpacity.value = 0; L04.dustFront.visible = false;
      L04.dustFront.material.uniforms.uLod.value = 2.5;
      L04.beam.material.uniforms.uOpacity.value = in04 * 0.7 * ok('s03_light_streak.webp');
      {
        // the ledge top sits a fixed distance below the bottle on screen; place the shadow there at the bottle's depth
        const sc = bottle.root.scale.x, zb = bottle.root.position.z - 0.3;
        const { hh } = frameRect(zb), ledgeTopNdc = MOBILE ? -0.8 : -0.82;
        shadow04.position.set(bottle.root.position.x + 0.05, camera.position.y + ledgeTopNdc * hh, zb);
        shadow04.scale.set(1.1, 0.26, 1);
        shadow04.material.uniforms.uOpacity.value = 0;
      }
    }
  }
  // leaves: each crosses the frame right → left at its own depth while scene 03 scrolls
  const leavesOK = loaded['s03_leaves_atlas.webp'] ? 1 : 0;
  for (const m of LEAVES) {
    const o = m.userData, k = (p - o.t0) / o.dur;
    const on = k > 0 && k < 1 && leavesOK;
    m.visible = !!on;
    if (!on) { m.material.uniforms.uOpacity.value = 0; continue; }
    const hh = o.D * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), hw = hh * camera.aspect;
    const x = lerp(hw * 1.25, -hw * 1.25, k), y = (o.y0 + o.dy * k) * hh + live * Math.sin(time * 1.3 + o.ph) * hh * 0.03;
    m.position.set(camera.position.x + x, camera.position.y + y, camera.position.z - o.D);
    m.scale.set(o.size * o.flip, o.size, 1);
    m.rotation.z = o.rot + o.spin * k + live * Math.sin(time * 1.1 + o.ph) * 0.15;
    m.material.uniforms.uOpacity.value = Math.min(1, Math.sin(Math.PI * k) * 3);
  }
  updateDom(p, intro);

  /* liquid refraction source: everything except the bottle */
  bottle.root.updateMatrixWorld(true);
  camLocal.copy(bottle.liquid.matrixWorld).invert();
  bottle.liquidUniforms.uCamLocal.value.copy(camera.position).applyMatrix4(camLocal);
  camera.layers.set(0);
  renderer.setRenderTarget(bgRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  camera.layers.enable(LAYER_BOTTLE);

  composer.render(dt);

  if (first) { first = false; requestAnimationFrame(() => canvas.classList.add('on')); window.__ready = true; }
  if (!STILL) requestAnimationFrame(frame);
}

window.__frame = (n = 1) => { for (let i = 0; i < n; i++) frame(); };
window.__setP = v => { forced = v; };
window.__setQ = q => { forced = q * P02END; };
window.__loaded = () => Object.keys(loaded).length;

layoutReady = true;
layout();
readScroll();
buildHeadline();
requestAnimationFrame(frame);
