// Run: node tools/lurker-patrol-check.mjs
// Real patrol/attack AI and player controls; only render/audio outputs are stubbed.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Level } from '../src/level/level.js';
import { DRAIN_LURKER_PATROL, LURKERS } from '../src/level/mapdata.js';
import { Player } from '../src/player.js';
import { Navigation } from '../src/navigation.js';
import { Lurkers } from '../src/creatures/lurker.js';
import { sphereClear } from '../src/creatures/collision.js';

const DT = 1 / 60;
const noop = () => {};

function relayNoise(player, manager) {
  const p = player.pos;
  let count = 0;
  const hear = (x, y, z, radius, loud = false) => { manager.hear(x, y, z, radius, loud); count++; };
  for (const e of player.events) {
    switch (e.type) {
      case 'jump': hear(p.x, p.y, p.z, 4); break;
      case 'land': hear(p.x, p.y, p.z, e.hard ? 16 : 6, e.hard); break;
      case 'step': hear(p.x, p.y, p.z, e.sprint ? 14 : e.crouch ? 3 : 7.5); break;
      case 'splash': hear(e.x, 0, e.z, e.quiet ? 6 : 22, !e.quiet); break;
      case 'stroke': hear(e.x, 0, e.z, e.sprint ? 12 : 6); break;
      case 'uswim': hear(p.x, p.y, p.z, e.sprint ? 8 : 4); break;
      case 'dive': hear(e.x, 0, e.z, 5); break;
      case 'climb': hear(e.x, 0, e.z, 6); break;
      case 'surface': if (e.gasp) hear(e.x, 0, e.z, 10); break;
      default: break;
    }
  }
  return count;
}

function harness(tx, tz) {
  const level = new Level(), camera = new THREE.PerspectiveCamera(), player = new Player(level, camera);
  player.spawn((tx + 0.5) * level.tile, (tz + 0.5) * level.tile, 0);
  const voice = { setPosition: noop, setState: noop, setSpeed: noop, update: noop, dispose: noop };
  const manager = new Lurkers({ level, scene: new THREE.Scene(), lampSys: { add: (lamp) => lamp },
    audio: { createCreatureVoice: () => voice, lurkerSnap: noop, splash: noop },
    water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [] });
  assert.deepEqual(LURKERS[3], DRAIN_LURKER_PATROL.entrance);
  assert.equal(manager.list.length, 8);
  assert.deepEqual(manager.list.filter((fish) => fish.patrol).map((fish) => fish.k), [3]);
  const keys = new Set(), previousKeys = new Set();
  const input = { consumeMouse: () => [0, 0], any: (...names) => names.some((key) => keys.has(key)),
    key: (key) => keys.has(key), hit: (key) => keys.has(key) && !previousKeys.has(key) };
  const run = { level, player, camera, manager, fish: manager.list[3], t: 0, catches: 0, noises: 0, states: new Set() };
  manager.onCatch = () => { run.catches++; };
  run.tick = (point = null, sprint = false) => {
    keys.clear();
    if (point) {
      const dx = point.x - player.pos.x, dz = point.z - player.pos.z, dy = point.y - player.pos.y;
      const horizontal = Math.hypot(dx, dz);
      const yaw = horizontal > 0.15 ? Math.atan2(-dx, -dz) : player.yaw;
      const pitch = player.mode === 'under'
        ? Math.max(-1.3, Math.min(1.3, Math.atan2(dy, Math.max(0.1, horizontal)))) : 0;
      player.look((player.yaw - yaw) / 0.0022, (player.pitch - pitch) / 0.0022);
      if (horizontal > 0.15) keys.add('KeyW');
      if (sprint) keys.add('ShiftLeft');
      if (player.mode === 'under') {
        if (horizontal < 0.15 && dy > 0.15) keys.add('Space');
        if (horizontal < 0.15 && dy < -0.15) keys.add('KeyC');
      } else if (player.mode === 'surface') {
        if (point.mode === 'under') keys.add('KeyC');
        if (point.mode === 'climb' && player.climbTarget()) keys.add('Space');
      }
    }
    player.update(DT, input);
    previousKeys.clear();
    for (const key of keys) previousKeys.add(key);
    run.noises += relayNoise(player, manager);
    run.t += DT;
    manager.update(DT, run.t, { player, camera });
    run.states.add(run.fish.state);
    assert.equal(player.frozen, false);
    assert.ok(player.breath > 0, 'test exhausted player oxygen');
  };
  return run;
}

function horizontalDistance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function chains(fish) { return [fish.tail, fish.stalk, ...fish.fringe.map((part) => part.chain)]; }

