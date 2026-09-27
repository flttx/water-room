import * as THREE from 'three';
import { G, GLSL_COMMON } from '../render/shaderlib.js';
import { makeNoise3 } from './flesh.js';
import { GlowPoints, ADD_MEDIUM } from './glow.js';
import { mulberry32 } from '../render/textures.js';
import { DRIFT_ROUTE } from '../level/mapdata.js';

// A siphonophore colony thirty metres long, drifting forever around the canal loop. It cannot see or
// hear; its curtains of stinging beads hang almost to the bottom and burn anything that brushes them.
// Bigger colonies circle the reservoir basin, and their curtains do not let go.

const BELLS = 26;
const SPACING = 1.25;
const STRANDS = 3;
const BEADS = 24;
const SPEED = 0.9;
const STING_R = 0.72;
const COL_A = [0.3, 0.85, 1.0];
const COL_B = [0.6, 0.32, 1.0];
const LAMP_COL = [0.42, 0.62, 1.0];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const bellSize = (i, n) => (i < 3 ? 0.55 : 0.75 + 0.35 * Math.sin((i / n) * Math.PI));

/** Closed centreline through the route tiles, resampled to even spacing and rounded at the corners. */
function buildLoop(level, route) {
  const pts = route.map(([x, z]) => level.worldCenter(x, z));
  let dense = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / 0.5));
    for (let k = 0; k < steps; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
  }
  for (let pass = 0; pass < 3; pass++) {
    const n = dense.length, w = 5;
    dense = dense.map((_, i) => {
      let sx = 0, sz = 0;
      for (let k = -w; k <= w; k++) {
        const q = dense[(i + k + n) % n];
        sx += q[0];
        sz += q[1];
      }
      return [sx / (2 * w + 1), sz / (2 * w + 1)];
    });
  }
  const n = dense.length;
  const x = new Float32Array(n + 1), z = new Float32Array(n + 1), s = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const q = dense[i % n];
    x[i] = q[0];
    z[i] = q[1];
    if (i > 0) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  }
  return { x, z, s, total: s[n] };
}

function bellGeometry() {
  const prof = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const a = u * Math.PI * 0.55;
    const r = Math.sin(a) * 0.5 * (1 + 0.12 * Math.sin(u * Math.PI));
    const y = Math.cos(a) * 0.82 - 0.1;
    prof.push(new THREE.Vector2(Math.max(0.002, r), y));
  }
  // the velum flares slightly inward at the opening
  prof.push(new THREE.Vector2(0.42, -0.14));
  const g = new THREE.LatheGeometry(prof, 28);
  g.computeVertexNormals();
  return g;
}

