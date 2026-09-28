import * as THREE from 'three';
import { sculptBody, EyeSet, buildTeeth, layoutEyes, makeSkinMaterial, TentacleBundle, Chain, makeNoise3, collideChain } from './flesh.js';
import { GlowPoints } from './glow.js';
import { attackClear, BodyCollider, PoseGuard, sphereClear } from './collision.js';
import { mulberry32 } from '../render/textures.js';
import { LURKERS, DRAIN_LURKER_PATROL } from '../level/mapdata.js';

// Lure-fish: blind ambushers lying in dark side pools and crawlways. A warm light bobs in front of a
// gaping mouth full of needles; anything that comes close, or makes noise nearby, is taken in one lunge.
// The drain entrance guard patrols between ambushes; the other fish stay near their lairs.

const LURE_COL = [1, 0.72, 0.38];
const REACH = 6;          // metres a lunge can carry the head away from its lair
const NEAR_R = 3.1;       // quiet approach distance (from the mouth) that triggers a lunge
const HEAR_R = 7.5;       // noises closer than this agitate it
const SUCK = 0.35;
const SURGE = 0.42;
const RETURN = 3;
const COOL = 6;
const SAFE_EYE_Y = 3.2;

const SKIN = {
  colA: [0.048, 0.043, 0.04],
  colB: [0.014, 0.013, 0.012],
  colFold: [0.085, 0.028, 0.034],
  colVein: [0.15, 0.04, 0.05],
  colTop: [0.03, 0.028, 0.026],
  colInner: [0.3, 0.04, 0.05],
  colPale: [0.17, 0.15, 0.13],
  roughness: 0.36,
  bump: 1.45,
};

