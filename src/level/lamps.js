import { mulberry32 } from '../render/textures.js';

export const SODIUM = [1.0, 0.52, 0.2];
export const WARM = [1.0, 0.64, 0.32];
export const POOL = [0.1, 0.55, 1.0];
export const MOON = [0.32, 0.46, 0.72];
export const EXIT_GREEN = [0.25, 1.0, 0.45];

/**
 * Deterministic lamp layout.
 * type: hang | wall | pool | window | exit | daylight
 * baked lamps contribute diffuse through vertex baking; the shader loop only adds specular/flicker.
 */
export function planLamps(level) {
  const rand = mulberry32(4242);
  const lamps = [];
  const order = [];
  for (let z = 0; z < level.H; z++) for (let x = 0; x < level.W; x++) order.push([x, z]);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const far = (x, y, z, types, minD) =>
    lamps.every((l) => !types.includes(l.type) || Math.hypot(l.x - x, (l.y - y) * 0.5, l.z - z) >= minD);
  const add = (o) => {
    const l = {
      baked: true, dead: false, flicker: 0, phase: rand() * 100, nx: 0, nz: 0,
      ...o,
    };
    lamps.push(l);
    return l;
  };
  const abyss = (x, z) => level.inHall(x, z) === 22;

  // hanging sodium lamps above the channels and decks
  for (const [x, z] of order) {
    const c = level.ch(x, z);
    if (c !== '~' && c !== '.' && c !== '-') continue;
    if (level.isDark(x, z) || abyss(x, z)) continue;
    const ceil = level.ceil(x, z);
    if (ceil < 5) continue;
    const [wx, wz] = level.worldCenter(x, z);
    const y = ceil <= 7 ? ceil - 1.15 : 6.2;
    if (y < Math.max(0, level.floor(x, z)) + 2.5) continue;
    if (!far(wx, y, wz, ['hang'], 13)) continue;
    const r = rand();
    add({ type: 'hang', x: wx, y, z: wz, ceil, color: SODIUM, intensity: 10, range: 17, dead: r < 0.14, flicker: r > 0.86 ? 1 : 0 });
  }

  // wall sconces: low corridors densely, channel decks sparsely
  for (const [x, z] of order) {
    const c = level.ch(x, z);
    const corridor = c === ',' || c === 'C' || c === 'S';
    if (!corridor && c !== '.' && c !== '^') continue;
    if (level.isDark(x, z) || abyss(x, z)) continue;
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dz]) => level.ch(x + dx, z + dz) === '#');
    if (!dirs.length) continue;
    const [dx, dz] = dirs[Math.floor(rand() * dirs.length)];
    const [cx, cz] = level.worldCenter(x, z);
    const wx = cx + dx * 0.82, wz = cz + dz * 0.82;
    const y = level.floor(x, z) + (corridor ? 1.75 : 2.0);
    if (!far(wx, y, wz, ['wall'], corridor ? 9 : 16)) continue;
    if (!corridor && !far(wx, y, wz, ['hang'], 8)) continue;
    const r = rand();
    add({ type: 'wall', x: wx, y, z: wz, nx: -dx, nz: -dz, color: WARM, intensity: corridor ? 5 : 6, range: corridor ? 11 : 13, dead: r < 0.1, flicker: r > 0.85 ? 1 : 0 });
  }

  // underwater pool lights on the channel walls
  for (const [x, z] of order) {
    if (level.ch(x, z) !== '~' || level.isDark(x, z)) continue;
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dz]) => {
      const n = level.ch(x + dx, z + dz);
      return n === '.' || n === '#' || n === ',';
    });
    if (!dirs.length) continue;
    const [dx, dz] = dirs[Math.floor(rand() * dirs.length)];
    const [cx, cz] = level.worldCenter(x, z);
    const wx = cx + dx * 0.75, wz = cz + dz * 0.75;
    if (!far(wx, -1.4, wz, ['pool'], 11)) continue;
    const r = rand();
    add({ type: 'pool', x: wx, y: -1.4, z: wz, nx: -dx, nz: -dz, color: POOL, intensity: 7, range: 13, dead: r < 0.12, flicker: r > 0.9 ? 1 : 0 });
  }

  // --- the Abyss hall is lit sparsely and deliberately (tile offsets relative to its corner)
  const A = level.abyss;
  const aw = (rx, rz) => level.worldCenter(A.x0 + rx, A.z0 + rz);
  for (const [rx, rz, dead, flicker] of [[3, 3, false, 0], [22, 3, false, 0], [3, 14, true, 0], [22, 14, false, 1]]) {
    const [wx, wz] = aw(rx, rz);
    add({ type: 'hang', x: wx, y: 11, z: wz, ceil: 22, color: SODIUM, intensity: 16, range: 26, dead, flicker });
  }
  {
    const [wx, wz] = aw(12, 8);
    add({ type: 'hang', x: wx + 1, y: 8, z: wz + 1, ceil: 22, color: SODIUM, intensity: 9, range: 15 });
  }
  // abyss wall lights, one ring near the surface and a dying ring deeper down
  for (const [rx, rz, dx, dz] of [[7, 1, 0, -1], [18, 1, 0, -1], [1, 10, -1, 0], [24, 6, 1, 0], [6, 16, 0, 1], [20, 16, 0, 1]]) {
    const [cx, cz] = aw(rx, rz);
    add({ type: 'pool', x: cx + dx * 0.75, y: -2.2, z: cz + dz * 0.75, nx: -dx, nz: -dz, color: POOL, intensity: 8, range: 15 });
  }
  for (const [rx, rz, dx, dz] of [[12, 1, 0, -1], [1, 13, -1, 0], [24, 12, 1, 0], [14, 16, 0, 1]]) {
    const [cx, cz] = aw(rx, rz);
    add({ type: 'pool', x: cx + dx * 0.75, y: -11, z: cz + dz * 0.75, nx: -dx, nz: -dz, color: POOL, intensity: 5, range: 12, flicker: 1 });
  }
  // high windows: cold light spilling into the hall
  for (const rz of [9, 12, 15]) {
    const wz = (A.z0 + rz) * 2;
    add({ type: 'window', x: A.x0 * 2 + 1.2, y: 15.5, z: wz, nx: 1, nz: 0, color: MOON, intensity: 7, range: 40, side: 'w' });
    add({ type: 'window', x: (A.x1 + 1) * 2 - 1.2, y: 15.5, z: wz, nx: -1, nz: 0, color: MOON, intensity: 7, range: 40, side: 'e' });
  }
  // --- the reservoir dome: a few lamps on long chains over the landings, dying lights on the basin walls
  for (const [tx, tz, dead, flicker, k] of [[109, 47, false, 1, 1], [149, 32, false, 0, 1], [149, 46, false, 1, 0.8], [110, 27, true, 0, 1], [131, 58, false, 0, 0.6]]) {
    const [wx, wz] = level.worldCenter(tx, tz);
    add({ type: 'hang', x: wx, y: 7.5, z: wz, ceil: 32, color: SODIUM, intensity: 11 * k, range: 20, dead, flicker });
  }
  for (const [tx, tz, dx, dz, y] of [[108, 36, -1, 0, -2], [151, 53, 1, 0, -2], [120, 26, 0, -1, -2], [140, 59, 0, 1, -2.5], [113, 40, -1, 0, -7], [146, 36, 1, 0, -8.5], [126, 56, 0, 1, -8]]) {
    const [cx, cz] = level.worldCenter(tx, tz);
    add({ type: 'pool', x: cx + dx * 0.75, y, z: cz + dz * 0.75, nx: -dx, nz: -dz, color: POOL, intensity: y < -5 ? 4 : 6, range: 13, flicker: y < -5 ? 1 : 0 });
  }

  // exit sign above the gate and daylight at the end of the exit corridor
  const gx = A.gateX * 2 + 1;
  add({ type: 'exit', x: gx, y: 7.4, z: 12.35, nx: 0, nz: 1, color: EXIT_GREEN, intensity: 4, range: 12 });
  add({ type: 'daylight', x: gx, y: 3.2, z: 2.6, nx: 0, nz: 1, color: [0.85, 0.95, 1.0], intensity: 14, range: 16 });
  return lamps;
}
