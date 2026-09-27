import * as THREE from 'three';
import { DECK_BOTTOM } from './level/level.js';

const R = 0.32;
const STAND_EYE = 1.62;
const CROUCH_EYE = 1.02;
const SURFACE_EYE = 0.26;
const BREATH_MAX = 30;
const DIVE_LIMIT_ABYSS = -15;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();

/**
 * First-person controller: walking on decks, surface swimming, free diving and ledge climbing.
 * pos is the eye position.
 */
export class Player {
  constructor(level, camera) {
    this.level = level;
    this.camera = camera;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.mode = 'ground'; // ground | air | surface | under | climb
    this.eyeH = STAND_EYE;
    this.crouch = false;
    this.sprint = false;
    this.flashlight = false;
    this.breath = BREATH_MAX;
    this.breathMax = BREATH_MAX;
    this.drownT = 0;
    this.bobT = 0;
    this.stepDist = 0;
    this.speed = 0;
    this.climb = null;
    this.frozen = false;
    this.fallStartY = 0;
    this.wetT = 0;
    this.shake = 0;
    this.roll = 0;
    this.depthWarn = 0;
    this.stepY = 0; // camera lag after snapping up or down a stair step
    this.events = []; // {type, ...} consumed by the game each frame
  }

  get underwater() { return this.mode === 'under'; }
  get inWater() { return this.mode === 'surface' || this.mode === 'under'; }
  get tileX() { return Math.floor(this.pos.x / 2); }
  get tileZ() { return Math.floor(this.pos.z / 2); }

  spawn(x, z, yaw) {
    const tx = Math.floor(x / 2), tz = Math.floor(z / 2);
    const water = this.level.isWater(tx, tz);
    this.pos.set(x, water ? SURFACE_EYE : this.level.floor(tx, tz) + STAND_EYE, z);
    this.vel.set(0, 0, 0);
    this.mode = water ? 'surface' : 'ground';
    this.eyeH = STAND_EYE;
    this.crouch = false;
    this.yaw = yaw;
    this.pitch = 0;
    this.breath = BREATH_MAX;
    this.drownT = 0;
    this.climb = null;
    this.shake = 0;
    this.stepY = 0;
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }

  _tileBlocks(tx, tz, yMin, yMax) {
    const L = this.level;
    if (L.solid(tx, tz)) return true;
    const dk = L.deckTop(tx, tz);
    if (dk !== null && yMin < dk && yMax > DECK_BOTTOM) return true;
    return L.floor(tx, tz) > yMin || L.ceil(tx, tz) < yMax;
  }