const MAW = { dir: [0, -0.08, 1], ru: 0.62, rv: 0.46, depth: 0.55, lip: 0.1 };
function headParams(seed) {
  return {
    seed, radius: 1.5, stretch: [1.1, 0.92, 1.25], detail: 28, fold: 0.1, foldFreq: 4.6, pale: 0.15,
    maw: MAW,
    lumps: [
      { dir: [0, 0.9, -0.3], amp: 0.16, width: 0.3 },
      { dir: [0, -0.55, 0.85], amp: 0.18, width: 0.08 },
      { dir: [0.75, -0.2, 0.3], amp: 0.1, width: 0.1 },
      { dir: [-0.75, -0.2, 0.3], amp: 0.1, width: 0.1 },
      { dir: [0, 0, -1], amp: 0.35, width: 0.2 },
      { dir: [0, 0.62, 0.78], amp: 0.08, width: 0.04 },
    ],
    eyes: layoutEyes({
      seed: seed + 5,
      sizes: [0.075, 0.07, 0.05, 0.045, 0.04, 0.035],
      region: (d) => d.z > 0.25 && d.y > 0.3 && d.y < 0.72,
      maw: MAW,
    }),
  };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class Lurker {
  constructor(mgr, tx, tz, k, head) {
    const L = mgr.level;
    this.mgr = mgr;
    this.k = k;
    const rand = mulberry32(900 + k * 31);
    this.rand = rand;
    this.noise = makeNoise3(500 + k);
    const [hx, hz] = L.worldCenter(tx, tz);
    // squeezed into the low crawlways, bloated in the open pools
    const low = L.ceil(tx, tz) < 2;
    this.scale = low ? 0.72 : 0.95 + rand() * 0.25;
    this.home = new THREE.Vector3(hx, low ? -1.9 : -2.6 - rand() * 0.6, hz);
    this.patrol = tx === DRAIN_LURKER_PATROL.entrance[0] && tz === DRAIN_LURKER_PATROL.entrance[1]
      ? { entry: new THREE.Vector3(), inner: new THREE.Vector3(), anchor: this.home.clone(), next: 1, pause: 2 } : null;
    this.yaw0 = this._openYaw(tx, tz);
    this.yaw = this.yaw0;
    this.pos = this.home.clone();
    this.maw = new THREE.Vector3();
    this.bulb = new THREE.Vector3();
    this.probe = { value: new THREE.Color(0.01, 0.012, 0.014) };
    this.rim = { value: new THREE.Color(0.006, 0.014, 0.016) };
    const skin = { ...SKIN, probe: this.probe, rim: this.rim };

    this.group = new THREE.Group();
    mgr.scene.add(this.group);
    this.root = new THREE.Group();
    this.root.scale.setScalar(this.scale);
    this.group.add(this.root);
    this.head = head;
    this.headMat = makeSkinMaterial({ ...skin, kind: 'body', scale: 1.5 });
    this.headMesh = new THREE.Mesh(head.geometry, this.headMat);
    this.root.add(this.headMesh);
    this.eyes = new EyeSet(this.headMesh, head.sockets, {
      iris: [0.5, 0.58, 0.52], irisAlt: [0.62, 0.55, 0.4], scleraAlt: [0.2, 0.2, 0.18],
      probe: this.probe, skin, rim: this.rim, seed: 60 + k,
    });
    this.eyes.setAllOpen(0.6);
    this.teeth = buildTeeth(head, 40, 0.3, 1.1, this.probe, 70 + k);
    this.headMesh.add(this.teeth);
    this.mawLocal = head.surface(head.maw.d).pos.clone();
    this.stalkLocal = head.surface(new THREE.Vector3(0, 0.62, 0.78).normalize()).pos.clone();
    this.tailLocal = head.surface(new THREE.Vector3(0, 0.05, -1).normalize()).pos.clone().multiplyScalar(0.8);

    const s = this.scale;
    // tapering tail and a ragged fringe of filaments around the jaw
    this.tailBundle = new TentacleBundle({
      count: 1, points: 14, segments: 40, radial: 14, suckers: null,
      skin: { ...skin, scale: 1.3, paleUnder: 0.35 },
    });
    this.tail = new Chain(14, 5.5 * s, 0.85 * s, 0.05 * s, 0.6);
    this.group.add(this.tailBundle.group);
    this.fringeBundle = new TentacleBundle({
      count: 7, points: 10, segments: 18, radial: 6, suckers: null,
      skin: { ...skin, colA: [0.07, 0.05, 0.045], colTop: [0.09, 0.07, 0.06], scale: 2.4, paleUnder: 0.2 },
    });
    this.stalk = new Chain(10, 3.4 * s, 0.085 * s, 0.035 * s, 0.8);
    const dirs = [[0.5, -0.8, 0.35], [-0.5, -0.8, 0.35], [0.9, -0.3, -0.1], [-0.9, -0.3, -0.1], [0.55, -0.55, -0.6], [-0.55, -0.55, -0.6]];
    this.fringe = dirs.map((d) => {
      const sf = head.surface(new THREE.Vector3(...d).normalize());
      return {
        rootLocal: sf.pos.clone().addScaledVector(sf.normal, -0.05),
        dirLocal: sf.normal.clone(),
        chain: new Chain(10, (1.2 + rand() * 1.1) * s, 0.06 * s, 0.01 * s, 0.8),
      };
    });
    this.group.add(this.fringeBundle.group);

    this.lamp = mgr.lampSys.add({ type: 'creature', x: hx, y: -500, z: hz, color: LURE_COL, intensity: 0, range: 7 });
    this.bodyCollider = new BodyCollider(head.geometry, 0.12);
    this.poseGuard = new PoseGuard([this.root], () => this._bodyClear(), () => this.root.updateMatrixWorld(true), 3);
    this.reset();
  }

  /** Face the longest open run of water or walkway from the lair. */
  _openYaw(tx, tz) {
    const L = this.mgr.level;
    const [cx, cz] = L.worldCenter(tx, tz);
    let best = 0, bestD = -1;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const dx = Math.sin(a), dz = Math.cos(a);
      let d = 0;
      while (d < 16) {
        const x = cx + dx * (d + 0.5), z = cz + dz * (d + 0.5);
        if (L.solid(Math.floor(x / 2), Math.floor(z / 2))) break;
        d += 0.5;
      }
      if (d > bestD + 0.25) { bestD = d; best = a; }
    }
    return best;
  }

  reset() {
    this.state = 'wait';
    this.t = 0;
    this.cool = 0;
    this.agitation = 0;
    this.tension = 0;
    this.light = 1;
    this.flickT = 0;
    this.bubbleT = 2 + this.rand() * 4;
    this.caught = false;
    this.pos.copy(this.home);
    this.surgeFrom = this.home.clone();
    this.surgeDir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.pitch = 0;
    this.yaw = this.yaw0;
    this.homeYaw = this.yaw0;
    this.now = 0;
    this.initialised = false;
    this.limbsNear = false;
    this.poseGuard.ready = false;
    this._fitHome();
    if (this.patrol) {
      const [x, z] = DRAIN_LURKER_PATROL.innerWorld;
      this.patrol.inner.set(x, this.home.y, z);
      const [ex, ez] = DRAIN_LURKER_PATROL.entryWorld;
      this.patrol.entry.set(ex, this.home.y, ez);
      this.patrol.anchor.copy(this.home);
      this.patrol.next = 1;
      this.patrol.pause = 2;
    }
  }

  _bodyClear() {
    const level = this.mgr.level, m = this.headMesh.matrixWorld;
    if (!this.bodyCollider.clear(level, m)) return false;
    for (const [anchor, chain] of [[this.tailLocal, this.tail], [this.stalkLocal, this.stalk], ...this.fringe.map((f) => [f.rootLocal, f.chain])]) {
      _a.copy(anchor).applyMatrix4(m);
      if (!sphereClear(level, _a.x, _a.y, _a.z, Math.max(...chain.r) + 0.04 + chain.seg * 0.125)) return false;
    }
    return true;
  }

  _fitHome() {
    const L = this.mgr.level, base = this.home.clone(), original = this.scale;
    const chains = [this.tail, this.stalk, ...this.fringe.map((f) => f.chain)];
    let previousScale = 1;
    for (const k of [1, 0.9, 0.8, 0.7, 0.6]) {
      this.root.scale.setScalar(original * k);
      for (const c of chains) {
        const ratio = k / previousScale;
        c.length *= ratio; c.seg *= ratio;
        for (let i = 0; i < c.n; i++) c.r[i] *= ratio;
      }
      previousScale = k;
      for (let ring = 0; ring <= 6; ring++) for (let dz = -ring; dz <= ring; dz++) for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const x = base.x + dx * 0.5, z = base.z + dz * 0.5, tx = Math.floor(x / 2), tz = Math.floor(z / 2);
        if (!L.isWater(tx, tz) || L.solid(tx, tz)) continue;
        for (const y of [base.y, (L.floor(tx, tz) + Math.min(0, L.ceil(tx, tz))) / 2]) {
          this.pos.set(x, y, z); this._place(0);
          if (!this._bodyClear()) continue;
          this.home.copy(this.pos); this.scale = original * k;
          this.poseGuard.reset();
          return;
        }
      }
    }
    throw new Error(`lurker ${this.k} has no clear lair`);
  }

  hear(x, y, z, r, loud) {
    if (this.state !== 'wait' || this.cool > 0) return;
    const d = Math.hypot(x - this.maw.x, (y - this.maw.y) * 0.7, z - this.maw.z);
    if (d > Math.min(r, HEAR_R)) return;
    this.agitation += loud ? 1 : 0.35 * (1 - (d / HEAR_R) * 0.5);
  }

  _place(t) {
    const r = this.root;
    const sway = this.state === 'wait' ? 1 : 0.2;
    r.position.copy(this.pos);
    r.position.y += Math.sin(t * 0.6 + this.k) * 0.12 * sway;
    r.rotation.set(-this.pitch, this.yaw + Math.sin(t * 0.37 + this.k * 2) * 0.08 * sway, Math.sin(t * 0.45 + this.k) * 0.05 * sway, 'YXZ');
    r.updateMatrixWorld(true);
    if (this.poseGuard?.ready) {
      this.poseGuard.constrain();
      this.pos.copy(r.position);
      this.pos.y -= Math.sin(t * 0.6 + this.k) * 0.12 * sway;
      this.yaw = r.rotation.y - Math.sin(t * 0.37 + this.k * 2) * 0.08 * sway;
      this.pitch = -r.rotation.x;
    }
    this.headMesh.localToWorld(this.maw.copy(this.mawLocal));
  }

  update(dt, t, player, camera, near) {
    const p = player.pos;
    this.t += dt;
    this.cool -= dt;
    this.now = t;
    this.agitation = Math.max(0, this.agitation - dt * 0.5);
    if (!this.initialised) this._place(t);
    const dh = Math.hypot(p.x - this.maw.x, p.z - this.maw.z);
    const d3 = Math.hypot(p.x - this.maw.x, p.y - this.maw.y, p.z - this.maw.z);
    const origin = this.patrol ? this.pos : this.home;
    const reachable = !player.frozen && p.y < SAFE_EYE_Y && Math.hypot(p.x - origin.x, p.z - origin.z) < REACH * this.scale + 3.5;
    const tensionTarget = reachable ? clamp(1 - (dh - NEAR_R) / 7, 0, 1) : 0;
    this.tension += (tensionTarget - this.tension) * Math.min(1, dt * 2);

    if (this.state === 'wait') {
      this.pitch += (0 - this.pitch) * Math.min(1, dt * 2);
      if (!this.patrol) this.pos.lerp(this.home, Math.min(1, dt * 0.5));
      this.light += (1 - this.light) * Math.min(1, dt * 0.8);
      const close = (p.y > 0 ? dh : d3) < NEAR_R * (0.6 + 0.4 * this.scale) + 0.6;
      if (reachable && this.cool <= 0 && (close || this.agitation >= 1) && this._clearTo(player)) this._strike(player);
      else if (this.patrol) this._patrol(dt);
    } else if (this.state === 'suck') {
      this.light += (0 - this.light) * Math.min(1, dt * 14);
      this.pitch += (0.25 - this.pitch) * Math.min(1, dt * 8);
      if (this.t > SUCK) {
        this.state = 'surge';
        this.t = 0;
        this.surgeFrom.copy(this.pos);
        const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        this.surgeDir.set(dx / d, 0, dz / d);
        this.mgr.water.addRipple(this.pos.x, this.pos.z, 1.2);
      }
      this._turn(Math.atan2(p.x - this.pos.x, p.z - this.pos.z), dt, 6);
    } else if (this.state === 'surge') {
      this._surge(dt, player);
    } else if (this.state === 'return') {
      this.light += (0.9 - this.light) * Math.min(1, dt * 0.5);
      this.pitch += (0 - this.pitch) * Math.min(1, dt * 2);
      this.pos.lerp(this.patrol ? this.patrol.anchor : this.home, Math.min(1, dt * 1.2));
      this._turn(this.homeYaw, dt, 1.5);
      if (this.t > RETURN) {
        this.state = 'wait';
        this.t = 0;
        this.cool = COOL;
        this.agitation = 0;
      }
    } else if (this.state === 'feed') {
      this.light = 0;
    }
    if (this.state !== 'wait' && this.state !== 'feed' && this.state !== 'return') this.tension = 1;
    this._place(t);
    if (!this.initialised || (near && !this.limbsNear)) {
      // A distant patrol keeps moving while its limb simulation is culled.
      // Rebuild at the current body before showing it, discarding the old contact pose.
      this._resetChains();
      this.initialised = true;
    }
    this.limbsNear = near;
    if (near) this._simLimbs(dt, t);
    this._effects(dt, t, camera, near);
  }

  _patrol(dt) {
    const patrol = this.patrol;
    if (patrol.pause > 0) {
      patrol.pause = Math.max(0, patrol.pause - dt);
      if (patrol.next === 1) this._turn(this.yaw0, dt, 1.5);
      return;
    }
    const target = patrol.next === 1 ? patrol.inner : patrol.entry;
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.001) {
      this.pos.x = target.x;
      this.pos.z = target.z;
      patrol.pause = patrol.next === 1 ? 7 : 2;
      patrol.next = 1 - patrol.next;
      return;
    }
    const yaw = Math.atan2(dx, dz);
    this._turn(yaw, dt, 1.5);
    // Turn before advancing; _place sweeps the complete body through the terrain.
    const error = Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
    if (Math.abs(error) > 0.15) return;
    const step = Math.min(distance, 0.85 * dt);
    this.pos.x += dx / distance * step;
    this.pos.z += dz / distance * step;
  }

  _clearTo(player) {
    const p = player.pos, m = this.maw;
    const sy = p.y > 0 ? Math.min(0.7, this.mgr.level.ceil(Math.floor(m.x / 2), Math.floor(m.z / 2)) - 0.15) : m.y;
    return this.mgr.level.segmentClear(m.x, sy, m.z, p.x, p.y - 0.2, p.z, 0.4);
  }

  _strike(player) {
    if (this.patrol) {
      this.patrol.anchor.copy(this.pos);
      this.homeYaw = this.yaw;
    }
    this.state = 'suck';
    this.t = 0;
    this.agitation = 0;
    this.mgr.audio.lurkerSnap(this.maw);
    this.mgr.fx.bubbles.spawn(this.maw.x, Math.min(-0.3, this.maw.y), this.maw.z, 18, 0.8, 1.2);
    this.mgr.events.push({ type: 'lunge', source: 'lurker', x: this.pos.x, y: this.pos.y, z: this.pos.z });
    player.shake = Math.max(player.shake, 0.25);
  }

  _surge(dt, player) {
    const L = this.mgr.level;
    const p = player.pos;
    const s = this.scale;
    // chase the prey's current position; keep the head in water, near the lair
    const mo = this.mawLocal.length() * s;
    const tx = p.x - this.surgeDir.x * mo * 0.8, tz = p.z - this.surgeDir.z * mo * 0.8;
    const fl = L.floor(Math.floor(this.pos.x / 2), Math.floor(this.pos.z / 2));
    const ce = L.ceil(Math.floor(this.pos.x / 2), Math.floor(this.pos.z / 2));
    const ty = clamp(p.y - 0.4, fl + 1.1 * s, Math.min(0.5, ce - 1.1 * s));
    let dx = tx - this.pos.x, dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    const step = Math.min(d, 14 * dt);
    if (d > 1e-3) { dx /= d; dz /= d; }
    const nx = this.pos.x + dx * step, nz = this.pos.z + dz * step;
    const ttx = Math.floor(nx / 2), ttz = Math.floor(nz / 2);
    const origin = this.patrol ? this.patrol.anchor : this.home;
    if (L.isWater(ttx, ttz) && !L.solid(ttx, ttz) && Math.hypot(nx - origin.x, nz - origin.z) < REACH * s + 0.5) {
      this.pos.x = nx;
      this.pos.z = nz;
    }
    this.pos.y += (ty - this.pos.y) * Math.min(1, dt * 12);
    this.pitch += (clamp((p.y - this.pos.y) * 0.25, -0.4, 0.5) - this.pitch) * Math.min(1, dt * 10);
    this._turn(Math.atan2(p.x - this.pos.x, p.z - this.pos.z), dt, 8);
    this._place(this.now);
    if (!player.frozen && !this.caught) {
      const hit = p.y > 0
        ? Math.hypot(p.x - this.maw.x, p.z - this.maw.z) < 1.8 && p.y - this.maw.y < 2.7 && p.y < SAFE_EYE_Y
        : Math.hypot(p.x - this.maw.x, p.y - this.maw.y, p.z - this.maw.z) < 1.9;
      if (hit && attackClear(L, this.maw, p)) {
        this.caught = true;
        this.state = 'feed';
        this.mgr.events.push({ type: 'catch', source: 'lurker', x: this.pos.x, y: this.pos.y, z: this.pos.z });
        if (this.mgr.onCatch) this.mgr.onCatch({ source: 'lurker', maw: this.maw.clone(), grab: p.clone() });
        return;
      }
    }
    if (this.t > SURGE) {
      this.state = 'return';
      this.t = 0;
      if (this.pos.y > -0.8) {
        this.mgr.audio.splash(0.8, this.pos);
        this.mgr.water.addRipple(this.pos.x, this.pos.z, 2.2);
      }
      this.mgr.fx.bubbles.spawn(this.maw.x, Math.min(-0.3, this.maw.y), this.maw.z, 26, 1.2, 1.6);
      this.mgr.events.push({ type: 'strike', source: 'lurker', x: this.pos.x, y: this.pos.y, z: this.pos.z });
    }
  }

  _turn(want, dt, rate) {
    const dy = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
    this.yaw += clamp(dy, -rate * dt, rate * dt);
  }

  _resetChains() {
    const m = this.headMesh.matrixWorld;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    _a.copy(this.tailLocal).applyMatrix4(m);
    this.tail.reset(_a.x, _a.y, _a.z, -fx, 0, -fz);
    _a.copy(this.stalkLocal).applyMatrix4(m);
    this.stalk.reset(_a.x, _a.y, _a.z, fx * 0.5, 0.866, fz * 0.5);
    for (const f of this.fringe) {
      _a.copy(f.rootLocal).applyMatrix4(m);
      f.chain.reset(_a.x, _a.y, _a.z, 0, -1, 0);
    }
  }

  _simLimbs(dt, t) {
    const L = this.mgr.level;
    const m = this.headMesh.matrixWorld;
    const nz = this.noise;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = fz, rz = -fx;
    const fast = this.state === 'surge' || this.state === 'suck' ? 1 : 0;

    // tail: a slow scull, whipping hard during a lunge
    const c = this.tail;
    _a.copy(this.tailLocal).applyMatrix4(m);
    c.integrate(dt, 0.9, 0, 0, 0);
    const k = 1 - Math.exp(-dt * (2 + fast * 8));
    for (let i = 1; i < c.n; i++) {
      const s = i * c.seg, tt = i / (c.n - 1);
      const w = Math.sin(t * (1.3 + fast * 7) - s * 0.9) * (0.2 + fast * 0.5) * tt * c.length * 0.25;
      c.pull(i, _a.x - fx * s + rx * w, _a.y - s * 0.12, _a.z - fz * s + rz * w, k * (0.3 + 0.7 * tt));
    }
    _b.set(-fx, -0.1, -fz).normalize();
    // Let a wall-compressed tail unfold with the pose instead of forcing every link straight.
    c.constrain(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, 0.08, true);
    collideChain(L, c, true, fast ? 28 : 10, true);
    c.frames(0, 1, 0);
    this.tailBundle.set(0, c);
    this.tailBundle.upload();

    // lure stalk: an arc over the head, the bulb dangling in front of the mouth
    const st = this.stalk;
    _a.copy(this.stalkLocal).applyMatrix4(m);
    const sc = this.scale;
    const retract = this.state === 'suck' || this.state === 'surge' ? 1 : this.state === 'return' ? Math.max(0, 1 - this.t / 1.5) : 0;
    const bx = this.maw.x + fx * 1.9 * sc + Math.sin(t * 0.9 + this.k) * 0.15;
    const by = this.maw.y + 0.5 * sc + Math.sin(t * 1.3 + this.k * 3) * 0.2 * sc;
    const bz = this.maw.z + fz * 1.9 * sc + Math.cos(t * 0.8 + this.k) * 0.15;
    const ex = bx + (_a.x + fx * 0.6 - bx) * retract;
    const ey = by + (_a.y + 1.2 * sc - by) * retract;
    const ez = bz + (_a.z + fz * 0.6 - bz) * retract;
    const cx = _a.x + fx * 0.8 * sc, cy = _a.y + 1.9 * sc, cz = _a.z + fz * 0.8 * sc;
    st.integrate(dt, 0.85, 0, 0, 0);
    const ks = 1 - Math.exp(-dt * (5 + retract * 10));
    for (let i = 1; i < st.n; i++) {
      const u = i / (st.n - 1), v = 1 - u;
      const px = v * v * _a.x + 2 * v * u * cx + u * u * ex;
      const py = v * v * _a.y + 2 * v * u * cy + u * u * ey;
      const pz = v * v * _a.z + 2 * v * u * cz + u * u * ez;
      st.pull(i, px, py, pz, ks);
    }
    _b.set(fx * 0.3, 0.95, fz * 0.3).normalize();
    st.constrain(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, 0.05);
    collideChain(L, st, true);
    st.frames(fx, 0, fz);
    this.fringeBundle.set(0, st);
    st.tip(this.bulb);

    // filaments drift in the water
    const dt2 = dt * dt;
    for (let j = 0; j < this.fringe.length; j++) {
      const f = this.fringe[j], ch = f.chain;
      _a.copy(f.rootLocal).applyMatrix4(m);
      _b.copy(f.dirLocal).transformDirection(m);
      ch.integrate(dt, 0.9, 0, 0, 0);
      for (let i = 1; i < ch.n; i++) {
        const o = i * 3, w = 8 * (0.3 + i / (ch.n - 1)), q = j * 3.7 + i * 0.4 + this.k * 11;
        ch.p[o] += (nz(q, t * 0.5, 0.5) - 0.5) * w * dt2 * 2;
        ch.p[o + 1] += ((ch.p[o + 1] < 0 ? -0.4 : -7) + (nz(q, t * 0.5, 7.5) - 0.5) * w) * dt2;
        ch.p[o + 2] += (nz(q, t * 0.5, 13.5) - 0.5) * w * dt2 * 2;
      }
      ch.constrain(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, 0.06);
      collideChain(L, ch, true);
      ch.frames(fx, 0, fz);
      this.fringeBundle.set(j + 1, ch);
    }
    this.fringeBundle.upload();
  }

  _effects(dt, t, camera, near) {
    const mgr = this.mgr;
    this.group.visible = near;
    // the lure flickers as prey draws near: the only warning
    this.flickT -= dt;
    if (this.state === 'wait' && this.tension > 0.25 && this.flickT < -0.1 && this.rand() < this.tension * dt * 2.5) this.flickT = 0.06 + this.rand() * 0.16;
    let b = this.light * (0.82 + 0.18 * Math.sin(t * 0.7 + this.k * 1.7));
    if (this.flickT > 0) b *= 0.12;
    this.bright = near ? b : 0;
    const lamp = this.lamp;
    lamp.x = this.bulb.x;
    lamp.y = near ? this.bulb.y : -500;
    lamp.z = this.bulb.z;
    lamp.intensity = 1.4 * this.bright;
    if (!near) return;

    const focus = this.state === 'wait' ? this.tension : 1;
    this.eyes.setAllOpen(0.45 + focus * 0.55);
    this.eyes.update(dt, focus > 0.2 ? camera.position : null, focus, 0.55 - focus * 0.3, 0.2 + focus * 0.9);
    const lum = mgr.lightGrid[Math.floor(this.pos.z / 2) * mgr.level.W + Math.floor(this.pos.x / 2)] || 0;
    this.probe.value.setRGB(0.008 + lum * 0.03 + b * 0.012, 0.009 + lum * 0.025 + b * 0.008, 0.011 + lum * 0.02 + b * 0.004);

    // gill bubbles, faster when tense
    this.bubbleT -= dt * (1 + this.tension * 3);
    if (this.bubbleT <= 0) {
      this.bubbleT = 3 + this.rand() * 4;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      this.mgr.fx.bubbles.spawn(this.pos.x - fx * 0.8, Math.min(-0.2, this.pos.y + 0.6), this.pos.z - fz * 0.8, 3 + Math.floor(this.tension * 6), 0.3, 0.9);
    }
  }

  get disturb() {
    if (this.state !== 'suck' && this.state !== 'surge') return null;
    return { x: this.pos.x, z: this.pos.z, r: 10, amount: 0.6 };
  }

  dispose() {
    this.group.removeFromParent();
    this.eyes.dispose();
    this.headMat.dispose();
    this.teeth.geometry.dispose();
    this.teeth.material.dispose();
    this.tailBundle.dispose();
    this.fringeBundle.dispose();
    this.lamp.y = -500;
    this.lamp.intensity = 0;
  }
}

