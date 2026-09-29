import * as THREE from 'three';
import { sculptBody, EyeSet, buildTeeth, layoutEyes, makeSkinMaterial, TentacleBundle, Chain, makeNoise3, collideChain } from './flesh.js';
import { pointsMaterial } from '../render/fx.js';
import { mulberry32 } from '../render/textures.js';
import { DECK_Y } from '../level/level.js';
import { attackClear, abyssTerrain, PoseGuard, sphereClear, sphereTravel } from './collision.js';
import { ABYSS } from '../level/mapdata.js';
import { exposure, sight, awarenessRate, AWARE_SUSPICIOUS, AWARE_CHASE } from './senses.js';
import { modelSkin, disposeModelSkin, castOnto } from './tripo.js';

// The thing in the Abyss hall: a many-eyed cephalopod mass that rises from the bottomless pool,
// watches the hall and hammers anything it sees with arms as thick as pillars.

const DORMANT_Y = -34;
const _upright = new THREE.Quaternion();
const WATCH_Y = 5.2;
const RISE_TIME = 11;
const SINK_TIME = 9;
// world centre of the Abyss hall
const CX = ABYSS.x0 + ABYSS.x1 + 1, CZ = ABYSS.z0 + ABYSS.z1 + 1;
const X_MIN = CX - 5, X_MAX = CX + 5;
// Two resting places either side of the island; yaw 0 faces +z
const ZONES = [
  { z: CZ - 9.2, yaw: 0 },
  { z: CZ + 9.2, yaw: Math.PI },
];
const REGION = { x0: ABYSS.x0 - 1, z0: ABYSS.z0 - 1, x1: ABYSS.x1 + 1, z1: ABYSS.z1 + 3 };

const SKIN = {
  colA: [0.052, 0.05, 0.03],
  colB: [0.019, 0.019, 0.012],
  colFold: [0.1, 0.02, 0.038],
  colVein: [0.17, 0.028, 0.06],
  colTop: [0.095, 0.09, 0.055],
  colInner: [0.26, 0.035, 0.05],
  colPale: [0.18, 0.14, 0.1],
  roughness: 0.3,
  bump: 1.25,
};
const BEARD_SKIN = {
  colA: [0.1, 0.028, 0.042],
  colB: [0.045, 0.012, 0.022],
  colFold: [0.13, 0.03, 0.05],
  colVein: [0.22, 0.04, 0.07],
  colTop: [0.2, 0.07, 0.07],
  colInner: [0.3, 0.05, 0.06],
  colPale: [0.24, 0.11, 0.1],
  roughness: 0.25,
  bump: 0.8,
};

const MAW = { dir: [0, -0.42, 1], ru: 0.24, rv: 0.46, depth: 0.3, lip: 0.07 };
const HEAD_P = {
  seed: 71, radius: 5.2, stretch: [1.05, 1.28, 0.95], detail: 56, fold: 0.075, foldFreq: 3.2, pale: 0.3,
  maw: MAW,
  lumps: [
    { dir: [0, 0.75, -0.55], amp: 0.34, width: 0.32 },
    { dir: [0.35, 0.95, -0.1], amp: 0.12, width: 0.12 },
    { dir: [-0.4, 0.9, 0.05], amp: 0.1, width: 0.1 },
    { dir: [0.55, 0.35, 0.75], amp: 0.1, width: 0.08 },
    { dir: [-0.55, 0.3, 0.78], amp: 0.12, width: 0.09 },
    { dir: [0.85, -0.25, 0.4], amp: 0.14, width: 0.16 },
    { dir: [-0.85, -0.2, 0.45], amp: 0.12, width: 0.14 },
    { dir: [0, -1, 0], amp: -0.15, width: 0.4 },
  ],
  eyes: layoutEyes({
    seed: 9,
    sizes: [0.2, 0.17, 0.14, 0.12, 0.11, 0.095, 0.085, 0.075, 0.065, 0.055, 0.05, 0.045],
    region: (d) => d.z > 0.05 && d.y > -0.3 && d.y < 0.8,
    maw: MAW,
  }),
};
const TRUNK_P = {
  seed: 72, radius: 5, stretch: [1.12, 1.6, 1.08], detail: 36, fold: 0.06, foldFreq: 2.6, pale: 0.55,
  maw: null,
  lumps: [
    { dir: [0, 1, 0], amp: -0.1, width: 0.3 },
    { dir: [0.6, -0.3, 0.7], amp: 0.12, width: 0.2 },
    { dir: [-0.7, -0.1, 0.6], amp: 0.1, width: 0.18 },
  ],
  eyes: layoutEyes({ seed: 12, sizes: [0.1, 0.08, 0.07, 0.05], region: (d) => d.z > 0.35 && d.y > 0.12 && d.y < 0.42 }),
};
const TRUNK_OFFSET = new THREE.Vector3(0, -10.8, -1.4);

// Tripo body (public/models/colossus.glb: metres, facing +z, maw near the origin). Above the neck the
// mesh follows the head pivot in the vertex shader, fading into the rigid trunk between NECK_LO and NECK_HI.
const NECK = new THREE.Vector3(0, -5, 0);
const NECK_LO = -8, NECK_HI = -2;
const MODEL_MAW = new THREE.Vector3(0, -1, 5);
// ellipses on the face [cx, cy, rx, ry] around the maw where the beard and the feelers grow
const BEARD_RING = [0, -1.05, 0.85, 1.8];
const FEEL_RING = [0, -1.3, 1.5, 1.9];
const MODEL_VERT_DECL = 'uniform mat4 uHead;\nuniform float uTime;\nvarying vec3 vRest;\n';
const MODEL_VERT = /* glsl */ `
float hw = smoothstep(${NECK_LO.toFixed(1)}, ${NECK_HI.toFixed(1)}, position.y);
vec3 objectNormal = normalize(mix(normal, mat3(uHead) * normal, hw));
// a slow swell running up the body
float swell = sin(uTime * 0.8 - position.y * 0.32 + position.x * 0.15) * 0.06;
vec3 wr_tpos = mix(position, (uHead * vec4(position, 1.0)).xyz, hw) + objectNormal * swell;
vRest = position;
`;
const MODEL_FRAG_DECL = /* glsl */ `
varying vec3 vRest;
uniform float uEyeOpen;
uniform float uEyeGlow;
uniform vec3 uEyeCol;
`;
// The amber irises painted on the face glow; they open patch by patch as uEyeOpen rises from -0.1 to 1.1.
const MODEL_EYES = /* glsl */ `
float eyeK;
{
  vec3 c = sqrt(max(diffuseColor.rgb, vec3(0.0)));
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float hue = (c.g - c.b) / max(mx - mn, 1e-4);
  float amber = step(c.g, c.r) * smoothstep(0.2, 0.35, hue) * smoothstep(0.5, 0.62, (mx - mn) / max(mx, 1e-4)) * smoothstep(0.42, 0.55, mx);
  amber *= smoothstep(2.8, 3.6, vRest.z) * smoothstep(-0.8, -0.2, vRest.y) * smoothstep(5.8, 5.2, vRest.y);
  float n = clamp((wr_noise(vRest * 0.55 + 7.0) - 0.25) * 2.0, 0.0, 1.0);
  float open = smoothstep(n - 0.06, n + 0.06, uEyeOpen);
  eyeK = amber * mix(0.05, 1.0, open);
  diffuseColor.rgb *= 1.0 - amber * (1.0 - open) * 0.65;
}
`;
const MODEL_EYE_GLOW = 'totalEmissiveRadiance += uEyeCol * eyeK * uEyeGlow;';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _hp = new THREE.Vector3();