function sampleGeometry(fish, level) {
  assert.ok(fish._bodyClear(), 'patrol body or attachment crossed the terrain');
  for (const chain of chains(fish)) {
    assert.ok([...chain.p].every(Number.isFinite), 'patrol limb has a non-finite position');
    for (let i = 1; i < chain.n; i++) {
      const a = (i - 1) * 3, b = i * 3;
      for (let j = 0; j <= 4; j++) {
        const t = j / 4;
        assert.ok(sphereClear(level,
          chain.p[a] + (chain.p[b] - chain.p[a]) * t,
          chain.p[a + 1] + (chain.p[b + 1] - chain.p[a + 1]) * t,
          chain.p[a + 2] + (chain.p[b + 2] - chain.p[a + 2]) * t,
          chain.r[i - 1] + (chain.r[i] - chain.r[i - 1]) * t), 'patrol limb or segment crossed the terrain');
      }
    }
  }
}

// Observe two complete cycles, including real turns and the long inner pause.
{
  const run = harness(72, 66), { fish, manager, level } = run;
  const home = fish.home.clone(), last = fish.pos.clone(), limbs = chains(fish), oldLimbs = limbs.map((chain) => chain.p.slice());
  let returned = 0, next = fish.patrol.next, innerPause = 0, longestPause = 0, maxStep = 0, maxLimbStep = 0;
  let samples = 0;
  try {
    for (let frame = 0; frame < 6600 && returned < 2; frame++) {
      run.tick();
      const step = horizontalDistance(fish.pos, last);
      maxStep = Math.max(maxStep, step);
      assert.ok(step <= 0.86 * DT + 0.0001, `patrol jumped ${step.toFixed(4)} m in one frame`);
      last.copy(fish.pos);
      if (fish.patrol.next !== next) {
        if (fish.patrol.next === 1) {
          returned++;
          assert.ok(horizontalDistance(fish.pos, fish.patrol.entry) < 0.02, 'return stopped before the entrance anchor');
        }
        next = fish.patrol.next;
      }
      if (horizontalDistance(fish.pos, fish.patrol.inner) < 0.02 && fish.patrol.pause > 0) {
        assert.ok(horizontalDistance(fish.pos, fish.patrol.entry) > 7, 'inner pause still occupies the entrance');
        innerPause += DT;
        longestPause = Math.max(longestPause, innerPause);
      } else innerPause = 0;
      for (const other of manager.list) if (other !== fish) {
        assert.equal(other.state, 'wait', `lair lurker ${other.k} unexpectedly attacked`);
        assert.ok(horizontalDistance(other.pos, other.home) < 0.7, `lair lurker ${other.k} left its idle swimming area`);
      }
      for (let k = 0; k < limbs.length; k++) {
        const chain = limbs[k];
        if (frame > 60) for (let i = 0; i < chain.p.length; i += 3) {
          const delta = Math.hypot(chain.p[i] - oldLimbs[k][i], chain.p[i + 1] - oldLimbs[k][i + 1], chain.p[i + 2] - oldLimbs[k][i + 2]);
          maxLimbStep = Math.max(maxLimbStep, delta);
          assert.ok(Number.isFinite(delta), 'patrol limb displacement is not finite');
        }
        oldLimbs[k].set(chain.p);
      }
      if (frame >= 60 && frame % 30 === 0) { sampleGeometry(fish, level); samples++; }
      assert.equal(manager.caught, false);
    }
    assert.equal(returned, 2, `patrol stalled: ${JSON.stringify({ pos: fish.pos, next: fish.patrol.next, pause: fish.patrol.pause })}`);
    assert.ok(longestPause >= 6, `entrance was clear for only ${longestPause.toFixed(2)} s`);
    process.stdout.write(`PASS two patrol round trips; inner pause ${longestPause.toFixed(2)} s; ${samples} geometry samples; max body/limb step ${maxStep.toFixed(3)}/${maxLimbStep.toFixed(3)} m; other 7 stay home\n`);

    manager.reset();
    assert.ok(fish.pos.distanceTo(home) < 0.001, 'reset did not restore the original entrance spawn');
    assert.equal(fish.patrol.next, 1);
    assert.equal(fish.state, 'wait');
    let innerReached = false, returnReached = false;
    for (let frame = 0; frame < 3000 && !returnReached; frame++) {
      run.tick();
      if (fish.patrol.next === 0) innerReached = true;
      if (innerReached && fish.patrol.next === 1 && horizontalDistance(fish.pos, fish.patrol.entry) < 0.02) returnReached = true;
    }
    assert.ok(innerReached && returnReached, 'reset patrol did not complete a fresh round trip');
    process.stdout.write('PASS reset restores original entrance spawn and completes a fresh patrol cycle\n');
  } finally { manager.dispose(); }
}

