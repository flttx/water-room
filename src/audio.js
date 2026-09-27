/**
 * Procedural audio engine for the flooded "pool rooms" horror stealth game.
 *
 * Everything is synthesised at runtime with the Web Audio API — there are no audio files.
 *
 * Graph (all buses are GainNodes):
 *
 *   one-shots / beds ─┬─ airBus   ─► uwFilter (500 Hz LP underwater) ─┐
 *                     ├─ waterBus ─► waterFilter (1.6 kHz underwater) ─┤
 *                     ├─ bodyBus  ─► bodyFilter  (3.5 kHz underwater) ─┼─► mix ─► duck ─► master ─► compressor ─► trim ─► destination
 *                     ├─ musicBus ─► musicFilter (2.4 kHz underwater) ─┘                ▲
 *                     └─ uiBus / overlayBus ────────────────────────────────────────────┘ (not muffled, not ducked)
 *
 *   per-sound sends ─► revIn ─► hall convolver (4.5 s tiles) ─► hallRet ─► airBus
 *                            └► pool convolver (1.8 s dark)  ─► poolRet ─► waterBus   (crossfaded by setUnderwater)
 *                  ─► echoIn ─► ping-pong feedback delays ─► echoRet ─► airBus (+ reverb)
 *
 * @module audio
 */

/** @typedef {{x:number, y:number, z:number}} Vec3 */

const MAX_SHOTS = 40;
const MAX_SHOTS_PRIORITY = 60;
const AMBIENT_SHOT_LIMIT = 22;
const MASTER_BASE = 0.75;
const OPEN_HZ = 20000;
const STATES = ['patrol', 'suspicious', 'chase', 'search'];

/** Modal frequency ratios. */
const BAR = [1, 2.76, 5.4, 8.93];
const PLATE = [1, 1.59, 2.14, 2.65, 3.16];
const TILE = [1, 2.31, 3.92];

/** Chase percussion: 3 = big boom, 2 = mid hit, 1 = ghost, 0 = rest (eighth notes). */
const DRUM_PATTERN = [3, 0, 1, 0, 2, 0, 0, 1, 3, 0, 1, 2, 0, 2, 1, 1];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v) => clamp(num(v, 0), 0, 1);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Validates a {x,y,z} object.
 * @param {unknown} p
 * @returns {Vec3|null}
 */
function toVec(p) {
  if (!p || typeof p !== 'object') return null;
  const v = /** @type {Record<string, unknown>} */ (p);
  const x = num(v.x, NaN);
  const y = num(v.y, NaN);
  const z = num(v.z, NaN);
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return null;
  return { x, y, z };
}

/** Accepts either (x, y, z) numbers or a single {x,y,z} object. */
function argsToVec(x, y, z) {
  if (typeof x === 'object') return toVec(x);
  return toVec({ x, y, z });
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// buffer generators (run once at init)
// ---------------------------------------------------------------------------

/**
 * Loopable mono noise buffer, DC-free, normalised to RMS 0.3.
 * @param {BaseAudioContext} ctx
 * @param {'white'|'pink'|'brown'} kind
 * @param {number} seconds
 */
function makeNoise(ctx, kind, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const fade = Math.floor(rate * 0.05);
  const raw = new Float32Array(len + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last;
    } else {
      raw[i] = w;
    }
  }
  let mean = 0;
  for (let i = 0; i < raw.length; i++) mean += raw[i];
  mean /= raw.length;
  let sq = 0;
  for (let i = 0; i < raw.length; i++) {
    raw[i] -= mean;
    sq += raw[i] * raw[i];
  }
  const k = 0.3 / Math.sqrt(sq / raw.length || 1);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = raw[i] * k;
  // crossfade the overflow into the head so the loop point is seamless
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    d[i] = d[i] * a + raw[len + i] * k * (1 - a);
  }
  return buf;
}

/** Sparse random crackle impulses (electrical fizz). */
function makeCrackle(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    if (Math.random() < 0.0009) {
      const amp = Math.random() ** 3 * (Math.random() < 0.5 ? -1 : 1);
      const n = 8 + Math.floor(Math.random() * 40);
      for (let j = 0; j < n && i + j < len; j++) {
        d[i + j] += amp * Math.exp(-j / (n / 4)) * (Math.random() * 2 - 1);
      }
    }
  }
  return buf;
}

/**
 * Procedural stereo impulse response: pre-delay, discrete early reflections,
 * optional flutter echo between parallel tiled walls, and a noise tail whose
 * high frequencies decay faster than its lows.
 */
function makeIR(ctx, o) {
  const rate = ctx.sampleRate;
  const len = Math.floor(o.seconds * rate);
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(o.predelay * rate);
  const decay = Math.exp(-6.91 / (o.rt60 * rate));
  const twoPiOverRate = (2 * Math.PI) / rate;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let env = 1;
    let lp1 = 0;
    let lp2 = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      const fc = o.hiEnd + (o.hiStart - o.hiEnd) * Math.exp(-t / o.damp);
      const a = 1 - Math.exp(-twoPiOverRate * fc);
      lp1 += a * (Math.random() * 2 - 1 - lp1);
      lp2 += a * (lp1 - lp2);
      d[i] = lp2 * env * Math.min(1, t / 0.015);
      env *= decay;
    }
    for (let k = 0; k < o.early; k++) {
      const tt = o.predelay * 0.5 + Math.random() * o.earlySpan;
      const idx = Math.floor(tt * rate);
      if (idx >= len - 2) continue;
      const g = (1 - tt / (o.earlySpan + o.predelay)) * rand(0.25, 0.7) * o.earlyGain * (Math.random() < 0.5 ? -1 : 1);
      d[idx] += g;
      d[idx + 1] += g * 0.5;
    }
    if (o.flutter > 0) {
      const period = (o.flutter + ch * 0.0019) * rate;
      let g = 0.3 * o.earlyGain;
      for (let p = pre + period; p < len - 1 && g > 0.004; p += period) {
        const idx = Math.floor(p);
        d[idx] += g * (Math.random() < 0.5 ? -1 : 1);
        g *= 0.8;
      }
    }
  }
  return buf;
}

/** Soft-clip curve (k = drive). */
function makeCurve(k) {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return c;
}

// ---------------------------------------------------------------------------
// envelopes
// ---------------------------------------------------------------------------

/** Percussive envelope: 0 → peak in `a` s, then exponential decay (~-43 dB after `d` s). */
function perc(param, t, a, d, peak) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(0, t + a, Math.max(0.0005, d / 5));
}

/** Linear attack / hold / release envelope that ends at exactly 0. */
function swell(param, t, a, hold, r, peak) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setValueAtTime(peak, t + a + hold);
  param.linearRampToValueAtTime(0, t + a + hold + r);
}

/** Irregular multi-point envelope (random swells) that ends at 0. */
function jaggedEnv(param, t, dur, amp, step = [0.08, 0.25], lo = 0.25) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(amp * rand(0.5, 1), t + 0.06);
  let tt = t + 0.06;
  while (tt < t + dur - 0.2) {
    tt += rand(step[0], step[1]);
    param.linearRampToValueAtTime(amp * rand(lo, 1), Math.min(tt, t + dur - 0.15));
  }
  param.linearRampToValueAtTime(0, t + dur);
}

// ---------------------------------------------------------------------------
// Shot: a self-cleaning one-shot voice
// ---------------------------------------------------------------------------

/**
 * A one-shot voice. Owns every node it creates; when its last source fires
 * `ended`, all nodes are disconnected and the shot is removed from the engine.
 */
class Shot {
  /**
   * @param {AudioEngine} engine
   * @param {object} o shot options (bus, pos, pan, into, gain, send, echo, at, ref, rolloff)
   */
  constructor(engine, o) {
    const ctx = /** @type {AudioContext} */ (engine._ctx);
    this._engine = engine;
    this.ctx = ctx;
    this.t = Math.max(ctx.currentTime + 0.01, num(o.at, 0));
    this.ambient = !!o.ambient;
    /** @type {AudioNode[]} */
    this._nodes = [];
    this._live = 0;
    this._closed = false;
    this.out = this.gain(num(o.gain, 1));
    if (o.into) {
      this.out.connect(o.into);
      return;
    }
    /** @type {AudioNode} */
    let head = this.out;
    let sendScale = 1;
    if (o.pos) {
      const d = engine._distance(o.pos);
      if (d > 6) {
        const lp = this.filter('lowpass', clamp(20000 * Math.exp(-(d - 6) / 28), 700, OPEN_HZ), 0.5);
        head.connect(lp);
        head = lp;
      }
      const p = engine._panner(o.pos, num(o.ref, 3), num(o.rolloff, 1));
      this._nodes.push(p);
      head.connect(p);
      head = p;
      sendScale = Math.sqrt(Math.min(1, 10 / Math.max(d, 1)));
    } else if (o.pan) {
      const sp = new StereoPannerNode(ctx, { pan: clamp(num(o.pan, 0), -1, 1) });
      this._nodes.push(sp);
      head.connect(sp);
      head = sp;
    }
    head.connect(o.bus || engine._airBus);
    if (o.send > 0) {
      const g = this.gain(o.send * sendScale);
      this.out.connect(g);
      g.connect(engine._revIn);
    }
    if (o.echo > 0) {
      const g = this.gain(o.echo * sendScale);
      this.out.connect(g);
      g.connect(engine._echoIn);
    }
  }

  gain(v = 1) {
    const n = new GainNode(this.ctx, { gain: v });
    this._nodes.push(n);
    return n;
  }

  filter(type, frequency, Q = 1, gainDb = 0) {
    const nyq = this.ctx.sampleRate / 2;
    const n = new BiquadFilterNode(this.ctx, { type, frequency: clamp(frequency, 10, nyq - 100), Q, gain: gainDb });
    this._nodes.push(n);
    return n;
  }

  shaper(k) {
    const n = new WaveShaperNode(this.ctx, { curve: this._engine._curve(k), oversample: '2x' });
    this._nodes.push(n);
    return n;
  }

  osc(type, freq, start, stop) {
    const n = new OscillatorNode(this.ctx, { type, frequency: freq });
    this._run(n, start, stop);
    return n;
  }

  noise(kind, start, stop, rate = 1) {
    const buf = this._engine._buf[kind];
    const n = new AudioBufferSourceNode(this.ctx, { buffer: buf, loop: true, playbackRate: rate });
    this._run(n, start, stop, Math.random() * buf.duration * 0.9);
    return n;
  }

  _run(src, start, stop, offset) {
    this._nodes.push(src);
    this._live++;
    src.onended = () => {
      src.onended = null;
      this._live--;
      if (this._live <= 0) this.close();
    };
    if (offset === undefined) src.start(start);
    else src.start(start, offset);
    src.stop(Math.max(stop, start + 0.005));
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const n of this._nodes) {
      try {
        n.disconnect();
      } catch (err) {
        console.warn('AudioEngine: disconnect failed', err);
      }
    }
    this._nodes.length = 0;
    this._engine._shots.delete(this);
  }
}

// ---------------------------------------------------------------------------
// synthesis building blocks (all schedule into a Shot)
// ---------------------------------------------------------------------------

/**
 * Noise source → filter → level-compensation gain, so that amplitude 1 ≈ the
 * nominal 0.3-RMS noise level regardless of how narrow the band is.
 * @returns {[BiquadFilterNode, GainNode]}
 */
function nz(s, kind, t0, t1, type, f, Q = 1, rate = 1) {
  const src = s.noise(kind, t0, t1, rate);
  const flt = s.filter(type, f, Q);
  const nyq = s.ctx.sampleRate / 2;
  let comp = 1;
  if (kind === 'white') {
    if (type === 'bandpass') comp = Math.sqrt((nyq * Q) / f);
    else if (type === 'lowpass') comp = Math.sqrt(nyq / f);
  } else if (kind === 'pink') {
    if (type === 'bandpass') comp = Math.sqrt(6.9 * Q);
    else if (type === 'lowpass') comp = Math.sqrt(6.9 / Math.max(0.5, Math.log(f / 20)));
  }
  const g = s.gain(clamp(comp, 1, 30));
  src.connect(flt).connect(g);
  return [flt, g];
}

/** Filtered noise hit with a percussive envelope. */
function hit(s, dest, t, kind, type, f, Q, a, d, amp) {
  const [flt, o] = nz(s, kind, t, t + a + d * 1.5 + 0.02, type, f, Q);
  const g = s.gain(0);
  perc(g.gain, t, a, d, amp);
  o.connect(g).connect(dest);
  return flt;
}

/** Oscillator with exponential pitch glide and percussive envelope. */
function toneDrop(s, dest, t, f0, f1, glide, a, d, amp, type = 'sine') {
  const o = s.osc(type, f0, t, t + a + d * 1.5 + 0.02);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + Math.max(0.005, glide));
  const g = s.gain(0);
  perc(g.gain, t, a, d, amp);
  o.connect(g).connect(dest);
  return o;
}

/** Droplet / bubble: sine with a fast upward pitch sweep. */
function blip(s, dest, t, f, ratio, dur, amp, attack = 0.002) {
  const o = s.osc('sine', f, t, t + attack + dur * 1.5 + 0.02);
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(Math.min(f * ratio, 16000), t + dur);
  const g = s.gain(0);
  perc(g.gain, t, attack, dur, amp);
  o.connect(g).connect(dest);
}

/** Many droplets spread over a time span, getting sparser. */
function dropletRain(s, dest, t, count, span, fLo, fHi, amp) {
  for (let k = 0; k < count; k++) {
    const tk = t + Math.random() ** 1.7 * span;
    blip(s, dest, tk, rand(fLo, fHi), rand(1.3, 2.1), rand(0.025, 0.07), amp * rand(0.3, 1), 0.001);
  }
}

/** Exhaled / released air bubbles. */
function bubbleBurst(s, dest, t, count, span, fLo, fHi, amp) {
  for (let k = 0; k < count; k++) {
    const tk = t + (k / Math.max(1, count)) ** 0.8 * span + rand(0, 0.03);
    blip(s, dest, tk, rand(fLo, fHi), rand(1.7, 2.8), rand(0.03, 0.09), amp * rand(0.35, 1), 0.004);
  }
}

/** Modal (sum of decaying sines) metallic / ceramic resonance. */
function modal(s, dest, t, f, ratios, d, amp) {
  const nyq = s.ctx.sampleRate / 2;
  ratios.forEach((r, i) => {
    const fr = f * r * rand(0.99, 1.01);
    if (fr > nyq - 500) return;
    const o = s.osc('sine', fr, t, t + d * 1.5 + 0.05);
    const g = s.gain(0);
    perc(g.gain, t, 0.001, d / (1 + i * 0.5), amp / (1 + i * 0.6));
    o.connect(g).connect(dest);
  });
}

