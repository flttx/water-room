/**
 * Automated verification of src/audio.js in headless Chrome.
 *
 *   node tools/audio-check.mjs
 *
 * Starts its own Vite server on 127.0.0.1:5199 (or uses AUDIO_TEST_URL), opens
 * tools/audio-test.html?auto, calls every public API method, measures output RMS
 * through the engine's debug analyser, checks for page/console errors, clipping
 * and one-shot voice leaks, then shuts everything down.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5199;

const db = (x) => (x > 1e-7 ? 20 * Math.log10(x) : -140);
const fmt = (x) => `${db(x).toFixed(1).padStart(6)} dB`;

async function main() {
  let server = null;
  let url = process.env.AUDIO_TEST_URL;
  if (!url) {
    server = await createServer({
      root: ROOT,
      logLevel: 'error',
      configFile: false,
      server: { port: PORT, host: '127.0.0.1', strictPort: true },
    });
    await server.listen();
    url = `http://127.0.0.1:${PORT}/tools/audio-test.html?auto`;
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const failures = [];
  const results = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
      else if (msg.type() === 'warning') warnings.push(`console.warn: ${msg.text()}`);
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__audioTest, null, { timeout: 15000 });

    // ------------------------------------------------------------ in-page harness
    await page.evaluate(() => {
      const T = window.__audioTest;
      const H = {
        e: T.engine,
        voices: {},
        orbits: [],
        yaw: 0,
        globalPeak: 0,
        maxShots: 0,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        async measure(sec) {
          let maxRms = 0;
          let maxPeak = 0;
          let sum = 0;
          let n = 0;
          const end = performance.now() + sec * 1000;
          while (performance.now() < end) {
            const { rms, peak } = H.e._debugLevel();
            maxRms = Math.max(maxRms, rms);
            maxPeak = Math.max(maxPeak, peak);
            sum += rms * rms;
            n++;
            await H.sleep(20);
          }
          return { maxRms, maxPeak, avgRms: Math.sqrt(sum / Math.max(1, n)) };
        },
        startDriver() {
          let last = performance.now();
          H.driver = setInterval(() => {
            const now = performance.now();
            const dt = (now - last) / 1000;
            last = now;
            H.yaw += dt * 0.3;
            H.e.setListener({ x: 0, y: 1.6, z: 0 }, { x: Math.sin(H.yaw), y: 0, z: -Math.cos(H.yaw) }, { x: 0, y: 1, z: 0 });
            for (const o of H.orbits) {
              o.a += dt * o.w;
              o.voice.setPosition(Math.cos(o.a) * o.r, o.y, Math.sin(o.a) * o.r);
              o.voice.update(dt);
            }
            H.e.update(dt);
            if (H.e.ready) {
              const { peak } = H.e._debugLevel();
              H.globalPeak = Math.max(H.globalPeak, peak);
            }
            H.maxShots = Math.max(H.maxShots, H.e._shots.size);
          }, 16);
        },
      };
      window.__H = H;
    });

    // ------------------------------------------------------------ 1. pre-init no-ops
    const preInit = await page.evaluate(() => {
      const { AudioEngine } = window.__audioTest;
      const pre = new AudioEngine();
      const threw = [];
      const p = { x: 1, y: 0, z: 1 };
      const calls = [
        ['suspend', []], ['resume', []], ['setMasterVolume', [0.5]], ['setListener', [p, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }]],
        ['setUnderwater', [true]], ['setUnderwater', [false]], ['setTension', [0.5]], ['setHeartbeat', [0.5]], ['setBreath', [0.1]],
        ['update', [0.016]], ['footstep', [0.5]], ['jumpLand', [0.5]], ['splash', [0.5, p]], ['swimStroke', [true, 0.5]],
        ['bubbles', [0.5]], ['gasp', []], ['climbOut', []], ['valveTurn', [p]], ['valveDone', [p]], ['gateOpen', [p]],
        ['checkpoint', []], ['pickup', []], ['uiHover', []], ['uiClick', []], ['spotted', []], ['chaseStart', []],
        ['lostThem', []], ['caught', []], ['respawn', []], ['drown', []], ['win', []], ['_debugLevel', []],
      ];
      for (const [m, a] of calls) {
        try {
          pre[m](...a);
        } catch (err) {
          threw.push(`${m}: ${err.message}`);
        }
      }
      try {
        for (const kind of ['hunter', 'colossus']) {
          const v = pre.createCreatureVoice(kind);
          v.setPosition(1, 2, 3);
          v.setState('chase');
          v.setSpeed(1);
          v.growl(); v.roar(); v.click(); v.call(); v.update(0.016);
          v.dispose();
        }
        const l = pre.createLampHum(p);
        l.setOn(false); l.setOn(true); l.setPosition(2, 2, 2); l.dispose();
      } catch (err) {
        threw.push(`factory: ${err.message}`);
      }
      return { threw, ready: pre.ready, ctx: pre._ctx === null, shots: pre._shots.size };
    });
    if (preInit.threw.length) failures.push(`pre-init threw: ${preInit.threw.join('; ')}`);
    if (!preInit.ctx || preInit.ready) failures.push('pre-init engine created an AudioContext');
    console.log(`[pre-init] ${preInit.threw.length} throws, context created: ${!preInit.ctx}, shots: ${preInit.shots}`);

    // voice created before init must come alive after init
    await page.evaluate(() => {
      const H = window.__H;
      H.voices.early = H.e.createCreatureVoice('hunter');
      H.voices.early.setPosition(10, 0, 0);
    });

    // ------------------------------------------------------------ 2. init (idempotent)
    const initRes = await page.evaluate(async () => {
      const H = window.__H;
      const p1 = H.e.init();
      const p2 = H.e.init();
      await Promise.all([p1, p2]);
      await H.e.init();
      H.e._ambientOn = false;
      H.e.setMasterVolume(0.8);
      H.startDriver();
      return { same: p1 === p2, ready: H.e.ready, state: H.e._ctx && H.e._ctx.state, rate: H.e._ctx && H.e._ctx.sampleRate, earlyBuilt: !!H.voices.early._g };
    });
    console.log(`[init] ready=${initRes.ready} state=${initRes.state} rate=${initRes.rate} samePromise=${initRes.same} earlyVoiceBuilt=${initRes.earlyBuilt}`);
    if (!initRes.ready || initRes.state !== 'running') failures.push(`init failed: ${JSON.stringify(initRes)}`);
    if (!initRes.same) failures.push('init() not idempotent');
    if (!initRes.earlyBuilt) failures.push('voice created before init was not built');
    await page.evaluate(() => window.__H.voices.early.dispose());

    const measure = async (label, sec, fn, arg) => {
      const r = await page.evaluate(
        async ([body, a, s]) => {
          const H = window.__H;
          const f = new Function('H', 'a', body);
          await f(H, a);
          return H.measure(s);
        },
        [fn, arg ?? null, sec],
      );
      results.push({ label, ...r });
      console.log(`  ${label.padEnd(34)} maxRMS ${fmt(r.maxRms)}  avgRMS ${fmt(r.avgRms)}  peak ${fmt(r.maxPeak)}`);
      return r;
    };
    const call = (method, args = []) => `H.e[${JSON.stringify(method)}](...${JSON.stringify(args)});`;

    // ------------------------------------------------------------ 3. baseline + one-shots
    console.log('[levels] (dBFS at output, ambient events disabled)');
    await page.evaluate(() => window.__H.sleep(1200));
    const base = await measure('baseline (surface bed + drone)', 1.5, '');
    const P = { x: 3, y: 1, z: -3 };
    const shots = [
      ['footstep(0.3)', 0.5, call('footstep', [0.3])],
      ['footstep(1)', 0.6, call('footstep', [1])],
      ['jumpLand(0.8)', 1, call('jumpLand', [0.8])],
      ['splash(0.3)', 1.2, call('splash', [0.3])],
      ['splash(1, pos)', 2, call('splash', [1, P])],
      ['swimStroke(false, 0.7)', 1, call('swimStroke', [false, 0.7])],
      ['gasp()', 2.4, call('gasp')],
      ['climbOut()', 2.6, call('climbOut')],
      ['valveTurn(pos)', 2.8, call('valveTurn', [P])],
      ['valveDone(pos)', 6, call('valveDone', [P])],
      ['gateOpen(pos)', 7, call('gateOpen', [{ x: -8, y: 0, z: -10 }])],
      ['checkpoint()', 2.5, call('checkpoint')],
      ['pickup()', 0.6, call('pickup')],
      ['uiHover()', 0.3, call('uiHover')],
      ['uiClick()', 0.3, call('uiClick')],
      ['spotted()', 1.8, call('spotted')],
      ['chaseStart()', 3, call('chaseStart')],
      ['lostThem()', 3, call('lostThem')],
    ];
    for (const [label, sec, body] of shots) {
      const r = await measure(label, sec, body);
      if (r.maxRms <= base.maxRms * 1.05 && r.maxPeak <= base.maxPeak * 1.05) failures.push(`${label} not audible above baseline`);
      await page.evaluate(() => window.__H.sleep(400));
    }

    // ------------------------------------------------------------ 4. underwater / breath
    console.log('[underwater / breath]');
    await measure('setUnderwater(true) + plunge', 1.5, call('setUnderwater', [true]));
    await measure('underwater bed', 1, '');
    await measure('swimStroke(true, 0.8)', 1, call('swimStroke', [true, 0.8]));
    await measure('bubbles(0.8)', 1.4, call('bubbles', [0.8]));
    await measure('setBreath(0.05) strain', 3, call('setBreath', [0.05]));
    await measure('setUnderwater(false) + surface', 1.5, `H.e.setBreath(1); H.e.setUnderwater(false);`);
    await measure('rapid underwater toggling x20', 1, `for (let i = 0; i < 20; i++) H.e.setUnderwater(i % 2 === 0); H.e.setUnderwater(false);`);

    // ------------------------------------------------------------ 5. tension / heartbeat
    console.log('[tension / heartbeat]');
    await measure('setTension(0.4) pad + pulses', 5, call('setTension', [0.4]));
    await measure('setTension(1) chase', 5, call('setTension', [1]));
    await measure('setHeartbeat(1) during chase', 3, call('setHeartbeat', [1]));
    await measure('tension 0, heartbeat 0.3', 4, `H.e.setTension(0); H.e.setHeartbeat(0.3);`);
    await page.evaluate(() => window.__H.e.setHeartbeat(0));

    // ------------------------------------------------------------ 6. ambient events
    console.log('[ambient events]');
    await measure('forced drip/creak/groan/slosh/glass', 4, `H.e._ambientOn = true; for (const k of ['drip','creak','groan','slosh','glass']) H.e._amb[k] = 0;`);
    await measure('forced whale moan (far)', 6, `H.e._amb.moan = 0;`);
    await measure('ambient running naturally', 4, '');
    await page.evaluate(() => { window.__H.e._ambientOn = false; });

    // ------------------------------------------------------------ 7. creatures
    console.log('[creatures]');
    await measure('hunter patrol 15 m speed 0.2', 2, `
      const v = H.e.createCreatureVoice('hunter');
      H.voices.h = v; v.setSpeed(0.2); v.setState('patrol');
      H.orbits.push({ voice: v, a: 0, w: 0.4, r: 15, y: 0 });`);
    await measure('hunter suspicious', 2.5, `H.voices.h.setState('suspicious');`);
    await measure('hunter chase speed 1 at 8 m', 4, `H.voices.h.setSpeed(1); H.voices.h.setState('chase'); H.orbits[0].r = 8;`);
    await measure('hunter growl()', 2.2, `H.voices.h.growl();`);
    await measure('hunter roar()', 3, `H.voices.h.roar();`);
    await measure('hunter click()', 1, `H.voices.h.click();`);
    await measure('hunter call()', 2.2, `H.voices.h.call();`);
    await measure('hunter search, 40 m', 2.5, `H.voices.h.setState('search'); H.voices.h.setSpeed(0.4); H.orbits[0].r = 40;`);
    await measure('hunter at 90 m (gated out)', 1.5, `H.orbits[0].r = 90; H.voices.h.setState('patrol');`);
    await measure('colossus patrol 100 m below', 2, `
      const c = H.e.createCreatureVoice('colossus');
      H.voices.c = c; c.setSpeed(0.3);
      H.orbits.push({ voice: c, a: 1, w: 0.05, r: 100, y: -30 });`);
    await measure('colossus call()', 8, `H.voices.c.call();`);
    await measure('colossus chase 60 m + growl/click', 4, `H.voices.c.setState('chase'); H.voices.c.setSpeed(1); H.orbits[1].r = 60; H.voices.c.growl(); H.voices.c.click();`);
    await measure('colossus roar()', 8, `H.voices.c.roar();`);
    await measure('colossus search / suspicious', 2, `H.voices.c.setState('search'); H.voices.c.setState('suspicious');`);
    const disposed = await page.evaluate(async () => {
      const H = window.__H;
      H.orbits.length = 0;
      H.voices.h.dispose();
      H.voices.c.dispose();
      H.voices.h.dispose();
      H.voices.h.growl();
      H.voices.c.update(0.016);
      H.voices.c.setPosition({ x: 1, y: 1, z: 1 });
      await H.sleep(300);
      return H.e._voices.size;
    });
    console.log(`  voices after dispose: ${disposed}`);
    if (disposed !== 0) failures.push(`voices not released: ${disposed}`);

    // ------------------------------------------------------------ 8. lamp hum
    console.log('[lamp hum]');
    await page.evaluate(() => {
      window.__H.e._ambientOn = false;
    });
    const lampBase = await measure('lamp baseline (before lamp)', 1, '');
    await measure('createLampHum at 1 m', 1.5, `H.lamp = H.e.createLampHum({ x: 1, y: 1.6, z: 0 });`);
    await measure('lamp setOn(false)', 1, `H.lamp.setOn(false);`);
    await measure('lamp setOn(true) (click/fizz)', 1, `H.lamp.setOn(true);`);
    const lampFar = await page.evaluate(async () => {
      const H = window.__H;
      const near = !!H.lamp._g;
      H.lamp.setPosition(20, 1.6, 0);
      await H.sleep(500);
      const culled = !H.lamp._g;
      H.lamp.setPosition({ x: 2, y: 1.6, z: 0 });
      await H.sleep(300);
      const rebuilt = !!H.lamp._g;
      H.lamp.dispose();
      H.lamp.dispose();
      return { near, culled, rebuilt, lamps: H.e._lamps.size };
    });
    console.log(`  lamp built near=${lampFar.near} culled at 20 m=${lampFar.culled} rebuilt=${lampFar.rebuilt} lamps after dispose=${lampFar.lamps} (baseline was ${fmt(lampBase.maxRms)})`);
    if (!lampFar.near || !lampFar.culled || !lampFar.rebuilt || lampFar.lamps !== 0) failures.push(`lamp lifecycle: ${JSON.stringify(lampFar)}`);

    // ------------------------------------------------------------ 9. stress + robustness
    console.log('[stress]');
    const stress = await page.evaluate(async () => {
      const H = window.__H;
      const e = H.e;
      const threw = [];
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) {
        e.setListener({ x: i * 0.01, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
        e.update(0.001);
      }
      const listenerMs = performance.now() - t0;
      let peakShots = 0;
      for (let i = 0; i < 120; i++) {
        e.footstep(Math.random());
        e.splash(Math.random(), { x: Math.random() * 20, y: 0, z: Math.random() * 20 });
        e.bubbles(Math.random());
        e.uiHover();
        e.jumpLand(1);
        e.swimStroke(i % 2 === 0, 1);
        peakShots = Math.max(peakShots, e._shots.size);
        await H.sleep(5);
      }
      const garbage = [
        () => e.footstep(NaN), () => e.splash('big', { x: NaN }), () => e.setListener(null, undefined, {}),
        () => e.setTension(Infinity), () => e.setHeartbeat(-3), () => e.setBreath('x'), () => e.update(NaN),
        () => e.update(-5), () => e.setMasterVolume(undefined), () => e.valveTurn({ x: 'a' }), () => e.gateOpen(null),
        () => e.createCreatureVoice('nonsense').setState('dancing'), () => e.createLampHum(null).dispose(),
      ];
      for (const g of garbage) {
        try {
          g();
        } catch (err) {
          threw.push(err.message);
        }
      }
      e.setMasterVolume(0.8);
      e.setListener({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
      for (const v of [...e._voices]) v.dispose();
      return { listenerMs, peakShots, threw };
    });
    console.log(`  2000x setListener+update: ${stress.listenerMs.toFixed(1)} ms; peak live one-shots during spam: ${stress.peakShots}; garbage-arg throws: ${stress.threw.length}`);
    if (stress.threw.length) failures.push(`garbage args threw: ${stress.threw.join('; ')}`);
    if (stress.peakShots > 60) failures.push(`voice cap exceeded: ${stress.peakShots}`);
    await measure('after spam (settling)', 1.5, '');

    // suspend / resume
    const sus = await page.evaluate(async () => {
      const H = window.__H;
      H.e.suspend();
      await H.sleep(300);
      const state = H.e._ctx.state;
      const before = H.e._shots.size;
      H.e.footstep(1);
      H.e.checkpoint();
      const after = H.e._shots.size;
      H.e.resume();
      await H.sleep(300);
      return { state, noop: before === after, resumed: H.e._ctx.state };
    });
    console.log(`  suspend -> ${sus.state}, one-shots no-op while suspended: ${sus.noop}, resume -> ${sus.resumed}`);
    if (sus.state !== 'suspended' || !sus.noop || sus.resumed !== 'running') failures.push(`suspend/resume: ${JSON.stringify(sus)}`);

    // ------------------------------------------------------------ 10. death / win
    console.log('[death / win]');
    await page.evaluate(() => window.__H.sleep(1500));
    const cBefore = await measure('before caught', 0.5, '');
    await measure('caught() roar/crunch/gurgle (0-2 s)', 2, call('caught'));
    const cAfter = await measure('caught() after cut (ringing)', 1.5, '');
    await measure('respawn()', 3, call('respawn'));
    await measure('drown()', 3.5, call('drown'));
    await measure('respawn() again', 3, call('respawn'));
    await measure('win()', 6, call('win'));
    console.log(`  duck check: before caught ${fmt(cBefore.avgRms)} -> after cut ${fmt(cAfter.avgRms)}`);
    if (cAfter.avgRms > cBefore.avgRms) failures.push('caught() did not cut to near-silence');

    // ------------------------------------------------------------ 11. leak check
    const leak = await page.evaluate(async () => {
      const H = window.__H;
      H.e.respawn();
      H.e._ambientOn = false;
      H.e.setTension(0);
      H.e.setHeartbeat(0);
      const t0 = performance.now();
      while (H.e._shots.size > 0 && performance.now() - t0 < 30000) await H.sleep(250);
      clearInterval(H.driver);
      return { shots: H.e._shots.size, waited: (performance.now() - t0) / 1000, voices: H.e._voices.size, lamps: H.e._lamps.size, globalPeak: H.globalPeak, maxShots: H.maxShots };
    });
    console.log(`[leaks] live one-shots after drain: ${leak.shots} (waited ${leak.waited.toFixed(1)} s), voices: ${leak.voices}, lamps: ${leak.lamps}`);
    console.log(`[clip] global max output peak over whole run: ${fmt(leak.globalPeak)} (${leak.globalPeak.toFixed(3)}), max concurrent one-shots: ${leak.maxShots}`);
    if (leak.shots !== 0) failures.push(`one-shots leaked: ${leak.shots}`);
    if (leak.globalPeak >= 1) failures.push(`output clipped: peak ${leak.globalPeak}`);
    const silent = results.filter((r) => r.maxRms < 1e-4);
    if (silent.length > 2) failures.push(`too many silent measurements: ${silent.map((r) => r.label).join(', ')}`);
  } finally {
    await browser.close().catch((err) => console.warn('browser close failed', err));
    if (server) await server.close().catch((err) => console.warn('server close failed', err));
  }

  console.log(`\n[console] errors: ${errors.length}, warnings: ${warnings.length}`);
  for (const m of [...errors, ...warnings]) console.log(`  ${m}`);
  if (errors.length) failures.push(`${errors.length} page/console errors`);
  if (failures.length) {
    console.log(`\nFAIL (${failures.length})`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
