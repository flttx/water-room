// Real skin, terrain, natural pursuit and binocular gaze regression.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Level } from '../src/level/level.js';
import { SpiderCrab } from '../src/creatures/spidercrab.js';

const noop = () => {};
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init) { this.type = type; Object.assign(this, init); }
};

async function main() {
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
  assert.ok(!only || ['gaze', 'pursuit'].includes(only), 'Unknown crab check');
  const file = await fs.readFile(new URL('../public/models/crab.glb', import.meta.url));
  const size = file.readUInt32LE(12);
  const json = JSON.parse(file.toString('utf8', 20, 20 + size));
  json.buffers[0].uri = `data:application/octet-stream;base64,${file.subarray(28 + size).toString('base64')}`;
  json.images = []; json.textures = []; json.materials = (json.materials || []).map(() => ({}));
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
  let mesh;
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
  const level = new Level(), scene = new THREE.Scene();
  const voice = new Proxy({}, { get: () => noop });
  const audio = new Proxy({ createCreatureVoice: () => voice }, { get: (o, k) => o[k] || noop });
  const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), frozen: false,
    shake: 0, speed: 3, mode: 'ground', crouch: false, flashlight: true, pitch: 0, yaw: -Math.PI / 2,
    get tileX() { return Math.floor(this.pos.x / 2); }, get tileZ() { return Math.floor(this.pos.z / 2); } };
  const c = new SpiderCrab({ scene, level, lampSys: { add: (o) => o }, audio,
    water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [], model: { scene: gltf.scene, mesh } });
  const toeSamples = c.legs.slice(0, 8).map((l, i) => c.surface.groups.get(i + 1)
    .filter(({ xyz }) => new THREE.Vector3(...xyz).distanceTo(l.ik.T0) < 0.07));
  toeSamples.forEach((samples) => assert.ok(samples.length > 0, 'missing real foot skin samples'));
  const toe = new THREE.Vector3(), weighted = new THREE.Vector3();
  const footGap = (i) => {
    c.surface.prepare();
    let gap = Infinity;
    for (const { xyz, bones, weights } of toeSamples[i]) {
      toe.set(0, 0, 0);
      for (let k = 0; k < 4; k++) if (weights[k]) {
        weighted.set(...xyz).applyMatrix4(c.surface.matrices[bones[k]]);
        toe.addScaledVector(weighted, weights[k]);
      }
      const tx = Math.floor(toe.x / 2), tz = Math.floor(toe.z / 2), deck = level.deckTop(tx, tz);
      const support = deck !== null && toe.y >= deck ? deck : level.floor(tx, tz);
      gap = Math.min(gap, toe.y - support);
    }
    return gap;
  };
  const results = [];
  const failures = [];
  try {
    for (const fps of only === 'gaze' ? [] : [30, 60]) {
      c.reset(); player.pos.set(243, 2.6, 95); player.frozen = false;
      c.onCatch = () => { player.frozen = true; };
      const start = c.hub.clone(), previous = start.clone();
      const feet = c.legs.slice(0, 8).map((l) => c.rig.toWorld(l.ik.knee, l.ik.T0, new THREE.Vector3()));
      const foot = new THREE.Vector3();
      const unplanted = Array(8).fill(0);
      const airborne = Array(8).fill(0);
      let maxUnplanted = 0, maxAirborne = 0;
      let chasing = false, maxStep = 0, maxFootStep = 0, stalled = 0, longestStall = 0, elapsed = 0;
      for (let frame = 0; frame < fps * 60 && !player.frozen; frame++) {
        c.update(1 / fps, elapsed, { player }); elapsed += 1 / fps;
        chasing ||= c.chasing;
        const step = c.hub.distanceTo(previous);
        maxStep = Math.max(maxStep, step); previous.copy(c.hub);
        const distant = Math.hypot(c.hub.x - player.pos.x, c.hub.z - player.pos.z) > 20;
        stalled = c.chasing && distant && step < 0.001 / fps ? stalled + 1 / fps : 0;
        longestStall = Math.max(longestStall, stalled);
        c.legs.slice(0, 8).forEach((l, i) => {
          c.rig.toWorld(l.ik.knee, l.ik.T0, foot);
          maxFootStep = Math.max(maxFootStep, feet[i].distanceTo(foot)); feet[i].copy(foot);
          const gap = footGap(i);
          unplanted[i] = l.swing < 0 && gap > 0.6 ? unplanted[i] + 1 / fps : 0;
          airborne[i] = gap > 0.6 ? airborne[i] + 1 / fps : 0;
          maxAirborne = Math.max(maxAirborne, airborne[i]);
          maxUnplanted = Math.max(maxUnplanted, unplanted[i]);
        });
        if (frame % fps === 0) assert.ok(c.surface.clear(level), `${fps} FPS: skin intersects terrain`);
      }
      const advance = start.x - c.hub.x;
      const caught = player.frozen;
      let recoveryFootStep = 0;
      for (let frame = 0; frame < fps * 12; frame++) {
        c.update(1 / fps, elapsed, { player }); elapsed += 1 / fps;
        c.legs.slice(0, 8).forEach((l, i) => {
          c.rig.toWorld(l.ik.knee, l.ik.T0, foot);
          recoveryFootStep = Math.max(recoveryFootStep, feet[i].distanceTo(foot)); feet[i].copy(foot);
          const gap = footGap(i);
          unplanted[i] = l.swing < 0 && gap > 0.6 ? unplanted[i] + 1 / fps : 0;
          airborne[i] = gap > 0.6 ? airborne[i] + 1 / fps : 0;
          maxAirborne = Math.max(maxAirborne, airborne[i]);
          maxUnplanted = Math.max(maxUnplanted, unplanted[i]);
        });
        if (frame % fps === 0) assert.ok(c.surface.clear(level), `${fps} FPS: recovery skin intersects terrain`);
      }
      results.push({ fps, advance, maxStep, maxFootStep, recoveryFootStep, longestStall, maxUnplanted, maxAirborne, caught });
      assert.ok(chasing, `${fps} FPS: did not naturally detect and pursue the player`);
      assert.ok(caught, `${fps} FPS: approached but did not complete a natural attack`);
      assert.ok(advance > 20, `${fps} FPS: stopped before approaching the west bridge (${advance.toFixed(2)} m)`);
      assert.ok(longestStall < 8, `${fps} FPS: pursuit stalled`);
      assert.ok(maxStep < 0.25, `${fps} FPS: body jumped`);
      assert.ok(maxFootStep * fps < 12, `${fps} FPS: walking foot reached ${(maxFootStep * fps).toFixed(2)} m/s`);
      assert.ok(recoveryFootStep * fps < 12, `${fps} FPS: recovery foot reached ${(recoveryFootStep * fps).toFixed(2)} m/s`);
      assert.equal(c.state, 'patrol', `${fps} FPS: did not resume patrol after feeding`);
      if (maxUnplanted >= 6) failures.push(`${fps} FPS: a standing leg hovered for ${maxUnplanted.toFixed(2)} s`);
      if (maxAirborne >= 12) failures.push(`${fps} FPS: a walking leg did not touch down for ${maxAirborne.toFixed(2)} s`);
    }
    if (only !== 'gaze') {
      c.reset(); player.frozen = false; player.pos.set(0, 2.6, 0);
      for (let frame = 0; frame < 600; frame++) c.update(1 / 30, frame / 30, { player });
      assert.equal(c.group.visible, false, 'offscreen fixture stayed visible');
      const previous = c.hub.clone();
      player.pos.set(243, 2.6, 95);
      c.update(1 / 30, 20, { player });
      const entryStep = c.hub.distanceTo(previous);
      assert.ok(entryStep < 0.25, `re-entering view jumped ${entryStep.toFixed(2)} m`);
      let chasing = false;
      for (let frame = 1; frame <= 1800 && !player.frozen; frame++) {
        c.update(1 / 30, 20 + frame / 30, { player });
        chasing ||= c.chasing;
        if (frame % 30 === 0) assert.ok(c.surface.clear(level), 'offscreen encounter skin intersects terrain');
      }
      assert.ok(chasing && player.frozen, 'offscreen patrol did not resume a natural pursuit and attack');
      results.push({ offscreenSeconds: 20, entryStep, caught: player.frozen });
    }
    if (only === 'pursuit') {
      process.stdout.write(`${JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', pursuit: results, failures })}\n`);
      assert.deepEqual(failures, [], 'walking feet did not settle');
      return;
    }
    c.reset(); player.frozen = false;
    let gazeError = 0, minZ = Infinity, maxZ = -Infinity;
    for (let frame = 0; frame < 240; frame++) {
      // The entire lateral path lies on the central pump deck.
      player.pos.set(262, 2.6, 94 + 4 * Math.cos(frame / 239 * Math.PI * 2));
      c.update(1 / 60, frame / 60, { player });
      assert.equal(player.frozen, false, 'lateral gaze fixture was caught before sampling');
      if (frame < 30) continue;
      minZ = Math.min(minZ, c.fwd.z); maxZ = Math.max(maxZ, c.fwd.z);
      for (const eye of c.eyes) {
        const target = player.pos.clone().sub(eye.position).normalize();
        gazeError = Math.max(gazeError, eye.getWorldDirection(new THREE.Vector3()).angleTo(target));
      }
    }
    assert.ok(gazeError < 5 * Math.PI / 180, `eyes lagged behind lateral movement by ${gazeError * 180 / Math.PI} degrees`);
    assert.ok(minZ < -0.05 && maxZ > 0.05, 'gaze did not follow both directions');
    c.reset(); player.pos.set(262, -2, 94); player.frozen = false;
    for (let frame = 0; frame < 90; frame++) c.update(1 / 30, frame / 30, { player });
    assert.equal(c.tracking, false, 'eyes tracked a player through the pump deck');
    assert.equal(c.chasing, false, 'sight started a chase through the pump deck');
    process.stdout.write(`${JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', pursuit: results, gazeErrorDegrees: gazeError * 180 / Math.PI, failures })}\n`);
    assert.deepEqual(failures, [], 'walking feet did not settle');
  } finally { c.dispose(); }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
