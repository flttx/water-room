import { MAP, W, H } from '../src/level/mapdata.js';
import { Level } from '../src/level/level.js';

// Prints the map and checks that every key tile is reachable on foot / by swimming from the start,
// respecting step heights: dry→dry up to 0.6 m up, water→dry only onto ledges ≤ 1.2 m, dry→water always.
console.log('    ' + Array.from({ length: W }, (_, x) => x % 10).join(''));
MAP.forEach((r, z) => console.log(String(z).padStart(3) + ' ' + r));

const L = new Level();
const solid = (c, open) => c === '#' || c === 'P' || ((c === 'G' || c === 'D') && !open);
function bfs(open) {
  const [s] = L.find('S');
  const seen = new Set([s.join()]);
  const q = [s];
  while (q.length) {
    const [x, z] = q.shift();
    const w0 = L.isWater(x, z), f0 = L.floor(x, z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, c = L.ch(nx, nz);
      if (solid(c, open)) continue;
      const w1 = L.isWater(nx, nz), f1 = L.floor(nx, nz);
      if (!w1 && !w0 && f1 - f0 > 0.61) continue;
      if (!w1 && w0 && f1 > 1.2) continue;
      if (!w1 && L.ceil(nx, nz) - f1 < 1.3) continue;
      const k = nx + ',' + nz;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([nx, nz]);
    }
  }
  return seen;
}
const r1 = bfs(false), r2 = bfs(true);
for (const ch of ['V', 'C', 'X', 'E', 'D', 'G']) {
  console.log(ch, L.find(ch).map((p) => p.join(',') + (r1.has(p.join()) ? ' ok' : r2.has(p.join()) ? ' open-only' : ' UNREACH')).join(' | '));
}
const lost = [];
for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (!solid(L.ch(x, z), true) && !r2.has(x + ',' + z)) lost.push(`${x},${z}${L.ch(x, z)}`);
console.log('unreachable (doors open):', lost.length, lost.slice(0, 60).join(' '));
console.log('core tiles', L.coreList.length, 'abyss core', L.abyssCore.length);