  /** Push a circle out of blocking tiles. */
  _collide(yMin, yMax) {
    const p = this.pos;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const x0 = Math.floor((p.x - R) / 2), x1 = Math.floor((p.x + R) / 2);
      const z0 = Math.floor((p.z - R) / 2), z1 = Math.floor((p.z + R) / 2);
      for (let tz = z0; tz <= z1; tz++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (!this._tileBlocks(tx, tz, yMin, yMax)) continue;
          const bx0 = tx * 2, bx1 = bx0 + 2, bz0 = tz * 2, bz1 = bz0 + 2;
          const cx = Math.max(bx0, Math.min(p.x, bx1));
          const cz = Math.max(bz0, Math.min(p.z, bz1));
          let dx = p.x - cx, dz = p.z - cz;
          const d = Math.hypot(dx, dz);
          if (d >= R) continue;
          if (d < 1e-5) {
            // centre inside the box: leave by the nearest side
            const opts = [[p.x - bx0, -1, 0], [bx1 - p.x, 1, 0], [p.z - bz0, 0, -1], [bz1 - p.z, 0, 1]];
            opts.sort((a, b) => a[0] - b[0]);
            const [pen, sx, sz] = opts[0];
            p.x += sx * (pen + R);
            p.z += sz * (pen + R);
          } else {
            dx /= d; dz /= d;
            p.x += dx * (R - d);
            p.z += dz * (R - d);
            // remove velocity into the wall
            const vn = this.vel.x * dx + this.vel.z * dz;
            if (vn < 0) { this.vel.x -= vn * dx; this.vel.z -= vn * dz; }
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  look(mx, my) {
    if (this.frozen) return;
    this.yaw -= mx * 0.0022;
    this.pitch -= my * 0.0022;
    this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch));
  }

  /** Forward-facing dry ledge the player can climb onto from the water, or null. */
  climbTarget() {
    if (this.mode !== 'surface') return null;
    const L = this.level;
    // no climbing up through a catwalk from beneath it
    if (L.deckTop(this.tileX, this.tileZ) !== null) return null;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    for (const reach of [0.75, 1.1]) {
      const x = this.pos.x + _fwd.x * reach, z = this.pos.z + _fwd.z * reach;
      const tx = Math.floor(x / 2), tz = Math.floor(z / 2);
      const dk = L.deckTop(tx, tz);
      if (L.solid(tx, tz) || (L.isWater(tx, tz) && dk === null)) continue;
      const f = dk ?? L.floor(tx, tz);
      if (f > 1.2 || L.ceil(tx, tz) - f < 1.3) continue;
      const [cx, cz] = L.worldCenter(tx, tz);
      // land just inside the tile edge
      const bx = Math.max(tx * 2 + 0.45, Math.min(x + _fwd.x * 0.35, tx * 2 + 1.55));
      const bz = Math.max(tz * 2 + 0.45, Math.min(z + _fwd.z * 0.35, tz * 2 + 1.55));
      return { x: bx, z: bz, y: f, cx, cz };
    }
    return null;
  }

  update(dt, input) {
    const L = this.level;
    const p = this.pos;
    this.events.length = 0;
    const [mx, my] = input.consumeMouse();
    this.look(mx, my);
    if (this.frozen) {
      this._applyCamera(dt);
      return;
    }

    const fwdIn = (input.any('KeyW', 'ArrowUp') ? 1 : 0) - (input.any('KeyS', 'ArrowDown') ? 1 : 0);
    const sideIn = (input.any('KeyD', 'ArrowRight') ? 1 : 0) - (input.any('KeyA', 'ArrowLeft') ? 1 : 0);
    const wantSprint = input.any('ShiftLeft', 'ShiftRight');
    const crouchKey = input.any('KeyC', 'ControlLeft', 'ControlRight');
    const jumpKey = input.key('Space');
    const jumpHit = input.hit('Space');
    if (input.hit('KeyF')) {
      this.flashlight = !this.flashlight;
      this.emit('flashlight', { on: this.flashlight });
    }

    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0).addScaledVector(_fwd, fwdIn).addScaledVector(_right, sideIn);
    if (_wish.lengthSq() > 1) _wish.normalize();
    const moving = _wish.lengthSq() > 0.01;

    const tx = Math.floor(p.x / 2), tz = Math.floor(p.z / 2);
    const water = L.isWater(tx, tz);

    if (this.mode === 'climb') {
      const c = this.climb;
      c.t += dt / c.dur;
      const t = Math.min(1, c.t);
      const up = Math.min(1, t / 0.55);
      const fw = Math.max(0, (t - 0.35) / 0.65);
      const eu = 1 - Math.pow(1 - up, 3);
      const ef = fw * fw * (3 - 2 * fw);
      p.x = c.from.x + (c.to.x - c.from.x) * ef;
      p.z = c.from.z + (c.to.z - c.from.z) * ef;
      p.y = c.from.y + (c.to.y - c.from.y) * eu + Math.sin(t * Math.PI) * 0.18;
      this.pitch += (-0.25 - this.pitch) * Math.min(1, dt * 3) * (t < 0.5 ? 1 : 0);
      if (t >= 1) {
        this.mode = 'ground';
        this.climb = null;
        this.vel.set(0, 0, 0);
        this.eyeH = STAND_EYE;
        this.wetT = 6;
      }
      this.speed = 0;
      this._breathe(dt);
      this._applyCamera(dt);
      return;
    }

    if (this.mode === 'ground' || this.mode === 'air') {
      this.crouch = crouchKey || (this.crouch && L.ceil(tx, tz) - L.floor(tx, tz) < STAND_EYE + 0.25);
      this.sprint = wantSprint && !this.crouch && fwdIn > 0;
      const targetEye = this.crouch ? CROUCH_EYE : STAND_EYE;
      const prevEye = this.eyeH;
      this.eyeH += (targetEye - this.eyeH) * Math.min(1, dt * 10);
      if (this.mode === 'ground') p.y += this.eyeH - prevEye;
      const spd = this.crouch ? 1.6 : this.sprint ? 5.4 : 3.2;
      const k = this.mode === 'ground' ? 12 : 1.5;
      this.vel.x += (_wish.x * spd - this.vel.x) * Math.min(1, dt * k);
      this.vel.z += (_wish.z * spd - this.vel.z) * Math.min(1, dt * k);
      if (this.mode === 'ground' && jumpHit && !this.crouch) {
        this.vel.y = 4.0;
        this.mode = 'air';
        this.fallStartY = p.y;
        this.emit('jump');
      }
      this.vel.y -= 16 * dt * (this.mode === 'air' ? 1 : 0);
      p.x += this.vel.x * dt;
      p.z += this.vel.z * dt;
      p.y += this.vel.y * dt;
      const feet = p.y - this.eyeH;
      this._collide(feet + 0.6, p.y + 0.12);
      const ntx = Math.floor(p.x / 2), ntz = Math.floor(p.z / 2);
      const deck = L.deckTop(ntx, ntz);
      const onDeck = deck !== null && feet > deck - 0.5;
      const nWater = L.isWater(ntx, ntz) && !onDeck;
      const floor = onDeck ? deck : nWater ? -99 : L.floor(ntx, ntz);
      const ceil = L.ceil(ntx, ntz);
      if (p.y + 0.12 > ceil && this.vel.y > 0) { this.vel.y = 0; p.y = ceil - 0.12; }
      const nfeet = p.y - this.eyeH;
      if (this.mode === 'ground') {
        const drop = nfeet - floor;
        if (drop > 0.05 && (nWater || drop > 0.62)) {
          this.mode = 'air';
          this.fallStartY = p.y;
          this.vel.y = 0;
        } else {
          // walk up and down stair steps, smoothing the snap on the camera
          const ny = floor + this.eyeH;
          this.stepY = Math.max(-0.7, Math.min(0.7, this.stepY + p.y - ny));
          p.y = ny;
        }
      }
      if (this.mode === 'air') {
        if (!nWater && nfeet <= floor) {
          p.y = floor + this.eyeH;
          const fell = this.fallStartY - p.y;
          this.mode = 'ground';
          this.vel.y = 0;
          this.emit('land', { hard: fell > 1.2 });
        } else if (nWater && nfeet < 0) {
          // entering the water
          const quiet = this.crouch && this.fallStartY - p.y < 1.9;
          this.mode = 'surface';
          this.vel.y = Math.min(this.vel.y, -1.5);
          this.vel.multiplyScalar(quiet ? 0.3 : 0.5);
          this.emit('splash', { quiet, x: p.x, z: p.z });
          this.crouch = false;
          this.eyeH = STAND_EYE;
        }
      }
      this.speed = Math.hypot(this.vel.x, this.vel.z);
      if (this.mode === 'ground' && this.speed > 0.3) {
        this.bobT += dt * this.speed * 2.1;
        this.stepDist += this.speed * dt;
        const stride = this.sprint ? 1.7 : this.crouch ? 0.9 : 1.35;
        if (this.stepDist > stride) {
          this.stepDist = 0;
          this.emit('step', { sprint: this.sprint, crouch: this.crouch, wet: this.wetT > 0 });
        }
      }
      this.wetT = Math.max(0, this.wetT - dt);
    } else if (this.mode === 'surface') {
      this.crouch = false;
      this.sprint = wantSprint && moving;
      const spd = this.sprint ? 3.2 : 2.0;
      this.vel.x += (_wish.x * spd - this.vel.x) * Math.min(1, dt * 2.6);
      this.vel.z += (_wish.z * spd - this.vel.z) * Math.min(1, dt * 2.6);
      // buoyancy back to the surface after a plunge
      const target = SURFACE_EYE;
      this.vel.y += ((target - p.y) * 10 - this.vel.y * 4) * dt;
      p.x += this.vel.x * dt;
      p.z += this.vel.z * dt;
      p.y += this.vel.y * dt;
      this._collide(-1.1, p.y + 0.1);
      this.speed = Math.hypot(this.vel.x, this.vel.z);
      this.bobT += dt * (1.2 + this.speed * 1.2);
      this.stepDist += this.speed * dt;
      if (this.stepDist > (this.sprint ? 1.3 : 1.7)) {
        this.stepDist = 0;
        this.emit('stroke', { sprint: this.sprint, x: p.x, z: p.z });
      }
      const ctx = Math.floor(p.x / 2), ctz = Math.floor(p.z / 2);
      if (!L.isWater(ctx, ctz)) {
        // pushed onto a dry tile edge somehow: stand up there
        this.mode = 'ground';
        p.y = L.floor(ctx, ctz) + STAND_EYE;
      } else if (L.ceil(ctx, ctz) < 0.3 || crouchKey) {
        this.mode = 'under';
        this.vel.y = -2.2;
        p.y = Math.min(p.y, -0.35);
        this.emit('dive', { x: p.x, z: p.z });
      } else if (jumpHit) {
        const c = this.climbTarget();
        if (c) {
          this.mode = 'climb';
          this.climb = { t: 0, dur: 0.95, from: p.clone(), to: new THREE.Vector3(c.x, c.y + STAND_EYE, c.z) };
          this.vel.set(0, 0, 0);
          this.emit('climb', { x: p.x, z: p.z });
        }
      }
    } else if (this.mode === 'under') {
      this.crouch = false;
      this.sprint = wantSprint && moving;
      const spd = this.sprint ? 3.5 : 2.4;
      // swim along the view direction
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const look = new THREE.Vector3(-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp);
      const wish3 = new THREE.Vector3().addScaledVector(look, fwdIn).addScaledVector(_right, sideIn);
      if (jumpKey) wish3.y += 1;
      if (crouchKey) wish3.y -= 1;
      if (wish3.lengthSq() > 1) wish3.normalize();
      this.vel.addScaledVector(wish3.multiplyScalar(spd).sub(this.vel), Math.min(1, dt * 2.4));
      // slight natural buoyancy when idle
      if (!moving && !jumpKey && !crouchKey) this.vel.y += 0.25 * dt;
      p.addScaledVector(this.vel, dt);
      this._collide(p.y - 0.45, p.y + 0.3);
      const ctx = Math.floor(p.x / 2), ctz = Math.floor(p.z / 2);
      const fl = L.isWater(ctx, ctz) ? L.floor(ctx, ctz) : 0;
      const ce = L.ceil(ctx, ctz);
      // the abyss is too deep to reach the bottom
      const isAbyss = fl < -20;
      const minY = isAbyss ? DIVE_LIMIT_ABYSS : fl + 0.45;
      if (p.y < minY) {
        p.y = minY;
        if (this.vel.y < 0) this.vel.y = 0;
        if (isAbyss) this.depthWarn = 1.5;
      }
      if (ce < 0.3 && p.y > ce - 0.32) {
        p.y = ce - 0.32;
        if (this.vel.y > 0) this.vel.y = 0;
      }
      this.speed = this.vel.length();
      this.bobT += dt * (0.8 + this.speed);
      this.stepDist += this.speed * dt;
      if (this.stepDist > 2.2) {
        this.stepDist = 0;
        this.emit('uswim', { sprint: this.sprint });
      }
      if (p.y > -0.2 && ce > 0.3) {
        this.mode = 'surface';
        this.vel.y = Math.max(this.vel.y, 0.5);
        this.emit('surface', { gasp: this.breath < this.breathMax * 0.45, x: p.x, z: p.z });
      }
    }
    this.depthWarn = Math.max(0, this.depthWarn - dt);
    this._breathe(dt);
    this._applyCamera(dt);
  }

