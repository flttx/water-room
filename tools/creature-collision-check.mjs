// Real model collision audit without WebGL, texture decoding or audio.
// Run: node tools/creature-collision-check.mjs [--strict]
// --strict returns a failing exit status for geometry or attack regressions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Level, DECK_BOTTOM, DECK_TOP, ABYSS_WALL_BOTTOM } from '../src/level/level.js';
import { Angler } from '../src/creatures/angler.js';
import { Whale } from '../src/creatures/whale.js';
import { SpiderCrab } from '../src/creatures/spidercrab.js';
import { Lurkers } from '../src/creatures/lurker.js';
import { Drifter } from '../src/creatures/drifter.js';
import { Colossus } from '../src/creatures/colossus.js';
import { Leviathan } from '../src/creatures/leviathan.js';

const noop = () => {};
globalThis.ProgressEvent ??= class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const voice = new Proxy({}, { get: () => noop });
const audio = new Proxy({ createCreatureVoice: () => voice }, { get: (o, k) => o[k] || noop });
const level = new Level();
const opts = { scene: new THREE.Scene(), level, lampSys: { add: (o) => o }, audio,
  water: { addRipple: noop }, fx: { bubbles: { spawn: noop } }, lightGrid: [] };

async function model(name) {
  const file = await fs.readFile(new URL(`../public/models/${name}.glb`, import.meta.url));
  const size = file.readUInt32LE(12);
  const json = JSON.parse(file.toString('utf8', 20, 20 + size));
  const bin = file.subarray(28 + size);
  // Only texture decoding needs browser APIs; geometry, skin weights and bones stay intact.
  json.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
  json.images = []; json.textures = [];
  json.materials = (json.materials || []).map(() => ({}));
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
  let mesh;
  gltf.scene.traverse((o) => { if (o.isMesh) mesh = o; });
  return { scene: gltf.scene, mesh };
}

const point = new THREE.Vector3();
const reports = [];
function contact(p, abyss = false) {
  // Abyss walls end at -18 m in builder.js; the space beneath them is intentionally open.
  if (abyss && p.y < ABYSS_WALL_BOTTOM - 0.04) return null;
  const tx = Math.floor(p.x / 2), tz = Math.floor(p.z / 2);
  if (level.solid(tx, tz)) return 'wall';
  if (p.y < level.floor(tx, tz) - 0.04) return 'floor';
  if (p.y > level.ceil(tx, tz) + 0.04) return 'ceiling';
  if (level.deckTop(tx, tz) != null && p.y > DECK_BOTTOM + 0.01 && p.y < DECK_TOP - 0.01) return 'catwalk';
  return null;
}
function tally() { return { points: 0, blocked: 0, kinds: {}, examples: [], minY: Infinity, maxY: -Infinity }; }
function sample(out, p, abyss = false) {
  assert.ok(Number.isFinite(p.x + p.y + p.z), 'invalid animated vertex');
  out.points++;
  out.minY = Math.min(out.minY, p.y); out.maxY = Math.max(out.maxY, p.y);
  const kind = contact(p, abyss);
  if (!kind) return;
  out.blocked++;
  out.kinds[kind] = (out.kinds[kind] || 0) + 1;
  if (out.examples.length < 3) out.examples.push({ kind, at: p.toArray().map((v) => +v.toFixed(3)) });
}
function record(name, results) {
  const peak = results.reduce((best, r) => r.blocked > best.blocked ? r : best, results[0]);
  const kinds = {};
  for (const r of results) for (const [kind, n] of Object.entries(r.kinds)) kinds[kind] = (kinds[kind] || 0) + n;
  const report = { name, samples: results.length, blockedSamples: results.filter((r) => r.blocked).length,
    kinds, peak, maxY: Math.max(...results.map((r) => r.maxY)) };
  reports.push(report);
  console.log(JSON.stringify(report));
}
function meshContacts(mesh, abyss = false, deform = null) {
  opts.scene.updateMatrixWorld(true);
  if (mesh.isSkinnedMesh) mesh.skeleton.update();
  const out = tally();
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    mesh.getVertexPosition(i, point);
    if (deform) deform(point, i);
    point.applyMatrix4(mesh.matrixWorld);
    sample(out, point, abyss);
  }
  return out;
}

