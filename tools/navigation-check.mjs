import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Level, DECK_BOTTOM } from '../src/level/level.js';
import { Navigation } from '../src/navigation.js';
import { Player } from '../src/player.js';

let checks = 0;
function check(name, run) {
  run();
  checks++;
  process.stdout.write(`PASS ${name}\n`);
}

function playerAt(level, tx, tz, mode = 'ground', y) {
  return { pos: { x: (tx + 0.5) * level.tile, y: y ?? (mode === 'ground'
    ? (level.deckTop(tx, tz) ?? level.floor(tx, tz)) + 1.62 : 0.26), z: (tz + 0.5) * level.tile },
  eyeH: 1.62, mode, breath: 30, breathMax: 30 };
}

function valvesFor(level) {
  return level.find('V').map(([tx, tz]) => ({ tx, tz, name: `阀门 ${tx},${tz}`, done: false }));
}

function only(valves, tx, tz) {
  return valves.map((v) => ({ ...v, done: v.tx !== tx || v.tz !== tz }));
}

function tileOf(level, point) {
  return [Math.floor(point.x / level.tile), Math.floor(point.z / level.tile)];
}

function standingConnectionClear(level, from, to) {
  const player = new Player(level, new THREE.PerspectiveCamera());
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.01);
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0;
    const x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
    player.pos.set(x, from.y, z);
    player._collide(from.y - 1.62 + 0.6, from.y + 0.12);
    if (Math.hypot(player.pos.x - x, player.pos.z - z) > 0.00001) return false;
  }
  return true;
}

// Independent path checks use the player controller's collision dimensions, not Navigation helpers.
function validatePath(level, path) {
  assert.ok(path.length > 0);
  for (let i = 0; i < path.length; i++) {
    const point = path[i], [tx, tz] = tileOf(level, point);
    assert.ok(!level.solid(tx, tz), `solid route tile ${tx},${tz}`);
    assert.ok(Number.isFinite(point.y));
    const swim = point.mode === 'surface' || point.mode === 'under';
    if (swim) {
      assert.ok(level.isWater(tx, tz));
      assert.ok(point.y - 0.45 >= level.floor(tx, tz) - 0.001);
      assert.ok(point.y + 0.3 <= level.ceil(tx, tz) + 0.001);
      if (level.deckTop(tx, tz) !== null) assert.ok(point.y + 0.3 < DECK_BOTTOM);
    } else {
      const floor = level.deckTop(tx, tz) ?? level.floor(tx, tz);
      assert.ok(level.ceil(tx, tz) - floor >= 1.3);
      assert.ok(point.y > floor);
    }
    if (!i) continue;
    const prev = path[i - 1], [px, pz] = tileOf(level, prev);
    const horizontal = Math.abs(tx - px) + Math.abs(tz - pz);
    assert.ok(horizontal <= 1, 'route skips a corner or tile');
    const prevSwim = prev.mode === 'surface' || prev.mode === 'under';
    if (!horizontal) {
      assert.ok(swim && prevSwim, 'cannot change catwalk layer within the same tile');
      continue;
    }
    if (swim && prevSwim) {
      assert.ok(Math.abs(point.y - prev.y) < 0.001, 'dive or surface inside the tile, before crossing a low ceiling');
    } else if (prevSwim) {
      assert.equal(level.deckTop(px, pz), null, 'cannot climb up through the catwalk');
      assert.ok(prev.y >= 0.25, 'must surface before climbing');
      assert.ok((level.deckTop(tx, tz) ?? level.floor(tx, tz)) <= 1.201);
      assert.equal(point.mode, 'climb');
    } else if (!swim) {
      const from = level.deckTop(px, pz) ?? level.floor(px, pz);
      const to = level.deckTop(tx, tz) ?? level.floor(tx, tz);
      assert.ok(to - from <= 0.601, 'cannot step onto a high gallery without its stairs');
    } else {
      assert.equal(level.deckTop(tx, tz), null, 'cannot fall through a catwalk');
      assert.ok(level.ceil(tx, tz) >= prev.y + 0.12);
    }
  }
}

const level = new Level();
const valves = valvesFor(level);
const spawn = playerAt(level, 51, 81);
const routes = new Map();

check('all four valves are reachable from spawn with both doors closed', () => {
  assert.equal(valves.length, 4);
  for (const valve of valves) {
    const route = new Navigation(level).update(spawn, only(valves, valve.tx, valve.tz));
    assert.equal(route.status, 'route');
    assert.equal(route.target.tx, valve.tx);
    assert.equal(route.target.tz, valve.tz);
    validatePath(level, route.path);
    assert.ok(route.path.every((p) => !['G', 'D'].includes(level.ch(...tileOf(level, p)))));
    routes.set(`${valve.tx},${valve.tz}`, route);
  }
});

