import * as THREE from 'three';
import { G, GLSL_COMMON } from './shaderlib.js';
import { mulberry32 } from './textures.js';

// Shared flashlight description for the particle shaders
export const FL = {
  uFlPos: G.uFlPos,
  uFlDir: G.uFlDir,
  uFlOn: G.uFlOn,
  uPx: { value: 800 },
};

const PARTICLE_LIGHT = /* glsl */ `
uniform float uPx;
vec3 wr_pointLight(vec3 p) {
  vec3 e = uAmbient * 3.0;
  for (int i = 0; i < LAMP_N; i++) {
    vec4 lp = uLampPos[i];
    if (lp.w <= 0.0) continue;
    float d = length(lp.xyz - p);
    if (d > lp.w) continue;
    float win = clamp(1.0 - pow(d / lp.w, 4.0), 0.0, 1.0);
    float att = win * win / (d * d * 0.09 + 1.0);
    if ((lp.y > 0.0) != (p.y > 0.0)) att *= 0.25;
    e += uLampCol[i].rgb * att;
  }
  vec3 fd = p - uFlPos;
  float fdl = length(fd);
  float cosA = dot(fd / max(fdl, 1e-3), uFlDir);
  e += vec3(1.0, 0.93, 0.8) * uFlOn * smoothstep(0.86, 0.95, cosA) * 3.0 / (1.0 + fdl * fdl * 0.05);
  return e;
}
`;

export function pointsMaterial({ vertex, fragment, uniforms = {}, blending = THREE.AdditiveBlending }) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...G, ...FL, ...uniforms },
    vertexShader: `${GLSL_COMMON}${PARTICLE_LIGHT}${vertex}`,
    fragmentShader: `${GLSL_COMMON}${fragment}`,
    transparent: true,
    depthWrite: false,
    blending,
  });
  return mat;
}

