// Shortcut regression: real player movement and lure-fish AI, without WebGL or audio devices.
// Run: node tools/shortcut-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Level } from '../src/level/level.js';
import { LURKERS } from '../src/level/mapdata.js';
import { Navigation } from '../src/navigation.js';
import { Player } from '../src/player.js';
import { Lurkers } from '../src/creatures/lurker.js';

const DT = 1 / 60;
const EAST_CHECKPOINT = [49, 65];
const WEST_CHECKPOINT = [23, 60];
const BATH_VALVE = [11, 34];
const NEW_SECTIONS = [[34, 61, 39, 62], [28, 61, 30, 62]];
const noop = () => {};

function makePlayer(level, [tx, tz]) {
  const player = new Player(level, new THREE.PerspectiveCamera());
  player.spawn((tx + 0.5) * level.tile, (tz + 0.5) * level.tile, 0);
  return player;
}

function goal([tx, tz]) { return [{ tx, tz, name: '测试目的地', done: false }]; }

function oldLayout() {
  const level = new Level();
  // Only undo the two new openings; preserve every pre-existing route and room.
  for (const [x0, z0, x1, z1] of NEW_SECTIONS) {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) level.chars[z][x] = '#';
  }
  return level;
}

function controller(player, level) {
  const keys = new Set(), previous = new Set();
  const input = {
    consumeMouse: () => [0, 0],
    any: (...names) => names.some((key) => keys.has(key)),
    key: (key) => keys.has(key),
    hit: (key) => keys.has(key) && !previous.has(key),
  };
  return (point, { sprint = false, crouch = false, breathe = false } = {}) => {
    keys.clear();
    if (point && !breathe) {
      const dx = point.x - player.pos.x, dz = point.z - player.pos.z;
      const horizontal = Math.hypot(dx, dz), dy = point.y - player.pos.y;
      const yaw = horizontal > 0.15 ? Math.atan2(-dx, -dz) : player.yaw;
      const pitch = player.mode === 'under'
        ? Math.max(-1.3, Math.min(1.3, Math.atan2(dy, Math.max(0.1, horizontal)))) : 0;
      // Camera input goes through Player.look; only update() moves the player after spawn.
      player.look((player.yaw - yaw) / 0.0022, (player.pitch - pitch) / 0.0022);
      if (horizontal > 0.15) keys.add('KeyW');
      if (sprint) keys.add('ShiftLeft');
      if (crouch) keys.add('ControlLeft');
      if (player.mode === 'under') {
        if (horizontal < 0.15 && dy > 0.15) keys.add('Space');
        if (horizontal < 0.15 && dy < -0.15) keys.add('KeyC');
      } else if (player.mode === 'surface') {
        if (point.mode === 'under') keys.add('KeyC');
        const tx = Math.floor(point.x / level.tile), tz = Math.floor(point.z / level.tile);
        if ((point.mode === 'climb' || !level.isWater(tx, tz)) && player.climbTarget()) keys.add('Space');
      }
    }
    player.update(DT, input);
    previous.clear();
    for (const key of keys) previous.add(key);
  };
}

function followRoute(level, from, to) {
  const player = makePlayer(level, from), nav = new Navigation(level), drive = controller(player, level);
  const destination = goal(to), visited = new Set();
  let route, climbs = 0, waterFrames = 0;
  for (let frame = 0; frame < 16000; frame++) {
    route = nav.update(player, destination);
    if (route.status === 'arrived') break;
    assert.ok(route.waypoint, `route disappeared from ${from} to ${to}`);
    drive(route.waypoint, { breathe: route.action === 'breathe' });
    visited.add(`${player.tileX},${player.tileZ}`);
    climbs += player.events.filter((event) => event.type === 'climb').length;
    waterFrames += player.inWater ? 1 : 0;
    assert.ok(player.breath > 0, 'shortcut exhausted the player oxygen');
    assert.equal(level.solid(player.tileX, player.tileZ), false, 'player entered a solid tile');
  }
  assert.equal(route.status, 'arrived', `player stuck from ${from} to ${to}`);
  assert.equal(player.mode, 'ground', 'route must end on the destination landing');
  return { visited, climbs, waterFrames };
}