check('the nearest reachable valve is selected by route length', () => {
  const route = new Navigation(level).update(spawn, valves);
  const shortest = [...routes.values()].sort((a, b) => a.distance - b.distance)[0];
  assert.equal(route.target.name, shortest.target.name);
});

check('the bath gallery is reached through all four stair heights', () => {
  const path = routes.get('11,34').path;
  for (let z = 54; z >= 51; z--) assert.ok(path.some((p) => {
    const [tx, tz] = tileOf(level, p);
    return tx === 13 && tz === z;
  }), `missing bath stair ${z}`);
  assert.ok(path.at(-1).y > 4.9);
});

check('the pump route dives before low ceilings and surfaces in both air pockets', () => {
  const path = routes.get('9,1').path;
  assert.ok(path.some((p) => level.ch(...tileOf(level, p)) === 'u' && p.mode === 'under'));
  for (const [z0, z1] of [[26, 27], [15, 16]]) {
    assert.ok(path.some((p) => {
      const [tx, tz] = tileOf(level, p);
      return level.ch(tx, tz) === 'a' && tz >= z0 && tz <= z1 && p.mode === 'surface';
    }), `missing breathing pocket ${z0}`);
  }
});

check('oxygen recovers at an air pocket before the next dive', () => {
  const nav = new Navigation(level);
  const player = playerAt(level, 2, 15, 'surface');
  player.breath = 4;
  const active = only(valves, 9, 1);
  assert.equal(nav.update(player, active).waypoint.mode, 'surface');
  assert.equal(nav.result.action, 'breathe');
  player.breath = 30;
  const route = nav.update(player, active);
  assert.equal(route.action, null);
  assert.equal(route.waypoint.mode, 'under');
  assert.equal(route.waypoint.x, player.pos.x);
  assert.equal(route.waypoint.z, player.pos.z);
  assert.ok(route.waypoint.y < -1.5);
});

check('all valves lead to the south side of a closed gate, then the open exit', () => {
  const nav = new Navigation(level), completed = valves.map((v) => ({ ...v, done: true }));
  const closed = nav.update(spawn, completed);
  assert.equal(closed.target.kind, 'gate');
  assert.equal(closed.target.tz, 6);
  assert.ok(closed.path.every((p) => level.ch(...tileOf(level, p)) !== 'G'));
  const atGate = playerAt(level, closed.target.tx, closed.target.tz);
  assert.equal(nav.update(atGate, completed).status, 'waiting');
  level.open('D');
  assert.equal(nav.update(atGate, completed).target.kind, 'gate');
  level.open('G');
  const open = nav.update(atGate, completed);
  assert.equal(open.target.kind, 'exit');
  assert.ok(open.path.some((p) => level.ch(...tileOf(level, p)) === 'G'));
  validatePath(level, open.path);
  assert.equal(nav.update(playerAt(level, 51, 1), completed).status, 'arrived');
  level.dynamicOpen.clear();
});

check('turning and movement within a tile reuse the path and update continuous distance', () => {
  const nav = new Navigation(level), player = playerAt(level, 51, 81);
  const first = nav.update(player, valves), path = first.path, distance = first.distance;
  player.yaw = 2;
  assert.equal(nav.update(player, valves).path, path);
  player.pos.z -= 0.2;
  assert.equal(nav.update(player, valves).path, path);
  assert.ok(nav.result.distance < distance);
  const [tx, tz] = tileOf(level, nav.result.waypoint);
  assert.ok(Math.abs(tx - 51) + Math.abs(tz - 81) <= 1);
});

check('going off route, changing valve state, and resetting rebuild the route', () => {
  const nav = new Navigation(level), player = playerAt(level, 51, 81);
  const initial = nav.update(player, valves).path;
  const detour = playerAt(level, 49, 65);
  const moved = nav.update(detour, valves).path;
  assert.notEqual(moved, initial);
  assert.deepEqual(tileOf(level, moved[0]), [49, 65]);
  const firstTarget = nav.result.target;
  const changed = valves.map((v) => ({ ...v, done: v.tx === firstTarget.tx && v.tz === firstTarget.tz }));
  nav.update(detour, changed);
  assert.notEqual(nav.result.target.name, firstTarget.name);
  nav.reset();
  assert.equal(nav.result.path.length, 0);
  assert.equal(nav.update(player, valves).target.kind, 'valve');
});