// Mirror the tube vertex shader's Catmull-Rom curve, frame, taper and flattened underside.
const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
function tubeContacts(bundle, abyss = false) {
  const out = tally(), pos = bundle.mesh.geometry.attributes.position, tent = bundle.mesh.geometry.attributes.tent;
  const n = bundle.TN, data = bundle.data;
  for (let v = 0; v < pos.count; v++) {
    const tt = pos.getY(v), s = tt * (n - 1), i = Math.min(Math.floor(s), n - 2), f = s - i;
    const row = Math.round(tent.getX(v)) * 2 * n * 4;
    let radius = 0;
    for (let k = 0; k < 4; k++) {
      const p0 = data[row + Math.max(i - 1, 0) * 4 + k], p1 = data[row + i * 4 + k];
      const p2 = data[row + (i + 1) * 4 + k], p3 = data[row + Math.min(i + 2, n - 1) * 4 + k];
      const a = 2 * p0 - 5 * p1 + 4 * p2 - p3, b = -p0 + 3 * p1 - 3 * p2 + p3;
      const value = 0.5 * (2 * p1 + (p2 - p0) * f + a * f * f + b * f ** 3);
      if (k === 3) radius = value;
      else {
        C.setComponent(k, value);
        T.setComponent(k, 0.5 * (p2 - p0 + 2 * a * f + 3 * b * f * f));
        const aN = row + n * 4 + i * 4 + k;
        N.setComponent(k, data[aN] + (data[aN + 4] - data[aN]) * f);
      }
    }
    T.y += 1e-5; T.normalize();
    N.addScaledVector(T, -N.dot(T)); N.x += 1e-5; N.normalize();
    B.crossVectors(T, N);
    radius = Math.max(0, radius) * Math.sqrt(Math.max(0, 1 - (Math.max(tt - 0.955, 0) / 0.045) ** 2));
    const ca = pos.getX(v), sa = pos.getZ(v);
    point.copy(C).addScaledVector(B, ca * radius).addScaledVector(N, sa * (sa < 0 ? 0.72 : 1) * radius);
    sample(out, point, abyss);
  }
  return out;
}

const player = { pos: new THREE.Vector3(262, -2, 78), vel: new THREE.Vector3(), frozen: true,
  shake: 0, inWater: true, underwater: true, speed: 0, crouch: false, flashlight: false, breath: 30,
  get tileX() { return Math.floor(this.pos.x / 2); }, get tileZ() { return Math.floor(this.pos.z / 2); } };
const ctx = { player, camera: { position: player.pos } };
const residents = {};
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
for (const [name, Kind] of [['angler', Angler], ['whale', Whale], ['crab', SpiderCrab]]) {
  if (only && name !== only) continue;
  player.pos.set(262, -2, 78); player.frozen = true;
  const c = new Kind({ ...opts, model: await model(name) });
  residents[name] = c;
  const results = [];
  const previousPosition = (c.head?.isVector3 ? c.head : c.hub || c.rig.root.position).clone();
  let distance = 0;
  for (let frame = 0; frame < 1800; frame++) {
    const t = frame / 30;
    c.update(1 / 30, t, ctx);
    const at = c.head?.isVector3 ? c.head : c.hub || c.rig.root.position;
    distance += at.distanceTo(previousPosition); previousPosition.copy(at);
    if (frame % 15) continue;
    const result = meshContacts(c.rig.mesh);
    results.push({ t, ...result });
  }
  record(name + '/idle-patrol', results);
  console.log(JSON.stringify({ name, distance, state: c.state }));
  if (name !== 'angler') assert.ok(distance > 10, `${name}: collision response stopped patrol movement`);
  // Exercise the actual animated attack poses with the loaded skin, not only contact predicates.
  player.frozen = false;
  if (name === 'angler') {
    player.pos.copy(c.mouth).add(new THREE.Vector3(Math.sin(c.homeYaw) * 5, 1, Math.cos(c.homeYaw) * 5));
    c._aim(player.pos); c._setState('lunge');
  } else if (name === 'whale') {
    player.pos.copy(c.head).add(new THREE.Vector3(Math.sin(c.yaw) * 6, 0, Math.cos(c.yaw) * 6));
    c.focus.copy(player.pos); c._setState('hunt');
  } else {
    player.pos.copy(c.foreTip[0]).setY(-1);
    c.state = 'chase'; c.seenT = 0;
    Object.assign(c._stab, { s: 0, phase: 'wind', t: 0, done: false });
    c._stab.aim.copy(player.pos); c.stab = c._stab;
  }
  const strikes = [];
  for (let frame = 0; frame < 240; frame++) {
    c.update(1 / 60, 60 + frame / 60, ctx);
    if (frame % 4 === 0) strikes.push({ t: frame / 60, ...meshContacts(c.rig.mesh) });
  }
  record(name + '/attack', strikes);
  c.reset(false);
}
if (only && residents[only]) process.exit(reports.some((r) => r.blockedSamples) ? 1 : 0);

