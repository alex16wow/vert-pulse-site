import * as THREE from 'three';
import { SPEC, TOTAL_H, slabProfile, sweepGeometry } from './geometry.js';

export const LAYER_BOTTLE = 1;

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100" fill="none"><g stroke="#ffffff" stroke-width="3.6" stroke-linecap="square" stroke-linejoin="miter"><path d="M26 31L46 69L66 31"/><path d="M129 31H101V69H129M101 49H126"/><path d="M111 21L122 15" stroke-width="3"/><path d="M169 69V31H188C199 31 204 35 204 42S199 53 188 53H169M187 53L206 69"/><path d="M238 31H272M255 31V69"/></g></svg>`;

function brushedTexture(aniso) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 2048;
  const x = c.getContext('2d');
  x.fillStyle = 'rgb(128,128,128)'; x.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 2600; i++) {
    const y = Math.random() * c.height, v = 100 + Math.random() * 60, a = 0.25 + Math.random() * 0.5;
    x.fillStyle = `rgba(${v},${v},${v},${a})`;
    x.fillRect(0, y, c.width, Math.random() < 0.85 ? 1 : 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

async function labelTexture(aniso) {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
  const x = c.getContext('2d');
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(LOGO_SVG);
  try { await img.decode(); } catch (e) {}
  try { await Promise.race([document.fonts.load('600 100px "Archivo"'), new Promise(r => setTimeout(r, 2500))]); } catch (e) {}
  const s = 5.2;
  x.drawImage(img, 1024 - 149 * s, 380 - 42 * s, 300 * s, 100 * s);
  x.fillStyle = '#ffffff';
  x.font = '600 92px "Archivo", "Helvetica Neue", Arial, sans-serif';
  const word = 'PULSE', track = 0.42 * 92;
  const widths = [...word].map(ch => x.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + track * (word.length - 1);
  let px = 1024 - total / 2;
  [...word].forEach((ch, i) => { x.fillText(ch, px, 700); px += widths[i] + track; });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

/**
 * Builds the bottle. Hierarchy: root (position, roll, pitch) → spin (yaw about the long axis) → body meshes.
 * `bgTexture` is a render of everything except the bottle, used by the liquid for refraction.
 */
export function createBottle(renderer, bgTexture, condensationTex) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const brushed = brushedTexture(aniso);

  const glassMat = new THREE.MeshPhysicalMaterial({
    color: '#b4dcbd', metalness: 0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, // frosted body, glossy surface
    transmission: 1, thickness: 0.42, ior: 1.5, dispersion: 0.8,
    attenuationColor: new THREE.Color('#2e7a46'), attenuationDistance: 1.6,
    specularIntensity: 1, side: THREE.FrontSide,
  });
  const capMat = new THREE.MeshPhysicalMaterial({
    color: '#e4e8e6', metalness: 1, roughness: 0.3,
    roughnessMap: brushed, bumpMap: brushed, bumpScale: 0.25,
  });
  const neckMat = new THREE.MeshPhysicalMaterial({
    color: '#050706', metalness: 0, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08,
  });

  const L = SPEC.liquid;
  const liquidUniforms = {
    uBg: { value: bgTexture },
    uMin: { value: new THREE.Vector3(-L.w / 2 + 0.002, L.y0, -L.d / 2 + 0.002) },
    uMax: { value: new THREE.Vector3(L.w / 2 - 0.002, L.y1, L.d / 2 - 0.002) },
    uCamLocal: { value: new THREE.Vector3() },
    uSigma: { value: new THREE.Vector3() },
    uGlowColor: { value: new THREE.Color('#123f20') },
    uGlow: { value: 0.6 },
  };
  const T = new THREE.Color('#7cc089'); // outer layer: a tone lighter // darker than the glass so the inner block reads
  liquidUniforms.uSigma.value.set(-Math.log(T.r) / 0.5, -Math.log(T.g) / 0.5, -Math.log(T.b) / 0.5);
  const liquidMat = new THREE.ShaderMaterial({
    uniforms: liquidUniforms,
    vertexShader: /* glsl */`
      varying vec3 vLocal; varying vec3 vNormalL; varying vec4 vClip;
      void main(){ vLocal = position; vNormalL = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); vClip = gl_Position; }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vLocal; varying vec3 vNormalL; varying vec4 vClip;
      uniform sampler2D uBg; uniform vec3 uMin, uMax, uCamLocal, uSigma, uGlowColor; uniform float uGlow;
      uniform mat4 modelMatrix, projectionMatrix;
      void main(){
        vec3 rd = normalize(vLocal - uCamLocal);
        vec3 n = normalize(vNormalL);
        if (dot(n, rd) > 0.0) n = -n;
        vec3 rr = refract(rd, n, 1.0 / 1.06); // the glass does the bending now; liquid only absorbs
        if (dot(rr, rr) < 1e-4) rr = rd;
        vec3 far = mix(uMin, uMax, step(0.0, rr));
        vec3 tA = (far - vLocal) / (rr + sign(rr) * 1e-5 + vec3(equal(rr, vec3(0.0))) * 1e-5);
        float t = max(min(min(tA.x, tA.y), tA.z), 0.0);
        vec3 exitL = vLocal + rr * t;
        vec3 dirW = normalize(mat3(modelMatrix) * rr);
        vec3 pW = (modelMatrix * vec4(exitL, 1.0)).xyz + dirW * 0.12;
        vec4 clip = projectionMatrix * viewMatrix * vec4(pW, 1.0);
        clip.w = max(clip.w, 1e-3);
        vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
        vec2 base = vClip.xy / max(vClip.w, 1e-3) * 0.5 + 0.5;
        // keep the refraction offset bounded: grazing faces otherwise jump across the screen and flicker
        vec2 off = suv - base;
        float ol = length(off);
        off *= min(1.0, 0.05 / max(ol, 1e-5));
        suv = base + off;
        // soft 9-tap gather: hides the half-res source and stops shimmer while rotating
        vec2 r = vec2(0.01, 0.016);
        vec3 bg = texture2D(uBg, clamp(suv, 0.001, 0.999)).rgb * 0.2;
        bg += texture2D(uBg, clamp(suv + vec2( r.x, 0.0), 0.001, 0.999)).rgb * 0.1;
        bg += texture2D(uBg, clamp(suv + vec2(-r.x, 0.0), 0.001, 0.999)).rgb * 0.1;
        bg += texture2D(uBg, clamp(suv + vec2(0.0,  r.y), 0.001, 0.999)).rgb * 0.1;
        bg += texture2D(uBg, clamp(suv + vec2(0.0, -r.y), 0.001, 0.999)).rgb * 0.1;
        bg += texture2D(uBg, clamp(suv + r * 0.8, 0.001, 0.999)).rgb * 0.1;
        bg += texture2D(uBg, clamp(suv - r * 0.8, 0.001, 0.999)).rgb * 0.1;
        bg += texture2D(uBg, clamp(suv + vec2(r.x, -r.y) * 0.8, 0.001, 0.999)).rgb * 0.1;
        bg += texture2D(uBg, clamp(suv + vec2(-r.x, r.y) * 0.8, 0.001, 0.999)).rgb * 0.1;
        // soften very dark silhouettes so the liquid never punches to black
        float lum = dot(bg, vec3(0.2126, 0.7152, 0.0722));
        bg = mix(bg, vec3(lum), 0.25) + vec3(0.012, 0.03, 0.02);
        vec3 col = bg * exp(-uSigma * t);
        float h = clamp((vLocal.y - uMin.y) / (uMax.y - uMin.y), 0.0, 1.0);
        col += uGlowColor * uGlow * (1.0 - exp(-t * 2.6)) * (0.22 + 0.55 * pow(1.0 - h, 1.6));
        col *= 1.0 - 0.45 * pow(1.0 - abs(dot(n, -rd)), 2.5);
        // never emit NaN/Inf: one bad pixel turns into black blocks after mip/bloom passes on some GPUs
        if (!(col.r == col.r) || !(col.g == col.g) || !(col.b == col.b)) col = vec3(0.02, 0.06, 0.035);
        col = clamp(col, 0.0, 16.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });

  const root = new THREE.Group();
  const spin = new THREE.Group();
  const body = new THREE.Group();
  root.add(spin); spin.add(body);
  body.position.y = -TOTAL_H / 2;

  const B = SPEC.body, C = SPEC.cap;
  const glassGeo = sweepGeometry(B, slabProfile(B), 28);
  const glass = new THREE.Mesh(glassGeo, glassMat);
  const liquid = new THREE.Mesh(sweepGeometry(L, slabProfile(L), 20), liquidMat);
  // inner darker block, same shape inset evenly on every side: reads as a few mm of glass wall
  const IN = 0.035;
  const LI = { w: L.w - 2 * IN, d: L.d - 2 * IN, y0: L.y0 + IN, y1: L.y1 - IN, cr: Math.max(0.02, L.cr - IN), bb: L.bb, bt: L.bt };
  const innerUniforms = {
    ...liquidUniforms,
    uMin: { value: new THREE.Vector3(-LI.w / 2, LI.y0, -LI.d / 2) },
    uMax: { value: new THREE.Vector3(LI.w / 2, LI.y1, LI.d / 2) },
    uSigma: { value: new THREE.Vector3() },
    uGlow: { value: 0.5 },
  };
  const TI = new THREE.Color('#2f7a3d');
  innerUniforms.uSigma.value.set(-Math.log(TI.r) / 0.5, -Math.log(TI.g) / 0.5, -Math.log(TI.b) / 0.5);
  const innerMat = liquidMat.clone(); innerMat.uniforms = innerUniforms;
  innerMat.depthTest = false; // drawn on top of the outer layer, inside its silhouette
  const inner = new THREE.Mesh(sweepGeometry(LI, slabProfile(LI), 20), innerMat);
  inner.renderOrder = 1;
  const neck = new THREE.Mesh(sweepGeometry(SPEC.neck, slabProfile(SPEC.neck, 6), 16), neckMat);
  const cap = new THREE.Mesh(sweepGeometry(C, slabProfile(C, 12), 20), capMat);
  // inner side of the far walls: drawn in the opaque pass so the front glass refracts it,
  // which makes the rear edges and corners read through the bottle
  const backMat = new THREE.MeshPhysicalMaterial({
    color: '#2f7a48', metalness: 0, roughness: 0.03, specularIntensity: 1, envMapIntensity: 2.2,
    side: THREE.BackSide, opacity: 0.12, transparent: false,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const back = new THREE.Mesh(glassGeo, backMat);
  back.scale.setScalar(0.985); back.position.y = 0.008;
  body.add(liquid, inner, back, glass, neck, cap);

  const labelMat = new THREE.MeshStandardMaterial({
    color: '#ffffff', transparent: true, roughness: 0.55, metalness: 0,
    emissive: '#ffffff', emissiveIntensity: 0.35,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.74, 0.37), labelMat);
  label.position.set(0, 0.58, B.d / 2 + 0.0015);
  label.renderOrder = 10;
  body.add(label);
  labelTexture(aniso).then(t => { labelMat.map = t; labelMat.emissiveMap = t; labelMat.needsUpdate = true; });

  // condensation: thin shell over the glass, water beads drawn with the same premultiplied water shading as the scene
  const condUniforms = {
    map: { value: condensationTex }, uOpacity: { value: 0 },
  };
  const condMat = new THREE.ShaderMaterial({
    uniforms: condUniforms, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        vUv = uv * vec2(4.2, 1.4);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D map; uniform float uOpacity;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        vec3 t = texture2D(map, vUv).rgb;
        float L = max(max(t.r, t.g), t.b);
        float facing = clamp(dot(vN, vV), 0.0, 1.0);
        float hi = pow(L, 1.3) * (0.55 + 0.6 * facing);
        float a = smoothstep(0.02, 0.25, L) * 0.3;
        gl_FragColor = vec4(vec3(0.92, 1.0, 0.95) * hi * 0.9, a) * uOpacity;
      }`,
  });
  const cond = new THREE.Mesh(glassGeo, condMat);
  cond.scale.setScalar(1.004);
  cond.position.y = -0.002;
  cond.renderOrder = 5;
  body.add(cond);

  root.traverse(o => o.layers.set(LAYER_BOTTLE));

  return { root, spin, body, glassMat, capMat, liquid, liquidUniforms, condUniforms };
}
