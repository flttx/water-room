import * as THREE from 'three';

// Procedural driver for the skeletons of the rigged Tripo models (see tripo.js loadRiggedModels).
// The glTF scene sits in `root`, scaled to metres; poses are written in model space (glTF units, y up),
// which is the root's local space. Each frame: begin() puts every bone back in its rest pose, the creature
// then bends bones (FK, rotations in model axes) or drives them (absolute model-space placement: spines laid
// along curves, two-bone leg IK), and pose() resolves the hierarchy into bone locals for GPU skinning.

const _m = new THREE.Matrix4();
const _basis = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _C = new THREE.Vector3();
const _T = new THREE.Vector3();
const _N = new THREE.Vector3();
const _B = new THREE.Vector3();
const _Z = new THREE.Vector3();
const _u = new THREE.Vector3();
const _p = new THREE.Vector3();
const _K = new THREE.Vector3();
const _Tc = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _e3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Orthonormal frame from a main direction a and a second direction b in the same plane. */
function planeFrame(a, b, out) {
  _e1.copy(a).normalize();
  _e2.copy(b).addScaledVector(_e1, -b.dot(_e1)).normalize();
  _e3.crossVectors(_e1, _e2);
  return out.makeBasis(_e1, _e2, _e3);
}

export class Rig {
  /** model: { scene, mesh } from loadRiggedModels; scale: metres per model unit. */
  constructor(model, scale) {
    this.root = new THREE.Group();
    this.root.scale.setScalar(scale);
    this.root.add(model.scene);
    this.mesh = model.mesh;
    // the bounding sphere is the rest pose; the posed body can be far from it
    this.mesh.frustumCulled = false;
    this.nodes = [];
    this.parent = [];
    const index = new Map();
    model.scene.traverse((o) => {
      if (o === model.scene || o.isMesh) return;
      this.parent.push(index.has(o.parent) ? index.get(o.parent) : -1);
      index.set(o, this.nodes.length);
      this.nodes.push(o);
    });
    this.names = new Map(this.nodes.map((o, i) => [o.name, i]));
    this.restPos = [];
    this.restQuat = [];
    this.restScale = [];
    this.restModel = [];
    this.restInv = [];
    this.restRot = [];
    this.restRotInv = [];
    this.restModelScale = [];
    this.cur = [];
    this.target = [];
    this.driven = new Uint8Array(this.nodes.length);
    this.nodes.forEach((o, i) => {
      this.restPos.push(o.position.clone());
      this.restQuat.push(o.quaternion.clone());
      this.restScale.push(o.scale.clone());
      const local = new THREE.Matrix4().compose(o.position, o.quaternion, o.scale);
      const p = this.parent[i];
      const m = p < 0 ? local : new THREE.Matrix4().multiplyMatrices(this.restModel[p], local);
      const rot = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      m.decompose(_v, rot, sc);
      this.restModel.push(m);
      this.restInv.push(m.clone().invert());
      this.restRot.push(rot);
      this.restRotInv.push(rot.clone().invert());
      this.restModelScale.push(sc);
      this.cur.push(m.clone());
      this.target.push(new THREE.Matrix4());
    });
    this.rootInv = new THREE.Matrix4();
    this.rootInvQ = new THREE.Quaternion();
  }

  get scale() { return this.root.scale.x; }

  /** Index of a bone by its Tripo name ('Head_0', 'bone_12'); GLTFLoader drops the "tripo::" prefix's colons. */
  bone(name) {
    const i = this.names.get(`tripo${name}`) ?? this.names.get(name);
    if (i === undefined) throw new Error(`rig has no bone ${name}`);
    return i;
  }

  /** Rest-pose model-space position of a bone head. */
  restHead(i, out = new THREE.Vector3()) { return out.setFromMatrixPosition(this.restModel[i]); }

  /** Is bone i (strictly) below bone a in the hierarchy? */
  under(i, a) {
    for (let p = this.parent[i]; p >= 0; p = this.parent[p]) if (p === a) return true;
    return false;
  }

