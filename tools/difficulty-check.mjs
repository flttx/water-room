// Browser regression for difficulty selection, persistence and HUD guidance.
// Run: node tools/difficulty-check.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(os.tmpdir(), 'drowned-halls-difficulty');

async function main() {
  await fs.mkdir(out, { recursive: true });
  const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 5197, strictPort: true } });
  await server.listen();
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      if (!localStorage.getItem('drowned-halls.settings')) localStorage.setItem('drowned-halls.settings', JSON.stringify({ quality: 'low', volume: 0 }));
    });
    const boot = async () => {
      await page.goto('http://127.0.0.1:5197/?debug');
      await page.waitForFunction(() => window.__game?.state === 'title', null, { timeout: 180000 });
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#title .title-box')).opacity) > 0.99);
    };
    const shot = async (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
    const pick = async (parent, value) => page.locator(`${parent} label`).filter({ has: page.locator(`input[value="${value}"]`) }).click();
    const start = async () => {
      await page.click('#btn-start');
      await page.evaluate(() => {
        const g = window.__game;
        g.renderer.setAnimationLoop(null);
        g._hud(0);
      });
    };
    const settings = async () => {
      await page.evaluate(() => window.__game.pause());
      await page.click('#btn-settings2');
      assert.equal(await page.evaluate(() => document.activeElement.value === window.__game.ui.settings.difficulty), true, 'settings should focus the checked difficulty');
    };
    const resume = async () => {
      await page.click('#settings-close');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-settings2');
      await page.click('#btn-resume');
      await page.evaluate(() => window.__game._hud(0));
    };
    const checkFocusLoop = async (difficulty) => {
      const radio = page.locator(`#settings-form input[name="difficulty"][value="${difficulty}"]`);
      await radio.focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-close', `${difficulty}: reverse Tab escaped the modal`);
      await page.keyboard.press('Tab');
      assert.equal(await radio.evaluate((el) => el === document.activeElement), true, `${difficulty}: Tab should return to the checked option`);
    };

    await boot();
    assert.equal(await page.locator('#title-difficulty input[value="normal"]').isChecked(), true, 'old settings should default to normal');
    await shot('desktop-title');
    await pick('#title-difficulty', 'easy');
    await start();
    assert.equal(await page.locator('#hud-route').isVisible(), true, 'easy should show the route map');
    assert.equal(await page.locator('#hud-direction').isVisible(), false);
    assert.match(await page.locator('#hud-route-target').textContent(), /下一站/);
    const mapChecks = await page.evaluate(() => {
      const g = window.__game, hud = g.ui.navigation, p = g.player.pos;
      const scale = hud.canvas.width / 80;
      const rgb = (wx, wz) => [...hud.ctx.getImageData(Math.round(hud.canvas.width / 2 + (wx - p.x) * scale), Math.round(hud.canvas.height / 2 + (wz - p.z) * scale), 1, 1).data].slice(0, 3).join(',');
      hud._draw({ path: [], target: null }, g.player, []);
      let checked = 0, mismatched = 0;
      // Sample actual room/pillar tile centres after projecting the map to screen.
      for (let z = 0; z < g.level.H; z++) for (let x = 0; x < g.level.W; x++) {
        const wx = (x + 0.5) * g.level.tile, wz = (z + 0.5) * g.level.tile;
        if (Math.abs(wx - p.x) > 37 || Math.abs(wz - p.z) > 21 || Math.hypot(wx - p.x, wz - p.z) < 2) continue;
        const expected = g.level.solid(x, z) ? '2,8,11' : g.level.deckTop(x, z) !== null ? '113,140,130' : g.level.isWater(x, z) ? '37,74,83' : '89,116,111';
        checked++;
        if (rgb(wx, wz) !== expected) mismatched++;
      }
      // A passed waypoint must not leave an amber detour behind the player's route.
      const passed = { x: p.x + 12, z: p.z }, next = { x: p.x - 12, z: p.z };
      hud._draw({ path: [passed, next], pathIndex: 1, target: null }, g.player, []);
      const remainingOnly = rgb(next.x + 2, next.z) === '240,166,74' && rgb(passed.x - 1, passed.z) !== '240,166,74';
      const [dx, dz] = g.level.find('D')[0];
      const saved = p.clone();
      p.x = (dx + 0.5) * g.level.tile - 8; p.z = (dz + 0.5) * g.level.tile;
      hud._draw({ path: [], target: null }, g.player, []);
      const closed = rgb(p.x + 8, p.z) === '2,8,11';
      g.level.open('D');
      hud._draw({ path: [], target: null }, g.player, []);
      const opened = rgb(p.x + 8, p.z) === '89,116,111';
      g.level.dynamicOpen.delete('D'); p.copy(saved); g._hud(0);
      return { checked, mismatched, remainingOnly, closed, opened };
    });
    assert.ok(mapChecks.checked > 50 && mapChecks.mismatched === 0 && mapChecks.remainingOnly && mapChecks.closed && mapChecks.opened,
      `map alignment regression: ${JSON.stringify(mapChecks)}`);
    const monsterChecks = await page.evaluate(() => {
      const g = window.__game, hud = g.ui.navigation, p = g.player.pos;
      const pixel = (pos) => {
        const scale = hud.canvas.width / 80;
        return [...hud.ctx.getImageData(Math.round(hud.canvas.width / 2 + (pos.x - p.x) * scale), Math.round(hud.canvas.height / 2 + (pos.z - p.z) * scale), 1, 1).data].slice(0, 3).join(',');
      };
      const isMonster = (pos) => pixel(pos) === '255,121,116';
      const lurker = g.lurkers.list[0], saved = lurker.pos.clone(), visible = lurker.group.visible;
      // A culled creature still exists. Move it while the player and cached route stay still.
      lurker.pos.set(p.x + 12, p.y, p.z + 6);
      lurker.group.visible = false;
      g._hud(0);
      const path = g.navigation.result.path, first = lurker.pos.clone();
      const before = isMonster(first);
      lurker.pos.x += 5;
      g._hud(0);
      const moved = isMonster(lurker.pos) && !isMonster(first);
      const cached = path === g.navigation.result.path;
      const hunter = g.director.hunters[0];
      const placed = g.director.spawnTiles.some((tile) => hunter.spawn(tile, g.player));
      hunter.x = p.x - 12; hunter.y = p.y; hunter.z = p.z + 6;
      g._hud(0);
      const spawned = isMonster(hunter);
      hunter.deactivate();
      g._hud(0);
      const despawned = !isMonster(hunter);
      const bodyMarkers = g._mapMonsters();
      const exact = bodyMarkers.some((m) => m.pos === lurker.pos) && bodyMarkers.some((m) => m.pos === g.colossus)
        && (!g.whale || bodyMarkers.some((m) => m.pos === g.whale.head))
        && (!g.crab || bodyMarkers.some((m) => m.pos === g.crab.rig.root.position))
        && (!g.angler || bodyMarkers.some((m) => m.pos === g.angler.rig.root.position));
      const d = g.drifter, ctx = { player: g.player, camera: g.camera };
      d.update(0, 0, ctx);
      const bell = Array.from(d.bellPos.slice(0, 3));
      d.update(0.1, 0.1, ctx);
      const drifted = bell.some((v, i) => v !== d.bellPos[i]) && g._mapMonsters().some((m) =>
        m.pos.x === d.bellPos[0] && m.pos.y === d.bellPos[1] && m.pos.z === d.bellPos[2]);
      lurker.pos.copy(saved); lurker.group.visible = visible;
      g.leviathan.active = true; g.leviathan.near = Infinity;
      const noUnplaced = !g._mapMonsters().some((m) => m.name === '利维坦');
      g.leviathan.near = 10; g.leviathan.headPos.copy(p);
      const leviathan = g._mapMonsters().some((m) => m.pos === g.leviathan.headPos);
      g.leviathan.reset();
      g.newGame(); g._hud(0);
      const reset = !g._mapMonsters().some((m) => ['追猎者', '利维坦'].includes(m.name));
      return { before, moved, cached, placed, spawned, despawned, exact, drifted, noUnplaced, leviathan, reset };
    });
    assert.ok(Object.values(monsterChecks).every(Boolean), `monster map regression: ${JSON.stringify(monsterChecks)}`);
    await shot('desktop-easy');
    // Capture a real populated area to check markers against the surrounding architecture.
    await page.evaluate(() => {
      const g = window.__game;
      g.player.spawn(103, 44, 0);
      g.drifter.update(0, 1, { player: g.player, camera: g.camera });
      g._hud(0);
    });
    await shot('desktop-map-monsters');
    const shortcut = await page.evaluate(() => {
      const g = window.__game;
      g.player.spawn(103, 123, Math.PI / 2);
      g.player.flashlight = true;
      for (const v of g.props.valves) v.done = v.tx !== 11 || v.tz !== 34;
      g.fade = 0;
      for (let frame = 0; frame < 12; frame++) g._frame(1 / 60);
      const route = g.navigation.result;
      return route.path.some((p) => Math.floor(p.x / 2) === 42 && Math.floor(p.z / 2) >= 60 && Math.floor(p.z / 2) <= 63);
    });
    assert.equal(shortcut, true, 'the west bath route should use the new plant-room shortcut');
    await shot('desktop-plant-shortcut');
    await page.evaluate(() => { const g = window.__game; g.newGame(); g._hud(0); });
    const guardStart = await page.evaluate(() => {
      const g = window.__game;
      g.player.spawn(143, 133, -Math.PI / 2);
      g.player.flashlight = true; g.fade = 0;
      g._frame(1 / 60);
      return { x: g.lurkers.list[3].pos.x, z: g.lurkers.list[3].pos.z, map: g.ui.navigation.canvas.toDataURL() };
    });
    await shot('desktop-drain-guard');
    const guardAway = await page.evaluate(() => {
      const g = window.__game;
      for (let frame = 1; frame <= 420; frame++) {
        g.lurkers.update(1 / 30, frame / 30, { player: g.player, camera: g.camera });
      }
      g._world(0, 14); g._hud(0); g._postFx(0, 14); g.post.render(0);
      return { x: g.lurkers.list[3].pos.x, z: g.lurkers.list[3].pos.z, map: g.ui.navigation.canvas.toDataURL() };
    });
    assert.ok(Math.hypot(guardAway.x - guardStart.x, guardAway.z - guardStart.z) > 6,
      'the entrance guard should leave the opening for the inner drain');
    assert.notEqual(guardStart.map, guardAway.map, 'easy map should track the real patrol position');
    await shot('desktop-drain-clear');
    await page.evaluate(() => { const g = window.__game; g.newGame(); g._hud(0); });
    const routeUpdates = await page.evaluate(() => {
      const g = window.__game;
      const first = g.navigation.update(g.player, g.props.valves).target;
      const valve = g.props.valves.find((v) => v.tx === first.tx && v.tz === first.tz);
      valve.done = true;
      g._hud(0);
      const next = g.navigation.update(g.player, g.props.valves).target;
      for (const v of g.props.valves) v.done = true;
      const waiting = g.navigation.update(g.player, g.props.valves).target.kind;
      g.level.open('G');
      const exit = g.navigation.update(g.player, g.props.valves).target.kind;
      g.newGame();
      g._hud(0);
      const reset = g.navigation.update(g.player, g.props.valves).target.kind;
      g.player.spawn(103, 44, 0);
      g._hud(0);
      g.respawn();
      g._hud(0);
      return { changed: first.tx !== next.tx || first.tz !== next.tz, waiting, exit, reset,
        respawn: g.navigation.result.path[0].z === g.player.pos.z };
    });
    assert.deepEqual(routeUpdates, { changed: true, waiting: 'gate', exit: 'exit', reset: 'valve', respawn: true });

    await settings();
    await checkFocusLoop('easy');
    await pick('#settings-form', 'normal');
    await checkFocusLoop('normal');
    await resume();
    assert.equal(await page.locator('#hud-route').isVisible(), false);
    assert.equal(await page.locator('#hud-direction-arrow').isVisible(), true);
    const arrowBefore = await page.locator('#hud-direction-arrow').getAttribute('style');
    await page.evaluate(() => { const g = window.__game; g.player.yaw += Math.PI / 2; g._hud(0); });
    assert.notEqual(await page.locator('#hud-direction-arrow').getAttribute('style'), arrowBefore, 'arrow should follow camera rotation');
    await shot('desktop-normal');

    await page.evaluate(() => window.__game.ui.message('任务提示测试', 10, 'task'));
    await settings();
    await pick('#settings-form', 'hard');
    await checkFocusLoop('hard');
    assert.equal(await page.locator('#hud-msg').evaluate((el) => el.classList.contains('show')), false, 'hard should clear an existing task message immediately');
    await shot('desktop-settings');
    await resume();
    assert.equal(await page.locator('#hud-navigation').isVisible(), false);
    assert.equal(await page.locator('#hud-valves').isVisible(), false);
    await page.evaluate(() => window.__game.ui.message('被隐藏的任务', 10, 'task'));
    assert.equal(await page.locator('#hud-msg').evaluate((el) => el.classList.contains('show')), false);
    await page.evaluate(() => {
      const g = window.__game;
      g.ui.message('危险反馈测试', 10);
      g.player.pos.copy(g.props.valves[0].pos);
      g.valveTarget = 0;
      g.player.breath = 12;
      g.player.mode = 'under';
      g._hud(0);
    });
    assert.equal(await page.locator('#hud-msg').textContent(), '危险反馈测试');
    assert.match(await page.locator('#hud-prompt-text').textContent(), /按住 E/);
    assert.equal(await page.locator('#hud-breath').evaluate((el) => el.classList.contains('show')), true);
    await shot('desktop-hard');
    await page.evaluate(() => window.__game.pause());
    assert.equal(await page.locator('#pause-objective').isVisible(), false);
    await page.click('#btn-help2');
    assert.equal(await page.locator('#help [data-task-hint]').isVisible(), false);
    assert.equal(await page.locator('#help .keys').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-help2');

    await boot();
    assert.equal(await page.locator('#title-difficulty input[value="hard"]').isChecked(), true, 'difficulty should survive reload');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('mobile-title');
    await pick('#title-difficulty', 'easy');
    await start();
    await shot('mobile-easy');
    const box = await page.locator('#hud-route').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height < 844, 'route map should fit the small viewport');
    await settings();
    await shot('mobile-settings');

    assert.deepEqual(errors, [], 'browser emitted errors');
    process.stdout.write(`Difficulty checks passed; screenshots: ${out}\n`);
  } finally {
    await browser?.close();
    server.httpServer?.closeAllConnections();
    await server.close();
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
