import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../render/shaderlib.js';
import { mulberry32 } from '../render/textures.js';
import { sphereClear, sphereTravel } from './collision.js';

// ------------------------------------------------------------------ CPU value noise for sculpting

export function makeNoise3(seed) {
  const rand = mulberry32(seed);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint16Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) val[i] = rand();
  const h = (x, y, z) => val[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  const s = (t) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = s(x - ix), fy = s(y - iy), fz = s(z - iz);
    const a = h(ix, iy, iz), b = h(ix + 1, iy, iz), c = h(ix, iy + 1, iz), d = h(ix + 1, iy + 1, iz);
    const e = h(ix, iy, iz + 1), f = h(ix + 1, iy, iz + 1), g = h(ix, iy + 1, iz + 1), k = h(ix + 1, iy + 1, iz + 1);
    const l1 = a + (b - a) * fx, l2 = c + (d - c) * fx, l3 = e + (f - e) * fx, l4 = g + (k - g) * fx;
    const m1 = l1 + (l2 - l1) * fy, m2 = l3 + (l4 - l3) * fy;
    return m1 + (m2 - m1) * fz;
  };
}

// ------------------------------------------------------------------ shaders

const SKIN_FRAG_DECL = /* glsl */ `
varying vec3 vObj;
varying vec3 vTone;
uniform float uSkinScale;
uniform float uBump;
uniform vec3 uSkinA;
uniform vec3 uSkinB;
uniform vec3 uSkinFold;
uniform vec3 uSkinVein;
uniform vec3 uSkinTop;
uniform vec3 uSkinInner;
uniform vec3 uSkinPale;
uniform vec3 uRim;
#ifdef SKIN_LID
uniform float uLidTop;
uniform float uLidBot;
#endif
float sk_crease(vec3 p) { float n = wr_noise(p); return pow(1.0 - abs(n * 2.0 - 1.0), 5.0); }
float sk_fade(float px, float freq) { return 1.0 - smoothstep(0.18, 0.55, px * freq); }
// Multi-scale wet flesh: warped fold creases, wrinkles, tubercles, veins and pores. Returns height in skin units.
float sk_height(vec3 p, float px, out float crease, out float bump, out float vein, out float mott) {
  vec3 w = vec3(wr_noise(p * 0.33), wr_noise(p * 0.33 + 17.1), wr_noise(p * 0.33 + 31.7)) - 0.5;
  vec3 q = p + w * 2.4;
  float f2 = sk_fade(px, 2.4), f3 = sk_fade(px, 6.5), f4 = sk_fade(px, 4.2), f5 = sk_fade(px, 11.0);
  float c1 = sk_crease(q * 0.85);
  float c2 = sk_crease(q * 2.4 + 3.7) * f2;
  float c3 = sk_crease(q * 6.5 + 9.1) * f3;
  crease = max(c1, c2 * 0.75);
  float tb = wr_noise(p * 4.2 + 50.0);
  bump = smoothstep(0.58, 0.9, tb) * (1.0 - c1) * f4;
  float vn = wr_noise(q * 1.25 + 70.0);
  vein = smoothstep(0.9, 0.985, 1.0 - abs(vn * 2.0 - 1.0)) * smoothstep(0.4, 0.7, wr_noise(p * 0.4 + 90.0)) * sk_fade(px, 9.0);
  mott = smoothstep(0.32, 0.78, wr_fbm(p * 0.55 + 120.0));
  float pores = wr_noise(p * 11.0 + 7.0) * f5;
  float puff = wr_noise(q * 1.7 + 30.0);
  return -c1 * 0.1 - c2 * 0.04 - c3 * 0.014 + bump * 0.045 + vein * 0.016 - pores * 0.006 + puff * 0.03;
}
vec3 sk_perturb(vec3 pos, vec3 nrm, float h, float fd) {
  vec3 sx = dFdx(pos), sy = dFdy(pos);
  vec3 r1 = cross(sy, nrm), r2 = cross(nrm, sx);
  float det = dot(sx, r1) * fd;
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * nrm - grad);
}
`;

const SKIN_ALBEDO = /* glsl */ `
vec3 skP = vObj * uSkinScale;
float skPx = length(fwidth(skP));
float skCrease, skBump, skVein, skMott;
float skH = sk_height(skP, skPx, skCrease, skBump, skVein, skMott);
#ifdef SKIN_LID
{
  vec3 le = normalize(vObj);
  float xx = le.x * le.x * 0.55;
  if (!(le.y + xx > uLidTop || le.y - xx < uLidBot)) discard;
}
#endif
vec3 skCol = mix(uSkinA, uSkinB, skMott);
skCol = mix(skCol, uSkinTop, skBump * 0.75);
skCol = mix(skCol, uSkinFold, clamp(skCrease * 0.8 + vTone.x, 0.0, 1.0));
skCol = mix(skCol, uSkinVein, skVein * 0.85);
skCol = mix(skCol, uSkinPale, clamp(vTone.z, 0.0, 1.0));
skCol = mix(skCol, uSkinInner, clamp(vTone.y, 0.0, 1.0));
diffuseColor.rgb = skCol;
`;

const SKIN_ROUGH = /* glsl */ `
roughnessFactor = clamp(roughnessFactor + skBump * 0.24 - skCrease * 0.12 - vTone.y * 0.1 + skMott * 0.06, 0.05, 1.0);
`;

const SKIN_NORMAL = /* glsl */ `
normal = sk_perturb(-vViewPosition, normal, skH * uBump / uSkinScale, faceDirection);
`;

const SKIN_LIGHT = /* glsl */ `
{
  float ndv = saturate(dot(geometryNormal, geometryViewDir));
  reflectedLight.indirectSpecular += uRim * pow(1.0 - ndv, 3.0);
}
`;