  /** Put every bone back in its rest pose and refresh the root transform. Call once per frame first. */
  begin() {
    this.nodes.forEach((o, i) => {
      o.position.copy(this.restPos[i]);
      o.quaternion.copy(this.restQuat[i]);
      o.scale.copy(this.restScale[i]);
    });
    this.driven.fill(0);
    this.root.updateMatrix();
    this.rootInv.copy(this.root.matrix).invert();
    this.rootInvQ.copy(this.root.quaternion).invert();
  }

  /** Rotate bone i about its head by q, expressed in model axes as seen in the rest pose (FK). */
  bend(i, q) {
    _q.copy(this.restRotInv[i]).multiply(q).multiply(this.restRot[i]);
    this.nodes[i].quaternion.multiply(_q);
  }

  /** Place bone i at a model-space position and rotation; its children follow unless driven themselves. */
  drive(i, pos, quat) {
    this.target[i].compose(pos, quat, this.restModelScale[i]);
    this.driven[i] = 1;
  }

  /** Resolve the hierarchy: driven bones get their locals from the parent's current pose. */
  pose() {
    const n = this.nodes.length;
    for (let i = 0; i < n; i++) {
      const o = this.nodes[i], p = this.parent[i], cur = this.cur[i];
      if (this.driven[i]) {
        cur.copy(this.target[i]);
        if (p < 0) _m.copy(cur);
        else _m.copy(this.cur[p]).invert().multiply(cur);
        _m.decompose(o.position, o.quaternion, o.scale);
      } else {
        _m.compose(o.position, o.quaternion, o.scale);
        if (p < 0) cur.copy(_m);
        else cur.multiplyMatrices(this.cur[p], _m);
      }
    }
  }

  /** A rest-pose model point carried by bone i, in world space after pose(). */
  toWorld(i, p, out) {
    return out.copy(p).applyMatrix4(this.restInv[i]).applyMatrix4(this.cur[i]).applyMatrix4(this.root.matrix);
  }

  /** World position of bone i's head after pose(). */
  headWorld(i, out) { return out.setFromMatrixPosition(this.cur[i]).applyMatrix4(this.root.matrix); }

  /**
   * Lay bones along a world-space curve, like a spine. The body runs along model -z from zHead;
   * axisY is the model height of the body axis. For each bone, s = arc length from the head in metres
   * (clamped to sRigid so the skull stays rigid); frame(s, C, T, N) writes the curve point, the tangent
   * toward the tail and the up normal. Every vertex then maps as C(s) + D(s)·scale·(v - axis(s)).
   */
  spine(bones, frame, zHead, axisY, sRigid = 0) {
    const S = this.scale;
    for (const i of bones) {
      _v.setFromMatrixPosition(this.restModel[i]);
      const s = Math.max(sRigid, (zHead - _v.z) * S);
      frame(s, _C, _T, _N);
      _T.normalize();
      _N.addScaledVector(_T, -_N.dot(_T)).normalize();
      _B.crossVectors(_T, _N);
      _basis.makeBasis(_B, _N, _Z.copy(_T).negate());
      _q.setFromRotationMatrix(_basis);
      _s.set(_v.x, _v.y - axisY, _v.z - (zHead - s / S)).applyQuaternion(_q);
      _p.copy(_C).addScaledVector(_s, S).applyMatrix4(this.rootInv);
      _q2.copy(this.rootInvQ).multiply(_q).multiply(this.restRot[i]);
      this.drive(i, _p, _q2);
    }
  }

  /**
   * Two-bone leg: hip and knee bones (bones between them and below the knee keep their rest locals, so the
   * thigh and the shin are rigid) and the rest-pose foot tip in model space. The hip's ancestors must stay
   * in their rest pose. The joints turn about the bone heads unless hipAt / kneeAt give other rest-pose
   * pivots (for a limb skinned onto bones that do not sit at its joints).
   */
  leg(hip, knee, tip, hipAt = null, kneeAt = null) {
    const H0 = hipAt ? hipAt.clone() : this.restHead(hip), K0 = kneeAt ? kneeAt.clone() : this.restHead(knee);
    const u0 = tip.clone().sub(H0).normalize();
    const thigh = K0.clone().sub(H0);
    return {
      hip, knee, H0, K0, T0: tip.clone(),
      a: thigh.length(), b: tip.distanceTo(K0),
      u0,
      pole0: thigh.clone().addScaledVector(u0, -thigh.dot(u0)).normalize(),
      shin0: tip.clone().sub(K0),
      F0t: planeFrame(thigh, tip.clone().sub(H0), new THREE.Matrix4()).transpose(),
      hipOff: this.restHead(hip).sub(H0),
      kneeOff: this.restHead(knee).sub(K0),
    };
  }