/** All lure-fish in the level, sharing sculpted heads, one glow layer and one voice. */
export class Lurkers {
  constructor({ scene, level, lampSys, audio, water, fx, lightGrid }) {
    this.scene = scene;
    this.level = level;
    this.lampSys = lampSys;
    this.audio = audio;
    this.water = water;
    this.fx = fx;
    this.lightGrid = lightGrid;
    this.events = [];
    this.onCatch = null;
    this.heads = [sculptBody(headParams(311)), sculptBody(headParams(347))];
    this.list = LURKERS.filter(([x, z]) => level.isWater(x, z) && !level.solid(x, z))
      .map(([x, z], k) => new Lurker(this, x, z, k, this.heads[k % 2]));
    this.glow = new GlowPoints(this.list.length * 2, { core: 1.1, halo: 0.55 });
    scene.add(this.glow.points);
    this.voice = audio.createCreatureVoice('hunter');
    this.voice.setPosition(0, -400, 0);
    this.threat = 0;
  }

  reset() {
    for (const l of this.list) l.reset();
    this.events.length = 0;
    this.threat = 0;
  }

  hear(x, y, z, r, loud) {
    for (const l of this.list) l.hear(x, y, z, r, loud);
  }

  get caught() { return this.list.some((l) => l.caught); }