// Small grids make impossible routes observable without relying on the authored map's alternate paths.
function fixture(rows, heights = {}) {
  const L = {
    W: rows[0].length, H: rows.length, tile: 2, dynamicOpen: new Set(),
    ch: (x, z) => rows[z]?.[x] ?? '#',
    isWater(x, z) { return '~u='.includes(this.ch(x, z)); },
    solid(x, z) { const ch = this.ch(x, z); return ch === '#' || ('DG'.includes(ch) && !this.dynamicOpen.has(ch)); },
    floor(x, z) { return heights[`${x},${z}`] ?? (this.isWater(x, z) ? -5 : 0.6); },
    ceil(x, z) { return this.ch(x, z) === 'u' ? -1.3 : 5; },
    deckTop(x, z) { return this.ch(x, z) === '=' ? 1 : null; },
    find(ch) {
      const found = [];
      rows.forEach((row, z) => [...row].forEach((c, x) => { if (c === ch) found.push([x, z]); }));
      return found;
    },
  };
  return L;
}

check('a swimmer beneath a catwalk must leave its underside before climbing', () => {
  const L = fixture(['######', '#~=V##', '######']);
  const nav = new Navigation(L), route = nav.update(playerAt(L, 2, 1, 'surface'), valvesFor(L));
  validatePath(L, route.path);
  assert.deepEqual(route.path.map((p) => tileOf(L, p)[0]), [2, 1, 2, 3]);
  assert.equal(route.path[0].mode, 'surface');
  assert.equal(route.path[2].mode, 'climb');
  const below = route.path;
  const above = nav.update(playerAt(L, 2, 1), valvesFor(L));
  assert.notEqual(above.path, below);
  assert.equal(above.path.length, 2);
  assert.equal(above.path[0].mode, 'ground');
});

check('starting beyond a tile center joins the first edge without pulling the player backward', () => {
  const L = fixture(['######', '#...V#', '######']);
  const player = playerAt(L, 1, 1);
  player.pos.x += 0.75;
  player.pos.z += 0.2;
  const nav = new Navigation(L), route = nav.update(player, valvesFor(L));
  assert.ok(route.waypoint.x > player.pos.x, 'the active route must continue forward');
  assert.equal(route.path[0].x, player.pos.x);
  assert.equal(route.path[0].z, 3, 'first edge remains aligned with the corridor');
  assert.equal(route.pathIndex, 1);
  assert.equal(route.waypoint, route.path[route.pathIndex]);
  assert.ok(standingConnectionClear(L, player.pos, route.waypoint));
  const cached = route.path;
  player.pos.x += 0.1;
  assert.equal(nav.update(player, valvesFor(L)).path, cached);
  assert.equal(route.pathIndex, 1, 'HUD must not redraw the consumed start point');
});

check('same-tile detours recenter before a wall or raised-gallery corner clips the player radius', () => {
  for (const raised of [false, true]) {
    const L = fixture([raised ? '##..###' : '##.####', '##...V#', '#######'], raised ? { '3,0': 3.35 } : {});
    const nav = new Navigation(L), player = playerAt(L, 2, 1);
    const active = valvesFor(L), original = nav.update(player, active).waypoint;
    assert.equal(nav.result.pathIndex, 1);
    player.pos.x += 0.6;
    player.pos.z -= 0.95;
    assert.ok(standingConnectionClear(L, player.pos, player.pos), 'detour position itself is valid');
    assert.equal(standingConnectionClear(L, player.pos, original), false, 'original connection clips the corner');
    const corrected = nav.update(player, active);
    assert.equal(corrected.pathIndex, 0);
    assert.equal(corrected.waypoint.x, 5);
    assert.equal(corrected.waypoint.z, 3);
    assert.ok(standingConnectionClear(L, player.pos, corrected.waypoint));
    player.pos.x = 5; player.pos.z = 3;
    assert.equal(nav.update(player, active).pathIndex, 1);
  }
});

check('joining the first edge preserves the later right-angle corridor turn', () => {
  const L = fixture(['######', '#...##', '###.##', '###V##', '######']);
  const player = playerAt(L, 1, 1);
  player.pos.x += 0.75;
  const route = new Navigation(L).update(player, valvesFor(L));
  assert.deepEqual(route.path.map((p) => tileOf(L, p)), [[1, 1], [2, 1], [3, 1], [3, 2], [3, 3]]);
  assert.deepEqual(tileOf(L, route.waypoint), [2, 1]);
  assert.equal(standingConnectionClear(L, player.pos, route.path.at(-1)), false);
  assert.ok(standingConnectionClear(L, player.pos, route.waypoint));
});

check('closed doors and unreachable heights return an empty path without a straight-line fallback', () => {
  for (const door of ['D', 'G']) {
    const L = fixture(['#####', `#.${door}V#`, '#####']);
    const nav = new Navigation(L), player = playerAt(L, 1, 1);
    const blocked = nav.update(player, valvesFor(L));
    assert.equal(blocked.status, 'unreachable');
    assert.deepEqual(blocked.path, []);
    assert.equal(blocked.waypoint, null);
    L.dynamicOpen.add(door);
    assert.equal(nav.update(player, valvesFor(L)).status, 'route');
  }
  const cliff = fixture(['####', '#.V#', '####'], { '2,1': 3.35 });
  assert.equal(new Navigation(cliff).update(playerAt(cliff, 1, 1), valvesFor(cliff)).status, 'unreachable');
  const underwater = fixture(['#####', '#.uV#', '#####']);
  assert.equal(new Navigation(underwater).update(playerAt(underwater, 1, 1), valvesFor(underwater)).status, 'unreachable');
});