  /** Solve a leg so its foot tip reaches T (model space); lift pulls the knee upward. Returns the reach used (0..1). */
  reach(leg, T, lift = 0.4) {
    const { a, b, H0 } = leg;
    _u.subVectors(T, H0);
    const d0 = _u.length();
    _u.divideScalar(d0 || 1);
    const d = Math.min(Math.max(d0, Math.abs(a - b) + 1e-4), (a + b) * 0.999);
    // knee pole: the rest pole carried along with the leg direction, pulled upward
    _q.setFromUnitVectors(leg.u0, _u);
    _p.copy(leg.pole0).applyQuaternion(_q).addScaledVector(UP, lift);
    _p.addScaledVector(_u, -_p.dot(_u)).normalize();
    const x = (a * a - b * b + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    _K.copy(H0).addScaledVector(_u, x).addScaledVector(_p, h);
    _Tc.copy(H0).addScaledVector(_u, d);
    // hip: the rest (thigh, leg plane) frame onto the solved one
    planeFrame(_v.subVectors(_K, H0), _s.subVectors(_Tc, H0), _basis).multiply(leg.F0t);
    _q.setFromRotationMatrix(_basis);
    _q2.copy(_q).multiply(this.restRot[leg.hip]);
    this.drive(leg.hip, _v.copy(leg.hipOff).applyQuaternion(_q).add(H0), _q2);
    // knee: swing the carried shin onto the knee-to-foot direction
    _v.copy(leg.shin0).applyQuaternion(_q).normalize();
    _s.subVectors(_Tc, _K).normalize();
    _q2.setFromUnitVectors(_v, _s).multiply(_q);
    _v.copy(leg.kneeOff).applyQuaternion(_q2).add(_K);
    _q2.multiply(this.restRot[leg.knee]);
    this.drive(leg.knee, _v, _q2);
    return d0 / (a + b);
  }

  /** Lowest rest vertex skinned mostly to bone i (a foot tip), in model space. */
  lowestVertex(i) {
    const g = this.mesh.geometry, pos = g.attributes.position;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const bones = this.mesh.skeleton.bones;
    const out = new THREE.Vector3(0, Infinity, 0);
    for (let v = 0; v < pos.count; v++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k);
        if (w > bw) { bw = w; best = si.getComponent(v, k); }
      }
      if (bones[best] !== this.nodes[i]) continue;
      const y = pos.getY(v);
      if (y < out.y) out.set(pos.getX(v), y, pos.getZ(v));
    }
    if (out.y === Infinity) this.restHead(i, out);
    return out;
  }
}

/**
 * Frame on a Chain (flesh.js) at arc length s from point 0, for Rig.spine: position, tangent toward the
 * chain's end and interpolated normal. Beyond the ends the chain is extended straight.
 */
export function chainFrame(chain, s, C, T, N) {
  const { p, nrm, n, seg } = chain;
  const f = s / seg;
  const i = Math.min(n - 2, Math.max(0, Math.floor(f)));
  const k = f - i;
  const a = i * 3, b = a + 3;
  T.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
  C.set(p[a], p[a + 1], p[a + 2]).addScaledVector(T, k);
  const kk = Math.min(1, Math.max(0, k));
  N.set(nrm[a] + (nrm[b] - nrm[a]) * kk, nrm[a + 1] + (nrm[b + 1] - nrm[a + 1]) * kk, nrm[a + 2] + (nrm[b + 2] - nrm[a + 2]) * kk);
}
