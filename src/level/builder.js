import * as THREE from 'three';
import { ABYSS_WALL_BOTTOM } from './level.js';
import { LightBaker } from './bake.js';
import { patchMaterial } from '../render/shaderlib.js';
import { makeTileTextures } from '../render/textures.js';

const CHUNK = 12;
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

class Buf {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.bake = []; this.cm = []; this.idx = [];
  }
}

/**
 * Builds the tiled shell of the level as chunked meshes with baked vertex lighting.
 * Doors and the gate are treated as open here; their panels are separate dynamic meshes.
 */
export function buildShell(level, lamps) {
  const baker = new LightBaker(level, lamps);
  const chunks = new Map();
  const tmpE = [0, 0, 0];
  const solidGeo = (x, z) => {
    const c = level.ch(x, z);
    return c === '#' || c === 'P';
  };
  const bottomOf = (x, z) => (level.ch(x, z) === 'O' ? ABYSS_WALL_BOTTOM : level.floor(x, z));
  const bufFor = (tx, tz) => {
    const key = `${Math.floor(tx / CHUNK)},${Math.floor(tz / CHUNK)}`;
    let b = chunks.get(key);
    if (!b) { b = new Buf(); chunks.set(key, b); }
    return b;
  };

  // caustic mask: strongest just under the surface, reflected ripples on low walls/ceilings above water
  const causticMask = (p, n, overWater) => {
    if (p[1] < -0.05) return Math.exp(p[1] * 0.1) * Math.min(1, -p[1] * 2.5);
    if (!overWater) return 0;
    if (n[1] < -0.5) return 0.55;
    return Math.max(0, 0.45 * (1 - p[1] / 3.5));
  };

  /** Emits a subdivided planar rectangle o + u*s + v*t, s in [0,ul], t in [0,vl]. */
  const face = (buf, o, u, v, ul, vl, n, uvMode, overWater, cell = 1) => {
    if (ul <= 1e-4 || vl <= 1e-4) return;
    const su = Math.max(1, Math.ceil(ul / cell - 1e-6)), sv = Math.max(1, Math.ceil(vl / cell - 1e-6));
    const base = buf.pos.length / 3;
    const p = [0, 0, 0];
    for (let j = 0; j <= sv; j++) {
      for (let i = 0; i <= su; i++) {
        const s = (ul * i) / su, t = (vl * j) / sv;
        p[0] = o[0] + u[0] * s + v[0] * t;
        p[1] = o[1] + u[1] * s + v[1] * t;
        p[2] = o[2] + u[2] * s + v[2] * t;
        buf.pos.push(p[0], p[1], p[2]);
        buf.nrm.push(n[0], n[1], n[2]);
        if (uvMode === 0) buf.uv.push(p[0] / 2, p[2] / 2);
        else if (uvMode === 1) buf.uv.push(p[2] / 2, p[1] / 2);
        else buf.uv.push(p[0] / 2, p[1] / 2);
        const through = baker.sample(p[0], p[1], p[2], n[0], n[1], n[2], tmpE);
        buf.bake.push(tmpE[0], tmpE[1], tmpE[2]);
        let cm = causticMask(p, n, overWater);
        if (p[1] < 0) cm *= Math.min(1, 0.25 + through * 0.05);
        buf.cm.push(cm);
      }
    }
    // winding so that the face points along n
    const cx = u[1] * v[2] - u[2] * v[1], cy = u[2] * v[0] - u[0] * v[2], cz = u[0] * v[1] - u[1] * v[0];
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    const row = su + 1;
    for (let j = 0; j < sv; j++) {
      for (let i = 0; i < su; i++) {
        const a = base + j * row + i, b = a + 1, c = a + row + 1, d = a + row;
        if (flip) buf.idx.push(a, c, b, a, d, c);
        else buf.idx.push(a, b, c, a, c, d);
      }
    }
  };

  for (let z = 0; z < level.H; z++) {
    for (let x = 0; x < level.W; x++) {
      if (solidGeo(x, z)) continue;
      const buf = bufFor(x, z);
      const c = level.ch(x, z);
      const f = level.floor(x, z), ce = level.ceil(x, z), bot = bottomOf(x, z);
      const water = level.isWater(x, z) && ce > 0;
      const x0 = x * 2, z0 = z * 2;
      if (c !== 'O') face(buf, [x0, f, z0], [1, 0, 0], [0, 0, 1], 2, 2, [0, 1, 0], 0, false);
      face(buf, [x0, ce, z0], [1, 0, 0], [0, 0, 1], 2, 2, [0, -1, 0], 0, water);

      for (const [dx, dz] of DIRS) {
        const nxT = x + dx, nzT = z + dz;
        const n = [-dx, 0, -dz];
        // face plane on the boundary between the two tiles
        let o, u, ul, uvMode;
        if (dx !== 0) {
          const px = dx > 0 ? (x + 1) * 2 : x * 2;
          o = [px, 0, z0]; u = [0, 0, 1]; ul = 2; uvMode = 1;
        } else {
          const pz = dz > 0 ? (z + 1) * 2 : z * 2;
          o = [x0, 0, pz]; u = [1, 0, 0]; ul = 2; uvMode = 2;
        }
        const spans = [];
        if (solidGeo(nxT, nzT)) {
          spans.push([bot, ce]);
        } else {
          const nf = bottomOf(nxT, nzT), nc = level.ceil(nxT, nzT);
          if (nf > bot) spans.push([bot, Math.min(nf, ce)]);
          if (nc < ce) spans.push([Math.max(nc, bot), ce]);
          // pool coping where dry deck meets water
          if (!level.isWater(x, z) && level.isWater(nxT, nzT) && nc > f) coping(buf, o, u, n, f, dx, dz);
        }
        for (const [y0, y1] of spans) {
          if (y1 - y0 < 1e-3) continue;
          face(buf, [o[0], y0, o[2]], u, [0, 1, 0], ul, y1 - y0, n, uvMode, water);
        }
      }
    }
  }

  // Lip overhanging the water: top, front and underside faces
  function coping(buf, o, u, n, f, dx, dz) {
    const out = [dx, 0, dz];
    const lipOut = 0.16, lipIn = 0.22, top = f + 0.07, low = f - 0.14;
    const at = (d, y) => [o[0] + out[0] * d, y, o[2] + out[2] * d];
    face(buf, at(-lipIn, top), u, out, 2, lipIn + lipOut, [0, 1, 0], 0, true, 2);
    face(buf, at(lipOut, low), u, [0, 1, 0], 2, top - low, [dx, 0, dz], dx !== 0 ? 1 : 2, true, 2);
    face(buf, at(0, low), u, out, 2, lipOut, [0, -1, 0], 0, true, 2);
    face(buf, at(-lipIn, f), u, [0, 1, 0], 2, top - f, n, dx !== 0 ? 1 : 2, false, 2);
  }

  const tex = makeTileTextures(1024);
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: tex.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
  });
  patchMaterial(mat, { env: true, tiles: true, key: 'shell' });

  const group = new THREE.Group();
  group.name = 'shell';
  let verts = 0, tris = 0;
  for (const b of chunks.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('bake', new THREE.Float32BufferAttribute(b.bake, 3));
    g.setAttribute('cmask', new THREE.Float32BufferAttribute(b.cm, 1));
    const vc = b.pos.length / 3;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = false;
    group.add(m);
    verts += vc;
    tris += b.idx.length / 3;
  }
  return { group, material: mat, baker, stats: { verts, tris, chunks: chunks.size } };
}

/** Water surface geometry in the XY plane (rotate -90deg about X), one quad per open-air water tile. */
export function buildWaterGeometry(level) {
  const pos = [], uv = [], idx = [];
  for (let z = 0; z < level.H; z++) {
    for (let x = 0; x < level.W; x++) {
      if (!level.isWater(x, z) || level.ceil(x, z) <= 0.05) continue;
      const b = pos.length / 3;
      const x0 = x * 2, x1 = x0 + 2, z0 = z * 2, z1 = z0 + 2;
      pos.push(x0, -z0, 0, x1, -z0, 0, x1, -z1, 0, x0, -z1, 0);
      uv.push(x0, z0, x1, z0, x1, z1, x0, z1);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