// Spine lookup shared by tentacle tubes and their suckers. Row 2k: xyz position + radius; row 2k+1: frame normal + length.
export const SPINE_GLSL = /* glsl */ `
uniform sampler2D uSpine;
uniform float uTN;
vec4 sp_at(int i, int row) { return texelFetch(uSpine, ivec2(i, row), 0); }
vec4 sp_eval(float t, float k, out vec3 T, out vec3 N, out float len) {
  float s = clamp(t, 0.0, 1.0) * (uTN - 1.0);
  int n = int(uTN + 0.5);
  int i = min(int(s), n - 2);
  float f = s - float(i);
  int row = int(k + 0.5) * 2;
  vec4 p0 = sp_at(max(i - 1, 0), row);
  vec4 p1 = sp_at(i, row);
  vec4 p2 = sp_at(i + 1, row);
  vec4 p3 = sp_at(min(i + 2, n - 1), row);
  vec4 a = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3;
  vec4 b = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
  vec4 p = 0.5 * (2.0 * p1 + (p2 - p0) * f + a * f * f + b * f * f * f);
  vec3 d = 0.5 * ((p2 - p0).xyz + 2.0 * a.xyz * f + 3.0 * b.xyz * f * f);
  T = normalize(d + vec3(0.0, 1e-5, 0.0));
  vec4 n1 = sp_at(i, row + 1);
  vec4 n2 = sp_at(i + 1, row + 1);
  N = mix(n1.xyz, n2.xyz, f);
  N = normalize(N - T * dot(N, T) + vec3(1e-5, 0.0, 0.0));
  len = n1.w;
  return p;
}
`;

const TUBE_VERT = /* glsl */ `
vec3 tT, tN; float tLen;
float tt = position.y;
vec4 tp = sp_eval(tt, tent, tT, tN, tLen);
vec3 tB = cross(tT, tN);
float ca = position.x, sa = position.z;
float rr = max(tp.w, 0.0);
rr *= sqrt(max(0.0, 1.0 - pow(max(tt - 0.955, 0.0) / 0.045, 2.0)));
float tflat = sa < 0.0 ? 0.72 : 1.0;
vec3 objectNormal = normalize(tB * ca + tN * sa / tflat);
vec3 wr_tpos = tp.xyz + (tB * ca + tN * sa * tflat) * rr;
vObj = vec3(ca * rr, sa * rr * tflat, tt * tLen) + vec3(tent * 17.0);
vTone = vec3(0.0, 0.0, smoothstep(-0.15, -0.85, sa) * uPaleUnder);
`;

const SUCKER_VERT = /* glsl */ `
vec3 tT, tN; float tLen;
vec4 tp = sp_eval(sk.y, sk.x, tT, tN, tLen);
vec3 tB = cross(tT, tN);
float ca = cos(sk.z), sa = sin(sk.z);
vec3 sup = normalize(tB * ca + tN * sa / 0.72);
vec3 sd = normalize(tT - sup * dot(tT, sup));
vec3 sf = cross(sd, sup);
float rr = max(tp.w, 0.0);
vec3 sbase = tp.xyz + (tB * ca + tN * sa * 0.72) * rr * 0.9;
float ssz = rr * sk.w;
vec3 objectNormal = normalize(sd * normal.x + sup * normal.y + sf * normal.z);
vec3 wr_tpos = sbase + (sd * position.x + sup * position.y + sf * position.z) * ssz;
vObj = position * 0.35 + vec3(sk.x * 13.0 + sk.y * 40.0);
float srim = length(position.xz);
vTone = vec3(0.0, smoothstep(0.6, 0.25, srim) * step(position.y, 0.24) * 0.85, smoothstep(0.45, 0.8, srim) * 0.95);
`;

/**
 * Wet creature flesh. kind: body (uses a per-vertex `tone` attribute), lid (eyelid shell with discard),
 * tentacle / sucker (vertices placed along a spine texture).
 */
export function makeSkinMaterial(o = {}) {
  const kind = o.kind || 'body';
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: o.roughness ?? 0.3, metalness: 0 });
  const u = {
    uSkinScale: { value: o.scale ?? 1 },
    uBump: { value: o.bump ?? 1 },
    uSkinA: { value: new THREE.Color(...(o.colA || [0.05, 0.048, 0.032])) },
    uSkinB: { value: new THREE.Color(...(o.colB || [0.018, 0.017, 0.013])) },
    uSkinFold: { value: new THREE.Color(...(o.colFold || [0.1, 0.022, 0.04])) },
    uSkinVein: { value: new THREE.Color(...(o.colVein || [0.16, 0.03, 0.06])) },
    uSkinTop: { value: new THREE.Color(...(o.colTop || [0.1, 0.095, 0.065])) },
    uSkinInner: { value: new THREE.Color(...(o.colInner || [0.22, 0.035, 0.05])) },
    uSkinPale: { value: new THREE.Color(...(o.colPale || [0.2, 0.15, 0.13])) },
    uRim: o.rim || { value: new THREE.Color(0.004, 0.012, 0.014) },
    uPaleUnder: { value: o.paleUnder ?? 0.8 },
  };
  if (kind === 'lid') {
    u.uLidTop = { value: 0.55 };
    u.uLidBot = { value: -0.62 };
    mat.defines = { SKIN_LID: '' };
    mat.side = THREE.DoubleSide;
  }
  let vertDecl = 'varying vec3 vObj;\nvarying vec3 vTone;\nuniform float uPaleUnder;\n';
  let vertBody = '';
  const vertReplace = {};
  if (kind === 'body') {
    vertDecl += 'attribute vec3 tone;\n';
    vertBody = 'vObj = position; vTone = tone;';
  } else if (kind === 'lid') {
    vertBody = 'vObj = position; vTone = vec3(0.45, 0.0, 0.0);';
  } else {
    u.uSpine = { value: o.spine };
    u.uTN = { value: o.tn };
    vertDecl += SPINE_GLSL + (kind === 'tentacle' ? 'attribute float tent;\n' : 'attribute vec4 sk;\n');
    vertReplace.beginnormal_vertex = kind === 'tentacle' ? TUBE_VERT : SUCKER_VERT;
    vertReplace.begin_vertex = 'vec3 transformed = wr_tpos;';
  }
  patchMaterial(mat, {
    key: `skin-${kind}`,
    probe: o.probe,
    uniforms: u,
    vertDecl,
    vertBody,
    vertReplace,
    fragDecl: SKIN_FRAG_DECL,
    albedo: SKIN_ALBEDO,
    lighting: SKIN_LIGHT,
    after: { roughnessmap_fragment: SKIN_ROUGH, normal_fragment_maps: SKIN_NORMAL },
  });
  mat.userData.u = u;
  return mat;
}