function bellMaterial(colA, colB) {
  return new THREE.ShaderMaterial({
    uniforms: { ...G, uColA: { value: new THREE.Color(...colA) }, uColB: { value: new THREE.Color(...colB) } },
    vertexShader: /* glsl */ `${GLSL_COMMON}
      attribute float bglow;
      varying float vGlow;
      varying vec3 vLocal;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vWNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vLocal = position;
        vGlow = bglow;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `${GLSL_COMMON}${ADD_MEDIUM}
      uniform vec3 uColA;
      uniform vec3 uColB;
      varying float vGlow;
      varying vec3 vLocal;
      void main() {
        vec3 v = normalize(cameraPosition - vWPos);
        float f = 1.0 - abs(dot(normalize(vWNrm), v));
        float rim = pow(f, 2.2);
        float ang = atan(vLocal.z, vLocal.x);
        float canal = pow(abs(cos(ang * 4.0)), 28.0) * smoothstep(-0.1, 0.4, vLocal.y);
        float margin = smoothstep(0.02, -0.12, vLocal.y);
        float n = wr_noise(vLocal * 7.0 + vec3(0.0, uTime * 0.4, 0.0));
        vec3 c = mix(uColB, uColA, rim) * (0.03 + rim * 0.55 + canal * 0.45 + margin * 0.6) * (0.35 + vGlow) * (0.7 + 0.6 * n);
        gl_FragColor = vec4(wr_addMedium(c * 0.6, vWPos), 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function strandMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...G, uCol: { value: new THREE.Color(0.1, 0.18, 0.34) } },
    vertexShader: /* glsl */ `${GLSL_COMMON}
      attribute float lf;
      varying float vF;
      void main() {
        vWPos = position;
        vWNrm = vec3(0.0, 1.0, 0.0);
        vF = lf;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `${GLSL_COMMON}${ADD_MEDIUM}
      uniform vec3 uCol;
      varying float vF;
      void main() {
        gl_FragColor = vec4(wr_addMedium(uCol * (1.0 - vF * 0.8), vWPos), 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

export class Drifter {
  /**
   * opt: the loop of route tiles, the colony's size (bells, scale), its drift speed and colours. A lethal colony
   * entangles what it stings, and a second sting while the venom still burns kills (onCatch).
   */
  constructor({ scene, level, lampSys, audio, water, fx }, opt = {}) {
    const { route = DRIFT_ROUTE, seed = 4242, bells = BELLS, scale = 1, speed = SPEED, colA = COL_A, colB = COL_B, lethal = false, source = 'drifter' } = opt;
    this.scene = scene;
    this.level = level;
    this.audio = audio;
    this.water = water;
    this.fx = fx;
    this.n = bells;
    this.scale = scale;
    this.spacing = SPACING * scale;
    this.speed = speed;
    this.colA = colA;
    this.colB = colB;
    this.lethal = lethal;
    this.source = source;
    this.onCatch = null;
    this.loop = buildLoop(level, route);
    this.noise = makeNoise3(77 + seed);
    this.events = [];
    const rand = mulberry32(seed);

    this.group = new THREE.Group();
    scene.add(this.group);
    this.bellGeo = bellGeometry();
    this.bellMat = bellMaterial(colA, colB);
    this.bells = new THREE.InstancedMesh(this.bellGeo, this.bellMat, this.n);
    this.bells.frustumCulled = false;
    this.bellGlow = new THREE.InstancedBufferAttribute(new Float32Array(this.n), 1);
    this.bellGlow.setUsage(THREE.DynamicDrawUsage);
    this.bellGeo.setAttribute('bglow', this.bellGlow);
    this.bells.renderOrder = 3;
    this.group.add(this.bells);

    // per strand: lateral offset, length, phase
    this.strands = [];
    for (let i = 0; i < this.n; i++) {
      const size = this.bellSize(i);
      for (let k = 0; k < STRANDS; k++) {
        this.strands.push({
          bell: i,
          side: ((k - 1) * 0.38 + (rand() - 0.5) * 0.15) * scale,
          along: (rand() - 0.5) * 0.5,
          len: (3.4 + rand() * 2) * size,
          ph: rand() * 100,
        });
      }
    }
    this.nBeads = this.strands.length * BEADS;
    this.beads = new Float32Array(this.nBeads * 3);
    this.glow = new GlowPoints(this.nBeads + this.n * 2, { core: 1.2, halo: 0.35, renderOrder: 3 });
    this.group.add(this.glow.points);

    const segs = this.strands.length * (BEADS - 1) + (this.n - 1);
    const lg = new THREE.BufferGeometry();
    this.linePos = new THREE.BufferAttribute(new Float32Array(segs * 2 * 3), 3);
    this.linePos.setUsage(THREE.DynamicDrawUsage);
    const lf = new Float32Array(segs * 2);
    let o = 0;
    for (let j = 0; j < this.strands.length; j++) {
      for (let b = 0; b < BEADS - 1; b++) {
        lf[o++] = b / (BEADS - 1);
        lf[o++] = (b + 1) / (BEADS - 1);
      }
    }
    lg.setAttribute('position', this.linePos);
    lg.setAttribute('lf', new THREE.BufferAttribute(lf, 1));
    this.lineMat = strandMaterial();
    this.lines = new THREE.LineSegments(lg, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.group.add(this.lines);

    this.bellPos = new Float32Array(this.n * 3);
    this.bellDir = new Float32Array(this.n * 2);
    this.flash = new Float32Array(this.n);
    this.lamp = lampSys.add({ type: 'creature', x: 0, y: -500, z: 0, color: LAMP_COL, intensity: 0, range: 10 });
    this.s0 = this._sAt(route[1]);
    this.reset(true);
  }

  _sAt([tx, tz]) {
    const [wx, wz] = this.level.worldCenter(tx, tz);
    const L = this.loop;
    let best = 0, bd = Infinity;
    for (let i = 0; i < L.x.length; i++) {
      const d = Math.hypot(L.x[i] - wx, L.z[i] - wz);
      if (d < bd) { bd = d; best = i; }
    }
    return L.s[best];
  }

  bellSize(i) { return bellSize(i, this.n) * this.scale; }

  /** full: back to the starting point (new game); otherwise keep drifting but calm down. */
  reset(full = false) {
    if (full) this.s = this.s0;
    this.flash.fill(0);
    this.stingCool = 3;
    this.tangle = 0;
    this.venom = 0;
    this.agitated = 0;
    this.threat = 0;
    this.events.length = 0;
  }

  _sample(s, out) {
    const L = this.loop;
    s = ((s % L.total) + L.total) % L.total;
    let lo = 0, hi = L.s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (L.s[mid] <= s) lo = mid; else hi = mid;
    }
    const u = (s - L.s[lo]) / Math.max(1e-5, L.s[hi] - L.s[lo]);
    out[0] = L.x[lo] + (L.x[hi] - L.x[lo]) * u;
    out[1] = L.z[lo] + (L.z[hi] - L.z[lo]) * u;
    const dx = L.x[hi] - L.x[lo], dz = L.z[hi] - L.z[lo];
    const d = Math.hypot(dx, dz) || 1;
    out[2] = dx / d;
    out[3] = dz / d;
    return out;
  }

  update(dt, t, { player, camera }) {
    this.events.length = 0;
    const L = this.level, nz = this.noise;
    this.agitated = Math.max(0, this.agitated - dt * 0.4);
    this.s += this.speed * dt * (1 - this.agitated * 0.6);
    this.stingCool -= dt;
    this.venom = Math.max(0, this.venom - dt);
    // tangled in the strands: every stroke only half gets through
    if (this.tangle > 0) {
      this.tangle -= dt;
      if (!player.frozen) player.vel.multiplyScalar(Math.max(0, 1 - dt * 4));
    }
    const cp = camera.position;
    const smp = [0, 0, 0, 0];
    let camD = Infinity;

    // bells: swim along the loop with a contraction wave running down the colony
    for (let i = 0; i < this.n; i++) {
      this._sample(this.s - i * this.spacing, smp);
      const q = i * 0.37;
      const lat = (nz(q, t * 0.12, 3.3) - 0.5) * 1.2 * this.scale;
      const x = smp[0] - smp[3] * lat, z = smp[1] + smp[2] * lat;
      const pulse = Math.sin(t * (2.2 + this.agitated * 5) - i * 0.55);
      const y = (-0.75 - (i < 3 ? 0 : 0.25)) * this.scale + pulse * 0.08 + (nz(q, t * 0.2, 9.1) - 0.5) * 0.3;
      this.bellPos[i * 3] = x;
      this.bellPos[i * 3 + 1] = y;
      this.bellPos[i * 3 + 2] = z;
      this.bellDir[i * 2] = smp[2];
      this.bellDir[i * 2 + 1] = smp[3];
      camD = Math.min(camD, Math.hypot(x - cp.x, z - cp.z));
      this.flash[i] = Math.max(0, this.flash[i] - dt * 1.2);
    }
    // alarm flashes travel along the colony
    const f2 = this.flash.slice();
    for (let i = 0; i < this.n; i++) {
      const nb = Math.max(i > 0 ? f2[i - 1] : 0, i < this.n - 1 ? f2[i + 1] : 0);
      this.flash[i] = Math.max(this.flash[i], nb * (1 - dt * 3) - dt * 0.6);
    }

    const near = camD < 75;
    this.group.visible = near;
    const p = player.pos;
    this.threat = 0;
    if (!near) {
      this.lamp.y = -500;
      this.lamp.intensity = 0;
      return;
    }

    let g = 0;
    for (let i = 0; i < this.n; i++) {
      const size = this.bellSize(i);
      const pulse = Math.sin(t * (2.2 + this.agitated * 5) - i * 0.55);
      const sq = 1 - pulse * 0.1;
      const x = this.bellPos[i * 3], y = this.bellPos[i * 3 + 1], z = this.bellPos[i * 3 + 2];
      const dx = this.bellDir[i * 2], dz = this.bellDir[i * 2 + 1];
      _e.set(0.35 + pulse * 0.05, Math.atan2(dx, dz), 0, 'YXZ');
      _q.setFromEuler(_e);
      _s.set(size * sq, size * (1 + pulse * 0.12), size * sq);
      _m.compose(_p.set(x, y, z), _q, _s);
      this.bells.setMatrixAt(i, _m);
      const fl = this.flash[i];
      const glow = 0.35 + 0.25 * (0.5 + 0.5 * pulse) + fl * 1.8;
      this.bellGlow.array[i] = glow;
      const k = 0.18 * glow;
      this.glow.set(g++, x, y + 0.15 * size, z, this.colA[0] * k, this.colA[1] * k, this.colA[2] * k, 0.45 * size);
      const h = 0.05 * glow;
      this.glow.set(g++, x, y, z, this.colB[0] * h, this.colB[1] * h, this.colB[2] * h, 3.2 * size);
    }
    this.bells.instanceMatrix.needsUpdate = true;
    this.bellGlow.needsUpdate = true;

    // stinging curtains trail behind and sway; beads glow brightest near the root
    const lp = this.linePos.array;
    let o = 0;
    let best = Infinity, bx = 0, by = 0, bz = 0;
    const checkSting = !player.frozen && this.stingCool <= 0;
    const bodyY = p.y - 0.85;
    for (let j = 0; j < this.strands.length; j++) {
      const st = this.strands[j];
      const i = st.bell;
      const x0 = this.bellPos[i * 3], y0 = this.bellPos[i * 3 + 1] - 0.1, z0 = this.bellPos[i * 3 + 2];
      const dx = this.bellDir[i * 2], dz = this.bellDir[i * 2 + 1];
      const rx = dz, rz = -dx;
      const fl = this.flash[i];
      const fy = L.floor(Math.floor(x0 / 2), Math.floor(z0 / 2)) + 0.35;
      const test = checkSting && Math.hypot(x0 - p.x, z0 - p.z) < 3 + st.len * 0.5;
      let px = 0, py = 0, pz = 0;
      for (let b = 0; b < BEADS; b++) {
        const u = b / (BEADS - 1);
        const d = 0.2 + u * st.len;
        const sway = 0.12 + 0.45 * u;
        const w1 = (nz(st.ph, t * 0.25, u * 1.5) - 0.5) * 2 * sway;
        const w2 = (nz(st.ph + 7, t * 0.25, u * 1.5) - 0.5) * 2 * sway;
        const trail = -d * (0.22 + this.agitated * 0.3);
        const x = x0 + rx * (st.side * (1 + u * 0.8) + w1) + dx * (trail + st.along);
        const z = z0 + rz * (st.side * (1 + u * 0.8) + w1) + dz * (trail + st.along);
        const y = Math.max(fy, y0 - d * 0.95 + w2 * 0.3);
        const bi = (j * BEADS + b) * 3;
        this.beads[bi] = x;
        this.beads[bi + 1] = y;
        this.beads[bi + 2] = z;
        const tw = 0.6 + 0.4 * Math.sin(t * 3 + st.ph + b * 1.3);
        const k = (0.22 * (1 - u * 0.55) * tw + fl * 0.9) * (b % 3 === 0 ? 1.4 : 0.7);
        const c = b % 2 ? this.colA : this.colB;
        this.glow.set(g++, x, y, z, c[0] * k, c[1] * k, c[2] * k, b % 3 === 0 ? 0.16 : 0.1);
        if (b > 0) {
          lp[o++] = px; lp[o++] = py; lp[o++] = pz;
          lp[o++] = x; lp[o++] = y; lp[o++] = z;
        }
        px = x; py = y; pz = z;
        if (test) {
          const d1 = Math.hypot(x - p.x, y - p.y, z - p.z);
          const d2 = p.y < 0.3 ? Math.hypot(x - p.x, (y - bodyY) * 0.8, z - p.z) : Infinity;
          const dd = Math.min(d1, d2);
          if (dd < best) { best = dd; bx = x; by = y; bz = z; }
        }
      }
    }
    // the stem joining the bells
    for (let i = 0; i < this.n - 1; i++) {
      for (const k of [i, i + 1]) {
        lp[o++] = this.bellPos[k * 3];
        lp[o++] = this.bellPos[k * 3 + 1] + 0.3;
        lp[o++] = this.bellPos[k * 3 + 2];
      }
    }
    this.linePos.needsUpdate = true;
    this.glow.upload(g);

    // light from the part of the colony nearest the player
    let ni = 0, nd = Infinity;
    for (let i = 0; i < this.n; i += 2) {
      const d = Math.hypot(this.bellPos[i * 3] - cp.x, this.bellPos[i * 3 + 2] - cp.z);
      if (d < nd) { nd = d; ni = i; }
    }
    const fl = Math.max(...this.flash);
    this.lamp.x = this.bellPos[ni * 3];
    this.lamp.y = this.bellPos[ni * 3 + 1];
    this.lamp.z = this.bellPos[ni * 3 + 2];
    this.lamp.intensity = 0.9 + fl * 2.5;
    this.threat = clamp(1 - (nd - 2) / 9, 0, 1) * 0.45;

    if (best < STING_R) this._sting(player, bx, by, bz);
  }

  _sting(player, x, y, z) {
    const p = player.pos;
    this.stingCool = 1.4;
    this.agitated = 1;
    // find the bell this bead hangs from and start an alarm flash there
    let bi = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = Math.hypot(this.bellPos[i * 3] - x, this.bellPos[i * 3 + 2] - z);
      if (d < bd) { bd = d; bi = i; }
    }
    this.flash[bi] = 1;
    if (player.underwater) player.breath = Math.max(0, player.breath - 8);
    let kx = p.x - x, kz = p.z - z;
    const kl = Math.hypot(kx, kz) || 1;
    kx /= kl; kz /= kl;
    player.vel.x += kx * 3.2;
    player.vel.z += kz * 3.2;
    if (player.underwater) player.vel.y += p.y > y ? 1.2 : -1.2;
    player.shake = Math.max(player.shake, 0.55);
    this.audio.sting({ x, y, z });
    if (y < -0.1) this.fx.bubbles.spawn(x, y, z, 10, 0.4, 0.8);
    this.water.addRipple(p.x, p.z, 0.8);
    if (this.lethal) {
      // the second sting while the first still burns: the curtain closes and hauls the swimmer up into the bells
      if (this.venom > 0) {
        this.events.push({ type: 'catch', source: this.source });
        if (this.onCatch) this.onCatch({ source: this.source, maw: new THREE.Vector3(this.bellPos[bi * 3], this.bellPos[bi * 3 + 1], this.bellPos[bi * 3 + 2]), grab: p.clone() });
        return;
      }
      this.venom = 6;
      this.tangle = 1.8;
      this.stingCool = 2.2;
    }
    this.events.push({ type: 'sting', source: this.source, x, y, z, tangle: this.lethal });
  }

  dispose() {
    this.group.removeFromParent();
    this.bellGeo.dispose();
    this.bellMat.dispose();
    this.lines.geometry.dispose();
    this.lineMat.dispose();
    this.glow.dispose();
    this.lamp.y = -500;
    this.lamp.intensity = 0;
  }
}