const current = new Level(), previous = oldLayout();
const start = makePlayer(current, EAST_CHECKPOINT);
for (const [name, target, expected] of [['locker checkpoint', WEST_CHECKPOINT, 40], ['bath valve', BATH_VALVE, 32]]) {
  const now = new Navigation(current).update(start, goal(target));
  const old = new Navigation(previous).update(start, goal(target));
  assert.equal(now.status, 'route');
  assert.equal(old.status, 'route', 'the old detour must remain available');
  assert.ok(Math.abs((old.distance - now.distance) - expected) < 0.01);
  followRoute(previous, EAST_CHECKPOINT, target);
  process.stdout.write(`PASS ${name}: ${old.distance.toFixed(2)} m -> ${now.distance.toFixed(2)} m (${expected} m shorter); old detour walkable\n`);
}

for (const [label, from, to] of [['east to west', EAST_CHECKPOINT, WEST_CHECKPOINT], ['west to east', WEST_CHECKPOINT, EAST_CHECKPOINT]]) {
  const run = followRoute(current, from, to);
  for (const [x0, z0, x1, z1] of NEW_SECTIONS) {
    for (let x = x0; x <= x1; x++) {
      assert.ok(Array.from({ length: z1 - z0 + 1 }, (_, i) => `${x},${z0 + i}`).some((tile) => run.visited.has(tile)),
        `${label} missed shortcut column ${x}`);
    }
  }
  assert.ok([...run.visited].some((tile) => {
    const [x, z] = tile.split(',').map(Number);
    return x >= 40 && x <= 44 && z >= 60 && z <= 63;
  }), 'route did not pass through the plant room');
  assert.ok(run.waterFrames > 0 && run.climbs > 0, 'route must swim and climb out');
  process.stdout.write(`PASS ${label}: real Player + Navigation crossed both openings and climbed ashore\n`);
}

// Mirror Main._playerEvents noise strengths. No artificial enemy states, cooldowns or catches.
function relayNoise(player, lurkers) {
  const p = player.pos;
  let count = 0;
  const hear = (x, y, z, radius, loud = false) => { lurkers.hear(x, y, z, radius, loud); count++; };
  for (const event of player.events) {
    switch (event.type) {
      case 'jump': hear(p.x, p.y, p.z, 4); break;
      case 'land': hear(p.x, p.y, p.z, event.hard ? 16 : 6, event.hard); break;
      case 'step': hear(p.x, p.y, p.z, event.sprint ? 14 : event.crouch ? 3 : 7.5); break;
      case 'splash': hear(event.x, 0, event.z, event.quiet ? 6 : 22, !event.quiet); break;
      case 'stroke': hear(event.x, 0, event.z, event.sprint ? 12 : 6); break;
      case 'uswim': hear(p.x, p.y, p.z, event.sprint ? 8 : 4); break;
      case 'dive': hear(event.x, 0, event.z, 5); break;
      case 'climb': hear(event.x, 0, event.z, 6); break;
      case 'surface': if (event.gasp) hear(event.x, 0, event.z, 10); break;
      default: break;
    }
  }
  return count;
}