const EYE_ALBEDO = /* glsl */ `
vec3 ey = normalize(vObj);
float eyAng = acos(clamp(ey.z, -1.0, 1.0));
float eyIris = 1.0 - smoothstep(uIrisR - 0.025, uIrisR + 0.01, eyAng);
float eyPhi = atan(ey.y, ey.x);
float eyFib = wr_noise(vec3(cos(eyPhi) * 7.0, sin(eyPhi) * 7.0, eyAng * 16.0 + uSeed));
eyFib = 0.55 + 0.45 * eyFib + 0.25 * wr_noise(vec3(cos(eyPhi) * 22.0, sin(eyPhi) * 22.0, eyAng * 3.0));
vec2 eyPP = ey.xy / max(ey.z, 0.25);
float eySlitH = uIrisR * 0.95;
float eySw = mix(0.035, 0.3, uDilate) * sqrt(max(0.0, 1.0 - pow(eyPP.y / eySlitH, 2.0)));
float eyPupil = (1.0 - smoothstep(eySw * 0.75, eySw + 0.02, abs(eyPP.x))) * step(abs(eyPP.y), eySlitH) * step(0.0, ey.z);
float eyLimbal = smoothstep(uIrisR - 0.16, uIrisR, eyAng) * eyIris;
vec3 eyIrisCol = uIrisCol * eyFib * (0.55 + 0.9 * smoothstep(uIrisR, 0.05, eyAng)) * (1.0 - eyLimbal * 0.8);
float eyVein = pow(1.0 - abs(wr_noise(vec3(eyPhi * 2.2, eyAng * 5.0, uSeed)) * 2.0 - 1.0), 14.0);
vec3 eyScl = mix(uSclera, vec3(0.3, 0.02, 0.02), eyVein * smoothstep(0.5, 1.3, eyAng));
eyScl *= mix(1.0, 0.25, smoothstep(0.9, 1.9, eyAng));
vec3 eyCol = mix(eyScl, eyIrisCol * 0.25, eyIris);
eyCol = mix(eyCol, vec3(0.002), eyPupil);
diffuseColor.rgb = eyCol;
vec3 eyGlow = eyIrisCol * eyIris * (1.0 - eyPupil) * uGlow;
`;

/** Glassy wet eyeball with amber iris, vertical slit pupil and emissive glow. Local +Z looks forward. */
export function makeEyeMaterial(o = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0 });
  const u = {
    uIrisCol: { value: new THREE.Color(...(o.iris || [1.0, 0.5, 0.08])) },
    uSclera: { value: new THREE.Color(...(o.sclera || [0.26, 0.22, 0.13])) },
    uIrisR: { value: o.irisR ?? 0.62 },
    uDilate: { value: 0.3 },
    uGlow: { value: o.glow ?? 1 },
    uSeed: { value: o.seed ?? 0 },
  };
  patchMaterial(mat, {
    key: 'eye',
    probe: o.probe,
    uniforms: u,
    vertDecl: 'varying vec3 vObj;\n',
    vertBody: 'vObj = position;',
    fragDecl: 'varying vec3 vObj;\nuniform vec3 uIrisCol;\nuniform vec3 uSclera;\nuniform float uIrisR;\nuniform float uDilate;\nuniform float uGlow;\nuniform float uSeed;\n',
    albedo: EYE_ALBEDO,
    emissive: 'totalEmissiveRadiance += eyGlow;',
  });
  mat.userData.u = u;
  return mat;
}

/** Long needle teeth, yellowed, darker at the gum. Instanced. */
export function makeToothMaterial(probe) {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.36, 0.22), roughness: 0.28, metalness: 0 });
  patchMaterial(mat, {
    key: 'tooth',
    probe,
    vertDecl: 'varying float vTip;\n',
    vertBody: 'vTip = position.y;',
    fragDecl: 'varying float vTip;\n',
    albedo: 'diffuseColor.rgb *= mix(vec3(0.3, 0.12, 0.1), vec3(1.0), smoothstep(0.0, 0.3, vTip)) * (0.9 + 0.2 * wr_noise(vec3(vTip * 30.0, vWPos.xz * 3.0)));',
  });
  return mat;
}

/** Slightly curved needle: base at y=0, tip at y=1, radius 1 at the base. */
export function toothGeometry() {
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(Math.pow(1 - t, 1.6) * 1.0 + 0.001, t));
  }
  const g = new THREE.LatheGeometry(pts, 7);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    p.setZ(i, p.getZ(i) + y * y * 0.18);
  }
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ chains (verlet spines)

/** A tentacle spine: n points with radii, simulated on the CPU and uploaded to a spine texture. */
export class Chain {
  constructor(n, length, r0, r1, taper = 0.85) {
    this.n = n;
    this.length = length;
    this.seg = length / (n - 1);
    this.p = new Float32Array(n * 3);
    this.o = new Float32Array(n * 3);
    this.previous = new Float32Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    this.r = new Float32Array(n);
    this.collisionR = new Float32Array(n);
    this.collisionSafe = new Float32Array(n * 3);
    this.collisionGoal = new Float32Array(n * 3);
    this.collisionReady = false;
    this.r0 = r0;
    this.dt = 1 / 60;
    for (let i = 0; i < n; i++) this.r[i] = r0 + (r1 - r0) * Math.pow(i / (n - 1), taper);
  }

  reset(x, y, z, dx, dy, dz) {
    this.collisionReady = false;
    this.dt = 1 / 60;
    for (let i = 0; i < this.n; i++) {
      const b = i * 3;
      this.p[b] = this.o[b] = x + dx * this.seg * i;
      this.p[b + 1] = this.o[b + 1] = y + dy * this.seg * i;
      this.p[b + 2] = this.o[b + 2] = z + dz * this.seg * i;
    }
    this.previous.set(this.p);
  }

  /** Verlet step with per-chain damping and a uniform acceleration (buoyancy / gravity). */
  integrate(dt, damp, ax, ay, az) {
    if (dt <= 0) return;
    const { p, o } = this;
    this.previous.set(p);
    const dt2 = dt * dt;
    const drag = Math.pow(damp, dt * 60) * dt / this.dt;
    this.dt = dt;
    for (let i = 3; i < p.length; i++) {
      const c = i % 3;
      const a = c === 0 ? ax : c === 1 ? ay : az;
      const v = (p[i] - o[i]) * drag;
      o[i] = p[i];
      p[i] += v + a * dt2;
    }
  }