const lurkers = new Lurkers(opts);
player.frozen = true;
for (const c of only ? [] : lurkers.list) {
  const heads = [], limbs = [];
  player.pos.copy(c.home).add(new THREE.Vector3(0, 0, 5));
  for (let frame = 0; frame < 450; frame++) {
    c.update(1 / 30, frame / 30, player, ctx.camera, true);
    if (frame % 15) continue;
    heads.push({ t: frame / 30, ...meshContacts(c.headMesh) });
    limbs.push({ t: frame / 30, part: 'tail', ...tubeContacts(c.tailBundle) });
    limbs.push({ t: frame / 30, part: 'lure-fringe', ...tubeContacts(c.fringeBundle) });
  }
  record(`lurker-${c.k}/head`, heads);
  record(`lurker-${c.k}/limbs`, limbs);
  player.frozen = false;
  player.pos.copy(c.maw).add(new THREE.Vector3(Math.sin(c.yaw) * 2, 0, Math.cos(c.yaw) * 2));
  c._strike(player);
  const strikes = [];
  for (let frame = 0; frame < 240; frame++) {
    c.update(1 / 60, 15 + frame / 60, player, ctx.camera, true);
    if (frame % 4 === 0) {
      strikes.push(meshContacts(c.headMesh), tubeContacts(c.tailBundle), tubeContacts(c.fringeBundle));
    }
  }
  record(`lurker-${c.k}/attack`, strikes);
  player.frozen = true;
}

for (let route = only ? level.reservoir.jellies.length : -1; route < level.reservoir.jellies.length; route++) {
  const c = new Drifter(opts, route < 0 ? {} : { route: level.reservoir.jellies[route],
    seed: 900 + route, bells: 20, scale: 1.5, speed: 0.7, lethal: true, source: 'siphonophore' });
  const results = [], m = new THREE.Matrix4();
  for (let i = 0; i < 320; i++) {
    c.s = c.loop.total * i / 320;
    const xy = c._sample(c.s, [0, 0, 0, 0]);
    player.pos.set(xy[0], -2, xy[1]);
    c.update(1 / 30, i / 2, ctx);
    assert.ok(c.group.visible);
    const out = tally();
    for (let bell = 0; bell < c.n; bell++) {
      c.bells.getMatrixAt(bell, m);
      for (let v = 0; v < c.bellGeo.attributes.position.count; v++) {
        point.fromBufferAttribute(c.bellGeo.attributes.position, v).applyMatrix4(m);
        sample(out, point);
      }
    }
    const lines = c.linePos.array;
    for (let v = 0; v < lines.length; v += 6) {
      const a = new THREE.Vector3().fromArray(lines, v), b = new THREE.Vector3().fromArray(lines, v + 3);
      const steps = Math.max(1, Math.ceil(a.distanceTo(b) / 0.12));
      for (let j = 0; j <= steps; j++) sample(out, point.lerpVectors(a, b, j / steps));
    }
    results.push({ routeFraction: i / 320, ...out });
  }
  record(`drifter-${route < 0 ? 'canal' : 'dome-' + route}/full-route`, results);
  c.dispose();
}

const loaded = await model('colossus');
const colossus = new Colossus({ ...opts, model: { geometry: loaded.mesh.geometry, material: loaded.mesh.material } });
player.pos.set(103, 1, 44);
if (!process.argv.includes('--natural-wake')) colossus._wake(false);
const headResults = [], armResults = [];
let attachmentGap = 0;
const normal = new THREE.Vector3(), bentNormal = new THREE.Vector3(), bent = new THREE.Vector3();
for (let frame = 0; frame < 1800; frame++) {
  const t = frame / 30;
  colossus.update(1 / 30, t, ctx);
  for (const a of colossus.arms) {
    point.copy(a.rootLocal).applyMatrix4(colossus.root.matrixWorld);
    attachmentGap = Math.max(attachmentGap, point.distanceTo(new THREE.Vector3().fromArray(a.chain.p)));
  }
  for (const a of [...colossus.feelers, ...colossus.beard]) {
    colossus._headPoint(a.rootLocal, a.w, point);
    attachmentGap = Math.max(attachmentGap, point.distanceTo(new THREE.Vector3().fromArray(a.chain.p)));
  }
  if (frame % 15) continue;
  const deform = (p, i) => {
    const u = THREE.MathUtils.clamp((p.y + 8) / 6, 0, 1), w = u * u * (3 - 2 * u);
    normal.fromBufferAttribute(colossus.bodyMesh.geometry.attributes.normal, i);
    bentNormal.copy(normal).applyMatrix3(new THREE.Matrix3().setFromMatrix4(colossus.headLocal));
    normal.lerp(bentNormal, w).normalize();
    const swell = Math.sin(t * 0.8 - p.y * 0.32 + p.x * 0.15) * 0.06;
    bent.copy(p).applyMatrix4(colossus.headLocal);
    p.lerp(bent, w).addScaledVector(normal, swell);
  };
  headResults.push({ t, state: colossus.state, ...meshContacts(colossus.bodyMesh, true, deform) });
  for (const [part, bundle] of [['arms', colossus.armBundle], ['feelers', colossus.feelBundle], ['beard', colossus.beardBundle]]) {
    armResults.push({ t, state: colossus.state, part, ...tubeContacts(bundle, true) });
  }
}
record('colossus/body', headResults);
record('colossus/limbs', armResults);
console.log(JSON.stringify({ name: 'colossus/attachments', attachmentGap, pose: [colossus.x, colossus.y, colossus.z, colossus.yaw, colossus.pitch] }));
assert.ok(attachmentGap < 0.3, 'colossus limb detached from body');
assert.ok(headResults.some((r) => r.maxY > 8), 'collision handling prevented colossus from surfacing');
if (only === 'colossus') process.exit(reports.some((r) => r.blockedSamples) ? 1 : 0);

