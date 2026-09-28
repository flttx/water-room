// Motion regressions for every lure-fish, including wall contact, turns and attack recovery.
// Run: node tools/lurker-motion-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Level } from '../src/level/level.js';
import { Lurkers } from '../src/creatures/lurker.js';
import { sphereClear } from '../src/creatures/collision.js';

const noop = () => {};
const voice = { setPosition: noop, setState: noop, setSpeed: noop, update: noop, dispose: noop };
const level = new Level();
const manager = new Lurkers({
  level, scene: new THREE.Scene(), lampSys: { add: (lamp) => lamp },
  audio: { createCreatureVoice: () => voice, lurkerSnap: noop, splash: noop },
  water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [],
});
// Freeze contact with the fixture only; the fish still execute the complete strike and return.
// Player survival and natural triggering are covered by lurker-patrol-check and shortcut-check.
const player = { pos: new THREE.Vector3(), frozen: true, shake: 0 };
const camera = { position: player.pos }, attachment = new THREE.Vector3();
let maxIdleSpeed = 0, maxStrikeSpeed = 0, maxGap = 0;
try {
  for (const steps of [[1 / 60], [1 / 120, 1 / 30, 1 / 60]]) {
    for (const fish of manager.list) {
      fish.reset();
      player.pos.copy(fish.home).add(new THREE.Vector3(0, 0, 12));
      const tail = fish.tail, previous = tail.p.slice();
      let t = 0, struck = false;
      const states = new Set();
      for (let frame = 0; t < 45; frame++) {
        const dt = steps[frame % steps.length];
        if (t >= 35 && !struck) {
          player.pos.copy(fish.maw).add(new THREE.Vector3(Math.sin(fish.yaw) * 3, 0, Math.cos(fish.yaw) * 3));
          fish._strike(player);
          struck = true;
        }
        const previousState = fish.state;
        fish.update(dt, t, player, camera, true);
        t += dt;
        states.add(fish.state);
        assert.ok(fish._bodyClear(), `lurker ${fish.k}: body crossed terrain`);
        if (t > 1) {
          attachment.copy(fish.tailLocal).applyMatrix4(fish.headMesh.matrixWorld);
          const gap = Math.hypot(tail.p[0] - attachment.x, tail.p[1] - attachment.y, tail.p[2] - attachment.z);
          maxGap = Math.max(maxGap, gap);
          assert.ok(gap < 0.05, `lurker ${fish.k}: tail detached ${gap.toFixed(3)} m`);
          const attacking = previousState === 'suck' || previousState === 'surge';
          for (let i = 3; i < tail.p.length; i += 3) {
            const speed = Math.hypot(tail.p[i] - previous[i], tail.p[i + 1] - previous[i + 1], tail.p[i + 2] - previous[i + 2]) / dt;
            assert.ok(Number.isFinite(speed));
            if (attacking) maxStrikeSpeed = Math.max(maxStrikeSpeed, speed);
            else maxIdleSpeed = Math.max(maxIdleSpeed, speed);
            // Idle wall contact must not produce the former half-metre single-frame snap.
            assert.ok(speed < (attacking ? 32 : 15), `lurker ${fish.k}: tail snapped at ${speed.toFixed(2)} m/s`);
          }
        }
        previous.set(tail.p);
        if (frame % 30 === 0) for (let i = 1; i < tail.n; i++) {
          const a = (i - 1) * 3, b = i * 3;
          for (let k = 0; k <= 4; k++) {
            const u = k / 4, radius = tail.r[i - 1] * (1 - u) + tail.r[i] * u;
            assert.ok(sphereClear(level, tail.p[a] * (1 - u) + tail.p[b] * u,
              tail.p[a + 1] * (1 - u) + tail.p[b + 1] * u, tail.p[a + 2] * (1 - u) + tail.p[b + 2] * u, radius),
            `lurker ${fish.k}: smoothing moved the tail through terrain`);
          }
        }
      }
      assert.ok(states.has('surge') && states.has('return') && fish.state === 'wait');
    }
  }
  const patrol = manager.list[3];
  patrol.reset();
  for (let frame = 0; frame < 840; frame++) patrol.update(1 / 60, frame / 60, player, camera, frame < 60);
  patrol.update(1 / 60, 14, player, camera, true);
  attachment.copy(patrol.tailLocal).applyMatrix4(patrol.headMesh.matrixWorld);
  assert.ok(attachment.distanceTo(new THREE.Vector3().fromArray(patrol.tail.p)) < 0.01,
    'returning to a distant patrol displayed its tail at the previous visible location');
  process.stdout.write(`PASS all 8 lure-fish at fixed and changing frame rates, including visibility re-entry; max idle/strike tail speed ${maxIdleSpeed.toFixed(2)}/${maxStrikeSpeed.toFixed(2)} m/s, attachment gap ${maxGap.toFixed(3)} m\n`);
} finally { manager.dispose(); }