  /** Pin the root, orient the first segment, keep segment lengths and add bending stiffness. */
  constrain(rx, ry, rz, dx, dy, dz, stiff = 0.1, slack = false) {
    const { p, n, seg } = this;
    const rootK = 1 - Math.pow(0.4, this.dt * 60);
    const bendK = 1 - Math.pow(1 - stiff, this.dt * 60);
    p[0] = rx; p[1] = ry; p[2] = rz;
    this.pull(1, rx + dx * seg, ry + dy * seg, rz + dz * seg, rootK);
    for (let i = 2; i < n && stiff > 0; i++) {
      const b = i * 3, a = b - 3, z = b - 6;
      this.pull(i, 2 * p[a] - p[z], 2 * p[a + 1] - p[z + 1], 2 * p[a + 2] - p[z + 2], bendK);
    }
    this.constrainLengths(slack);
  }

  /** Keep the root pinned while restoring lengths after collision corrections. */
  constrainLengths(slack = false) {
    const { p, o, n, seg } = this;
    for (let i = 1; i < n; i++) {
      const b = i * 3, a = b - 3;
      const ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2];
      const d = Math.hypot(ex, ey, ez) || 1e-6;
      if (slack && d < seg) continue;
      const k = seg / d;
      const cx = ex * (k - 1), cy = ey * (k - 1), cz = ez * (k - 1);
      p[b] += cx; p[b + 1] += cy; p[b + 2] += cz;
      o[b] += cx; o[b + 1] += cy; o[b + 2] += cz;
    }
  }

  pull(i, x, y, z, k) {
    const b = i * 3;
    const dx = (x - this.p[b]) * k, dy = (y - this.p[b + 1]) * k, dz = (z - this.p[b + 2]) * k;
    // Following a pose is a positional correction, not a force for the next frame.
    this.p[b] += dx; this.p[b + 1] += dy; this.p[b + 2] += dz;
    this.o[b] += dx; this.o[b + 1] += dy; this.o[b + 2] += dz;
  }

  /** Parallel-transported frame normals starting from a reference up vector. */
  frames(ux, uy, uz) {
    const { p, nrm, n } = this;
    let nx = ux, ny = uy, nz = uz;
    let lastTx = 0, lastTy = -1, lastTz = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(n - 1, i + 1) * 3;
      let tx = p[b] - p[a], ty = p[b + 1] - p[a + 1], tz = p[b + 2] - p[a + 2];
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 1e-6) { tx /= tl; ty /= tl; tz /= tl; }
      else { tx = lastTx; ty = lastTy; tz = lastTz; }
      lastTx = tx; lastTy = ty; lastTz = tz;
      const d = nx * tx + ny * ty + nz * tz;
      nx -= tx * d; ny -= ty * d; nz -= tz * d;
      let nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-4) {
        if (Math.abs(ty) > 0.99) { nx = 1; ny = 0; nz = 0; }
        else { nx = -tz; ny = 0; nz = tx; }
        const dot = nx * tx + ny * ty + nz * tz;
        nx -= tx * dot; ny -= ty * dot; nz -= tz * dot;
        nl = Math.hypot(nx, ny, nz);
      }
      nx /= nl; ny /= nl; nz /= nl;
      nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
    }
  }

  tip(out) { const b = (this.n - 1) * 3; return out.set(this.p[b], this.p[b + 1], this.p[b + 2]); }
  point(i, out) { const b = i * 3; return out.set(this.p[b], this.p[b + 1], this.p[b + 2]); }
}

/** Protect spans as well when the creature's body collider guarantees an unobstructed root. */
export function collideChain(level, c, protectSpans = false, maxSpeed = Infinity) {
  const p = c.p, old = c.o;
  // A submerged point beside a deck must leave through its side, rather than teleport to
  // the deck's floor. Alternate contacts and lengths so the skin cannot stretch apart.
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < c.n; i++) {
      const b = i * 3, x = p[b], y = p[b + 1], z = p[b + 2];
      const tx = Math.floor(x / 2), tz = Math.floor(z / 2), r = c.r[i] * 0.9;
      if (level.openBelow !== undefined && y + r < level.openBelow) continue;
      if (!level.solid(tx, tz) && y >= level.floor(tx, tz) + r && y <= level.ceil(tx, tz) - r) continue;
      let best = Infinity, bx = x, by = y, bz = z;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx, nz = tz + dz;
          if (level.solid(nx, nz)) continue;
          const floor = level.floor(nx, nz) + r, ceil = level.ceil(nx, nz) - r;
          if (floor > ceil) continue;
          const cx = dx === 0 ? x : Math.max(nx * 2 + 0.05, Math.min(nx * 2 + 1.95, x));
          const cz = dz === 0 ? z : Math.max(nz * 2 + 0.05, Math.min(nz * 2 + 1.95, z));
          const cy = Math.max(floor, Math.min(ceil, y));
          const d = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2;
          if (d < best) { best = d; bx = cx; by = cy; bz = cz; }
        }
      }
      if (!Number.isFinite(best)) continue;
      // An attached root can be inside terrain while the creature surfaces. Resolve that
      // gradually, without injecting the projection displacement into Verlet velocity.
      const k = Math.min(1, c.seg * c.dt * 2 / (Math.sqrt(best) || 1));
      const ex = (bx - x) * k, ey = (by - y) * k, ez = (bz - z) * k;
      p[b] += ex; p[b + 1] += ey; p[b + 2] += ez;
      old[b] += ex; old[b + 1] += ey; old[b + 2] += ez;
      const len2 = ex * ex + ey * ey + ez * ez;
      const inward = ((p[b] - old[b]) * ex + (p[b + 1] - old[b + 1]) * ey + (p[b + 2] - old[b + 2]) * ez) / (len2 || 1);
      if (inward < 0) {
        old[b] += ex * inward; old[b + 1] += ey * inward; old[b + 2] += ez * inward;
      }
    }
    c.constrainLengths();
  }
  if (!protectSpans) return;
  // Keep both the skin and the spans between nodes outside terrain. Length restoration
  // must not pull a limb back through a wall. A blocked span can fold/compress against it.
  // The extra margin covers the spline's small overshoot between its control points.
  let radius = 0;
  for (let i = c.n - 1; i >= 0; i--) {
    radius = Math.max(radius, c.r[i]);
    c.collisionR[i] = radius + 0.04 + c.seg * 0.125;
  }
  for (let i = 1; i < c.n; i++) {
    const b = i * 3, a = b - 3, r = c.collisionR[i - 1];
    if (!sphereClear(level, p[a], p[a + 1], p[a + 2], r)) continue;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const lengthK = Math.min(1, c.seg / (Math.hypot(dx, dy, dz) || 1));
    const x = p[a] + dx * lengthK, y = p[a + 1] + dy * lengthK, z = p[a + 2] + dz * lengthK;
    const travel = sphereTravel(level, p[a], p[a + 1], p[a + 2], x, y, z, r);
    const k = travel * lengthK;
    let nx = p[a] + dx * k, ny = p[a + 1] + dy * k, nz = p[a + 2] + dz * k;
    if (travel < 1) {
      // Retain the last clear bend around a corner instead of collapsing the entire tip
      // toward the root when the animated target crosses to the other side of a wall.
      const prev = c.previous;
      const px = prev[b] - p[a], py = prev[b + 1] - p[a + 1], pz = prev[b + 2] - p[a + 2];
      const reach = Math.min(1, c.seg / (Math.hypot(px, py, pz) || 1));
      const keep = sphereTravel(level, p[a], p[a + 1], p[a + 2], p[a] + px * reach, p[a + 1] + py * reach, p[a + 2] + pz * reach, r) * reach;
      const ax = p[a] + px * keep, ay = p[a + 1] + py * keep, az = p[a + 2] + pz * keep;
      if (Math.hypot(ax - prev[b], ay - prev[b + 1], az - prev[b + 2]) < Math.hypot(nx - prev[b], ny - prev[b + 1], nz - prev[b + 2])) {
        nx = ax; ny = ay; nz = az;
      }
    }
    const ex = nx - p[b], ey = ny - p[b + 1], ez = nz - p[b + 2];
    p[b] += ex; p[b + 1] += ey; p[b + 2] += ez;
    old[b] += ex; old[b + 1] += ey; old[b + 2] += ez;
  }
  if (Number.isFinite(maxSpeed)) smoothChainContact(level, c, maxSpeed);
}

