import { Hunter } from './hunter.js';
import { mulberry32 } from '../render/textures.js';

// Decides when the roaming hunters enter and leave play: never in the first moments after waking up
// in a new place, never where the player can watch them appear, and more of them once the valves
// start groaning through the pipes.

const GRACE = 20;
const MIN_D = 30;
const MAX_D = 62;
const LEAVE_D = 35;

export class Director {
  constructor(opts) {
    this.level = opts.level;
    this.rand = mulberry32(8080);
    this.hunters = [1, 2].map((seed) => new Hunter({ ...opts, seed }));
    this.events = [];
    this.onCatch = null;
    for (const h of this.hunters) h.onCatch = (info) => { if (this.onCatch) this.onCatch(info); };
    const L = this.level;
    // open deep water only: a hunter needs room to turn its mantle around
    this.spawnTiles = L.coreList.filter((i) => L.ch(i % L.W, (i / L.W) | 0) === '~');
    this.reset();
  }

  reset() {
    for (const h of this.hunters) h.deactivate();
    this.grace = GRACE;
    this.spawnT = 6 + this.rand() * 6;
    this.events.length = 0;
    for (const h of this.hunters) h.idleT = 0;
  }

  get active() { return this.hunters.filter((h) => h.active); }
  get chasing() { return this.hunters.some((h) => h.chasing); }
  get caught() { return this.hunters.some((h) => h.active && h.caught); }

  get threat() {
    let t = 0;
    for (const h of this.hunters) t = Math.max(t, h.threat);
    return t;
  }

  get disturbs() {
    const out = [];
    for (const h of this.hunters) {
      const d = h.disturb;
      if (d) out.push(d);
    }
    return out;
  }

  hear(x, y, z, r, loud) {
    for (const h of this.hunters) h.hear(x, y, z, r, loud);
    // something that loud draws company sooner
    if (loud && this.grace <= 0) this.spawnT = Math.min(this.spawnT, 5 + this.rand() * 4);
  }

  /** ctx: { player, camera, valves } */
  update(dt, t, ctx) {
    this.events.length = 0;
    const { player } = ctx;
    this.grace -= dt;
    for (const h of this.hunters) {
      h.update(dt, t, ctx);
      for (const e of h.events) this.events.push(e);
    }
    if (player.frozen) return;

    const p = player.pos;
    const L = this.level;
    // quietly retire hunters that have wandered off unseen
    for (const h of this.hunters) {
      if (!h.active) continue;
      const d = Math.hypot(h.x - p.x, h.z - p.z);
      if (h.state === 'patrol' && d > LEAVE_D && !L.segmentClear(h.x, 0.5, h.z, p.x, p.y, p.z, 0.6)) h.idleT += dt;
      else h.idleT = 0;
      if (h.idleT > (h.leaveAfter || 50)) h.deactivate();
    }

    if (this.grace > 0) return;
    this.spawnT -= dt;
    if (this.spawnT > 0) return;
    this.spawnT = 20 + this.rand() * 20;
    const cap = (ctx.valves || 0) > 0 ? 2 : 1;
    const act = this.active;
    if (act.length >= cap) return;
    const idle = this.hunters.find((h) => !h.active);
    const tile = this._pickTile(p, act);
    if (idle && tile >= 0 && idle.spawn(tile, player)) {
      idle.idleT = 0;
      idle.leaveAfter = 40 + this.rand() * 30;
      this.events.push({ type: 'hunterSpawn', source: 'hunter', x: idle.x, y: idle.y, z: idle.z });
    } else {
      this.spawnT = 6;
    }
  }

  _pickTile(p, act) {
    const L = this.level;
    const cand = [];
    for (const i of this.spawnTiles) {
      const [x, z] = L.worldCenter(i % L.W, (i / L.W) | 0);
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < MIN_D || d > MAX_D) continue;
      if (act.some((h) => Math.hypot(h.x - x, h.z - z) < 25)) continue;
      cand.push(i);
    }
    // try a few random candidates until one is hidden from the player
    for (let k = 0; k < 24 && cand.length; k++) {
      const j = Math.floor(this.rand() * cand.length);
      const i = cand[j];
      const [x, z] = L.worldCenter(i % L.W, (i / L.W) | 0);
      if (!L.segmentClear(x, 0.8, z, p.x, p.y, p.z, 0.6)) return i;
      cand.splice(j, 1);
    }
    return -1;
  }

  dispose() {
    for (const h of this.hunters) h.dispose();
  }
}
