// Fixed-camera Chrome samples of real idle motion, including rendered skin.
// Run: node tools/creature-idle-visual-check.mjs [output-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(os.tmpdir(), 'drowned-halls-idle-visual');

async function main() {
  await fs.mkdir(out, { recursive: true });
  const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  let browser;
  const errors = [], results = [];
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      args: ['--mute-audio', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => localStorage.setItem('drowned-halls.settings', JSON.stringify({ quality: 'high', volume: 0, difficulty: 'hard' })));
    await page.goto(`${server.resolvedUrls.local[0]}?debug`);
    await page.waitForFunction(() => window.__game?.state === 'title', null, { timeout: 180000 });
    await page.click('#btn-start');
    for (const name of ['whale', 'angler', 'lurker']) {
      await page.evaluate(async (name) => {
        const g = window.__game;
        const THREE = await import('/node_modules/.vite/deps/three.js');
        const { G } = await import('/src/render/shaderlib.js');
        g.renderer.setAnimationLoop(null);
        const manager = name === 'lurker' ? g.lurkers : g[name];
        manager.reset();
        const c = name === 'lurker' ? manager.list[0] : manager;
        if (!c) throw new Error(`Missing ${name}`);
        const mesh = c.rig?.mesh || c.headMesh;
        if (!mesh) throw new Error(`Missing rendered ${name} mesh`);
        const creatureRoot = c.rig?.root || c.root;
        g.scene.updateMatrixWorld(true);
        mesh.skeleton?.update();
        const centre = new THREE.Box3().setFromObject(mesh, true).getCenter(new THREE.Vector3());
        const distance = name === 'whale' ? 20 : name === 'angler' ? 13 : 7;
        const candidate = new THREE.Vector3();
        let cameraReady = false;
        for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0], [0.7, 0.7], [-0.7, -0.7]]) {
          candidate.set(centre.x + dx * distance, Math.max(-6, Math.min(-0.8, centre.y + 2)), centre.z + dz * distance);
          if (g.level.blockedAt(candidate.x, candidate.y, candidate.z)) continue;
          if (!g.level.segmentClear(candidate.x, candidate.y, candidate.z, centre.x, centre.y, centre.z, 0.1)) continue;
          g.camera.position.copy(candidate); cameraReady = true; break;
        }
        if (!cameraReady) throw new Error(`No unobstructed fixed camera for ${name}`);
        g.camera.lookAt(centre);
        g.player.pos.copy(g.camera.position);
        g.player.vel.set(0, 0, 0);
        g.player.mode = 'under'; g.player.frozen = true; g.player.flashlight = true;
        g.flOn = 1; g.fade = 0;
        const ctx = { player: g.player, camera: g.camera, whale: g.whale, calm: true };
        const vertex = new THREE.Vector3();
        const samples = () => {
          g.scene.updateMatrixWorld(true); mesh.skeleton?.update();
          return Array.from({ length: 96 }, (_, i) => {
            const index = Math.floor(i * (mesh.geometry.attributes.position.count - 1) / 95);
            mesh.getVertexPosition(index, vertex).applyMatrix4(mesh.matrixWorld);
            return vertex.toArray();
          });
        };
        const state = { name, time: 0, mesh, c, manager, ctx, samples, base: null,
          initialRoot: creatureRoot.getWorldPosition(new THREE.Vector3()), root: creatureRoot,
          maxSkinDisplacement: 0, maxRootDisplacement: 0, frames: [] };
        state.measure = () => {
          const points = samples();
          if (!state.base) state.base = points;
          points.forEach((p, i) => {
            const b = state.base[i];
            state.maxSkinDisplacement = Math.max(state.maxSkinDisplacement, Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]));
          });
          state.maxRootDisplacement = Math.max(state.maxRootDisplacement, state.initialRoot.distanceTo(creatureRoot.getWorldPosition(vertex)));
          if (c.surface && !c.surface.clear(g.level)) throw new Error(`${name} skin entered terrain`);
        };
        state.advance = (seconds) => {
          while (state.time + 1e-6 < seconds) {
            state.time += 1 / 60;
            manager.update(1 / 60, state.time, ctx);
            if (Math.round(state.time * 60) % 30 === 0) state.measure();
          }
        };
        state.render = () => {
          G.uTime.value = state.time; g._world(0, state.time);
          for (let i = 0; i < 30; i++) g._postFx(1 / 60, state.time);
          g.post.render(1 / 60); state.measure();
          const gl = g.renderer.getContext();
          return { time: state.time, state: c.state, visible: c.group.visible,
            maxSkinDisplacement: state.maxSkinDisplacement, maxRootDisplacement: state.maxRootDisplacement,
            camera: g.camera.position.toArray(), glError: gl.getError(), calls: g.renderer.info.render.calls,
            failedPrograms: g.renderer.info.programs.filter((p) => p.diagnostics?.runnable === false).length };
        };
        manager.update(0, 0, ctx); state.measure();
        window.__idleVisual = state;
      }, name);
      const frames = [];
      for (const seconds of [0, 4, 8, 12]) {
        const frame = await page.evaluate((seconds) => {
          const s = window.__idleVisual; s.advance(seconds); return s.render();
        }, seconds);
        const filename = path.join(out, `${name}-${seconds}s.png`);
        await page.screenshot({ path: filename }); frames.push({ ...frame, filename });
        assert.equal(frame.glError, 0, `${name}: WebGL error`);
        assert.equal(frame.failedPrograms, 0, `${name}: shader error`);
        assert.ok(frame.visible && frame.calls > 0, `${name}: creature was not rendered`);
      }
      results.push({ name, frames });
      assert.ok(frames.at(-1).maxSkinDisplacement > 0.1, `${name}: actual rendered skin remained still`);
      assert.ok(frames.at(-1).maxRootDisplacement > (name === 'whale' ? 0.5 : 0.08), `${name}: no visible small-range movement`);
      assert.deepEqual(frames.at(-1).camera, frames[0].camera, `${name}: observer camera moved`);
    }
    assert.deepEqual(errors, [], 'browser errors');
    const evidence = { results, browserErrors: errors,
      limits: ['The observer is frozen to isolate idle behavior; creature state updates and terrain collision remain active.',
        'Cameras stay fixed for each 12-second sample. Screenshots are not a subjective smoothness verdict.'] };
    await fs.writeFile(path.join(out, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ result: 'PASS', evidence: path.join(out, 'evidence.json'),
      creatures: results.map(({ name, frames }) => ({ name, ...frames.at(-1) })) })}\n`);
  } finally {
    try { await browser?.close(); }
    finally { server.httpServer?.closeAllConnections(); await server.close(); }
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
