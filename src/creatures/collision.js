import * as THREE from 'three';
import { DECK_BOTTOM, ABYSS_WALL_BOTTOM } from '../level/level.js';

/** The abyss opens into a cavern below the rendered wall bottoms. */
export function abyssTerrain(level) {
  return {
    solid: (x, z) => level.solid(x, z), floor: (x, z) => level.floor(x, z),
    ceil: (x, z) => level.ceil(x, z), deckTop: (x, z) => level.deckTop(x, z),
    openBelow: ABYSS_WALL_BOTTOM,
  };
}

/** Recheck obstruction at the actual contact point, including the two endpoints. */
export function attackClear(level, from, to) {
  return sphereTravel(level, from.x, from.y, from.z, to.x, to.y, to.z, 0.025) === 1;
}

/** Test the whole sphere against nearby walls, floor steps, ceilings and catwalk slabs. */
export function sphereClear(level, x, y, z, radius) {
  if (level.openBelow !== undefined && y + radius < level.openBelow) return true;
  const r2 = radius * radius;
  for (let tz = Math.floor((z - radius) / 2); tz <= Math.floor((z + radius) / 2); tz++) {
    for (let tx = Math.floor((x - radius) / 2); tx <= Math.floor((x + radius) / 2); tx++) {
      const dx = x - Math.max(tx * 2, Math.min(tx * 2 + 2, x));
      const dz = z - Math.max(tz * 2, Math.min(tz * 2 + 2, z));
      const horizontal = dx * dx + dz * dz;
      if (horizontal >= r2) continue;
      if (level.solid(tx, tz)) return false;
      const h = Math.sqrt(r2 - horizontal);
      if (y - h < level.floor(tx, tz) || y + h > level.ceil(tx, tz)) return false;
      const deck = level.deckTop?.(tx, tz);
      if (deck != null && y + h > DECK_BOTTOM && y - h < deck) return false;
    }
  }
  return true;
}

/** Nearest clear sphere placement. Used for spawn fitting and soft, trailing appendages. */
export function fitSphere(level, p, radius, search = 3) {
  if (sphereClear(level, p.x, p.y, p.z, radius)) return true;
  let best = Infinity, bx = p.x, by = p.y, bz = p.z;
  const tx = Math.floor(p.x / 2), tz = Math.floor(p.z / 2);
  const consider = (x, y, z) => {
    const d = (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2;
    if (d >= best || !sphereClear(level, x, y, z, radius)) return;
    best = d; bx = x; by = y; bz = z;
  };
  if (level.openBelow !== undefined) consider(p.x, Math.min(p.y, level.openBelow - radius - 0.01), p.z);
  for (let dz = -search; dz <= search; dz++) for (let dx = -search; dx <= search; dx++) {
    const x = tx + dx, z = tz + dz;
    if (level.solid(x, z)) continue;
    const lo = level.floor(x, z) + radius + 0.015, hi = level.ceil(x, z) - radius - 0.015;
    if (lo > hi) continue;
    const ys = [Math.max(lo, Math.min(hi, p.y))];
    const deck = level.deckTop?.(x, z);
    if (deck != null) ys.push(DECK_BOTTOM - radius - 0.015, deck + radius + 0.015);
    const xs = [Math.max(x * 2 + radius + 0.015, Math.min(x * 2 + 2 - radius - 0.015, p.x)), x * 2 + 1];
    const zs = [Math.max(z * 2 + radius + 0.015, Math.min(z * 2 + 2 - radius - 0.015, p.z)), z * 2 + 1];
    for (const xx of xs) for (const zz of zs) for (const yy of ys) consider(xx, yy, zz);
  }
  if (!Number.isFinite(best)) return false;
  p.set(bx, by, bz);
  return true;
}

/** Slide a moving sphere along terrain without crossing a thin slab or a wall. */
export function moveSphere(level, from, to, radius) {
  const x = to.x, y = to.y, z = to.z;
  const k = sphereTravel(level, from.x, from.y, from.z, x, y, z, radius);
  to.copy(from).lerp({ x, y, z }, k);
  if (k === 1) return 1;
  for (const [axis, value] of [['x', x], ['z', z], ['y', y]]) {
    const ax = to.x, ay = to.y, az = to.z;
    to[axis] = value;
    const f = sphereTravel(level, ax, ay, az, to.x, to.y, to.z, radius);
    to.set(ax + (to.x - ax) * f, ay + (to.y - ay) * f, az + (to.z - az) * f);
  }
  return k;
}

/** Clamp a proposed hierarchy pose to its last clear pose; includes turns and bone animation. */
export class PoseGuard {
  constructor(objects, clear, refresh, radius = 1, worldFirst = true) {
    this.objects = objects; this.clear = clear; this.refresh = refresh; this.radius = radius;
    this.worldFirst = worldFirst;
    this.safe = this._snapshot(); this.goal = this._snapshot(); this.ready = false;
  }
  _snapshot() { return this.objects.map((o) => ({ p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() })); }
  _copy(out) { this.objects.forEach((o, i) => { out[i].p.copy(o.position); out[i].q.copy(o.quaternion); out[i].s.copy(o.scale); }); }
  reset() { this.refresh(); this.ready = this.clear(); if (this.ready) this._copy(this.safe); return this.ready; }
  apply(k) {
    this.objects.forEach((o, i) => {
      o.position.lerpVectors(this.safe[i].p, this.goal[i].p, k);
      o.quaternion.slerpQuaternions(this.safe[i].q, this.goal[i].q, k);
      o.scale.lerpVectors(this.safe[i].s, this.goal[i].s, k);
    });
    this.refresh();
  }
  constrain() {
    if (!this.ready) return this.reset() ? 1 : 0;
    this._copy(this.goal);
    let motion = 0;
    for (let i = 0; i < this.safe.length; i++) {
      motion = Math.max(motion, this.safe[i].p.distanceTo(this.goal[i].p) * (i || !this.worldFirst ? this.radius : 1)
        + this.safe[i].q.angleTo(this.goal[i].q) * this.radius);
    }
    const steps = Math.max(1, Math.ceil(motion / 0.12));
    let safe = 0;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      this.apply(k);
      if (this.clear()) { safe = k; continue; }
      let blocked = k;
      for (let j = 0; j < 8; j++) {
        const mid = (safe + blocked) / 2;
        this.apply(mid);
        if (this.clear()) safe = mid; else blocked = mid;
      }
      break;
    }
    this.apply(safe); this._copy(this.safe);
    return safe;
  }
}