/** Sweep the entire last clear curve toward the corrected pose. This prevents a
 * long tentacle from snapping back to its root when a bend meets a pillar. */
function smoothChainContact(level, c, maxSpeed) {
  const { p, o, collisionSafe: safe, collisionGoal: goal } = c;
  const clear = () => {
    for (let i = 1; i < c.n; i++) {
      const b = i * 3, a = b - 3;
      if (sphereTravel(level, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], c.collisionR[i - 1]) < 1) return false;
    }
    return true;
  };
  if (!c.collisionReady) {
    c.collisionReady = clear();
    if (c.collisionReady) safe.set(p);
    return;
  }
  goal.set(p);
  let distance = 0;
  for (let b = 0; b < p.length; b += 3) distance = Math.max(distance, Math.hypot(goal[b] - safe[b], goal[b + 1] - safe[b + 1], goal[b + 2] - safe[b + 2]));
  const limit = Math.min(1, maxSpeed * c.dt / (distance || 1));
  const apply = (k) => { for (let b = 0; b < p.length; b++) p[b] = safe[b] + (goal[b] - safe[b]) * k; };
  const steps = Math.max(1, Math.ceil(distance * limit / 0.12));
  let accepted = 0;
  for (let i = 1; i <= steps; i++) {
    const k = limit * i / steps;
    apply(k);
    if (clear()) { accepted = k; continue; }
    let blocked = k;
    for (let j = 0; j < 8; j++) {
      const mid = (accepted + blocked) / 2;
      apply(mid);
      if (clear()) accepted = mid; else blocked = mid;
    }
    break;
  }
  apply(accepted);
  if (accepted < limit) {
    // A single contact must not pin every other node. Relax the clear sections
    // independently so the bend can retract around the obstacle over later frames.
    const budget = maxSpeed * c.dt;
    for (let pass = 0; pass < 2; pass++) for (let i = c.n - 1; i >= 0; i--) {
      const b = i * 3, x = p[b], y = p[b + 1], z = p[b + 2];
      const remaining = Math.max(0, budget - Math.hypot(x - safe[b], y - safe[b + 1], z - safe[b + 2]));
      const k = Math.min(1, remaining / (Math.hypot(goal[b] - x, goal[b + 1] - y, goal[b + 2] - z) || 1));
      let dx = (goal[b] - x) * k, dy = (goal[b + 1] - y) * k, dz = (goal[b + 2] - z) * k;
      const localClear = (u) => {
        p[b] = x + dx * u; p[b + 1] = y + dy * u; p[b + 2] = z + dz * u;
        if (sphereTravel(level, x, y, z, p[b], p[b + 1], p[b + 2], c.collisionR[Math.max(0, i - 1)]) < 1) return false;
        for (const j of [i - 1, i]) {
          if (j < 0 || j >= c.n - 1) continue;
          const a = j * 3, e = a + 3;
          if (Math.hypot(p[e] - p[a], p[e + 1] - p[a + 1], p[e + 2] - p[a + 2]) > c.seg * 1.00001) return false;
          if (sphereTravel(level, p[a], p[a + 1], p[a + 2], p[e], p[e + 1], p[e + 2], c.collisionR[j]) < 1) return false;
        }
        return true;
      };
      let lo = 0, hi = 1;
      if (localClear(1)) lo = 1;
      else for (let j = 0; j < 8; j++) { const u = (lo + hi) / 2; if (localClear(u)) lo = u; else hi = u; }
      if (lo < 0.1 && i > 0) {
        // When the desired bend is around the far side of a corner, retract
        // along the existing clear span before extending toward it again.
        const a = b - 3, d = Math.hypot(p[a] - x, p[a + 1] - y, p[a + 2] - z);
        const retract = Math.min(1, remaining / (d || 1));
        dx = (p[a] - x) * retract; dy = (p[a + 1] - y) * retract; dz = (p[a + 2] - z) * retract;
        lo = 0; hi = 1;
        if (localClear(1)) lo = 1;
        else for (let j = 0; j < 8; j++) { const u = (lo + hi) / 2; if (localClear(u)) lo = u; else hi = u; }
      }
      localClear(lo);
    }
  }
  for (let b = 0; b < p.length; b++) o[b] += p[b] - goal[b];
  safe.set(p);
}

// ------------------------------------------------------------------ tentacle bundles