check('an unreachable nearby valve does not hide a reachable farther valve', () => {
  const L = fixture(['########', '#.V#..V#', '#..#...#', '#......#', '########'], { '2,1': 3.35 });
  const route = new Navigation(L).update(playerAt(L, 1, 1), valvesFor(L));
  assert.equal(route.target.tx, 6);
  validatePath(L, route.path);
});

check('invalid coordinates clear cached guidance', () => {
  const nav = new Navigation(level);
  nav.update(spawn, valves);
  for (const value of [NaN, Infinity, -Infinity]) {
    const player = playerAt(level, 51, 81);
    player.pos.x = value;
    const route = nav.update(player, valves);
    assert.equal(route.status, 'unreachable');
    assert.deepEqual(route.path, []);
    assert.equal(route.target, null);
    assert.equal(route.waypoint, null);
    assert.equal(route.pathIndex, 0);
  }
});

check('the real player controller follows all four routes without drowning or getting stuck', () => {
  for (const valve of valves) {
    const L = new Level(), nav = new Navigation(L), player = new Player(L, new THREE.PerspectiveCamera());
    const active = only(valves, valve.tx, valve.tz), breathedAt = new Set();
    player.spawn(103, 163, 0);
    const keys = new Set();
    const input = {
      consumeMouse: () => [0, 0],
      any: (...names) => names.some((key) => keys.has(key)),
      key: (key) => keys.has(key),
      hit: (key) => keys.has(key),
    };
    let route;
    for (let frame = 0; frame < 16000; frame++) {
      route = nav.update(player, active);
      if (route.status === 'arrived') break;
      assert.ok(route.waypoint, `lost route to ${valve.name}`);
      assert.equal(route.waypoint, route.path[route.pathIndex]);
      const point = route.waypoint, dx = point.x - player.pos.x, dz = point.z - player.pos.z;
      const dy = point.y - player.pos.y, horizontal = Math.hypot(dx, dz);
      keys.clear();
      if (horizontal > 0.15) {
        player.yaw = Math.atan2(-dx, -dz);
        keys.add('KeyW');
      }
      if (player.mode === 'under') {
        player.pitch = Math.max(-1.3, Math.min(1.3, Math.atan2(dy, Math.max(0.1, horizontal))));
        if (horizontal < 0.15 && dy > 0.15) keys.add('Space');
        if (horizontal < 0.15 && dy < -0.15) keys.add('KeyC');
      } else {
        player.pitch = 0;
        if (player.mode === 'surface' && point.mode === 'under') keys.add('KeyC');
        if (player.mode === 'surface' && point.mode === 'climb') keys.add('Space');
      }
      if (route.action === 'breathe') keys.clear();
      player.update(1 / 60, input);
      assert.ok(player.breath > 0, `ran out of oxygen on route to ${valve.name}`);
      if (player.mode === 'surface' && L.ch(player.tileX, player.tileZ) === 'a') {
        breathedAt.add(player.tileZ < 20 ? 'north' : 'south');
      }
    }
    assert.equal(route.status, 'arrived', `controller stuck on route to ${valve.name}: ${JSON.stringify({ pos: player.pos, mode: player.mode, waypoint: route.waypoint })}`);
    if (valve.tx === 9) assert.deepEqual([...breathedAt].sort(), ['north', 'south']);
    // Props._valves places the wheel 0.5 m inside its wall, 1.2 m above the floor.
    const [dx, dz] = L.wallDir(valve.tx, valve.tz), [cx, cz] = L.worldCenter(valve.tx, valve.tz);
    const wheel = new THREE.Vector3(cx + dx * 0.5, L.floor(valve.tx, valve.tz) + 1.2, cz + dz * 0.5);
    const toWheel = wheel.sub(player.pos);
    assert.ok(toWheel.length() < 2.4, 'arrived must put the player within the actual valve interaction reach');
    assert.equal(player.underwater, false);
    player.yaw = Math.atan2(-toWheel.x, -toWheel.z);
    player.pitch = Math.atan2(toWheel.y, Math.hypot(toWheel.x, toWheel.z));
    player._applyCamera(1 / 60);
    assert.ok(player.camera.getWorldDirection(new THREE.Vector3()).dot(toWheel.normalize()) > 0.4,
      'the valve must be interactable after looking at its wheel');
  }
});

process.stdout.write(`${checks} navigation checks passed\n`);
