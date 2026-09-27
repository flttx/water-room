/**
 * Headless smoke test of the full game in system Chrome.
 *
 *   node tools/game-check.mjs [outDir]
 *
 * Boots the game with ?debug, measures load time and frame rate, walks through the title screen,
 * teleports to key places for screenshots, turns a valve, forces a death + respawn and reaches the
 * exit. Fails (exit code 1) on any page error or console error.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5198;
const OUT = process.argv[2] || path.join(os.tmpdir(), 'drowned-halls-shots');

const errors = [];
const warnings = [];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    configFile: false,
    server: { port: PORT, host: '127.0.0.1', strictPort: true },
  });
  await server.listen();
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      else if (m.type() === 'warning') warnings.push(m.text());
    });
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/?debug`);
    await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 180000 });
    const loadMs = Date.now() - t0;
    const gpu = await page.evaluate(() => {
      const gl = window.__game.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    console.log(`load ${loadMs} ms · GPU ${gpu}`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, '00-title.png') });

    await page.click('#btn-start');
    await page.waitForFunction(() => window.__game.state === 'playing');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '01-start.png') });

    // walk forward for a bit with real key events
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    const fps = await page.evaluate(() => new Promise((res) => {
      let n = 0;
      const t = performance.now();
      const f = () => { n++; if (performance.now() - t < 3000) requestAnimationFrame(f); else res(n / ((performance.now() - t) / 1000)); };
      requestAnimationFrame(f);
    }));
    const info = await page.evaluate(() => {
      const r = window.__game.renderer.info.render;
      return { calls: r.calls, triangles: r.triangles, pos: window.__game.player.pos.toArray().map((v) => +v.toFixed(2)) };
    });
    console.log(`fps ${fps.toFixed(1)} · calls ${info.calls} · tris ${info.triangles} · pos ${info.pos}`);

    const shot = async (name, x, z, yaw, pitch = 0, wait = 1200, y = null) => {
      await page.evaluate(([x, z, yaw, pitch, y]) => {
        const g = window.__game;
        g.player.spawn(x, z, yaw);
        g.player.pitch = pitch;
        if (y !== null) { g.player.pos.y = y; g.player.mode = y < -0.3 ? 'under' : g.player.mode; }
      }, [x, z, yaw, pitch, y]);
      await page.waitForTimeout(wait);
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      const s = await page.evaluate(() => {
        const g = window.__game;
        return { state: g.state, mode: g.player.mode, pos: g.player.pos.toArray().map((v) => +v.toFixed(1)), threat: +g.threat().toFixed(2) };
      });
      console.log(`${name}: ${JSON.stringify(s)}`);
    };

    await shot('02-abyss', 103, 44, 0, 0.12);
    await shot('03-abyss-under', 103, 36, 0, -0.3, 1500, -4);
    await shot('04-pump-room', 13, 5, Math.PI / 2, 0);
    await shot('05-pool-hall', 105, 113, 0, 0.05);
    await shot('05b-dome', 220, 95, -Math.PI / 2, 0.15);
    await shot('06-dark', 25, 131, 0, 0, 400);
    await page.evaluate(() => { window.__game.player.flashlight = true; });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '06-flashlight.png') });
    await page.evaluate(() => { window.__game.player.flashlight = false; });

    // valve: stand in front of the first valve, look at it, hold E
    const valveOk = await page.evaluate(async () => {
      const g = window.__game;
      const v = g.props.valves.find((q) => q.name === '浴场阀门');
      const x = v.pos.x + v.nx * 1.3, z = v.pos.z + v.nz * 1.3;
      g.player.spawn(x, z, Math.atan2(v.nx, v.nz));
      g.player.pitch = -0.15;
      return { name: v.name, x, z };
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '07-valve.png') });
    const target = await page.evaluate(() => window.__game.valveTarget);
    await page.keyboard.down('KeyE');
    await page.waitForTimeout(3200);
    await page.keyboard.up('KeyE');
    const valves = await page.evaluate(() => window.__game.valvesDone());
    console.log(`valve ${valveOk.name}: target ${target} · done ${valves}/${await page.evaluate(() => window.__game.props.valves.length)}`);
    // the reservoir valve in the dome must be reachable by the interaction ray as well
    const domeIdx = await page.evaluate(() => {
      const g = window.__game, i = g.props.valves.findIndex((q) => q.name === '水库阀门'), v = g.props.valves[i];
      g.player.spawn(v.pos.x + v.nx * 1.3, v.pos.z + v.nz * 1.3, Math.atan2(v.nx, v.nz));
      g.player.pitch = -0.15;
      return i;
    });
    await page.waitForTimeout(300);
    console.log(`dome valve: index ${domeIdx} · target ${await page.evaluate(() => window.__game.valveTarget)}`);
    await page.screenshot({ path: path.join(OUT, '07b-dome-valve.png') });

    // death + respawn
    await page.evaluate(() => {
      const g = window.__game;
      const p = g.player.pos;
      g.die({ source: 'hunter', maw: p.clone().add({ x: 0, y: 0.5, z: -4 }), grab: p.clone() });
    });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: path.join(OUT, '08-death.png') });
    await page.waitForFunction(() => window.__game.state === 'playing', null, { timeout: 8000 });
    console.log(`respawn ok · deaths ${await page.evaluate(() => window.__game.stats.deaths)}`);

    // creatures up close
    const creatures = await page.evaluate(() => {
      const g = window.__game;
      const l = g.lurkers.list[0];
      return { lurker: l ? [l.pos.x, l.pos.z] : null };
    });
    if (creatures.lurker) {
      const [lx, lz] = creatures.lurker;
      await shot('09-lurker', lx + 7, lz + 7, Math.atan2(7, 7), 0, 900);
    }

    // open everything and reach the exit
    await page.evaluate(() => {
      const g = window.__game;
      g.props.valves.forEach((v, i) => g.props.setValve(i, 1, false));
      g.props.openDoor();
      g.props.openGate();
      g.colossus.gateOpen = true;
      g.props.gateT = 1;
      g.props.doorT = 1;
    });
    await shot('10-gate-open', 103, 22, 0, 0.1, 1500);
    await page.evaluate(() => {
      const g = window.__game;
      g.player.spawn(103, 5, 0);
    });
    await page.waitForFunction(() => window.__game.state === 'won', null, { timeout: 5000 });
    await page.waitForTimeout(4200);
    await page.screenshot({ path: path.join(OUT, '11-win.png') });
    const winVisible = await page.evaluate(() => !document.getElementById('win').hidden);
    console.log(`win screen ${winVisible}`);

    // pause menu via UI
    await page.click('#btn-again');
    await page.waitForTimeout(800);
    await page.evaluate(() => window.__game.pause());
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '12-pause.png') });
    await page.click('#btn-settings2');
    await page.waitForTimeout(200);
    await page.check('input[name="quality"][value="low"]', { force: true });
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    const focusBack = await page.evaluate(() => document.activeElement && document.activeElement.id);
    console.log(`settings closed, focus → ${focusBack}`);
    await page.click('#btn-resume');
    await page.waitForTimeout(600);
    console.log(`final state ${await page.evaluate(() => window.__game.state)}`);
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`screenshots: ${OUT}`);
  if (warnings.length) console.log(`warnings (${warnings.length}):\n  ${[...new Set(warnings)].slice(0, 12).join('\n  ')}`);
  if (errors.length) {
    console.log(`ERRORS (${errors.length}):\n  ${[...new Set(errors)].join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('no page/console errors');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