/** Train of short clicks (one noise source, gated by gain automation). */
function clickTrain(s, dest, times, amps, f, q, wetF = 0, wetQ = 10, wetAmt = 0) {
  if (!times.length) return;
  const t0 = times[0] - 0.01;
  const src = s.noise('white', t0, times[times.length - 1] + 0.12);
  const g = s.gain(0);
  g.gain.setValueAtTime(0, t0);
  times.forEach((tk, i) => {
    g.gain.setValueAtTime(amps[i], tk);
    g.gain.setTargetAtTime(0, tk + 0.0004, 0.0012);
  });
  src.connect(g);
  const nyq = s.ctx.sampleRate / 2;
  const bp = s.filter('bandpass', f, q);
  const bg = s.gain(Math.sqrt((nyq * q) / f));
  g.connect(bp).connect(bg).connect(dest);
  if (wetAmt > 0) {
    const w = s.filter('bandpass', wetF, wetQ);
    const wg = s.gain(wetAmt * Math.sqrt((nyq * wetQ) / wetF));
    g.connect(w).connect(wg).connect(dest);
  }
}

/** Breathy formant noise (inhale / exhale / gasp), optionally voiced. */
function breath(s, dest, t, dur, f1, f2, amp, voicedHz = 0, rise = 1) {
  const src = s.noise('white', t, t + dur + 0.05);
  const hp = s.filter('highpass', 280, 0.7);
  const b1 = s.filter('bandpass', f1, 2.2);
  const b2 = s.filter('bandpass', f2, 3);
  b1.frequency.setValueAtTime(f1, t);
  b1.frequency.linearRampToValueAtTime(f1 * rise, t + dur);
  b2.frequency.setValueAtTime(f2, t);
  b2.frequency.linearRampToValueAtTime(f2 * rise, t + dur);
  const nyq = s.ctx.sampleRate / 2;
  const c1 = s.gain(Math.sqrt((nyq * 2.2) / f1) * 0.8);
  const c2 = s.gain(Math.sqrt((nyq * 3) / f2) * 0.5);
  const g = s.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(amp, t + dur * 0.15);
  g.gain.linearRampToValueAtTime(amp * 0.55, t + dur * 0.65);
  g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(hp);
  hp.connect(b1).connect(c1).connect(g);
  hp.connect(b2).connect(c2).connect(g);
  g.connect(dest);
  if (voicedHz > 0) {
    const o = s.osc('sawtooth', voicedHz, t, t + dur + 0.05);
    o.frequency.setValueAtTime(voicedHz, t);
    o.frequency.linearRampToValueAtTime(voicedHz * 1.45, t + dur * 0.7);
    const vg = s.gain(0);
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(amp * 0.12, t + dur * 0.2);
    vg.gain.linearRampToValueAtTime(0, t + dur * 0.8);
    o.connect(vg);
    vg.connect(b1);
    vg.connect(b2);
  }
}

/** Stick-slip metal creak through resonant bands. */
function creak(s, dest, t, dur, f, amp, res) {
  const o = s.osc('sawtooth', f, t, t + dur + 0.05);
  o.frequency.setValueAtTime(f, t);
  let tt = t;
  while (tt < t + dur) {
    tt += rand(0.03, 0.14);
    o.frequency.linearRampToValueAtTime(f * rand(0.7, 1.4), Math.min(tt, t + dur));
  }
  const g = s.gain(0);
  jaggedEnv(g.gain, t, dur, 1, [0.04, 0.16], 0.15);
  const sh = s.shaper(3);
  const sum = s.gain(amp);
  o.connect(g).connect(sh);
  for (const [rf, q, lvl] of res) {
    const bp = s.filter('bandpass', rf, q);
    const bg = s.gain(lvl * Math.sqrt(q) * 1.5);
    sh.connect(bp).connect(bg).connect(sum);
  }
  sum.connect(dest);
}

/** Slow wandering pitch jitter source (brown noise → lowpass) routed into `params`. */
function jitter(s, t0, t1, cutoff, depth, params) {
  const src = s.noise('brown', t0, t1, 0.5);
  const lp = s.filter('lowpass', cutoff, 0.7);
  const g = s.gain(depth);
  src.connect(lp).connect(g);
  for (const p of params) g.connect(p);
}

/** Low guttural growl (hunter). */
function synthGrowl(s, dest, t, o) {
  const dur = o.dur;
  const f0 = o.f0;
  const stop = t + dur + 0.1;
  const oscA = s.osc('sawtooth', f0, t, stop);
  const oscB = s.osc('sawtooth', f0 * 1.013, t, stop);
  [[oscA, 1], [oscB, 1.013]].forEach(([osc, m]) => {
    osc.frequency.setValueAtTime(f0 * 0.85 * m, t);
    osc.frequency.linearRampToValueAtTime(f0 * 1.12 * m, t + dur * 0.35);
    osc.frequency.linearRampToValueAtTime(f0 * 0.78 * m, t + dur);
  });
  jitter(s, t, stop, 25, f0 * 0.6, [oscA.frequency, oscB.frequency]);
  const am = s.gain(0.55);
  const fl = s.osc('sine', rand(16, 26), t, stop);
  const flg = s.gain(0.45);
  fl.connect(flg).connect(am.gain);
  oscA.connect(am);
  oscB.connect(am);
  const sh = s.shaper(o.drive || 4);
  am.connect(sh);
  const env = s.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(o.amp, t + 0.22);
  env.gain.linearRampToValueAtTime(o.amp * 0.8, t + dur - 0.45);
  env.gain.linearRampToValueAtTime(0, t + dur);
  for (const [f, q, lvl] of [[300, 3, 1], [720, 4, 0.6], [1350, 6, 0.25]]) {
    const bp = s.filter('bandpass', f * rand(0.9, 1.1), q);
    const bg = s.gain(lvl * 1.6);
    sh.connect(bp).connect(bg).connect(env);
  }
  const lp = s.filter('lowpass', 180, 0.8);
  const lg = s.gain(0.5);
  sh.connect(lp).connect(lg).connect(env);
  const [, wet] = nz(s, 'pink', t, stop, 'bandpass', 480, 0.9);
  const wg = s.gain(0);
  swell(wg.gain, t, 0.3, dur - 0.7, 0.4, o.amp * 0.35);
  wet.connect(wg).connect(dest);
  env.connect(dest);
}

/** Roar: big distorted formant-swept voice with scream partials and spray noise. */
function synthRoar(s, dest, t, o) {
  const dur = o.dur;
  const f0 = o.f0;
  const bright = o.bright || 1;
  const stop = t + dur + 0.15;
  const tp = t + dur * 0.3;
  const oscs = [
    [s.osc('sawtooth', f0, t, stop), 1],
    [s.osc('sawtooth', f0 * 1.021, t, stop), 1.021],
    [s.osc('square', f0 * 0.5, t, stop), 0.5],
  ];
  const freqParams = [];
  for (const [osc, m] of oscs) {
    osc.frequency.setValueAtTime(f0 * 0.8 * m, t);
    osc.frequency.linearRampToValueAtTime(f0 * 1.35 * m, tp);
    osc.frequency.linearRampToValueAtTime(f0 * 1.1 * m, t + dur * 0.7);
    osc.frequency.linearRampToValueAtTime(f0 * 0.72 * m, t + dur);
    freqParams.push(osc.frequency);
  }
  jitter(s, t, stop, 35, f0 * 1.2, freqParams);
  const am = s.gain(0.5);
  const fl = s.osc('sine', rand(26, 36), t, stop);
  const flg = s.gain(0.5);
  fl.connect(flg).connect(am.gain);
  for (const [osc] of oscs) osc.connect(am);
  const sh = s.shaper(o.drive || 10);
  am.connect(sh);
  const env = s.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(o.amp, t + 0.12);
  env.gain.linearRampToValueAtTime(o.amp * 0.85, t + dur - 0.6);
  env.gain.linearRampToValueAtTime(0, t + dur);
  const formants = [[420, 880, 2.5, 1], [1000, 1900, 3, 0.7], [2500, 2900, 4, 0.35 * bright]];
  for (const [fa, fb, q, lvl] of formants) {
    const bp = s.filter('bandpass', fa, q);
    bp.frequency.setValueAtTime(fa, t);
    bp.frequency.linearRampToValueAtTime(fb, tp);
    bp.frequency.linearRampToValueAtTime(fa * 1.1, t + dur);
    const bg = s.gain(lvl * 1.5);
    sh.connect(bp).connect(bg).connect(env);
  }
  const lp = s.filter('lowpass', 200, 0.8);
  const lg = s.gain(0.7);
  sh.connect(lp).connect(lg).connect(env);
  // scream partial
  const sc = s.osc('sawtooth', f0 * 7, t, stop);
  sc.frequency.setValueAtTime(f0 * 6, t);
  sc.frequency.linearRampToValueAtTime(f0 * 9, tp);
  sc.frequency.linearRampToValueAtTime(f0 * 5.5, t + dur);
  const scb = s.filter('bandpass', 2300, 4);
  const scg = s.gain(0);
  swell(scg.gain, t + 0.05, 0.3, dur * 0.4, dur * 0.4, 0.3 * bright * o.amp);
  sc.connect(scb).connect(scg).connect(dest);
  // spray / breath noise
  const [spf, spray] = nz(s, 'white', t, stop, 'bandpass', 1600, 0.8);
  spf.frequency.setValueAtTime(1300, t);
  spf.frequency.linearRampToValueAtTime(2800, tp);
  spf.frequency.linearRampToValueAtTime(1200, t + dur);
  const spg = s.gain(0);
  jaggedEnv(spg.gain, t, dur, o.amp * 0.35, [0.05, 0.15], 0.4);
  spray.connect(spg).connect(dest);
  // chest / water body
  const [, body] = nz(s, 'brown', t, stop, 'lowpass', 160, 0.7);
  const bdg = s.gain(0);
  swell(bdg.gain, t, 0.15, dur - 0.7, 0.5, o.amp * 1.2);
  body.connect(bdg).connect(dest);
  env.connect(dest);
}

/** Wet clicking / chittering train. */
function synthClicks(s, dest, t, o) {
  const times = [];
  const amps = [];
  let tt = t;
  for (let k = 0; k < o.count; k++) {
    const acc = 1 - (k / o.count) * (o.accel || 0);
    tt += rand(o.gap[0], o.gap[1]) * acc;
    times.push(tt);
    amps.push(o.amp * rand(0.35, 1));
  }
  clickTrain(s, dest, times, amps, o.f, o.q, o.wetF, o.wetQ, o.wet);
}

/** Deep whale-like moan with formant sweeps and pulsed grain. */
function synthWhaleCall(s, dest, t, o) {
  const { dur, f0, peak, end, amp } = o;
  const bright = o.bright || 1;
  const stop = t + dur + 0.2;
  const tp = t + dur * rand(0.3, 0.5);
  const oscA = s.osc('sawtooth', f0, t, stop);
  const oscB = s.osc('triangle', f0 * 2.003, t, stop);
  const sub = s.osc('sine', f0 * 0.5, t, stop);
  [[oscA, 1], [oscB, 2.003], [sub, 0.5]].forEach(([osc, m]) => {
    osc.frequency.setValueAtTime(f0 * m, t);
    osc.frequency.exponentialRampToValueAtTime(peak * m, tp);
    osc.frequency.exponentialRampToValueAtTime(end * m, t + dur);
  });
  const vib = s.osc('sine', rand(2.5, 4.5), t, stop);
  const vg = s.gain(f0 * 0.03);
  vib.connect(vg);
  vg.connect(oscA.frequency);
  vg.connect(oscB.frequency);
  const am = s.gain(0.72);
  const pulse = s.osc('sine', rand(5, 9), t, stop);
  const pg = s.gain(0.28);
  pulse.connect(pg).connect(am.gain);
  oscA.connect(am);
  const bg2 = s.gain(0.6);
  oscB.connect(bg2).connect(am);
  const sh = s.shaper(o.drive || 1.5);
  am.connect(sh);
  const env = s.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(amp, t + dur * 0.2);
  env.gain.linearRampToValueAtTime(amp * 0.85, t + dur * 0.65);
  env.gain.linearRampToValueAtTime(0, t + dur);
  const forms = [[170, 460, 200, 4, 2.4], [520, 1250, 470, 6, 1.1 * bright]];
  for (const [a, b, c, q, lvl] of forms) {
    const bp = s.filter('bandpass', a, q);
    bp.frequency.setValueAtTime(a, t);
    bp.frequency.exponentialRampToValueAtTime(b * (a > 300 ? bright : 1), tp);
    bp.frequency.exponentialRampToValueAtTime(c, t + dur);
    const g = s.gain(lvl);
    sh.connect(bp).connect(g).connect(env);
  }
  const lp = s.filter('lowpass', 120, 0.7);
  const lg = s.gain(0.8);
  sh.connect(lp).connect(lg).connect(env);
  const sg = s.gain(0.7);
  sub.connect(sg).connect(env);
  env.connect(dest);
}

// ---------------------------------------------------------------------------
// creature voices
// ---------------------------------------------------------------------------

/** Vocal scheduling ranges (seconds) per kind/state. */
const VOCAL_SCHEDULE = {
  hunter: {
    patrol: { click: [7, 16], growl: [14, 28] },
    suspicious: { click: [2.2, 4.5], growl: [7, 12] },
    search: { click: [1.8, 3.8], growl: [5, 10] },
    chase: { click: [3, 6], growl: [2.5, 5], roar: [6, 10] },
  },
  colossus: {
    patrol: { call: [18, 36], click: [20, 40] },
    suspicious: { call: [10, 18], click: [8, 16], growl: [14, 24] },
    search: { call: [12, 22], click: [9, 18], growl: [12, 20] },
    chase: { call: [7, 12], growl: [5, 9], roar: [14, 22] },
  },
};

/**
 * Positional creature voice. Continuous water-displacement bed plus scheduled
 * vocal one-shots routed through the voice's own HRTF panner.
 * Safe to create before `AudioEngine.init()` — the graph is built lazily.
 */
class CreatureVoice {
  /**
   * @param {AudioEngine} engine
   * @param {'hunter'|'colossus'} kind
   */
  constructor(engine, kind) {
    this._e = engine;
    this.kind = kind === 'colossus' ? 'colossus' : 'hunter';
    this._pos = { x: 0, y: 0, z: 0 };
    this._state = 'patrol';
    this._speed = 0;
    this._g = null;
    this._disposed = false;
    this._gateLevel = 0;
    this._timers = { click: rand(2, 8), growl: rand(6, 14), roar: rand(6, 10), call: rand(4, 12) };
    engine._voices.add(this);
    this._tryBuild();
  }

  /** @returns {'patrol'|'suspicious'|'chase'|'search'} current state */
  get state() {
    return /** @type {'patrol'|'suspicious'|'chase'|'search'} */ (this._state);
  }

  /** Moves the voice. Accepts (x, y, z) numbers or a {x,y,z} object. */
  setPosition(x, y, z) {
    const p = argsToVec(x, y, z);
    if (!p) return;
    this._pos = p;
    if (!this._g) return;
    this._e._setPannerPos(this._g.panner, p);
    this._updateDistance(false);
  }

