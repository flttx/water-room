// Local regressions plus honest long-running motion diagnostics.
// --regression runs only the fixed Hunter contracts; the default also diagnoses
// known narrow-corner and Colossus sinking failures, returning exit status 1.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Level } from '../src/level/level.js';
import { Player } from '../src/player.js';
import { Hunter } from '../src/creatures/hunter.js';
import { Colossus } from '../src/creatures/colossus.js';

const noop = () => {};
const voice = new Proxy({}, { get: () => noop });
const audio = new Proxy({ createCreatureVoice: () => voice }, { get: (o, k) => o[k] || noop });
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function fixture(Kind, extra = {}) {
  const level = new Level();
  const player = new Player(level, new THREE.PerspectiveCamera());
  player.spawn(103, 163, 0);
  const creature = new Kind({ scene: new THREE.Scene(), level, lampSys: { add: (o) => o }, audio,
    water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [], ...extra });
  return { level, player, creature, ctx: { player, camera: player.camera } };
}

function regressions() {
  const { level, creature: h, ctx } = fixture(Hunter, { seed: 1 });
  assert.ok(h.spawn(38 * level.W + 44, null));
  assert.ok(h.path?.length > 1, 'spawn must build its first route before choosing a heading');
  // A pooled Hunter must not inherit the previous life’s failed-path cooldown.
  h.noPathT = 9;
  assert.ok(h.spawn(38 * level.W + 44, null));
  assert.ok(h.noPathT <= 1.5, 'spawn retained the old cooldown');

  h.path = null;
  h.noPathT = 0.5;
  const goal = [h.patrolX, h.patrolZ];
  for (let i = 1; i <= 20; i++) h.update(1 / 60, i / 60, ctx);
  assert.deepEqual([h.patrolX, h.patrolZ], goal, 'path cooldown churned patrol destinations');

  h.path = [[h.x, h.z], [h.x + 1.5, h.z], [h.x + 1.5, h.z + 6]];
  h.pathI = 1; h.repathT = 2;
  h._goTo(0, h.x + 1.5, h.z + 6, 2.5, 8);
  assert.equal(h.pathI, 1, 'corner was skipped while still 1.5 m away');

  h.vx = h.vz = 0;
  const yaw = h.yaw;
  const wanted = yaw - 0.2;
  h._steer(1 / 60, h.x + Math.sin(wanted) * 10, h.z + Math.cos(wanted) * 10, 2.5);
  assert.ok(Math.abs(angle(h.yaw - yaw)) > 0.001, 'low velocity prevented steering');
  h._moveBody(0.35);
  assert.ok(h._poseClear(), 'low-speed steering bypassed the body collision');
  h.dispose();
  report({ regression: 'Hunter spawn/reset, cooldown, corner retention, low-speed turn', result: 'PASS' });
}

function hunterPatrol(seed, tx, tz) {
  const { level, creature: h, ctx } = fixture(Hunter, { seed });
  assert.ok(h.spawn(tz * level.W + tx, null));
  let distance = 0, stall = 0, maxStall = 0, maxStep = 0, goalChanges = 0;
  let ax = h.x, az = h.z, gx = h.patrolX, gz = h.patrolZ;
  for (let frame = 1; frame <= 3600; frame++) {
    const x = h.x, z = h.z;
    h.update(1 / 60, frame / 60, ctx);
    const step = Math.hypot(h.x - x, h.z - z);
    distance += step; maxStep = Math.max(maxStep, step);
    // Net 0.4 m progress, so jitter against a wall cannot hide a sustained stall.
    if (Math.hypot(h.x - ax, h.z - az) > 0.4) { ax = h.x; az = h.z; stall = 0; }
    else stall += 1 / 60;
    maxStall = Math.max(maxStall, stall);
    if (h.patrolX !== gx || h.patrolZ !== gz) { goalChanges++; gx = h.patrolX; gz = h.patrolZ; }
    if (frame % 30 === 0) assert.ok(h._poseClear(), 'patrol body entered terrain');
  }
  assert.ok(maxStep < 0.15, 'patrol jumped between frames');
  assert.ok(goalChanges < 45, 'failed route still changed destination every frame');
  const passed = maxStall < 5;
  report({ diagnostic: `Hunter patrol seed ${seed}, tile ${tx},${tz}`, result: passed ? 'PASS' : 'FAIL',
    distanceM: +distance.toFixed(2), maxContinuousStallS: +maxStall.toFixed(2),
    maxStepM: +maxStep.toFixed(3), goalChanges, stoppedAt: [h.x, h.z].map((v) => +v.toFixed(3)) });
  h.dispose();
  return passed;
}