/** First unobstructed portion of a swept sphere. Sampling is finer than the thinnest slab. */
export function sphereTravel(level, ax, ay, az, bx, by, bz, radius) {
  if (!sphereClear(level, ax, ay, az, radius)) return 0;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / 0.12));
  let safe = 0;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    if (sphereClear(level, ax + dx * k, ay + dy * k, az + dz * k, radius)) {
      safe = k;
      continue;
    }
    let blocked = k;
    for (let j = 0; j < 10; j++) {
      const mid = (safe + blocked) / 2;
      if (sphereClear(level, ax + dx * mid, ay + dy * mid, az + dz * mid, radius)) safe = mid;
      else blocked = mid;
    }
    return Math.max(0, safe - 1e-4);
  }
  return 1;
}

const point = new THREE.Vector3();

/** Overlapping spheres enclosing slices of the actual mesh, including a skin margin. */
export class BodyCollider {
  constructor(geometry, margin = 0.15) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const span = box.max.z - box.min.z;
    const count = Math.max(1, Math.ceil(span / 0.5));
    const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2;
    this.spheres = Array.from({ length: count }, (_, i) => ({
      center: new THREE.Vector3(cx, cy, box.min.z + (i + 0.5) * span / count), radius: 0,
    }));
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      point.fromBufferAttribute(pos, i);
      const bin = Math.min(count - 1, Math.floor((point.z - box.min.z) / (span || 1) * count));
      const sphere = this.spheres[bin];
      sphere.radius = Math.max(sphere.radius, sphere.center.distanceTo(point) + margin);
    }
    this.spheres = this.spheres.filter((s) => s.radius > 0);
    this.radius = Math.max(...this.spheres.map((s) => s.radius));
  }

  clear(level, matrix) {
    const scale = matrix.getMaxScaleOnAxis();
    for (const s of this.spheres) {
      point.copy(s.center).applyMatrix4(matrix);
      if (!sphereClear(level, point.x, point.y, point.z, s.radius * scale)) return false;
    }
    return true;
  }
}