  /** @param {'patrol'|'suspicious'|'chase'|'search'} state */
  setState(state) {
    if (!STATES.includes(state) || state === this._state) return;
    this._state = state;
    const sched = VOCAL_SCHEDULE[this.kind][state];
    for (const key of Object.keys(sched)) {
      this._timers[key] = Math.min(this._timers[key], rand(sched[key][0], sched[key][1]));
    }
    if (state === 'suspicious') this._timers.click = Math.min(this._timers.click, rand(0.2, 0.8));
    if (state === 'chase') {
      if (this.kind === 'hunter') this._timers.roar = Math.min(this._timers.roar, rand(0.2, 0.6));
      else this._timers.call = Math.min(this._timers.call, rand(0.3, 1));
    }
    this._applyBody(false);
  }

  /** @param {number} v movement speed 0..1 (modulates water-displacement rumble) */
  setSpeed(v) {
    const sp = clamp01(v);
    if (Math.abs(sp - this._speed) < 0.01) return;
    this._speed = sp;
    this._applyBody(false);
  }

  /** Low guttural growl at the voice position. */
  growl() {
    const s = this._shot(1);
    if (!s) return;
    if (this.kind === 'hunter') {
      synthGrowl(s, s.out, s.t, { dur: rand(1.2, 2.2), f0: rand(46, 62), amp: 0.5, drive: 4 });
    } else {
      synthWhaleCall(s, s.out, s.t, { dur: rand(2.5, 3.5), f0: rand(28, 34), peak: rand(36, 44), end: rand(24, 29), amp: 0.7, drive: 3 });
    }
  }

  /** Full roar at the voice position. */
  roar() {
    const s = this._shot(1);
    if (!s) return;
    if (this.kind === 'hunter') {
      synthRoar(s, s.out, s.t, { dur: rand(2.2, 3), f0: rand(68, 80), amp: 0.55, bright: 1 });
    } else {
      synthWhaleCall(s, s.out, s.t, { dur: rand(7, 9), f0: rand(30, 36), peak: rand(60, 80), end: rand(26, 32), amp: 0.9, drive: 5, bright: 1.3 });
    }
  }

  /** Wet clicking / chittering (hunter) or deep knocks (colossus). */
  click() {
    const s = this._shot(1);
    if (!s) return;
    if (this.kind === 'hunter') {
      synthClicks(s, s.out, s.t, { count: Math.floor(rand(6, 17)), gap: [0.018, 0.075], accel: 0.5, amp: 0.7, f: rand(2300, 4200), q: 6, wetF: rand(800, 1300), wetQ: 14, wet: 0.8 });
    } else {
      synthClicks(s, s.out, s.t, { count: Math.floor(rand(4, 9)), gap: [0.08, 0.2], accel: 0.3, amp: 1, f: rand(260, 480), q: 8, wetF: rand(120, 180), wetQ: 12, wet: 1.2 });
    }
  }

  /** Whale-like moaning call (colossus); hunter falls back to a growl. */
  call() {
    if (this.kind === 'hunter') {
      this.growl();
      return;
    }
    const s = this._shot(1);
    if (!s) return;
    synthWhaleCall(s, s.out, s.t, { dur: rand(5, 9), f0: rand(30, 45), peak: rand(50, 80), end: rand(28, 40), amp: 0.8 });
  }

  /**
   * Per-frame update: distance gating/air absorption and random vocalisations.
   * @param {number} dt seconds
   */
  update(dt) {
    if (this._disposed) return;
    if (!this._g) {
      this._tryBuild();
      if (!this._g) return;
    }
    if (!this._e._live()) return;
    const d = clamp(num(dt, 0), 0, 0.25);
    this._updateDistance(false);
    const sched = VOCAL_SCHEDULE[this.kind][this._state];
    for (const key of Object.keys(sched)) {
      this._timers[key] -= d;
      if (this._timers[key] > 0) continue;
      this._timers[key] = rand(sched[key][0], sched[key][1]);
      if (this._gateLevel < 0.01) continue;
      if (key === 'click') this.click();
      else if (key === 'growl') this.growl();
      else if (key === 'roar') this.roar();
      else if (key === 'call') this.call();
    }
  }

  /** Stops and disconnects everything. The voice is unusable afterwards. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._e._voices.delete(this);
    const g = this._g;
    this._g = null;
    if (!g) return;
    const ctx = /** @type {AudioContext} */ (this._e._ctx);
    const t = ctx.currentTime;
    g.input.gain.cancelScheduledValues(t);
    g.input.gain.setTargetAtTime(0, t, 0.02);
    const nodes = g.nodes;
    const first = g.srcs[0];
    first.onended = () => {
      first.onended = null;
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch (err) {
          console.warn('AudioEngine: voice disconnect failed', err);
        }
      }
      nodes.length = 0;
    };
    for (const src of g.srcs) src.stop(t + 0.15);
  }

  _shot(gain) {
    if (!this._g || this._disposed) return null;
    return this._e._shot({ into: this._g.input, gain, priority: true });
  }

  _tryBuild() {
    if (this._g || this._disposed || !this._e.ready) return;
    const e = this._e;
    const ctx = /** @type {AudioContext} */ (e._ctx);
    const H = this.kind === 'hunter';
    /** @type {AudioNode[]} */
    const nodes = [];
    const mk = (n) => {
      nodes.push(n);
      return n;
    };
    const input = mk(new GainNode(ctx, { gain: 1 }));
    const air = mk(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 8000, Q: 0.5 }));
    const gate = mk(new GainNode(ctx, { gain: 0 }));
    const panner = mk(e._panner(this._pos, H ? 7 : 30, 1));
    const send = mk(new GainNode(ctx, { gain: H ? 0.3 : 0.8 }));
    input.connect(air).connect(gate).connect(panner).connect(e._waterBus);
    gate.connect(send).connect(e._revIn);

    const bed = mk(new GainNode(ctx, { gain: 1 }));
    bed.connect(input);
    const am = mk(new GainNode(ctx, { gain: 0.65 }));
    am.connect(bed);
    const lfo = mk(new OscillatorNode(ctx, { frequency: 0.4 }));
    const lfoAmp = mk(new GainNode(ctx, { gain: 0.35 }));
    lfo.connect(lfoAmp).connect(am.gain);
    const rumble = mk(e._loop('brown'));
    const rumbleLP = mk(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: H ? 110 : 55, Q: 0.8 }));
    const rumbleG = mk(new GainNode(ctx, { gain: 0.2 }));
    rumble.connect(rumbleLP).connect(rumbleG).connect(am);
    const whoosh = mk(e._loop('pink'));
    const whooshF = mk(new BiquadFilterNode(ctx, H ? { type: 'bandpass', frequency: 300, Q: 1.1 } : { type: 'lowpass', frequency: 160, Q: 0.7 }));
    const whooshG = mk(new GainNode(ctx, { gain: 0 }));
    whoosh.connect(whooshF).connect(whooshG).connect(am);
    const lfoF = mk(new GainNode(ctx, { gain: H ? 140 : 40 }));
    lfo.connect(lfoF).connect(whooshF.frequency);
    const sub = mk(new OscillatorNode(ctx, { frequency: H ? 33 : 23 }));
    const subG = mk(new GainNode(ctx, { gain: 0.1 }));
    sub.connect(subG).connect(bed);
    lfo.start();
    sub.start();
    this._g = { nodes, srcs: [lfo, sub, rumble, whoosh], input, air, gate, panner, send, bed, am, lfo, lfoAmp, rumbleLP, rumbleG, whooshF, whooshG, subG, last: { gate: -1, air: -1, send: -1 } };
    this._applyBody(true);
    this._updateDistance(true);
  }

  _applyBody(immediate) {
    const g = this._g;
    if (!g) return;
    const e = this._e;
    const tc = immediate ? 0.001 : 0.25;
    const s = this._speed;
    const chase = this._state === 'chase';
    if (this.kind === 'hunter') {
      e._to(g.rumbleLP.frequency, 90 + 420 * s, tc);
      e._to(g.rumbleG.gain, 0.25 + 1.3 * s, tc);
      e._to(g.whooshG.gain, 0.03 + 0.55 * s ** 1.4, tc);
      e._to(g.whooshF.frequency, 220 + 650 * s, tc);
      e._to(g.lfo.frequency, 0.25 + 1.3 * s, tc);
      e._to(g.subG.gain, 0.12 + 0.3 * s, tc);
      e._to(g.bed.gain, chase ? 1.3 : 1, tc);
    } else {
      e._to(g.rumbleG.gain, 0.9 + 0.8 * s, tc);
      e._to(g.whooshG.gain, 0.05 + 0.5 * s, tc);
      e._to(g.lfo.frequency, 0.05 + 0.15 * s, tc);
      e._to(g.subG.gain, 0.2 + 0.2 * s, tc);
      e._to(g.bed.gain, chase ? 1.25 : 1, tc);
    }
  }

  _updateDistance(immediate) {
    const g = this._g;
    if (!g) return;
    const e = this._e;
    const d = e._distance(this._pos);
    const H = this.kind === 'hunter';
    const gate = H ? 1 - smoothstep(45, 70, d) : 1 - smoothstep(130, 185, d);
    const air = H ? clamp(18000 * Math.exp(-d / 22), 600, 18000) : clamp(5000 * Math.exp(-d / 70), 250, 5000);
    const send = H ? 0.22 * Math.sqrt(clamp(d / 8, 1, 8)) : 0.85;
    const tc = immediate ? 0.001 : 0.12;
    this._gateLevel = gate;
    if (Math.abs(gate - g.last.gate) > 0.005) {
      e._to(g.gate.gain, gate, tc);
      g.last.gate = gate;
    }
    if (Math.abs(air - g.last.air) > g.last.air * 0.03) {
      e._to(g.air.frequency, air, tc);
      g.last.air = air;
    }
    if (Math.abs(send - g.last.send) > 0.01) {
      e._to(g.send.gain, send, tc);
      g.last.send = send;
    }
  }
}

// ---------------------------------------------------------------------------
// lamp hum
// ---------------------------------------------------------------------------

/**
 * Positional electrical hum. Nodes exist only while the listener is within
 * range (distance culling), so many lamps cost nothing when far away.
 */
class LampHum {
  /**
   * @param {AudioEngine} engine
   * @param {Vec3} pos
   */
  constructor(engine, pos) {
    this._e = engine;
    this._pos = toVec(pos) || { x: 0, y: 0, z: 0 };
    this._on = true;
    this._g = null;
    this._offTimer = 0;
    this._flicker = false;
    this._disposed = false;
    this._detune = rand(-0.4, 0.4);
    engine._lamps.add(this);
  }

  /** Switches the lamp; plays a click/fizz when within earshot. */
  setOn(on) {
    const v = !!on;
    if (v === this._on || this._disposed) return;
    this._on = v;
    this._flicker = v;
    if (this._e._distance(this._pos) < 14) this._e._lampToggle(this._pos, v);
    if (this._g) this._applyLevel(true);
  }

  /** Moves the lamp. Accepts (x, y, z) numbers or a {x,y,z} object. */
  setPosition(x, y, z) {
    const p = argsToVec(x, y, z);
    if (!p) return;
    this._pos = p;
    if (this._g) this._e._setPannerPos(this._g.panner, p);
  }

  /** Releases all nodes. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._e._lamps.delete(this);
    this._teardown();
  }

  _tick() {
    if (this._disposed) return;
    const d = this._e._distance(this._pos);
    if (!this._g) {
      if (this._on && d < 11) this._build();
      return;
    }
    const ctx = /** @type {AudioContext} */ (this._e._ctx);
    if (d > 13 || (!this._on && ctx.currentTime > this._offTimer)) {
      this._teardown();
      return;
    }
    const fade = 1 - smoothstep(8, 11, d);
    if (Math.abs(fade - this._g.fade) > 0.01) {
      this._g.fade = fade;
      this._e._to(this._g.dist.gain, fade, 0.1);
    }
  }

  _build() {
    const e = this._e;
    const ctx = /** @type {AudioContext} */ (e._ctx);
    const nodes = [];
    const mk = (n) => {
      nodes.push(n);
      return n;
    };
    const out = mk(new GainNode(ctx, { gain: 0 }));
    const dist = mk(new GainNode(ctx, { gain: 0 }));
    const panner = mk(e._panner(this._pos, 1.2, 1.6));
    const send = mk(new GainNode(ctx, { gain: 0.12 }));
    out.connect(dist).connect(panner).connect(e._airBus);
    dist.connect(send).connect(e._revIn);
    const hum = mk(new OscillatorNode(ctx, { frequency: 100 + this._detune }));
    hum.setPeriodicWave(e._humWave);
    const humG = mk(new GainNode(ctx, { gain: 0.03 }));
    const flick = mk(new OscillatorNode(ctx, { frequency: rand(0.2, 0.6) }));
    const flickG = mk(new GainNode(ctx, { gain: 0.008 }));
    flick.connect(flickG).connect(humG.gain);
    hum.connect(humG).connect(out);
    const hum2 = mk(new OscillatorNode(ctx, { frequency: 120 + this._detune * 1.2 }));
    const hum2G = mk(new GainNode(ctx, { gain: 0.012 }));
    hum2.connect(hum2G).connect(out);
    const fizz = mk(new AudioBufferSourceNode(ctx, { buffer: e._buf.crackle, loop: true, playbackRate: rand(0.8, 1.2) }));
    const fizzHP = mk(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 2500, Q: 0.7 }));
    const fizzG = mk(new GainNode(ctx, { gain: 0.05 }));
    fizz.connect(fizzHP).connect(fizzG).connect(out);
    const t = ctx.currentTime;
    hum.start(t);
    hum2.start(t);
    flick.start(t);
    fizz.start(t, Math.random() * e._buf.crackle.duration * 0.9);
    this._g = { nodes, srcs: [hum, hum2, flick, fizz], out, dist, panner, fade: -1 };
    this._applyLevel(this._flicker);
    this._flicker = false;
    this._tick();
  }

  _applyLevel(toggle) {
    const g = this._g;
    if (!g) return;
    const ctx = /** @type {AudioContext} */ (this._e._ctx);
    const t = ctx.currentTime;
    const p = g.out.gain;
    p.cancelScheduledValues(t);
    if (this._on) {
      p.setValueAtTime(p.value, t);
      if (toggle) {
        // stuttering start-up flicker
        p.linearRampToValueAtTime(1, t + 0.03);
        p.linearRampToValueAtTime(0.1, t + 0.09);
        p.linearRampToValueAtTime(0.9, t + 0.14);
        p.linearRampToValueAtTime(0.3, t + 0.2);
        p.linearRampToValueAtTime(1, t + 0.3);
      } else {
        p.linearRampToValueAtTime(1, t + 0.4);
      }
    } else {
      p.setTargetAtTime(0, t, 0.03);
      this._offTimer = t + 0.4;
    }
  }

  _teardown() {
    const g = this._g;
    this._g = null;
    if (!g) return;
    const ctx = /** @type {AudioContext} */ (this._e._ctx);
    const t = ctx.currentTime;
    g.out.gain.cancelScheduledValues(t);
    g.out.gain.setTargetAtTime(0, t, 0.02);
    const first = g.srcs[0];
    first.onended = () => {
      first.onended = null;
      for (const n of g.nodes) {
        try {
          n.disconnect();
        } catch (err) {
          console.warn('AudioEngine: lamp disconnect failed', err);
        }
      }
      g.nodes.length = 0;
    };
    for (const s of g.srcs) s.stop(t + 0.12);
  }
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