// Proximity must still start the complete attack both at the entrance and after moving inward.
for (const [label, spawn, moved] of [['entrance', [76, 66], false], ['inner corridor', [78, 71], true]]) {
  const run = harness(...spawn), { fish, manager } = run;
  try {
    let strikePosition = null;
    for (let frame = 0; frame < 1800 && !run.states.has('surge'); frame++) {
      run.tick();
      if (fish.state === 'suck' && !strikePosition) strikePosition = fish.pos.clone();
    }
    assert.ok(strikePosition && run.states.has('surge'), `${label}: close player did not trigger a real ambush`);
    if (moved) assert.ok(horizontalDistance(strikePosition, fish.home) > 4, 'inner ambush happened before the fish moved inward');
    process.stdout.write(`PASS ${label}: proximity triggered suck -> surge${moved ? ' after moving inward' : ''}\n`);
  } finally { manager.dispose(); }
}

// Feed sound through the public hearing API outside the proximity radius; retreat uses real input.
for (const [label, spawn, inner, retreat] of [
  ['entrance', [74, 66], false, { x: 143, y: 0.26, z: 133, mode: 'surface' }],
  ['inner corridor', [81, 70], true, { x: 173, y: 0.26, z: 141, mode: 'surface' }],
]) {
  const run = harness(...spawn), { fish, manager, player } = run;
  try {
    if (inner) {
      for (let frame = 0; frame < 1800 && !(fish.patrol.next === 0 && fish.patrol.pause > 6); frame++) run.tick();
      assert.ok(fish.patrol.next === 0 && fish.patrol.pause > 6, 'fish did not reach the inner sound-test position');
    } else for (let frame = 0; frame < 10; frame++) run.tick();
    assert.equal(fish.state, 'wait', 'sound test started inside the automatic proximity trigger');
    const anchor = fish.pos.clone();
    for (let burst = 0; burst < 2; burst++) {
      manager.hear(player.pos.x, player.pos.y, player.pos.z, 7.5, true);
      run.tick(retreat, true);
    }
    assert.ok(run.states.has('suck'), `${label}: sound did not trigger the ambush`);
    let recovered = false;
    for (let frame = 0; frame < 2100 && !recovered; frame++) {
      run.tick(retreat, true);
      assert.equal(manager.caught, false, `${label}: retreat failed`);
      if (run.states.has('return') && fish.state === 'wait' && horizontalDistance(fish.pos, anchor) > 2) recovered = true;
    }
    assert.ok(run.states.has('surge') && run.states.has('return') && recovered, `${label}: attack did not resume patrol`);
    process.stdout.write(`PASS ${label}: hearing triggered a real ambush; retreat survived; patrol resumed\n`);
  } finally { manager.dispose(); }
}

// Gameplay crossing: wait west of the entrance, observe the fish reach its inner pause, then go north.
{
  const run = harness(73, 66), { player, manager, fish, level } = run;
  const nav = new Navigation(level), destination = [{ tx: 78, tz: 63, name: '排水渠北段', done: false }];
  let entered = false, arrived = false, waited = 0;
  const visited = new Set();
  try {
    for (let frame = 0; frame < 1800; frame++) {
      if (!entered && fish.patrol.next === 0 && fish.patrol.pause > 6.5) { entered = true; waited = run.t; }
      const route = entered ? nav.update(player, destination) : null;
      if (route?.status === 'arrived') { arrived = true; break; }
      run.tick(route?.waypoint ?? null);
      visited.add(`${player.tileX},${player.tileZ}`);
      assert.equal(manager.caught, false, `player caught while crossing: ${JSON.stringify({ pos: player.pos, fish: fish.pos, state: fish.state })}`);
      if (frame % 60 === 0 && frame > 0) sampleGeometry(fish, level);
    }
    assert.ok(entered && arrived, 'observing the inner pause did not allow the player to pass north');
    assert.ok(visited.has('77,66') || visited.has('78,66'), 'player bypassed the drain entrance');
    assert.ok(player.pos.z < 129, 'player did not reach the north corridor');
    assert.ok(run.noises > 0, 'crossing muted real player movement noise');
    assert.equal(run.catches, 0);
    process.stdout.write(`PASS real player waits ${waited.toFixed(2)} s, crosses entrance and reaches north corridor alive in ${(run.t - waited).toFixed(2)} s with normal movement noise\n`);
  } finally { manager.dispose(); }
}
