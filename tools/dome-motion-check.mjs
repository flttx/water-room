// Exercise reservoir movement with the real rigs, without rendering or audio.
// Run all residents, or use --only=crab / --only=angler / --only=whale.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Level } from '../src/level/level.js';
import { Whale } from '../src/creatures/whale.js';
import { SpiderCrab } from '../src/creatures/spidercrab.js';
import { Angler } from '../src/creatures/angler.js';

const noop = () => {};
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init) { this.type = type; Object.assign(this, init); }
};
const voice = new Proxy({}, { get: () => noop });
const audio = new Proxy({ createCreatureVoice: () => voice }, { get: (o, k) => o[k] || noop });

async function model(name) {
  const file = await fs.readFile(new URL(`../public/models/${name}.glb`, import.meta.url));
  const size = file.readUInt32LE(12);
  const json = JSON.parse(file.toString('utf8', 20, 20 + size));
  json.buffers[0].uri = `data:application/octet-stream;base64,${file.subarray(28 + size).toString('base64')}`;
  json.images = []; json.textures = [];
  json.materials = (json.materials || []).map(() => ({}));
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
  let mesh;
  gltf.scene.traverse((o) => { if (o.isMesh) mesh = o; });
  return { scene: gltf.scene, mesh };
}

async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) || 120);
  assert.ok(!only || ['whale', 'crab', 'angler'].includes(only), 'Unknown resident');
  assert.ok(Number.isFinite(seconds) && seconds >= 10, 'Duration must be at least ten seconds');
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const level = new Level();
  const player = { pos: new THREE.Vector3(262, -2, 78), vel: new THREE.Vector3(), frozen: true,
    shake: 0, inWater: true, underwater: true, speed: 0, crouch: false, flashlight: false, breath: 30,
    get tileX() { return Math.floor(this.pos.x / 2); }, get tileZ() { return Math.floor(this.pos.z / 2); } };
  const ctx = { player, camera: { position: player.pos } };
  const opts = { scene: new THREE.Scene(), level, lampSys: { add: (o) => o }, audio,
    water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [] };
  for (const [name, Kind] of [['whale', Whale], ['crab', SpiderCrab], ['angler', Angler]]) {
    if (only && only !== name) continue;
    const c = new Kind({ ...opts, model: await model(name) });
    const position = () => c.head?.isVector3 ? c.head : c.hub || c.rig.root.position;
    const previous = position().clone(), windows = [];
    let distance = 0, maxStep = 0, invalid = 0, still = 0, longestStop = 0;
    for (let frame = 0; frame < seconds * 30; frame++) {
      c.update(1 / 30, frame / 30, ctx);
      const at = position(), step = at.distanceTo(previous);
      assert.ok(Number.isFinite(step), `${name}: position became non-finite`);
      distance += step; maxStep = Math.max(maxStep, step); previous.copy(at);
      still = step < 1 / 3000 ? still + 1 / 30 : 0;
      longestStop = Math.max(longestStop, still);
      if (frame % 30 === 0 && !c.surface.clear(level)) invalid++;
      if ((frame + 1) % 300 === 0) {
        windows.push({ t: (frame + 1) / 30, distance: +distance.toFixed(3), at: at.toArray().map((v) => +v.toFixed(2)),
          state: c.state, blocked: c.blockedT, route: c.u ?? c.patrolWp });
        distance = 0;
      }
    }
    process.stdout.write(`${JSON.stringify({ name, maxStep, invalid, longestStop, windows })}\n`);
    check(invalid === 0, `${name}: posed skin intersects terrain`);
    check(maxStep < 0.25, `${name}: patrol position jumped between frames`);
    if (name !== 'angler') {
      check(longestStop < 8, `${name}: longest stop was ${longestStop.toFixed(2)} seconds`);
      check(windows.every((w) => w.distance > 0.5), `${name}: a ten-second patrol window made no useful progress`);
    }
    if (name === 'angler') {
      for (const side of [0, 2]) {
        c.reset(); player.frozen = false;
        player.pos.copy(c.mouth).add(new THREE.Vector3(side, 1, -3));
        const states = new Set(); let maxOffset = 0, attackInvalid = 0;
        c.onCatch = () => { player.frozen = true; };
        for (let frame = 0; frame < 1200; frame++) {
          if (frame === 60) { player.frozen = true; player.pos.set(262, -2, 78); }
          c.update(1 / 30, 120 + frame / 30, ctx);
          states.add(c.state); maxOffset = Math.max(maxOffset, c.off.length());
          if (frame % 15 === 0 && !c.surface.clear(level)) attackInvalid++;
        }
        check(['tense', 'lunge', 'recover', 'dark', 'idle'].every((state) => states.has(state)), `angler/${side}: attack cycle did not complete`);
        check(maxOffset > 1 && c.off.length() < 0.05, `angler/${side}: strike did not return to its resting position`);
        check(attackInvalid === 0, `angler/${side}: attack skin intersects terrain`);
        process.stdout.write(`${JSON.stringify({ name, side, states: [...states], maxOffset, finalOffset: c.off.toArray(), attackInvalid })}\n`);
      }
    }
    c.dispose();
  }
  process.stdout.write(`${JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', failures })}\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
