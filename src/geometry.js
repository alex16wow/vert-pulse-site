import * as THREE from 'three';

/* ─────────────────────────── Bottle spec (1 unit ≈ bottle width) ─────────────────────────── */
export const SPEC = {
  body:   { w: 1.00, d: 0.62, y0: 0.00, y1: 1.08, cr: 0.115, bb: 0.045, bt: 0.055 },
  // fills the whole body: one dark frosted block, no visible glass rim
  liquid: { w: 0.99, d: 0.61, y0: 0.006, y1: 1.074, cr: 0.11, bb: 0.04, bt: 0.05 },
  neck:   { w: 0.34, d: 0.26, y0: 1.075, y1: 1.165, cr: 0.045, bb: 0.006, bt: 0.006 },
  cap:    { w: 0.68, d: 0.50, y0: 1.16, y1: 1.50, cr: 0.055, bb: 0.012, bt: 0.02,
            grooves: [0.25, 0.5, 0.75], gDepth: 0.0065, gWidth: 0.02 },
};
export const TOTAL_H = 1.50;

/* ─────────────────────────── Geometry: rounded-rect sweep with analytic normals ─────────────────────────── */
// Profile point: o = inward inset from outer wall, y = height, (nx, ny) = normal in (outward, up) plane.
export function slabProfile({ y0, y1, bb, bt, grooves = [], gDepth = 0, gWidth = 0 }, steps = 14) {
  const P = [];
  for (let i = 0; i <= steps; i++) {
    const f = -Math.PI / 2 + (i / steps) * (Math.PI / 2);
    P.push({ o: bb - bb * Math.cos(f), y: y0 + bb + bb * Math.sin(f), nx: Math.cos(f), ny: Math.sin(f) });
  }
  const H = y1 - y0;
  const gs = 12;
  for (const g of grooves) {
    const yc = y0 + g * H;
    for (let s = 0; s <= gs; s++) {
      const t = s / gs;
      const o = gDepth * (1 - Math.cos(2 * Math.PI * t)) / 2;
      const slope = gDepth * Math.PI / gWidth * Math.sin(2 * Math.PI * t);
      const len = Math.hypot(1, slope);
      P.push({ o, y: yc - gWidth / 2 + t * gWidth, nx: 1 / len, ny: slope / len });
    }
  }
  for (let i = 0; i <= steps; i++) {
    const f = (i / steps) * (Math.PI / 2);
    P.push({ o: bt - bt * Math.cos(f), y: y1 - bt + bt * Math.sin(f), nx: Math.cos(f), ny: Math.sin(f) });
  }
  return P;
}

export function sweepGeometry({ w, d, cr }, profile, seg = 24) {
  const cx = w / 2 - cr, cz = d / 2 - cr;
  const corners = [[cx, cz, 0], [-cx, cz, Math.PI / 2], [-cx, -cz, Math.PI], [cx, -cz, Math.PI * 1.5]];
  const dirs = [];
  for (const [ox, oz, a0] of corners)
    for (let j = 0; j <= seg; j++) {
      const a = a0 + (j / seg) * (Math.PI / 2);
      dirs.push([ox, oz, Math.cos(a), Math.sin(a)]);
    }
  dirs.push(dirs[0]);
  const N = dirs.length;

  // u along outer perimeter, v along profile length
  const u = [0];
  for (let k = 1; k < N; k++) {
    const [ax, az, aca, asa] = dirs[k - 1], [bx, bz, bca, bsa] = dirs[k];
    u.push(u[k - 1] + Math.hypot(bx + bca * cr - ax - aca * cr, bz + bsa * cr - az - asa * cr));
  }
  const uLen = u[N - 1];
  const v = [0];
  for (let i = 1; i < profile.length; i++)
    v.push(v[i - 1] + Math.hypot(profile[i].o - profile[i - 1].o, profile[i].y - profile[i - 1].y));
  const vLen = v[v.length - 1] || 1;

  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i], r = cr - p.o;
    for (let k = 0; k < N; k++) {
      const [ox, oz, ca, sa] = dirs[k];
      pos.push(ox + ca * r, p.y, oz + sa * r);
      const n = new THREE.Vector3(ca * p.nx, p.ny, sa * p.nx).normalize();
      nor.push(n.x, n.y, n.z);
      uv.push(u[k] / uLen, v[i] / vLen);
    }
  }
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), Nn = new THREE.Vector3();
  const tri = (a, b, c) => {
    A.fromArray(pos, a * 3); B.fromArray(pos, b * 3); C.fromArray(pos, c * 3);
    const cr3 = B.clone().sub(A).cross(C.clone().sub(A));
    if (cr3.lengthSq() < 1e-14) return;
    Nn.fromArray(nor, a * 3).add(new THREE.Vector3().fromArray(nor, b * 3)).add(new THREE.Vector3().fromArray(nor, c * 3));
    if (cr3.dot(Nn) < 0) idx.push(a, c, b); else idx.push(a, b, c);
  };
  for (let i = 0; i < profile.length - 1; i++)
    for (let k = 0; k < N - 1; k++) {
      const a = i * N + k, b = a + 1, c = a + N, e = c + 1;
      tri(a, c, b); tri(b, c, e);
    }
  // flat caps
  const cap = (pi, ny) => {
    const p = profile[pi], r = cr - p.o, base = pos.length / 3;
    pos.push(0, p.y, 0); nor.push(0, ny, 0); uv.push(0.5, 0.5);
    for (let k = 0; k < N; k++) {
      const [ox, oz, ca, sa] = dirs[k];
      const x = ox + ca * r, z = oz + sa * r;
      pos.push(x, p.y, z); nor.push(0, ny, 0); uv.push(x / w + 0.5, z / d + 0.5);
    }
    for (let k = 0; k < N - 1; k++) tri(base, base + 1 + k, base + 2 + k);
  };
  cap(0, -1);
  cap(profile.length - 1, 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