function tubeGeometry(count, segments, radial) {
  const pos = [], tent = [], idx = [];
  for (let k = 0; k < count; k++) {
    const base = pos.length / 3;
    for (let j = 0; j <= segments; j++) {
      // denser rings near the tip where curvature is highest
      const t = 1 - Math.pow(1 - j / segments, 1.25);
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        pos.push(Math.cos(a), t, Math.sin(a));
        tent.push(k);
      }
    }
    const row = radial + 1;
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < radial; i++) {
        const a = base + j * row + i, b = a + 1, c = a + row + 1, d = a + row;
        idx.push(a, d, b, b, d, c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  g.setAttribute('tent', new THREE.Float32BufferAttribute(tent, 1));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  return g;
}

function cupGeometry() {
  const prof = [[0.0, 0.03], [0.3, 0.05], [0.5, 0.12], [0.6, 0.26], [0.72, 0.32], [0.86, 0.28], [0.98, 0.14], [1.0, -0.05], [0.9, -0.25]];
  const g = new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), 14);
  g.computeVertexNormals();
  return g;
}

/**
 * Several tentacles in one draw call. Chains are simulated in world space; the mesh has an identity transform.
 * suckers: { rows, perRow, from, to, size } places cup instances on the underside.
 */
export class TentacleBundle {
  constructor({ count, points = 20, segments = 60, radial = 14, suckers = null, skin = {} }) {
    this.count = count;
    this.TN = points;
    this.data = new Float32Array(points * count * 2 * 4);
    this.tex = new THREE.DataTexture(this.data, points, count * 2, THREE.RGBAFormat, THREE.FloatType);
    this.tex.needsUpdate = true;
    const geo = tubeGeometry(count, segments, radial);
    this.material = makeSkinMaterial({ ...skin, kind: 'tentacle', spine: this.tex, tn: points });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    if (suckers) {
      const cup = cupGeometry();
      const ig = new THREE.InstancedBufferGeometry();
      ig.index = cup.index;
      ig.setAttribute('position', cup.attributes.position);
      ig.setAttribute('normal', cup.attributes.normal);
      const inst = [];
      const rand = mulberry32(count * 97 + points);
      for (let k = 0; k < count; k++) {
        for (let j = 0; j < suckers.perRow; j++) {
          const t = suckers.from + (suckers.to - suckers.from) * Math.pow(j / (suckers.perRow - 1), 1.15);
          for (let r = 0; r < suckers.rows; r++) {
            const off = suckers.rows === 1 ? 0 : (r / (suckers.rows - 1) - 0.5) * 0.9;
            const a = -Math.PI / 2 + off + (j % 2 ? 0.12 : -0.12) * (suckers.rows > 1 ? 1 : 0);
            const s = suckers.size * (1 - t * 0.35) * (0.8 + rand() * 0.35);
            inst.push(k, t + (r % 2) * 0.006, a, s);
          }
        }
      }
      ig.setAttribute('sk', new THREE.InstancedBufferAttribute(new Float32Array(inst), 4));
      ig.instanceCount = inst.length / 4;
      this.suckerMaterial = makeSkinMaterial({ ...skin, kind: 'sucker', spine: this.tex, tn: points, roughness: 0.22 });
      this.suckerMesh = new THREE.Mesh(ig, this.suckerMaterial);
      this.suckerMesh.frustumCulled = false;
      this.group.add(this.suckerMesh);
    }
  }

  set(k, chain) {
    const TN = this.TN, d = this.data;
    const rowP = (k * 2) * TN * 4, rowN = (k * 2 + 1) * TN * 4;
    for (let i = 0; i < TN; i++) {
      d[rowP + i * 4] = chain.p[i * 3];
      d[rowP + i * 4 + 1] = chain.p[i * 3 + 1];
      d[rowP + i * 4 + 2] = chain.p[i * 3 + 2];
      d[rowP + i * 4 + 3] = chain.r[i];
      d[rowN + i * 4] = chain.nrm[i * 3];
      d[rowN + i * 4 + 1] = chain.nrm[i * 3 + 1];
      d[rowN + i * 4 + 2] = chain.nrm[i * 3 + 2];
      d[rowN + i * 4 + 3] = chain.length;
    }
  }

  upload() { this.tex.needsUpdate = true; }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.suckerMesh) { this.suckerMesh.geometry.dispose(); this.suckerMaterial.dispose(); }
    this.tex.dispose();
  }
}

// ------------------------------------------------------------------ sculpted bodies

const _v = new THREE.Vector3();

function frameFor(d) {
  const up = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(up, d).normalize();
  const v = new THREE.Vector3().crossVectors(d, u).normalize();
  return { u, v };
}

/**
 * Sculpts a fleshy many-eyed mass from a subdivided sphere.
 * params: seed, radius, stretch [sx,sy,sz], detail, lumps [{dir,amp,width}], fold, foldFreq,
 * eyes [{dir, size}] (size = angular radius), maw {dir, ru, rv, depth, lip}, pale (underside paling).
 * Returns geometry (with `tone`), eye sockets {pos, normal, radius} and helpers in object space.
 */
