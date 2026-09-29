// Real Chrome/WebGL crab inspection. Fixed-step screenshots do not measure perceived smoothness.
// Run: node tools/crab-visual-check.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(os.tmpdir(), 'drowned-halls-crab-visual');

async function main() {
  await fs.mkdir(out, { recursive: true });
  const server = await createServer({ root, configFile: false, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  let browser;
  const errors = [], assets = [], frames = [];
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', (response) => {
      if (response.url().includes('/models/crab')) assets.push({ url: response.url(), status: response.status() });
    });
    await page.addInitScript(() => localStorage.setItem('drowned-halls.settings', JSON.stringify({ quality: 'high', volume: 0, difficulty: 'hard' })));
    await page.goto(`${server.resolvedUrls.local[0]}?debug`);
    await page.waitForFunction(() => window.__game?.state === 'title', null, { timeout: 180000 });
    await page.click('#btn-start');
    const presence = await page.evaluate(async () => {
      const g = window.__game, c = g.crab;
      const { G } = await import('/src/render/shaderlib.js');
      g.renderer.setAnimationLoop(null);
      if (!c) throw new Error('Crab was not loaded');
      c.reset();
      g.player.pos.set(243, 2.6, 95);
      g.player.vel.set(0, 0, 0);
      g.player.mode = 'ground';
      g.player.frozen = false;
      g.player.flashlight = true;
      g.flOn = 1; g.fade = 0;
      const context = { player: g.player, camera: g.camera, calm: true, whale: g.whale };
      const start = c.hub.clone(), previous = c.hub.clone();
      const state = { t: 0, count: 0, distance: 0, maxStep: 0, context, samples: [], scenario: 'approach' };
      state.resetLateral = () => {
        c.reset();
        g.state = 'playing'; g.player.frozen = false;
        g.player.pos.set(262, 2.6, 98);
        state.t = 0; state.count = 0; state.distance = 0; state.maxStep = 0; state.scenario = 'lateral';
        start.copy(c.hub); previous.copy(c.hub);
      };
      state.playerView = () => {
        g.camera.position.copy(g.player.pos);
        g.camera.lookAt(c.eye);
        const delta = c.eye.clone().sub(g.player.pos);
        g.player.yaw = Math.atan2(-delta.x, -delta.z);
        g.player.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
      };
      state.sample = () => {
        const direction = g.player.pos.clone().sub(c.eye).normalize();
        const angle = (forward) => Math.acos(Math.max(-1, Math.min(1, forward.dot(direction)))) * 180 / Math.PI;
        return { scenario: state.scenario, t: state.t, state: c.state, gameState: g.state, playerFrozen: g.player.frozen,
          player: g.player.pos.toArray(), hub: c.hub.toArray(), eye: c.eye.toArray(), fwd: c.fwd.toArray(),
          displacement: c.hub.distanceTo(start), distance: state.distance, maxStep: state.maxStep,
          playerDistance: c.hub.distanceTo(g.player.pos), gazeAngleDegrees: angle(c.fwd),
          eyes: (c.eyes || []).map((eye) => {
            const at = eye.getWorldPosition(c.eye.clone()), forward = eye.getWorldDirection(c.fwd.clone());
            const target = g.player.pos.clone().sub(at).normalize();
            return { position: at.toArray(), direction: forward.toArray(),
              angleDegrees: Math.acos(Math.max(-1, Math.min(1, forward.dot(target)))) * 180 / Math.PI };
          }) };
      };
      state.advance = (count, destination = null) => {
        const from = g.player.pos.clone();
        for (let i = 0; i < count; i++) {
          // Keep the scripted walking route on the existing bridge and pump deck.
          // A natural catch leaves the real death callback and frozen player intact.
          if (destination && !g.player.frozen) {
            const next = from.clone().lerp(destination, (i + 1) / count);
            for (const [dx, dz] of [[0, 0], [-0.32, 0], [0.32, 0], [0, -0.32], [0, 0.32]]) {
              const x = next.x + dx, z = next.z + dz;
              if (g.level.deckTop(g.level.tx(x), g.level.tx(z)) === null || g.level.blockedAt(x, next.y - 1, z)) {
                throw new Error('Diagnostic walking route left the traversable deck');
              }
            }
            g.player.vel.copy(next).sub(g.player.pos).multiplyScalar(60);
            g.player.speed = g.player.vel.length();
            g.player.pos.copy(next);
          }
          state.t += 1 / 60;
          state.count++;
          state.playerView();
          c.update(1 / 60, state.t, context);
          const step = c.hub.distanceTo(previous);
          state.distance += step;
          state.maxStep = Math.max(state.maxStep, step);
          previous.copy(c.hub);
          if (state.count % 60 === 0) state.samples.push(state.sample());
        }
        g.player.vel.set(0, 0, 0);
        g.player.speed = 0;
      };
      state.render = () => {
        G.uTime.value = state.t;
        g._world(0, state.t);
        for (let i = 0; i < 30; i++) g._postFx(1 / 60, state.t);
        g.scene.updateMatrixWorld(true);
        g.post.render(1 / 60);
        const gl = g.renderer.getContext();
        return { ...state.sample(), camera: g.camera.position.toArray(), glError: gl.getError(),
          calls: g.renderer.info.render.calls,
          failedPrograms: g.renderer.info.programs.filter((program) => program.diagnostics?.runnable === false).length };
      };
      state.eyeView = () => {
        g.camera.position.copy(c.eye).addScaledVector(c.fwd, 3.5);
        g.camera.position.y += 0.2;
        g.camera.lookAt(c.eye);
      };
      state.playerView();
      c.update(0, 0, context);
      state.samples.push(state.sample());
      window.__crabVisual = state;
      const mesh = c.rig.mesh, gl = g.renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl2: g.renderer.capabilities.isWebGL2,
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        rigged: !!mesh?.isSkinnedMesh, vertices: mesh?.geometry.attributes.position.count,
        bones: mesh?.skeleton.bones.length,
        texture: { width: mesh?.material.map?.image?.width, height: mesh?.material.map?.image?.height } };
    });
    assert.ok(presence.webgl2 && presence.rigged && presence.vertices > 0 && presence.bones > 0, 'real skinned crab model unavailable');
    assert.ok(presence.texture.width > 0 && presence.texture.height > 0, 'crab texture unavailable');
    assert.ok(assets.length > 0 && assets.every((asset) => asset.status === 200), 'crab asset request failed');
    const capture = async (name, result) => {
      const filename = path.join(out, `${name}.png`);
      await page.screenshot({ path: filename });
      frames.push({ name, filename, ...result });
    };
    for (const seconds of [0, 8, 16]) {
      await capture(`crab-bridge-${seconds}s`, await page.evaluate((seconds) => {
        const s = window.__crabVisual;
        s.advance(Math.max(0, Math.round(seconds * 60) - s.count));
        s.playerView();
        return s.render();
      }, seconds));
    }
    for (const [name, x, z, seconds] of [['pump-centre', 262, 94, 8], ['pump-left', 262, 90, 2], ['pump-right', 262, 98, 2]]) {
      await capture(`crab-${name}`, await page.evaluate(({ x, z, seconds }) => {
        const g = window.__game, s = window.__crabVisual;
        if (z === 90) s.resetLateral();
        // Reach the pump deck along the east-west bridge before moving sideways.
        if (g.player.pos.x < 256) s.advance(seconds * 60, g.player.pos.clone().set(x, 2.6, 95));
        s.advance(seconds * 60, g.player.pos.clone().set(x, 2.6, z));
        s.playerView();
        return s.render();
      }, { x, z, seconds }));
      if (name !== 'pump-centre') {
        await capture(`crab-${name}-eyes`, await page.evaluate(() => {
          const s = window.__crabVisual;
          s.eyeView();
          return s.render();
        }));
      }
    }
    const samples = await page.evaluate(() => window.__crabVisual.samples);
    const result = { presence, assets, browserErrors: errors, frames, samples,
      limits: ['Fixed-step screenshot samples do not establish perceived smoothness.',
        'Only the crab is simulated; its state, collision rules and natural catch callback remain active.',
        'Player movement follows a checked bridge/deck route and stops if the real death callback freezes the player.',
        'Eye close-ups move only the diagnostic camera after simulation; lighting, textures and shaders remain unchanged.',
        'Behavior measurements are observations, without pass thresholds.'] };
    await fs.writeFile(path.join(out, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...result, samples: `${samples.length} samples in evidence.json` })}\n`);
    assert.deepEqual(errors, [], 'browser emitted errors');
    for (const frame of frames) {
      assert.equal(frame.glError, 0, `${frame.name}: WebGL error`);
      assert.equal(frame.failedPrograms, 0, `${frame.name}: shader compilation failed`);
      assert.ok(frame.calls > 0, `${frame.name}: nothing was rendered`);
    }
  } finally {
    try { await browser?.close(); }
    finally { server.httpServer?.closeAllConnections(); await server.close(); }
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