/** Procedural Web Audio engine. Construct freely; call `init()` from a user gesture. */
export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this._ctx = null;
    /** @type {Promise<void>|null} */
    this._initPromise = null;
    this._ready = false;
    this._userSuspended = false;
    this._volume = 0.8;
    this._underwater = false;
    this._tensionTarget = 0;
    this._tension = 0;
    this._tensionApplied = -1;
    this._heartbeat = 0;
    this._breath = 1;
    this._strain = 0;
    this._strainApplied = -1;
    this._ambientOn = true;
    this._lis = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
    /** @type {Set<Shot>} */
    this._shots = new Set();
    /** @type {Set<CreatureVoice>} */
    this._voices = new Set();
    /** @type {Set<LampHum>} */
    this._lamps = new Set();
    /** @type {Map<string, number>} */
    this._lastPlay = new Map();
    /** @type {Map<number, Float32Array>} */
    this._curves = new Map();
    this._sched = { hb: 0, pulse: 0, drum: 0, drumStep: 0, throat: 0, slide: 0 };
    this._amb = { drip: 1.2, creak: rand(4, 10), groan: rand(14, 28), slosh: rand(6, 14), moan: rand(40, 90), glass: rand(8, 18), bub: 1.5 };
    this._gestureHandler = null;
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Creates the AudioContext (call from a user gesture), builds the graph and
   * starts the ambient beds. Idempotent: later calls return the same promise.
   * @returns {Promise<void>}
   */
  init() {
    if (this._initPromise) return this._initPromise;
    const AC = typeof window !== 'undefined' ? window.AudioContext || /** @type {typeof AudioContext|undefined} */ (window['webkitAudioContext']) : undefined;
    if (!AC) {
      console.warn('AudioEngine: Web Audio API unavailable');
      this._initPromise = Promise.resolve();
      return this._initPromise;
    }
    this._initPromise = this._build(AC).catch((err) => {
      console.warn('AudioEngine: init failed', err);
      this._ready = false;
      if (this._ctx) this._ctx.close().catch((e) => console.warn('AudioEngine: close failed', e));
      this._ctx = null;
      this._initPromise = null;
    });
    return this._initPromise;
  }

  /** @returns {boolean} true once the graph is built. */
  get ready() {
    return this._ready;
  }

  /** Pauses all audio (pause menu). */
  suspend() {
    this._userSuspended = true;
    if (this._ctx && this._ctx.state === 'running') {
      this._ctx.suspend().catch((err) => console.warn('AudioEngine: suspend failed', err));
    }
  }

  /** Resumes audio after `suspend()`. */
  resume() {
    this._userSuspended = false;
    if (this._ctx && this._ctx.state !== 'running' && this._ctx.state !== 'closed') {
      this._ctx.resume().catch((err) => console.warn('AudioEngine: resume failed', err));
    }
  }

  /** @param {number} v master volume 0..1 (smoothed) */
  setMasterVolume(v) {
    this._volume = clamp01(v);
    if (this._ready) this._to(this._master.gain, this._volume * MASTER_BASE, 0.05);
  }

  /**
   * Updates the listener. Call every frame.
   * @param {Vec3} pos
   * @param {Vec3} forward
   * @param {Vec3} up
   */
  setListener(pos, forward, up) {
    const p = toVec(pos);
    const f = toVec(forward);
    const u = toVec(up);
    if (p) this._lis.pos = p;
    if (f && Math.hypot(f.x, f.y, f.z) > 1e-6) this._lis.fwd = f;
    if (u && Math.hypot(u.x, u.y, u.z) > 1e-6) this._lis.up = u;
    if (this._ready) this._applyListener(false);
  }

  /** @param {boolean} on player's head is underwater (smooth ~0.35 s transition + plunge/surface whoosh) */
  setUnderwater(on) {
    const v = !!on;
    if (v === this._underwater) return;
    this._underwater = v;
    if (!this._ready) return;
    this._applyUnderwater(false);
    if (v) this._plunge();
    else this._surfaceWhoosh();
  }

  /** @param {number} t tension 0..1 (0 lonely drone, 0.4 uneasy pad + pulses, 1 chase) */
  setTension(t) {
    this._tensionTarget = clamp01(t);
  }

  /** @param {number} r heartbeat 0 = off, 0..1 → 60..150 bpm and louder */
  setHeartbeat(r) {
    this._heartbeat = clamp01(r);
  }

  /** @param {number} level air remaining 0..1 (strain effects below ~0.3 while underwater) */
  setBreath(level) {
    this._breath = clamp01(level);
  }

  /**
   * Per-frame update: tension layers, heartbeat, breath strain, random ambience, lamp culling.
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this._live()) return;
    const d = clamp(num(dt, 0), 0, 0.25);
    const now = /** @type {AudioContext} */ (this._ctx).currentTime;
    this._updateTension(d, now);
    this._updateHeartbeat(now);
    this._updateBreath(d);
    if (this._ambientOn) this._updateAmbient(d);
    for (const lamp of this._lamps) lamp._tick();
  }

  // ------------------------------------------------------------------ player one-shots

  /** Wet ceramic tile footstep with splashy tail. @param {number} intensity 0..1 */
  footstep(intensity = 0.5) {
    const i = clamp01(intensity);
    const s = this._shot({ key: 'step', gap: 0.07, gain: 0.3 + 0.45 * i, send: 0.18, echo: 0.03, pan: rand(-0.15, 0.15) });
    if (!s) return;
    const t = s.t;
    hit(s, s.out, t, 'white', 'bandpass', rand(2600, 3900), 2.5, 0.0008, 0.03, 0.45 + 0.3 * i);
    modal(s, s.out, t, rand(1700, 2400), TILE, 0.07, 0.035);
    hit(s, s.out, t + 0.003, 'brown', 'lowpass', 240 + 200 * i, 0.8, 0.004, 0.08, 0.9 + 0.5 * i);
    const st = t + rand(0.008, 0.025);
    const [, sp] = nz(s, 'white', st, st + 0.55, 'bandpass', rand(1500, 2600), 0.8);
    const sg = s.gain(0);
    sg.gain.setValueAtTime(0, st);
    sg.gain.linearRampToValueAtTime(0.22 + 0.35 * i, st + 0.012);
    sg.gain.setTargetAtTime(0, st + 0.015, 0.045 + 0.05 * i);
    sp.connect(sg).connect(s.out);
    const drops = 1 + Math.floor(rand(0, 2 + 3 * i));
    for (let k = 0; k < drops; k++) {
      blip(s, s.out, st + rand(0.03, 0.28), rand(1300, 3200), rand(1.3, 2), rand(0.025, 0.06), rand(0.02, 0.06), 0.001);
    }
  }

  /** Landing on wet tiles after a jump. @param {number} intensity 0..1 */
  jumpLand(intensity = 0.6) {
    const i = clamp01(intensity);
    const s = this._shot({ key: 'land', gap: 0.15, gain: 0.45 + 0.45 * i, send: 0.25, echo: 0.06 });
    if (!s) return;
    const t = s.t;
    for (const dt of [0, rand(0.015, 0.035)]) {
      hit(s, s.out, t + dt, 'white', 'bandpass', rand(2400, 3400), 2, 0.001, 0.04, 0.4);
      hit(s, s.out, t + dt, 'brown', 'lowpass', 420, 0.8, 0.003, 0.12, 1);
    }
    toneDrop(s, s.out, t, 82, 44, 0.12, 0.003, 0.2, 0.55 + 0.3 * i);
    modal(s, s.out, t, rand(1500, 2100), TILE, 0.1, 0.03);
    const [, sp] = nz(s, 'white', t + 0.01, t + 0.9, 'bandpass', 1800, 0.7);
    const sg = s.gain(0);
    perc(sg.gain, t + 0.01, 0.01, 0.35 + 0.25 * i, 0.35 + 0.3 * i);
    sp.connect(sg).connect(s.out);
    dropletRain(s, s.out, t + 0.04, 4 + Math.floor(6 * i), 0.6, 1200, 3200, 0.06);
  }

  /**
   * Water splash / entering water.
   * @param {number} size 0..1
   * @param {Vec3} [pos] optional world position
   */
  splash(size = 0.5, pos) {
    const z = clamp01(size);
    const p = toVec(pos);
    const s = this._shot({ key: 'splash', gap: 0.08, pos: p, ref: 4, gain: 0.35 + 0.5 * z, send: 0.35, echo: 0.08, priority: z > 0.6 });
    if (!s) return;
    const t = s.t;
    hit(s, s.out, t, 'white', 'highpass', 900, 0.7, 0.002, 0.07 + 0.08 * z, 0.5 + 0.3 * z);
    const [bf, body] = nz(s, 'white', t, t + 2.4, 'bandpass', 2800, 0.7);
    bf.frequency.setValueAtTime(2800, t);
    bf.frequency.exponentialRampToValueAtTime(800, t + 0.5 + 0.5 * z);
    const bg = s.gain(0);
    perc(bg.gain, t, 0.012, 0.35 + 0.9 * z, 0.55 + 0.3 * z);
    body.connect(bg).connect(s.out);
    if (z > 0.25) {
      toneDrop(s, s.out, t + 0.01, 150, 55, 0.25, 0.004, 0.3, 0.45 * z);
      hit(s, s.out, t + 0.01, 'brown', 'lowpass', 200, 0.8, 0.01, 0.4, 1.2 * z);
    }
    dropletRain(s, s.out, t + 0.08, 6 + Math.floor(22 * z), 0.35 + 1.1 * z, 1000, 3400, 0.07);
    bubbleBurst(s, s.out, t + 0.2, 3 + Math.floor(8 * z), 0.8, 180, 600, 0.06);
  }

  /**
   * Swim stroke.
   * @param {boolean} underwater true = underwater whoosh, false = surface slosh
   * @param {number} intensity 0..1
   */
  swimStroke(underwater = false, intensity = 0.5) {
    const i = clamp01(intensity);
    if (underwater) {
      const s = this._shot({ key: 'stroke', gap: 0.12, bus: this._bodyBus, gain: 0.35 + 0.45 * i, send: 0.08 });
      if (!s) return;
      const t = s.t;
      const [lp, w] = nz(s, 'pink', t, t + 0.9, 'lowpass', 200, 1.5);
      lp.frequency.setValueAtTime(180, t);
      lp.frequency.exponentialRampToValueAtTime(650 + 300 * i, t + 0.2);
      lp.frequency.exponentialRampToValueAtTime(170, t + 0.7);
      const g = s.gain(0);
      swell(g.gain, t, 0.18, 0.05, 0.5, 0.6);
      w.connect(g).connect(s.out);
      hit(s, s.out, t, 'brown', 'lowpass', 110, 0.9, 0.12, 0.35, 0.8);
      bubbleBurst(s, s.out, t + 0.1, 2 + Math.floor(3 * i), 0.4, 300, 900, 0.05);
    } else {
      const s = this._shot({ key: 'stroke', gap: 0.12, gain: 0.3 + 0.4 * i, send: 0.25, echo: 0.05, pan: rand(-0.3, 0.3) });
      if (!s) return;
      const t = s.t;
      const [bp, w] = nz(s, 'white', t, t + 0.8, 'bandpass', 650, 0.9);
      bp.frequency.setValueAtTime(600, t);
      bp.frequency.exponentialRampToValueAtTime(1300, t + 0.18);
      bp.frequency.exponentialRampToValueAtTime(700, t + 0.6);
      const g = s.gain(0);
      swell(g.gain, t, 0.07, 0.1, 0.4, 0.45);
      w.connect(g).connect(s.out);
      const [, lo] = nz(s, 'pink', t, t + 0.7, 'lowpass', 350, 0.9);
      const lg = s.gain(0);
      swell(lg.gain, t + 0.02, 0.1, 0.05, 0.35, 0.5);
      lo.connect(lg).connect(s.out);
      dropletRain(s, s.out, t + 0.12, 3 + Math.floor(4 * i), 0.5, 1100, 2900, 0.05);
    }
  }

  /** Exhaled bubble burst near the listener. @param {number} amount 0..1 */
  bubbles(amount = 0.5) {
    const a = clamp01(amount);
    if (a <= 0) return;
    const s = this._shot({ key: 'bubbles', gap: 0.08, bus: this._bodyBus, gain: 0.35 + 0.35 * a, send: 0.06 });
    if (!s) return;
    const t = s.t;
    const span = 0.25 + a;
    bubbleBurst(s, s.out, t, 3 + Math.round(a * 22), span, 250, 1100, 0.22);
    const [, rush] = nz(s, 'pink', t, t + span + 0.3, 'bandpass', 350, 0.8);
    const rg = s.gain(0);
    swell(rg.gain, t, 0.03, span * 0.5, 0.25, 0.3 * a);
    rush.connect(rg).connect(s.out);
  }

  /** Surfacing gasp after a long dive, then panting. */
  gasp() {
    const s = this._shot({ key: 'gasp', gap: 0.5, bus: this._bodyBus, gain: 0.55, send: 0.12, priority: true });
    if (!s) return;
    const t = s.t;
    breath(s, s.out, t, 0.55, 850, 1700, 0.9, 170, 1.15);
    breath(s, s.out, t + 0.72, 0.45, 600, 1150, 0.35, 0, 0.9);
    breath(s, s.out, t + 1.3, 0.38, 800, 1500, 0.45, 0, 1.1);
    breath(s, s.out, t + 1.8, 0.5, 580, 1100, 0.28, 0, 0.9);
  }

  /** Hands on wet tile, pulling out of the pool, water running off. */
  climbOut() {
    const s = this._shot({ key: 'climb', gap: 0.5, gain: 0.55, send: 0.25, echo: 0.05 });
    if (!s) return;
    const t = s.t;
    for (const dt of [0, 0.18]) {
      hit(s, s.out, t + dt, 'white', 'bandpass', rand(1300, 1800), 1.2, 0.001, 0.05, 0.6);
      hit(s, s.out, t + dt, 'brown', 'lowpass', 300, 0.8, 0.003, 0.08, 0.8);
    }
    const [, sheet] = nz(s, 'white', t + 0.25, t + 2, 'bandpass', 1800, 0.7);
    const sg = s.gain(0);
    swell(sg.gain, t + 0.25, 0.05, 0.2, 1.1, 0.35);
    sheet.connect(sg).connect(s.out);
    const [, slosh] = nz(s, 'pink', t + 0.2, t + 1.6, 'lowpass', 700, 0.8);
    const lg = s.gain(0);
    swell(lg.gain, t + 0.2, 0.1, 0.2, 0.9, 0.35);
    slosh.connect(lg).connect(s.out);
    hit(s, s.out, t + 0.35, 'brown', 'bandpass', 260, 1.2, 0.05, 0.25, 0.5);
    dropletRain(s, s.out, t + 0.4, 16, 2.4, 1100, 3000, 0.07);
  }

  // ------------------------------------------------------------------ world one-shots

  /** ~2.5 s rusty valve wheel groan with ratchet clicks. @param {Vec3} [pos] */
  valveTurn(pos) {
    const s = this._shot({ key: 'valve', gap: 0.6, pos: toVec(pos), ref: 3, gain: 0.55, send: 0.4, echo: 0.1, priority: true });
    if (!s) return;
    const t = s.t;
    const dur = 2.5;
    creak(s, s.out, t, dur, rand(62, 80), 0.35, [[430, 18, 1], [1170, 25, 0.7], [2310, 30, 0.4]]);
    creak(s, s.out, t + 0.4, dur - 0.6, rand(140, 180), 0.12, [[900, 20, 1], [1650, 25, 0.6]]);
    const times = [];
    const amps = [];
    let tt = t + rand(0.05, 0.2);
    while (tt < t + dur - 0.1) {
      times.push(tt);
      amps.push(rand(0.6, 1));
      tt += rand(0.16, 0.26);
    }
    clickTrain(s, s.out, times, amps, 3800, 6, 1200, 15, 0.6);
    const [, grit] = nz(s, 'white', t, t + dur, 'bandpass', 3000, 2);
    const gg = s.gain(0);
    jaggedEnv(gg.gain, t, dur, 0.06, [0.05, 0.15], 0.1);
    grit.connect(gg).connect(s.out);
  }

  /** Heavy clunk, distant machinery rumble, far echoing klaxon (loud event). @param {Vec3} [pos] */
  valveDone(pos) {
    const p = toVec(pos);
    const a = this._shot({ key: 'valveDone', gap: 1, pos: p, ref: 3, gain: 0.8, send: 0.5, echo: 0.2, priority: true });
    if (!a) return;
    const t = a.t;
    toneDrop(a, a.out, t, 64, 38, 0.2, 0.002, 0.45, 0.9);
    hit(a, a.out, t, 'brown', 'lowpass', 900, 0.8, 0.002, 0.14, 1.2);
    hit(a, a.out, t, 'white', 'bandpass', 1400, 1, 0.001, 0.05, 0.5);
    modal(a, a.out, t, rand(150, 190), PLATE, 1.6, 0.18);
    const b = this._shot({ gain: 0.6, send: 0.6, priority: true, at: t + 0.4 });
    if (b) {
      const tb = b.t;
      const [, rum] = nz(b, 'brown', tb, tb + 9, 'lowpass', 85, 1.2);
      const throb = b.gain(0.7);
      const lfo = b.osc('sine', 6.5, tb, tb + 9);
      const lg = b.gain(0.3);
      lfo.connect(lg).connect(throb.gain);
      const env = b.gain(0);
      swell(env.gain, tb, 1.8, 3, 3.6, 1.6);
      rum.connect(throb).connect(env).connect(b.out);
      const motor = b.osc('sawtooth', 31, tb, tb + 9);
      const mlp = b.filter('lowpass', 130, 1);
      const mg = b.gain(0);
      swell(mg.gain, tb + 0.3, 2, 2.6, 3.5, 0.18);
      motor.connect(mlp).connect(mg).connect(b.out);
      const rat = b.noise('crackle', tb, tb + 9);
      const rbp = b.filter('bandpass', 1300, 1.5);
      const rg = b.gain(0);
      swell(rg.gain, tb + 0.5, 1.5, 3, 3, 0.8);
      rat.connect(rbp).connect(rg).connect(b.out);
    }
    const c = this._shot({ gain: 0.2, send: 1.4, echo: 0.9, priority: true, at: t + 1.3, pan: rand(-0.5, 0.5) });
    if (c) {
      const tc = c.t;
      for (let k = 0; k < 3; k++) {
        const tk = tc + k * 1.4;
        const o1 = c.osc('square', 185, tk, tk + 1.3);
        const o2 = c.osc('sawtooth', 277.2, tk, tk + 1.3);
        for (const [o, f] of [[o1, 185], [o2, 277.2]]) {
          o.frequency.setValueAtTime(f * 0.94, tk);
          o.frequency.linearRampToValueAtTime(f, tk + 0.12);
          o.frequency.setValueAtTime(f, tk + 0.9);
          o.frequency.linearRampToValueAtTime(f * 0.9, tk + 1.2);
        }
        const lp = c.filter('lowpass', 1400, 0.7);
        const bp = c.filter('bandpass', 700, 0.9);
        const g = c.gain(0);
        swell(g.gain, tk, 0.08, 0.85, 0.3, 0.8);
        o1.connect(lp);
        o2.connect(lp);
        lp.connect(bp).connect(g).connect(c.out);
      }
    }
  }

  /** ~6 s heavy steel gate grinding upward, chains, water rushing through. @param {Vec3} [pos] */
  gateOpen(pos) {
    const s = this._shot({ key: 'gate', gap: 1, pos: toVec(pos), ref: 5, gain: 0.6, send: 0.45, echo: 0.1, priority: true });
    if (!s) return;
    const t = s.t;
    const D = 6;
    // latch release
    hit(s, s.out, t, 'brown', 'lowpass', 700, 0.8, 0.002, 0.15, 1);
    modal(s, s.out, t, rand(210, 240), PLATE, 1, 0.12);
    // motor / rumble
    for (const f of [36, 36.4]) {
      const o = s.osc('sawtooth', f, t, t + D + 1);
      const lp = s.filter('lowpass', 140, 1);
      const g = s.gain(0);
      swell(g.gain, t + 0.1, 0.6, D - 1, 0.8, 0.22);
      o.connect(lp).connect(g).connect(s.out);
    }
    // grinding steel on steel: noise bands chopped by a wandering modulator
    const grindAm = s.gain(0.4);
    const mod = s.noise('brown', t, t + D + 1, 0.4);
    const modG = s.gain(1.4);
    mod.connect(modG).connect(grindAm.gain);
    const grindEnv = s.gain(0);
    swell(grindEnv.gain, t + 0.2, 0.5, D - 1, 0.6, 0.55);
    const sh = s.shaper(3);
    for (const [f, q] of [[420, 3], [1250, 5], [2600, 6]]) {
      const [, band] = nz(s, 'white', t, t + D + 1, 'bandpass', f, q);
      band.connect(grindAm);
    }
    grindAm.connect(sh).connect(grindEnv).connect(s.out);
    // chains
    const times = [];
    const amps = [];
    let tt = t + 0.3;
    while (tt < t + D - 0.3) {
      times.push(tt);
      amps.push(rand(0.15, 1));
      tt += rand(0.03, 0.09);
    }
    clickTrain(s, s.out, times, amps.map((x) => x * 0.35), 3200, 4, 5500, 6, 0.5);
    // friction squeals
    for (let k = 0; k < 2; k++) {
      const ts = t + rand(0.8, D - 1.8);
      const f = rand(700, 1400);
      const o = s.osc('triangle', f, ts, ts + 1.8);
      const vib = s.osc('sine', rand(5, 8), ts, ts + 1.8);
      const vg = s.gain(f * 0.02);
      vib.connect(vg).connect(o.frequency);
      const bp = s.filter('bandpass', f, 8);
      const g = s.gain(0);
      swell(g.gain, ts, 0.3, 0.6, 0.6, 0.12);
      o.connect(bp).connect(g).connect(s.out);
    }
    // water rushing in
    const [, rush] = nz(s, 'pink', t + 1, t + D + 3, 'bandpass', 650, 0.5);
    const rg = s.gain(0);
    swell(rg.gain, t + 1.2, 2.5, D - 3.2, 2.5, 0.55);
    rush.connect(rg).connect(s.out);
    const [, flow] = nz(s, 'brown', t + 1, t + D + 3, 'lowpass', 220, 0.7);
    const fg = s.gain(0);
    swell(fg.gain, t + 1.5, 2.5, D - 3.5, 2.5, 0.8);
    flow.connect(fg).connect(s.out);
    // final stop clunk
    hit(s, s.out, t + D, 'brown', 'lowpass', 600, 0.8, 0.002, 0.3, 1.2);
    toneDrop(s, s.out, t + D, 58, 34, 0.25, 0.002, 0.5, 0.7);
    modal(s, s.out, t + D, rand(120, 150), PLATE, 1.8, 0.15);
  }

  // ------------------------------------------------------------------ UI / feedback

  /** Subtle warm, safe-feeling chime. */
  checkpoint() {
    const s = this._shot({ key: 'checkpoint', gap: 1, bus: this._musicBus, gain: 0.3, send: 0.35 });
    if (!s) return;
    const t = s.t;
    [[220, 0], [329.63, 0.09], [440, 0.18], [554.37, 0.32]].forEach(([f, dt], k) => {
      const o = s.osc('sine', f, t + dt, t + dt + 4.5);
      const tri = s.osc('triangle', f * 2, t + dt, t + dt + 4.5);
      const g = s.gain(0);
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(0.28 / (1 + k * 0.3), t + dt + 0.25);
      g.gain.setTargetAtTime(0, t + dt + 0.3, 0.9);
      const tg = s.gain(0.06);
      o.connect(g);
      tri.connect(tg).connect(g);
      g.connect(s.out);
    });
    const [, air] = nz(s, 'pink', t, t + 2.2, 'bandpass', 2000, 0.6);
    const ag = s.gain(0);
    swell(ag.gain, t, 0.4, 0.2, 1.4, 0.05);
    air.connect(ag).connect(s.out);
  }

  /** Small item pickup confirmation. */
  pickup() {
    const s = this._shot({ key: 'pickup', gap: 0.1, bus: this._uiBus, gain: 0.3 });
    if (!s) return;
    const t = s.t;
    for (const [f, dt] of [[660, 0], [990, 0.075]]) {
      const o = s.osc('sine', f, t + dt, t + dt + 0.4);
      const g = s.gain(0);
      perc(g.gain, t + dt, 0.004, 0.22, 0.4);
      o.connect(g).connect(s.out);
      const o2 = s.osc('triangle', f * 2, t + dt, t + dt + 0.2);
      const g2 = s.gain(0);
      perc(g2.gain, t + dt, 0.003, 0.08, 0.06);
      o2.connect(g2).connect(s.out);
    }
  }

  /** Menu hover tick. */
  uiHover() {
    const s = this._shot({ key: 'hover', gap: 0.035, bus: this._uiBus, gain: 0.18 });
    if (!s) return;
    const o = s.osc('sine', 1800, s.t, s.t + 0.08);
    const g = s.gain(0);
    perc(g.gain, s.t, 0.002, 0.04, 0.35);
    o.connect(g).connect(s.out);
  }

  /** Menu click. */
  uiClick() {
    const s = this._shot({ key: 'click', gap: 0.05, bus: this._uiBus, gain: 0.3 });
    if (!s) return;
    const t = s.t;
    hit(s, s.out, t, 'white', 'bandpass', 2500, 2, 0.001, 0.02, 0.5);
    toneDrop(s, s.out, t, 880, 520, 0.06, 0.002, 0.09, 0.3);
  }

  // ------------------------------------------------------------------ stingers

  /** Sharp dissonant stinger: a creature noticed the player. */
  spotted() {
    const s = this._shot({ key: 'spotted', gap: 0.8, bus: this._musicBus, gain: 0.45, send: 0.4, priority: true });
    if (!s) return;
    const t = s.t;
    const hp = s.filter('highpass', 300, 0.7);
    const bp = s.filter('peaking', 1800, 0.8, 5);
    const env = s.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.006);
    env.gain.setTargetAtTime(0.35, t + 0.01, 0.12);
    env.gain.setTargetAtTime(0, t + 0.5, 0.35);
    [466.16, 493.88, 698.46, 739.99, 1479.98, 1567.98].forEach((f, k) => {
      const o = s.osc('sawtooth', f, t, t + 2.4);
      o.detune.setValueAtTime(rand(-12, 12), t);
      o.detune.linearRampToValueAtTime(-80 + rand(-20, 20), t + 1.8);
      const g = s.gain(0.1 / (1 + k * 0.15));
      o.connect(g).connect(hp);
    });
    hp.connect(bp).connect(env).connect(s.out);
    toneDrop(s, s.out, t, 95, 40, 0.4, 0.003, 0.8, 0.7);
    hit(s, s.out, t, 'white', 'bandpass', 3500, 2, 0.002, 0.3, 0.3);
  }

  /** Brutal chase stinger plus a creature roar. */
  chaseStart() {
    const s = this._shot({ key: 'chase', gap: 1, bus: this._musicBus, gain: 0.55, send: 0.5, priority: true });
    if (!s) return;
    const t = s.t;
    const boom = s.gain(1);
    const sh = s.shaper(3);
    toneDrop(s, boom, t, 58, 26, 1.2, 0.003, 1.8, 0.9);
    boom.connect(sh).connect(s.out);
    hit(s, s.out, t, 'brown', 'lowpass', 700, 0.8, 0.002, 0.5, 1.2);
    hit(s, s.out, t, 'white', 'highpass', 2000, 0.7, 0.001, 0.25, 0.25);
    const hp = s.filter('highpass', 600, 0.7);
    const bp = s.filter('peaking', 2400, 0.8, 6);
    const env = s.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.01);
    env.gain.setTargetAtTime(0.4, t + 0.02, 0.2);
    env.gain.setTargetAtTime(0, t + 1.2, 0.4);
    [1174.66, 1244.51, 1661.22, 1760, 2349.32].forEach((f) => {
      const o = s.osc('sawtooth', f, t, t + 3.2);
      o.detune.setValueAtTime(rand(-15, 15), t);
      o.detune.linearRampToValueAtTime(-300 + rand(-40, 40), t + 2.2);
      const g = s.gain(0.07);
      o.connect(g).connect(hp);
    });
    hp.connect(bp).connect(env).connect(s.out);
    modal(s, s.out, t, rand(90, 120), PLATE, 1.6, 0.12);
    const r = this._shot({ bus: this._waterBus, gain: 0.55, send: 0.6, echo: 0.15, pan: rand(-0.4, 0.4), priority: true, at: t + 0.25 });
    if (r) synthRoar(r, r.out, r.t, { dur: 2.4, f0: 70, amp: 0.6, bright: 1 });
  }

  /** Tension release when the creature loses the player. */
  lostThem() {
    const s = this._shot({ key: 'lost', gap: 1, bus: this._musicBus, gain: 0.45, send: 0.5 });
    if (!s) return;
    const t = s.t;
    const [bf, ex] = nz(s, 'pink', t, t + 3.6, 'bandpass', 1100, 1.2);
    bf.frequency.setValueAtTime(1100, t);
    bf.frequency.exponentialRampToValueAtTime(260, t + 2.8);
    const eg = s.gain(0);
    swell(eg.gain, t, 0.35, 0.6, 2.3, 0.35);
    ex.connect(eg).connect(s.out);
    for (const [f0, f1, a] of [[110, 73.42, 0.22], [55, 49, 0.25]]) {
      const o = s.osc('sine', f0, t, t + 4.2);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 3);
      const g = s.gain(0);
      swell(g.gain, t, 0.6, 1, 2.4, a);
      o.connect(g).connect(s.out);
    }
  }

  /** Caught: close roar, crunch, gurgle, then near-silence with ear ringing. */
  caught() {
    const s = this._shot({ key: 'caught', gap: 2, bus: this._bodyBus, gain: 0.9, send: 0.15, priority: true });
    if (!s) return;
    const t = s.t;
    synthRoar(s, s.out, t, { dur: 1.6, f0: 88, amp: 0.7, bright: 1.3, drive: 14 });
    const c = this._shot({ bus: this._bodyBus, gain: 0.8, priority: true, at: t + 0.55 });
    if (c) {
      const tc = c.t;
      const times = [];
      const amps = [];
      let tt = tc;
      for (let k = 0; k < 9; k++) {
        tt += rand(0.012, 0.04);
        times.push(tt);
        amps.push(rand(0.6, 1));
      }
      const crunch = c.gain(1.5);
      const sh = c.shaper(6);
      clickTrain(c, crunch, times, amps, 1800, 1.5, 700, 4, 0.8);
      crunch.connect(sh).connect(c.out);
      hit(c, c.out, tc, 'brown', 'lowpass', 400, 0.8, 0.003, 0.25, 1.4);
      toneDrop(c, c.out, tc, 72, 34, 0.2, 0.002, 0.35, 0.8);
      bubbleBurst(c, c.out, tc + 0.3, 18, 1.4, 140, 480, 0.2);
      const [, gur] = nz(c, 'brown', tc + 0.2, tc + 1.8, 'lowpass', 600, 1.5);
      const am = c.gain(0.5);
      const lfo = c.osc('sine', 13, tc + 0.2, tc + 1.8);
      const lg = c.gain(0.5);
      lfo.connect(lg).connect(am.gain);
      const gg = c.gain(0);
      swell(gg.gain, tc + 0.2, 0.2, 0.7, 0.6, 1.1);
      gur.connect(am).connect(gg).connect(c.out);
    }
    const cut = t + 2.1;
    this._duckTo(0.015, cut, 0.03);
    const r = this._shot({ bus: this._overlayBus, gain: 0.06, priority: true, at: cut });
    if (r) {
      for (const f of [3950, 5277]) {
        const o = r.osc('sine', f, r.t, r.t + 6);
        const g = r.gain(0);
        swell(g.gain, r.t, 0.02, 0.6, 5, f > 5000 ? 0.4 : 1);
        o.connect(g).connect(r.out);
      }
    }
  }

  /** Respawn: soft inhale and world fading back in. */
  respawn() {
    if (!this._ready) return;
    const ctx = /** @type {AudioContext} */ (this._ctx);
    this._duckTo(1, ctx.currentTime + 0.2, 0.9);
    const s = this._shot({ key: 'respawn', gap: 0.5, bus: this._bodyBus, gain: 0.45, send: 0.2, priority: true });
    if (s) breath(s, s.out, s.t + 0.3, 1.4, 420, 1000, 0.6, 0, 2.2);
    const r = this._shot({ bus: this._overlayBus, gain: 0.035, priority: true });
    if (r) {
      const o = r.osc('sine', 4200, r.t, r.t + 4);
      const g = r.gain(0);
      swell(g.gain, r.t, 0.05, 0.3, 3.4, 1);
      o.connect(g).connect(r.out);
    }
  }

  /** Drowning: choking, big bubbles, fade to near-silence. */
  drown() {
    const s = this._shot({ key: 'drown', gap: 3, bus: this._bodyBus, gain: 0.7, priority: true });
    if (!s) return;
    const t = s.t;
    let tt = t;
    for (let k = 0; k < 7; k++) {
      tt += rand(0.2, 0.45);
      const o = s.osc('sawtooth', rand(90, 125), tt, tt + 0.4);
      const bp = s.filter('bandpass', 480, 2);
      const lp = s.filter('lowpass', 900, 0.7);
      const g = s.gain(0);
      swell(g.gain, tt, 0.02, 0.07, 0.15, 0.6 * (1 - k * 0.08));
      o.connect(bp).connect(lp).connect(g).connect(s.out);
      hit(s, s.out, tt, 'brown', 'lowpass', 200, 0.7, 0.01, 0.15, 0.6);
    }
    bubbleBurst(s, s.out, t + 0.1, 30, 3, 120, 520, 0.28);
    const [, gur] = nz(s, 'brown', t, t + 4.6, 'lowpass', 400, 1.2);
    const am = s.gain(0.5);
    const lfo = s.osc('sine', 9, t, t + 4.6);
    const lg = s.gain(0.5);
    lfo.connect(lg).connect(am.gain);
    const gg = s.gain(0);
    swell(gg.gain, t, 0.2, 2, 2.2, 1);
    gur.connect(am).connect(gg).connect(s.out);
    this._duckTo(0.04, t + 1.5, 1);
  }

  /** Ending: water drains away and a warm airy tone swells. */
  win() {
    if (!this._ready) return;
    this._tensionTarget = 0;
    this._heartbeat = 0;
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const now = ctx.currentTime;
    this._duckTo(0.2, now + 1, 2.5);
    const s = this._shot({ key: 'win', gap: 5, gain: 0.6, send: 0.5, priority: true });
    if (s) {
      const t = s.t;
      const [bf, swirl] = nz(s, 'pink', t, t + 8.5, 'bandpass', 900, 3);
      bf.frequency.setValueAtTime(900, t);
      bf.frequency.exponentialRampToValueAtTime(200, t + 7);
      const lfo = s.osc('sine', 0.9, t, t + 8.5);
      const lg = s.gain(120);
      lfo.connect(lg).connect(bf.frequency);
      const sg = s.gain(0);
      swell(sg.gain, t, 1, 4, 3, 0.55);
      swirl.connect(sg).connect(s.out);
      const [, gur] = nz(s, 'brown', t, t + 8.5, 'lowpass', 300, 1.2);
      const am = s.gain(0.5);
      const lfo2 = s.osc('sine', 5, t, t + 8.5);
      const lg2 = s.gain(0.4);
      lfo2.connect(lg2).connect(am.gain);
      const gg = s.gain(0);
      swell(gg.gain, t, 1, 4, 3, 0.9);
      gur.connect(am).connect(gg).connect(s.out);
      bubbleBurst(s, s.out, t + 0.5, 22, 5.5, 120, 500, 0.12);
    }
    const p = this._shot({ key: 'winPad', gap: 5, bus: this._overlayBus, gain: 0.18, priority: true, at: now + 3 });
    if (p) {
      const t = p.t;
      const lp = p.filter('lowpass', 2400, 0.5);
      const env = p.gain(0);
      swell(env.gain, t, 4, 7, 6, 1);
      [146.83, 220, 293.66, 369.99, 440, 659.25].forEach((f, k) => {
        for (const det of [-4, 4]) {
          const o = p.osc(k < 2 ? 'triangle' : 'sine', f, t, t + 17.5);
          o.detune.value = det + rand(-2, 2);
          const g = p.gain(0.09 / (1 + k * 0.25));
          o.connect(g).connect(lp);
        }
      });
      lp.connect(env).connect(p.out);
      const [, air] = nz(p, 'pink', t, t + 17.5, 'highpass', 3000, 0.5);
      const ag = p.gain(0);
      swell(ag.gain, t, 5, 5, 6, 0.08);
      air.connect(ag).connect(p.out);
    }
  }

  // ------------------------------------------------------------------ other creatures

  /** Lure-fish strike: a wet jaw snap with a sucking implosion and a torn bubble plume. @param {Vec3} [pos] */
  lurkerSnap(pos) {
    const p = toVec(pos);
    const s = this._shot({ key: 'lurkerSnap', gap: 0.6, bus: this._waterBus, pos: p, ref: 5, gain: 0.9, send: 0.5, echo: 0.15, priority: true });
    if (!s) return;
    const t = s.t;
    const [sf, suck] = nz(s, 'pink', t, t + 0.35, 'bandpass', 300, 1.2);
    sf.frequency.setValueAtTime(260, t);
    sf.frequency.exponentialRampToValueAtTime(1400, t + 0.3);
    const sg = s.gain(0);
    swell(sg.gain, t, 0.22, 0.02, 0.06, 0.8);
    suck.connect(sg).connect(s.out);
    const tc = t + 0.3;
    hit(s, s.out, tc, 'white', 'bandpass', 2400, 1.4, 0.001, 0.06, 1.2);
    hit(s, s.out, tc + 0.012, 'white', 'highpass', 4200, 0.8, 0.001, 0.04, 0.6);
    modal(s, s.out, tc, rand(180, 230), [1, 2.3, 3.9, 5.1], 0.18, 0.5);
    toneDrop(s, s.out, tc, 120, 38, 0.3, 0.003, 0.5, 0.8);
    synthGrowl(s, s.out, tc + 0.1, { dur: rand(1, 1.4), f0: rand(52, 64), amp: 0.35, drive: 5 });
    bubbleBurst(s, s.out, tc + 0.05, 14, 0.9, 150, 520, 0.12);
  }

  /** Stinging-colony touch: an electric crackle and a sharp nerve whine. @param {Vec3} [pos] */
  sting(pos) {
    const p = toVec(pos);
    const s = this._shot({ key: 'sting', gap: 0.7, pos: p, ref: 3, gain: 0.7, send: 0.35, priority: true });
    if (!s) return;
    const t = s.t;
    const times = [];
    const amps = [];
    let tt = t;
    while (tt < t + 0.55) {
      times.push(tt);
      amps.push(rand(0.4, 1));
      tt += rand(0.008, 0.04);
    }
    clickTrain(s, s.out, times, amps, 5200, 3, 1800, 8, 0.4);
    const whine = s.osc('sawtooth', 2400, t, t + 1.4);
    whine.frequency.setValueAtTime(2600, t);
    whine.frequency.exponentialRampToValueAtTime(1100, t + 1.3);
    const wf = s.filter('bandpass', 2200, 6);
    const wg = s.gain(0);
    perc(wg.gain, t, 0.01, 0.9, 0.12);
    whine.connect(wf).connect(wg).connect(s.out);
    toneDrop(s, s.out, t, 70, 40, 0.3, 0.004, 0.35, 0.6);
  }

  /** Something enormous passing far below: a slow sub-bass swell with a distant moan. @param {Vec3} [pos] */
  leviathanPass(pos) {
    const p = toVec(pos);
    const s = this._shot({ key: 'leviathan', gap: 20, bus: this._waterBus, pos: p, ref: 60, rolloff: 0.4, gain: 0.9, send: 0.9, echo: 0.3, priority: true });
    if (!s) return;
    const t = s.t;
    const dur = rand(11, 14);
    const sub = s.osc('sine', 22, t, t + dur);
    sub.frequency.setValueAtTime(19, t);
    sub.frequency.linearRampToValueAtTime(27, t + dur * 0.5);
    sub.frequency.linearRampToValueAtTime(18, t + dur);
    const sg = s.gain(0);
    swell(sg.gain, t, dur * 0.4, dur * 0.2, dur * 0.4, 0.9);
    sub.connect(sg).connect(s.out);
    const [rf, rum] = nz(s, 'brown', t, t + dur, 'lowpass', 90, 0.9);
    rf.frequency.setValueAtTime(60, t);
    rf.frequency.linearRampToValueAtTime(140, t + dur * 0.5);
    rf.frequency.linearRampToValueAtTime(50, t + dur);
    const rg = s.gain(0);
    swell(rg.gain, t, dur * 0.45, dur * 0.1, dur * 0.45, 1.1);
    rum.connect(rg).connect(s.out);
    synthWhaleCall(s, s.out, t + dur * 0.3, { dur: rand(6, 8), f0: rand(22, 26), peak: rand(30, 38), end: rand(18, 21), amp: 0.45, drive: 2.5 });
  }

  // ------------------------------------------------------------------ factories

  /**
   * Creates a positional creature voice (safe before init; activates after init).
   * @param {'hunter'|'colossus'} kind
   * @returns {CreatureVoice}
   */
  createCreatureVoice(kind) {
    return new CreatureVoice(this, kind);
  }

  /**
   * Creates a positional lamp hum (audible within ~8 m, distance-culled).
   * @param {Vec3} pos
   * @returns {{setOn(on: boolean): void, setPosition(x: number|Vec3, y?: number, z?: number): void, dispose(): void}}
   */
  createLampHum(pos) {
    return new LampHum(this, pos);
  }

  // ------------------------------------------------------------------ debug (tools only)

  /**
   * Debug-only output meter (lazily taps the final output with an AnalyserNode).
   * @returns {{rms: number, peak: number}} linear RMS and peak of the last ~43 ms
   */
  _debugLevel() {
    if (!this._ready) return { rms: 0, peak: 0 };
    const ctx = /** @type {AudioContext} */ (this._ctx);
    if (!this._debugAnalyser) {
      this._debugAnalyser = new AnalyserNode(ctx, { fftSize: 2048 });
      this._debugBuf = new Float32Array(2048);
      this._trim.connect(this._debugAnalyser);
    }
    const buf = this._debugBuf;
    this._debugAnalyser.getFloatTimeDomainData(buf);
    let sq = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      sq += buf[i] * buf[i];
      peak = Math.max(peak, Math.abs(buf[i]));
    }
    return { rms: Math.sqrt(sq / buf.length), peak };
  }

  // ------------------------------------------------------------------ internals: build

  async _build(AC) {
    const ctx = new AC({ latencyHint: 'interactive' });
    this._ctx = ctx;
    this._buf = {
      white: makeNoise(ctx, 'white', 4),
      pink: makeNoise(ctx, 'pink', 5),
      brown: makeNoise(ctx, 'brown', 6),
      crackle: makeCrackle(ctx, 3),
    };
    this._humWave = this._makeHumWave();
    this._buildMaster();
    this._buildReverb();
    this._buildEcho();
    this._buildBeds();
    this._buildMusic();
    this._buildBody();
    this._ready = true;
    this._applyListener(true);
    this._applyUnderwater(true);
    this._applyTension(true);
    for (const v of this._voices) v._tryBuild();
    if (ctx.state !== 'running' && !this._userSuspended) {
      const resumed = ctx.resume().catch((err) => console.warn('AudioEngine: resume failed', err));
      await Promise.race([resumed, sleep(400)]);
      if (ctx.state !== 'running') this._armGestureResume();
    } else if (this._userSuspended) {
      await ctx.suspend().catch((err) => console.warn('AudioEngine: suspend failed', err));
    }
  }

  _armGestureResume() {
    if (this._gestureHandler || typeof window === 'undefined') return;
    const events = ['pointerdown', 'keydown', 'touchend'];
    const handler = () => {
      const ctx = this._ctx;
      if (!ctx || this._userSuspended) return;
      ctx
        .resume()
        .then(() => {
          if (ctx.state === 'running' && this._gestureHandler) {
            for (const ev of events) window.removeEventListener(ev, this._gestureHandler, true);
            this._gestureHandler = null;
          }
        })
        .catch((err) => console.warn('AudioEngine: resume failed', err));
    };
    this._gestureHandler = handler;
    for (const ev of events) window.addEventListener(ev, handler, true);
  }

  _makeHumWave() {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const n = 28;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let h = 1; h < n; h++) {
      const odd = h % 2 === 1 ? 1 : 0.55;
      imag[h] = (odd / h ** 0.7) * (h === 1 ? 1 : 0.8);
    }
    return ctx.createPeriodicWave(real, imag);
  }

  _buildMaster() {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    this._comp = new DynamicsCompressorNode(ctx, { threshold: -14, knee: 8, ratio: 6, attack: 0.004, release: 0.28 });
    this._trim = new GainNode(ctx, { gain: 0.7 });
    this._master = new GainNode(ctx, { gain: this._volume * MASTER_BASE });
    this._duck = new GainNode(ctx, { gain: 1 });
    this._mix = new GainNode(ctx, { gain: 1 });
    this._mix.connect(this._duck).connect(this._master).connect(this._comp).connect(this._trim).connect(ctx.destination);
    const lp = (q = 0.7) => new BiquadFilterNode(ctx, { type: 'lowpass', frequency: OPEN_HZ, Q: q });
    this._uwFilter = lp();
    this._waterFilter = lp();
    this._bodyFilter = lp();
    this._musicFilter = lp();
    this._airBus = new GainNode(ctx, { gain: 1 });
    this._waterBus = new GainNode(ctx, { gain: 1 });
    this._bodyBus = new GainNode(ctx, { gain: 1 });
    this._musicBus = new GainNode(ctx, { gain: 0.9 });
    this._airBus.connect(this._uwFilter).connect(this._mix);
    this._waterBus.connect(this._waterFilter).connect(this._mix);
    this._bodyBus.connect(this._bodyFilter).connect(this._mix);
    this._musicBus.connect(this._musicFilter).connect(this._mix);
    this._uiBus = new GainNode(ctx, { gain: 0.7 });
    this._uiBus.connect(this._master);
    this._overlayBus = new GainNode(ctx, { gain: 1 });
    this._overlayBus.connect(this._master);
  }

  _buildReverb() {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    this._revIn = new GainNode(ctx, { gain: 1 });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 90, Q: 0.7 });
    this._revIn.connect(hp);
    this._hallVerb = new ConvolverNode(ctx, {
      buffer: makeIR(ctx, { seconds: 5, rt60: 4.4, predelay: 0.022, hiStart: 9000, hiEnd: 1300, damp: 1.1, early: 14, earlySpan: 0.12, earlyGain: 1, flutter: 0.047 }),
    });
    this._poolVerb = new ConvolverNode(ctx, {
      buffer: makeIR(ctx, { seconds: 2.2, rt60: 1.8, predelay: 0.008, hiStart: 1800, hiEnd: 320, damp: 0.5, early: 5, earlySpan: 0.05, earlyGain: 0.6, flutter: 0 }),
    });
    this._hallRet = new GainNode(ctx, { gain: 0.6 });
    this._poolRet = new GainNode(ctx, { gain: 0 });
    hp.connect(this._hallVerb).connect(this._hallRet).connect(this._airBus);
    hp.connect(this._poolVerb).connect(this._poolRet).connect(this._waterBus);
  }

  _buildEcho() {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    this._echoIn = new GainNode(ctx, { gain: 1 });
    const dL = new DelayNode(ctx, { maxDelayTime: 2, delayTime: 0.41 });
    const dR = new DelayNode(ctx, { maxDelayTime: 2, delayTime: 0.63 });
    const lpL = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2600, Q: 0.5 });
    const lpR = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2200, Q: 0.5 });
    const fbL = new GainNode(ctx, { gain: 0.5 });
    const fbR = new GainNode(ctx, { gain: 0.48 });
    this._echoIn.connect(dL);
    dL.connect(lpL).connect(fbL).connect(dR);
    dR.connect(lpR).connect(fbR).connect(dL);
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    lpL.connect(merger, 0, 0);
    lpR.connect(merger, 0, 1);
    this._echoRet = new GainNode(ctx, { gain: 0.5 });
    merger.connect(this._echoRet).connect(this._airBus);
    const toVerb = new GainNode(ctx, { gain: 0.35 });
    this._echoRet.connect(toVerb).connect(this._revIn);
  }

  _buildBeds() {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    // surface: room tone, ventilation air, water lapping at the pool edges
    this._surfBed = new GainNode(ctx, { gain: 1 });
    this._surfBed.connect(this._airBus);
    const tone = this._loop('brown');
    const toneLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 140, Q: 0.7 });
    const toneG = new GainNode(ctx, { gain: 0.07 });
    tone.connect(toneLP).connect(toneG).connect(this._surfBed);
    const air = this._loop('pink');
    const airBP = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 480, Q: 0.6 });
    const airG = new GainNode(ctx, { gain: 0.02 });
    this._lfo(0.043, 0.01, airG.gain);
    air.connect(airBP).connect(airG).connect(this._surfBed);
    for (const [pan, f, r1, r2] of [[-0.55, 420, 0.11, 0.37], [0.6, 360, 0.083, 0.29]]) {
      const src = this._loop('pink', 0.9);
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: f, Q: 1.3 });
      const g = new GainNode(ctx, { gain: 0.03 });
      this._lfo(r1, 0.016, g.gain);
      this._lfo(r2, 0.01, g.gain);
      const p = new StereoPannerNode(ctx, { pan });
      src.connect(bp).connect(g).connect(p).connect(this._surfBed);
    }
    // underwater: pressure rumble, muffled drone, distant hiss
    this._uwBed = new GainNode(ctx, { gain: 0 });
    this._uwBed.connect(this._waterBus);
    const pr = this._loop('brown', 0.7);
    const prLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 85, Q: 1 });
    const prG = new GainNode(ctx, { gain: 0.45 });
    this._lfo(0.07, 0.15, prG.gain);
    pr.connect(prLP).connect(prG).connect(this._uwBed);
    const droneLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 240, Q: 0.7 });
    const droneG = new GainNode(ctx, { gain: 1 });
    this._lfo(0.13, 0.3, droneG.gain);
    droneLP.connect(droneG).connect(this._uwBed);
    for (const [f, a, type] of [[41.2, 0.09, 'sine'], [61.7, 0.05, 'sine'], [82.5, 0.03, 'triangle']]) {
      const o = new OscillatorNode(ctx, { type, frequency: f });
      const g = new GainNode(ctx, { gain: a });
      o.connect(g).connect(droneLP);
      o.start();
    }
    const hiss = this._loop('pink');
    const hissBP = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1100, Q: 0.7 });
    const hissG = new GainNode(ctx, { gain: 0.012 });
    hiss.connect(hissBP).connect(hissG).connect(this._uwBed);
  }

  _buildMusic() {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const m = this._musicBus;
    // lonely drone (always)
    this._droneG = new GainNode(ctx, { gain: 0 });
    this._droneG.connect(m);
    const dLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 380, Q: 0.7 });
    dLP.connect(this._droneG);
    for (const [f, a, type] of [[55, 0.3, 'sine'], [55.27, 0.3, 'sine'], [82.41, 0.1, 'triangle'], [110.3, 0.04, 'triangle']]) {
      const o = new OscillatorNode(ctx, { type, frequency: f });
      const g = new GainNode(ctx, { gain: a });
      o.connect(g).connect(dLP);
      o.start();
    }
    const whistle = this._loop('pink');
    const wBP = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1350, Q: 9 });
    const wG = new GainNode(ctx, { gain: 0.06 });
    this._lfo(0.05, 0.055, wG.gain);
    whistle.connect(wBP).connect(wG).connect(this._droneG);
    // uneasy dissonant pad
    this._padG = new GainNode(ctx, { gain: 0 });
    this._padG.connect(m);
    this._padLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 500, Q: 2.5 });
    this._padLP.connect(this._padG);
    this._lfo(0.05, 220, this._padLP.frequency);
    const warble = new OscillatorNode(ctx, { frequency: 0.17 });
    const warbleG = new GainNode(ctx, { gain: 7 });
    warble.connect(warbleG);
    warble.start();
    for (const f of [73.42, 77.78, 103.83, 110, 146.83, 155.56]) {
      const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: f, detune: rand(-9, 9) });
      const g = new GainNode(ctx, { gain: 0.09 });
      warbleG.connect(o.detune);
      o.connect(g).connect(this._padLP);
      o.start();
    }
    // screeching string cluster (chase)
    this._screechG = new GainNode(ctx, { gain: 0 });
    this._screechG.connect(m);
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 420, Q: 0.7 });
    const pk = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2300, Q: 0.9, gain: 6 });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5500, Q: 0.7 });
    const trem = new GainNode(ctx, { gain: 0.7 });
    this._lfo(10.5, 0.3, trem.gain);
    hp.connect(pk).connect(lp).connect(trem).connect(this._screechG);
    const vib = new OscillatorNode(ctx, { frequency: 5.6 });
    const vibG = new GainNode(ctx, { gain: 22 });
    vib.connect(vibG);
    vib.start();
    this._screech = [622.25, 659.26, 698.46, 932.33, 987.77, 1046.5].map((f) => {
      const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: f });
      const g = new GainNode(ctx, { gain: 0.06 });
      vibG.connect(o.detune);
      o.connect(g).connect(hp);
      o.start();
      return o;
    });
  }

  _buildBody() {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    this._whineG = new GainNode(ctx, { gain: 0 });
    this._whineG.connect(this._bodyBus);
    this._whine = new OscillatorNode(ctx, { frequency: 2900 });
    const w2 = new OscillatorNode(ctx, { frequency: 2937 });
    this._lfo(0.4, 35, this._whine.frequency);
    const g2 = new GainNode(ctx, { gain: 0.5 });
    this._whine.connect(this._whineG);
    w2.connect(g2).connect(this._whineG);
    this._whine.start();
    w2.start();
  }

  // ------------------------------------------------------------------ internals: helpers

  /** @returns {boolean} graph built, context running and not paused */
  _live() {
    return this._ready && !!this._ctx && this._ctx.state === 'running' && !this._userSuspended;
  }

  /** Smoothly moves an AudioParam to `value` (first-order, time-constant `tc`). */
  _to(param, value, tc = 0.05, at) {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const t = at === undefined ? ctx.currentTime : at;
    param.cancelScheduledValues(t);
    param.setTargetAtTime(value, t, Math.max(0.001, tc));
  }

  /** Exponential sweep of a positive AudioParam from its current value. */
  _sweep(param, value, dur) {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const t = ctx.currentTime;
    const cur = Math.max(1e-4, param.value);
    param.cancelScheduledValues(t);
    param.setValueAtTime(cur, t);
    param.exponentialRampToValueAtTime(Math.max(1e-4, value), t + Math.max(0.01, dur));
  }

  _duckTo(v, at, tc) {
    const p = this._duck.gain;
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const now = ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.setTargetAtTime(v, Math.max(now, at), tc);
  }

  _loop(kind, rate = 1) {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const buf = this._buf[kind];
    const n = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true, playbackRate: rate });
    n.start(ctx.currentTime, Math.random() * buf.duration * 0.9);
    return n;
  }

  _lfo(freq, depth, param, type = 'sine') {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const o = new OscillatorNode(ctx, { type, frequency: freq });
    const g = new GainNode(ctx, { gain: depth });
    o.connect(g).connect(param);
    o.start();
    return o;
  }

  _curve(k) {
    const key = Math.round(k * 10);
    let c = this._curves.get(key);
    if (!c) {
      c = makeCurve(key / 10);
      this._curves.set(key, c);
    }
    return c;
  }

  _distance(pos) {
    return dist(this._lis.pos, pos);
  }

  _panner(pos, ref, rolloff) {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 10000;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    return p;
  }

  _setPannerPos(p, pos) {
    if (p.positionX) {
      this._to(p.positionX, pos.x, 0.03);
      this._to(p.positionY, pos.y, 0.03);
      this._to(p.positionZ, pos.z, 0.03);
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
  }

  /**
   * Allocates a one-shot voice, or null when not running / over the voice cap / rate-limited.
   * @returns {Shot|null}
   */
  _shot(o) {
    if (!this._live()) return null;
    if (o.key) {
      const now = performance.now() / 1000;
      const last = this._lastPlay.get(o.key);
      if (last !== undefined && now - last < (o.gap || 0)) return null;
      this._lastPlay.set(o.key, now);
    }
    const n = this._shots.size;
    if (o.ambient && n >= AMBIENT_SHOT_LIMIT) return null;
    if (n >= (o.priority ? MAX_SHOTS_PRIORITY : MAX_SHOTS)) return null;
    const s = new Shot(this, o);
    this._shots.add(s);
    return s;
  }

  _around(minD, maxD, dy = 3) {
    const a = Math.random() * Math.PI * 2;
    const d = rand(minD, maxD);
    const p = this._lis.pos;
    return { x: p.x + Math.cos(a) * d, y: p.y + rand(-dy, dy), z: p.z + Math.sin(a) * d };
  }

  // ------------------------------------------------------------------ internals: state application

  _applyListener(immediate) {
    const ctx = /** @type {AudioContext} */ (this._ctx);
    const L = ctx.listener;
    const { pos, fwd, up } = this._lis;
    if (L.positionX) {
      const tc = immediate ? 0.001 : 0.015;
      const vals = [
        [L.positionX, pos.x], [L.positionY, pos.y], [L.positionZ, pos.z],
        [L.forwardX, fwd.x], [L.forwardY, fwd.y], [L.forwardZ, fwd.z],
        [L.upX, up.x], [L.upY, up.y], [L.upZ, up.z],
      ];
      for (const [param, v] of vals) this._to(param, v, tc);
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  _applyUnderwater(immediate) {
    const uw = this._underwater;
    const T = immediate ? 0.01 : 0.35;
    const tc = immediate ? 0.001 : 0.12;
    this._sweep(this._uwFilter.frequency, uw ? 500 : OPEN_HZ, T);
    this._to(this._uwFilter.Q, uw ? 3.2 : 0.7, tc);
    this._sweep(this._waterFilter.frequency, uw ? 1600 : OPEN_HZ, T);
    this._sweep(this._bodyFilter.frequency, uw ? 3500 : OPEN_HZ, T);
    this._sweep(this._musicFilter.frequency, uw ? 2400 : OPEN_HZ, T);
    this._to(this._surfBed.gain, uw ? 0 : 1, tc);
    this._to(this._uwBed.gain, uw ? 1 : 0, tc);
    this._to(this._hallRet.gain, uw ? 0 : 0.6, tc);
    this._to(this._poolRet.gain, uw ? 0.75 : 0, tc);
    this._to(this._echoRet.gain, uw ? 0.06 : 0.5, tc);
  }

  _applyTension(immediate) {
    const x = this._tension;
    const tc = immediate ? 0.001 : 0.08;
    this._tensionApplied = x;
    this._to(this._droneG.gain, 0.5 * (1 - 0.5 * smoothstep(0.3, 1, x)), tc);
    this._to(this._padG.gain, 0.55 * smoothstep(0.15, 0.5, x) * (1 - 0.3 * smoothstep(0.8, 1, x)), tc);
    this._to(this._screechG.gain, 0.5 * smoothstep(0.68, 1, x), tc);
  }

  // ------------------------------------------------------------------ internals: schedulers

  _updateTension(dt, now) {
    const target = this._tensionTarget;
    const tc = target > this._tension ? 0.5 : 2.2;
    this._tension += (target - this._tension) * (1 - Math.exp(-dt / tc));
    if (Math.abs(this._tension - this._tensionApplied) > 0.003) this._applyTension(false);
    const x = this._tension;
    const S = this._sched;
    // low pulses (uneasy)
    const pulse = smoothstep(0.22, 0.45, x) * (1 - smoothstep(0.7, 0.9, x));
    if (pulse > 0.02) {
      if (S.pulse < now - 0.3) S.pulse = now + 0.05;
      while (S.pulse < now + 0.15) {
        this._pulse(S.pulse, pulse);
        S.pulse += lerp(2.0, 0.85, clamp((x - 0.25) / 0.5, 0, 1)) * rand(0.95, 1.05);
      }
    }
    // chase percussion
    const drum = smoothstep(0.62, 0.9, x);
    if (drum > 0.02) {
      if (S.drum < now - 0.3) {
        S.drum = now + 0.05;
        S.drumStep = 0;
      }
      const bpm = 118 + 44 * smoothstep(0.7, 1, x);
      const step = 60 / bpm / 2;
      while (S.drum < now + 0.15) {
        this._drumHit(S.drum, S.drumStep, drum);
        S.drum += step;
        S.drumStep = (S.drumStep + 1) % DRUM_PATTERN.length;
      }
    }
    // screech cluster slides
    if (x > 0.65) {
      S.slide -= dt;
      if (S.slide <= 0) {
        S.slide = rand(1.2, 3);
        const bend = 120 * smoothstep(0.8, 1, x);
        for (const o of this._screech) this._to(o.detune, rand(-90, 90) + bend, rand(0.2, 0.7));
      }
    }
  }

  _pulse(t, level) {
    const s = this._shot({ bus: this._musicBus, at: t, gain: level * 0.8, send: 0.25, priority: true });
    if (!s) return;
    toneDrop(s, s.out, s.t, 48, 34, 0.5, 0.03, 1.1, 0.9);
    hit(s, s.out, s.t, 'brown', 'lowpass', 160, 0.7, 0.03, 0.5, 0.6);
  }

  _drumHit(t, step, level) {
    const kind = DRUM_PATTERN[step];
    if (!kind) return;
    const s = this._shot({ bus: this._musicBus, at: t, gain: level * 0.75, send: 0.28, priority: true });
    if (!s) return;
    const T = s.t;
    if (kind === 3) {
      const o = s.gain(1);
      const sh = s.shaper(2.5);
      toneDrop(s, o, T, 78, 36, 0.22, 0.002, 0.65, 1);
      o.connect(sh).connect(s.out);
      hit(s, s.out, T, 'brown', 'lowpass', 600, 0.7, 0.002, 0.18, 1.2);
      hit(s, s.out, T, 'white', 'bandpass', 1200, 1, 0.001, 0.04, 0.3);
    } else if (kind === 2) {
      toneDrop(s, s.out, T, 120, 62, 0.14, 0.002, 0.35, 0.65);
      hit(s, s.out, T, 'white', 'bandpass', 900, 1.2, 0.001, 0.07, 0.4);
    } else {
      toneDrop(s, s.out, T, 95, 60, 0.1, 0.002, 0.2, 0.3);
    }
    if (step === 8 && Math.random() < 0.4) modal(s, s.out, T, rand(180, 260), BAR, 0.9, 0.1);
  }

  _updateHeartbeat(now) {
    const r = this._heartbeat;
    const S = this._sched;
    if (r <= 0.001) return;
    if (S.hb < now - 0.3) S.hb = now + 0.05;
    while (S.hb < now + 0.12) {
      const period = 60 / (60 + 90 * r);
      this._beat(S.hb, r, period);
      S.hb += period;
    }
  }

  _beat(t, r, period) {
    const s = this._shot({ bus: this._bodyBus, at: t, gain: 0.3 + 0.6 * r, priority: true });
    if (!s) return;
    const T = s.t;
    const t2 = T + Math.min(0.3, period * 0.36);
    toneDrop(s, s.out, T, 58, 38, 0.12, 0.006, 0.16, 1);
    hit(s, s.out, T, 'brown', 'lowpass', 120, 0.8, 0.004, 0.1, 0.7);
    toneDrop(s, s.out, t2, 52, 34, 0.1, 0.006, 0.13, 0.7);
    hit(s, s.out, t2, 'brown', 'lowpass', 110, 0.8, 0.004, 0.08, 0.45);
  }

  _updateBreath(dt) {
    const strain = this._underwater ? clamp((0.3 - this._breath) / 0.3, 0, 1) : 0;
    this._strain = strain;
    if (Math.abs(strain - this._strainApplied) > 0.01) {
      this._strainApplied = strain;
      this._to(this._whineG.gain, strain ** 1.5 * 0.03, 0.3);
      this._to(this._whine.frequency, 2900 + 1400 * strain, 0.5);
    }
    const S = this._sched;
    if (strain <= 0) {
      S.throat = 0;
      return;
    }
    S.throat -= dt;
    if (S.throat <= 0) {
      S.throat = lerp(1.4, 0.45, strain) * rand(0.85, 1.15);
      this._throatPulse(strain);
    }
  }

  _throatPulse(strain) {
    const s = this._shot({ bus: this._bodyBus, gain: 0.3 + 0.5 * strain, priority: true });
    if (!s) return;
    const t = s.t;
    const o = s.osc('sawtooth', rand(85, 115), t, t + 0.35);
    const bp = s.filter('bandpass', 420, 2.5);
    const lp = s.filter('lowpass', 800, 0.7);
    const g = s.gain(0);
    swell(g.gain, t, 0.025, 0.06, 0.2, 0.5);
    o.connect(bp).connect(lp).connect(g).connect(s.out);
    toneDrop(s, s.out, t, 70, 40, 0.1, 0.005, 0.2, 0.6);
    hit(s, s.out, t, 'brown', 'lowpass', 200, 0.7, 0.01, 0.15, 0.5);
  }

  _updateAmbient(dt) {
    const A = this._amb;
    const uw = this._underwater;
    A.drip -= dt;
    if (A.drip <= 0) {
      A.drip = rand(0.5, 2.6);
      if (!uw) this._ambDrip();
    }
    A.creak -= dt;
    if (A.creak <= 0) {
      A.creak = rand(7, 18);
      this._ambCreak();
    }
    A.groan -= dt;
    if (A.groan <= 0) {
      A.groan = rand(22, 45);
      this._ambGroan();
    }
    A.slosh -= dt;
    if (A.slosh <= 0) {
      A.slosh = rand(9, 22);
      if (!uw) this._ambSlosh();
    }
    A.moan -= dt;
    if (A.moan <= 0) {
      A.moan = rand(55, 140);
      this._ambMoan();
    }
    A.glass -= dt;
    if (A.glass <= 0) {
      A.glass = rand(14, 30);
      if (!uw && this._tension < 0.3) this._ambGlass();
    }
    A.bub -= dt;
    if (A.bub <= 0) {
      A.bub = rand(1.2, 4);
      if (uw) this._ambBubbles();
    }
  }

  _ambDrip() {
    const s = this._shot({ pos: this._around(3, 28), ref: 2, gain: rand(0.2, 0.4), send: 0.6, echo: 0.35, ambient: true });
    if (!s) return;
    const t = s.t;
    const n = Math.random() < 0.3 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const tk = t + k * rand(0.12, 0.3);
      blip(s, s.out, tk, rand(900, 2200), rand(1.4, 2.2), rand(0.05, 0.11), 0.5, 0.001);
      hit(s, s.out, tk, 'white', 'bandpass', 4000, 3, 0.0005, 0.01, 0.2);
    }
  }

  _ambCreak() {
    const s = this._shot({ pos: this._around(10, 35), ref: 5, gain: rand(0.35, 0.6), send: 0.7, echo: 0.3, ambient: true });
    if (!s) return;
    const t = s.t;
    if (Math.random() < 0.5) {
      const n = 2 + Math.floor(rand(0, 3));
      const f = rand(140, 220);
      for (let k = 0; k < n; k++) {
        const tk = t + k * rand(0.25, 0.6);
        hit(s, s.out, tk, 'brown', 'lowpass', 500, 0.8, 0.002, 0.08, 0.7);
        modal(s, s.out, tk, f, [1, 2.9, 6.1], 0.5, 0.25);
      }
    } else {
      creak(s, s.out, t, rand(0.6, 1.4), rand(90, 160), 0.4, [[rand(500, 700), 20, 1], [rand(1300, 1700), 25, 0.6]]);
    }
  }

  _ambGroan() {
    const s = this._shot({ pos: this._around(35, 70), ref: 10, gain: rand(0.5, 0.8), send: 0.9, echo: 0.3, ambient: true });
    if (!s) return;
    const dur = rand(3, 5);
    creak(s, s.out, s.t, dur, rand(38, 55), 0.6, [[140, 12, 1], [330, 16, 0.8], [610, 20, 0.5]]);
  }

  _ambSlosh() {
    const s = this._shot({ pos: this._around(15, 45), ref: 5, gain: rand(0.35, 0.6), send: 0.7, echo: 0.15, ambient: true });
    if (!s) return;
    const t = s.t;
    const dur = rand(1.5, 3);
    const [bp, w] = nz(s, 'pink', t, t + dur + 0.1, 'bandpass', 500, 1);
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.linearRampToValueAtTime(rand(600, 850), t + dur * 0.4);
    bp.frequency.linearRampToValueAtTime(380, t + dur);
    const g = s.gain(0);
    swell(g.gain, t, dur * 0.35, dur * 0.15, dur * 0.5, 0.5);
    w.connect(g).connect(s.out);
    const [, lo] = nz(s, 'brown', t, t + dur + 0.1, 'lowpass', 250, 0.8);
    const lg = s.gain(0);
    swell(lg.gain, t, dur * 0.3, dur * 0.2, dur * 0.5, 0.6);
    lo.connect(lg).connect(s.out);
  }

  _ambMoan() {
    const s = this._shot({ bus: this._waterBus, pos: this._around(90, 140, 20), ref: 40, gain: 0.5, send: 1.2, echo: 0.2, ambient: true });
    if (!s) return;
    synthWhaleCall(s, s.out, s.t, { dur: rand(6, 9), f0: rand(32, 42), peak: rand(55, 75), end: rand(28, 36), amp: 0.7 });
  }

  _ambGlass() {
    const s = this._shot({ bus: this._musicBus, gain: 0.05, send: 0.8, echo: 0.35, pan: rand(-0.6, 0.6), ambient: true });
    if (!s) return;
    const t = s.t;
    const f = pick([880, 987.77, 1174.66, 1318.51]);
    for (const [ff, a] of [[f, 1], [f * 1.5, 0.35], [f * 2.01, 0.15]]) {
      const o = s.osc('sine', ff, t, t + 4);
      const g = s.gain(0);
      perc(g.gain, t, 0.015, 3, a);
      o.connect(g).connect(s.out);
    }
  }

  _ambBubbles() {
    const s = this._shot({ bus: this._bodyBus, gain: 0.25, pan: rand(-0.7, 0.7), ambient: true });
    if (!s) return;
    bubbleBurst(s, s.out, s.t, 2 + Math.floor(rand(0, 4)), 0.4, 300, 1000, 0.15);
  }

  _plunge() {
    const s = this._shot({ key: 'plunge', gap: 0.25, bus: this._bodyBus, gain: 0.5, send: 0.1, priority: true });
    if (!s) return;
    const t = s.t;
    const [lp, n] = nz(s, 'white', t, t + 1, 'lowpass', 5000, 1.5);
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.exponentialRampToValueAtTime(250, t + 0.45);
    const g = s.gain(0);
    perc(g.gain, t, 0.015, 0.7, 0.5);
    n.connect(g).connect(s.out);
    toneDrop(s, s.out, t, 90, 40, 0.3, 0.005, 0.4, 0.5);
    bubbleBurst(s, s.out, t + 0.05, 14, 0.9, 250, 900, 0.15);
  }

  _surfaceWhoosh() {
    const s = this._shot({ key: 'surface', gap: 0.25, bus: this._bodyBus, gain: 0.45, send: 0.2, priority: true });
    if (!s) return;
    const t = s.t;
    const [bp, n] = nz(s, 'white', t, t + 0.9, 'bandpass', 500, 0.8);
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.3);
    const g = s.gain(0);
    perc(g.gain, t, 0.03, 0.5, 0.6);
    n.connect(g).connect(s.out);
    toneDrop(s, s.out, t, 300, 120, 0.08, 0.003, 0.1, 0.25);
    dropletRain(s, s.out, t + 0.1, 8, 1.1, 1200, 3000, 0.06);
  }

  _lampToggle(pos, on) {
    const s = this._shot({ key: 'lamp', gap: 0.05, pos, ref: 1.2, rolloff: 1.6, gain: 0.35, send: 0.15 });
    if (!s) return;
    const t = s.t;
    hit(s, s.out, t, 'white', 'highpass', 2500, 0.7, 0.0005, 0.015, 0.8);
    const fz = s.noise('crackle', t, t + 0.4);
    const bp = s.filter('bandpass', 4000, 1);
    const g = s.gain(0);
    swell(g.gain, t, 0.01, on ? 0.2 : 0.05, 0.12, on ? 1.2 : 0.8);
    fz.connect(bp).connect(g).connect(s.out);
    if (on) {
      const o = s.osc('sine', 100, t + 0.02, t + 0.4);
      const og = s.gain(0);
      perc(og.gain, t + 0.02, 0.005, 0.25, 0.2);
      o.connect(og).connect(s.out);
    }
  }
}