const leviathan = new Leviathan({ ...opts, rigged: await model('leviathan_rig') });
const leviathanResults = [];
for (let pass = 0; pass < 3; pass++) {
  player.pos.set(83 + pass * 19, -1, 30);
  leviathan._begin(player.pos);
  for (let frame = 0; frame < 1200 && leviathan.active; frame++) {
    leviathan.update(1 / 30, pass * 40 + frame / 30, ctx);
    if (frame % 15) continue;
    leviathanResults.push({ pass, t: frame / 30, ...meshContacts(leviathan.rig.mesh, true) });
  }
}
record('leviathan/three-passes', leviathanResults);

// Attack fixtures: both endpoints in open water, with a pillar corner across the line of attack.
const pillar = new Level();
pillar.solid = (x, z) => x === 1 && z === 1;
pillar.floor = () => -10; pillar.ceil = () => 10; pillar.deckTop = () => null;
pillar.blockedAt = (x, y, z) => pillar.solid(Math.floor(x / 2), Math.floor(z / 2));
pillar.ch = (x, z) => pillar.solid(x, z) ? 'P' : '~';
const origin = new THREE.Vector3(1.9, -2, 2.4);
player.pos.set(2.4, -2, 1.9); player.frozen = false;
assert.equal(pillar.blockedAt(...origin.toArray()), false);
assert.equal(pillar.blockedAt(...player.pos.toArray()), false);
assert.equal(pillar.segmentClear(...origin.toArray(), ...player.pos.toArray(), 0.05), false);
const attacks = [];
function attack(name, run) {
  let catches = 0;
  run(() => { catches++; });
  const caughtThroughPillar = catches > 0;
  const solid = pillar.solid;
  pillar.solid = () => false;
  catches = 0;
  run(() => { catches++; });
  pillar.solid = solid;
  assert.ok(catches > 0, `${name}: unobstructed attack no longer catches the player`);
  attacks.push({ name, caughtThroughPillar, caughtWithoutPillar: catches > 0 });
}
attack('angler', (caught) => {
  const c = residents.angler;
  c.level = pillar; c.mouth.copy(origin); c.state = 'lunge'; c.stateT = 0; c.caught = false; c.onCatch = caught;
  c.update(0, 0, ctx);
});
attack('whale', (caught) => {
  const c = residents.whale;
  c.level = pillar; c.mouth.copy(origin); c.state = 'hunt'; c.caught = false; c.onCatch = caught;
  c._contact(0, player);
});
attack('crab', (caught) => {
  const c = residents.crab;
  c.level = pillar; c.stab = { s: 0, phase: 'strike', done: false }; c.onCatch = caught;
  c.prevTip[0].copy(origin); c.foreTip[0].copy(origin);
  c._hit(player);
});
attack('colossus', (caught) => {
  colossus.level = pillar; colossus.caught = false; colossus.onCatch = caught;
  const arm = colossus.arms[0]; arm.hit = false;
  for (let i = 0; i < arm.chain.n; i++) origin.toArray(arm.chain.p, i * 3);
  colossus._checkHit(arm, player);
});
attack('lurker', (caught) => {
  const c = lurkers.list[0];
  c.mgr.level = pillar; c.mgr.onCatch = caught; c.caught = false;
  c.pos.copy(origin); c.home.copy(origin); c.maw.copy(origin); c.t = 0;
  // Isolate contact at a fixed, valid mouth position; dt=0 leaves its movement unchanged.
  c._place = noop;
  c._surge(0, player);
});
console.log(JSON.stringify({ attacks }));
const affected = reports.filter((r) => r.blockedSamples).length + attacks.filter((r) => r.caughtThroughPillar).length;
console.log(`Audit complete: ${reports.length} geometry scenarios, ${attacks.length} occluded attacks; ${affected} scenarios exposed an issue.`);
if (process.argv.includes('--strict') && affected) process.exitCode = 1;
for (const c of Object.values(residents)) c.dispose();
lurkers.dispose(); colossus.dispose(); leviathan.dispose();
