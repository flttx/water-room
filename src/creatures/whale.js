import * as THREE from 'three';
import { Chain } from './flesh.js';
import { GlowPoints } from './glow.js';
import { modelSkin, disposeModelSkin } from './tripo.js';
import { Rig, chainFrame } from './rig.js';
import { mulberry32 } from '../render/textures.js';

// A dead whale that never stopped swimming. Twenty-eight metres of grey, peeling carcass circles the reservoir
// basin in a slow figure of eight, lit only by the things eating it. It is blind and hunts by ear: a splash turns
// it, and it rises under whatever made the noise. Its body is the rigged Tripo model (public/models/whale.glb,
// snout at +z, up +y): every spine bone is laid along the path its head has swum, the flippers row by FK.

const S = 29;
const Z_HEAD = 0.487;
const AXIS_Y = 0.1;
const RIGID = 6.5;
const N = 16;
const LEN = 28.5;
const TRAIL = 96;
const TRAIL_STEP = 0.4;
const MOUTH = new THREE.Vector3(0, 0.09, 0.455);
// body radius along the spine (metres), head to flukes
const PROFILE = [1.6, 2.4, 2.6, 2.5, 2.1, 1.6, 1.0, 0.6, 0.45];
const SPEED = { drift: 2.6, return: 3, suspicious: 3.2, hunt: 5.5, feed: 1.2 };
const TURN = { drift: 0.5, return: 0.55, suspicious: 0.6, hunt: 0.85, feed: 0.3 };
const CRUISE_Y = -6.3;
const Y_MIN = -7;
const Y_MAX = -1.8;
const LOOK = 8;
const CATCH_R = 4.2;
const GLOW_COL = [0.4, 1.0, 0.7];
const GLOWS = 26;

