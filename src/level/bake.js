const INV_PI = 1 / Math.PI;
const CELL = 8;

/** Per-vertex irradiance from the static lamp set, with grid occlusion and water attenuation. */
export class LightBaker {
  constructor(level, lamps) {
    this.level = level;
    this.lamps = lamps.filter((l) => l.baked && !l.dead);
    this.gw = Math.ceil((level.W * level.tile) / CELL);
    this.gh = Math.ceil((level.H * level.tile) / CELL);
    this.buckets = Array.from({ length: this.gw * this.gh }, () => []);
    this.lamps.forEach((l, i) => {
      const x0 = Math.max(0, Math.floor((l.x - l.range) / CELL)), x1 = Math.min(this.gw - 1, Math.floor((l.x + l.range) / CELL));
      const z0 = Math.max(0, Math.floor((l.z - l.range) / CELL)), z1 = Math.min(this.gh - 1, Math.floor((l.z + l.range) / CELL));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.buckets[z * this.gw + x].push(i);
    });
  }

  /**
   * Writes irradiance (already divided by PI) into out[0..2]. wrap softens N.L to fake bounce light.
   * Returns the fraction of light that reached the point through the water surface (caustic hint).
   */
  sample(px, py, pz, nx, ny, nz, out, wrap = 0.3) {
    out[0] = 0.0035; out[1] = 0.0045; out[2] = 0.0055;
    if (py < 0) { out[1] += 0.003; out[2] += 0.006; }
    const bx = Math.floor(px / CELL), bz = Math.floor(pz / CELL);
    if (bx < 0 || bz < 0 || bx >= this.gw || bz >= this.gh) return 0;
    const list = this.buckets[bz * this.gw + bx];
    const ox = px + nx * 0.12, oy = py + ny * 0.12, oz = pz + nz * 0.12;
    let through = 0;
    for (let k = 0; k < list.length; k++) {
      const l = this.lamps[list[k]];
      let dx = l.x - px, dy = l.y - py, dz = l.z - pz;
      const d = Math.hypot(dx, dy, dz);
      if (d > l.range || d < 1e-3) continue;
      dx /= d; dy /= d; dz /= d;
      const ndl = nx * dx + ny * dy + nz * dz;
      const lit = Math.max(0, (ndl + wrap) / (1 + wrap)) + 0.06;
      if (lit <= 0.061 && ndl < -0.5) continue;
      // wall-mounted lamps only emit into their half space
      if ((l.nx || l.nz) && (-dx * l.nx - dz * l.nz) < -0.05) continue;
      if (!this.level.segmentClear(ox, oy, oz, l.x, l.y, l.z, 0.4)) continue;
      const win = Math.max(0, 1 - Math.pow(d / l.range, 4));
      let att = (win * win) / (d * d * 0.09 + 1);
      // pendant shades throw light downward
      if (l.type === 'hang') att *= 0.3 + 0.7 * Math.max(0, dy < 0 ? 0 : dy);
      if (l.y > 0 && py < 0) {
        const wl = d * (-py) / Math.max(l.y - py, 1e-3);
        att *= Math.exp(-0.2 * wl);
        through += att * l.intensity;
      } else if (l.y < 0 && py >= 0) {
        att *= 0.25;
      } else if (l.y < 0 && py < 0) {
        att *= Math.exp(-0.05 * d);
      }
      const e = l.intensity * att * lit * INV_PI;
      out[0] += l.color[0] * e;
      out[1] += l.color[1] * e;
      out[2] += l.color[2] * e;
    }
    return through;
  }

  /** Scalar light level per tile at body height, used by creature vision. */
  buildLightGrid() {
    const { level } = this;
    const grid = new Float32Array(level.W * level.H);
    const o = [0, 0, 0];
    for (let z = 0; z < level.H; z++) {
      for (let x = 0; x < level.W; x++) {
        if (level.solid(x, z)) continue;
        const [wx, wz] = level.worldCenter(x, z);
        const y = level.isWater(x, z) ? 0.4 : level.floor(x, z) + 1.1;
        this.sample(wx, Math.min(y, level.ceil(x, z) - 0.2), wz, 0, 1, 0, o, 1.0);
        grid[z * level.W + x] = o[0] * 0.3 + o[1] * 0.55 + o[2] * 0.15;
      }
    }
    return grid;
  }
}
