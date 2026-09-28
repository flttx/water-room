// Real Chrome/WebGL pose inspection. Screenshots are fixed-step samples, not a smoothness measurement.
// Run: node tools/swimmer-visual-check.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(os.tmpdir(), 'drowned-halls-swimmer-visual');

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
      if (response.url().includes('/models/leviathan')) assets.push({ url: response.url(), status: response.status() });
    });
    await page.addInitScript(() => localStorage.setItem('drowned-halls.settings', JSON.stringify({ quality: 'high', volume: 0, difficulty: 'hard' })));
    await page.goto(`${server.resolvedUrls.local[0]}?debug`);
    await page.waitForFunction(() => window.__game?.state === 'title', null, { timeout: 180000 });
    await page.click('#btn-start');
    const presence = await page.evaluate(async () => {
      const g = window.__game;
      const { G } = await import('/src/render/shaderlib.js');
      g.renderer.setAnimationLoop(null);
      g.player.pos.set(103, -1, 30);
      g.player.frozen = false;
      g.player.flashlight = true;
      g.flOn = 1; g.fade = 0;
      const context = { player: g.player, camera: g.camera, calm: true };
      const state = { t: 0, context };
      state.render = () => {
        G.uTime.value = state.t;
        g._world(0, state.t);
        // Settle the existing flashlight/post-process uniforms at the diagnostic camera.
        for (let i = 0; i < 30; i++) g._postFx(1 / 60, state.t);
        g.scene.updateMatrixWorld(true);
        g.post.render(1 / 60);
        const gl = g.renderer.getContext();
        return { t: state.t, glError: gl.getError(), calls: g.renderer.info.render.calls,
          camera: g.camera.position.toArray(), head: g.leviathan.headPos.toArray(),
          active: g.leviathan.active, visible: g.leviathan.group.visible, u: g.leviathan.u,
          failedPrograms: g.renderer.info.programs.filter((program) => program.diagnostics?.runnable === false).length };
      };
      state.leviathanView = () => {
        const c = g.leviathan, centre = g.camera.position.clone().fromArray(c.chain.p, 12);
        const forward = g.camera.position.clone().fromArray(c.chain.p).sub(g.camera.position.clone().fromArray(c.chain.p, 3));
        forward.y = 0; forward.normalize();
        g.camera.position.copy(centre).addScaledVector(forward, 3);
        g.camera.position.x += forward.z * 11;
        g.camera.position.z -= forward.x * 11;
        g.camera.position.y += 4;
        g.camera.lookAt(centre);
      };
      state.advance = (creature, count) => {
        for (let i = 0; i < count; i++) { state.t += 1 / 60; creature.update(1 / 60, state.t, context); }
      };
      window.__swimmerVisual = state;
      const mesh = g.leviathan.rig?.mesh, gl = g.renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl2: g.renderer.capabilities.isWebGL2,
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        rigged: !!mesh?.isSkinnedMesh, vertices: mesh?.geometry.attributes.position.count,
        bones: mesh?.skeleton.bones.length, texture: { width: mesh?.material.map?.image?.width, height: mesh?.material.map?.image?.height },
        drifters: [g.drifter, ...g.domeDrifters].map((c) => ({ bells: c.n, vertices: c.bellGeo.attributes.position.count })) };
    });
    assert.ok(presence.webgl2 && presence.rigged && presence.vertices > 0 && presence.bones > 0, 'real skinned model unavailable');
    const capture = async (name, result) => {
      assert.equal(result.glError, 0, `${name}: WebGL error`);
      assert.equal(result.failedPrograms, 0, `${name}: shader compilation failed`);
      const filename = path.join(out, `${name}.png`);
      await page.screenshot({ path: filename });
      frames.push({ name, filename, ...result });
    };
    await capture('leviathan-first-visible-frame', await page.evaluate(() => {
      const g = window.__game, s = window.__swimmerVisual, c = g.leviathan;
      c.reset(); c.wait = 0;
      s.advance(c, 1);
      s.leviathanView();
      return s.render();
    }));
    assert.ok(frames.at(-1).visible && frames.at(-1).head[1] < -18, 'first visible pose was not placed below the walls');
    await capture('leviathan-mid-pass', await page.evaluate(() => {
      const g = window.__game, s = window.__swimmerVisual;
      s.advance(g.leviathan, 899); s.leviathanView();
      return s.render();
    }));
    await capture('leviathan-before-exit', await page.evaluate(() => {
      const g = window.__game, s = window.__swimmerVisual;
      s.advance(g.leviathan, 1350); s.leviathanView();
      return s.render();
    }));
    await capture('leviathan-after-exit', await page.evaluate(() => {
      const g = window.__game, s = window.__swimmerVisual;
      while (g.leviathan.active) s.advance(g.leviathan, 1);
      return s.render();
    }));
    assert.equal(frames.at(-1).visible, false, 'leviathan did not disappear after departure');
    for (const route of ['canal', 'reservoir']) {
      await capture(`drifter-${route}-before-turn`, await page.evaluate((route) => {
        const g = window.__game, s = window.__swimmerVisual;
        const c = route === 'canal' ? g.drifter : g.domeDrifters[0];
        const corner = route === 'canal' ? c._sAt([32, 76]) : c._sAt(g.level.reservoir.jellies[0][1]);
        c.s = corner - 2.5;
        const eye = c._sample(corner + 5, []), look = c._sample(corner, []);
        g.camera.position.set(eye[0], -0.35, eye[1]);
        g.camera.lookAt(look[0], -1.5, look[1]);
        g.player.frozen = true;
        c.update(0, s.t, s.context);
        s.drifter = c;
        return { ...s.render(), bell: Array.from(c.bellPos.slice(0, 3)), bellsVisible: c.group.visible };
      }, route));
      await capture(`drifter-${route}-after-turn`, await page.evaluate(() => {
        const s = window.__swimmerVisual;
        s.advance(s.drifter, Math.ceil(5 / s.drifter.speed * 60));
        return { ...s.render(), bell: Array.from(s.drifter.bellPos.slice(0, 3)), bellsVisible: s.drifter.group.visible };
      }));
      assert.ok(frames.at(-1).bellsVisible, 'drifter was culled from its nearby camera');
    }
    assert.deepEqual(errors, [], 'browser emitted errors');
    const result = { presence, assets, browserErrors: errors, frames,
      limits: ['Fixed-step screenshot samples do not establish perceived smoothness.',
        'Diagnostic cameras follow the creatures; lighting, fog, model textures and shaders remain unchanged.',
        'The browser used the shipped rigged leviathan; fallback variants were covered by the motion check only.'] };
    await fs.writeFile(path.join(out, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    try { await browser?.close(); }
    finally { server.httpServer?.closeAllConnections(); await server.close(); }
  }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