const BZ = 28;
const _bz = new Float32Array((BZ + 1) * 3);
const _bl = new Float32Array(BZ + 1);

/** Distribute the arm along the curve, contracting when the target is close. */
function poseAlong(chain, out, p0, p1, p2, p3) {
  for (let s = 0; s <= BZ; s++) {
    const t = s / BZ, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    _bz[s * 3] = a * p0.x + b * p1.x + c * p2.x + d * p3.x;
    _bz[s * 3 + 1] = a * p0.y + b * p1.y + c * p2.y + d * p3.y;
    _bz[s * 3 + 2] = a * p0.z + b * p1.z + c * p2.z + d * p3.z;
    _bl[s] = s ? _bl[s - 1] + Math.hypot(_bz[s * 3] - _bz[s * 3 - 3], _bz[s * 3 + 1] - _bz[s * 3 - 2], _bz[s * 3 + 2] - _bz[s * 3 - 1]) : 0;
  }
  const L = _bl[BZ];
  let j = 0;
  for (let i = 0; i < chain.n; i++) {
    const s = i / (chain.n - 1) * Math.min(L, chain.length);
    const o = i * 3;
    while (j < BZ - 1 && _bl[j + 1] < s) j++;
    const f = (s - _bl[j]) / Math.max(1e-6, _bl[j + 1] - _bl[j]);
    out[o] = _bz[j * 3] + (_bz[j * 3 + 3] - _bz[j * 3]) * f;
    out[o + 1] = _bz[j * 3 + 1] + (_bz[j * 3 + 4] - _bz[j * 3 + 1]) * f;
    out[o + 2] = _bz[j * 3 + 2] + (_bz[j * 3 + 5] - _bz[j * 3 + 2]) * f;
  }
}

const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

