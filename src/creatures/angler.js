import * as THREE from 'three';
import { GlowPoints } from './glow.js';
import { modelSkin, disposeModelSkin } from './tripo.js';
import { Rig } from './rig.js';
import { attackClear } from './collision.js';
import { RigSurface } from './rig-collision.js';
import { mulberry32 } from '../render/textures.js';

// A thirteen-metre anglerfish lying on the silt of the reservoir basin under the east catwalk, its lure hanging
// in the black like a lamp someone forgot. It does not hunt: it waits. Rush past it or crash into the water
// near it and it strikes, jaw first; slip by slowly and it never moves. After a strike its light goes out for
// a while. The body is the rigged Tripo model (public/models/angler.glb, mouth at +z, up +y), posed by FK.

const S = 13;
const LURE_TIP = new THREE.Vector3(0, 0.49, 0.462);
const MOUTH = new THREE.Vector3(0, 0.33, 0.4);
const LURE_COL = [0.6, 0.95, 1.0];
const R_FAST = 10;
const R_SLOW = 6;
const R_LOUD = 12;
const TELEGRAPH = 1.2;
const LUNGE_T = 0.55;
const REACH = 8;
const CATCH_R = 3.5;
const DARK_T = 25;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Angler {
  constructor({ scene, level, lampSys, audio, fx, model }) {
    this.level = level;
    this.audio = audio;
    this.fx = fx;
    this.rand = mulberry32(1313);
    this.events = [];
    this.onCatch = null;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const [tx, tz] = level.reservoir.angler;
    const [cx, cz] = level.worldCenter(tx, tz);
    this.home = new THREE.Vector3(cx, level.floor(tx, tz) + 0.15, cz);
    this.homeYaw = Math.PI; // facing north, at the gap in the east catwalk

    this.probe = { value: new THREE.Color(0.004, 0.008, 0.01) };
    this.rim = { value: new THREE.Color(0.004, 0.01, 0.012) };
    const rig = new Rig(model, S);
    this.rig = rig;
    this.bodyMat = modelSkin(model.mesh.material, { key: 'angler', probe: this.probe, rim: this.rim, tint: [0.7, 0.7, 0.7], roughness: 0.35 });
    model.mesh.material = this.bodyMat;
    this.group.add(rig.root);
    const b = (n) => rig.bone(n);
    this.jaw = b('Head_0');
    this.lure = [b('bone_4'), b('bone_5'), b('bone_6')];
    this.finR = [b('bone_7'), b('bone_8')];
    this.finL = [b('bone_10'), b('bone_11')];
    this.dorsal = b('bone_9');
    this.head = b('bone_2');
    this.tail = [b('Spine_1'), b('Tail_0'), b('Tail_1'), b('Tail_2')];
    this.caudal = [b('bone_17'), b('bone_19')];

    this.glow = new GlowPoints(3, { core: 1.2, halo: 0.6 });
    this.group.add(this.glow.points);
    this.lamp = lampSys.add({ type: 'creature', x: 0, y: -500, z: 0, color: LURE_COL, intensity: 0, range: 10 });
    this.mouth = new THREE.Vector3();
    this.lureW = new THREE.Vector3();
    this.from = new THREE.Vector3();
    this.to = new THREE.Vector3();
    this.off = new THREE.Vector3();
    this.surface = new RigSurface(rig);
    this.poseGuard = this.surface.guard(level);
    this.reset();
  }

  reset() {
    this.events.length = 0;
    this.state = 'idle';
    this.stateT = 0;
    this.gape = 0.06;
    this.light = 1;
    this.yaw = this.homeYaw;
    this.pitch = 0;
    this.off.set(0, 0, 0);
    this.caught = false;
    this.alarm = null;
    this._place();
    this.rig.begin();
    this.rig.pose();
    this.rig.toWorld(this.head, MOUTH, this.mouth);
    if (!this.poseGuard.reset()) throw new Error('angler resting pose does not fit terrain');
  }

  get chasing() { return this.state === 'tense' || this.state === 'lunge'; }

  get threat() {
    if (this.chasing) return 1;
    return this.nearK || 0;
  }

  get disturb() {
    if (this.state !== 'lunge' && this.state !== 'recover') return null;
    return { x: this.mouth.x, z: this.mouth.z, r: 14, amount: 0.5 };
  }

  /** A loud splash close to it sets it off, wherever the swimmer is. */
  hear(x, y, z, r, loud) {
    if ((!loud && r < 12) || this.state !== 'idle') return;
    if (Math.hypot(x - this.mouth.x, y - this.mouth.y, z - this.mouth.z) < Math.min(R_LOUD, r)) this.alarm = new THREE.Vector3(x, y, z);
  }

  update(dt, t, { player }) {
    this.events.length = 0;
    const p = player.pos;
    this.group.visible = Math.hypot(p.x - this.home.x, p.z - this.home.z) < 90;
    this.stateT += dt;
    const d = this.mouth.distanceTo(p);
    const wet = player.inWater && !player.frozen;
    this.nearK = wet ? clamp(1 - d / 18, 0, 1) * 0.45 : 0;

    switch (this.state) {
      case 'idle': {
        // only a swimmer in front of it counts
        _a.subVectors(p, this.mouth);
        const front = Math.sin(this.homeYaw) * _a.x + Math.cos(this.homeYaw) * _a.z > -2;
        const fast = player.sprint || player.speed > 2.4;
        const r = player.underwater ? R_SLOW : fast ? R_FAST : R_SLOW;
        if (wet && ((front && d < r) || this.alarm)) {
          this._setState('tense');
          this.events.push({ type: 'suspicious', source: 'angler' });
        }
        this.alarm = null;
        break;
      }
      case 'tense':
        // the light flutters and dies, the jaw drops: then it strikes where the swimmer is now
        if (this.stateT > TELEGRAPH) {
          if (!wet) { this._setState('recover'); break; }
          this._aim(p);
          this._setState('lunge');
          this.audio.lurkerSnap(this.mouth);
          this.events.push({ type: 'snap', source: 'angler', x: this.mouth.x, y: this.mouth.y, z: this.mouth.z });
        }
        break;
      case 'lunge':
        if (!this.caught && wet && d < CATCH_R) this._catch(player);
        if (this.stateT > LUNGE_T + 0.35) this._setState('recover');
        break;
      case 'recover':
        if (this.stateT > 3) this._setState('dark');
        break;
      case 'dark':
        if (this.stateT > DARK_T) this._setState('idle');
        break;
      default:
        break;
    }
    this._move(dt);
    this._place();
    this._pose(dt, t);
    this.poseGuard.constrain();
    this.off.copy(this.rig.root.position).sub(this.home);
    this.pitch = this.rig.root.rotation.x;
    this.yaw = this.rig.root.rotation.y;
    this.rig.toWorld(this.head, MOUTH, this.mouth);
    this.rig.toWorld(this.lure[2], LURE_TIP, this.lureW);
    this._effects(dt, t);
  }

  _setState(s) {
    this.state = s;
    this.stateT = 0;
    if (s === 'recover') this.from.copy(this.off);
    if (s === 'dark') this.caught = false;
  }

  /** Strike vector: from the resting mouth toward the swimmer, at most REACH long, within its field of view. */
  _aim(p) {
    this.from.copy(this.off);
    _a.subVectors(p, this.mouth).add(this.off);
    const yawTo = Math.atan2(_a.x, _a.z);
    const dy = wrapAngle(yawTo - this.homeYaw);
    this.aimYaw = this.homeYaw + clamp(dy, -0.7, 0.7);
    const l = _a.length();
    if (l > REACH) _a.multiplyScalar(REACH / l);
    this.to.copy(_a);
    this.to.y = Math.max(0, this.to.y);
  }

  _move(dt) {
    const T = this.stateT;
    let yawT = this.homeYaw, pitchT = 0;
    if (this.state === 'lunge') {
      const k = Math.min(1, T / LUNGE_T), e = 1 - Math.pow(1 - k, 3);
      this.off.lerpVectors(this.from, this.to, e);
      yawT = this.aimYaw;
      pitchT = -Math.atan2(this.to.y, Math.hypot(this.to.x, this.to.z) + 4) * 0.8;
    } else if (this.state === 'recover') {
      const k = Math.min(1, T / 3), e = k * k * (3 - 2 * k);
      this.off.lerpVectors(this.from, _b.set(0, 0, 0), e);
    }
    const rate = this.state === 'lunge' ? 6 : 1.2;
    this.yaw += wrapAngle(yawT - this.yaw) * Math.min(1, dt * rate);
    this.pitch += (pitchT - this.pitch) * Math.min(1, dt * rate);
    const gapeT = this.state === 'tense' ? 0.25 + 0.1 * Math.min(1, T / TELEGRAPH)
      : this.state === 'lunge' ? 0.95 : this.state === 'recover' ? 0.3 : 0.06;
    this.gape += (gapeT - this.gape) * Math.min(1, dt * (this.state === 'lunge' ? 14 : 2));
    // the lure: steady, fluttering before a strike, out after it
    const lightT = this.state === 'idle' ? 1 : this.state === 'tense' ? (T < TELEGRAPH * 0.7 ? 1 : 0) : this.state === 'dark' ? Math.max(0, (this.stateT - DARK_T + 3) / 3) : 0;
    this.light += (lightT - this.light) * Math.min(1, dt * 4);
  }

  _place() {
    const r = this.rig.root;
    r.position.copy(this.home).add(this.off);
    r.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  _pose(dt, t) {
    const rig = this.rig;
    const strike = this.state === 'lunge' ? 1 : 0;
    rig.begin();
    rig.bend(this.jaw, _q.setFromAxisAngle(X_AXIS, this.gape + 0.03 * Math.sin(t * 0.5)));
    rig.bend(this.head, _q.setFromAxisAngle(X_AXIS, -this.gape * 0.15));
    // the tail sways slowly, and thrashes through a strike
    const f = strike ? 7 : 0.9, amp = strike ? 2.5 : 1;
    this.tail.forEach((i, k) => rig.bend(i, _q.setFromAxisAngle(Y_AXIS, amp * (0.05 + 0.04 * k) * Math.sin(t * f - k * 0.7))));
    for (const i of this.caudal) rig.bend(i, _q.setFromAxisAngle(Y_AXIS, amp * 0.12 * Math.sin(t * f - 2.6)));
    // pectoral fins fan to hold it on the bottom
    const fan = 0.22 * Math.sin(t * 1.3) + strike * 0.5;
    rig.bend(this.finR[0], _q.setFromAxisAngle(Y_AXIS, fan).multiply(_q2.setFromAxisAngle(Z_AXIS, 0.08 * Math.sin(t * 1.3 + 1))));
    rig.bend(this.finL[0], _q.setFromAxisAngle(Y_AXIS, -fan).multiply(_q2.setFromAxisAngle(Z_AXIS, -0.08 * Math.sin(t * 1.3 + 1))));
    rig.bend(this.finR[1], _q.setFromAxisAngle(Y_AXIS, 0.3 * Math.sin(t * 1.3 - 0.8)));
    rig.bend(this.finL[1], _q.setFromAxisAngle(Y_AXIS, -0.3 * Math.sin(t * 1.3 - 0.8)));
    rig.bend(this.dorsal, _q.setFromAxisAngle(X_AXIS, 0.08 * Math.sin(t * 0.7)));
    // the lure bobs on its rod, twitching before the strike, folded back during it
    const tw = this.state === 'tense' ? 0.25 * Math.sin(t * 23) : 0;
    rig.bend(this.lure[0], _q.setFromAxisAngle(X_AXIS, 0.08 * Math.sin(t * 0.7) - strike * 0.5)
      .multiply(_q2.setFromAxisAngle(Y_AXIS, 0.12 * Math.sin(t * 0.45) + tw)));
    rig.bend(this.lure[1], _q.setFromAxisAngle(X_AXIS, 0.14 * Math.sin(t * 0.7 - 0.8) + tw));
    rig.bend(this.lure[2], _q.setFromAxisAngle(X_AXIS, 0.2 * Math.sin(t * 0.7 - 1.6)));
    rig.pose();
    rig.toWorld(this.head, MOUTH, this.mouth);
    rig.toWorld(this.lure[2], LURE_TIP, this.lureW);
  }

  _catch(player) {
    if (!attackClear(this.level, this.mouth, player.pos)) return;
    this.caught = true;
    this.events.push({ type: 'catch', source: 'angler' });
    if (this.onCatch) this.onCatch({ source: 'angler', maw: this.mouth.clone(), grab: player.pos.clone() });
  }

  _effects(dt, t) {
    const L = this.lureW;
    const flick = 0.85 + 0.15 * Math.sin(t * 5.3) * Math.sin(t * 2.1);
    const k = this.light * flick;
    if (this.group.visible && k > 0.01) {
      this.glow.set(0, L.x, L.y, L.z, LURE_COL[0] * 2 * k, LURE_COL[1] * 2 * k, LURE_COL[2] * 2 * k, 0.9);
      this.glow.set(1, L.x, L.y, L.z, LURE_COL[0] * 0.3 * k, LURE_COL[1] * 0.3 * k, LURE_COL[2] * 0.3 * k, 7);
      this.glow.upload(2);
      this.lamp.x = L.x;
      this.lamp.y = L.y;
      this.lamp.z = L.z;
      this.lamp.intensity = 1.3 * k;
    } else {
      this.glow.upload(0);
      this.lamp.y = -500;
      this.lamp.intensity = 0;
    }
    this.probe.value.setRGB(0.004 + 0.02 * k, 0.008 + 0.03 * k, 0.01 + 0.034 * k);
    if (this.state === 'lunge' && this.rand() < dt * 30) this.fx.bubbles.spawn(this.mouth.x, this.mouth.y, this.mouth.z, 6, 2, 1.6);
    else if (this.group.visible && this.rand() < dt * 0.25) this.fx.bubbles.spawn(this.mouth.x, this.mouth.y + 0.5, this.mouth.z, 3, 0.5, 0.8);
  }

  dispose() {
    this.group.removeFromParent();
    this.rig.mesh.geometry.dispose();
    this.rig.mesh.skeleton.dispose();
    disposeModelSkin(this.bodyMat);
    this.glow.dispose();
    this.lamp.y = -500;
    this.lamp.intensity = 0;
  }
}