async function loadModel() {
  globalThis.ProgressEvent ??= class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  const file = await fs.readFile(new URL('../public/models/colossus.glb', import.meta.url));
  const size = file.readUInt32LE(12);
  const json = JSON.parse(file.toString('utf8', 20, 20 + size));
  json.buffers[0].uri = `data:application/octet-stream;base64,${file.subarray(28 + size).toString('base64')}`;
  // Geometry, skin weights and bones remain real; texture decoding needs a browser.
  json.images = []; json.textures = [];
  json.materials = (json.materials || []).map(() => ({}));
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
  let mesh;
  gltf.scene.traverse((o) => { if (o.isMesh) mesh = o; });
  assert.ok(mesh, 'colossus model contains no mesh');
  return { geometry: mesh.geometry, material: mesh.material };
}

function colossusCycle(model) {
  const { player, creature: c, ctx } = fixture(Colossus, model ? { model } : {});
  player.spawn(103, 44, 0);
  const states = [c.state];
  const point = new THREE.Vector3(), root = new THREE.Vector3();
  let peak = c.y, stall = 0, maxStall = 0, anchorY = c.y, maxStep = 0, maxGap = 0;
  for (let frame = 1; frame <= 3000; frame++) {
    // Scene boundaries are intentional Player spawns; monster state is never forced.
    if (frame === 900) player.spawn(103, 163, 0);
    const x = c.x, y = c.y, z = c.z;
    c.update(1 / 30, frame / 30, ctx);
    if (states.at(-1) !== c.state) states.push(c.state);
    // Dormant relocation happens below the level; measure visible/awake movement.
    if (frame > 1) maxStep = Math.max(maxStep, Math.hypot(c.x - x, c.y - y, c.z - z));
    peak = Math.max(peak, c.y);
    if (c.state === 'sinking') {
      if (Math.abs(c.y - anchorY) > 0.1) { anchorY = c.y; stall = 0; }
      else stall += 1 / 30;
      maxStall = Math.max(maxStall, stall);
    }
    for (const a of c.arms) {
      point.copy(a.rootLocal).applyMatrix4(c.root.matrixWorld);
      maxGap = Math.max(maxGap, point.distanceTo(root.fromArray(a.chain.p)));
    }
    for (const a of [...c.feelers, ...c.beard]) {
      c._headPoint(a.rootLocal, a.w, point);
      maxGap = Math.max(maxGap, point.distanceTo(root.fromArray(a.chain.p)));
    }
  }
  assert.ok(maxStep < 0.3, 'Colossus moved discontinuously');
  assert.ok(maxGap < 0.3, 'Colossus tentacle detached');
  const passed = peak > 5 && states.includes('watch') && c.state === 'dormant' && maxStall < 5;
  report({ diagnostic: `Colossus natural cycle (${model ? 'GLB' : 'fallback'})`, result: passed ? 'PASS' : 'FAIL',
    states, peakY: +peak.toFixed(3), maxContinuousSinkStallS: +maxStall.toFixed(2), finalY: +c.y.toFixed(3),
    maxStepM: +maxStep.toFixed(3), maxAttachmentGapM: +maxGap.toFixed(3) });
  c.dispose();
  return passed;
}

async function main() {
  regressions();
  if (process.argv.includes('--regression')) return;
  const results = [hunterPatrol(1, 44, 38), hunterPatrol(2, 32, 50), colossusCycle(null), colossusCycle(await loadModel())];
  if (results.some((passed) => !passed)) {
    report({ summary: 'Local Hunter regressions PASS; unresolved sustained-motion diagnostics FAIL.' });
    process.exitCode = 1;
  }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