export function sculptBody(P) {
  const noise = makeNoise3(P.seed);
  const S = new THREE.Vector3(...P.stretch);
  const R = P.radius;
  const eyes = P.eyes.map((e, i) => {
    const d = new THREE.Vector3(...e.dir).normalize();
    return { d, size: e.size, depth: e.size * 0.95, rim: e.size * 0.42, ph: i * 1.7, ...frameFor(d) };
  });
  const lumps = P.lumps.map((l) => ({ d: new THREE.Vector3(...l.dir).normalize(), a: l.amp, w: l.width }));
  let maw = null;
  if (P.maw) {
    const d = new THREE.Vector3(...P.maw.dir).normalize();
    maw = { d, ...frameFor(d), ru: P.maw.ru, rv: P.maw.rv, depth: P.maw.depth, lip: P.maw.lip };
  }
  const F = P.foldFreq;
  const tone = [0, 0, 0];

  /** Unit radius at direction d (unit). skipEye excludes one socket (to find the undisturbed surface). */
  function shape(d, skipEye = -1, out = tone) {
    let r = 1, cav = 0, inner = 0, lid = 0;
    for (const L of lumps) r += L.a * Math.exp((d.dot(L.d) - 1) / L.w);
    const wx = noise(d.x * 1.3 + 11, d.y * 1.3, d.z * 1.3) - 0.5;
    const wy = noise(d.x * 1.3, d.y * 1.3 + 23, d.z * 1.3) - 0.5;
    const wz = noise(d.x * 1.3, d.y * 1.3, d.z * 1.3 + 37) - 0.5;
    const qx = d.x + wx * 0.9, qy = d.y + wy * 0.9, qz = d.z + wz * 0.9;
    const n1 = noise(qx * F, qy * F, qz * F);
    const n2 = noise(qx * F * 2.3 + 5, qy * F * 2.3, qz * F * 2.3);
    const n3 = noise(qx * F * 0.55 + 9, qy * F * 0.55, qz * F * 0.55);
    const c1 = Math.pow(1 - Math.abs(n1 * 2 - 1), 5);
    const c2 = Math.pow(1 - Math.abs(n2 * 2 - 1), 5);
    r += P.fold * ((n3 - 0.5) * 1.6 - c1 - 0.45 * c2);
    cav += c1 * 0.55 + c2 * 0.2;
    for (let i = 0; i < eyes.length; i++) {
      if (i === skipEye) continue;
      const e = eyes[i];
      const th = Math.acos(Math.max(-1, Math.min(1, d.dot(e.d))));
      const x = th / e.size;
      if (x > 3) continue;
      if (x < 1) r -= e.depth * Math.pow(1 - x * x, 0.7);
      const ring = Math.exp(-(((x - 1.1) / 0.32) ** 2));
      r += e.rim * ring;
      const phi = Math.atan2(d.dot(e.v), d.dot(e.u));
      r += e.rim * 0.35 * Math.sin(phi * 7 + e.ph) * Math.exp(-(((x - 1.7) / 0.5) ** 2));
      lid = Math.max(lid, ring);
      cav += Math.exp(-(((x - 1.45) / 0.25) ** 2)) * 0.5;
    }
    if (maw) {
      const c = d.dot(maw.d);
      if (c > 0) {
        const au = Math.atan2(d.dot(maw.u), c) / maw.ru;
        const av = Math.atan2(d.dot(maw.v), c) / maw.rv;
        const e = Math.hypot(au, av);
        if (e < 1) r -= maw.depth * Math.pow(1 - e * e, 0.45);
        r += maw.lip * Math.exp(-(((e - 1.06) / 0.16) ** 2));
        const phi = Math.atan2(av, au);
        r += maw.lip * 0.55 * Math.sin(phi * 19) * Math.exp(-(((e - 1.45) / 0.35) ** 2));
        inner = Math.max(inner, Math.min(1, Math.max(0, (1.12 - e) / 0.3)));
        cav += Math.exp(-(((e - 1.3) / 0.2) ** 2)) * 0.6;
      }
    }
    out[0] = Math.min(1, cav * 0.9 + lid * 0.35);
    out[1] = inner;
    out[2] = P.pale ? Math.max(0, Math.min(1, (-d.y - 0.25) * 1.4)) * P.pale : 0;
    return r;
  }

  const toPos = (d, r, out) => out.set(d.x * r * R * S.x, d.y * r * R * S.y, d.z * r * R * S.z);

  let geo = new THREE.IcosahedronGeometry(1, P.detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-5);
  const pos = geo.attributes.position;
  const toneArr = new Float32Array(pos.count * 3);
  const d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    const r = shape(d);
    toPos(d, r, _v);
    pos.setXYZ(i, _v.x, _v.y, _v.z);
    toneArr[i * 3] = tone[0];
    toneArr[i * 3 + 1] = tone[1];
    toneArr[i * 3 + 2] = tone[2];
  }
  geo.setAttribute('tone', new THREE.BufferAttribute(toneArr, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const tmpT = [0, 0, 0];
  /** Surface point and normal in object space for direction d (numerical normal). */
  function surface(dir, skipEye = -1) {
    const dd = dir.clone().normalize();
    const { u, v } = frameFor(dd);
    const h = 0.004;
    const p0 = toPos(dd, shape(dd, skipEye, tmpT), new THREE.Vector3());
    const du = dd.clone().addScaledVector(u, h).normalize();
    const dv = dd.clone().addScaledVector(v, h).normalize();
    const pu = toPos(du, shape(du, skipEye, tmpT), new THREE.Vector3());
    const pv = toPos(dv, shape(dv, skipEye, tmpT), new THREE.Vector3());
    const n = new THREE.Vector3().crossVectors(pu.sub(p0), pv.sub(p0)).normalize();
    if (n.dot(dd) < 0) n.negate();
    return { pos: p0, normal: n };
  }

  const avgS = (S.x + S.y + S.z) / 3;
  const sockets = eyes.map((e, i) => {
    const s = surface(e.d, i);
    const radius = e.size * R * avgS * 0.82;
    return { pos: s.pos.clone().addScaledVector(s.normal, -radius * 0.32), normal: s.normal, radius, dir: e.d };
  });

  return { geometry: geo, sockets, surface, maw, R, S };
}

// ------------------------------------------------------------------ eyes

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _t = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);

/** Tracking, blinking eyes set into a sculpted body. Each eye can be opened independently. */
export class EyeSet {
  constructor(parent, sockets, o) {
    const rand = mulberry32(o.seed || 5);
    this.rand = rand;
    const ballGeo = new THREE.SphereGeometry(1, 40, 28);
    const lidGeo = new THREE.SphereGeometry(1.1, 40, 28);
    this.materials = [];
    const main = makeEyeMaterial({ iris: o.iris, probe: o.probe, seed: 1 });
    const alt = makeEyeMaterial({ iris: o.irisAlt || o.iris, sclera: o.scleraAlt, irisR: 0.5, probe: o.probe, seed: 7 });
    this.materials.push(main, alt);
    this.eyes = sockets.map((s, i) => {
      const g = new THREE.Group();
      g.position.copy(s.pos);
      // local +Z = socket normal, +Y toward the body's up
      const up = new THREE.Vector3(0, 1, 0);
      const x = new THREE.Vector3().crossVectors(up, s.normal);
      if (x.lengthSq() < 1e-4) x.set(1, 0, 0);
      x.normalize();
      const y = new THREE.Vector3().crossVectors(s.normal, x).normalize();
      _m.makeBasis(x, y, s.normal);
      g.quaternion.setFromRotationMatrix(_m);
      const ball = new THREE.Mesh(ballGeo, i % 4 === 3 ? alt : main);
      ball.scale.setScalar(s.radius);
      const lidMat = makeSkinMaterial({ ...o.skin, kind: 'lid', probe: o.probe, rim: o.rim, scale: (o.skin?.scale ?? 1) * 1.6 });
      const lid = new THREE.Mesh(lidGeo, lidMat);
      lid.scale.setScalar(s.radius);
      g.add(ball, lid);
      parent.add(g);
      return {
        group: g, ball, lid, lidU: lidMat.userData.u, radius: s.radius,
        open: 0, openTarget: 0, blink: 0, blinkT: 2 + rand() * 6,
        wander: new THREE.Vector3(0, 0, 1), wanderT: rand() * 2,
        look: new THREE.Quaternion(),
      };
    });
  }