  _breathe(dt) {
    if (this.mode === 'under') {
      this.breath = Math.max(0, this.breath - dt * (this.sprint ? 1.6 : 1));
      if (this.breath <= 0) {
        this.drownT += dt;
        if (this.drownT > 3.5) this.emit('drown');
      }
    } else {
      this.breath = Math.min(this.breathMax, this.breath + dt * 7);
      this.drownT = 0;
    }
  }

  _applyCamera(dt) {
    const cam = this.camera;
    let bobY = 0, bobX = 0, roll = 0;
    if (this.mode === 'ground') {
      const amp = this.sprint ? 0.065 : this.crouch ? 0.02 : 0.04;
      const s = Math.min(1, this.speed / 3);
      bobY = Math.abs(Math.sin(this.bobT * 1.0)) * amp * s * 1.4 - amp * s * 0.7;
      bobX = Math.sin(this.bobT * 0.5 * 2) * amp * 0.6 * s;
    } else if (this.mode === 'surface') {
      bobY = Math.sin(this.bobT * 1.4) * 0.045 + Math.sin(this.bobT * 0.53) * 0.03;
      roll = Math.sin(this.bobT * 0.9) * 0.035;
    } else if (this.mode === 'under') {
      bobY = Math.sin(this.bobT * 0.9) * 0.03;
      roll = Math.sin(this.bobT * 0.4) * 0.05;
    }
    this.roll += (roll - this.roll) * Math.min(1, dt * 3);
    this.stepY *= Math.exp(-12 * dt);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const sh = this.shake * this.shake;
    const t = performance.now() * 0.001;
    cam.position.set(
      this.pos.x + bobX * Math.cos(this.yaw) + Math.sin(t * 37) * sh * 0.05,
      this.pos.y + bobY + this.stepY + Math.sin(t * 29) * sh * 0.05,
      this.pos.z - bobX * Math.sin(this.yaw),
    );
    // keep the eye clear of the surface plane while swimming on top
    if (this.mode === 'surface' && cam.position.y < 0.1) cam.position.y = 0.1;
    cam.rotation.set(this.pitch + Math.sin(t * 23) * sh * 0.02, this.yaw, this.roll, 'YXZ');
  }
}
