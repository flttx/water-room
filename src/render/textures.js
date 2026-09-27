import * as THREE from 'three';

// Deterministic PRNG so every run builds identical textures
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Tileable value noise sampler of period p (in cells). */
function periodicNoise(rand, p) {
  const v = new Float32Array(p * p);
  for (let i = 0; i < v.length; i++) v[i] = rand();
  const s = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = s(x - xi), yf = s(y - yi);
    const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
    const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
    const a = v[y0 * p + x0], b = v[y0 * p + x1], c = v[y1 * p + x0], d = v[y1 * p + x1];
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

function heightToNormal(height, size, strength) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const u = height[((y - 1 + size) % size) * size + x];
      const b = height[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - b) * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function toTexture(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Small square ceramic tiles, 16x16 per texture repeat (one repeat = 2 m).
 * Returns albedo (neutral, tinted in shader), normal and roughness maps.
 */
export function makeTileTextures(size = 1024) {
  const rand = mulberry32(1337);
  const n = 16;
  const cell = size / n;
  const grout = Math.max(2, Math.round(cell * 0.07));
  const noise = periodicNoise(rand, 32);
  const noise2 = periodicNoise(mulberry32(99), 8);

  const alb = canvas(size, size);
  const actx = alb.getContext('2d');
  const aimg = actx.createImageData(size, size);
  const rough = canvas(size, size);
  const rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(size, size);
  const height = new Float32Array(size * size);

  const tileTone = [];
  for (let i = 0; i < n * n; i++) {
    const r = rand();
    // a few tiles darker / stained / chipped
    tileTone.push({
      v: 0.9 + rand() * 0.1 - (r < 0.06 ? 0.25 : 0) - (r > 0.97 ? 0.4 : 0),
      tint: rand() * 0.06,
      chip: rand() < 0.035,
      chipX: rand(), chipY: rand(),
      tilt: (rand() - 0.5) * 0.4,
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tx = Math.floor(x / cell), ty = Math.floor(y / cell);
      const lx = x - tx * cell, ly = y - ty * cell;
      const edge = Math.min(lx, ly, cell - 1 - lx, cell - 1 - ly);
      const tone = tileTone[ty * n + tx];
      const inGrout = edge < grout;
      const nn = noise((x / size) * 32, (y / size) * 32);
      const nn2 = noise2((x / size) * 8, (y / size) * 8);
      let v, h, r;
      if (inGrout) {
        v = 0.42 + nn * 0.12;
        h = 0.0;
        r = 0.85;
      } else {
        // bevelled tile edge
        const bev = Math.min(1, (edge - grout) / (cell * 0.12));
        v = tone.v * (0.93 + nn * 0.07) - (1 - bev) * 0.06;
        h = 0.55 + bev * 0.45 + tone.tilt * (lx / cell - 0.5) * 0.2;
        r = 0.3 + nn * 0.12 + (1 - tone.v) * 0.4;
        if (tone.chip) {
          const cx = tone.chipX * cell, cy = tone.chipY * cell;
          const dd = Math.hypot(lx - cx, ly - cy) / cell;
          if (dd < 0.28 + nn * 0.1) {
            v = 0.5 + nn * 0.15;
            h = 0.2;
            r = 0.9;
          }
        }
      }
      // large scale grime
      v *= 0.88 + nn2 * 0.12;
      const c = Math.max(0, Math.min(1, v));
      const p = i * 4;
      aimg.data[p] = c * 255 * (1 - tone.tint);
      aimg.data[p + 1] = c * 255;
      aimg.data[p + 2] = c * 255 * (1 - tone.tint * 0.3);
      aimg.data[p + 3] = 255;
      rimg.data[p] = rimg.data[p + 1] = rimg.data[p + 2] = Math.min(1, r) * 255;
      rimg.data[p + 3] = 255;
      height[i] = h;
    }
  }
  actx.putImageData(aimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  const norm = heightToNormal(height, size, 3.2);
  return {
    map: toTexture(alb, true),
    normalMap: toTexture(norm, false),
    roughnessMap: toTexture(rough, false),
  };
}

/** Tileable water ripple normal map. */
export function makeWaterNormal(size = 512) {
  const rand = mulberry32(7);
  const n1 = periodicNoise(rand, 8);
  const n2 = periodicNoise(rand, 16);
  const n3 = periodicNoise(rand, 32);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      h[y * size + x] = n1(u * 8, v * 8) * 0.55 + n2(u * 16, v * 16) * 0.3 + n3(u * 32, v * 32) * 0.15;
    }
  }
  return toTexture(heightToNormal(h, size, 6), false);
}

export function makeGlowTexture(size = 128, falloff = 2.2) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
      const a = Math.max(0, 1 - d);
      const v = Math.pow(a, falloff);
      const p = (y * size + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
      img.data[p + 3] = v * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Painted stencil lettering on a transparent background. */
export function makeSignTexture(text, opts = {}) {
  const w = opts.w || 512, h = opts.h || 256;
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = opts.color || 'rgba(20,40,48,0.85)';
  const fs = opts.size || 150;
  ctx.font = `700 ${fs}px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (opts.glow) {
    ctx.shadowColor = opts.glow;
    ctx.shadowBlur = 30;
  }
  ctx.fillText(text, w / 2, h / 2 + 6);
  if (opts.sub) {
    ctx.font = `600 ${fs * 0.34}px "Microsoft YaHei", sans-serif`;
    ctx.fillText(opts.sub, w / 2, h * 0.84);
  }
  // weathering: erase random specks so the paint looks chipped
  if (!opts.clean) {
    const rand = mulberry32(text.length * 31 + fs);
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 260; i++) {
      ctx.globalAlpha = 0.3 + rand() * 0.7;
      ctx.beginPath();
      ctx.arc(rand() * w, rand() * h, 1 + rand() * 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
