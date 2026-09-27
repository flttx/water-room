import { G, LAMP_N } from './render/shaderlib.js';

/** Smooth-ish flicker pattern: long steady stretches, stutter bursts and short blackouts. */
function flicker(t, ph) {
  const a = Math.sin(t * 0.9 + ph) + Math.sin(t * 2.3 + ph * 1.7) * 0.6;
  if (a > 1.15) {
    const s = Math.sin(t * 43 + ph * 3) * Math.sin(t * 71 + ph);
    return s > 0.05 ? 1 : 0.08;
  }
  if (a < -1.3) return 0.04;
  return 0.93 + 0.07 * Math.sin(t * 97 + ph);
}

/**
 * Chooses the lamps that feed the shader loop each frame and animates their brightness.
 * Baked lamps send a brightness delta (lampCol.w) so baked diffuse follows flicker; dynamic lamps send w=1.
 */
export class LampSystem {
  constructor(lamps) {
    this.lamps = lamps;
    this.k = new Float32Array(lamps.length);
    this.prevOn = new Uint8Array(lamps.length).fill(1);
    this.disturb = []; // [{x, z, r, amount}] creature interference
    this.onToggle = null;
    this._order = lamps.map((_, i) => i);
    this._score = new Float32Array(lamps.length);
  }

  add(lamp) {
    const l = { baked: false, dead: false, flicker: 0, phase: Math.random() * 100, nx: 0, nz: 0, ...lamp };
    this.lamps.push(l);
    const k = new Float32Array(this.lamps.length);
    k.set(this.k);
    this.k = k;
    const p = new Uint8Array(this.lamps.length).fill(1);
    p.set(this.prevOn);
    this.prevOn = p;
    this._order.push(this.lamps.length - 1);
    this._score = new Float32Array(this.lamps.length);
    return l;
  }

  update(t, cam) {
    const L = this.lamps;
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      let k = l.dead ? 0 : (l.power ?? 1);
      if (!l.dead && l.flicker) k *= flicker(t, l.phase);
      if (!l.dead && l.baked) {
        for (const d of this.disturb) {
          const dist = Math.hypot(l.x - d.x, l.z - d.z);
          if (dist < d.r) {
            const f = (1 - dist / d.r) * d.amount;
            const s = Math.sin(t * 31 + l.phase) * Math.sin(t * 13.7 + l.phase * 2);
            if (s > 1 - f * 1.6) k *= 0.06;
          }
        }
      }
      this.k[i] = k;
      const on = k > 0.3 ? 1 : 0;
      if (on !== this.prevOn[i]) {
        this.prevOn[i] = on;
        if (this.onToggle && !l.dead) this.onToggle(i, !!on);
      }
      const d = Math.hypot(l.x - cam.x, (l.y - cam.y) * 0.8, l.z - cam.z);
      // dynamic lamps must win a slot: their diffuse exists only in the loop
      this._score[i] = (l.dead || k <= 0.001) && l.baked ? 1e9 : d - l.range * (l.baked ? 0.5 : 1.5);
    }
    const order = this._order;
    const sc = this._score;
    order.sort((a, b) => sc[a] - sc[b]);
    const P = G.uLampPos.value, C = G.uLampCol.value;
    for (let s = 0; s < LAMP_N; s++) {
      const i = order[s];
      const l = i === undefined ? null : L[i];
      if (!l || sc[i] > 60) { P[s].set(0, -999, 0, 0); C[s].set(0, 0, 0, 0); continue; }
      const k = this.k[i];
      P[s].set(l.x, l.y, l.z, l.range);
      if (l.baked) {
        const kk = Math.max(k, 0.02);
        C[s].set(l.color[0] * l.intensity * kk, l.color[1] * l.intensity * kk, l.color[2] * l.intensity * kk, (k - 1) / kk);
      } else {
        C[s].set(l.color[0] * l.intensity * k, l.color[1] * l.intensity * k, l.color[2] * l.intensity * k, 1);
      }
    }
  }
}
