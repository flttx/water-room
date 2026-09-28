import * as THREE from 'three';
import { G, GLSL_COMMON, patchMaterial } from './render/shaderlib.js';
import { makeSignTexture, mulberry32 } from './render/textures.js';
import { DECK_TOP, DECK_BOTTOM } from './level/level.js';

// Everything bolted onto the tiled shell: lamp fixtures, valves, checkpoint lanterns, the pressure
// door and sluice gate, painted signs, ladders, lane ropes, railings and service pipes.
// Static pieces are merged per material and lit from the same light bake as the walls.

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = [1, 1, 1];
const RED = [1, 0.1, 0.06];
const AMBER = [1, 0.55, 0.12];
const GREEN = [0.2, 1, 0.38];
const CP_ON = [1, 0.82, 0.55];

const DOOR_H = 2.6;
const DOOR_TIME = 2.5;
const GATE_H = 5.8;
const GATE_TIME = 6.5;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _nm = new THREE.Matrix3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => t * t * (3 - 2 * t);

function mat(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
}

/** Local frame on a wall: +z points out of the wall along (nx, nz), +y up, +x along the wall. */
class Frame {
  constructor(x, y, z, nx, nz) {
    this.base = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(nx, nz)), new THREE.Vector3(1, 1, 1));
    this.nx = nx;
    this.nz = nz;
  }

  m(lx, ly, lz, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
    return this.base.clone().multiply(mat(lx, ly, lz, rx, ry, rz, sx, sy, sz));
  }

  p(lx, ly, lz) {
    return new THREE.Vector3(lx, ly, lz).applyMatrix4(this.base);
  }
}

/** Accumulates transformed primitives with vertex colours, then bakes light into them. */
class Batch {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.idx = [];
    this.grp = [];
    this.groups = [];
  }

  /**
   * col: [r,g,b] or fn(localPos, localNormal) -> [r,g,b]. flip turns the surface inside out.
   * bakeAt: [x,y,z] samples the light once for the whole piece (for many tiny parts).
   */
  add(geo, m, col, { flip = false, bakeAt = null } = {}) {
    const p = geo.attributes.position, n = geo.attributes.normal;
    _nm.getNormalMatrix(m);
    const base = this.pos.length / 3;
    const fn = typeof col === 'function';
    let grp = -1;
    if (bakeAt) {
      grp = this.groups.length;
      this.groups.push(bakeAt);
    }
    for (let i = 0; i < p.count; i++) {
      _a.fromBufferAttribute(p, i);
      _b.fromBufferAttribute(n, i);
      if (flip) _b.negate();
      const c = fn ? col(_a, _b) : col;
      _a.applyMatrix4(m);
      _b.applyMatrix3(_nm).normalize();
      this.pos.push(_a.x, _a.y, _a.z);
      this.nrm.push(_b.x, _b.y, _b.z);
      this.col.push(c[0], c[1], c[2]);
      this.grp.push(grp);
    }
    const count = geo.index ? geo.index.count : p.count;
    const P = this.pos, N = this.nrm;
    for (let i = 0; i < count; i += 3) {
      const i0 = base + (geo.index ? geo.index.getX(i) : i);
      let i1 = base + (geo.index ? geo.index.getX(i + 1) : i + 1);
      let i2 = base + (geo.index ? geo.index.getX(i + 2) : i + 2);
      // keep every triangle facing the same way as its vertex normals
      const ux = P[i1 * 3] - P[i0 * 3], uy = P[i1 * 3 + 1] - P[i0 * 3 + 1], uz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
      const vx = P[i2 * 3] - P[i0 * 3], vy = P[i2 * 3 + 1] - P[i0 * 3 + 1], vz = P[i2 * 3 + 2] - P[i0 * 3 + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const nx = N[i0 * 3] + N[i1 * 3] + N[i2 * 3];
      const ny = N[i0 * 3 + 1] + N[i1 * 3 + 1] + N[i2 * 3 + 1];
      const nz = N[i0 * 3 + 2] + N[i1 * 3 + 2] + N[i2 * 3 + 2];
      if (cx * nx + cy * ny + cz * nz < 0) [i1, i2] = [i2, i1];
      this.idx.push(i0, i1, i2);
    }
    return this;
  }

  get empty() { return this.idx.length === 0; }

  /** Geometry with baked irradiance; pivot re-centres it for parts that move. */
  build(baker, pivot = null, wrap = 0.5) {
    const n = this.pos.length / 3;
    const bake = new Float32Array(n * 3), cm = new Float32Array(n);
    const o = [0, 0, 0];
    const gb = this.groups.map(([x, y, z]) => {
      baker.sample(x, y, z, 0, 1, 0, o, 1);
      return [o[0], o[1], o[2]];
    });
    for (let i = 0; i < n; i++) {
      const py = this.pos[i * 3 + 1];
      const g = this.grp[i];
      if (g >= 0) {
        bake.set(gb[g], i * 3);
      } else {
        baker.sample(this.pos[i * 3], py, this.pos[i * 3 + 2], this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2], o, wrap);
        bake[i * 3] = o[0];
        bake[i * 3 + 1] = o[1];
        bake[i * 3 + 2] = o[2];
      }
      cm[i] = py < -0.05 ? 0.6 * Math.min(1, -py * 2.5) * Math.exp(py * 0.1) : 0;
    }
    const pos = new Float32Array(this.pos);
    if (pivot) {
      for (let i = 0; i < n; i++) {
        pos[i * 3] -= pivot.x;
        pos[i * 3 + 1] -= pivot.y;
        pos[i * 3 + 2] -= pivot.z;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('bake', new THREE.BufferAttribute(bake, 3));
    g.setAttribute('cmask', new THREE.BufferAttribute(cm, 1));
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const GRIME = /* glsl */ `
diffuseColor.rgb *= 0.72 + 0.42 * wr_fbm(vWPos * 2.3);
`;

// rust, drip streaks and a hazard band along the bottom edge (local origin at the bottom centre)
const PLATE_ALBEDO = /* glsl */ `
{
  vec3 q = vLocal;
  if (q.y < 0.42) {
    float s = step(0.5, fract((q.x + q.z + q.y) * 1.4));
    diffuseColor.rgb = mix(vec3(0.62, 0.46, 0.05), vec3(0.03), s);
  }
  float rust = smoothstep(0.4, 0.85, wr_fbm(q * vec3(1.4, 0.7, 1.4) + vec3(0.0, 4.0, 0.0)));
  float streak = smoothstep(0.55, 0.95, wr_noise(vec3((q.x + q.z) * 9.0, q.y * 0.35, 0.0)));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.19, 0.075, 0.03), clamp(rust * 0.85 + streak * 0.35, 0.0, 0.9));
  diffuseColor.rgb *= 0.8 + 0.3 * wr_noise(q * 6.0);
}
`;

function propMaterial(key, roughness, metalness) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness });
  return patchMaterial(m, { env: true, key, albedo: GRIME });
}

function plateMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.25 });
  return patchMaterial(m, {
    env: true,
    key: 'plate',
    vertDecl: 'varying vec3 vLocal;\n',
    vertBody: 'vLocal = position;\n',
    fragDecl: 'varying vec3 vLocal;\n',
    albedo: PLATE_ALBEDO,
  });
}

function signMaterial(map) {
  const m = new THREE.MeshStandardMaterial({
    map, transparent: true, depthWrite: false, alphaTest: 0.04, roughness: 0.85,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  return patchMaterial(m, { env: true, key: 'sign' });
}

/** Self-lit parts (bulbs, lenses, window panes); PATTERN 1 = arched window, 2 = sunlit grille. */
function glowMaterial(pattern) {
  return new THREE.ShaderMaterial({
    uniforms: { ...G },
    defines: { PATTERN: pattern },
    vertexShader: /* glsl */ `${GLSL_COMMON}
      attribute vec3 icol;
      attribute float glow;
      varying vec3 vCol;
      varying vec2 vUv;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vWNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vCol = icol * glow;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `${GLSL_COMMON}
      varying vec3 vCol;
      varying vec2 vUv;
      void main() {
        vec3 v = normalize(cameraPosition - vWPos);
        float facing = abs(dot(normalize(vWNrm), v));
        vec3 c = vCol * (0.55 + 0.45 * facing) + vec3(0.012, 0.013, 0.012);
        #if PATTERN == 1
          vec2 q = vec2((vUv.x - 0.5) * 2.4, vUv.y * 5.0);
          float ar = length(vec2(q.x, q.y - 3.8));
          if (q.y > 3.8 && ar > 1.2) discard;
          float bar = step(abs(q.x), 0.05) + step(abs(abs(q.x) - 0.6), 0.03);
          bar += step(abs(fract(q.y / 0.8 + 0.5) - 0.5) * 0.8, 0.03);
          bar += step(3.8, q.y) * step(1.12, ar);
          bar += step(q.y, 0.1);
          vec2 cell = floor(vec2(q.x / 0.6, q.y / 0.8));
          float h = wr_hash(vec3(cell, floor((vWPos.z + 3.0) / 6.0) + step(100.0, vWPos.x) * 17.0));
          float pane = h < 0.14 ? 0.04 : 0.55 + 0.45 * wr_noise(vec3(q * 3.0, 1.0));
          pane *= 0.65 + 0.35 * smoothstep(0.0, 5.0, q.y);
          c = mix(vCol * pane, vec3(0.006), clamp(bar, 0.0, 1.0));
        #elif PATTERN == 2
          vec2 q = vec2(vUv.x * 4.0, vUv.y * 5.0);
          float bar = step(abs(fract(q.x / 0.4) - 0.5) * 0.4, 0.028) + step(abs(fract(q.y / 1.25) - 0.5) * 1.25, 0.05);
          float haze = 0.7 + 0.3 * vUv.y + 0.08 * wr_noise(vec3(q * 2.0, uTime * 0.2));
          c = mix(vCol * haze, vec3(0.01), clamp(bar, 0.0, 1.0));
        #endif
        gl_FragColor = vec4(wr_medium(c, vWPos), 1.0);
      }
    `,
  });
}

/** Emissive sign face: a texture multiplied by a brightness driven from the lamp system. */
function litSignMaterial(map, color) {
  return new THREE.ShaderMaterial({
    uniforms: { ...G, map: { value: map }, uCol: { value: new THREE.Color(...color) }, uGlow: { value: 1 } },
    vertexShader: /* glsl */ `${GLSL_COMMON}
      varying vec2 vUv;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vWNrm = normalize(mat3(modelMatrix) * normal);
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `${GLSL_COMMON}
      uniform sampler2D map;
      uniform vec3 uCol;
      uniform float uGlow;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(map, vUv);
        vec3 c = mix(vec3(0.004, 0.012, 0.006), t.rgb * uCol * uGlow, t.a) + vec3(0.003);
        gl_FragColor = vec4(wr_medium(c, vWPos), 1.0);
      }
    `,
  });
}

/** Instanced self-lit meshes; items linked to a lamp follow its brightness each frame. */
class Glows {
  constructor(geo, max, pattern = 0) {
    this.max = max;
    this.n = 0;
    this.items = [];
    this.icol = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.glow = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.icol.setUsage(THREE.DynamicDrawUsage);
    this.glow.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('icol', this.icol);
    geo.setAttribute('glow', this.glow);
    this.mesh = new THREE.InstancedMesh(geo, glowMaterial(pattern), max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  add(m, col, lamp = -1, base = 1) {
    if (this.n >= this.max) return -1;
    const i = this.n++;
    this.mesh.setMatrixAt(i, m);
    this.icol.setXYZ(i, col[0], col[1], col[2]);
    this.glow.setX(i, lamp >= 0 ? 0 : base);
    this.items.push({ lamp, base });
    this.mesh.count = this.n;
    return i;
  }

  set(i, col, g) {
    if (i < 0) return;
    if (col) this.icol.setXYZ(i, col[0], col[1], col[2]);
    this.glow.setX(i, g);
  }

  update(k) {
    for (let i = 0; i < this.n; i++) {
      const it = this.items[i];
      if (it.lamp >= 0) this.glow.setX(i, (k[it.lamp] || 0) * it.base);
    }
    this.icol.needsUpdate = true;
    this.glow.needsUpdate = true;
  }
}

const SUB = {
  '泵房←': 'PUMP ROOM', '中央泳池': 'LIDO', '阶梯浴场': 'TERRACE BATHS', '东蓄水池': 'EAST CISTERN',
  '更衣室': 'CHANGING ROOMS', '救生站': 'LIFEGUARD', '排水渠': 'DRAIN', '淋浴廊': 'SHOWERS', '泵房 · 水下': 'PUMP ROOM ↓',
  '更衣室近道': '机房积水 · 保持安静', '救生站近道': '机房积水 · 保持安静',
};

export class Props {
  constructor({ scene, level, lamps, lampSys, baker }) {
    this.level = level;
    this.lamps = lamps;
    this.lampSys = lampSys;
    this.baker = baker;
    this.rand = mulberry32(9191);
    this.group = new THREE.Group();
    this.group.name = 'props';
    scene.add(this.group);

    this.metal = propMaterial('metal', 0.42, 0.2);
    this.matte = propMaterial('matte', 0.8, 0);
    this.plate = plateMaterial();
    this.bm = new Batch();
    this.bx = new Batch();

    this.geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 10, 1),
      cylLo: new THREE.CylinderGeometry(1, 1, 1, 7, 1),
      sph: new THREE.SphereGeometry(1, 12, 8),
      buoy: new THREE.TorusGeometry(0.32, 0.075, 8, 32),
      ring: new THREE.TorusGeometry(0.22, 0.035, 6, 24),
      rim: new THREE.TorusGeometry(0.44, 0.014, 5, 28),
      wheel: new THREE.TorusGeometry(0.3, 0.028, 6, 28),
    };
    this.glowSph = new Glows(new THREE.SphereGeometry(1, 14, 10), 320);
    this.glowDisk = new Glows(new THREE.CircleGeometry(1, 20), 80);
    this.glowBox = new Glows(new THREE.BoxGeometry(1, 1, 1), 40);
    this.glowWin = new Glows(new THREE.PlaneGeometry(2.4, 5), 8, 1);
    this.glowDay = new Glows(new THREE.PlaneGeometry(4, 5), 2, 2);
    for (const g of [this.glowSph, this.glowDisk, this.glowBox, this.glowWin, this.glowDay]) this.group.add(g.mesh);

    // bake the moving panels as if open so both of their faces see the rooms they face
    const opened = new Set(level.dynamicOpen);
    level.open('D');
    level.open('G');
    try {
      this._fixtures();
      this._valves();
      this._checkpoints();
      this._door();
      this._gate();
      this._signs();
      this._ladders();
      this._laneRopes();
      this._railings();
      this._catwalks();
      this._pipes();
      this._flush();
    } finally {
      level.dynamicOpen.clear();
      for (const c of opened) level.dynamicOpen.add(c);
    }
    for (const g of Object.values(this.geo)) g.dispose();
    this.reset();
  }

  _flush() {
    for (const [b, m] of [[this.bm, this.metal], [this.bx, this.matte]]) {
      if (b.empty) continue;
      const mesh = new THREE.Mesh(b.build(this.baker), m);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    this.bm = null;
    this.bx = null;
  }

  /** A wall frame at the face of the nearest solid tile around (tx, tz), or null. */
  _nearWall(tx, tz, maxD = 4) {
    const L = this.level;
    for (let d = 1; d <= maxD; d++) {
      for (const [dx, dz] of DIRS) {
        if (!L.solid(tx + dx * d, tz + dz * d)) continue;
        let ok = true;
        for (let k = 1; k < d; k++) if (L.solid(tx + dx * k, tz + dz * k)) ok = false;
        if (!ok) continue;
        const fx = tx + dx * (d - 1), fz = tz + dz * (d - 1);
        const [cx, cz] = L.worldCenter(fx, fz);
        return { tx: fx, tz: fz, x: cx + dx, z: cz + dz, nx: -dx, nz: -dz };
      }
    }
    return null;
  }

  _sign(tex, m, w, h, parent = null, pivot = null) {
    const plane = new THREE.PlaneGeometry(w, h, 3, 2);
    const geo = new Batch().add(plane, m, WHITE).build(this.baker, pivot);
    // Batch drops texture coordinates; with a single plane the vertex order is unchanged
    geo.setAttribute('uv', plane.getAttribute('uv').clone());
    plane.dispose();
    const mesh = new THREE.Mesh(geo, signMaterial(tex));
    mesh.renderOrder = 1;
    (parent || this.group).add(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------ lamp fixtures
  _fixtures() {
    const { geo, bm, bx } = this;
    const green = [0.05, 0.13, 0.1], enamel = [0.78, 0.76, 0.68], iron = [0.07, 0.07, 0.07];
    const shade = [[0.44, -0.16], [0.42, -0.1], [0.36, 0.03], [0.26, 0.15], [0.14, 0.24], [0.07, 0.3], [0.05, 0.36]];
    const outer = new THREE.LatheGeometry(shade.map(([r, y]) => new THREE.Vector2(r, y)), 16);
    const inner = new THREE.LatheGeometry(shade.map(([r, y]) => new THREE.Vector2(r - 0.014, y - 0.01)), 16);
    const cage = new THREE.CylinderGeometry(0.07, 0.13, 0.12, 12, 1, true);
    this.exitLamp = -1;

    this.lamps.forEach((l, i) => {
      if (l.type === 'hang') {
        bm.add(outer, mat(l.x, l.y, l.z), green);
        bx.add(inner, mat(l.x, l.y, l.z), enamel, { flip: true });
        bm.add(geo.rim, mat(l.x, l.y - 0.16, l.z, Math.PI / 2), green);
        if (l.ceil) {
          const len = l.ceil - l.y - 0.36;
          bm.add(geo.cyl, mat(l.x, l.y + 0.36 + len / 2, l.z, 0, 0, 0, 0.018, len, 0.018), iron);
          bm.add(geo.cyl, mat(l.x, l.ceil - 0.04, l.z, 0, 0, 0, 0.1, 0.08, 0.1), green);
        }
        this.glowSph.add(mat(l.x, l.y - 0.03, l.z, 0, 0, 0, 0.1), l.color, i, 7);
      } else if (l.type === 'wall') {
        const f = new Frame(l.x - l.nx * 0.18, l.y, l.z - l.nz * 0.18, l.nx, l.nz);
        bm.add(geo.box, f.m(0, 0, 0.015, 0, 0, 0, 0.2, 0.3, 0.03), green);
        bm.add(geo.box, f.m(0, -0.06, 0.1, 0, 0, 0, 0.035, 0.035, 0.16), iron);
        bm.add(cage, f.m(0, 0.075, 0.18), green);
        bx.add(cage, f.m(0, 0.075, 0.18), enamel, { flip: true });
        this.glowSph.add(f.m(0, 0, 0.18, 0, 0, 0, 0.065), l.color, i, 5);
      } else if (l.type === 'pool') {
        const f = new Frame(l.x - l.nx * 0.25, l.y, l.z - l.nz * 0.25, l.nx, l.nz);
        bm.add(geo.ring, f.m(0, 0, 0.03), [0.5, 0.52, 0.5]);
        this.glowDisk.add(f.m(0, 0, 0.035, 0, 0, 0, 0.2), l.color, i, 6);
      } else if (l.type === 'window') {
        const wx = l.side === 'w' ? l.x - 1.18 : l.x + 1.18;
        const f = new Frame(wx, l.y, l.z, l.nx, 0);
        this.glowWin.add(f.m(0, 0, 0.0), l.color, i, 2.4);
        bx.add(geo.box, f.m(0, -2.58, 0.08, 0, 0, 0, 2.7, 0.16, 0.18), [0.5, 0.5, 0.46]);
      } else if (l.type === 'exit') {
        this.exitLamp = i;
        const f = new Frame(l.x, l.y, 12, 0, 1);
        bm.add(geo.box, f.m(0, 0, 0.06, 0, 0, 0, 1.75, 0.62, 0.12), [0.05, 0.07, 0.06]);
        const tex = makeSignTexture('出口  EXIT', { w: 512, h: 160, size: 92, color: '#d8ffe0', clean: true });
        this.exitMat = litSignMaterial(tex, [0.35, 1, 0.5]);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), this.exitMat);
        sign.position.copy(f.p(0, 0, 0.125));
        this.group.add(sign);
      } else if (l.type === 'daylight') {
        const f = new Frame(l.x, 3.1, 2.02, 0, 1);
        this.glowDay.add(f.m(0, 0, 0), l.color, i, 4.5);
      }
    });
    for (const g of [outer, inner, cage]) g.dispose();
  }

  // ------------------------------------------------------------------ valves
  _valves() {
    const L = this.level, { geo, bm } = this;
    const pipeC = [0.16, 0.13, 0.1], bodyC = [0.1, 0.12, 0.11], redC = [0.5, 0.05, 0.035];
    const names = { pump: ['泵房阀门', 'PUMP VALVE'], bath: ['浴场阀门', 'BATH VALVE'], cistern: ['蓄水池阀门', 'CISTERN VALVE'], reservoir: ['水库阀门', 'RESERVOIR VALVE'] };
    this.valves = L.find('V').map(([tx, tz]) => {
      const [dx, dz] = L.wallDir(tx, tz);
      const [cx, cz] = L.worldCenter(tx, tz);
      const f0 = L.floor(tx, tz), c0 = L.ceil(tx, tz);
      const nx = -dx, nz = -dz;
      const fr = new Frame(cx + dx, f0, cz + dz, nx, nz);
      const kind = tx > 104 ? 'reservoir' : tz < 10 ? 'pump' : tx < 50 ? 'bath' : 'cistern';
      const h = 1.2;
      // riser from floor to ceiling, a stub into the valve body, the stem and bonnet
      const rise = c0 - f0;
      bm.add(geo.cyl, fr.m(-0.55, rise / 2, 0.17, 0, 0, 0, 0.09, rise, 0.09), pipeC);
      for (const y of [0.35, h, Math.min(rise - 0.3, 2.6)]) bm.add(geo.cyl, fr.m(-0.55, y, 0.17, 0, 0, 0, 0.13, 0.05, 0.13), pipeC);
      bm.add(geo.cyl, fr.m(-0.28, h, 0.17, 0, 0, Math.PI / 2, 0.075, 0.5, 0.075), pipeC);
      bm.add(geo.sph, fr.m(0, h, 0.17, 0, 0, 0, 0.19, 0.17, 0.17), bodyC);
      bm.add(geo.cyl, fr.m(0, h, 0.34, Math.PI / 2, 0, 0, 0.08, 0.16, 0.08), bodyC);
      bm.add(geo.cyl, fr.m(0, h, 0.44, Math.PI / 2, 0, 0, 0.022, 0.12, 0.022), [0.3, 0.3, 0.28]);
      bm.add(geo.cyl, fr.m(0.28, h, 0.17, 0, 0, Math.PI / 2, 0.075, 0.2, 0.075), pipeC);
      bm.add(geo.cyl, fr.m(0.38, h / 2, 0.17, 0, 0, 0, 0.075, h, 0.075), pipeC);
      bm.add(geo.box, fr.m(0.38, 0.03, 0.17, 0, 0, 0, 0.3, 0.06, 0.3), pipeC);
      // the wheel turns about the stem
      const pivot = fr.p(0, h, 0.5);
      const wb = new Batch();
      wb.add(geo.wheel, fr.m(0, h, 0.5), redC);
      for (let k = 0; k < 3; k++) wb.add(geo.box, fr.m(0, h, 0.5, 0, 0, (k * Math.PI) / 3, 0.58, 0.03, 0.022), redC);
      wb.add(geo.cyl, fr.m(0, h, 0.5, Math.PI / 2, 0, 0, 0.05, 0.07, 0.05), redC);
      wb.add(geo.cyl, fr.m(0.3, h, 0.58, Math.PI / 2, 0, 0, 0.016, 0.16, 0.016), [0.2, 0.2, 0.19]);
      const wheel = new THREE.Mesh(wb.build(this.baker, pivot), this.metal);
      wheel.position.copy(pivot);
      this.group.add(wheel);
      // status lamp and name plate
      bm.add(geo.box, fr.m(0.62, h + 0.75, 0.04, 0, 0, 0, 0.16, 0.16, 0.08), bodyC);
      const glow = this.glowSph.add(fr.m(0.62, h + 0.75, 0.1, 0, 0, 0, 0.05), RED, -1, 2);
      const lampPos = fr.p(0.62, h + 0.75, 0.4);
      const lamp = this.lampSys.add({ type: 'prop', x: lampPos.x, y: lampPos.y, z: lampPos.z, color: RED.slice(), intensity: 1.2, range: 4.5 });
      const [name, sub] = names[kind];
      const tex = makeSignTexture(name, { w: 512, h: 192, size: 78, bg: '#1d4a57', color: '#e8efe6', sub });
      this._sign(tex, fr.m(0, h + 0.75, 0.025), 0.84, 0.32);
      return {
        tx, tz, name, pump: kind === 'pump', kind, pos: pivot.clone(), nx, nz,
        progress: 0, done: false, turning: false, angle: 0, wheel, glow, lamp,
      };
    });
  }

  // ------------------------------------------------------------------ checkpoints
  _checkpoints() {
    const L = this.level, { geo, bm, bx } = this;
    const cps = [...L.find('S').map((t) => [...t, true]), ...L.find('C').map((t) => [...t, false])];
    this.checkpoints = cps.map(([tx, tz, start]) => {
      const [x, z] = L.worldCenter(tx, tz);
      // face the most open direction on respawn
      let best = 0, bd = [0, -1];
      for (const [dx, dz] of DIRS) {
        let n = 0;
        while (n < 8 && !L.solid(tx + dx * (n + 1), tz + dz * (n + 1))) n++;
        if (n > best) { best = n; bd = [dx, dz]; }
      }
      const yaw = Math.atan2(-bd[0], -bd[1]);
      const w = this._nearWall(tx, tz) || { tx, tz, x, z: z - 1, nx: 0, nz: 1 };
      const f0 = L.floor(w.tx, w.tz), c0 = L.ceil(w.tx, w.tz);
      const ly = Math.min(f0 + 2.0, c0 - 0.45);
      const fr = new Frame(w.x, ly, w.z, w.nx, w.nz);
      bm.add(geo.box, fr.m(0, 0, 0.09, 0, 0, 0, 0.34, 0.46, 0.18), [0.06, 0.12, 0.09]);
      bm.add(geo.box, fr.m(0, 0.26, 0.1, 0, 0, 0, 0.4, 0.05, 0.22), [0.06, 0.12, 0.09]);
      const glow = this.glowBox.add(fr.m(0, -0.02, 0.185, 0, 0, 0, 0.24, 0.32, 0.03), RED, -1, 0.5);
      // lifebuoy on a hook beside it
      const by = Math.min(f0 + 1.25, ly - 0.2);
      bx.add(geo.buoy, fr.m(0.62, by, 0.1), (p) => {
        const a = Math.atan2(p.y, p.x) + Math.PI;
        return Math.floor(a / (Math.PI / 4)) % 2 ? [0.72, 0.7, 0.64] : [0.6, 0.07, 0.04];
      });
      bm.add(geo.box, fr.m(0.62, by + 0.36, 0.05, 0, 0, 0, 0.05, 0.1, 0.1), [0.2, 0.2, 0.19]);
      const lp = fr.p(0, -0.1, 0.5);
      const lamp = this.lampSys.add({ type: 'prop', x: lp.x, y: -500, z: lp.z, color: CP_ON.slice(), intensity: 3, range: 7 });
      return { tx, tz, x, z, yaw, active: start, start, glow, lamp, ly: lp.y };
    });
  }

  // ------------------------------------------------------------------ pressure door & sluice gate
  _door() {
    const L = this.level, { geo, bm } = this;
    const [tx, tz] = L.find('D')[0];
    const [cx, cz] = L.worldCenter(tx, tz);
    const f0 = L.floor(tx, tz);
    const frameC = [0.42, 0.33, 0.06];
    for (const sx of [-1, 1]) bm.add(geo.box, mat(cx + sx * 0.93, f0 + DOOR_H / 2, cz, 0, 0, 0, 0.14, DOOR_H, 0.4), frameC);
    const pb = new Batch();
    const pivot = new THREE.Vector3(cx, f0, cz);
    const steel = [0.2, 0.23, 0.22];
    pb.add(geo.box, mat(cx, f0 + DOOR_H / 2, cz, 0, 0, 0, 1.74, DOOR_H, 0.12), steel);
    for (const y of [0.55, 1.35, 2.15]) {
      for (const s of [-1, 1]) pb.add(geo.box, mat(cx, f0 + y, cz + s * 0.075, 0, 0, 0, 1.6, 0.08, 0.05), steel);
    }
    for (const s of [-1, 1]) pb.add(geo.cyl, mat(cx, f0 + 1.9, cz + s * 0.1, Math.PI / 2, 0, 0, 0.18, 0.04, 0.18), [0.12, 0.14, 0.14]);
    this.doorMesh = new THREE.Mesh(pb.build(this.baker, pivot), this.plate);
    this.doorMesh.position.copy(pivot);
    this.doorBase = pivot.clone();
    this.group.add(this.doorMesh);
    // stencil on the approach side travels with the door
    const tex = makeSignTexture('加压门', { w: 512, h: 192, size: 104, color: 'rgba(220,200,120,0.9)', sub: '需启动泵房阀门' });
    this._sign(tex, mat(cx, f0 + 1.45, cz + 0.125), 1.3, 0.49, this.doorMesh, pivot);
    this.doorGlows = [-1, 1].map((s) => {
      bm.add(geo.box, mat(cx - 0.93, f0 + 2.3, cz + s * 0.2, 0, 0, 0, 0.12, 0.12, 0.04), [0.08, 0.08, 0.08]);
      return this.glowSph.add(mat(cx - 0.93, f0 + 2.3, cz + s * 0.23, 0, 0, 0, 0.045), RED, -1, 2);
    });
    this.doorLamp = this.lampSys.add({ type: 'prop', x: cx - 0.7, y: f0 + 2.3, z: cz + 0.6, color: RED.slice(), intensity: 0.8, range: 4 });
  }

  _gate() {
    const L = this.level, { geo, bm } = this;
    const tiles = L.find('G');
    const xs = tiles.map(([x]) => x);
    const tz = tiles[0][1];
    const x0 = Math.min(...xs) * 2, x1 = (Math.max(...xs) + 1) * 2;
    const cx = (x0 + x1) / 2, cz = tz * 2 + 1;
    const f0 = L.floor(tiles[0][0], tz), top = L.ceil(tiles[0][0], tz);
    // guide channels either side
    for (const gx of [x0, x1]) {
      bm.add(geo.box, mat(gx, (f0 + top) / 2, cz, 0, 0, 0, 0.34, top - f0, 0.6), [0.14, 0.13, 0.11]);
      for (let y = f0 + 0.6; y < top; y += 1.2) bm.add(geo.cyl, mat(gx, y, cz + 0.31, Math.PI / 2, 0, 0, 0.05, 0.04, 0.05), [0.2, 0.18, 0.15]);
    }
    const pb = new Batch();
    const pivot = new THREE.Vector3(cx, f0, cz);
    const steel = [0.17, 0.19, 0.18];
    const w = x1 - x0 - 0.1;
    pb.add(geo.box, mat(cx, f0 + GATE_H / 2, cz, 0, 0, 0, w, GATE_H, 0.24), steel);
    for (let y = 0.9; y < GATE_H; y += 0.95) {
      for (const s of [-1, 1]) pb.add(geo.box, mat(cx, f0 + y, cz + s * 0.15, 0, 0, 0, w - 0.2, 0.14, 0.08), steel);
    }
    for (const vx of [-1.5, 0, 1.5]) {
      for (const s of [-1, 1]) pb.add(geo.box, mat(cx + vx, f0 + GATE_H / 2, cz + s * 0.16, 0, 0, 0, 0.12, GATE_H - 0.3, 0.1), steel);
    }
    this.gateMesh = new THREE.Mesh(pb.build(this.baker, pivot), this.plate);
    this.gateMesh.position.copy(pivot);
    this.gateBase = pivot.clone();
    this.group.add(this.gateMesh);
    const face = tz * 2 + 2;
    this.gateGlows = [cx - 2, cx + 2].map((gx) => {
      bm.add(geo.box, mat(gx, top + 0.5, face + 0.05, 0, 0, 0, 0.3, 0.3, 0.1), [0.08, 0.08, 0.08]);
      return this.glowSph.add(mat(gx, top + 0.5, face + 0.12, 0, 0, 0, 0.09), RED, -1, 2.5);
    });
    this.gateLamp = this.lampSys.add({ type: 'prop', x: cx, y: top + 0.4, z: face + 0.8, color: RED.slice(), intensity: 1.4, range: 7 });
  }

  // ------------------------------------------------------------------ signs
  _signs() {
    const L = this.level;
    for (const [tx, tz, text] of L.signs) {
      const w = this._nearWall(tx, tz);
      if (!w) continue;
      const f0 = L.floor(w.tx, w.tz), c0 = L.ceil(w.tx, w.tz);
      const y = Math.min(L.isWater(w.tx, w.tz) ? 1.35 : f0 + 2.1, c0 - 0.5);
      const fr = new Frame(w.x, y, w.z, w.nx, w.nz);
      if (SUB[text]) {
        const tex = makeSignTexture(text, { w: 768, h: 256, size: 100, bg: '#1d4a57', color: '#e8efe6', sub: SUB[text] });
        this.bx.add(this.geo.box, fr.m(0, 0, 0.01, 0, 0, 0, 1.86, 0.66, 0.02), [0.1, 0.1, 0.1]);
        this._sign(tex, fr.m(0, 0, 0.022), 1.8, 0.6);
      } else {
        const tex = makeSignTexture(text, { w: 512, h: 256, size: 150, color: 'rgba(18,34,40,0.88)' });
        this._sign(tex, fr.m(0, 0, 0.012), 1.3, 0.65);
      }
    }
    const A = L.abyss;
    const gx = A.gateX * 2 + 1, face = A.z0 * 2;
    const big = makeSignTexture('深渊浴场', { w: 1024, h: 256, size: 200, color: 'rgba(16,34,40,0.8)' });
    this._sign(big, mat(gx, 15.5, face + 0.02), 10, 2.5);
    const hint = makeSignTexture('闸门', { w: 512, h: 192, size: 96, bg: '#b58a1c', color: '#1a1406', sub: '需开启三处阀门' });
    const [gTx] = L.find('G')[0];
    const hw = this._nearWall(gTx - 2, A.z0 - 1, 1);
    if (hw) this._sign(hint, new Frame(hw.x, L.floor(hw.tx, hw.tz) + 2.2, hw.z, hw.nx, hw.nz).m(0, 0, 0.02), 1.2, 0.45);
    const [sx, sz] = L.find('S')[0];
    const quiet = makeSignTexture('保持安静', { w: 768, h: 256, size: 150, color: 'rgba(120,22,16,0.85)' });
    const sw = this._nearWall(sx - 2, sz - 1, 2);
    if (sw) this._sign(quiet, new Frame(sw.x, L.floor(sw.tx, sw.tz) + 2.25, sw.z, sw.nx, sw.nz).m(0, 0, 0.02), 1.9, 0.63);
  }

  // ------------------------------------------------------------------ decor
  _ladders() {
    const L = this.level;
    const chrome = [0.62, 0.64, 0.64];
    const rail = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, -2.4, 0.2), new THREE.Vector3(0, 0.9, 0.2), new THREE.Vector3(0, 1.22, 0.12),
      new THREE.Vector3(0, 1.28, -0.08), new THREE.Vector3(0, 1.05, -0.3), new THREE.Vector3(0, 0.62, -0.32),
    ]), 28, 0.024, 6);
    const spots = [];
    const order = [];
    for (let z = 1; z < L.H - 1; z++) for (let x = 1; x < L.W - 1; x++) order.push([x, z]);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const [x, z] of order) {
      const c = L.ch(x, z);
      if ((c !== '.' && c !== ',') || Math.abs(L.floor(x, z) - 0.6) > 0.01 || L.isDark(x, z)) continue;
      for (const [dx, dz] of DIRS) {
        if (L.ch(x + dx, z + dz) !== '~' || L.ceil(x + dx, z + dz) < 3) continue;
        const [cx, cz] = L.worldCenter(x, z);
        const ex = cx + dx, ez = cz + dz;
        if (spots.some(([sx, sz]) => Math.hypot(sx - ex, sz - ez) < 14)) continue;
        spots.push([ex, ez]);
        const fr = new Frame(ex, 0, ez, dx, dz);
        for (const s of [-0.26, 0.26]) this.bm.add(rail, fr.m(s, 0, 0), chrome);
        for (const y of [0.25, -0.35, -0.95, -1.55]) this.bm.add(this.geo.cyl, fr.m(0, y, 0.2, 0, 0, Math.PI / 2, 0.02, 0.52, 0.02), chrome);
        break;
      }
      if (spots.length >= 40) break;
    }
    rail.dispose();
  }

  _laneRopes() {
    const L = this.level;
    const pool = { x0: 80, x1: 128 };
    const float = this.geo.cylLo;
    for (const r of [37, 39, 41, 47, 49]) {
      const z = r * 2;
      const len = pool.x1 - pool.x0;
      this.bx.add(this.geo.cyl, mat((pool.x0 + pool.x1) / 2, 0.02, z, 0, 0, Math.PI / 2, 0.012, len, 0.012), [0.5, 0.5, 0.48]);
      const n = Math.floor(len / 0.3);
      for (let i = 0; i <= n; i++) {
        const x = pool.x0 + 0.15 + i * 0.3;
        if (x > pool.x1 - 0.1) break;
        const d = Math.min(x - pool.x0, pool.x1 - x);
        const c = d < 5 ? [0.62, 0.07, 0.05] : i % 2 ? [0.75, 0.74, 0.7] : [0.06, 0.2, 0.55];
        this.bx.add(float, mat(x, 0.03, z, 0, 0, Math.PI / 2, 0.075, 0.22, 0.075), c, { bakeAt: [x, 0.1, z] });
      }
    }
  }

  _railings() {
    const L = this.level;
    const paint = [0.08, 0.2, 0.16];
    const skip = new Set(['50,43,-1', '50,44,-1']);
    for (let z = 0; z < L.H; z++) {
      for (let x = 0; x < L.W; x++) {
        if (L.solid(x, z)) continue;
        const f = L.floor(x, z);
        if (f < 3) continue;
        for (const [dx, dz] of DIRS) {
          const nx = x + dx, nz = z + dz;
          if (L.solid(nx, nz) || L.ch(nx, nz) === '^' || L.floor(nx, nz) > f - 1) continue;
          if (skip.has(`${x},${z},${dx}`)) continue;
          const [cx, cz] = L.worldCenter(x, z);
          const fr = new Frame(cx + dx * 0.92, f, cz + dz * 0.92, dx, dz);
          for (const s of [-0.5, 0.5]) this.bm.add(this.geo.cylLo, fr.m(s, 0.525, 0, 0, 0, 0, 0.022, 1.05, 0.022), paint);
          for (const y of [0.55, 1.05]) this.bm.add(this.geo.box, fr.m(0, y, 0, 0, 0, 0, 2.0, 0.04, 0.04), paint);
        }
      }
    }
    // diving board off the west side of the tower
    const bf = L.floor(50, 43);
    this.bx.add(this.geo.box, mat(98.6, bf + 0.1, 88, 0, 0, 0, 2.8, 0.08, 0.52), [0.62, 0.6, 0.52]);
    this.bm.add(this.geo.box, mat(100.35, bf + 0.05, 88, 0, 0, 0, 0.5, 0.1, 0.6), [0.12, 0.13, 0.12]);
  }

  /** Concrete catwalk slabs over the reservoir on rusted legs; the railings rotted away long ago. */
  _catwalks() {
    const L = this.level;
    const concrete = [0.3, 0.29, 0.26], rust = [0.2, 0.11, 0.07];
    const mid = (DECK_TOP + DECK_BOTTOM) / 2, th = DECK_TOP - DECK_BOTTOM;
    for (let z = 0; z < L.H; z++) {
      for (let x = 0; x < L.W; x++) {
        if (L.deckTop(x, z) === null) continue;
        const [cx, cz] = L.worldCenter(x, z);
        this.bx.add(this.geo.box, mat(cx, mid, cz, 0, 0, 0, 2.02, th, 2.02), concrete);
        const f = L.floor(x, z), leg = DECK_BOTTOM - f;
        for (const [dx, dz] of DIRS) {
          const nc = L.ch(x + dx, z + dz);
          if (nc === '=' || !L.isWater(x + dx, z + dz)) continue;
          const fr = new Frame(cx + dx * 0.96, DECK_TOP, cz + dz * 0.96, dx, dz);
          this.bm.add(this.geo.box, fr.m(0, -th / 2 - 0.02, 0, 0, 0, 0, 2.0, th + 0.1, 0.08), rust);
          // stumps of the old railing, a few still standing
          const k = (x * 7 + z * 13 + dx * 3 + dz * 5) % 5;
          if (k === 0) this.bm.add(this.geo.cylLo, fr.m(-0.5, 0.5, 0, 0.12, 0, 0.1, 0.022, 1.0, 0.022), rust);
          else if (k < 3) this.bm.add(this.geo.cylLo, fr.m(k === 1 ? 0.5 : -0.5, 0.12, 0, 0, 0, 0, 0.026, 0.24, 0.026), rust);
        }
        if ((x + z) % 2 === 0) this.bm.add(this.geo.cylLo, mat(cx, DECK_BOTTOM - leg / 2, cz, 0, 0, 0, 0.13, leg, 0.13), rust);
      }
    }
  }

  _pipes() {
    const L = this.level;
    const rust = [0.2, 0.11, 0.07], grey = [0.13, 0.14, 0.13];
    for (let z = 0; z < L.H; z++) {
      for (let x = 0; x < L.W; x++) {
        if (L.ch(x, z) !== ',') continue;
        const [cx, cz] = L.worldCenter(x, z);
        const c0 = L.ceil(x, z);
        for (const [dx, dz] of [[0, -1], [-1, 0]]) {
          if (L.ch(x + dx, z + dz) !== '#') continue;
          const fr = new Frame(cx + dx, c0, cz + dz, -dx, -dz);
          this.bm.add(this.geo.cylLo, fr.m(0, -0.3, 0.12, 0, 0, Math.PI / 2, 0.055, 2.0, 0.055), rust);
          this.bm.add(this.geo.cylLo, fr.m(0, -0.52, 0.09, 0, 0, Math.PI / 2, 0.035, 2.0, 0.035), grey);
          if ((x + z) % 2 === 0) this.bm.add(this.geo.box, fr.m(0, -0.4, 0.05, 0, 0, 0, 0.05, 0.36, 0.1), grey);
        }
      }
    }
  }

  // ------------------------------------------------------------------ state
  setValve(i, progress, turning) {
    const v = this.valves[i];
    if (!v) return;
    v.progress = clamp(progress, 0, 1);
    v.turning = !!turning && v.progress < 1;
    if (v.progress >= 1) v.done = true;
  }

  activateCheckpoint(i) {
    const c = this.checkpoints[i];
    if (c) c.active = true;
  }

  openDoor() { this.doorOpening = true; }
  openGate() { this.gateOpening = true; }
  get doorPassable() { return this.doorT > 0.6; }
  get gatePassable() { return this.gateT > 0.6; }

  reset() {
    for (const v of this.valves) {
      v.progress = 0;
      v.done = false;
      v.turning = false;
      v.angle = 0;
    }
    for (const c of this.checkpoints) c.active = c.start;
    this.doorT = 0;
    this.gateT = 0;
    this.doorOpening = false;
    this.gateOpening = false;
  }

  update(dt, t, k) {
    for (const g of [this.glowWin, this.glowDay, this.glowDisk]) g.update(k);

    for (const v of this.valves) {
      if (v.turning) v.angle += dt * 2.4;
      v.wheel.quaternion.setFromAxisAngle(_a.set(v.nx, 0, v.nz), -v.angle);
      let col = RED, g = 1.6 + 0.6 * Math.sin(t * 2.5);
      if (v.done) { col = GREEN; g = 2.2; }
      else if (v.turning) { col = AMBER; g = 2.4 + Math.sin(t * 14); }
      this.glowSph.set(v.glow, col, g);
      v.lamp.color[0] = col[0]; v.lamp.color[1] = col[1]; v.lamp.color[2] = col[2];
      v.lamp.intensity = 0.55 * g;
    }

    for (const c of this.checkpoints) {
      if (c.active) {
        this.glowBox.set(c.glow, CP_ON, 3.2 + 0.2 * Math.sin(t * 1.3 + c.tx));
        c.lamp.y = c.ly;
      } else {
        this.glowBox.set(c.glow, RED, 0.35 + 0.35 * Math.max(0, Math.sin(t * 2.2 + c.tx)));
        c.lamp.y = -500;
      }
    }
    this.glowBox.update(k);

    if (this.doorOpening && this.doorT < 1) this.doorT = Math.min(1, this.doorT + dt / DOOR_TIME);
    this.doorMesh.position.set(this.doorBase.x, this.doorBase.y + (DOOR_H + 0.1) * ease(this.doorT), this.doorBase.z);
    const dcol = this.doorT >= 1 ? GREEN : this.doorOpening ? AMBER : RED;
    for (const i of this.doorGlows) this.glowSph.set(i, dcol, this.doorOpening && this.doorT < 1 ? 2 + Math.sin(t * 12) : 2);
    this.doorLamp.color[0] = dcol[0]; this.doorLamp.color[1] = dcol[1]; this.doorLamp.color[2] = dcol[2];

    if (this.gateOpening && this.gateT < 1) this.gateT = Math.min(1, this.gateT + dt / GATE_TIME);
    const moving = this.gateOpening && this.gateT < 1;
    const jx = moving ? Math.sin(t * 41) * 0.015 : 0;
    this.gateMesh.position.set(this.gateBase.x + jx, this.gateBase.y + (GATE_H + 0.3) * ease(this.gateT), this.gateBase.z);
    const gcol = this.gateT >= 1 ? GREEN : moving ? AMBER : RED;
    for (const i of this.gateGlows) this.glowSph.set(i, gcol, moving ? 2.5 + 1.5 * Math.sin(t * 9) : 2.5);
    this.gateLamp.color[0] = gcol[0]; this.gateLamp.color[1] = gcol[1]; this.gateLamp.color[2] = gcol[2];
    this.glowSph.update(k);

    if (this.exitMat) this.exitMat.uniforms.uGlow.value = this.exitLamp >= 0 ? 2.2 * (k[this.exitLamp] || 0) + 0.1 : 1;
  }
}