// Figure of eight through the basin (world metres): down the middle lane, round the west pillars, down the middle
// again and round the east ones. Kept about five metres off every pillar.
const ROUTE = [
  [262, 78], [262, 88], [255, 94], [244, 93], [239, 82], [241, 70], [250, 66], [258, 68.5],
  [262, 78], [262, 88], [269, 94], [282, 92], [286, 82], [284, 71], [276, 68], [266, 70],
];
const STEP = 0.5;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Closed Catmull-Rom through ROUTE, resampled every STEP metres of arc: Float32Array of x, z. */
function buildRoute() {
  const n = ROUTE.length, dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = ROUTE[(i - 1 + n) % n], p1 = ROUTE[i], p2 = ROUTE[(i + 1) % n], p3 = ROUTE[(i + 2) % n];
    for (let k = 0; k < 40; k++) {
      const t = k / 40, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const out = [];
  let carry = 0;
  for (let i = 0; i < dense.length; i++) {
    const [x0, z0] = dense[i], [x1, z1] = dense[(i + 1) % dense.length];
    const l = Math.hypot(x1 - x0, z1 - z0);
    for (let s = carry; s < l; s += STEP) out.push(x0 + (x1 - x0) * s / l, z0 + (z1 - z0) * s / l);
    carry = (carry - l) % STEP;
    if (carry < 0) carry += STEP;
  }
  return new Float32Array(out);
}

export class Whale {
  constructor({ scene, level, lampSys, audio, water, fx, model }) {
    this.level = level;
    this.audio = audio;
    this.water = water;
    this.fx = fx;
    this.rand = mulberry32(2929);
    this.events = [];
    this.onCatch = null;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.route = buildRoute();
    this.routeN = this.route.length / 2;
    this.routeLen = this.routeN * STEP;
    const [bx0, bz0, bx1, bz1] = level.reservoir.basin;
    this.box = [bx0 * 2, bz0 * 2, (bx1 + 1) * 2, (bz1 + 1) * 2];
    this.pillars = [];
    for (let z = bz0; z <= bz1; z++) {
      for (let x = bx0; x <= bx1; x++) if (level.ch(x, z) === 'P') this.pillars.push([x * 2, z * 2, x * 2 + 2, z * 2 + 2]);
    }

    this.probe = { value: new THREE.Color(0.006, 0.012, 0.012) };
    this.rim = { value: new THREE.Color(0.006, 0.014, 0.013) };
    const rig = new Rig(model, S);
    this.rig = rig;
    this.bodyMat = modelSkin(model.mesh.material, { key: 'whale', probe: this.probe, rim: this.rim, tint: [0.75, 0.75, 0.72], roughness: 0.55 });
    model.mesh.material = this.bodyMat;
    this.group.add(rig.root);
    this.skull = rig.bone('bone_11');
    this.flipR = [rig.bone('bone_12'), rig.bone('bone_14')];
    this.flipL = [rig.bone('bone_16'), rig.bone('bone_18')];
    this.spineBones = rig.nodes.map((_, i) => i)
      .filter((i) => i !== this.flipR[0] && i !== this.flipL[0] && !rig.under(i, this.flipR[0]) && !rig.under(i, this.flipL[0]));

    this.chain = new Chain(N, LEN, 2.6, 0.45, 1);
    for (let i = 0; i < N; i++) {
      const f = (i / (N - 1)) * (PROFILE.length - 1), j = Math.min(PROFILE.length - 2, Math.floor(f));
      this.chain.r[i] = PROFILE[j] + (PROFILE[j + 1] - PROFILE[j]) * (f - j);
    }
    this.chainAt = (s, C, T, Nn) => chainFrame(this.chain, s, C, T, Nn);
    this.trail = new Float32Array(TRAIL * 3);
    this._sampleGlows();
    this.glow = new GlowPoints(GLOWS * 2, { core: 1.0, halo: 0.5 });
    this.group.add(this.glow.points);
    this.lamp = lampSys.add({ type: 'creature', x: 0, y: -500, z: 0, color: [0.35, 0.9, 0.7], intensity: 0, range: 14 });
    this.voice = audio.createCreatureVoice('colossus');
    this.voice.setPosition(0, -400, 0);

    this.head = new THREE.Vector3();
    this.mouth = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.inited = false;
    this.reset(true);
  }

  /** Parasites: glowing spots on the back and flanks, each carried by the bone that skins its vertex. */
  _sampleGlows() {
    const rig = this.rig, g = rig.mesh.geometry;
    const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const bones = rig.mesh.skeleton.bones;
    this.glows = [];
    for (let tries = 0; tries < 4000 && this.glows.length < GLOWS; tries++) {
      const v = Math.floor(this.rand() * pos.count);
      const y = pos.getY(v), z = pos.getZ(v);
      if (y < AXIS_Y + 0.01 || z < -0.33 || z > 0.36) continue;
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k);
        if (w > bw) { bw = w; best = si.getComponent(v, k); }
      }
      const node = rig.nodes.indexOf(bones[best]);
      if (node < 0) continue;
      const p = new THREE.Vector3(pos.getX(v), y, z);
      if (this.glows.some((o) => o.p.distanceTo(p) < 0.03)) continue;
      this.glows.push({ node, p, ph: this.rand() * 6.28, sz: 0.25 + this.rand() * 0.35 });
    }
  }

  reset(full = true) {
    this.events.length = 0;
    this.awareness = 0;
    this.heardT = 99;
    this.stateT = 0;
    this.passCool = 8;
    this.callT = 12 + this.rand() * 10;
    this.caught = false;
    this.touchT = 0;
    this.nearK = 0;
    this.phase = 0;
    if (full || !this.inited) {
      this.inited = true;
      this.u = this.routeLen * 0.62;
      const [x, z, tx, tz] = this._pathAt(this.u, [0, 0, 0, 0]);
      this.head.set(x, CRUISE_Y, z);
      this.yaw = Math.atan2(tx, tz);
      for (let k = 0; k < TRAIL; k++) {
        const q = this._pathAt(this.u - (k + 1) * TRAIL_STEP, [0, 0, 0, 0]);
        this.trail.set([q[0], CRUISE_Y, q[1]], k * 3);
      }
      this.spd = SPEED.drift;
      this.state = 'drift';
    } else {
      this.u = this._nearestU(this.head.x, this.head.z, null);
      this.state = 'return';
    }
    this.voice.setState('patrol');
  }

  get chasing() { return this.state === 'hunt' || this.state === 'feed'; }

  get threat() {
    if (this.chasing) return 1;
    if (this.state === 'suspicious') return 0.5 + 0.3 * Math.min(1, this.awareness);
    return this.nearK * 0.35;
  }

  get disturb() {
    if (!this.group.visible || (!this.chasing && this.head.y < -4)) return null;
    return { x: this.head.x, z: this.head.z, r: 18, amount: 0.35 };
  }

  /** Horizontal distance from (x, z) to the whale's flank; the crab keeps out of its way. */
  clearance(x, z) {
    const c = this.chain;
    let best = Infinity;
    for (let i = 0; i < N; i++) best = Math.min(best, Math.hypot(c.p[i * 3] - x, c.p[i * 3 + 2] - z) - c.r[i]);
    return best;
  }

  /** It hears through water far better than through air. */
  hear(x, y, z, r, loud) {
    if (this.state === 'feed') return;
    const wet = y < 0.6 && this.level.isWater(Math.floor(x / 2), Math.floor(z / 2));
    const reach = r * (wet ? 1.8 : 0.7);
    const d = Math.hypot(x - this.head.x, (y - this.head.y) * 0.5, z - this.head.z);
    if (d > reach) return;
    this.awareness = Math.min(1.5, this.awareness + (loud ? 0.6 : 0.3) * (1 - (d / reach) * 0.6));
    this.focus.set(x, y, z);
    this.heardT = 0;
  }

  update(dt, t, { player }) {
    this.events.length = 0;
    const p = player.pos;
    const far = Math.hypot(p.x - this.head.x, p.z - this.head.z);
    this.group.visible = far < 110;
    this._think(dt, player);
    this._swim(dt, t);
    this._trailPush();
    this._layChain(dt);
    if (this.group.visible) this._pose(t);
    else this.rig.toWorld(this.skull, MOUTH, this.mouth);
    this._contact(dt, player);
    this._effects(dt, t, player);
  }

  // ------------------------------------------------------------------ behaviour

  _setState(s) {
    const prev = this.state;
    if (prev === s) return;
    this.state = s;
    this.stateT = 0;
    if (s === 'hunt') {
      this.events.push({ type: 'spotted', source: 'whale' });
      this.voice.roar();
    } else if (s === 'suspicious') {
      this.events.push({ type: 'suspicious', source: 'whale' });
      this.voice.click();
    } else if (s === 'return') {
      this.u = this._nearestU(this.head.x, this.head.z, null);
      if (prev === 'hunt') this.events.push({ type: 'lost', source: 'whale' });
    }
    this.voice.setState(s === 'hunt' || s === 'feed' ? 'chase' : s === 'suspicious' ? 'suspicious' : 'patrol');
  }

  _think(dt, player) {
    this.stateT += dt;
    this.heardT += dt;
    this.passCool -= dt;
    const aw = this.awareness;
    switch (this.state) {
      case 'drift':
      case 'return':
        this.awareness = Math.max(0, aw - dt * 0.08);
        if (aw >= 1) this._setState('hunt');
        else if (aw >= 0.3) this._setState('suspicious');
        else if (this.state === 'return' && this._offPath() < 3) this._setState('drift');
        break;
      case 'suspicious':
        this.awareness = Math.max(0, aw - dt * 0.08);
        if (aw >= 1) this._setState('hunt');
        else if (aw < 0.15) this._setState('return');
        else if (this.stateT > 16) { this.awareness *= 0.5; this._setState('return'); }
        break;
      case 'hunt': {
        const closeIn = Math.hypot(this.focus.x - this.head.x, this.focus.z - this.head.z) < 6;
        this.awareness = Math.max(0, aw - dt * (closeIn ? 0.25 : 0.05));
        if (this.heardT > 5 || (this.stateT > 14 && this.heardT > 3)) {
          this.awareness = 0.2;
          this._setState('return');
        }
        break;
      }
      case 'feed':
        if (this.stateT > 6) { this.caught = false; this.awareness = 0; this._setState('return'); }
        break;
      default:
        break;
    }
    if (player.frozen && this.state !== 'feed') this.awareness = Math.min(this.awareness, 0.2);
  }

  _swim(dt, t) {
    const h = this.head, st = this.state;
    let tx, tz, ty;
    if (st === 'suspicious' || st === 'hunt') {
      tx = this.focus.x;
      tz = this.focus.z;
      ty = st === 'hunt' ? this.focus.y - 1.2 : Math.min(-4, this.focus.y - 3);
    } else {
      this.u = this._nearestU(h.x, h.z, this.u);
      const q = this._pathAt(this.u + LOOK, [0, 0, 0, 0]);
      tx = q[0];
      tz = q[1];
      ty = CRUISE_Y + 0.5 * Math.sin(t * 0.09);
    }
    ty = clamp(ty, Y_MIN, Y_MAX);
    let wx = tx - h.x, wz = tz - h.z;
    const wl = Math.hypot(wx, wz) || 1;
    wx /= wl; wz /= wl;
    // pillars and basin walls push the heading away
    for (const [x0, z0, x1, z1] of this.pillars) {
      const cx = clamp(h.x, x0, x1), cz = clamp(h.z, z0, z1);
      const d = Math.hypot(h.x - cx, h.z - cz);
      if (d > 7 || d < 1e-3) continue;
      const k = ((7 - d) / 7) * 1.6;
      wx += ((h.x - cx) / d) * k;
      wz += ((h.z - cz) / d) * k;
    }
    const [X0, Z0, X1, Z1] = this.box;
    wx += Math.max(0, 7 - (h.x - X0)) * 0.25 - Math.max(0, 7 - (X1 - h.x)) * 0.25;
    wz += Math.max(0, 7 - (h.z - Z0)) * 0.25 - Math.max(0, 7 - (Z1 - h.z)) * 0.25;
    const want = Math.atan2(wx, wz);
    const rate = TURN[st];
    this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(want - this.yaw), -rate * dt, rate * dt));
    // slow down to turn hard
    const turn = Math.abs(wrapAngle(want - this.yaw));
    const target = SPEED[st] * (st === 'hunt' && wl < 5 ? 0.6 : 1) * (1 - Math.min(0.4, turn * 0.25));
    this.spd += (target - this.spd) * Math.min(1, dt * (st === 'hunt' ? 0.9 : 0.4));
    h.x = clamp(h.x + Math.sin(this.yaw) * this.spd * dt, X0 + 4.5, X1 - 4.5);
    h.z = clamp(h.z + Math.cos(this.yaw) * this.spd * dt, Z0 + 4.5, Z1 - 4.5);
    h.y += clamp((ty - h.y) * 0.6, -1.6, 1.6) * dt;
    this.phase += dt * (0.8 + this.spd * 0.22);
  }

  _trailPush() {
    const tr = this.trail, h = this.head;
    if (Math.hypot(h.x - tr[0], h.y - tr[1], h.z - tr[2]) < TRAIL_STEP) return;
    tr.copyWithin(3, 0, (TRAIL - 1) * 3);
    tr[0] = h.x; tr[1] = h.y; tr[2] = h.z;
  }

  /** Chain points every seg metres back along the swum path, with the flukes beating up and down. */
  _layChain() {
    const c = this.chain, tr = this.trail, seg = c.seg;
    let ax = this.head.x, ay = this.head.y, az = this.head.z;
    let s = 0, i = 0, dx = 0, dy = 0, dz = -1;
    for (let k = 0; k < TRAIL && i < N; k++) {
      const bx = tr[k * 3], by = tr[k * 3 + 1], bz = tr[k * 3 + 2];
      const l = Math.hypot(bx - ax, by - ay, bz - az);
      if (l > 1e-4) {
        dx = (bx - ax) / l; dy = (by - ay) / l; dz = (bz - az) / l;
        while (i < N && i * seg <= s + l) {
          const f = i * seg - s;
          c.p[i * 3] = ax + dx * f; c.p[i * 3 + 1] = ay + dy * f; c.p[i * 3 + 2] = az + dz * f;
          i++;
        }
        s += l;
      }
      ax = bx; ay = by; az = bz;
    }
    for (; i < N; i++) {
      const f = i * seg - s;
      c.p[i * 3] = ax + dx * f; c.p[i * 3 + 1] = ay + dy * f; c.p[i * 3 + 2] = az + dz * f;
    }
    for (let j = 0; j < N; j++) {
      const k = j / (N - 1);
      c.p[j * 3 + 1] += (0.1 + 1.0 * k * k) * Math.sin(this.phase - k * 2.4);
    }
    c.frames(0, 1, 0);
  }

  _pose(t) {
    const rig = this.rig;
    rig.begin();
    rig.spine(this.spineBones, this.chainAt, Z_HEAD, AXIS_Y, RIGID);
    // long flippers row slowly and sweep back as it speeds up
    const flap = 0.22 * Math.sin(t * 0.8) + (this.chasing ? 0.12 * Math.sin(t * 2.1) : 0);
    const sweep = 0.1 + this.spd * 0.06;
    const lag = 0.25 * Math.sin(t * 0.8 - 0.9);
    rig.bend(this.flipR[0], _q.setFromAxisAngle(Z_AXIS, flap).multiply(_q2.setFromAxisAngle(Y_AXIS, sweep)));
    rig.bend(this.flipL[0], _q.setFromAxisAngle(Z_AXIS, -flap).multiply(_q2.setFromAxisAngle(Y_AXIS, -sweep)));
    rig.bend(this.flipR[1], _q.setFromAxisAngle(Z_AXIS, lag));
    rig.bend(this.flipL[1], _q.setFromAxisAngle(Z_AXIS, -lag));
    rig.pose();
    rig.toWorld(this.skull, MOUTH, this.mouth);
  }

  /** The body shoves a swimmer aside; its open mouth takes one that lies in the way of a hunt. */
  _contact(dt, player) {
    const p = player.pos, c = this.chain;
    let dmin = Infinity;
    for (let i = 0; i < N; i++) {
      const o = i * 3;
      const dx = p.x - c.p[o], dy = p.y - c.p[o + 1], dz = p.z - c.p[o + 2];
      const dh = Math.hypot(dx, dz);
      dmin = Math.min(dmin, dh - c.r[i]);
      if (!player.inWater || player.frozen) continue;
      const d = Math.hypot(dx, dy, dz), r = c.r[i] + 0.45;
      if (d >= r || d < 1e-4) continue;
      const k = (r - d) / d;
      p.x += dx * k; p.y = Math.min(p.y + dy * k, 0.26); p.z += dz * k;
      player.vel.x += (dx / d) * 3 * dt; player.vel.z += (dz / d) * 3 * dt;
      player.shake = Math.max(player.shake, 0.35);
      // it feels you brush past
      this.touchT += dt;
      this.awareness = Math.min(1.5, this.awareness + dt * 1.5);
      this.focus.copy(p);
      this.heardT = 0;
    }
    this.nearK = player.inWater ? clamp(1 - dmin / 30, 0, 1) : 0;
    if (this.state === 'drift' && dmin < 10 && this.passCool <= 0) {
      this.passCool = 25;
      this.voice.call();
      this.events.push({ type: 'pass', source: 'whale', x: this.head.x, y: this.head.y, z: this.head.z });
    }
    if (this.caught || !player.inWater || player.frozen) return;
    if ((this.state === 'hunt' || this.state === 'suspicious') && this.mouth.distanceTo(p) < CATCH_R) this._catch(player);
  }

  _catch(player) {
    this.caught = true;
    this._setState('feed');
    this.events.push({ type: 'catch', source: 'whale' });
    this.voice.roar();
    if (this.onCatch) this.onCatch({ source: 'whale', maw: this.mouth.clone(), grab: player.pos.clone() });
  }

  _effects(dt, t, player) {
    const h = this.head;
    if (this.group.visible) {
      const rig = this.rig;
      let g = 0;
      for (const o of this.glows) {
        rig.toWorld(o.node, o.p, _a);
        const k = 0.45 + 0.55 * Math.max(0, Math.sin(t * 0.7 + o.ph)) ** 3;
        this.glow.set(g++, _a.x, _a.y, _a.z, GLOW_COL[0] * k * 1.4, GLOW_COL[1] * k * 1.4, GLOW_COL[2] * k * 1.4, o.sz);
        this.glow.set(g++, _a.x, _a.y, _a.z, GLOW_COL[0] * k * 0.12, GLOW_COL[1] * k * 0.12, GLOW_COL[2] * k * 0.12, o.sz * 9);
      }
      this.glow.upload(g);
      const pulse = 0.7 + 0.3 * Math.sin(t * 0.5);
      this.probe.value.setRGB(0.006 + 0.012 * pulse, 0.012 + 0.03 * pulse, 0.012 + 0.024 * pulse);
      rig.headWorld(this.skull, _b);
      this.lamp.x = _b.x;
      this.lamp.y = _b.y + 3;
      this.lamp.z = _b.z;
      this.lamp.intensity = 0.9 * pulse;
      if (this.rand() < dt * 0.5) this.fx.bubbles.spawn(_b.x, _b.y + 2.5, _b.z, 10, 1.4, 2);
      // near the surface its back drags the water
      if (h.y > -4 && this.rand() < dt * 3) {
        const i = Math.floor(this.rand() * N) * 3, c = this.chain.p;
        this.water.addRipple(c[i], c[i + 2], 0.5 + (h.y + 4) * 0.25);
      }
    } else {
      this.lamp.y = -500;
      this.lamp.intensity = 0;
    }
    this.callT -= dt;
    if (this.callT <= 0) {
      this.callT = 20 + this.rand() * 25;
      if (this.group.visible && !this.chasing) this.voice.call();
    }
    this.voice.setPosition(h.x, h.y, h.z);
    this.voice.setSpeed(this.spd / SPEED.hunt);
    this.voice.update(dt);
  }

  // ------------------------------------------------------------------ route

  /** Route point at arc distance u (wrapped): [x, z, tx, tz]. */
  _pathAt(u, out) {
    const M = this.routeN, r = this.route;
    const f = ((u % this.routeLen) + this.routeLen) % this.routeLen / STEP;
    const i = Math.floor(f) % M, j = (i + 1) % M, k = f - Math.floor(f);
    const x0 = r[i * 2], z0 = r[i * 2 + 1], x1 = r[j * 2], z1 = r[j * 2 + 1];
    const l = Math.hypot(x1 - x0, z1 - z0) || 1;
    out[0] = x0 + (x1 - x0) * k; out[1] = z0 + (z1 - z0) * k;
    out[2] = (x1 - x0) / l; out[3] = (z1 - z0) / l;
    return out;
  }

  /** Arc distance of the route point nearest (x, z): near hint (never far backwards), or anywhere. */
  _nearestU(x, z, hint) {
    const M = this.routeN, r = this.route;
    const from = hint === null ? 0 : Math.round(hint / STEP) - 8;
    const count = hint === null ? M : 40;
    let best = Infinity, bu = hint ?? 0;
    for (let n = 0; n < count; n++) {
      const i = (((from + n) % M) + M) % M;
      const d = (r[i * 2] - x) ** 2 + (r[i * 2 + 1] - z) ** 2;
      if (d < best) { best = d; bu = (from + n) * STEP; }
    }
    return hint === null ? bu : Math.max(bu, hint);
  }

  _offPath() {
    const q = this._pathAt(this.u, [0, 0, 0, 0]);
    return Math.hypot(q[0] - this.head.x, q[1] - this.head.z);
  }

  dispose() {
    this.group.removeFromParent();
    this.rig.mesh.geometry.dispose();
    this.rig.mesh.skeleton.dispose();
    disposeModelSkin(this.bodyMat);
    this.glow.dispose();
    this.voice.dispose();
    this.lamp.y = -500;
    this.lamp.intensity = 0;
  }
}
