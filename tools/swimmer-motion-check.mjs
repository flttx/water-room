// Continuous motion checks using the real level, creature updates and shipped model geometry.
// Run: node tools/swimmer-motion-check.mjs [--only=drifter|leviathan]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Level, ABYSS_WALL_BOTTOM } from '../src/level/level.js';
import { sphereClear, sphereTravel } from '../src/creatures/collision.js';
import { Drifter } from '../src/creatures/drifter.js';
import { Leviathan } from '../src/creatures/leviathan.js';

const noop = () => {};
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const level = new Level();
const scene = new THREE.Scene();
const options = { scene, level, lampSys: { add: (o) => o }, audio: new Proxy({}, { get: () => noop }),
  water: { addRipple: noop }, fx: { bubbles: { spawn: noop } } };
const player = { pos: new THREE.Vector3(103, -1, 30), vel: new THREE.Vector3(), frozen: true, shake: 0 };
const camera = { position: new THREE.Vector3(-1000, 0, -1000) };
const context = { player, camera };
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

function drifters() {
  player.frozen = true;
  for (let route = -1; route < level.reservoir.jellies.length; route++) {
    const checkpoints = new Map();
    for (const fps of [30, 60, 144]) {
      const creature = new Drifter(options, route < 0 ? {} : { route: level.reservoir.jellies[route],
        seed: 900 + route, bells: 20, scale: 1.5, speed: 0.7, lethal: true, source: 'siphonophore' });
      const dt = 1 / fps, frames = Math.ceil(creature.loop.total / creature.speed * fps) + 1;
      creature.update(0, 0, context);
      const previous = creature.bellPos.slice();
      let maxSpeed = 0, contacts = 0, crossedWalls = 0, fpsError = 0;
      for (let frame = 1; frame <= frames; frame++) {
        // Keep the real animation visible twice a second; bell motion updates on every frame.
        if (frame % Math.round(fps / 2) === 0) camera.position.fromArray(previous);
        else camera.position.set(-1000, 0, -1000);
        creature.update(dt, frame * dt, context);
        for (let i = 0; i < creature.n; i++) {
          const o = i * 3, p = creature.bellPos, radius = creature.bellSize(i) * 0.9;
          assert.ok(Number.isFinite(p[o] + p[o + 1] + p[o + 2]), 'non-finite drifter position');
          maxSpeed = Math.max(maxSpeed, Math.hypot(p[o] - previous[o], p[o + 1] - previous[o + 1], p[o + 2] - previous[o + 2]) / dt);
          if (!sphereClear(level, p[o], p[o + 1], p[o + 2], radius)) contacts++;
          if (sphereTravel(level, previous[o], previous[o + 1], previous[o + 2], p[o], p[o + 1], p[o + 2], radius) < 1) crossedWalls++;
        }
        if (frame % (fps * 15) === 0) {
          const key = frame / fps;
          if (fps === 30) checkpoints.set(key, creature.bellPos.slice());
          else if (checkpoints.has(key)) {
            const reference = checkpoints.get(key);
            for (let i = 0; i < reference.length; i++) fpsError = Math.max(fpsError, Math.abs(reference[i] - creature.bellPos[i]));
          }
        }
        previous.set(creature.bellPos);
      }
      report({ name: 'drifter/full-loop', route, fps, frames, maxSpeed, contacts, crossedWalls, fpsError });
      creature.dispose();
      assert.equal(contacts + crossedWalls, 0, 'drifter crossed or entered terrain');
      assert.ok(maxSpeed < 3, 'drifter corner causes a sudden position jump');
      assert.ok(fpsError < 0.001, 'drifter route depends on frame rate');
    }
  }
}

async function model(name) {
  const file = await fs.readFile(new URL(`../public/models/${name}.glb`, import.meta.url));
  const size = file.readUInt32LE(12), json = JSON.parse(file.toString('utf8', 20, 20 + size));
  json.buffers[0].uri = `data:application/octet-stream;base64,${file.subarray(28 + size).toString('base64')}`;
  // Retain geometry, weights and bones; only texture decoding requires browser APIs.
  json.images = []; json.textures = []; json.materials = (json.materials || []).map(() => ({}));
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
  let mesh;
  gltf.scene.traverse((node) => { if (node.isMesh) mesh = node; });
  return { scene: gltf.scene, mesh };
}