  get disturbs() {
    const out = [];
    for (const l of this.list) {
      const d = l.disturb;
      if (d) out.push(d);
    }
    return out;
  }

  update(dt, t, { player, camera }) {
    this.events.length = 0;
    const cp = camera.position;
    let nearest = null, nd = Infinity, threat = 0;
    let n = 0;
    for (const l of this.list) {
      const d = Math.hypot(l.home.x - cp.x, l.home.z - cp.z);
      const near = d < 55;
      l.update(dt, t, player, camera, near);
      if (near) {
        const b = l.bright;
        const s = l.scale;
        this.glow.set(n++, l.bulb.x, l.bulb.y, l.bulb.z, LURE_COL[0] * b * 1.4, LURE_COL[1] * b * 1.4, LURE_COL[2] * b * 1.4, 0.3 * s);
        this.glow.set(n++, l.bulb.x, l.bulb.y, l.bulb.z, LURE_COL[0] * b * 0.5, LURE_COL[1] * b * 0.45, LURE_COL[2] * b * 0.35, 2.2 * s);
      }
      if (d < nd) { nd = d; nearest = l; }
      threat = Math.max(threat, l.state === 'wait' || l.state === 'return' ? l.tension * 0.6 : 1);
    }
    this.glow.upload(n);
    this.threat = threat;
    // one voice follows the closest lair: slow clicking, quickening as something swims near
    if (nearest && nd < 26) {
      this.voice.setPosition(nearest.pos.x, nearest.pos.y, nearest.pos.z);
      this.voice.setState(nearest.tension > 0.35 ? 'suspicious' : 'patrol');
      this.voice.setSpeed(nearest.state === 'surge' ? 1 : 0.05);
    } else {
      this.voice.setPosition(cp.x, -400, cp.z);
      this.voice.setState('patrol');
    }
    this.voice.update(dt);
  }

  dispose() {
    for (const l of this.list) l.dispose();
    for (const h of this.heads) h.geometry.dispose();
    this.glow.dispose();
    this.voice.dispose();
  }
}
