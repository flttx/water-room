import { DECK_BOTTOM } from './level/level.js';

// Match the player controller's body clearance, stair step and shore-climbing limits.
const STAND_EYE = 1.62;
const CROUCH_EYE = 1.02;
const SURFACE_EYE = 0.26;
const STEP = 0.6;
const CLIMB = 1.2;
const PLAYER_RADIUS = 0.32;
const EPS = 0.001;
const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Player routes have separate walking and swimming states beneath each catwalk. */
export class Navigation {
  constructor(level) {
    this.level = level;
    this.size = level.W * level.H * 2;
    this.cost = new Float64Array(this.size);
    this.previous = new Int32Array(this.size);
    this.closed = new Uint8Array(this.size);
    this.heap = new RouteHeap();
    this.gates = level.find('G');
    this.exits = level.find('X');
    this.result = { path: [], pathIndex: 0, target: null, distance: Infinity, waypoint: null, status: 'unreachable', action: null };
    this.reset();
  }

  reset() {
    this.key = '';
    this.cursor = 0;
    this.remaining = [];
    this.result.path = [];
    this.result.pathIndex = 0;
    this.result.target = null;
    this.result.distance = Infinity;
    this.result.waypoint = null;
    this.result.status = 'unreachable';
    this.result.action = null;
  }