  setOpen(i, v) { if (this.eyes[i]) this.eyes[i].openTarget = v; }
  setAllOpen(v) { for (const e of this.eyes) e.openTarget = v; }

  /** target: world-space point to stare at (or null to wander). focus 0..1 = how locked-on the eyes are. */
  update(dt, target, focus, dilate, glow) {
    for (const m of this.materials) {
      m.userData.u.uDilate.value += (dilate - m.userData.u.uDilate.value) * Math.min(1, dt * 2);
      m.userData.u.uGlow.value += (glow - m.userData.u.uGlow.value) * Math.min(1, dt * 2.5);
    }
    for (const e of this.eyes) {
      e.open += (e.openTarget - e.open) * Math.min(1, dt * 2.2);
      e.blinkT -= dt;
      if (e.blinkT <= 0) { e.blink = 1; e.blinkT = 2.5 + this.rand() * 7; }
      e.blink = Math.max(0, e.blink - dt * 5);
      const bl = Math.sin(Math.min(1, e.blink) * Math.PI);
      const op = Math.max(0, e.open * (1 - bl));
      e.lidU.uLidTop.value = 0.55 * op + 0.02 * (1 - op);
      e.lidU.uLidBot.value = -0.62 * op + 0.02 * (1 - op);
      e.ball.visible = e.open > 0.02 || e.openTarget > 0;
      // desired direction in the eye's local frame
      e.wanderT -= dt;
      if (e.wanderT <= 0) {
        e.wanderT = 0.4 + this.rand() * 2.2;
        e.wander.set((this.rand() - 0.5) * 1.1, (this.rand() - 0.5) * 0.8, 1).normalize();
      }
      let dir = e.wander;
      if (target && focus > 0.01) {
        e.group.updateWorldMatrix(true, false);
        _t.copy(target);
        e.group.worldToLocal(_t);
        _t.normalize();
        // clamp to a cone the eye can physically rotate through
        const ang = Math.acos(Math.max(-1, Math.min(1, _t.z)));
        const maxA = 0.85;
        if (ang > maxA) {
          const k = Math.sin(maxA) / Math.max(1e-4, Math.hypot(_t.x, _t.y));
          _t.set(_t.x * k, _t.y * k, Math.cos(maxA));
        }
        dir = _t.lerp(e.wander, 1 - focus).normalize();
      }
      _q.setFromUnitVectors(_z, dir);
      // saccades: fast snap rather than smooth pursuit
      e.look.slerp(_q, Math.min(1, dt * (focus > 0.5 ? 9 : 5)));
      e.ball.quaternion.copy(e.look);
    }
  }

  dispose() {
    for (const e of this.eyes) e.lid.material.dispose();
    for (const m of this.materials) m.dispose();
    if (this.eyes[0]) { this.eyes[0].ball.geometry.dispose(); this.eyes[0].lid.geometry.dispose(); }
  }
}

/** Instanced needle teeth placed on the maw rim. */
export function buildTeeth(body, count, lenMin, lenMax, probe, seed) {
  const { maw, surface } = body;
  const rand = mulberry32(seed);
  const geo = toothGeometry();
  const mesh = new THREE.InstancedMesh(geo, makeToothMaterial(probe), count);
  const up = new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const axisPt = surface(maw.d).pos;
  for (let i = 0; i < count; i++) {
    const row = i % 3 === 2 ? 0.62 : 0.9 + rand() * 0.08;
    const phi = (i / count) * Math.PI * 2 * 3 + rand() * 0.4;
    const d = maw.d.clone()
      .addScaledVector(maw.u, Math.tan(maw.ru * Math.cos(phi) * row))
      .addScaledVector(maw.v, Math.tan(maw.rv * Math.sin(phi) * row)).normalize();
    const sp = surface(d);
    const inward = axisPt.clone().sub(sp.pos).normalize();
    const dir = inward.multiplyScalar(0.8).addScaledVector(sp.normal, 0.35).addScaledVector(maw.d, -0.25).normalize();
    // longer fangs top and bottom of the slit
    const len = (lenMin + (lenMax - lenMin) * (0.4 + 0.6 * Math.abs(Math.sin(phi))) * (0.6 + rand() * 0.4)) * (row < 0.7 ? 0.6 : 1);
    q.setFromUnitVectors(up, dir);
    s.set(len * 0.055, len, len * 0.055);
    m.compose(sp.pos.clone().addScaledVector(dir, -len * 0.08), q, s);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Deterministic eye layout: rejection-sampled directions inside a region, avoiding the maw. */
export function layoutEyes({ seed, sizes, region, maw, minGap = 0.05 }) {
  const rand = mulberry32(seed);
  const out = [];
  const mawD = maw ? new THREE.Vector3(...maw.dir).normalize() : null;
  const mf = mawD ? frameFor(mawD) : null;
  for (const size of sizes) {
    for (let tries = 0; tries < 400; tries++) {
      const d = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      if (d.lengthSq() > 1 || d.lengthSq() < 0.01) continue;
      d.normalize();
      if (!region(d, size)) continue;
      let ok = true;
      for (const e of out) {
        if (Math.acos(Math.min(1, d.dot(e.d))) < (size + e.size) * 1.45 + minGap) { ok = false; break; }
      }
      if (ok && mawD) {
        const c = d.dot(mawD);
        if (c > 0) {
          const au = Math.atan2(d.dot(mf.u), c) / maw.ru, av = Math.atan2(d.dot(mf.v), c) / maw.rv;
          if (Math.hypot(au, av) < 1.35 + size / Math.min(maw.ru, maw.rv)) ok = false;
        }
      }
      if (ok) { out.push({ d, size }); break; }
    }
  }
  return out.map((e) => ({ dir: [e.d.x, e.d.y, e.d.z], size: e.size }));
}
