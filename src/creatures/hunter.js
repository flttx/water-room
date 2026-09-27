import * as THREE from 'three';
import { sculptBody, EyeSet, buildTeeth, layoutEyes, makeSkinMaterial, TentacleBundle, Chain, makeNoise3, collideChain } from './flesh.js';
import { mulberry32 } from '../render/textures.js';
import { BodyCollider, sphereClear } from './collision.js';
import { exposure, sight, sightRange, awarenessRate, AWARE_SUSPICIOUS, AWARE_CHASE } from './senses.js';

// Brood hunters: pale many-eyed squid longer than a bus that roam the deep canals.
// They swim face first with a skirt of sucker arms streaming under the mantle, watch along the water,
// hear splashes, and burst out of the water at anything standing close to the edge.

const CRUISE_Y = -3.2;
const SPEED = { patrol: 2.5, suspicious: 3.0, search: 2.8, chase: 4.4 };
const VIEW_COS = Math.cos(0.96);
const VIEW_RANGE = 34;
const LOSE_AFTER = 6;
const TRAIL_MAX = 60;
const ROAR_TIME = 1.3;
const WINDUP = 0.6;
const STRIKE = 0.3;
const RECOVER = 1.1;
const POSE_KEYS = ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'jetC'];
const LUNGE_RANGE = 7.5;
const SAFE_EYE_Y = 3.2; // player eyes above this (galleries, the diving tower) are out of reach

const SKIN = {
  colA: [0.1, 0.088, 0.07],
  colB: [0.034, 0.03, 0.026],
  colFold: [0.13, 0.04, 0.05],
  colVein: [0.22, 0.05, 0.08],
  colTop: [0.05, 0.046, 0.04],
  colInner: [0.32, 0.045, 0.06],
  colPale: [0.3, 0.26, 0.21],
  roughness: 0.32,
  bump: 1.1,
};
const TENDRIL_SKIN = {
  colA: [0.12, 0.035, 0.05],
  colB: [0.05, 0.015, 0.025],
  colFold: [0.14, 0.03, 0.05],
  colVein: [0.24, 0.05, 0.08],
  colTop: [0.18, 0.07, 0.07],
  colInner: [0.3, 0.05, 0.06],
  colPale: [0.26, 0.13, 0.12],
  roughness: 0.25,
  bump: 0.7,
};

