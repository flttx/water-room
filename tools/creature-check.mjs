// Regression checks for creature motion and collision, without a renderer or audio device.
// Run with: node tools/creature-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Chain, collideChain } from '../src/creatures/flesh.js';
import { Colossus } from '../src/creatures/colossus.js';
import { Hunter } from '../src/creatures/hunter.js';
import { sphereClear, sphereTravel } from '../src/creatures/collision.js';
import { Level } from '../src/level/level.js';

const noop = () => {};
const voice = new Proxy({}, { get: () => noop });
const audio = new Proxy({ createCreatureVoice: () => voice }, { get: (o, k) => o[k] || noop });

// Moving a pose and restoring its segment lengths must not launch it on the next frame.
const posed = new Chain(8, 7, 0.15, 0.05);
posed.reset(0, 0, 0, 0, 0, 1);
posed.pull(4, 3, 2, 4, 0.4);
posed.constrain(0, 0, 0, 0, 0, 1);
const pose = posed.p.slice();
posed.integrate(1 / 60, 0.9, 0, 0, 0);
assert.ok(posed.p.every((v, i) => Math.abs(v - pose[i]) < 1e-5), 'pose correction became a velocity impulse');

// Water beside a raised platform: entering its side must not send a submerged limb upward.
const ledge = {
  solid: () => false,
  floor: (x) => x < 1 ? -90 : 0.6,
  ceil: () => 30,
};
const chain = new Chain(8, 7, 0.15, 0.05);
chain.reset(1.8, -30, 1, 0, 0, 1);
for (let i = 3; i < chain.p.length; i += 3) chain.p[i] = chain.o[i] = 2.1;
chain.integrate(1 / 60, 0.9, 0, 0, 0);
chain.constrain(1.8, -30, 1, 0, 0, 1);
collideChain(ledge, chain);
assert.ok([...chain.p].every(Number.isFinite));
for (let i = 3; i < chain.p.length; i += 3) {
  assert.ok(Math.abs(chain.p[i + 1] + 30) < 0.1, 'deck contact teleported a submerged limb vertically');
  assert.ok(chain.p[i] < 2, 'limb remained inside the platform side');
}

function checkColossus(label, steps) {
  const level = new Level();
  const creature = new Colossus({
    scene: new THREE.Scene(), level, lampSys: { add: (o) => o }, audio,
    water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [],
  });
  const player = { pos: new THREE.Vector3(103, 1, 44), frozen: true, shake: 0, tileX: 51, tileZ: 22 };
  const ctx = { player, camera: { position: player.pos } };
  creature._wake(false);
  const chains = [...creature.arms, ...creature.feelers, ...creature.beard].map((a) => a.chain);
  const previous = chains.map((c) => c.p.slice());
  let t = 0, frame = 0, maxStep = 0, maxSpeed = 0, settledSpeed = 0, maxStretch = 0, attachmentGap = 0;
  const anchor = new THREE.Vector3(), root = new THREE.Vector3();
  while (t < 60) {
    const dt = steps[frame++ % steps.length];
    t += dt;
    creature.update(dt, t, ctx);
    for (const a of creature.arms) {
      anchor.copy(a.rootLocal).applyMatrix4(creature.root.matrixWorld);
      attachmentGap = Math.max(attachmentGap, anchor.distanceTo(root.fromArray(a.chain.p)));
    }
    for (const a of [...creature.feelers, ...creature.beard]) {
      creature._headPoint(a.rootLocal, a.w, anchor);
      attachmentGap = Math.max(attachmentGap, anchor.distanceTo(root.fromArray(a.chain.p)));
    }
    chains.forEach((c, ci) => {
      assert.ok([...c.p].every(Number.isFinite), 'limb contains an invalid position');
      for (let b = 3; b < c.p.length; b += 3) {
        const length = Math.hypot(c.p[b] - c.p[b - 3], c.p[b + 1] - c.p[b - 2], c.p[b + 2] - c.p[b - 1]);
        maxStretch = Math.max(maxStretch, length / c.seg);
        if (t > 3) {
          const step = Math.hypot(c.p[b] - previous[ci][b], c.p[b + 1] - previous[ci][b + 1], c.p[b + 2] - previous[ci][b + 2]);
          maxStep = Math.max(maxStep, step);
          maxSpeed = Math.max(maxSpeed, step / dt);
          if (t > 12 && creature.state === 'watch') settledSpeed = Math.max(settledSpeed, step / dt);
        }
      }
      previous[ci].set(c.p);
    });
  }
  creature.dispose();
  console.log(`${label}: max frame displacement ${maxStep.toFixed(3)} m; max segment stretch ${maxStretch.toFixed(5)}x`);
  console.log(`peak speed ${maxSpeed.toFixed(3)} m/s; idle peak ${settledSpeed.toFixed(3)} m/s`);
  console.log(`maximum attachment gap ${attachmentGap.toFixed(3)} m`);
  assert.ok(attachmentGap < 0.3, `${label}: limb detached from the body`);
  assert.ok(maxStretch < 1.001, `${label}: collisions stretched the limb`);
  assert.ok(maxSpeed < 120, `${label}: limb jumped between frames`);
  assert.ok(settledSpeed < 30, `${label}: idle limbs jerked after surfacing`);
}

