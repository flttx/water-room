// Ambushers must visibly scull inside their lairs, with their real collision guards enabled.
// Run: node tools/ambush-idle-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Level } from '../src/level/level.js';
import { Lurkers } from '../src/creatures/lurker.js';
import { Angler } from '../src/creatures/angler.js';

globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init) { this.type = type; Object.assign(this, init); }
};
const noop = () => {};
const voice = { setPosition: noop, setState: noop, setSpeed: noop, update: noop, dispose: noop };
const level = new Level();
const options = {
  level, scene: new THREE.Scene(), lampSys: { add: (lamp) => lamp },
  audio: { createCreatureVoice: () => voice, lurkerSnap: noop, splash: noop },
  water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [],
};
const player = { pos: new THREE.Vector3(), frozen: true, shake: 0, inWater: true, underwater: true, speed: 0 };
const camera = { position: player.pos };

async function anglerModel() {
  const file = await fs.readFile(new URL('../public/models/angler.glb', import.meta.url));
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
  const manager = new Lurkers(options);
  const angler = new Angler({ ...options, model: await anglerModel() });
  try {
    for (const fps of [30, 60]) {
      const results = [];
      for (const creature of [...manager.list.filter((fish) => !fish.patrol), angler]) {
        creature.reset();
        player.pos.copy(creature.home).add(new THREE.Vector3(0, 0, 20));
        const rigged = creature === angler;
        const root = rigged ? creature.rig.root : creature.root;
        const box = new THREE.Box3(), tailBox = new THREE.Box3();
        const tip = new THREE.Vector3(), previous = root.position.clone();
        let maxStep = 0, still = 0, longestStop = 0, finMotion = 0;
        let finStart;
        for (let frame = 0; frame < 24 * fps; frame++) {
          const t = frame / fps;
          if (rigged) creature.update(1 / fps, t, { player });
          else creature.update(1 / fps, t, player, camera, true);
          assert.ok(rigged ? creature.surface.clear(level) : creature._bodyClear(), 'idle body crossed terrain');
          assert.equal(creature.state, rigged ? 'idle' : 'wait');
          const step = root.position.distanceTo(previous);
          previous.copy(root.position);
          if (t < 2) continue;
          maxStep = Math.max(maxStep, step);
          still = step < 0.001 / fps ? still + 1 / fps : 0;
          longestStop = Math.max(longestStop, still);
          box.expandByPoint(root.position);
          if (rigged) {
            const fin = creature.rig.nodes[creature.finR[0]].quaternion;
            finStart ??= fin.clone();
            finMotion = Math.max(finMotion, finStart.angleTo(fin));
          } else {
            creature.tail.tip(tip);
            tip.sub(root.position);
            tailBox.expandByPoint(tip);
          }
        }
        const span = box.getSize(new THREE.Vector3());
        const horizontal = Math.hypot(span.x, span.z);
        const name = rigged ? 'angler' : `lurker ${creature.k}`;
        assert.ok(horizontal > 0.15, `${name}: no visible swimming (${horizontal.toFixed(3)} m)`);
        assert.ok(longestStop < 4, `${name}: body froze for ${longestStop.toFixed(2)} s`);
        assert.ok(maxStep * fps < 1, `${name}: idle position snapped ${(maxStep * fps).toFixed(3)} m/s`);
        if (rigged) assert.ok(finMotion > 0.1, 'angler: posed pectoral fin froze');
        else assert.ok(tailBox.getSize(tip).length() > 0.05, `${name}: posed tail froze`);
        results.push({ name, horizontal: +horizontal.toFixed(3), longestStop: +longestStop.toFixed(2) });
        if (rigged) {
          // Trigger from an already drifting pose, rather than only testing a fresh reset.
          player.frozen = false;
          player.pos.copy(creature.mouth).add(new THREE.Vector3(2, 1, -3));
          const states = new Set();
          let strikeDistance = 0;
          for (let frame = 0; frame < 40 * fps; frame++) {
            if (frame === 2 * fps) player.frozen = true;
            creature.update(1 / fps, 24 + frame / fps, { player });
            states.add(creature.state);
            strikeDistance = Math.max(strikeDistance, creature.off.length());
            assert.ok(creature.surface.clear(level), 'angler: drift-to-strike pose crossed terrain');
          }
          assert.ok(['tense', 'lunge', 'recover', 'dark', 'idle'].every((state) => states.has(state)),
            'angler: attack from the idle swim did not complete');
          assert.ok(strikeDistance > 1 && creature.off.length() < 0.05,
            'angler: attack from the idle swim did not return to the lair');
        }
      }
      process.stdout.write(`${JSON.stringify({ fps, results })}\n`);
    }
    process.stdout.write('PASS ambusher idle swimming, appendages, continuity and body safety at 30/60 FPS\n');
  } finally {
    manager.dispose();
    angler.dispose();
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

