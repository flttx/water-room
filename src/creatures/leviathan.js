import * as THREE from 'three';
import { sculptBody, EyeSet, makeSkinMaterial, TentacleBundle, Chain, SPINE_GLSL } from './flesh.js';
import { GlowPoints } from './glow.js';
import { modelSkin, disposeModelSkin } from './tripo.js';
import { Rig, chainFrame } from './rig.js';
import { mulberry32 } from '../render/textures.js';

// Something sixty metres long that lives under the Abyss. It never comes up: it only passes far
// below, a slow river of cold lights and one pale eye, and the whole hall trembles while it does.

const N = 30;
const BODY_LEN = 60;
const SPEED = 8;
const PHOTO_COL = [0.25, 0.95, 0.85];
const EYE_COL = [1, 0.8, 0.45];

const SKIN = {
  colA: [0.032, 0.038, 0.036],
  colB: [0.01, 0.012, 0.012],
  colFold: [0.05, 0.03, 0.035],
  colVein: [0.07, 0.05, 0.06],
  colTop: [0.02, 0.024, 0.024],
  colInner: [0.2, 0.05, 0.05],
  colPale: [0.12, 0.13, 0.12],
  roughness: 0.3,
  bump: 1.2,
};

const MAW = { dir: [0, -0.3, 1], ru: 0.52, rv: 0.14, depth: 0.28, lip: 0.06 };
const HEAD_P = {
  seed: 404, radius: 2.8, stretch: [0.85, 0.72, 1.6], detail: 40, fold: 0.06, foldFreq: 3.8, pale: 0.45,
  maw: MAW,
  lumps: [
    { dir: [0, 1, 0.25], amp: 0.12, width: 0.3 },
    { dir: [0, -0.6, 0.8], amp: 0.1, width: 0.1 },
    { dir: [0.9, 0.2, 0.4], amp: 0.08, width: 0.06 },
    { dir: [-0.9, 0.2, 0.4], amp: 0.08, width: 0.06 },
  ],
  eyes: [
    { dir: [0.62, 0.25, 0.74], size: 0.12 },
    { dir: [-0.62, 0.25, 0.74], size: 0.12 },
    { dir: [0.48, 0.47, 0.74], size: 0.045 },
    { dir: [-0.48, 0.47, 0.74], size: 0.045 },
    { dir: [0.74, 0.04, 0.67], size: 0.04 },
    { dir: [-0.74, 0.04, 0.67], size: 0.04 },
  ],
};

// Tripo body (public/models/leviathan.glb: snout at z=0, tail at z=-BODY_LEN, up +y) bent along the chain
// in the vertex shader; the skull, the first HEAD_K chain segments, stays rigid.
const HEAD_K = 4;
const MODEL_EYES = [new THREE.Vector3(4.2, 0.6, -4.25), new THREE.Vector3(-4.2, 0.6, -4.25)];
const MODEL_VERT_DECL = `${SPINE_GLSL}
uniform float uBodyLen;
uniform float uHeadT;
varying vec3 vRest;
varying vec3 vRestN;
varying float vT;
`;
const MODEL_VERT = /* glsl */ `
vec3 sT, sN; float sLen;
float st = -position.z / uBodyLen;
float sh = clamp(st, uHeadT, 1.0);
vec4 sp = sp_eval(sh, 0.0, sT, sN, sLen);
vec3 sB = cross(sT, sN);
// model x, y, -z map to the spine frame's binormal, normal and tangent
vec3 objectNormal = normalize(sB * normal.x + sN * normal.y - sT * normal.z);
vec3 wr_tpos = sp.xyz + sT * (st - sh) * uBodyLen + sB * position.x + sN * position.y;
vRest = position;
vRestN = normal;
vT = st;
`;
const MODEL_FRAG_DECL = /* glsl */ `
uniform vec3 uPhotoCol;
uniform float uPhoto;
varying vec3 vRest;
varying vec3 vRestN;
varying float vT;
`;
// The pale spots painted along the upper flanks are photophores; waves of light run from head to tail.
const MODEL_PHOTO = /* glsl */ `
float photoK;
{
  vec3 c = sqrt(max(diffuseColor.rgb, vec3(0.0)));
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  photoK = smoothstep(0.42, 0.6, mx) * (1.0 - smoothstep(0.2, 0.4, (mx - mn) / max(mx, 1e-4)));
  photoK *= smoothstep(0.12, 0.16, vT) * smoothstep(-0.6, -0.1, vRest.y);
  float wave = max(0.0, sin(uTime * 1.6 - vT * ${((N - 1) * 0.45).toFixed(3)}));
  photoK *= 0.25 + 1.2 * wave * wave * wave;
}
`;
const MODEL_PHOTO_GLOW = 'totalEmissiveRadiance += uPhotoCol * photoK * uPhoto;';