// a wide lipless grin under a cluster of eyes
const MAW = { dir: [0, -0.3, 1], ru: 0.55, rv: 0.26, depth: 0.34, lip: 0.08 };
const HEAD_P = {
  seed: 131, radius: 1.9, stretch: [1, 0.85, 1.35], detail: 30, fold: 0.07, foldFreq: 3.6, pale: 0.4,
  maw: MAW,
  lumps: [
    { dir: [0, 1, -0.2], amp: 0.12, width: 0.25 },
    { dir: [0.7, 0.3, 0.45], amp: 0.08, width: 0.1 },
    { dir: [-0.7, 0.3, 0.45], amp: 0.08, width: 0.1 },
    { dir: [0, -1, 0.2], amp: -0.1, width: 0.3 },
    { dir: [0, 0.2, -1], amp: -0.12, width: 0.3 },
  ],
  eyes: layoutEyes({
    seed: 17,
    sizes: [0.16, 0.14, 0.12, 0.1, 0.09, 0.08, 0.07],
    region: (d) => d.z > 0.2 && d.y > 0.02 && d.y < 0.78,
    maw: MAW,
  }),
};
const MANTLE_P = {
  seed: 132, radius: 2.1, stretch: [0.85, 0.72, 2.3], detail: 24, fold: 0.05, foldFreq: 2.4, pale: 0.5,
  maw: null,
  lumps: [
    { dir: [0, 0, -1], amp: 0.28, width: 0.07 },
    { dir: [0.8, 0, -0.6], amp: 0.2, width: 0.05 },
    { dir: [-0.8, 0, -0.6], amp: 0.2, width: 0.05 },
    { dir: [0, 1, 0.1], amp: 0.07, width: 0.12 },
    { dir: [0, 0, 1], amp: -0.14, width: 0.3 },
  ],
  eyes: [],
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _e = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _mx = new THREE.Vector3();
const _my = new THREE.Vector3();
const _mz = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Hunter {
  constructor({ scene, level, lampSys, audio, water, fx, lightGrid, seed = 1 }) {
    this.level = level;
    this.audio = audio;
    this.water = water;
    this.fx = fx;
    this.lightGrid = lightGrid;
    this.rand = mulberry32(4001 + seed * 97);
    this.noise = makeNoise3(211 + seed);
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.probe = { value: new THREE.Color(0.02, 0.024, 0.028) };
    this.rim = { value: new THREE.Color(0.012, 0.03, 0.034) };
    this.events = [];
    this.onCatch = null;
    this.active = false;
    this.caught = false;
    this.state = 'idle';
    this.allow = (i) => level.ch(i % level.W, (i / level.W) | 0) === '~';
    this.x = 0; this.y = -400; this.z = 0;
    this.vx = 0; this.vz = 0;
    this.yaw = 0; this.pitch = 0; this.roll = 0;
    this._turnRate = 0;
    this._vy = 0;
    this.noPathT = 0;
    this.awareness = 0;
    this.trail = [];
    this.focus = new THREE.Vector3();
    this.lastKnown = new THREE.Vector3();
    this.maw = new THREE.Vector3();
    this.strikeFrom = new THREE.Vector3();
    this.strikeDir = new THREE.Vector3();
    this._buildBody();
    this._buildLimbs();
    this.limbs = [...this.arms, ...this.tendrils];
    this.safePose = new Float64Array(POSE_KEYS.length + 1);
    this.goalPose = new Float64Array(POSE_KEYS.length + 1);
    this.lamp = lampSys.add({ type: 'creature', x: 0, y: -500, z: 0, color: [0.62, 0.9, 0.32], intensity: 0, range: 7.5 });
    this.voice = audio.createCreatureVoice('hunter');
    this.voice.setPosition(0, -400, 0);
  }

  // ------------------------------------------------------------------ construction

  _buildBody() {
    const skin = { ...SKIN, probe: this.probe, rim: this.rim };
    this.skin = skin;
    this.bodyMat = makeSkinMaterial({ ...skin, kind: 'body', scale: 1.4 });
    this.root = new THREE.Group();
    this.group.add(this.root);
    this.head = sculptBody(HEAD_P);
    this.headMesh = new THREE.Mesh(this.head.geometry, this.bodyMat);
    this.headCollider = new BodyCollider(this.head.geometry, 0.4);
    this.root.add(this.headMesh);
    this.eyes = new EyeSet(this.headMesh, this.head.sockets, {
      iris: [0.7, 0.85, 0.2], irisAlt: [0.9, 0.6, 0.15], scleraAlt: [0.24, 0.24, 0.12],
      probe: this.probe, skin, rim: this.rim, seed: 53 + Math.floor(this.rand() * 40),
    });
    this.teeth = buildTeeth(this.head, 34, 0.18, 0.75, this.probe, 11);
    this.headMesh.add(this.teeth);
    this.mawLocal = this.head.surface(this.head.maw.d).pos.clone();
    this.mantle = sculptBody(MANTLE_P);
    this.mantleMesh = new THREE.Mesh(this.mantle.geometry, this.bodyMat);
    this.mantleCollider = new BodyCollider(this.mantle.geometry, 0.2);
    this.group.add(this.mantleMesh);
  }

  _buildLimbs() {
    const rand = this.rand;
    const n = 8;
    this.armBundle = new TentacleBundle({
      count: n, points: 18, segments: 64, radial: 12,
      suckers: { rows: 2, perRow: 26, from: 0.1, to: 0.96, size: 0.55 },
      skin: { ...this.skin, scale: 1.8, paleUnder: 0.9 },
    });
    this.arms = [];
    for (let k = 0; k < n; k++) {
      // a skirt of arms around the underside of the head, streaming back beneath the mantle
      const phi = (k / (n - 1) - 0.5) * 2.7;
      const s = this.head.surface(new THREE.Vector3(Math.sin(phi) * 0.95, -Math.cos(phi) * 0.8 - 0.15, -0.55));
      const long = k === 2 || k === 5;
      const chain = new Chain(18, long ? 17 : 10.5 + rand() * 2.5, 0.46, 0.04, 0.75);
      if (long) {
        // two feeding tentacles: thin stalks ending in sucker clubs
        for (let i = 0; i < 18; i++) {
          const t = i / 17;
          const club = Math.exp(-(((t - 0.84) / 0.08) ** 2));
          chain.r[i] = (0.4 * Math.pow(1 - t, 1.5) + 0.1) * (1 - club) + club * 0.34;
        }
      }
      const ring = (k / n) * Math.PI * 2 + 0.4;
      this.arms.push({
        k, chain, long, side: Math.sin(phi),
        rootLocal: s.pos.clone().addScaledVector(s.normal, -0.25),
        dirLocal: new THREE.Vector3(Math.sin(phi) * 0.4, -0.5, -1).normalize(),
        fx: Math.cos(ring), fy: Math.sin(ring),
        seed: rand() * 50,
      });
    }
    this.group.add(this.armBundle.group);

    // fine red tendrils fringing the grin
    const maw = this.head.maw;
    const mawDir = (e, phi) => maw.d.clone()
      .addScaledVector(maw.u, Math.tan(maw.ru * e * Math.cos(phi)))
      .addScaledVector(maw.v, Math.tan(maw.rv * e * Math.sin(phi))).normalize();
    const count = 14;
    this.tendrilBundle = new TentacleBundle({
      count, points: 8, segments: 16, radial: 6, suckers: null,
      skin: { ...TENDRIL_SKIN, probe: this.probe, rim: this.rim, scale: 2.6 },
    });
    this.tendrils = [];
    for (let k = 0; k < count; k++) {
      const phi = (k / count) * Math.PI * 2 + rand() * 0.2;
      const s = this.head.surface(mawDir(1.05 + rand() * 0.15, phi));
      const low = Math.max(0, -Math.sin(phi));
      this.tendrils.push({
        rootLocal: s.pos.clone().addScaledVector(s.normal, -0.04),
        dirLocal: s.normal.clone().multiplyScalar(0.6).add(new THREE.Vector3(0, -0.3, 0.4)).normalize(),
        chain: new Chain(8, 1.1 + rand() * 1.6 + low * 1.2, 0.07 + rand() * 0.03, 0.012, 0.8),
      });
    }
    this.group.add(this.tendrilBundle.group);
  }

  // ------------------------------------------------------------------ public

  /** Bring the hunter into the world at a core water tile index. */
  spawn(tileIdx, player) {
    const L = this.level;
    const [x, z] = L.worldCenter(tileIdx % L.W, (tileIdx / L.W) | 0);
    this.x = x;
    this.z = z;
    this.y = Math.max(CRUISE_Y, L.floor(tileIdx % L.W, (tileIdx / L.W) | 0) + this.headCollider.radius + 0.15);
    this.vx = this.vz = 0;
    this.pitch = this.roll = 0;
    this.awareness = 0;
    this.seenT = 99;
    this.heardT = 99;
    this.stateT = 0;
    this.ignoreT = 0;
    this.lungeCool = 0;
    this.stuckT = 0;
    this.chaseReachT = 0;
    this.searchT = 0;
    this.flare = 0;
    this.jetPh = this.rand();
    this.jetC = 0;
    this.jetPuffed = false;
    this.rippleT = 0;
    this.near = 0;
    this.caught = false;
    this.active = true;
    this.group.visible = true;
    this.events.length = 0;
    this.path = null;
    this.pathI = 0;
    this.repathT = 0;
    this.state = 'patrol';
    this._pickPatrol(player);
    // face along the first leg of the patrol route
    if (this.path && this.path.length > 1) this.yaw = Math.atan2(this.path[1][0] - x, this.path[1][1] - z);
    else this.yaw = this.rand() * Math.PI * 2;
    // The entire body must fit at spawn, including the mantle behind the head.
    const firstYaw = this.yaw;
    let fits = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      this.yaw = wrapAngle(attempt < 16 ? firstYaw + attempt * Math.PI / 8 : (attempt - 16) * Math.PI / 2);
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      this.trail.length = 0;
      for (let i = 1; i <= 36; i++) this.trail.push(new THREE.Vector3(x - fx * 0.3 * i, this.y, z - fz * 0.3 * i));
      this._place(0);
      if (this._poseClear()) { fits = true; break; }
    }
    if (!fits) { this.deactivate(); return false; }
    this._savePose(this.safePose, 0);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const m = this.headMesh.matrixWorld;
    const bx = -fx, bz = -fz;
    for (const a of this.arms) {
      _a.copy(a.rootLocal).applyMatrix4(m);
      a.chain.reset(_a.x, _a.y, _a.z, bx * 0.98, -0.2, bz * 0.98);
    }
    for (const f of this.tendrils) {
      _a.copy(f.rootLocal).applyMatrix4(m);
      f.chain.reset(_a.x, _a.y, _a.z, 0, -1, 0);
    }
    this.eyes.setAllOpen(1);
    this.voice.setState('patrol');
    return true;
  }

  /** Remove from play (pooled by the director). */
  deactivate() {
    this.active = false;
    this.caught = false;
    this.state = 'idle';
    this.awareness = 0;
    this.group.visible = false;
    this.lamp.y = -500;
    this.lamp.intensity = 0;
    this.voice.setState('patrol');
    this.voice.setPosition(this.x, -400, this.z);
  }

  reset() { this.deactivate(); }

  /** A sound at (x,y,z) audible within r metres; loud noises raise awareness faster. */
  hear(x, y, z, r, loud) {
    if (!this.active || this.caught) return;
    const d = Math.hypot(x - this.x, (y - this.y) * 0.6, z - this.z);
    if (d > r) return;
    this.awareness = Math.min(1.5, this.awareness + (loud ? 0.6 : 0.28) * (1 - (d / r) * 0.6));
    this.focus.set(x, y, z);
    this.heardT = 0;
    if (this.state === 'chase' || this.state === 'search') this.lastKnown.set(x, y, z);
    if (this.state === 'search') this.searchT = 0;
    if (this.state !== 'chase') this.path = null;
  }

  get chasing() {
    return this.active && (this.state === 'roar' || this.state === 'chase' || this.state === 'lunge' || this.state === 'feed');
  }

  /** Rough threat for music/UI. */
  get threat() {
    if (!this.active) return 0;
    if (this.chasing) return 1;
    return Math.min(0.9, Math.max(this.awareness * 0.9, this.near * 0.3));
  }

  get disturb() {
    if (!this.active) return null;
    return { x: this.x, z: this.z, r: 14, amount: 0.2 + Math.min(1, this.awareness) * 0.4 };
  }

  update(dt, t, ctx) {
    this.events.length = 0;
    if (!this.active) return;
    const player = ctx.player;
    this.near = clamp(1 - Math.hypot(player.pos.x - this.x, player.pos.z - this.z) / 40, 0, 1);
    this._think(dt, t, player);
    this._jet(dt);
    this._moveBody(t);
    this._trailPush();
    this._simArms(dt, t);
    this._simTendrils(dt, t);
    this._effects(dt, t, ctx);
  }

  dispose() {
    this.group.removeFromParent();
    this.eyes.dispose();
    this.armBundle.dispose();
    this.tendrilBundle.dispose();
    this.headMesh.geometry.dispose();
    this.mantleMesh.geometry.dispose();
    this.bodyMat.dispose();
    this.teeth.geometry.dispose();
    this.teeth.material.dispose();
    this.voice.dispose();
    this.lamp.y = -500;
    this.lamp.intensity = 0;
  }

  // ------------------------------------------------------------------ behaviour

  _setState(s) {
    const prev = this.state;
    if (prev === s) return;
    this.state = s;
    this.stateT = 0;
    this.path = null;
    if (s === 'roar') {
      this.events.push({ type: 'spotted', source: 'hunter' });
      this.voice.roar();
    } else if (s === 'suspicious') {
      this.events.push({ type: 'suspicious', source: 'hunter' });
      this.voice.click();
    } else if (s === 'search') {
      this.searchT = 0;
      this.searchGoal = null;
      if (prev === 'chase' || prev === 'lunge') this.events.push({ type: 'lost', source: 'hunter' });
    } else if (s === 'chase') {
      this.chaseReachT = 0;
    }
    const v = s === 'roar' || s === 'chase' || s === 'lunge' || s === 'feed' ? 'chase' : s === 'idle' ? 'patrol' : s;
    this.voice.setState(v);
  }

  _think(dt, t, player) {
    this.stateT += dt;
    this.seenT += dt;
    this.heardT += dt;
    this.repathT -= dt;
    this.noPathT -= dt;
    this.lungeCool -= dt;
    this._turnRate = 0;
    this.ignoreT -= dt;
    const frozen = player.frozen;
    if (!frozen && this.state !== 'feed') this._look(dt, player);
    else this.awareness = Math.max(0, this.awareness - dt * 0.2);

    // perception-driven transitions
    const s = this.state;
    if (!frozen && s !== 'roar' && s !== 'chase' && s !== 'lunge' && s !== 'feed' && this.awareness >= AWARE_CHASE && this.seenT < 0.5) {
      this._setState('roar');
    } else if (s === 'patrol' && this.awareness >= AWARE_SUSPICIOUS) {
      this._setState('suspicious');
    }

    switch (this.state) {
      case 'patrol': {
        this._depth(dt, CRUISE_Y + Math.sin(t * 0.3 + this.jetPh * 6) * 0.3, 1);
        if (this._goTo(dt, this.patrolX, this.patrolZ, SPEED.patrol, 8)) {
          this._steer(dt, this.x, this.z, 0);
          this._pickPatrol(player);
        }
        break;
      }
      case 'suspicious': {
        this._depth(dt, -2.8, 1);
        const arrived = this._goTo(dt, this.focus.x, this.focus.z, SPEED.suspicious, 8);
        if (arrived) this._hover(dt, this.focus.x, this.focus.z);
        if (this.awareness < 0.12 && this.stateT > 3) this._setState('patrol');
        else if (this.stateT > 18) { this.awareness *= 0.5; this._setState('patrol'); }
        break;
      }
      case 'roar': {
        this._hover(dt, player.pos.x, player.pos.z, 1.2);
        this._depth(dt, -1.3, 2);
        this.pitch += (0.32 - this.pitch) * Math.min(1, dt * 4);
        this.flare += (0.45 - this.flare) * Math.min(1, dt * 3);
        if (this.stateT > ROAR_TIME) {
          this.lastKnown.copy(player.pos);
          this._setState('chase');
        }
        break;
      }
      case 'chase':
        this._chase(dt, t, player);
        break;
      case 'lunge':
        this._lunge(dt, player);
        break;
      case 'search': {
        this._depth(dt, -2.8, 1);
        this.searchT += dt;
        const goal = this.searchGoal || [this.lastKnown.x, this.lastKnown.z];
        if (this._goTo(dt, goal[0], goal[1], this.searchGoal ? SPEED.search * 0.8 : SPEED.search, 8)) {
          this._hover(dt, this.lastKnown.x, this.lastKnown.z);
          this._pickSearch();
        }
        if (this.searchT > 14) {
          this.awareness = Math.min(this.awareness, 0.2);
          this._setState('patrol');
        }
        break;
      }
      case 'feed':
        this._hover(dt, this.maw.x, this.maw.z, 0);
        this._depth(dt, -0.4, 3);
        this.flare += (1 - this.flare) * Math.min(1, dt * 4);
        break;
      default:
        break;
    }
    if (this.state !== 'roar' && this.state !== 'lunge' && this.state !== 'feed') {
      this.pitch += (clamp(this._vy * 0.1, -0.2, 0.2) - this.pitch) * Math.min(1, dt * 2);
      this.flare += (0 - this.flare) * Math.min(1, dt * 2);
    }

    // anything swimming into the grin is taken
    if (!frozen && !this.caught && player.inWater && this.state !== 'lunge') {
      const d = Math.hypot(player.pos.x - this.maw.x, player.pos.y - this.maw.y, player.pos.z - this.maw.z);
      if (d < 2.5) this._catch(player);
    }
  }

  _depth(dt, ty, rate) {
    const L = this.level;
    const tx = Math.floor(this.x / 2), tz = Math.floor(this.z / 2);
    const lo = L.floor(tx, tz) + 1.8;
    const want = Math.max(lo, ty);
    const prev = this.y;
    this.y += (want - this.y) * Math.min(1, dt * rate);
    this._vy = (this.y - prev) / Math.max(dt, 1e-4);
  }

  /** Vision cone from the eye cluster: awareness climbs while the player is in view. */
  _look(dt, player) {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    _fwd.set(fx, 0, fz);
    const eye = _e.set(this.x + fx * 2.3, this.y + 0.5, this.z + fz * 2.3);
    const range = sightRange(VIEW_RANGE, eye.y, player.pos.y);
    const d = sight(this.level, eye, _fwd, VIEW_COS, range, player.pos);
    if (d >= 0) {
      const vis = exposure(player, this.lightGrid, this.level, eye);
      const mul = this.ignoreT > 0 ? 0.4 : 1;
      this.awareness = Math.min(1.5, this.awareness + awarenessRate(vis, d, range) * dt * mul);
      this.seenT = 0;
      if (this.awareness > AWARE_SUSPICIOUS * 0.5) {
        this.focus.copy(player.pos);
        this.lastKnown.copy(player.pos);
      }
    } else {
      const decay = this.state === 'chase' ? 0.05 : this.state === 'search' ? 0.08 : 0.12;
      this.awareness = Math.max(0, this.awareness - dt * decay);
    }
  }

  /** Can the player be reached by swimming (deep channel water with room for the body)? */
  _reachable(player) {
    if (!player.inWater) return false;
    const L = this.level;
    return L.ch(player.tileX, player.tileZ) === '~' && this._bodyOk(player.pos.x, player.pos.z, 0.9);
  }

  _chase(dt, t, player) {
    const p = player.pos;
    const reach = this._reachable(player);
    const lost = Math.min(this.seenT, this.heardT * 1.6) > LOSE_AFTER;
    if (lost || player.frozen) {
      this._setState('search');
      return;
    }
    if (this.seenT < 0.3) this.lastKnown.copy(p);
    const gx = this.seenT < 1.5 ? p.x : this.lastKnown.x;
    const gz = this.seenT < 1.5 ? p.z : this.lastKnown.z;
    const dh = Math.hypot(gx - this.x, gz - this.z);
    // depth: follow a diving player, otherwise ride just under the surface
    const ty = reach && player.underwater ? clamp(p.y - 0.3, -5.2, -1.6) : -1.9;
    this._depth(dt, ty, 1.5);
    const direct = dh < 11 && this.seenT < 1 &&
      this.level.segmentClear(this.x, Math.max(this.y, -1), this.z, gx, Math.max(-1, Math.min(p.y, 0)), gz, 0.8);
    if (direct) {
      this._steer(dt, gx, gz, SPEED.chase);
    } else {
      if (this.repathT <= 0) this.path = null;
      if (this._goTo(dt, gx, gz, SPEED.chase, 8)) this._steer(dt, gx, gz, dh > 2 ? SPEED.chase * 0.6 : 0);
    }
    // strike at prey on the edge or in water too shallow / tight to follow
    if (!reach && this.lungeCool <= 0 && p.y < SAFE_EYE_Y && dh < LUNGE_RANGE && dh > 1.5 && this.seenT < 0.6 &&
      this.level.segmentClear(this.x, 1, this.z, p.x, Math.max(1, p.y - 0.3), p.z, 0.5)) {
      this._startLunge(player);
      return;
    }
    // prey out of reach for long: give up and drift off
    if (!reach && dh > LUNGE_RANGE) this.chaseReachT += dt;
    else this.chaseReachT = Math.max(0, this.chaseReachT - dt * 0.5);
    if (this.chaseReachT > 16) {
      this.ignoreT = 10;
      this.awareness = 0.5;
      this._setState('search');
    }
  }

  _startLunge(player) {
    this._setState('lunge');
    this.lungePhase = 'windup';
    this.lungeT = 0;
    this.voice.growl();
    this.events.push({ type: 'lunge', source: 'hunter', x: this.x, z: this.z });
    this.strikeFrom.set(this.x, this.y, this.z);
    this.strikeDir.set(player.pos.x - this.x, 0, player.pos.z - this.z).normalize();
  }

  _lunge(dt, player) {
    this.lungeT += dt;
    const p = player.pos;
    const L = this.level;
    if (this.lungePhase === 'windup') {
      this.vx *= Math.exp(-dt * 5);
      this.vz *= Math.exp(-dt * 5);
      this._advance(dt);
      this._turnTo(Math.atan2(p.x - this.x, p.z - this.z), dt, 3);
      this._depth(dt, -0.9, 4);
      this.pitch += (0.35 - this.pitch) * Math.min(1, dt * 6);
      this.flare += (0.5 - this.flare) * Math.min(1, dt * 5);
      this.rippleT -= dt;
      if (this.rippleT <= 0) {
        this.rippleT = 0.12;
        this.water.addRipple(this.x + (this.rand() - 0.5) * 4, this.z + (this.rand() - 0.5) * 4, 1.1);
        this.fx.bubbles.spawn(this.x, -0.8, this.z, 8, 1.5, 1.6);
      }
      if (this.lungeT > WINDUP) {
        this.lungePhase = 'strike';
        this.lungeT = 0;
        this.strikeFrom.set(this.x, this.y, this.z);
        const dx = p.x - this.x, dz = p.z - this.z;
        const d = Math.hypot(dx, dz) || 1;
        this.strikeDir.set(dx / d, 0, dz / d);
        this.strikeLen = clamp(d - 2.1, 0.6, 3.6);
        this.yaw = Math.atan2(dx, dz);
        this.voice.roar();
        this.audio.splash(1, { x: this.x, y: 0, z: this.z });
        this.water.addRipple(this.x, this.z, 3);
        this.water.addRipple(this.x + this.strikeDir.x * 3, this.z + this.strikeDir.z * 3, 2.5);
        this.fx.bubbles.spawn(this.x, -0.6, this.z, 50, 2.2, 2.6);
        const pd = Math.hypot(p.x - this.x, p.z - this.z);
        player.shake = Math.max(player.shake, 1 - pd / 18);
        this.events.push({ type: 'strike', source: 'hunter', x: this.x, z: this.z });
      }
    } else if (this.lungePhase === 'strike') {
      const e = 1 - Math.pow(1 - Math.min(1, this.lungeT / STRIKE), 3);
      const nx = this.strikeFrom.x + this.strikeDir.x * this.strikeLen * e;
      const nz = this.strikeFrom.z + this.strikeDir.z * this.strikeLen * e;
      if (L.isWater(Math.floor(nx / 2), Math.floor(nz / 2)) && !L.solid(Math.floor(nx / 2), Math.floor(nz / 2))) {
        this.x = nx;
        this.z = nz;
      }
      this.y += (0.2 - this.y) * Math.min(1, dt * 12);
      this.pitch += (-0.18 - this.pitch) * Math.min(1, dt * 10);
      this.flare += (1 - this.flare) * Math.min(1, dt * 10);
      if (!player.frozen && !this.caught && p.y < SAFE_EYE_Y + 0.2) {
        const dh = Math.hypot(p.x - this.maw.x, p.z - this.maw.z);
        if (dh < 2.3 && p.y - this.maw.y < 3.1) this._catch(player);
      }
      if (this.lungeT > STRIKE && !this.caught) {
        this.lungePhase = 'recover';
        this.lungeT = 0;
      }
    } else {
      // sink back and slide off the edge to open water
      const k = Math.min(1, dt * 2.5);
      const bx = this.x + (this.strikeFrom.x - this.x) * k, bz = this.z + (this.strikeFrom.z - this.z) * k;
      if (!L.solid(Math.floor(bx / 2), Math.floor(bz / 2))) { this.x = bx; this.z = bz; }
      this._depth(dt, -1.9, 2.5);
      this.pitch += (0 - this.pitch) * Math.min(1, dt * 3);
      this.flare += (0 - this.flare) * Math.min(1, dt * 3);
      if (this.lungeT > RECOVER) {
        this.lungeCool = 2.2 + this.rand() * 1.2;
        this.vx = this.vz = 0;
        this.state = 'chase';
        this.stateT = 0;
        this.path = null;
      }
    }
  }

  _catch(player) {
    if (this.caught) return;
    const p = player.pos, m = this.maw;
    if (!this.level.segmentClear(m.x, m.y, m.z, p.x, p.y, p.z, 0.15)) return;
    this.caught = true;
    this._setState('feed');
    this.events.push({ type: 'catch', source: 'hunter' });
    this.voice.roar();
    if (this.onCatch) this.onCatch({ source: 'hunter', maw: this.maw.clone(), grab: player.pos.clone() });
  }

  _pickPatrol(player) {
    const L = this.level, list = L.coreList;
    let best = -1;
    for (let tries = 0; tries < 40; tries++) {
      const i = list[Math.floor(this.rand() * list.length)];
      if (!this.allow(i)) continue;
      const [x, z] = L.worldCenter(i % L.W, (i / L.W) | 0);
      const d = player ? Math.hypot(x - player.pos.x, z - player.pos.z) : 40;
      const far = Math.hypot(x - this.x, z - this.z);
      if (d >= 20 && d <= 70 && far > 16) { best = i; break; }
      if (best < 0 && far > 16) best = i;
    }
    if (best < 0) best = list[Math.floor(this.rand() * list.length)];
    const [x, z] = L.worldCenter(best % L.W, (best / L.W) | 0);
    this.patrolX = x;
    this.patrolZ = z;
    this.path = null;
  }

  _pickSearch() {
    const L = this.level;
    for (let tries = 0; tries < 20; tries++) {
      const a = this.rand() * Math.PI * 2, r = 4 + this.rand() * 12;
      const x = this.lastKnown.x + Math.cos(a) * r, z = this.lastKnown.z + Math.sin(a) * r;
      const i = L.nearestCore(x, z, 3, this.allow);
      if (i < 0) continue;
      this.searchGoal = L.worldCenter(i % L.W, (i / L.W) | 0);
      this.path = null;
      return;
    }
    this.searchGoal = [this.lastKnown.x, this.lastKnown.z];
    this.path = null;
  }

  /** Follow an A* path over core water toward (gx, gz). Returns true when there (or unreachable). */
  _goTo(dt, gx, gz, speed, maxR) {
    const L = this.level;
    if (this.path && this.repathT <= 0 && Math.hypot(gx - this.pathGX, gz - this.pathGZ) > 4) this.path = null;
    if (!this.path) {
      if (this.noPathT > 0) return true;
      const from = L.nearestCore(this.x, this.z, 6, this.allow);
      const to = L.nearestCore(gx, gz, maxR, this.allow);
      this.path = from >= 0 && to >= 0 ? L.findPath(from, to, this.allow) : null;
      this.pathI = this.path && this.path.length > 1 ? 1 : 0;
      this.pathGX = gx;
      this.pathGZ = gz;
      this.repathT = this.state === 'chase' ? 0.6 : 1.5;
      if (!this.path) {
        this.noPathT = 1.5;
        return true;
      }
    }
    let wp = this.path[this.pathI];
    while (wp && Math.hypot(wp[0] - this.x, wp[1] - this.z) < (this.pathI === this.path.length - 1 ? 1.2 : 2.4)) {
      this.pathI++;
      wp = this.path[this.pathI];
    }
    if (!wp) return true;
    // ease off into the final waypoint
    const left = Math.hypot(wp[0] - this.x, wp[1] - this.z);
    const last = this.pathI === this.path.length - 1;
    this._steer(dt, wp[0], wp[1], last ? Math.min(speed, 0.6 + left * 0.6) : speed);
    if (this.stuckT > 1.5) {
      this.stuckT = 0;
      this.path = null;
    }
    return false;
  }

  /** Hold position and turn to look at (x, z). */
  _hover(dt, x, z, rate = 0.9) {
    this._steer(dt, this.x, this.z, 0);
    if (rate > 0) this._turnTo(Math.atan2(x - this.x, z - this.z), dt, rate);
  }

  _steer(dt, tx, tz, speed) {
    let dx = tx - this.x, dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-3) { dx /= d; dz /= d; } else { dx = dz = 0; }
    const k = Math.min(1, dt * 2.2);
    this.vx += (dx * speed - this.vx) * k;
    this.vz += (dz * speed - this.vz) * k;
    this._advance(dt);
  }

  _advance(dt) {
    const mul = 0.75 + 0.5 * this.jetC;
    const nx = this.x + this.vx * dt * mul, nz = this.z + this.vz * dt * mul;
    if (this._bodyOk(nx, nz)) {
      this.x = nx; this.z = nz;
      this.stuckT = 0;
    } else if (this._bodyOk(nx, this.z)) {
      this.x = nx; this.vz *= 0.5;
    } else if (this._bodyOk(this.x, nz)) {
      this.z = nz; this.vx *= 0.5;
    } else {
      this.vx *= 0.3; this.vz *= 0.3;
      this.stuckT += dt;
    }
    const sp = Math.hypot(this.vx, this.vz);
    if (sp > 0.3) this._turnTo(Math.atan2(this.vx, this.vz), dt, 1.2 + sp * 0.35);
    // bank into turns
    this.roll += (clamp(this._turnRate * -0.25, -0.35, 0.35) - this.roll) * Math.min(1, dt * 2);
  }

  _turnTo(want, dt, rate) {
    const dy = wrapAngle(want - this.yaw);
    const step = clamp(dy, -rate * dt, rate * dt);
    this.yaw = wrapAngle(this.yaw + step);
    this._turnRate = step / Math.max(dt, 1e-4);
  }

  _bodyOk(x, z, m = 1.2) {
    const L = this.level;
    const c = (px, pz) => {
      const ch = L.ch(Math.floor(px / 2), Math.floor(pz / 2));
      return ch === '~' || ch === 'O';
    };
    return c(x, z) && c(x + m, z) && c(x - m, z) && c(x, z + m) && c(x, z - m)
      && sphereClear(L, x, this.y, z, Math.max(m, 2.0));
  }

  // ------------------------------------------------------------------ body

  _savePose(out, t) {
    POSE_KEYS.forEach((key, i) => { out[i] = this[key]; });
    out[POSE_KEYS.length] = t;
  }

  _poseClear() {
    const level = this.level, matrix = this.headMesh.matrixWorld;
    if (!this.headCollider.clear(level, matrix) || !this.mantleCollider.clear(level, this.mantleMesh.matrixWorld)) return false;
    for (const limb of this.limbs) {
      _a.copy(limb.rootLocal).applyMatrix4(matrix);
      const radius = Math.max(...limb.chain.r) + 0.04 + limb.chain.seg * 0.125;
      if (!sphereClear(level, _a.x, _a.y, _a.z, radius)) return false;
    }
    return true;
  }

  /** Sweep translation and rotation together; lunges and in-place turns obey the same bounds. */
  _moveBody(t) {
    const x = this.safePose[0], z = this.safePose[2];
    this._savePose(this.goalPose, t);
    const wanted = Math.hypot(this.goalPose[0] - x, this.goalPose[2] - z);
    if (this._sweepBody() < 1) {
      // Keep sliding when there is room to move but not yet enough room to turn.
      for (let i = 3; i < this.goalPose.length; i++) this.goalPose[i] = this.safePose[i];
      if (this._sweepBody() < 1) {
        this.goalPose[1] = this.safePose[1];
        this._sweepBody();
      }
      if (wanted > 1e-5 && Math.hypot(this.x - x, this.z - z) < wanted * 0.1) {
        this.vx *= 0.3; this.vz *= 0.3;
        this.path = null;
        this.noPathT = 0.25;
      }
    }
  }

  _sweepBody() {
    const from = this.safePose, to = this.goalPose;
    const t = to[POSE_KEYS.length];
    const apply = (k) => {
      POSE_KEYS.forEach((key, i) => {
        const delta = key === 'yaw' ? wrapAngle(to[i] - from[i]) : to[i] - from[i];
        this[key] = from[i] + delta * k;
      });
      this._place(from[POSE_KEYS.length] + (t - from[POSE_KEYS.length]) * k);
    };
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const turn = Math.abs(wrapAngle(to[3] - from[3])) + Math.abs(to[4] - from[4]) + Math.abs(to[5] - from[5]);
    const steps = Math.max(1, Math.ceil((distance + turn * 12) / 0.15));
    let safe = 0;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      apply(k);
      if (this._poseClear()) { safe = k; continue; }
      let blocked = k;
      for (let j = 0; j < 8; j++) {
        const mid = (safe + blocked) / 2;
        apply(mid);
        if (this._poseClear()) safe = mid;
        else blocked = mid;
      }
      break;
    }
    apply(safe);
    this._savePose(this.safePose, from[POSE_KEYS.length] + (t - from[POSE_KEYS.length]) * safe);
    return safe;
  }

  _jet(dt) {
    const sp = Math.hypot(this.vx, this.vz);
    this.jetPh += dt * (0.35 + sp * 0.22);
    const c = Math.pow(Math.max(0, Math.sin(this.jetPh * Math.PI * 2)), 3);
    if (c > 0.85 && !this.jetPuffed && sp > 1) {
      this.jetPuffed = true;
      this._trailAt(10.5, _p0);
      this.fx.bubbles.spawn(_p0.x, _p0.y, _p0.z, 10, 0.7, 1.4);
    }
    if (c < 0.2) this.jetPuffed = false;
    this.jetC = c;
  }

  _trailPush() {
    const tr = this.trail;
    const last = tr[0];
    if (last && Math.hypot(last.x - this.x, last.y - this.y, last.z - this.z) < 0.3) return;
    const v = tr.length >= TRAIL_MAX ? tr.pop() : new THREE.Vector3();
    v.set(this.x, this.y, this.z);
    tr.unshift(v);
  }

  /** Point `dist` metres back along the path the head has swum. */
  _trailAt(dist, out) {
    let px = this.x, py = this.y, pz = this.z, acc = 0;
    for (const q of this.trail) {
      const seg = Math.hypot(q.x - px, q.y - py, q.z - pz);
      if (seg > 1e-5 && acc + seg >= dist) {
        const f = (dist - acc) / seg;
        return out.set(px + (q.x - px) * f, py + (q.y - py) * f, pz + (q.z - pz) * f);
      }
      acc += seg;
      px = q.x; py = q.y; pz = q.z;
    }
    const e = dist - acc;
    return out.set(px - Math.sin(this.yaw) * e, py, pz - Math.cos(this.yaw) * e);
  }

  _place(t) {
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.set(-this.pitch + Math.sin(t * 0.7) * 0.03, this.yaw + Math.sin(t * 0.43) * 0.04, this.roll, 'YXZ');
    this.root.updateMatrixWorld(true);
    // the mantle hangs off the back of the head and follows the path through corners
    this._trailAt(2.4, _p0);
    this._trailAt(6.3, _p1);
    _mz.subVectors(_p0, _p1);
    if (_mz.lengthSq() < 1e-6) _mz.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _mz.normalize();
    _mx.crossVectors(_up, _mz);
    if (_mx.lengthSq() < 1e-6) _mx.set(1, 0, 0);
    _mx.normalize();
    _my.crossVectors(_mz, _mx);
    _m4.makeBasis(_mx, _my, _mz);
    const m = this.mantleMesh;
    m.position.copy(_p1);
    m.position.y += 0.35;
    m.quaternion.setFromRotationMatrix(_m4);
    const c = this.jetC;
    m.scale.set(1 - c * 0.11, 1 - c * 0.08, 1 + c * 0.04);
    m.updateMatrixWorld(true);
    this.headMesh.localToWorld(this.maw.copy(this.mawLocal));
  }

  _simArms(dt, t) {
    const m = this.headMesh.matrixWorld;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = fz, rz = -fx;
    const fl = this.flare;
    const nz = this.noise;
    const mw = this.maw;
    const k = 1 - Math.exp(-dt * (0.7 + fl * 7));
    for (const a of this.arms) {
      const c = a.chain;
      _a.copy(a.rootLocal).applyMatrix4(m);
      _b.copy(a.dirLocal).transformDirection(m);
      c.integrate(dt, 0.88, 0, -0.5, 0);
      for (let i = 1; i < c.n; i++) {
        const s = i * c.seg, tt = i / (c.n - 1), o = i * 3;
        let tx = _a.x - fx * s * 0.92 + rx * a.side * s * 0.22;
        let ty = _a.y - s * 0.2;
        let tz = _a.z - fz * s * 0.92 + rz * a.side * s * 0.22;
        if (fl > 0.01) {
          // open like a flower around the grin, feeding tentacles reaching furthest
          const r = s * 0.5, f = s * (a.long ? 0.8 : 0.5);
          tx += (mw.x + fx * f + rx * a.fx * r - tx) * fl;
          ty += (mw.y + a.fy * r - ty) * fl;
          tz += (mw.z + fz * f + rz * a.fx * r - tz) * fl;
        }
        const amp = (0.2 + 1.2 * tt * tt) * (1 - fl * 0.5);
        const q = i * 0.3 + a.seed, w = t * (0.55 + fl);
        c.pull(
          i,
          tx + (nz(q, w, 0.5) - 0.5) * 2 * amp,
          ty + (nz(q, w, 9.5) - 0.5) * 1.6 * amp,
          tz + (nz(q, w, 17.5) - 0.5) * 2 * amp,
          k * (0.35 + 0.65 * tt),
        );
        if (c.p[o + 1] > 0.2 + fl * 2) c.p[o + 1] -= (c.p[o + 1] - 0.2) * Math.min(1, dt * 3);
      }
      c.constrain(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, 0.05);
      collideChain(this.level, c, true);
      c.frames(0, 1, 0);
      this.armBundle.set(a.k, c);
    }
    this.armBundle.upload();
  }

  _simTendrils(dt, t) {
    const m = this.headMesh.matrixWorld;
    const dt2 = dt * dt;
    const nz = this.noise;
    this.headMesh.getWorldDirection(_fwd);
    const list = this.tendrils;
    for (let k = 0; k < list.length; k++) {
      const f = list[k], c = f.chain;
      _a.copy(f.rootLocal).applyMatrix4(m);
      _b.copy(f.dirLocal).transformDirection(m);
      c.integrate(dt, 0.9, 0, 0, 0);
      for (let i = 1; i < c.n; i++) {
        const o = i * 3;
        const w = 14 * (0.3 + i / (c.n - 1));
        const s = k * 3.1 + i * 0.4;
        c.p[o] += (nz(s, t * 0.8, 0.5) - 0.5) * w * dt2 * 2;
        c.p[o + 1] += ((c.p[o + 1] < 0 ? 0.6 : -7) + (nz(s, t * 0.8, 7.5) - 0.5) * w) * dt2;
        c.p[o + 2] += (nz(s, t * 0.8, 13.5) - 0.5) * w * dt2 * 2;
      }
      c.constrain(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, 0.06);
      collideChain(this.level, c, true);
      c.frames(_fwd.x, _fwd.y, _fwd.z);
      this.tendrilBundle.set(k, c);
    }
    this.tendrilBundle.upload();
  }

  _effects(dt, t, ctx) {
    const aw = Math.min(1, this.awareness);
    const hunting = this.chasing;
    const cam = ctx.camera.position;
    const look = aw > 0.15 || hunting;
    this.eyes.update(dt, look ? cam : null, hunting ? 1 : aw, hunting ? 0.06 : 0.4 - aw * 0.25, 0.8 + aw * 2.2 + (hunting ? 0.8 : 0));

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const lamp = this.lamp;
    lamp.x = this.x + fx * 2.8;
    lamp.y = this.y + 0.8;
    lamp.z = this.z + fz * 2.8;
    lamp.intensity = (0.6 + aw * 2.6) * (0.9 + 0.1 * Math.sin(t * 6.1 + this.jetPh));

    const L = this.level;
    const tx = Math.floor(this.x / 2), tz = Math.floor(this.z / 2);
    const lum = this.lightGrid[tz * L.W + tx] || 0;
    this.probe.value.setRGB(0.02 + lum * 0.04, 0.024 + lum * 0.03, 0.028 + lum * 0.02);

    // a hump pushing the surface when it swims shallow
    this.rippleT -= dt;
    if (this.rippleT <= 0 && this.y > -2.6 && this.state !== 'lunge') {
      const sp = Math.hypot(this.vx, this.vz);
      this.rippleT = 0.3;
      this.water.addRipple(this.x + fx * 1.5, this.z + fz * 1.5, 0.35 + sp * 0.12 + (this.y + 2.6) * 0.3);
    }

    this.voice.setPosition(this.x, this.y, this.z);
    this.voice.setSpeed(Math.hypot(this.vx, this.vz) / SPEED.chase);
    this.voice.update(dt);
  }
}
