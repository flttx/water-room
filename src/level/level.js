import { MAP, W, H, TILE, HALLS, DARK_ZONES, SIGNS, LIFT, ABYSS, RESERVOIR } from './mapdata.js';

const WATER = new Set(['~', 'O', 'u', 'a', '-', 'l', 'R', 'Q', '=']);
const OPEN_WATER = new Set(['~', 'O']);
const DRY_FLOOR = 0.6;

export const DECK_Y = DRY_FLOOR;
export const ABYSS_WALL_BOTTOM = -18;
export const ABYSS_FLOOR = -90;
// the reservoir basin is deep but reachable: the crab walks on its floor
export const RESERVOIR_FLOOR = -10;
// catwalk slab over the reservoir water: walk on DECK_TOP, swim beneath DECK_BOTTOM
export const DECK_TOP = 1.0;
export const DECK_BOTTOM = 0.7;
const DECK_MID = (DECK_TOP + DECK_BOTTOM) / 2;

/** Tile grid with height queries, line-of-sight and creature navigation. */
export class Level {
  constructor() {
    this.W = W;
    this.H = H;
    this.tile = TILE;
    this.chars = MAP.map((r) => [...r]);
    this.dynamicOpen = new Set(); // opened doors / gate chars
    this.floorH = new Float32Array(W * H);
    this.ceilH = new Float32Array(W * H);
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        this.floorH[z * W + x] = this._floorOf(x, z);
        this.ceilH[z * W + x] = this._ceilOf(x, z);
      }
    }
    this.signs = SIGNS;
    this.darkZones = DARK_ZONES;
    this.abyss = ABYSS;
    this.reservoir = RESERVOIR;
    this._buildNav();
  }

  ch(x, z) {
    if (x < 0 || z < 0 || x >= W || z >= H) return '#';
    return this.chars[z][x];
  }

  inHall(x, z) {
    for (const [x0, z0, x1, z1, c] of HALLS) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return c;
    return 0;
  }

  _floorOf(x, z) {
    const c = this.ch(x, z);
    if (c === '~') return -7;
    if (c === 'O') return ABYSS_FLOOR;
    if (c === 'u' || c === 'a') return -5.5;
    if (c === '-') return -1.5;
    if (c === 'l') return -3.5;
    if (c === 'R') return -5;
    if (c === 'Q') return RESERVOIR_FLOOR;
    if (c === '=') {
      const [x0, z0, x1, z1] = RESERVOIR.basin;
      return x >= x0 && x <= x1 && z >= z0 && z <= z1 ? RESERVOIR_FLOOR : -5;
    }
    return LIFT.get(z * W + x) ?? DRY_FLOOR;
  }

  _ceilOf(x, z) {
    const c = this.ch(x, z);
    if (c === 'u') return -1.3;
    if (c === 'a') return 2.2;
    if (c === 'l') return 0.85;
    if (c === 'E' || c === 'X' || c === 'G') return 6.4;
    const lift = LIFT.get(z * W + x);
    const base = this._baseCeil(x, z, c);
    return lift === undefined ? base : Math.max(base, lift + 2.6);
  }

  _baseCeil(x, z, c) {
    const hall = this.inHall(x, z);
    if (hall) return hall;
    if (c === ',' || c === 'S' || c === 'C' || c === 'D') return 3.2;
    // arch beams give the long channels a rhythm
    if (x % 6 === 0 || z % 6 === 0) return 5.6;
    return 7;
  }

  isSolidChar(c) {
    if (c === '#' || c === 'P') return true;
    if ((c === 'G' || c === 'D') && !this.dynamicOpen.has(c)) return true;
    return false;
  }

  solid(x, z) { return this.isSolidChar(this.ch(x, z)); }
  isWater(x, z) { return WATER.has(this.ch(x, z)); }
  /** Walking height of a catwalk tile, or null. */
  deckTop(x, z) { return this.ch(x, z) === '=' ? DECK_TOP : null; }
  floor(x, z) { return (x < 0 || z < 0 || x >= W || z >= H) ? 999 : this.floorH[z * W + x]; }
  ceil(x, z) { return (x < 0 || z < 0 || x >= W || z >= H) ? -999 : this.ceilH[z * W + x]; }

  open(ch) { this.dynamicOpen.add(ch); }

  /** tile index from world coordinate */
  tx(x) { return Math.floor(x / TILE); }

  /** Is the world point inside rock (walls, below floor, above ceiling)? */
  blockedAt(x, y, z) {
    const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
    if (this.solid(tx, tz)) return true;
    const i = tz * W + tx;
    if (y > DECK_BOTTOM && y < DECK_TOP && this.chars[tz][tx] === '=') return true;
    return y < this.floorH[i] || y > this.ceilH[i];
  }

  /** Segment test through the grid (sampled). */
  segmentClear(ax, ay, az, bx, by, bz, step = 0.45) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.blockedAt(ax + dx * t, ay + dy * t, az + dz * t)) return false;
    }
    // a thin catwalk slab can fall between two samples
    if ((ay - DECK_MID) * (by - DECK_MID) < 0) {
      const t = (DECK_MID - ay) / dy;
      if (this.ch(Math.floor((ax + dx * t) / TILE), Math.floor((az + dz * t) / TILE)) === '=') return false;
    }
    return true;
  }

  worldCenter(x, z) { return [(x + 0.5) * TILE, (z + 0.5) * TILE]; }

  find(ch) {
    const out = [];
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (this.chars[z][x] === ch) out.push([x, z]);
    return out;
  }

  /** Direction (dx,dz) of an adjacent solid wall for wall-mounted objects. */
  wallDir(x, z) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (const [dx, dz] of dirs) if (this.ch(x + dx, z + dz) === '#') return [dx, dz];
    for (const [dx, dz] of dirs) if (this.solid(x + dx, z + dz)) return [dx, dz];
    return [0, -1];
  }

  isDark(x, z) {
    for (const [x0, z0, x1, z1] of DARK_ZONES) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return true;
    return false;
  }

  // ------------------------------------------------------------------ navigation
  _buildNav() {
    const core = new Uint8Array(W * H);
    for (let z = 1; z < H - 1; z++) {
      for (let x = 1; x < W - 1; x++) {
        let ok = true;
        for (let dz = -1; dz <= 1 && ok; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!OPEN_WATER.has(this.ch(x + dx, z + dz))) { ok = false; break; }
          }
        }
        core[z * W + x] = ok ? 1 : 0;
      }
    }
    this.core = core;
    this.coreList = [];
    for (let i = 0; i < W * H; i++) if (core[i]) this.coreList.push(i);
    this.abyssCore = this.coreList.filter((i) => this.ch(i % W, (i / W) | 0) === 'O');
  }

  isCore(x, z) { return x >= 0 && z >= 0 && x < W && z < H && this.core[z * W + x] === 1; }

  /** Nearest core tile to a world position (ring search outward); allow(i) optionally restricts tiles. */
  nearestCore(wx, wz, maxR = 12, allow = null) {
    const cx = Math.floor(wx / TILE), cz = Math.floor(wz / TILE);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = cx + dx, z = cz + dz;
          if (!this.isCore(x, z) || (allow && !allow(z * W + x))) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = z * W + x; }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  /** A* over core water tiles; returns array of [wx, wz] or null. allow(i) optionally restricts tiles. */
  findPath(fromIdx, toIdx, allow = null) {
    if (fromIdx < 0 || toIdx < 0) return null;
    const open = new MinHeap();
    const g = new Float32Array(W * H).fill(Infinity);
    const came = new Int32Array(W * H).fill(-1);
    const closed = new Uint8Array(W * H);
    const tx = toIdx % W, tz = (toIdx / W) | 0;
    const h = (i) => Math.hypot((i % W) - tx, ((i / W) | 0) - tz);
    g[fromIdx] = 0;
    open.push(fromIdx, h(fromIdx));
    let iter = 0;
    while (open.size && iter++ < 20000) {
      const cur = open.pop();
      if (cur === toIdx) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % W, cz = (cur / W) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx, nz = cz + dz;
          if (!this.isCore(nx, nz)) continue;
          if (dx && dz && (!this.isCore(cx + dx, cz) || !this.isCore(cx, cz + dz))) continue;
          const ni = nz * W + nx;
          if (allow && !allow(ni)) continue;
          const ng = g[cur] + (dx && dz ? 1.4142 : 1);
          if (ng < g[ni]) {
            g[ni] = ng;
            came[ni] = cur;
            open.push(ni, ng + h(ni));
          }
        }
      }
    }
    if (came[toIdx] < 0 && fromIdx !== toIdx) return null;
    const idx = [];
    for (let c = toIdx; c >= 0; c = came[c]) { idx.push(c); if (c === fromIdx) break; }
    idx.reverse();
    // string pulling over core tiles
    const pts = [];
    let anchor = 0;
    pts.push(idx[0]);
    for (let i = 2; i < idx.length; i++) {
      if (!this._coreLine(idx[anchor], idx[i], allow)) {
        anchor = i - 1;
        pts.push(idx[anchor]);
      }
    }
    if (idx.length > 1) pts.push(idx[idx.length - 1]);
    return pts.map((i) => this.worldCenter(i % W, (i / W) | 0));
  }

  _coreLine(a, b, allow = null) {
    const ax = (a % W) + 0.5, az = ((a / W) | 0) + 0.5;
    const bx = (b % W) + 0.5, bz = ((b / W) | 0) + 0.5;
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) * 3);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = Math.floor(ax + (bx - ax) * t), z = Math.floor(az + (bz - az) * t);
      if (!this.isCore(x, z) || (allow && !allow(z * W + x))) return false;
    }
    return true;
  }
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(k, p) {
    const a = this.k, b = this.p;
    a.push(k); b.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (b[j] <= b[i]) break;
      [a[i], a[j]] = [a[j], a[i]]; [b[i], b[j]] = [b[j], b[i]];
      i = j;
    }
  }
  pop() {
    const a = this.k, b = this.p;
    const top = a[0];
    const lk = a.pop(), lp = b.pop();
    if (a.length) {
      a[0] = lk; b[0] = lp;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && b[l] < b[m]) m = l;
        if (r < a.length && b[r] < b[m]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; [b[i], b[m]] = [b[m], b[i]];
        i = m;
      }
    }
    return top;
  }
}