async function leviathans() {
  globalThis.ProgressEvent ??= class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  player.frozen = false;
  camera.position.copy(player.pos);
  for (const variant of ['rigged', 'model', 'sculpted']) {
    const checkpoints = new Map();
    for (const fps of [30, 60, 144]) {
      const loaded = variant === 'sculpted' ? null : await model(variant === 'rigged' ? 'leviathan_rig' : 'leviathan');
      const creature = new Leviathan({ ...options, ...(variant === 'rigged' ? { rigged: loaded } : variant === 'model'
        ? { model: { geometry: loaded.mesh.geometry, material: loaded.mesh.material } } : {}) });
      const dt = 1 / fps;
      creature.wait = 0;
      creature.update(dt, dt, context);
      assert.ok(creature.active && creature.group.visible, 'natural pass did not start');
      assert.ok(creature.headPos.y < ABYSS_WALL_BOTTOM, 'newly visible leviathan still uses its unposed origin');
      const previous = creature.headPos.clone();
      const point = new THREE.Vector3();
      let maxSpeed = 0, fpsError = 0, vertices = 0, maxY = -Infinity, passes = 0, frame = 1;
      while (creature.active && frame < fps * 60) {
        frame++;
        creature.update(dt, frame * dt, context);
        assert.ok(Number.isFinite(creature.headPos.lengthSq()), 'non-finite leviathan head');
        maxSpeed = Math.max(maxSpeed, previous.distanceTo(creature.headPos) / dt);
        previous.copy(creature.headPos);
        passes += creature.events.filter((event) => event.type === 'pass').length;
        if (frame % fps === 0) {
          const key = frame / fps;
          const sample = [...creature.headPos.toArray(), ...creature.chain.p];
          if (fps === 30) checkpoints.set(key, sample);
          else if (checkpoints.has(key)) fpsError = Math.max(fpsError, ...sample.map((v, i) => Math.abs(v - checkpoints.get(key)[i])));
          const mesh = creature.rig?.mesh || creature.headMesh;
          if (mesh) {
            scene.updateMatrixWorld(true);
            if (mesh.isSkinnedMesh) mesh.skeleton.update();
            for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
              mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
              assert.ok(Number.isFinite(point.lengthSq()), 'non-finite animated model vertex');
              maxY = Math.max(maxY, point.y); vertices++;
            }
          }
        }
      }
      let entrySpeed = 0;
      for (const endpoint of [0, creature.len]) {
        const a = creature._path(endpoint - 0.0001, []), b = creature._path(endpoint + 0.0001, []);
        entrySpeed = Math.max(entrySpeed, Math.abs(b[1] - a[1]) / 0.0002 * 8);
      }
      report({ name: 'leviathan/full-pass', variant, fps, frame, maxSpeed, entrySpeed, fpsError, vertices, maxY, passes });
      assert.ok(!creature.active && !creature.group.visible && creature.lamp.intensity === 0, 'leviathan did not leave cleanly');
      assert.ok(passes <= 1, 'duplicate close-pass event');
      assert.ok(entrySpeed < 0.01, 'pass curve does not join its entry/exit smoothly');
      assert.ok(maxSpeed < 12, 'leviathan pose jumps along the pass');
      if (vertices) assert.ok(maxY < ABYSS_WALL_BOTTOM, 'animated model rose into the abyss walls');
      assert.ok(fpsError < 0.001, 'pass route depends on frame rate');
      creature.wait = 0;
      creature.update(dt, 60, context);
      assert.ok(creature.headPos.distanceTo(previous) > 30, 'second pass exposed the previous departure pose');
      creature.dispose();
    }
  }
}

async function main() {
  if (!only || only === 'drifter') drifters();
  if (!only || only === 'leviathan') await leviathans();
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