function encounter(strategy) {
  const level = new Level(), player = makePlayer(level, [46, 61]), drive = controller(player, level);
  const voice = { setPosition: noop, setState: noop, setSpeed: noop, update: noop, dispose: noop };
  // Rendering/audio outputs alone are stubs; the complete Lurkers manager and collisions run.
  const lurkers = new Lurkers({
    scene: new THREE.Scene(), level, lampSys: { add: (lamp) => lamp },
    audio: { createCreatureVoice: () => voice, lurkerSnap: noop, splash: noop },
    water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [],
  });
  assert.deepEqual(LURKERS[7], [42, 61]);
  const fish = lurkers.list[7];
  assert.equal(fish.k, 7);
  assert.equal(fish.home.x, 85);
  assert.equal(fish.home.z, 123);
  const states = new Set(), milestones = [], visited = new Set();
  let catches = 0, noises = 0, phase = 'approach', crossingPoint = 0, previousState = 'wait', elapsed = 0;
  let completed = false, climbedWest = false, retreated = false;
  lurkers.onCatch = () => { catches++; };
  // Enter from the original east landing, then keep south of the lair during its recovery.
  const crossing = [
    { x: 89, y: 0.26, z: 123, mode: 'surface' },
    { x: 87, y: 0.26, z: 126.5, mode: 'surface' },
    { x: 80.7, y: 0.26, z: 125, mode: 'surface' },
    { x: 61, y: 2.22, z: 125, mode: 'climb' },
    { x: 59, y: 2.22, z: 125, mode: 'ground' },
  ];
  try {
    for (let frame = 0; frame < 1800; frame++) {
      elapsed = frame * DT;
      if (strategy === 'bait' && phase === 'approach' && fish.state === 'suck') phase = 'retreat';
      if (phase === 'retreat' && fish.state === 'return' && player.mode === 'ground' && player.pos.x > 92.2) {
        retreated = true;
        phase = 'cross';
      }
      let point = strategy === 'rush' ? crossing.at(-1)
        : phase === 'approach' ? { x: 89.8, y: 0.26, z: 123, mode: 'surface' }
          : phase === 'retreat' ? { x: 93, y: 2.22, z: 123, mode: 'climb' } : crossing[crossingPoint];
      if (phase === 'cross' && Math.hypot(point.x - player.pos.x, point.z - player.pos.z) < 0.6) {
        if (crossingPoint === crossing.length - 1 && player.mode === 'ground') { completed = true; break; }
        if (crossingPoint < crossing.length - 1) point = crossing[++crossingPoint];
      }
      drive(point, { sprint: strategy === 'rush' || phase !== 'approach', crouch: strategy === 'bait' && phase === 'approach' });
      noises += relayNoise(player, lurkers);
      lurkers.update(DT, elapsed, { player, camera: player.camera });
      states.add(fish.state);
      if (fish.state !== previousState) {
        milestones.push(`${fish.state}@${elapsed.toFixed(2)}s`);
        previousState = fish.state;
      }
      visited.add(`${player.tileX},${player.tileZ}`);
      if (player.events.some((event) => event.type === 'climb') && player.pos.x < 64) climbedWest = true;
      assert.equal(player.frozen, false, 'survival must not disable the player');
      assert.ok(player.breath > 0);
      if (lurkers.caught) break;
    }
    assert.ok(noises > 0, 'real movement noise must reach Lurkers.hear');
    assert.ok(states.has('suck') && states.has('surge'), 'the real ambush must execute');
    if (strategy === 'rush') {
      assert.ok(fish.caught && catches > 0, 'rushing straight through must retain the lure-fish danger');
    } else {
      assert.ok(retreated && states.has('return'), 'strategy must retreat and wait out the actual lunge');
      assert.ok(completed && climbedWest, `safe crossing did not reach the west landing: ${JSON.stringify({ phase, crossingPoint, pos: player.pos })}`);
      assert.equal(catches, 0);
      assert.equal(lurkers.caught, false);
      assert.ok(visited.has('43,63'), 'crossing must use the south side of the room');
      assert.ok(visited.has('29,62'), 'crossing must end beyond the west climb-out');
    }
    return { elapsed, milestones };
  } finally {
    lurkers.dispose();
  }
}

const rush = encounter('rush');
process.stdout.write(`PASS danger retained: rushing in was caught at ${rush.elapsed.toFixed(2)} s (${rush.milestones.join(', ')})\n`);
const safe = encounter('bait');
process.stdout.write(`PASS safe crossing: crouch approach, retreat, southern pass, west climb-out; alive at ${safe.elapsed.toFixed(2)} s (${safe.milestones.join(', ')})\n`);