function makeMist(count) {
  const rand = mulberry32(606);
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
  const mat = pointsMaterial({
    blending: THREE.NormalBlending,
    uniforms: { uCenter: { value: new THREE.Vector3() }, uMist: { value: 0 } },
    vertex: /* glsl */ `
      uniform vec3 uCenter;
      uniform float uMist;
      attribute vec4 seed;
      varying vec3 vCol;
      varying float vA;
      varying float vSeed;
      void main() {
        float a = seed.x * 6.2831853 + uTime * 0.025 * (seed.w - 0.5);
        float r = 4.5 + seed.y * 11.0;
        vec3 p = uCenter + vec3(cos(a) * r, 0.5 + seed.z * 2.4 + sin(uTime * 0.2 + seed.w * 9.0) * 0.3, sin(a) * r);
        vWPos = p;
        vWNrm = vec3(0.0, 1.0, 0.0);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp((5.0 + seed.z * 7.0) * uPx / max(-mv.z, 0.1), 0.0, 700.0);
        vCol = wr_pointLight(p) * 0.5 + vec3(0.03, 0.045, 0.05);
        vA = uMist * (0.1 + seed.w * 0.12) * smoothstep(2.0, 9.0, -mv.z) * step(0.0, cameraPosition.y);
        vSeed = seed.w;
      }
    `,
    fragment: /* glsl */ `
      varying vec3 vCol;
      varying float vA;
      varying float vSeed;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        if (r > 1.0 || vA < 0.002) discard;
        float n = wr_noise(vec3(gl_PointCoord * 3.0, uTime * 0.12 + vSeed * 40.0));
        float a = (1.0 - smoothstep(0.15, 1.0, r)) * vA * (0.5 + 0.9 * n);
        gl_FragColor = vec4(wr_medium(vCol, vWPos), a);
      }
    `,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  return pts;
}

export class Colossus {
  constructor({ scene, level, lampSys, audio, water, fx, lightGrid, model = null }) {
    this.level = level;
    this.lampSys = lampSys;
    this.audio = audio;
    this.water = water;
    this.fx = fx;
    this.lightGrid = lightGrid;
    this.rand = mulberry32(777);
    this.noise = makeNoise3(91);
    this.group = new THREE.Group();
    scene.add(this.group);
    this.probe = { value: new THREE.Color(0.012, 0.016, 0.02) };
    this.rim = { value: new THREE.Color(0.01, 0.022, 0.026) };
    this.events = [];
    this.onCatch = null;
    this.gateOpen = false;
    this.revealed = false;
    this.tripo = !!model;
    // head pivot and head frame relative to the root, refreshed in _place
    this.headLocal = new THREE.Matrix4();
    this._buildBody(model);
    this._buildLimbs();
    this.terrain = abyssTerrain(level);
    this.bodyGuard = new PoseGuard([this.root, this.headPivot, this.headMesh, ...(this.trunkMesh ? [this.trunkMesh] : [])],
      () => this._bodyClear(), () => {
        this.root.updateMatrixWorld(true);
        this.headLocal.multiplyMatrices(this.headPivot.matrix, this.headMesh.matrix);
      }, 18);
    this.mist = makeMist(46);
    this.group.add(this.mist);
    this.lamp = lampSys.add({ type: 'creature', x: 0, y: -500, z: 0, color: [1, 0.42, 0.1], intensity: 0, range: 18 });
    this.voice = audio.createCreatureVoice('colossus');
    this.drape = [];
    for (let tz = REGION.z0; tz <= REGION.z1; tz++) {
      for (let tx = REGION.x0; tx <= REGION.x1; tx++) {
        const c = level.ch(tx, tz);
        if (level.inHall(tx, tz) !== 22) continue;
        const [x, z] = level.worldCenter(tx, tz);
        if (c === '.') this.drape.push({ x, z, deck: true });
        else if (c === 'O' && (tx + tz) % 2 === 0) this.drape.push({ x, z, deck: false });
      }
    }
    this.reset();
  }

  // ------------------------------------------------------------------ construction

  _buildBody(model) {
    const skin = { ...SKIN, probe: this.probe, rim: this.rim };
    this.skin = skin;
    this.root = new THREE.Group();
    this.group.add(this.root);
    this.headPivot = new THREE.Group();
    this.root.add(this.headPivot);
    if (model) {
      this._buildModel(model);
      return;
    }
    this.head = sculptBody(HEAD_P);
    this.headMesh = new THREE.Mesh(this.head.geometry, makeSkinMaterial({ ...skin, kind: 'body', scale: 0.9 }));
    this.headPivot.add(this.headMesh);
    const eyeOpts = { iris: [1.0, 0.48, 0.07], irisAlt: [0.95, 0.7, 0.16], scleraAlt: [0.3, 0.25, 0.1], probe: this.probe, skin, rim: this.rim };
    this.headEyes = new EyeSet(this.headMesh, this.head.sockets, { ...eyeOpts, seed: 31 });
    this.teeth = buildTeeth(this.head, 44, 0.45, 1.6, this.probe, 3);
    this.headMesh.add(this.teeth);
    this.mawLocal = this.head.surface(this.head.maw.d).pos.clone();
    this.trunk = sculptBody(TRUNK_P);
    this.trunkMesh = new THREE.Mesh(this.trunk.geometry, makeSkinMaterial({ ...skin, kind: 'body', scale: 0.8 }));
    this.trunkMesh.position.copy(TRUNK_OFFSET);
    this.root.add(this.trunkMesh);
    this.trunkEyes = new EyeSet(this.trunkMesh, this.trunk.sockets, { ...eyeOpts, seed: 44 });
  }

  _buildModel(model) {
    // the head frame keeps the model's axes; its pivot sits in the neck
    this.headPivot.position.copy(NECK);
    this.headMesh = new THREE.Object3D();
    this.headMesh.position.copy(NECK).negate();
    this.headPivot.add(this.headMesh);
    this.eyeU = { uEyeOpen: { value: -0.1 }, uEyeGlow: { value: 0 }, uEyeCol: { value: new THREE.Color(1, 0.45, 0.08) } };
    this.bodyMat = modelSkin(model.material, {
      key: 'colossus', probe: this.probe, rim: this.rim, tint: [0.45, 0.45, 0.45], roughness: 0.55,
      uniforms: { uHead: { value: this.headLocal }, ...this.eyeU },
      vertDecl: MODEL_VERT_DECL,
      vertReplace: { beginnormal_vertex: MODEL_VERT, begin_vertex: 'vec3 transformed = wr_tpos;' },
      fragDecl: MODEL_FRAG_DECL,
      albedo: MODEL_EYES,
      emissive: MODEL_EYE_GLOW,
    });
    this.bodyMesh = new THREE.Mesh(model.geometry, this.bodyMat);
    this.bodyMesh.frustumCulled = false;
    this.root.add(this.bodyMesh);
    this.mawLocal = MODEL_MAW.clone();
  }

  /** Where arm k leaves the body, in root space. */
  _armAnchor(shape, ang, k) {
    if (!shape) return new THREE.Vector3(Math.sin(ang) * 5, -7.4 + (k >> 1) * 0.3, -0.8 + Math.cos(ang) * 5);
    const y = -8.6 + (k >> 1) * 0.3;
    const dir = new THREE.Vector3(-Math.sin(ang), 0, -Math.cos(ang));
    const hit = castOnto(shape, _a.set(Math.sin(ang) * 30, y, Math.cos(ang) * 30), dir);
    // sink the root into the flesh so the arm grows out of it
    return hit ? hit.pos.addScaledVector(dir, 0.7) : new THREE.Vector3(Math.sin(ang) * 4, y, Math.cos(ang) * 4);
  }

  /** Root on the model's face, e ring radii from the ring centre at angle phi (head space). */
  _faceAnchor(shape, ring, e, phi, depth) {
    const x = ring[0] + ring[2] * e * Math.cos(phi), y = ring[1] + ring[3] * e * Math.sin(phi);
    const hit = castOnto(shape, _a.set(x, y, 30), _b.set(0, 0, -1)) || { pos: new THREE.Vector3(x, y, 5), normal: new THREE.Vector3(0, 0, 1) };
    return {
      rootLocal: hit.pos.clone().addScaledVector(hit.normal, -depth),
      dirLocal: hit.normal.multiplyScalar(0.55).add(_c.set(0, -1, 0.15)).normalize(),
      w: smooth((y - NECK_LO) / (NECK_HI - NECK_LO)),
    };
  }

  _buildLimbs() {
    const rand = this.rand;
    // rays are cast against the model's rest shape
    const shape = this.tripo ? new THREE.Mesh(this.bodyMesh.geometry) : null;
    // six great arms rooted around the trunk just under the head
    const angs = [0.55, -0.55, 1.4, -1.4, 2.35, -2.35];
    this.armBundle = new TentacleBundle({
      count: angs.length, points: 22, segments: 96, radial: 18,
      suckers: { rows: 2, perRow: 46, from: 0.08, to: 0.97, size: 0.5 },
      skin: { ...this.skin, scale: 1.1, paleUnder: 0.85 },
    });
    this.arms = angs.map((ang, k) => {
      const chain = new Chain(22, 22 + rand() * 4, 1.0 + rand() * 0.15, 0.06, 0.8);
      return {
        k, ang, chain,
        rootLocal: this._armAnchor(shape, ang, k),
        rootW: new THREE.Vector3(),
        outX: 0, outZ: 1,
        mode: 'sink', t: 0, cool: 0,
        goal: new THREE.Vector3(), idleGoal: new THREE.Vector3(), idleT: 0,
        target: new THREE.Vector3(), strokeStart: new THREE.Vector3(), splashed: false, hit: false, surfT: 0,
        h1: -3, h2: 1,
        targets: new Float32Array(22 * 3),
        seed: rand() * 50,
      };
    });
    this.group.add(this.armBundle.group);

    // feelers on the lower face and a beard of fine tendrils around the maw
    const maw = this.head?.maw;
    const mawDir = (e, phi) => maw.d.clone()
      .addScaledVector(maw.u, Math.tan(maw.ru * e * Math.cos(phi)))
      .addScaledVector(maw.v, Math.tan(maw.rv * e * Math.sin(phi))).normalize();
    const hang = (dir, depth) => {
      const s = this.head.surface(dir);
      return {
        rootLocal: s.pos.clone().addScaledVector(s.normal, -depth),
        dirLocal: s.normal.clone().multiplyScalar(0.55).add(new THREE.Vector3(0, -1, 0.15)).normalize(),
        w: 1,
      };
    };
    const grow = (ring, e, phi, depth) => (shape ? this._faceAnchor(shape, ring, e, phi, depth) : hang(mawDir(e, phi), depth));
    this.feelBundle = new TentacleBundle({
      count: 8, points: 14, segments: 56, radial: 12,
      suckers: { rows: 1, perRow: 26, from: 0.12, to: 0.95, size: 0.6 },
      skin: { ...this.skin, scale: 1.6 },
    });
    this.feelers = [];
    for (let k = 0; k < 8; k++) {
      const phi = Math.PI * (1.08 + (k / 7) * 0.84) + (rand() - 0.5) * 0.12;
      const h = grow(FEEL_RING, 1.7 + rand() * 0.5, phi, 0.12);
      this.feelers.push({ ...h, chain: new Chain(14, 8.5 + rand() * 3.5, 0.34 + rand() * 0.08, 0.025, 0.9) });
    }
    this.group.add(this.feelBundle.group);
    this.beardBundle = new TentacleBundle({
      count: 34, points: 9, segments: 20, radial: 7, suckers: null,
      skin: { ...BEARD_SKIN, probe: this.probe, rim: this.rim, scale: 2.4 },
    });
    this.beard = [];
    for (let k = 0; k < 34; k++) {
      // denser along the lower lip
      const u = k / 34;
      const phi = Math.PI * 1.5 + Math.sin((u - 0.5) * Math.PI) * Math.PI * 0.98 + (rand() - 0.5) * 0.1;
      const h = grow(BEARD_RING, 1.02 + rand() * 0.22, phi, 0.05);
      const low = Math.max(0, -Math.sin(phi));
      this.beard.push({ ...h, chain: new Chain(9, 2.5 + low * 3 + rand() * 1.2, 0.1 + rand() * 0.06, 0.018, 0.8) });
    }
    this.group.add(this.beardBundle.group);
  }

  // ------------------------------------------------------------------ public

  reset() {
    this.bodyGuard.ready = false;
    this.state = 'dormant';
    this.t = 0;
    this.zone = ZONES[1];
    this.x = CX;
    this.z = this.zone.z;
    this.y = DORMANT_Y;
    this.yaw = this.zone.yaw;
    this.pitch = 0;
    this.awareness = 0;
    this.aggro = false;
    this.seenT = 99;
    this.calmT = 0;
    this.sleepT = 12;
    this.abyssT = 0;
    this.reveal = false;
    this.attackCool = 0;
    this.scanT = 0;
    this.scanYaw = this.yaw;
    this.focus = new THREE.Vector3(CX, 0, CZ);
    this.rippleT = 0;
    this.lampK = 0;
    this.caught = false;
    this.events.length = 0;
    this._place(0, 0);
    this._resetLimbs();
    if (!this.tripo) {
      this.headEyes.setAllOpen(0.1);
      this.trunkEyes.setAllOpen(0.25);
    }
    this.bodyGuard.reset();
  }

  _resetLimbs() {
    for (const a of this.arms) {
      a.mode = 'sink';
      a.t = 0; a.cool = 0; a.h1 = -3; a.h2 = 1;
      this._armRoot(a);
      a.chain.reset(a.rootW.x, a.rootW.y, a.rootW.z, a.outX * 0.5, -0.86, a.outZ * 0.5);
      a.chain.tip(a.goal);
    }
    for (const f of [...this.feelers, ...this.beard]) {
      this._headPoint(f.rootLocal, f.w, _a);
      f.chain.reset(_a.x, _a.y, _a.z, 0, -1, 0);
    }
  }

  /** A sound the creature may notice. r: audible radius; loud noises can wake it. */
  hear(x, y, z, r, loud) {
    if (this.state === 'dormant') {
      if (loud && this._inRegion(x, z) && this.sleepT <= 0) this._wake(false);
      return;
    }
    if (this.state === 'sinking') return;
    const d = Math.hypot(x - this.x, z - this.z);
    if (d > r * 1.6) return;
    this.awareness = Math.min(1.4, this.awareness + (loud ? 0.45 : 0.18) * (1 - d / (r * 1.6) * 0.5));
    this.focus.set(x, y, z);
    this.calmT = 0;
  }

  get awake() { return this.state !== 'dormant'; }

  /** Rough threat for music/UI: 0 asleep, ~0.4 watching, 1 hunting. */
  get threat() {
    if (this.state === 'dormant') return 0;
    const presence = this.state === 'watch' ? 0.35 : 0.25;
    return Math.max(presence, Math.min(1, this.awareness));
  }

  get disturb() {
    if (this.state === 'dormant') return null;
    const k = this.state === 'rising' ? 0.9 : this.state === 'sinking' ? 0.5 : 0.25 + this.awareness * 0.5;
    return { x: this.x, z: this.z, r: 34, amount: k };
  }

  update(dt, t, ctx) {
    const player = ctx.player;
    this.events.length = 0;
    const pIn = this._inRegion(player.pos.x, player.pos.z);
    this._think(dt, t, player, pIn);
    this._place(dt, t);
    this.group.visible = this.state !== 'dormant' || pIn;
    if (!this.group.visible) {
      this.lamp.y = -500;
      this.voice.setPosition(this.x, -400, this.z);
      this.voice.update(dt);
      return;
    }
    for (const a of this.arms) this._updateArm(a, dt, t, player);
    this.armBundle.upload();
    this.headMesh.getWorldDirection(_fwd);
    this._simHanging(this.feelers, this.feelBundle, dt, t, 9, 0.1);
    this._simHanging(this.beard, this.beardBundle, dt, t, 12, 0.05);
    this._effects(dt, t, ctx);
  }

  dispose() {
    this.group.removeFromParent();
    for (const b of [this.armBundle, this.feelBundle, this.beardBundle]) b.dispose();
    if (this.tripo) {
      this.bodyMesh.geometry.dispose();
      disposeModelSkin(this.bodyMat);
    } else {
      this.headEyes.dispose();
      this.trunkEyes.dispose();
      this.headMesh.geometry.dispose();
      this.headMesh.material.dispose();
      this.trunkMesh.geometry.dispose();
      this.trunkMesh.material.dispose();
      this.teeth.geometry.dispose();
      this.teeth.material.dispose();
    }
    this.mist.geometry.dispose();
    this.mist.material.dispose();
    this.voice.dispose();
    this.lamp.y = -500;
    this.lamp.intensity = 0;
  }

  // ------------------------------------------------------------------ behaviour

  _inRegion(x, z) {
    const tx = Math.floor(x / 2), tz = Math.floor(z / 2);
    return tx >= REGION.x0 && tx <= REGION.x1 && tz >= REGION.z0 && tz <= REGION.z1;
  }

  _wake(reveal) {
    this.state = 'rising';
    this.t = 0;
    this.reveal = reveal;
    this.revealed = true;
    this.calmT = 0;
    this.events.push({ type: 'rise' });
    this.voice.call();
  }

  _think(dt, t, player, pIn) {
    this.t += dt;
    this.attackCool -= dt;
    this.seenT += dt;
    const L = this.level;
    if (this.state === 'dormant') {
      this.sleepT -= dt;
      this.awareness = 0;
      this.aggro = false;
      if (pIn && L.ch(player.tileX, player.tileZ) === 'O') this.abyssT += dt;
      else this.abyssT = Math.max(0, this.abyssT - dt * 0.25);
      let wake = false, reveal = false;
      if (pIn && !this.revealed) { wake = true; reveal = true; }
      else if (pIn && this.sleepT <= 0 && (this.gateOpen || this.abyssT > 12 || this.sleepT < -55)) wake = true;
      if (wake) {
        this.zone = this.gateOpen ? ZONES[1] : player.pos.z < CZ ? ZONES[1] : ZONES[0];
        this.z = this.zone.z;
        this.x = Math.max(X_MIN, Math.min(X_MAX, player.pos.x));
        this.yaw = Math.atan2(player.pos.x - this.x, player.pos.z - this.z);
        this.scanYaw = this.yaw;
        this.y = DORMANT_Y;
        // Relocate the complete sleeping creature in the open cavern before it surfaces.
        this.bodyGuard.ready = false;
        this._place(0, t);
        this._resetLimbs();
        this.bodyGuard.reset();
        this._wake(reveal);
      }
      return;
    }
    if (this.state === 'rising') {
      const surfaced = this.y >= WATCH_Y - 0.15;
      const p = Math.min(1, this.t / RISE_TIME);
      this.y = DORMANT_Y + (WATCH_Y - DORMANT_Y) * smooth(p) + Math.sin(p * Math.PI) * 0.8;
      if (p > 0.72) this._look(dt, player);
      if (p >= 1 && surfaced) { this.state = 'watch'; this.t = 0; }
      this._turn(dt, 0.22);
      return;
    }
    if (this.state === 'sinking') {
      const submerged = this.y <= DORMANT_Y + 0.2;
      const p = Math.min(1, this.t / SINK_TIME);
      this.y = WATCH_Y + (DORMANT_Y - WATCH_Y) * smooth(p * p);
      this.awareness = Math.max(0, this.awareness - dt * 0.3);
      if (p >= 1 && submerged) {
        this.state = 'dormant';
        this.sleepT = 25 + this.rand() * 20;
        this.abyssT = 0;
      }
      return;
    }

    // --- watch
    this._look(dt, player);
    const loom = this.aggro ? 1.2 : 0;
    this.y += (WATCH_Y + loom + Math.sin(t * 0.37) * 0.35 + Math.sin(t * 0.91) * 0.18 - this.y) * Math.min(1, dt * 0.8);
    // drift across the zone to keep the player in reach
    const tx = this.awareness > AWARE_SUSPICIOUS ? this.focus.x : CX + Math.sin(t * 0.05) * 4;
    const want = Math.max(X_MIN, Math.min(X_MAX, tx));
    this.x += Math.max(-dt * 0.9, Math.min(dt * 0.9, want - this.x));
    this._turn(dt, this.aggro ? 0.42 : 0.24);
    if (this.awareness < AWARE_SUSPICIOUS * 0.6) this.calmT += dt;
    else this.calmT = 0;
    const hold = this.gateOpen && pIn;
    const calmLimit = this.reveal ? 13 : pIn ? 26 : 9;
    if (!hold && this.calmT > calmLimit) {
      this.state = 'sinking';
      this.t = 0;
      this.events.push({ type: 'sink' });
      for (const a of this.arms) if (a.mode === 'idle') { a.mode = 'sink'; a.t = 0; }
      return;
    }
    // attacks
    if (this.aggro && this.attackCool <= 0 && this.seenT < 2.2 && !this.caught) {
      let busy = 0;
      for (const a of this.arms) if (a.mode === 'raise' || a.mode === 'slam') busy++;
      if (busy < 2) {
        let best = null, bestD = Infinity;
        for (const a of this.arms) {
          if (a.mode !== 'idle' || a.cool > 0) continue;
          const d = Math.hypot(a.rootW.x - player.pos.x, a.rootW.z - player.pos.z);
          this._slamPoint(_a, player.pos.x, player.pos.z);
          if (d < a.chain.length * 0.85 && d < bestD && this._armPoseClear(a, _a, 5, 0.6)) { best = a; bestD = d; }
        }
        if (best) {
          best.mode = 'raise';
          best.t = 0;
          best.splashed = false;
          best.hit = false;
          best.chain.tip(best.strokeStart);
          this._slamPoint(best.target, player.pos.x, player.pos.z);
          this.attackCool = 1.4 + this.rand() * 1.0;
          this.voice.growl();
          this.events.push({ type: 'raise', x: best.target.x, z: best.target.z });
        }
      }
    }
  }

  /** Vision update: awareness rises while the player is seen, decays otherwise. */
  _look(dt, player) {
    const L = this.level;
    this.headMesh.getWorldDirection(_fwd);
    _fwd.y = 0;
    _fwd.normalize();
    const eye = _a.set(this.x, this.y + 1, this.z).addScaledVector(_fwd, 4.5);
    let range = 62;
    if (player.mode === 'under') range = player.pos.y < -1.2 ? 13 : 30;
    const d = sight(L, eye, _fwd, Math.cos(1.22), range, player.pos);
    const before = this.awareness;
    if (d >= 0) {
      const vis = exposure(player, this.lightGrid, L, eye);
      this.awareness = Math.min(1.5, this.awareness + awarenessRate(vis, d, range) * dt * 0.85);
      this.seenT = 0;
      if (this.awareness > AWARE_SUSPICIOUS * 0.5) this.focus.copy(player.pos);
    } else {
      this.awareness = Math.max(0, this.awareness - dt * (this.aggro ? 0.09 : 0.15));
    }
    if (before < AWARE_CHASE && this.awareness >= AWARE_CHASE) {
      this.aggro = true;
      this.attackCool = Math.max(this.attackCool, 0.9);
      this.voice.roar();
      this.events.push({ type: 'spotted' });
    }
    if (before >= AWARE_SUSPICIOUS && this.awareness < AWARE_SUSPICIOUS && this.aggro) {
      this.aggro = false;
      this.events.push({ type: 'lost' });
    }
    if (before < AWARE_SUSPICIOUS && this.awareness >= AWARE_SUSPICIOUS && !this.aggro) this.events.push({ type: 'suspicious' });
    this.voice.setState(this.aggro ? 'chase' : this.awareness > AWARE_SUSPICIOUS ? 'suspicious' : this.calmT > 3 && this.seenT < 30 ? 'search' : 'patrol');
  }

  /** Turn the head toward what it is interested in, scanning slowly otherwise. */
  _turn(dt, rate) {
    let want;
    if (this.awareness > AWARE_SUSPICIOUS * 0.5) {
      want = Math.atan2(this.focus.x - this.x, this.focus.z - this.z);
    } else {
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 4 + this.rand() * 5;
        this.scanYaw = this.zone.yaw + (this.rand() - 0.5) * 2.2;
      }
      want = this.scanYaw;
    }
    let dy = want - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += Math.max(-rate * dt, Math.min(rate * dt, dy));
    // tilt the face down toward the focus
    const hd = Math.hypot(this.focus.x - this.x, this.focus.z - this.z);
    const wantPitch = this.awareness > 0.15 ? Math.max(-0.15, Math.min(0.38, Math.atan2(this.y - this.focus.y, hd) * 0.55)) : 0.06;
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * 0.8);
  }

  _slamPoint(out, x, z) {
    const L = this.level;
    const tx = Math.floor(x / 2), tz = Math.floor(z / 2);
    const deck = !L.isWater(tx, tz) && !L.solid(tx, tz);
    out.set(x, deck ? L.floor(tx, tz) + 0.35 : -0.7, z);
    return deck;
  }

  _place(dt, t) {
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.set(0, this.yaw, 0);
    this.headPivot.rotation.set(this.pitch + Math.sin(t * 0.31) * 0.025, Math.sin(t * 0.17) * 0.04, Math.sin(t * 0.23) * 0.035, 'YXZ');
    // Keep the head upright and at rest size while it clears the narrow shaft.
    if (this.state === 'rising') {
      this.root.rotation.y = this.zone.yaw;
      this.headPivot.quaternion.copy(_upright);
    }
    const br = 1 + (this.state === 'rising' ? 0 : 0.012 * Math.sin(t * 0.8));
    this.headMesh.scale.set(br, br, br);
    if (this.trunkMesh) this.trunkMesh.rotation.set(Math.sin(t * 0.13) * 0.03, 0, Math.sin(t * 0.2) * 0.03);
    this.root.updateMatrixWorld(true);
    this.headLocal.multiplyMatrices(this.headPivot.matrix, this.headMesh.matrix);
    if (this.bodyGuard?.ready) {
      const wanted = this.root.position.clone();
      if (this.bodyGuard.constrain() < 1) {
        // Straighten in the shaft before continuing to rise. A blocked looking
        // turn must not lock vertical movement at the wall's lower edge.
        const k = Math.min(1, dt * 3);
        this.root.rotation.y += Math.atan2(Math.sin(this.zone.yaw - this.root.rotation.y), Math.cos(this.zone.yaw - this.root.rotation.y)) * k;
        this.headPivot.quaternion.slerp(_upright, k);
        this.bodyGuard.constrain();
        this.root.position.copy(wanted);
        this.bodyGuard.constrain();
      }
      this.x = this.root.position.x; this.y = this.root.position.y; this.z = this.root.position.z;
      this.yaw = this.root.rotation.y;
      this.pitch = this.headPivot.rotation.x - Math.sin(t * 0.31) * 0.025;
    }
  }

  _bodyClear() {
    // Limbs share their body's sweep budget, so a blocked tentacle cannot be left
    // behind while its attachment rises or turns through the next pose.
    for (const arm of this.arms) {
      _a.copy(arm.rootLocal).applyMatrix4(this.root.matrixWorld);
      if (arm.chain.collisionReady && _a.distanceTo(_b.fromArray(arm.chain.p)) > 0.2) return false;
    }
    for (const limb of [...this.feelers, ...this.beard]) {
      this._headPoint(limb.rootLocal, limb.w, _a);
      if (limb.chain.collisionReady && _a.distanceTo(_b.fromArray(limb.chain.p)) > 0.12) return false;
    }
    if (this.tripo) {
      const pos = this.bodyMesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _a.fromBufferAttribute(pos, i);
        const k = Math.max(0, Math.min(1, (_a.y + 8) / 6)), w = k * k * (3 - 2 * k);
        this._headPoint(_a, w, _b);
        // Include the shader's 6 cm breathing displacement.
        if (!sphereClear(this.terrain, _b.x, _b.y, _b.z, 0.09)) return false;
      }
    } else {
      for (const mesh of [this.headMesh, this.trunkMesh]) {
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          _a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          if (!sphereClear(this.terrain, _a.x, _a.y, _a.z, 0.04)) return false;
        }
      }
    }
    for (const arm of this.arms) {
      _a.copy(arm.rootLocal).applyMatrix4(this.root.matrixWorld);
      const r = Math.max(...arm.chain.r) + 0.04 + arm.chain.seg * 0.125;
      if (!sphereClear(this.terrain, _a.x, _a.y, _a.z, r)) return false;
    }
    for (const limb of [...this.feelers, ...this.beard]) {
      this._headPoint(limb.rootLocal, limb.w, _a);
      const r = Math.max(...limb.chain.r) + 0.04 + limb.chain.seg * 0.125;
      if (!sphereClear(this.terrain, _a.x, _a.y, _a.z, r)) return false;
    }
    return true;
  }

  /** Head-space rest point to world; w blends from the rigid trunk (0) to the head (1) like the neck bend. */
  _headPoint(p, w, out) {
    _hp.copy(p).applyMatrix4(this.headLocal);
    return out.copy(p).lerp(_hp, w).applyMatrix4(this.root.matrixWorld);
  }

  _headDir(d, w, out) {
    _hp.copy(d).transformDirection(this.headLocal);
    return out.copy(d).lerp(_hp, w).transformDirection(this.root.matrixWorld);
  }

  _armRoot(a) {
    this.root.localToWorld(a.rootW.copy(a.rootLocal));
    a.outX = Math.sin(this.yaw + a.ang);
    a.outZ = Math.cos(this.yaw + a.ang);
  }

  _pickIdle(a) {
    const rw = a.rootW;
    let best = null, bestS = -Infinity;
    for (let tries = 0; tries < 40; tries++) {
      const c = this.drape[Math.floor(this.rand() * this.drape.length)];
      const dx = c.x - rw.x, dz = c.z - rw.z;
      const d = Math.hypot(dx, dz);
      if (d < 9 || d > a.chain.length * 0.78) continue;
      const cos = (dx * a.outX + dz * a.outZ) / d;
      if (cos < 0.45) continue;
      _a.set(c.x, c.deck ? DECK_Y + 0.5 : -0.6, c.z);
      if (!this._armPoseClear(a, _a, 3.5, 1)) continue;
      const s = cos + this.rand() * 0.3;
      if (s > bestS) { bestS = s; best = c; }
    }
    if (best) {
      a.idleGoal.set(best.x, best.deck ? DECK_Y + 0.5 : -0.6, best.z);
    } else {
      // Keep the last reachable tip if the arm faces a wall; never invent a point beyond it.
      a.chain.tip(a.idleGoal);
      for (let reach = 10; reach >= 2; reach -= 2) {
        _a.set(rw.x + a.outX * reach, Math.min(-0.6, rw.y), rw.z + a.outZ * reach);
        if (this._armPoseClear(a, _a, 3.5, 1)) { a.idleGoal.copy(_a); break; }
      }
    }
    a.idleT = 7 + this.rand() * 7;
  }

  _armPose(a, goal, h1, h2) {
    const rw = a.rootW, c = a.chain;
    const spare = Math.max(0, c.length * 0.96 - rw.distanceTo(goal));
    h1 = Math.sign(h1) * Math.min(Math.abs(h1), spare * 0.55 + 1);
    h2 = Math.min(h2, spare * 0.45 + 0.5);
    const dx = goal.x - rw.x, dz = goal.z - rw.z, dl = Math.hypot(dx, dz) || 1;
    _p0.copy(rw);
    _p1.set(rw.x + a.outX * 3, rw.y + h1, rw.z + a.outZ * 3);
    _p2.set(goal.x - dx / dl * 2, goal.y + h2, goal.z - dz / dl * 2);
    _p3.copy(goal);
    poseAlong(c, a.targets, _p0, _p1, _p2, _p3);
  }

  _armPoseClear(a, goal, h1, h2) {
    this._armPose(a, goal, h1, h2);
    const p = a.targets, c = a.chain;
    // An unreachable endpoint or a blocked curve cannot be an idle/attack destination.
    if (Math.hypot(p[p.length - 3] - goal.x, p[p.length - 2] - goal.y, p[p.length - 1] - goal.z) > 0.1) return false;
    for (let i = 1; i < c.n; i++) {
      const b = i * 3, prev = b - 3;
      if (sphereTravel(this.terrain, p[prev], p[prev + 1], p[prev + 2], p[b], p[b + 1], p[b + 2], c.r[i - 1] + 0.1 + c.seg * 0.125) < 1) return false;
    }
    return true;
  }

  _updateArm(a, dt, t, player) {
    const c = a.chain;
    this._armRoot(a);
    a.t += dt;
    a.cool -= dt;
    const rw = a.rootW;
    const sleeping = this.state === 'dormant' || this.state === 'sinking';
    if (sleeping && a.mode !== 'sink') { a.mode = 'sink'; a.t = 0; }
    if (!sleeping && a.mode === 'sink' && rw.y > -8 && (this.state === 'watch' || this.t > RISE_TIME * 0.65 + a.k * 0.3)) {
      a.mode = 'idle';
      a.idleT = 0;
      c.tip(a.goal);
    }
    let h1 = 3.5, h2 = 1, rate = 2.2, wob = 0.35;
    const goal = a.goal;
    switch (a.mode) {
      case 'sink':
        // Trail inside the shaft during ascent, so submerged arms cannot hook its lower rim.
        goal.lerp(_a.set(rw.x + a.outX * 2, rw.y - c.length * 0.8, rw.z + a.outZ * 2), 1 - Math.exp(-dt * 2));
        h1 = -3; h2 = 1; rate = 1.2;
        break;
      case 'idle': {
        a.idleT -= dt;
        if (a.idleT <= 0) this._pickIdle(a);
        goal.lerp(a.idleGoal, 1 - Math.exp(-dt * 0.45));
        rate = 2.4;
        break;
      }
      case 'raise': {
        if (a.t < 1.5 * 0.6 && !this.caught) this._slamPoint(a.target, player.pos.x, player.pos.z);
        const dx = a.target.x - rw.x, dz = a.target.z - rw.z, dl = Math.hypot(dx, dz) || 1;
        _a.set(a.target.x - (dx / dl) * 3, a.target.y + 9, a.target.z - (dz / dl) * 3);
        goal.lerpVectors(a.strokeStart, _a, smooth(Math.min(1, a.t / 1.5)));
        h1 = 9; h2 = 2; rate = 5; wob = 0.35;
        a.surfT -= dt;
        if (a.surfT <= 0) { a.surfT = 0.28; this.water.addRipple(a.target.x, a.target.z, 0.9); }
        // A slow or obstructed arm must finish lifting before the downward stroke starts.
        if (a.t > 1.5 && c.tip(_b).distanceTo(goal) < 2) {
          a.mode = 'slam'; a.t = 0; a.strokeStart.copy(goal);
        } else if (a.t > 3.5) {
          a.mode = 'idle'; a.t = 0; a.cool = 2.6; a.idleT = 0;
        }
        break;
      }
      case 'slam':
        goal.lerpVectors(a.strokeStart, a.target, smooth(Math.min(1, a.t / 0.5)));
        h1 = 5; h2 = 1.2; rate = 18; wob = 0.1;
        if (a.t > 0.5) { a.mode = 'lie'; a.t = 0; }
        break;
      case 'lie':
        goal.copy(a.target);
        h1 = 5; h2 = 0.6; rate = 4; wob = 0.1;
        if (a.t > 1.3) {
          a.mode = 'idle';
          a.cool = 2.6 + this.rand() * 1.5;
          a.idleGoal.copy(a.target);
          a.idleT = 1.5;
        }
        break;
      default:
        break;
    }
    const bend = 1 - Math.exp(-dt * (a.mode === 'slam' ? 12 : 3));
    a.h1 += (h1 - a.h1) * bend;
    a.h2 += (h2 - a.h2) * bend;
    this._armPose(a, goal, a.h1, a.h2);
    let dx = goal.x - rw.x, dz = goal.z - rw.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    c.integrate(dt, 0.9, 0, -1.5, 0);
    const k = 1 - Math.exp(-rate * dt);
    const T = a.targets, nz = this.noise;
    for (let i = 1; i < c.n; i++) {
      const tt = i / (c.n - 1);
      const amp = (0.15 + 1.3 * tt * tt) * wob;
      const o = i * 3;
      const ox = (nz(i * 0.33 + a.seed, t * 0.33, 0.5) - 0.5) * 2 * amp;
      const oy = (nz(i * 0.33 + a.seed, t * 0.33, 9.5) - 0.5) * 1.4 * amp;
      const oz = (nz(i * 0.33 + a.seed, t * 0.33, 17.5) - 0.5) * 2 * amp;
      c.pull(i, T[o] + ox, T[o + 1] + oy, T[o + 2] + oz, k);
    }
    // Follow the curve's tangent, including the downward tangent of a sleeping arm.
    _a.fromArray(T, 3).sub(_b.fromArray(T)).multiplyScalar(1 / c.seg);
    c.constrain(rw.x, rw.y, rw.z, _a.x, _a.y, _a.z, 0.04, true);
    collideChain(this.terrain, c, true, a.mode === 'slam' || a.mode === 'lie' ? 28 : 12, true);
    if (a.mode === 'slam' || a.mode === 'lie') {
      if (!a.splashed && c.tip(_a).distanceTo(a.target) < 1.6) this._impact(a, player);
      if (!a.hit) this._checkHit(a, player);
    }
    c.frames(-dx, 0, -dz);
    this.armBundle.set(a.k, c);
  }

  _impact(a, player) {
    a.splashed = true;
    const tg = a.target;
    const onWater = tg.y < 0;
    if (onWater) {
      this.water.addRipple(tg.x, tg.z, 3);
      this.water.addRipple(tg.x + 1.5, tg.z - 1, 2);
      this.fx.bubbles.spawn(tg.x, -0.6, tg.z, 60, 2.4, 3);
    }
    this.audio.splash(1, { x: tg.x, y: 0, z: tg.z });
    const d = Math.hypot(player.pos.x - tg.x, player.pos.z - tg.z);
    player.shake = Math.max(player.shake, 1.3 - d / 26);
    this.events.push({ type: 'slam', x: tg.x, y: tg.y, z: tg.z, water: onWater });
  }

  _checkHit(a, player) {
    const c = a.chain, p = c.p;
    const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
    for (let i = Math.floor(c.n * 0.3); i < c.n; i++) {
      const o = i * 3;
      const r = c.r[i];
      const dx = p[o] - px, dz = p[o + 2] - pz;
      const dy = py - p[o + 1];
      if (dx * dx + dz * dz < (r + 1.25) ** 2 && dy > -(r + 1.2) && dy < r + 2.1) {
        if (!attackClear(this.level, _a.set(p[o], p[o + 1], p[o + 2]), player.pos)) continue;
        a.hit = true;
        this._catch(a);
        return;
      }
    }
  }

  _catch(a) {
    if (this.caught) return;
    this.caught = true;
    const maw = this.headMesh.localToWorld(this.mawLocal.clone());
    this.events.push({ type: 'catch' });
    this.voice.roar();
    if (this.onCatch) this.onCatch({ source: 'colossus', maw, grab: a.target.clone() });
  }

  /** Feelers and beard: loose chains that hang in air and drift in water. */
  _simHanging(list, bundle, dt, t, writhe, stiff) {
    const dt2 = dt * dt;
    const nz = this.noise;
    const travelling = this.state === 'rising' || this.state === 'sinking' || this.state === 'dormant';
    for (let k = 0; k < list.length; k++) {
      const f = list[k], c = f.chain;
      this._headPoint(f.rootLocal, f.w, _a);
      this._headDir(f.dirLocal, f.w, _b);
      c.integrate(dt, 0.93, 0, 0, 0);
      for (let i = 1; i < c.n; i++) {
        const o = i * 3;
        const tt = i / (c.n - 1);
        const w = writhe * (0.3 + tt);
        const s = k * 3.1 + i * 0.4;
        c.p[o] += (nz(s, t * 0.5, 0.5) - 0.5) * w * dt2 * 2;
        c.p[o + 1] += ((c.p[o + 1] < 0 ? 0.6 : -7) + (nz(s, t * 0.5, 7.5) - 0.5) * w) * dt2;
        c.p[o + 2] += (nz(s, t * 0.5, 13.5) - 0.5) * w * dt2 * 2;
        if (travelling) {
          // Gather the hanging limbs beneath their attachments before entering the
          // shaft; buoyant loose ends otherwise hook its rim and pin the whole head.
          const reach = i * c.seg;
          c.pull(i, _a.x, _a.y - reach * 0.85, _a.z, 1 - Math.exp(-dt * 2.5));
        }
      }
      if (travelling) _b.set(0, -1, 0);
      c.constrain(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, stiff, true);
      collideChain(this.terrain, c, true, 12, true);
      c.frames(_fwd.x, _fwd.y, _fwd.z);
      bundle.set(k, c);
    }
    bundle.upload();
  }

  _effects(dt, t, ctx) {
    const aw = Math.min(1, this.awareness);
    const rising = this.state === 'rising' ? Math.min(1, this.t / RISE_TIME) : this.state === 'watch' ? 1 : this.state === 'sinking' ? 1 - Math.min(1, this.t / SINK_TIME) : 0;
    const glow = 0.6 + rising * 1.2 + aw * 2.2;
    if (this.tripo) {
      // eyes open patch by patch as it surfaces
      this.eyeU.uEyeOpen.value = smooth((rising - 0.35) / 0.45) * 1.2 - 0.1;
      this.eyeU.uEyeGlow.value = glow * 0.3;
    } else {
      // eyes open one after another as it surfaces
      const n = this.headEyes.eyes.length;
      for (let i = 0; i < n; i++) this.headEyes.setOpen(i, rising > 0.35 + (i / n) * 0.45 ? 1 : 0.08);
      this.trunkEyes.setAllOpen(rising > 0.2 ? 1 : 0.3);
      const cam = ctx.camera.position;
      const look = this.state === 'watch' || (this.state === 'rising' && rising > 0.7);
      const focus = look ? Math.max(0.35, aw) : 0;
      const dilate = this.aggro ? 0.08 : 0.45 - aw * 0.3;
      this.headEyes.update(dt, look ? cam : null, focus, dilate, glow);
      this.trunkEyes.update(dt, look ? cam : null, focus * 0.7, dilate, glow * 0.8);
    }

    // amber eye light spilling over the face and the water in front of it
    this.headMesh.getWorldDirection(_c);
    this.lampK += ((rising > 0.3 ? 1 : 0) - this.lampK) * Math.min(1, dt * 0.6);
    const lamp = this.lamp;
    if (this.lampK > 0.01) {
      lamp.x = this.x + _c.x * 7.5;
      lamp.y = this.y + 1.5 + _c.y * 7.5;
      lamp.z = this.z + _c.z * 7.5;
      lamp.intensity = this.lampK * (2.2 + aw * 7) * (0.92 + 0.08 * Math.sin(t * 5.3));
    } else {
      lamp.y = -500;
    }
    // light probe follows the nearest baked light a little
    const tx = Math.floor(this.x / 2), tz = Math.floor(this.z / 2);
    const lum = this.lightGrid[tz * this.level.W + tx] || 0;
    this.probe.value.setRGB(0.012 + lum * 0.03, 0.016 + lum * 0.02, 0.02 + lum * 0.012);

    // water: breaching ripples, bubbles from below while rising, mist at the waterline
    this.rippleT -= dt;
    const nearSurface = this.y > -8;
    if (this.rippleT <= 0 && this.state !== 'dormant') {
      const busy = this.state === 'rising' || this.state === 'sinking';
      this.rippleT = busy ? 0.35 : 1.6;
      if (nearSurface) {
        const a = this.rand() * Math.PI * 2;
        const r = 5 + this.rand() * 3;
        this.water.addRipple(this.x + Math.cos(a) * r, this.z + Math.sin(a) * r, busy ? 1.6 : 0.6);
      }
      if (busy) this.fx.bubbles.spawn(this.x + (this.rand() - 0.5) * 10, Math.min(-1, this.y + 4), this.z + (this.rand() - 0.5) * 10, 30, 3, 2.5);
    }
    const mu = this.mist.material.uniforms;
    mu.uCenter.value.set(this.x, 0, this.z);
    mu.uMist.value = smooth((this.y + 6) / 8) * (0.7 + 0.3 * aw);

    this.voice.setPosition(this.x, this.state === 'dormant' ? -400 : this.y, this.z);
    this.voice.setSpeed(this.state === 'rising' || this.state === 'sinking' ? 0.8 : this.aggro ? 0.6 : 0.15);
    this.voice.update(dt);
  }
}
