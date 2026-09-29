// The carcass must visibly drift beside the catwalk, including reversal, pursuit and respawn.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Level } from '../src/level/level.js';
import { Whale } from '../src/creatures/whale.js';

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
  const level = new Level();
  const player = { pos: new THREE.Vector3(263, 2.6, 80), vel: new THREE.Vector3(),
    frozen: false, inWater: false, shake: 0 };
  for (const fps of [30, 60]) {
    const c = new Whale({ scene: new THREE.Scene(), level, lampSys: { add: (o) => o }, audio,
      water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, model: await model('whale') });
    try {
      const previous = c.head.clone(), tail = new THREE.Vector3(), previousTail = new THREE.Vector3();
      // A real tail skin vertex, carried by the same matrices used for collision and rendering.
      const sample = c.surface.samples.reduce((a, b) => a.xyz[2] < b.xyz[2] ? a : b);
      const weighted = new THREE.Vector3();
      const tailAt = () => {
        c.surface.prepare(); tail.set(0, 0, 0);
        for (let k = 0; k < 4; k++) if (sample.weights[k]) {
          weighted.set(...sample.xyz).applyMatrix4(c.surface.matrices[sample.bones[k]]);
          tail.addScaledVector(weighted, sample.weights[k]);
        }
        return tail;
      };
      previousTail.copy(tailAt());
      let headTravel = 0, tailTravel = 0, maxStep = 0, maxTailStep = 0, windows = 0;
      for (let frame = 0; frame < fps * 120; frame++) {
        if (frame === fps * 55) c.reset(false);
        c.update(1 / fps, frame / fps, { player });
        const step = c.head.distanceTo(previous), tailStep = tailAt().distanceTo(previousTail);
        maxStep = Math.max(maxStep, step); maxTailStep = Math.max(maxTailStep, tailStep);
        headTravel += step; tailTravel += tailStep; previous.copy(c.head); previousTail.copy(tail);
        assert.ok(c.surface.clear(level), `whale/${fps}: skin intersects terrain`);
        assert.equal(c.group.visible, true, `whale/${fps}: hidden from nearby catwalk`);
        if ((frame + 1) % (fps * 10) === 0) {
          assert.ok(headTravel > 0.5, `whale/${fps}: ten-second head motion stopped`);
          assert.ok(tailTravel > 0.5, `whale/${fps}: ten-second tail animation stopped`);
          headTravel = 0; tailTravel = 0; windows++;
        }
      }
      assert.ok(maxStep < 0.1 && maxTailStep < 0.25, `whale/${fps}: patrol or reset jumped`);
      c.reset(); player.pos.set(262, -4, 82); player.inWater = true; player.frozen = false;
      let heard = false, caught = false;
      c.onCatch = () => { caught = true; player.frozen = true; };
      for (let frame = 0; frame < fps * 30; frame++) {
        if (frame % fps === 0 && !caught) c.hear(player.pos.x, player.pos.y, player.pos.z, 30, true);
        c.update(1 / fps, 120 + frame / fps, { player });
        heard ||= c.state === 'suspicious' || c.chasing;
        assert.ok(c.surface.clear(level), `whale/${fps}: pursuit skin intersects terrain`);
      }
      assert.ok(heard && caught, `whale/${fps}: a reachable noisy swimmer was not caught`);
      player.pos.set(263, 2.6, 80); player.inWater = false; player.frozen = false;
      process.stdout.write(`${JSON.stringify({ fps, windows, maxStep, maxTailStep, heard, caught })}\n`);
    } finally { c.dispose(); }
  }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