  update(player, valves) {
    const p = player.pos;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      this.reset();
      return this.result;
    }
    const L = this.level;
    const tx = Math.floor(p.x / L.tile), tz = Math.floor(p.z / L.tile);
    if (tx < 0 || tz < 0 || tx >= L.W || tz >= L.H || L.solid(tx, tz)) {
      this.reset();
      return this.result;
    }
    const deck = L.deckTop(tx, tz);
    const aboveDeck = deck !== null && player.mode !== 'surface' && player.mode !== 'under'
      && p.y - (player.eyeH ?? STAND_EYE) > deck - 0.5;
    const swimming = L.isWater(tx, tz) && !aboveDeck;
    const start = (tz * L.W + tx) * 2 + (swimming ? 1 : 0);
    // Movement within a tile and camera rotation only update the waypoint and distance.
    let key = `${start}/${L.dynamicOpen.has('D') ? 1 : 0}${L.dynamicOpen.has('G') ? 1 : 0}`;
    for (const v of valves) key += `/${v.tx},${v.tz},${v.done ? 1 : 0}`;
    if (key !== this.key) {
      this.key = key;
      this._search(start, valves, p);
    }
    this._guide(player);
    return this.result;
  }

  _height(tx, tz, swimming) {
    const L = this.level;
    if (swimming) {
      if (!L.isWater(tx, tz)) return null;
      const ceiling = L.deckTop(tx, tz) === null ? L.ceil(tx, tz) : Math.min(L.ceil(tx, tz), DECK_BOTTOM);
      const y = Math.min(SURFACE_EYE, ceiling - 0.34);
      return y >= L.floor(tx, tz) + 0.45 ? y : null;
    }
    const floor = L.deckTop(tx, tz) ?? (L.isWater(tx, tz) ? null : L.floor(tx, tz));
    if (floor === null || L.ceil(tx, tz) - floor < 1.3) return null;
    return floor + (L.ceil(tx, tz) - floor >= STAND_EYE + 0.12 ? STAND_EYE : CROUCH_EYE);
  }

  _point(state, mode) {
    const tile = state >> 1, tx = tile % this.level.W, tz = Math.floor(tile / this.level.W);
    const y = this._height(tx, tz, (state & 1) === 1);
    return { x: (tx + 0.5) * this.level.tile, y, z: (tz + 0.5) * this.level.tile,
      mode: mode ?? ((state & 1) ? (y < -0.2 ? 'under' : 'surface') : 'ground') };
  }

  _targets(valves) {
    const L = this.level;
    const pending = valves.filter((v) => !v.done);
    const entries = pending.length ? pending.map((v) => ({ tx: v.tx, tz: v.tz, name: v.name, kind: 'valve' }))
      : L.dynamicOpen.has('G') ? this.exits.map(([tx, tz]) => ({ tx, tz, name: '出口', kind: 'exit' }))
        : this.gates.map(([tx, tz]) => ({ tx, tz: tz + 1, name: '逃生闸门', kind: 'gate' }));
    return entries.filter((v) => Number.isInteger(v.tx) && Number.isInteger(v.tz)
      && v.tx >= 0 && v.tz >= 0 && v.tx < L.W && v.tz < L.H && !L.solid(v.tx, v.tz))
      .map((v) => {
        const swimming = L.isWater(v.tx, v.tz) && L.deckTop(v.tx, v.tz) === null;
        const state = (v.tz * L.W + v.tx) * 2 + (swimming ? 1 : 0);
        return { state, target: { ...v, ...this._point(state) } };
      }).filter((v) => v.target.y !== null);
  }

  _search(start, valves, position) {
    const L = this.level, targets = this._targets(valves);
    this.result.path = [];
    this.result.pathIndex = 0;
    this.result.target = null;
    this.result.waypoint = null;
    this.result.distance = Infinity;
    this.result.status = 'unreachable';
    this.result.action = null;
    this.cursor = 0;
    this.remaining = [];
    if (!targets.length) return;
    const startTile = start >> 1;
    if (this._height(startTile % L.W, Math.floor(startTile / L.W), (start & 1) === 1) === null) return;
    this.cost.fill(Infinity);
    this.previous.fill(-1);
    this.closed.fill(0);
    this.heap.clear();
    this.cost[start] = 0;
    this.heap.push(start, 0);
    let reached = null;
    while (this.heap.size) {
      const state = this.heap.pop();
      if (this.closed[state]) continue;
      this.closed[state] = 1;
      reached = targets.find((v) => v.state === state);
      if (reached) break;
      const tile = state >> 1, tx = tile % L.W, tz = Math.floor(tile / L.W);
      const swimming = (state & 1) === 1, y = this._height(tx, tz, swimming);
      for (const [dx, dz] of DIRECTIONS) {
        const nx = tx + dx, nz = tz + dz;
        if (nx < 0 || nz < 0 || nx >= L.W || nz >= L.H || L.solid(nx, nz)) continue;
        for (let layer = 0; layer < 2; layer++) {
          const nextSwimming = layer === 1, ny = this._height(nx, nz, nextSwimming);
          if (ny === null || !this._canMove(tx, tz, swimming, nx, nz, nextSwimming, y, ny)) continue;
          const next = (nz * L.W + nx) * 2 + layer;
          const cost = this.cost[state] + (swimming && nextSwimming
            ? L.tile + Math.abs(y - ny) : Math.hypot(L.tile, ny - y));
          if (cost >= this.cost[next]) continue;
          this.cost[next] = cost;
          this.previous[next] = state;
          this.heap.push(next, cost);
        }
      }
    }
    if (!reached) return;
    const states = [];
    for (let state = reached.state; state !== -1; state = this.previous[state]) states.push(state);
    states.reverse();
    const path = [this._point(states[0])];
    for (let i = 1; i < states.length; i++) {
      const from = this._point(states[i - 1]), to = this._point(states[i]);
      const fromWater = (states[i - 1] & 1) === 1, toWater = (states[i] & 1) === 1;
      if (fromWater && toWater) {
        // Dive before entering a low ceiling; surface inside each breathing pocket.
        const travelY = Math.min(from.y, to.y);
        if (from.y > travelY + EPS) path.push({ ...from, y: travelY, mode: 'under' });
        if (to.y > travelY + EPS) path.push({ ...to, y: travelY, mode: 'under' });
      } else if (fromWater) to.mode = 'climb';
      path.push(to);
    }
    // Join only the first grid edge at the player's progress along it. Keep every later corner.
    const first = path[0], next = path[1];
    if (next && first.mode === next.mode && Math.abs(first.y - next.y) < EPS
      && Math.abs(position.y - first.y) < 0.4) {
      const dx = (next.x - first.x) / L.tile, dz = (next.z - first.z) / L.tile;
      const progress = (position.x - first.x) * dx + (position.z - first.z) * dz;
      if (progress > 0) { first.x += dx * progress; first.z += dz * progress; }
    }
    this.result.path = path;
    this.result.target = reached.target;
    this.result.status = 'route';
    this.remaining = new Float64Array(path.length);
    for (let i = path.length - 2; i >= 0; i--) {
      this.remaining[i] = this.remaining[i + 1] + Math.hypot(path[i + 1].x - path[i].x,
        path[i + 1].y - path[i].y, path[i + 1].z - path[i].z);
    }
  }

  _canMove(tx, tz, swimming, nx, nz, nextSwimming, y, ny) {
    const L = this.level;
    if (swimming && nextSwimming) {
      return Math.min(y, ny) >= Math.max(L.floor(tx, tz), L.floor(nx, nz)) + 0.45;
    }
    if (swimming) {
      const floor = L.deckTop(nx, nz) ?? L.floor(nx, nz);
      return L.deckTop(tx, tz) === null && y >= SURFACE_EYE - EPS && floor <= CLIMB + EPS
        && L.ceil(nx, nz) - floor >= 1.3;
    }
    const floor = L.deckTop(tx, tz) ?? L.floor(tx, tz);
    if (nextSwimming) {
      // Walking cannot enter an underwater ceiling or drop through a catwalk slab.
      return L.deckTop(nx, nz) === null && L.ceil(nx, nz) >= y + 0.12;
    }
    const nextFloor = L.deckTop(nx, nz) ?? L.floor(nx, nz);
    return nextFloor - floor <= STEP + EPS && L.ceil(nx, nz) >= y + 0.12;
  }

  _guide(player) {
    const result = this.result, path = result.path, p = player.pos;
    result.action = null;
    if (!path.length) return;
    // A same-tile detour can put a wall corner between the player and the active edge.
    if (this.cursor > 0 && !this._connectionClear(player, path[this.cursor])) {
      this.cursor = 0;
      path[0].x = (Math.floor(p.x / this.level.tile) + 0.5) * this.level.tile;
      path[0].z = (Math.floor(p.z / this.level.tile) + 0.5) * this.level.tile;
      this.remaining[0] = this.remaining[1] + Math.hypot(path[1].x - path[0].x,
        path[1].y - path[0].y, path[1].z - path[0].z);
    }
    while (this.cursor < path.length - 1) {
      const point = path[this.cursor], next = path[this.cursor + 1];
      if (Math.hypot(p.x - point.x, p.z - point.z) > 0.45 || Math.abs(p.y - point.y) > 0.4) break;
      // The long pump tunnel has air pockets; allow oxygen to recover before its next dive.
      const needsBreath = point.mode === 'surface' && next.mode === 'under'
        && point.x === next.x && point.z === next.z;
      if (needsBreath && Number.isFinite(player.breath) && Number.isFinite(player.breathMax)
        && player.breath < player.breathMax * 0.85) {
        result.action = 'breathe';
        break;
      }
      if (!this._connectionClear(player, next)) break;
      this.cursor++;
    }
    const point = path[this.cursor];
    result.waypoint = point;
    // HUD consumers start here so they never reconnect the player to consumed route points.
    result.pathIndex = this.cursor;
    result.distance = Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z) + this.remaining[this.cursor];
    const arrived = this.cursor === path.length - 1 && Math.hypot(p.x - point.x, p.z - point.z) < 0.7
      && Math.abs(p.y - point.y) < 0.6;
    result.status = arrived ? (result.target.kind === 'gate' ? 'waiting' : 'arrived') : 'route';
  }

  _connectionClear(player, point) {
    const L = this.level, p = player.pos, r = PLAYER_RADIUS;
    const dx = point.x - p.x, dz = point.z - p.z;
    let low = -Infinity, high = Infinity;
    // On a level edge include height blockers such as the side of a raised gallery.
    // Climb, drop and dive edges already have their own transitions in the route.
    if (Math.abs(p.y - point.y) < 0.1) {
      if (player.mode === 'ground' && point.mode === 'ground') {
        low = point.y - (player.eyeH ?? STAND_EYE) + STEP; high = point.y + 0.12;
      } else if (['surface', 'under'].includes(player.mode) && ['surface', 'under'].includes(point.mode)) {
        low = point.mode === 'surface' ? -1.1 : point.y - 0.45;
        high = point.y + (point.mode === 'surface' ? 0.1 : 0.3);
      }
    }
    for (let z = Math.floor((Math.min(p.z, point.z) - r) / L.tile); z <= Math.floor((Math.max(p.z, point.z) + r) / L.tile); z++) {
      for (let x = Math.floor((Math.min(p.x, point.x) - r) / L.tile); x <= Math.floor((Math.max(p.x, point.x) + r) / L.tile); x++) {
        const deck = L.deckTop(x, z);
        const blocksHeight = Number.isFinite(low) && (L.floor(x, z) > low + EPS || L.ceil(x, z) < high - EPS
          || (deck !== null && low < deck && high > DECK_BOTTOM));
        if (!L.solid(x, z) && !blocksHeight) continue;
        // A radius-expanded rectangle conservatively covers the player's swept circle.
        let enter = 0, leave = 1;
        for (const [origin, delta, min, max] of [[p.x, dx, x * L.tile - r, (x + 1) * L.tile + r],
          [p.z, dz, z * L.tile - r, (z + 1) * L.tile + r]]) {
          if (Math.abs(delta) < EPS) {
            if (origin <= min + EPS || origin >= max - EPS) { leave = -1; break; }
          } else {
            const a = (min - origin) / delta, b = (max - origin) / delta;
            enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
          }
        }
        if (enter < leave - EPS) return false;
      }
    }
    return true;
  }
}

/** Reused binary heap: searches allocate no per-cell queue entries. */
class RouteHeap {
  constructor() { this.states = []; this.costs = []; }
  get size() { return this.states.length; }
  clear() { this.states.length = 0; this.costs.length = 0; }
  push(state, cost) {
    let i = this.states.length;
    this.states.push(state);
    this.costs.push(cost);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent] <= cost) break;
      this.states[i] = this.states[parent];
      this.costs[i] = this.costs[parent];
      i = parent;
    }
    this.states[i] = state;
    this.costs[i] = cost;
  }
  pop() {
    const first = this.states[0], state = this.states.pop(), cost = this.costs.pop();
    if (!this.states.length) return first;
    let i = 0;
    while (i * 2 + 1 < this.states.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.states.length && this.costs[child + 1] < this.costs[child]) child++;
      if (this.costs[child] >= cost) break;
      this.states[i] = this.states[child];
      this.costs[i] = this.costs[child];
      i = child;
    }
    this.states[i] = state;
    this.costs[i] = cost;
    return first;
  }
}