/** Marine snow in the water and dust motes in the air, wrapped around the camera. */
function makeSnow(count, box, under) {
  const rand = mulberry32(under ? 11 : 12);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
  const mat = pointsMaterial({
    uniforms: { uBox: { value: box }, uUnderSet: { value: under ? 1 : 0 }, uCam: { value: new THREE.Vector3() } },
    vertex: /* glsl */ `
      uniform float uBox;
      uniform float uUnderSet;
      uniform vec3 uCam;
      attribute vec3 seed;
      varying vec3 vCol;
      varying float vA;
      void main() {
        vec3 p = seed * uBox;
        float t = uTime;
        p += vec3(sin(t * 0.13 + seed.y * 40.0) * 0.5, -t * (uUnderSet > 0.5 ? 0.04 : 0.015) * (0.4 + seed.x), cos(t * 0.11 + seed.z * 31.0) * 0.5);
        p = mod(p - uCam + uBox * 0.5, uBox) + uCam - uBox * 0.5;
        vWPos = p;
        vWNrm = vec3(0.0, 1.0, 0.0);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 0.05);
        float s = uUnderSet > 0.5 ? (0.035 + seed.x * 0.05) : (0.02 + seed.z * 0.02);
        gl_PointSize = clamp(s * uPx / d, 1.0, 14.0);
        bool wrongSide = uUnderSet > 0.5 ? p.y > -0.05 : p.y < 0.05;
        vA = wrongSide ? 0.0 : smoothstep(uBox * 0.5, uBox * 0.2, length(p - uCam)) * (0.35 + seed.y * 0.65);
        vCol = wr_pointLight(p) * (uUnderSet > 0.5 ? vec3(0.8, 0.95, 1.0) : vec3(1.0, 0.9, 0.75));
      }
    `,
    fragment: /* glsl */ `
      varying vec3 vCol;
      varying float vA;
      void main() {
        if (vA <= 0.001) discard;
        vec2 c = gl_PointCoord - 0.5;
        float r = dot(c, c);
        if (r > 0.25) discard;
        float a = smoothstep(0.25, 0.0, r) * vA;
        vec3 col = wr_medium(vCol * a * 0.55, vWPos);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = under ? 1 : 3;
  return pts;
}

/** Soft glow sprites around every lit lamp. */
function makeHalos(lamps, under) {
  const list = lamps.filter((l) => !l.dead && (under ? l.y < 0 : l.y >= 0));
  const pos = new Float32Array(list.length * 3);
  const col = new Float32Array(list.length * 3);
  const size = new Float32Array(list.length);
  const idx = new Float32Array(list.length);
  list.forEach((l, i) => {
    pos.set([l.x + l.nx * 0.12, l.y, l.z + l.nz * 0.12], i * 3);
    col.set(l.color, i * 3);
    const s = { hang: 2.4, wall: 1.6, pool: 2.6, window: 9, exit: 2.2, daylight: 7 }[l.type] || 2;
    size[i] = s;
    idx[i] = lamps.indexOf(l);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  g.setAttribute('lampIndex', new THREE.BufferAttribute(idx, 1));
  const inten = new Float32Array(Math.max(1, lamps.length)).fill(1);
  const tex = new THREE.DataTexture(inten, inten.length, 1, THREE.RedFormat, THREE.FloatType);
  tex.needsUpdate = true;
  const mat = pointsMaterial({
    uniforms: { tInten: { value: tex }, uCount: { value: inten.length } },
    vertex: /* glsl */ `
      attribute vec3 color;
      attribute float size;
      attribute float lampIndex;
      uniform sampler2D tInten;
      uniform float uCount;
      varying vec3 vCol;
      void main() {
        vWPos = position;
        vWNrm = vec3(0.0, 1.0, 0.0);
        float k = texture2D(tInten, vec2((lampIndex + 0.5) / uCount, 0.5)).r;
        vec4 mv = viewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 0.1);
        gl_PointSize = clamp(size * uPx / d, 0.0, 900.0);
        vCol = color * k;
      }
    `,
    fragment: /* glsl */ `
      varying vec3 vCol;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        if (r > 1.0) discard;
        float a = exp(-r * r * 6.0) * 0.55 + exp(-r * r * 60.0) * 0.8;
        gl_FragColor = vec4(wr_medium(vCol * a * 0.5, vWPos), 1.0);
      }
    `,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = under ? 1 : 3;
  pts.userData.intensity = inten;
  pts.userData.tex = tex;
  return pts;
}

const CONE_VERT = /* glsl */ `
  varying vec2 vUv2;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv2 = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWPos = wp.xyz;
    vWNrm = normalize(mat3(modelMatrix) * normal);
    vN = vWNrm;
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const CONE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uI;
  varying vec2 vUv2;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float edge = pow(facing, 2.0);
    float along = vUv2.y; // 1 at the source, 0 at the far end
    float fall = pow(along, 1.6);
    float n = wr_noise(vec3(vWPos.x * 0.6, vWPos.y * 0.25 - uTime * 0.12, vWPos.z * 0.6));
    float a = edge * fall * uI * (0.6 + 0.8 * n);
    vec3 col = wr_medium(uColor * a, vWPos);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function makeConeMaterial(color, intensity) {
  return new THREE.ShaderMaterial({
    uniforms: { ...G, uColor: { value: new THREE.Color(...color) }, uI: { value: intensity } },
    vertexShader: `${GLSL_COMMON}${CONE_VERT}`,
    fragmentShader: `${GLSL_COMMON}${CONE_FRAG}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Cone geometry with its apex at the origin, opening along -Y. uv.y = 1 at the apex. */
export function coneGeometry(r0, r1, len, seg = 24) {
  const g = new THREE.CylinderGeometry(r0, r1, len, seg, 6, true);
  g.translate(0, -len / 2, 0);
  return g;
}

function makeShafts(level, lamps) {
  const group = new THREE.Group();
  for (const l of lamps) {
    if (l.dead) continue;
    if (l.type === 'hang') {
      const floorY = Math.max(0, level.floor(Math.floor(l.x / 2), Math.floor(l.z / 2)));
      const len = l.y - floorY;
      if (len < 1.5) continue;
      const m = new THREE.Mesh(coneGeometry(0.22, len * 0.55 + 0.6, len), makeConeMaterial(l.color, l.y > 9 ? 0.05 : 0.07));
      m.position.set(l.x, l.y - 0.25, l.z);
      m.renderOrder = 3;
      m.userData.lamp = l;
      group.add(m);
    } else if (l.type === 'window') {
      // long slanted moon shafts from the high windows toward the abyss
      const len = 34;
      const m = new THREE.Mesh(coneGeometry(1.4, 3.6, len, 18), makeConeMaterial(l.color, 0.05));
      m.position.set(l.x - l.nx * 1.0, l.y + 1.2, l.z);
      const dir = new THREE.Vector3(l.nx, -0.62, 0.12 * (l.side === 'w' ? 1 : -1)).normalize();
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      m.renderOrder = 3;
      m.userData.lamp = l;
      group.add(m);
    }
  }
  return group;
}

/** CPU-driven bubbles and falling drips. */
class Bubbles {
  constructor(max = 320) {
    this.max = max;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);
    this.n = 0;
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('bsize', this.sizeAttr);
    g.setDrawRange(0, 0);
    const mat = pointsMaterial({
      vertex: /* glsl */ `
        attribute float bsize;
        varying vec3 vCol;
        void main() {
          vWPos = position;
          vWNrm = vec3(0.0, 1.0, 0.0);
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(bsize * uPx / max(-mv.z, 0.05), 1.0, 40.0);
          vCol = wr_pointLight(position) + vec3(0.02, 0.05, 0.06);
        }
      `,
      fragment: /* glsl */ `
        varying vec3 vCol;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c) * 2.0;
          if (r > 1.0) discard;
          float ring = smoothstep(0.6, 0.95, r) * smoothstep(1.0, 0.9, r);
          float hi = smoothstep(0.35, 0.0, length(c + vec2(0.16, 0.16)));
          vec3 col = vCol * (ring * 0.7 + hi * 0.9);
          gl_FragColor = vec4(wr_medium(col, vWPos), 1.0);
        }
      `,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
  }

  spawn(x, y, z, count, spread = 0.15, sizeMul = 1) {
    for (let k = 0; k < count; k++) {
      if (y >= -0.05) return;
      let i = this.n;
      if (i >= this.max) i = Math.floor(Math.random() * this.max);
      else this.n++;
      this.p[i * 3] = x + (Math.random() - 0.5) * spread;
      this.p[i * 3 + 1] = y + (Math.random() - 0.5) * spread;
      this.p[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      this.v[i * 3] = (Math.random() - 0.5) * 0.3;
      this.v[i * 3 + 1] = 0.5 + Math.random() * 0.6;
      this.v[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
      this.life[i] = 4 + Math.random() * 6;
      this.size[i] = (0.015 + Math.random() * 0.04) * sizeMul;
    }
  }

  update(dt, t, onSurface) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      const b = i * 3;
      this.v[b + 1] = Math.min(this.v[b + 1] + dt * 0.6, 1.4 + this.size[i] * 10);
      this.p[b] += (this.v[b] + Math.sin(t * 6 + i) * 0.12) * dt;
      this.p[b + 1] += this.v[b + 1] * dt;
      this.p[b + 2] += (this.v[b + 2] + Math.cos(t * 5 + i * 1.3) * 0.12) * dt;
      if (this.p[b + 1] >= -0.04) {
        if (onSurface && this.size[i] > 0.035) onSurface(this.p[b], this.p[b + 2]);
        continue;
      }
      if (this.life[i] <= 0) continue;
      if (w !== i) {
        this.p[w * 3] = this.p[b]; this.p[w * 3 + 1] = this.p[b + 1]; this.p[w * 3 + 2] = this.p[b + 2];
        this.v[w * 3] = this.v[b]; this.v[w * 3 + 1] = this.v[b + 1]; this.v[w * 3 + 2] = this.v[b + 2];
        this.life[w] = this.life[i]; this.size[w] = this.size[i];
      }
      w++;
    }
    this.n = w;
    this.posAttr.array.set(this.p.subarray(0, w * 3));
    this.sizeAttr.array.set(this.size.subarray(0, w));
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.points.geometry.setDrawRange(0, w);
  }
}

class Drips {
  constructor(level, max = 40) {
    this.level = level;
    this.max = max;
    this.items = [];
    this.timer = 0;
    const g = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.attr);
    g.setDrawRange(0, 0);
    const mat = pointsMaterial({
      vertex: /* glsl */ `
        varying vec3 vCol;
        void main() {
          vWPos = position;
          vWNrm = vec3(0.0, 1.0, 0.0);
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(0.05 * uPx / max(-mv.z, 0.05), 1.0, 8.0);
          vCol = wr_pointLight(position) * 0.9 + 0.02;
        }
      `,
      fragment: /* glsl */ `
        varying vec3 vCol;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          if (abs(c.x) > 0.18) discard;
          gl_FragColor = vec4(wr_medium(vCol * (1.0 - abs(c.x) * 5.0), vWPos), 1.0);
        }
      `,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  update(dt, cam, onImpact) {
    this.timer -= dt;
    if (this.timer <= 0 && this.items.length < this.max) {
      this.timer = 0.15 + Math.random() * 0.5;
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 16;
      const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
      const tx = Math.floor(x / 2), tz = Math.floor(z / 2);
      if (!this.level.solid(tx, tz)) {
        const ceil = this.level.ceil(tx, tz);
        if (ceil > 0.5 && ceil < 30) this.items.push({ x, y: ceil - 0.05, z, vy: 0, floor: Math.max(0, this.level.floor(tx, tz)), water: this.level.isWater(tx, tz) });
      }
    }
    let w = 0;
    const arr = this.attr.array;
    for (let i = 0; i < this.items.length; i++) {
      const d = this.items[i];
      d.vy -= 9.8 * dt;
      d.y += d.vy * dt;
      if (d.y <= d.floor) {
        if (onImpact) onImpact(d);
        continue;
      }
      this.items[w] = d;
      arr[w * 3] = d.x; arr[w * 3 + 1] = d.y; arr[w * 3 + 2] = d.z;
      w++;
    }
    this.items.length = w;
    this.attr.needsUpdate = true;
    this.points.geometry.setDrawRange(0, w);
  }
}

export class FX {
  constructor(level, lamps, scene) {
    this.lamps = lamps;
    this.snowUnder = makeSnow(2600, 26, true);
    this.dustAir = makeSnow(900, 22, false);
    this.halosUnder = makeHalos(lamps, true);
    this.halosAir = makeHalos(lamps, false);
    this.shafts = makeShafts(level, lamps);
    this.bubbles = new Bubbles();
    this.drips = new Drips(level);
    for (const o of [this.snowUnder, this.dustAir, this.halosUnder, this.halosAir, this.shafts, this.bubbles.points, this.drips.points]) scene.add(o);
  }

  /** k[i]: current brightness multiplier of lamp i (flicker / dead). */
  setLampIntensities(k) {
    for (const h of [this.halosUnder, this.halosAir]) {
      h.userData.intensity.set(k.subarray(0, h.userData.intensity.length));
      h.userData.tex.needsUpdate = true;
    }
    for (const m of this.shafts.children) {
      const i = this.lamps.indexOf(m.userData.lamp);
      m.visible = k[i] > 0.05;
    }
  }

  update(dt, t, camPos, cb) {
    this.snowUnder.material.uniforms.uCam.value.copy(camPos);
    this.dustAir.material.uniforms.uCam.value.copy(camPos);
    this.bubbles.update(dt, t, cb.onBubbleSurface);
    this.drips.update(dt, camPos, cb.onDrip);
  }
}