const wall = { solid: (x) => x === 1, floor: () => -10, ceil: () => 10 };
assert.equal(sphereClear(wall, 1.8, -3, 1, 0.3), false, 'skin crossed the wall while its center was outside');
assert.equal(sphereClear(wall, 1.6, -3, 1, 0.3), true);
const travel = sphereTravel(wall, 1, -3, 1, 5, -3, 1, 0.3);
assert.ok(travel > 0 && 1 + 4 * travel < 1.7, 'fast movement tunneled through the wall');
const slab = { solid: () => false, floor: () => -10, ceil: () => 10, deckTop: () => 1 };
assert.ok(sphereTravel(slab, 1, -2, 1, 1, 3, 1, 0.1) < 0.52, 'movement passed through the catwalk slab');

function checkSpans(c, level) {
  const p = c.p;
  for (let i = 1; i < c.n; i++) {
    const b = i * 3, a = b - 3;
    for (let j = 0; j <= 12; j++) {
      const k = j / 12;
      assert.ok(sphereClear(level,
        p[a] + (p[b] - p[a]) * k, p[a + 1] + (p[b + 1] - p[a + 1]) * k, p[a + 2] + (p[b + 2] - p[a + 2]) * k,
        c.r[i - 1] + (c.r[i] - c.r[i - 1]) * k), 'limb skin or a span crossed terrain');
    }
  }
}

// Both endpoints can be outside a pillar while the span between them cuts its corner.
const pillar = { ...wall, solid: (x, z) => x === 1 && z === 1 };
const corner = new Chain(2, Math.sqrt(8), 0.2, 0.1);
corner.reset(1, -3, 3, Math.SQRT1_2, 0, -Math.SQRT1_2);
collideChain(pillar, corner, true);
checkSpans(corner, pillar);
const thick = new Chain(12, 8, 0.4, 0.05);
thick.reset(0.8, -3, 1, 1, 0, 0);
collideChain(wall, thick, true);
checkSpans(thick, wall);
thick.frames(0, 1, 0);
for (let i = 0; i < thick.n; i++) assert.ok(Math.abs(Math.hypot(...thick.nrm.slice(i * 3, i * 3 + 3)) - 1) < 1e-5, 'folded limbs lost their surface frame');

function checkHunter() {
  const level = new Level();
  const hunter = new Hunter({
    scene: new THREE.Scene(), level, lampSys: { add: (o) => o }, audio, seed: 1,
    water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [],
  });
  const player = { pos: new THREE.Vector3(105, 2.2, 113), frozen: true, shake: 0, inWater: false, tileX: 52, tileZ: 56 };
  assert.equal(hunter.spawn(38 * level.W + 44, null), true);
  const vertex = new THREE.Vector3();
  const checkBody = () => {
    // Check actual rendered vertices independently of the collision proxies.
    for (const mesh of [hunter.headMesh, hunter.mantleMesh]) {
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        vertex.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        assert.equal(level.blockedAt(vertex.x, vertex.y, vertex.z), false, 'monster mesh entered terrain');
      }
    }
  };
  let distance = 0, t = 0, maxLimbSpeed = 0;
  const previousLimbs = hunter.limbs.map((limb) => limb.chain.p.slice());
  const steps = [1 / 60, 1 / 30, 1 / 120];
  for (let i = 0; t < 30; i++) {
    const dt = steps[i % steps.length], x = hunter.x, z = hunter.z;
    t += dt;
    hunter.update(dt, t, { player, camera: { position: player.pos } });
    distance += Math.hypot(hunter.x - x, hunter.z - z);
    assert.ok(hunter._poseClear(), 'monster body or limb root entered terrain');
    hunter.limbs.forEach((limb, li) => {
      const p = limb.chain.p, prev = previousLimbs[li];
      if (i > 2) {
        for (let b = 3; b < p.length; b += 3) maxLimbSpeed = Math.max(maxLimbSpeed, Math.hypot(p[b] - prev[b], p[b + 1] - prev[b + 1], p[b + 2] - prev[b + 2]) / dt);
      }
      prev.set(p);
    });
    if (i % 15 === 0) {
      checkBody();
      for (const limb of hunter.limbs) checkSpans(limb.chain, level);
    }
  }
  assert.ok(distance > 10, 'collision handling stopped normal patrol movement');
  assert.ok(maxLimbSpeed < 60, 'wall contact made the hunter limbs snap');
  // A large movement through a wall must stop on the near side, even if the destination is clear.
  hunter.x += 30;
  hunter.yaw += Math.PI;
  hunter._moveBody(t + 0.05);
  checkBody();
  assert.ok(hunter._poseClear(), 'fast movement or turning bypassed the body collider');
  // Spawn rejection must not leave an active monster embedded in a wall.
  assert.equal(hunter.spawn(0, null), false);
  assert.equal(hunter.active, false);
  hunter.dispose();
  console.log(`Hunter collision checks passed; patrolled ${distance.toFixed(1)} m.`);
}

checkHunter();
checkColossus('60 fps', [1 / 60]);
checkColossus('30 fps', [1 / 30]);
checkColossus('changing frame rate', [1 / 120, 1 / 30, 1 / 60, 1 / 20]);
console.log('Creature animation checks passed.');