// Rigged Tripo body (public/models/leviathan_rig.glb, model units, snout at +z): every bone is laid along the
// chain by Rig.spine and the GPU skins the mesh; the lower jaw (bone_18..21) hangs from the skull and gapes.
const RIG_S = 61;
const RIG_ZHEAD = 0.4913;
const RIG_AXIS = 0.075;
const RIG_RIGID = 7.5;
const RIG_EYES = [new THREE.Vector3(0.043, 0.092, 0.424), new THREE.Vector3(-0.043, 0.092, 0.424)];
const RIG_VERT_DECL = /* glsl */ `
uniform float uRigS;
uniform float uRigAxis;
uniform float uRigZHead;
varying vec3 vRest;
varying vec3 vRestN;
varying float vT;
`;
// the photophore shader expects metres from the body axis and t along the body, as on the unrigged model
const RIG_VERT = /* glsl */ `
vRest = (position - vec3(0.0, uRigAxis, 0.0)) * uRigS;
vRestN = normal;
vT = (uRigZHead - position.z) * uRigS / ${BODY_LEN.toFixed(1)};
`;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _qa = new THREE.Quaternion();

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Leviathan {
  constructor({ scene, level, lampSys, audio, water, fx, model = null, rigged = null }) {
    this.level = level;
    this.audio = audio;
    this.water = water;
    this.fx = fx;
    this.rand = mulberry32(606);
    this.events = [];
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.probe = { value: new THREE.Color(0.004, 0.008, 0.009) };
    this.rim = { value: new THREE.Color(0.004, 0.012, 0.012) };
    const skin = { ...SKIN, probe: this.probe, rim: this.rim };
    this.rig = null;
    this.tripo = !rigged && !!model;
    this.chain = new Chain(N, BODY_LEN, 2.3, 0.25, 1);
    this.photo = [];
    if (rigged) this._buildRig(rigged);
    else if (model) this._buildModel(model);
    else this._buildSculpted(skin);
    this.glow = new GlowPoints(this.photo.length * 2 + 4, { core: 1.1, halo: 0.45 });
    this.group.add(this.glow.points);
    this.lamp = lampSys.add({ type: 'creature', x: 0, y: -500, z: 0, color: [0.3, 0.8, 0.75], intensity: 0, range: 16 });
    this.headPos = new THREE.Vector3();
    this.reset();
  }

  _buildModel(model) {
    this.spine = new THREE.DataTexture(new Float32Array(N * 2 * 4), N, 2, THREE.RGBAFormat, THREE.FloatType);
    this.bodyMat = modelSkin(model.material, {
      key: 'leviathan', probe: this.probe, rim: this.rim, tint: [0.7, 0.7, 0.7], roughness: 0.45,
      uniforms: {
        uSpine: { value: this.spine }, uTN: { value: N }, uBodyLen: { value: BODY_LEN }, uHeadT: { value: HEAD_K / (N - 1) },
        uPhotoCol: { value: new THREE.Color(...PHOTO_COL) }, uPhoto: { value: 1.6 },
      },
      vertDecl: MODEL_VERT_DECL,
      vertReplace: { beginnormal_vertex: MODEL_VERT, begin_vertex: 'vec3 transformed = wr_tpos;' },
      fragDecl: MODEL_FRAG_DECL,
      albedo: MODEL_PHOTO,
      emissive: MODEL_PHOTO_GLOW,
    });
    this.bodyMesh = new THREE.Mesh(model.geometry, this.bodyMat);
    this.bodyMesh.frustumCulled = false;
    this.group.add(this.bodyMesh);
    this.eyeLocal = MODEL_EYES;
  }

  _buildRig(model) {
    const rig = new Rig(model, RIG_S);
    this.rig = rig;
    this.bodyMat = modelSkin(model.mesh.material, {
      key: 'leviathan-rig', probe: this.probe, rim: this.rim, tint: [0.7, 0.7, 0.7], roughness: 0.45,
      uniforms: {
        uRigS: { value: RIG_S }, uRigAxis: { value: RIG_AXIS }, uRigZHead: { value: RIG_ZHEAD },
        uPhotoCol: { value: new THREE.Color(...PHOTO_COL) }, uPhoto: { value: 1.6 },
      },
      vertDecl: RIG_VERT_DECL,
      vertTransform: RIG_VERT,
      fragDecl: MODEL_FRAG_DECL,
      albedo: MODEL_PHOTO,
      emissive: MODEL_PHOTO_GLOW,
    });
    model.mesh.material = this.bodyMat;
    this.group.add(rig.root);
    this.jaw = rig.bone('bone_18');
    this.skull = rig.bone('Head_0');
    this.spineBones = rig.nodes.map((_, i) => i).filter((i) => i !== this.jaw && !rig.under(i, this.jaw));
    this.chainAt = (s, C, T, Nn) => chainFrame(this.chain, s, C, T, Nn);
    this.gape = 0;
    this.eyeLocal = RIG_EYES;
  }

  _poseRig(dt, t) {
    const rig = this.rig;
    rig.begin();
    rig.spine(this.spineBones, this.chainAt, RIG_ZHEAD, RIG_AXIS, RIG_RIGID);
    // the jaw works slowly and hangs wide open while it passes close
    this.gape += ((this.near < 26 ? 1 : 0) - this.gape) * Math.min(1, dt * 0.8);
    rig.bend(this.jaw, _qa.setFromAxisAngle(X_AXIS, 0.1 + 0.07 * Math.sin(t * 0.6) + this.gape * 0.38));
    rig.pose();
    rig.toWorld(this.skull, _b.set(0, RIG_AXIS, RIG_ZHEAD - 3 / RIG_S), this.headPos);
  }

  _buildSculpted(skin) {
    this.head = sculptBody(HEAD_P);
    this.headMat = makeSkinMaterial({ ...skin, kind: 'body', scale: 0.6 });
    this.headMesh = new THREE.Mesh(this.head.geometry, this.headMat);
    this.headMesh.matrixAutoUpdate = false;
    this.group.add(this.headMesh);
    this.eyes = new EyeSet(this.headMesh, this.head.sockets, {
      iris: [0.95, 0.75, 0.4], irisAlt: [0.7, 0.8, 0.6], scleraAlt: [0.15, 0.16, 0.14],
      probe: this.probe, skin, rim: this.rim, seed: 31,
    });
    this.eyes.setAllOpen(1);
    this.backDist = -this.head.surface(new THREE.Vector3(0, 0, -1)).pos.z;
    this.eyeLocal = this.head.sockets.slice(0, 2).map((s) => s.pos.clone().addScaledVector(s.normal, s.radius * 0.8));

    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      this.chain.r[i] = 0.25 + 2.3 * (1 + 0.3 * Math.sin(Math.PI * Math.min(1, u * 2.2))) * Math.pow(1 - u, 0.85);
    }
    this.body = new TentacleBundle({ count: 1, points: N, segments: 150, radial: 22, suckers: null, skin: { ...skin, scale: 0.45, paleUnder: 0.7 } });
    this.group.add(this.body.group);

    for (let i = 2; i < N - 2; i++) {
      for (const a of [1.75, -1.75, Math.PI]) {
        if (a === Math.PI && i % 2) continue;
        this.photo.push({ i, a, ph: this.rand() * 6.28 });
      }
    }
  }

  reset() {
    this.active = false;
    this.wait = 14;
    this.passed = false;
    this.near = Infinity;
    this.events.length = 0;
    this.group.visible = false;
    this.lamp.y = -500;
    this.lamp.intensity = 0;
  }

  get threat() {
    if (!this.active) return 0;
    return 0.3;
  }

  get disturb() {
    if (!this.active || this.near > 36) return null;
    return { x: this.headPos.x, z: this.headPos.z, r: 28, amount: 0.55 * (1 - this.near / 36) };
  }

  _begin(p) {
    const A = this.level.abyss;
    const cx = (A.x0 + A.x1 + 1), cz = (A.z0 + A.z1 + 1);
    // aim beneath the player, across the hall at a random heading
    const mx = cx + (clamp(p.x, A.x0 * 2 + 6, A.x1 * 2 - 4) - cx) * 0.7;
    const mz = cz + (clamp(p.z, A.z0 * 2 + 6, A.z1 * 2 - 4) - cz) * 0.7;
    const th = this.rand() * Math.PI * 2;
    const dx = Math.sin(th), dz = Math.cos(th);
    const bend = (this.rand() < 0.5 ? -1 : 1) * (18 + this.rand() * 14);
    this.A = [mx - dx * 110, mz - dz * 110];
    this.B = [mx - dz * bend, mz + dx * bend];
    this.C = [mx + dx * 110, mz + dz * 110];
    this.len = 220;
    this.yEnd = -44;
    this.yMid = Math.min(-21, p.y - 11);
    this.u = -10;
    this.near = Infinity;
    this.passed = false;
    this.active = true;
    this.group.visible = true;
  }

  /** Point on the pass curve at arc distance u (extrapolated straight beyond both ends). */
  _path(u, out) {
    const L = this.len;
    const s = clamp(u, 0, L), q = s / L, v = 1 - q;
    const { A, B, C } = this;
    let x = v * v * A[0] + 2 * v * q * B[0] + q * q * C[0];
    let z = v * v * A[1] + 2 * v * q * B[1] + q * q * C[1];
    let tx = 2 * v * (B[0] - A[0]) + 2 * q * (C[0] - B[0]);
    let tz = 2 * v * (B[1] - A[1]) + 2 * q * (C[1] - B[1]);
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    x += tx * (u - s);
    z += tz * (u - s);
    const y = this.yEnd + (this.yMid - this.yEnd) * Math.pow(Math.sin(q * Math.PI), 0.6);
    out[0] = x; out[1] = y; out[2] = z; out[3] = tx; out[4] = tz;
    return out;
  }

  update(dt, t, { player, camera, calm = true }) {
    this.events.length = 0;
    const p = player.pos;
    if (!this.active) {
      const A = this.level.abyss;
      const inRegion = p.x > (A.x0 - 6) * 2 && p.x < (A.x1 + 7) * 2 && p.z > (A.z0 - 4) * 2 && p.z < (A.z1 + 6) * 2;
      if (inRegion) this.wait -= dt;
      if (this.wait <= 0 && calm && !player.frozen) this._begin(p);
      return;
    }

    this.u += SPEED * dt;
    const c = this.chain, pp = [0, 0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const ui = this.u - i * c.seg;
      this._path(ui, pp);
      const k = i / (N - 1);
      const amp = 0.3 + 2.4 * Math.pow(k, 1.4);
      const w = Math.sin(ui * 0.085 - t * 0.9) * amp;
      const o = i * 3;
      c.p[o] = pp[0] - pp[4] * w;
      c.p[o + 1] = pp[1] + Math.cos(ui * 0.06 - t * 0.5) * 0.4 * k;
      c.p[o + 2] = pp[2] + pp[3] * w;
    }
    c.frames(0, 1, 0);
    if (this.rig) {
      this._poseRig(dt, t);
    } else if (this.tripo) {
      this._writeSpine();
      this._headPoint(_b.set(0, 0, -3), this.headPos);
    } else {
      this.body.set(0, c);
      this.body.upload();

      // head: its back rests on the first body point, looking along the body
      c.point(0, _a);
      c.point(1, _b);
      _z.subVectors(_a, _b).normalize();
      _x.crossVectors(_y.set(0, 1, 0), _z).normalize();
      _y.crossVectors(_z, _x);
      _m.makeBasis(_x, _y, _z);
      this.headPos.copy(_a).addScaledVector(_z, this.backDist - 1.2);
      _m.setPosition(this.headPos);
      this.headMesh.matrix.copy(_m);
      this.headMesh.matrixWorldNeedsUpdate = true;
      this.headMesh.updateMatrixWorld(true);
    }

    const hd = Math.hypot(this.headPos.x - p.x, this.headPos.z - p.z);
    this.near = hd;
    if (!this.passed && hd < 22 && this.u > 0) {
      this.passed = true;
      this.audio.leviathanPass(this.headPos);
      player.shake = Math.max(player.shake, 0.3);
      this.water.addRipple(p.x, p.z, 1.1);
      this.events.push({ type: 'pass', source: 'leviathan', x: this.headPos.x, y: this.headPos.y, z: this.headPos.z });
    }
    if (this.passed && hd < 30 && this.rand() < dt * 0.6) this.water.addRipple(p.x + (this.rand() - 0.5) * 16, p.z + (this.rand() - 0.5) * 16, 0.5);
    if (this.rand() < dt * 0.5) this.fx.bubbles.spawn(this.headPos.x, this.headPos.y + 2, this.headPos.z, 12, 1.5, 2.2);

    if (this.eyes) this.eyes.update(dt, camera.position, 0.4, 0.3, 1.6);
    const glowK = 0.75 + 0.25 * Math.sin(t * 0.4);
    this.probe.value.setRGB(0.004 + 0.01 * glowK, 0.008 + 0.03 * glowK, 0.009 + 0.028 * glowK);
    this._lights(t);
    this.lamp.x = this.headPos.x;
    this.lamp.y = this.headPos.y + 2;
    this.lamp.z = this.headPos.z;
    this.lamp.intensity = 0.8 * glowK;

    if (this.u > this.len + BODY_LEN + 20) {
      this.active = false;
      this.group.visible = false;
      this.lamp.y = -500;
      this.lamp.intensity = 0;
      this.wait = 70 + this.rand() * 50;
    }
  }

  /** Spine texture in the TentacleBundle layout: row 0 position + radius, row 1 frame normal + length. */
  _writeSpine() {
    const c = this.chain, d = this.spine.image.data;
    for (let i = 0; i < N; i++) {
      const o = i * 4, q = (N + i) * 4;
      d[o] = c.p[i * 3]; d[o + 1] = c.p[i * 3 + 1]; d[o + 2] = c.p[i * 3 + 2]; d[o + 3] = c.r[i];
      d[q] = c.nrm[i * 3]; d[q + 1] = c.nrm[i * 3 + 1]; d[q + 2] = c.nrm[i * 3 + 2]; d[q + 3] = BODY_LEN;
    }
    this.spine.needsUpdate = true;
  }

  /** A rest-pose model point in the skull to world, the same way the vertex shader places it. */
  _headPoint(v, out) {
    const c = this.chain, p = c.p, o = HEAD_K * 3;
    const vx = v.x, vy = v.y, along = -v.z - HEAD_K * c.seg;
    _z.set(p[o + 3] - p[o - 3], p[o + 4] - p[o - 2], p[o + 5] - p[o - 1]).normalize();
    _y.set(c.nrm[o], c.nrm[o + 1], c.nrm[o + 2]);
    _x.crossVectors(_z, _y);
    return out.set(p[o], p[o + 1], p[o + 2]).addScaledVector(_z, along).addScaledVector(_x, vx).addScaledVector(_y, vy);
  }

  _lights(t) {
    const c = this.chain;
    let g = 0;
    for (const f of this.photo) {
      const o = f.i * 3;
      const tx0 = c.p[Math.min(N - 1, f.i + 1) * 3] - c.p[(f.i - 1) * 3];
      const ty0 = c.p[Math.min(N - 1, f.i + 1) * 3 + 1] - c.p[(f.i - 1) * 3 + 1];
      const tz0 = c.p[Math.min(N - 1, f.i + 1) * 3 + 2] - c.p[(f.i - 1) * 3 + 2];
      _z.set(tx0, ty0, tz0).normalize();
      _y.set(c.nrm[o], c.nrm[o + 1], c.nrm[o + 2]);
      _x.crossVectors(_y, _z);
      const r = c.r[f.i] * 0.97;
      const ca = Math.cos(f.a), sa = Math.sin(f.a);
      const x = c.p[o] + (_y.x * ca + _x.x * sa) * r;
      const y = c.p[o + 1] + (_y.y * ca + _x.y * sa) * r;
      const z = c.p[o + 2] + (_y.z * ca + _x.z * sa) * r;
      // waves of light run from head to tail
      const wave = Math.max(0, Math.sin(t * 1.6 - f.i * 0.45 + (f.a > 3 ? 1 : 0)));
      const k = (0.25 + 1.2 * wave * wave * wave) * (0.85 + 0.15 * Math.sin(t * 7 + f.ph));
      this.glow.set(g++, x, y, z, PHOTO_COL[0] * k, PHOTO_COL[1] * k, PHOTO_COL[2] * k, 0.55);
      const h = k * 0.12;
      this.glow.set(g++, x, y, z, PHOTO_COL[0] * h, PHOTO_COL[1] * h, PHOTO_COL[2] * h, 3.5);
    }
    for (const e of this.eyeLocal) {
      if (this.rig) this.rig.toWorld(this.skull, e, _a);
      else if (this.tripo) this._headPoint(e, _a);
      else _a.copy(e).applyMatrix4(this.headMesh.matrixWorld);
      this.glow.set(g++, _a.x, _a.y, _a.z, EYE_COL[0] * 1.6, EYE_COL[1] * 1.6, EYE_COL[2] * 1.6, 1.1);
      this.glow.set(g++, _a.x, _a.y, _a.z, EYE_COL[0] * 0.2, EYE_COL[1] * 0.2, EYE_COL[2] * 0.2, 6);
    }
    this.glow.upload(g);
  }

  dispose() {
    this.group.removeFromParent();
    if (this.rig) {
      this.rig.mesh.geometry.dispose();
      this.rig.mesh.skeleton.dispose();
      disposeModelSkin(this.bodyMat);
    } else if (this.tripo) {
      this.bodyMesh.geometry.dispose();
      disposeModelSkin(this.bodyMat);
      this.spine.dispose();
    } else {
      this.eyes.dispose();
      this.headMat.dispose();
      this.head.geometry.dispose();
      this.body.dispose();
    }
    this.glow.dispose();
    this.lamp.y = -500;
    this.lamp.intensity = 0;
  }
}
