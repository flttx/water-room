import * as THREE from 'three';
import { Level } from './level/level.js';
import { planLamps } from './level/lamps.js';
import { buildShell, buildWaterGeometry } from './level/builder.js';
import { G } from './render/shaderlib.js';
import { FX, FL } from './render/fx.js';
import { Water } from './render/water.js';
import { Post } from './render/post.js';
import { LampSystem } from './lights.js';
import { Props } from './props.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { Colossus } from './creatures/colossus.js';
import { Lurkers } from './creatures/lurker.js';
import { Drifter } from './creatures/drifter.js';
import { Leviathan } from './creatures/leviathan.js';
import { Director } from './creatures/director.js';
import { Whale } from './creatures/whale.js';
import { SpiderCrab } from './creatures/spidercrab.js';
import { Angler } from './creatures/angler.js';
import { loadCreatureModels, loadRiggedModels } from './creatures/tripo.js';
import { UI } from './ui/ui.js';

const DEBUG = new URLSearchParams(window.location.search).has('debug');

const QUALITY = {
  low: { max: 1, scale: 0.75, refl: false, bloom: false },
  medium: { max: 1, scale: 1, refl: true, bloom: true },
  high: { max: 2, scale: 1, refl: true, bloom: true },
};

const VALVE_REACH = 2.4;
const VALVE_TIME = 2.6;
const CP_RADIUS = 3.2;
const DOOR_POS = new THREE.Vector3(23, 1.9, 11);
const GATE_POS = new THREE.Vector3(103, 3, 11);
const TITLE_TARGET = new THREE.Vector3(103, 5.5, 12);

const DEATH_TEXT = {
  colossus: ['你被深渊吞没', '触腕把你拖回了水底'],
  hunter: ['你被深渊吞没', '它一直跟在你身后'],
  lurker: ['你被深渊吞没', '那盏灯不是出口'],
  crab: ['你被深渊吞没', '那些不是柱子，是它的腿'],
  angler: ['你被深渊吞没', '它一动不动，直到你游得太快'],
  whale: ['你被深渊吞没', '死去的东西也会饿'],
  siphonophore: ['你被深渊吞没', '丝网收紧，把你拖进了钟群'],
  drown: ['你沉了下去', '肺里灌满了冰冷的水'],
};

const HINTS = [
  [2, 'WASD 移动 · 鼠标环顾 · Esc 暂停', 5],
  [9, '它们靠声音和光找你。按 C 蹲伏，脚步会更轻', 5.5],
  [17, '靠近池边按空格攀上窄道；在水面按 C 下潜', 5.5],
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Resolve after the browser had a chance to paint (falls back to a timer in background tabs). */
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 120);
});

const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v = new THREE.Vector3();
const _fl = new THREE.Vector3();

class Game {
  constructor(ui) {
    this.ui = ui;
    this.state = 'loading';
    this.t = 0;
    this.last = 0;
    this.frameError = false;
  }

  // ------------------------------------------------------------------ boot
  async boot() {
    const ui = this.ui;
    const step = async (p, text) => { ui.setLoading(p, text); await nextFrame(); };
    await step(0.03, '正在灌水……');

    const canvas = document.getElementById('view');
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 unavailable');
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;
    this.pixelRatio = 1;
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    const scene = new THREE.Scene();
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(ui.settings.fov, window.innerWidth / window.innerHeight, 0.05, 420);
    camera.rotation.order = 'YXZ';
    this.camera = camera;

    // the creature models download while the level is built
    const models = loadCreatureModels();
    const riggedModels = loadRiggedModels().catch((err) => {
      console.warn('rigged models unavailable', err);
      return {};
    });
    const level = new Level();
    this.level = level;
    const lamps = planLamps(level);
    this.lamps = lamps;
    await step(0.1, '点亮钠灯，烘焙瓷砖上的光……');

    const shell = buildShell(level, lamps);
    scene.add(shell.group);
    this.baker = shell.baker;
    await step(0.34, '测量黑暗……');
    const lightGrid = this.baker.buildLightGrid();

    await step(0.42, '让水面平静下来……');
    this.water = new Water(buildWaterGeometry(level), renderer);
    scene.add(this.water.reflector);
    this.lampSys = new LampSystem(lamps);
    this.fx = new FX(level, lamps, scene);

    await step(0.48, '安装阀门、救生圈与生锈的闸门……');
    this.props = new Props({ scene, level, lamps, lampSys: this.lampSys, baker: this.baker });

    this.player = new Player(level, camera);
    this.input = new Input(canvas);
    this.audio = new AudioEngine();

    await step(0.64, '有什么东西在深处成形……');
    const opts = { scene, level, lampSys: this.lampSys, audio: this.audio, water: this.water, fx: this.fx, lightGrid };
    const { colossus, leviathan } = await models;
    const rigged = await riggedModels;
    this.colossus = new Colossus({ ...opts, model: colossus });
    await step(0.74, '它们在等待……');
    this.lurkers = new Lurkers(opts);
    this.drifter = new Drifter(opts);
    await step(0.82, '远处有东西经过……');
    this.leviathan = new Leviathan({ ...opts, model: leviathan, rigged: rigged.leviathanRig });
    this.director = new Director(opts);
    await step(0.86, '穹顶下的黑水里不止一种东西……');
    this._domeCreatures(opts, rigged);
    for (const c of [this.colossus, this.lurkers, this.director, ...this.dome, ...this.domeDrifters]) c.onCatch = (info) => this.die(info);

    this._lampHums();

    await step(0.9, '调整镜头……');
    this.post = new Post(renderer, scene, camera, { msaa: false });
    this.applySettings(ui.settings);
    window.addEventListener('resize', () => this.resize());
    this._bindControls();

    this.newGame();
    this._titleCamera(0);
    try {
      renderer.compile(scene, camera);
    } catch (err) {
      console.warn('shader precompile failed', err);
    }
    await step(1, '准备就绪');
    this.state = 'title';
    ui.show('title');
    this.last = performance.now();
    renderer.setAnimationLoop((now) => this.frame(now));
    window.__game = this;
  }

  /** The reservoir dome's residents. A creature whose rigged model failed to load is simply absent. */
  _domeCreatures(opts, rigged) {
    const make = (name, Kind) => {
      if (!rigged[name]) return null;
      try {
        return new Kind({ ...opts, model: rigged[name] });
      } catch (err) {
        console.warn(`dome creature "${name}" unavailable`, err);
        return null;
      }
    };
    this.whale = make('whale', Whale);
    this.crab = make('crab', SpiderCrab);
    this.angler = make('angler', Angler);
    this.dome = [this.whale, this.crab, this.angler].filter(Boolean);
    const palettes = [[[1.0, 0.42, 0.22], [1.0, 0.16, 0.34]], [[0.7, 1.0, 0.25], [0.25, 1.0, 0.4]]];
    this.domeDrifters = this.level.reservoir.jellies.map((route, k) => new Drifter(opts, {
      route, seed: 900 + k, bells: 20, scale: 1.5, speed: 0.7,
      colA: palettes[k % 2][0], colB: palettes[k % 2][1], lethal: true, source: 'siphonophore',
    }));
  }

  _lampHums() {
    this.hums = new Map();
    this.lamps.forEach((l, i) => {
      if (!l.baked || l.dead || (l.type !== 'hang' && l.type !== 'wall')) return;
      this.hums.set(i, this.audio.createLampHum({ x: l.x, y: l.y, z: l.z }));
    });
    this.lampSys.onToggle = (i, on) => {
      const h = this.hums.get(i);
      if (h) h.setOn(on);
    };
  }

  // ------------------------------------------------------------------ settings & sizing
  applySettings(s) {
    const q = QUALITY[s.quality] || QUALITY.medium;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, q.max) * q.scale;
    this.water.setReflections(q.refl);
    this.post.setBloom(q.bloom);
    this.camera.fov = s.fov;
    this.input.sens = s.sens;
    this.input.invertY = s.invertY;
    this.audio.setMasterVolume(s.volume);
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const r = this.renderer;
    r.setPixelRatio(this.pixelRatio);
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.composer.setPixelRatio(this.pixelRatio);
    this.post.setSize(w, h);
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this.water.setSize(size.x, size.y);
    FL.uPx.value = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  // ------------------------------------------------------------------ menus & state
  _bindControls() {
    const ui = this.ui, input = this.input, audio = this.audio;
    ui.on('hover', () => audio.uiHover());
    ui.on('click', () => audio.uiClick());
    ui.on('settings', (s) => this.applySettings(s));
    ui.on('start', () => {
      this.newGame();
      this.play();
    });
    ui.on('resume', () => this.play());
    ui.on('restart', () => {
      this.newGame();
      this.play();
    });
    ui.on('again', () => {
      this.newGame();
      this.play();
    });
    ui.on('quit', () => this.toTitle());

    input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing' && !DEBUG) this.pause();
      else if (locked && this.state === 'paused' && !ui.modalOpen) this.play();
    };
    this.canvas.addEventListener('mousedown', () => {
      if (this.state === 'playing' && !input.locked) input.requestLock();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.state === 'playing') this.pause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
  }

  _initAudio() {
    this.audio.init()
      .then(() => {
        this.audio.setMasterVolume(this.ui.settings.volume);
        this.audio.resume();
      })
      .catch((err) => console.warn('audio unavailable', err));
  }

  play() {
    this._initAudio();
    this.ui.closeModal();
    this.state = 'playing';
    this.ui.show(null);
    this.audio.resume();
    this.input.enabled = true;
    this.input.requestLock();
    this.last = performance.now();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.input.down.clear();
    this.input.exitLock();
    this.audio.suspend();
    this.ui.setObjective(this._objective());
    this.ui.show('pause');
  }

  toTitle() {
    this.state = 'title';
    this.input.enabled = false;
    this.input.exitLock();
    this.newGame();
    this.audio.resume();
    this.ui.show('title');
  }

  _objective() {
    const n = this.valvesDone(), all = this.props.valves.length;
    if (n >= all) return '闸门已经升起。穿过深渊浴场，向北，去有光的地方。';
    return `找到出口。${'零一二三四五六七八九'[all] || all}处阀门能开启深渊浴场北侧的闸门——已开启 ${n}/${all}。救生圈提灯是检查点。`;
  }

  valvesDone() { return this.props.valves.filter((v) => v.done).length; }

  /** Reset everything for a fresh descent. */
  newGame() {
    const { level, props, player } = this;
    level.dynamicOpen.clear();
    props.reset();
    this.colossus.gateOpen = false;
    this.colossus.reset();
    this.lurkers.reset();
    this.director.reset();
    this.drifter.reset(true);
    this.leviathan.reset();
    for (const c of this.dome) c.reset(true);
    for (const d of this.domeDrifters) d.reset(true);
    this.lampSys.disturb.length = 0;
    this.cp = 0;
    const s = props.checkpoints[0];
    player.frozen = false;
    player.flashlight = false;
    player.spawn(s.x, s.z, s.yaw);
    this.valveSoundT = 0;
    this.doorOpened = false;
    this.gateOpened = false;
    this.chasing = false;
    this.chaseHold = 0;
    this.spottedCool = 0;
    this.deathT = 0;
    this.death = null;
    this.drowned = false;
    this.winT = 0;
    this.winShown = false;
    this.deathShown = false;
    this.playT = 0;
    this.hintI = 0;
    this.seenAbyss = false;
    this.fade = 1;
    this.hurt = 0;
    this.danger = 0;
    this.under = 0;
    this.surfaceFx = 0;
    this.flOn = 0;
    this.valveTarget = -1;
    this.stats = { deaths: 0, spotted: 0, swim: 0, cps: 1 };
    this.lastPos = player.pos.clone();
    this.ui.clearMessage();
  }

  // ------------------------------------------------------------------ frame
  frame(now) {
    if (this.frameError) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    try {
      this._frame(dt);
    } catch (err) {
      this.frameError = true;
      this.renderer.setAnimationLoop(null);
      console.error(err);
      this.input.exitLock();
      document.getElementById('error-text').textContent = '游戏运行时出现了问题。请刷新页面重试。';
      this.ui.showError();
    }
  }

  _frame(dt) {
    const s = this.state;
    const live = s === 'playing' || s === 'dying' || s === 'won';
    if (live || s === 'title') this.t += dt;
    const t = this.t;
    G.uTime.value = t;

    if (s === 'title') {
      this._titleCamera(t);
      this._titleAudio(dt);
    }
    if (live) this._simulate(dt, t);
    if (s !== 'paused') this._world(dt, t);
    this._postFx(dt, t);
    this.post.render(dt);
    this.input.endFrame();
  }

  _titleCamera(t) {
    const cam = this.camera;
    cam.position.set(103 + Math.sin(t * 0.045) * 7, 1.35 + Math.sin(t * 0.21) * 0.12, 42 + Math.sin(t * 0.03) * 2);
    _v.copy(TITLE_TARGET);
    _v.x += Math.sin(t * 0.07) * 3;
    cam.lookAt(_v);
    cam.rotation.z += Math.sin(t * 0.17) * 0.012;
  }

  _titleAudio(dt) {
    const { audio, camera } = this;
    camera.getWorldDirection(_dir);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    audio.setListener(camera.position, _dir, _up);
    audio.setUnderwater(false);
    audio.setTension(0);
    audio.setHeartbeat(0);
    audio.setBreath(1);
    audio.update(dt);
  }

  /** Lamps, particles, props and water: runs on the title screen too. */
  _world(dt, t) {
    const cam = this.camera;
    const dis = this.lampSys.disturb;
    dis.length = 0;
    if (this.state !== 'title') {
      if (this.colossus.disturb) dis.push(this.colossus.disturb);
      if (this.leviathan.disturb) dis.push(this.leviathan.disturb);
      for (const c of this.dome) if (c.disturb) dis.push(c.disturb);
      for (const d of this.lurkers.disturbs) dis.push(d);
      for (const d of this.director.disturbs) dis.push(d);
    }
    this.lampSys.update(t, cam.position);
    this.fx.setLampIntensities(this.lampSys.k);
    this.fx.update(dt, t, cam.position, {
      onBubbleSurface: (x, z) => this.water.addRipple(x, z, 0.12),
      onDrip: (d) => { if (d.water) this.water.addRipple(d.x, d.z, 0.1); },
    });
    this.props.update(dt, t, this.lampSys.k);
  }

  _simulate(dt, t) {
    const { player, input, camera } = this;
    const playing = this.state === 'playing';
    if (this.state === 'dying') this._dyingCamera(dt);
    player.update(dt, playing ? input : this._noInput());
    if (playing) {
      this.playT += dt;
      this._playerEvents(dt);
    }

    const ctx = { player, camera, valves: this.valvesDone(), calm: !this.colossus.awake && !this.director.chasing, whale: this.whale };
    this.colossus.update(dt, t, ctx);
    this.lurkers.update(dt, t, ctx);
    this.director.update(dt, t, ctx);
    this.drifter.update(dt, t, ctx);
    this.leviathan.update(dt, t, ctx);
    for (const c of this.dome) c.update(dt, t, ctx);
    for (const d of this.domeDrifters) d.update(dt, t, ctx);
    this._creatureEvents();

    if (playing) {
      this._valves(dt);
      this._doors();
      this._checkpoints();
      this._exit();
      this._hints();
      const p = player.pos;
      if (player.inWater) this.stats.swim += Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z);
      this.lastPos.copy(p);
    }
    if (this.state === 'dying') this._dying(dt);
    if (this.state === 'won') this._winning(dt);
    this._audioFrame(dt);
    this._hud(dt);
  }

  _noInput() {
    if (!this._idle) {
      this._idle = {
        key: () => false, hit: () => false, any: () => false, anyHit: () => false,
        consumeMouse: () => [0, 0],
      };
    }
    // drain accumulated mouse movement so it does not jump the view on respawn
    this.input.consumeMouse();
    return this._idle;
  }

  // ------------------------------------------------------------------ noise & events
  noise(x, y, z, r, loud = false) {
    this.colossus.hear(x, y, z, r, loud);
    this.director.hear(x, y, z, r, loud);
    this.lurkers.hear(x, y, z, r, loud);
    for (const c of this.dome) c.hear(x, y, z, r, loud);
  }

  _playerEvents(dt) {
    const { player, audio, water, fx } = this;
    const p = player.pos;
    for (const e of player.events) {
      switch (e.type) {
        case 'flashlight':
          audio.uiClick();
          break;
        case 'jump':
          this.noise(p.x, p.y, p.z, 4);
          break;
        case 'land':
          audio.jumpLand(e.hard ? 1 : 0.45);
          this.noise(p.x, p.y, p.z, e.hard ? 16 : 6, e.hard);
          break;
        case 'step': {
          audio.footstep(e.sprint ? 0.95 : e.crouch ? 0.18 : 0.5);
          this.noise(p.x, p.y, p.z, e.sprint ? 14 : e.crouch ? 3 : 7.5);
          break;
        }
        case 'splash': {
          audio.splash(e.quiet ? 0.3 : 0.95, { x: e.x, y: 0, z: e.z });
          water.addRipple(e.x, e.z, e.quiet ? 0.5 : 1.4);
          fx.bubbles.spawn(e.x, -0.4, e.z, e.quiet ? 6 : 18, 0.4, 1);
          this.noise(e.x, 0, e.z, e.quiet ? 6 : 22, !e.quiet);
          break;
        }
        case 'stroke':
          audio.swimStroke(false, e.sprint ? 0.9 : 0.5);
          water.addRipple(e.x, e.z, e.sprint ? 0.6 : 0.35);
          this.noise(e.x, 0, e.z, e.sprint ? 12 : 6);
          break;
        case 'uswim':
          audio.swimStroke(true, e.sprint ? 0.8 : 0.4);
          fx.bubbles.spawn(p.x, p.y - 0.2, p.z, e.sprint ? 4 : 2, 0.2, 0.7);
          this.noise(p.x, p.y, p.z, e.sprint ? 8 : 4);
          break;
        case 'dive':
          water.addRipple(e.x, e.z, 0.7);
          fx.bubbles.spawn(e.x, -0.5, e.z, 14, 0.3, 1);
          this.noise(e.x, 0, e.z, 5);
          break;
        case 'climb':
          audio.climbOut();
          water.addRipple(e.x, e.z, 0.6);
          this.noise(e.x, 0, e.z, 6);
          break;
        case 'surface':
          water.addRipple(e.x, e.z, 0.6);
          this.surfaceFx = 1;
          if (e.gasp) {
            audio.gasp();
            this.noise(e.x, 0, e.z, 10);
          }
          break;
        case 'drown':
          if (!this.drowned) {
            this.drowned = true;
            this.die({ source: 'drown' });
          }
          break;
        default:
          break;
      }
    }
    if (player.underwater && Math.random() < dt * 0.9) audio.bubbles(0.3);
  }

  _creatureEvents() {
    const { player, audio } = this;
    const p = player.pos;
    const shakeAt = (x, z, k, r) => {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < r) player.shake = Math.max(player.shake, k * (1 - d / r));
    };
    const spotted = () => {
      this.stats.spotted++;
      if (this.spottedCool <= 0) audio.spotted();
      this.spottedCool = 2;
    };
    for (const e of this.colossus.events) {
      if (e.type === 'rise') {
        this.ui.message('深渊里有什么东西醒了。', 5);
        player.shake = Math.max(player.shake, 0.4);
      } else if (e.type === 'spotted') spotted();
      else if (e.type === 'slam') shakeAt(e.x, e.z, 0.9, 30);
    }
    for (const e of this.director.events) {
      if (e.type === 'spotted') spotted();
      else if (e.type === 'strike' || e.type === 'lunge') {
        shakeAt(e.x, e.z, 0.5, 14);
        if (e.type === 'strike') this.noise(e.x, 0, e.z, 30, true);
      }
    }
    for (const e of this.lurkers.events) {
      if (e.type === 'lunge' || e.type === 'strike') {
        shakeAt(e.x, e.z, 0.6, 10);
        this.noise(e.x, e.y, e.z, 30, e.type === 'strike');
      }
    }
    for (const e of this.drifter.events) {
      if (e.type === 'sting') {
        this.noise(e.x, e.y, e.z, 25);
        this.ui.message('刺痛——别碰那些发光的丝', 3);
      }
    }
    for (const e of this.leviathan.events) {
      if (e.type === 'pass') this.ui.message('……脚下的黑暗在移动。', 4);
    }
    for (const e of this.whale ? this.whale.events : []) {
      if (e.type === 'spotted') spotted();
      else if (e.type === 'pass') this.ui.message('一具巨大的尸骸从你身边滑过……别出声。', 4);
    }
    for (const e of this.crab ? this.crab.events : []) {
      if (e.type === 'spotted') spotted();
      else if (e.type === 'stab') {
        shakeAt(e.x, e.z, 0.8, 16);
        this.noise(e.x, e.y, e.z, 18);
      }
    }
    for (const e of this.angler ? this.angler.events : []) {
      if (e.type === 'snap') shakeAt(e.x, e.z, 0.7, 16);
    }
    for (const d of this.domeDrifters) {
      for (const e of d.events) {
        if (e.type !== 'sting') continue;
        this.noise(e.x, e.y, e.z, 25);
        this.ui.message('你被缠住了——快挣脱！再碰一次就完了', 3.5);
      }
    }
  }

  // ------------------------------------------------------------------ interaction
  _valves(dt) {
    const { player, props, input, camera, audio } = this;
    const p = player.pos;
    camera.getWorldDirection(_dir);
    let target = -1, best = Infinity;
    props.valves.forEach((v, i) => {
      if (v.done) return;
      _v.subVectors(v.pos, p);
      const d = _v.length();
      if (d > VALVE_REACH || player.underwater) return;
      if (_v.dot(_dir) / d < 0.4) return;
      if (d < best) { best = d; target = i; }
    });
    this.valveTarget = target;
    if (target < 0) {
      for (let i = 0; i < props.valves.length; i++) if (props.valves[i].turning) props.setValve(i, props.valves[i].progress, false);
      return;
    }
    const v = props.valves[target];
    const turning = input.key('KeyE');
    if (!turning) {
      props.setValve(target, v.progress, false);
      return;
    }
    const prog = v.progress + dt / VALVE_TIME;
    props.setValve(target, prog, true);
    this.valveSoundT -= dt;
    if (this.valveSoundT <= 0) {
      this.valveSoundT = 0.7;
      audio.valveTurn(v.pos);
      this.noise(v.pos.x, v.pos.y, v.pos.z, 11);
    }
    if (prog >= 1) this._valveDone(v);
  }

  _valveDone(v) {
    const { audio, props, ui } = this;
    audio.valveDone(v.pos);
    this.noise(v.pos.x, v.pos.y, v.pos.z, 30, true);
    this.valveSoundT = 0;
    const n = this.valvesDone(), all = props.valves.length;
    if (v.pump) {
      props.openDoor();
      ui.message(`${v.name}已开启（${n}/${all}）。加压门的锁扣松开了。`, 5.5);
    } else {
      ui.message(`${v.name}已开启（${n}/${all}）。管道深处传来轰鸣。`, 5);
    }
    if (n >= all) {
      props.openGate();
      this.colossus.gateOpen = true;
      audio.gateOpen(GATE_POS);
      setTimeout(() => {
        if (this.state === 'playing') ui.message('远处的闸门正在升起——深渊浴场北侧。', 6);
      }, 5600);
    }
  }

  _doors() {
    const { level, props } = this;
    if (props.doorPassable && !this.doorOpened) {
      this.doorOpened = true;
      level.open('D');
    }
    if (props.gatePassable && !this.gateOpened) {
      this.gateOpened = true;
      level.open('G');
    }
  }

  _checkpoints() {
    const { props, player, level } = this;
    const p = player.pos;
    props.checkpoints.forEach((c, i) => {
      if (i === this.cp) return;
      if (Math.hypot(c.x - p.x, c.z - p.z) > CP_RADIUS) return;
      if (Math.abs(p.y - (level.floor(c.tx, c.tz) + 1.6)) > 2.2) return;
      if (!c.active) {
        props.activateCheckpoint(i);
        this.stats.cps++;
        this.audio.checkpoint();
        this.ui.message('救生圈旁的提灯亮了。检查点。', 3.5);
      }
      this.cp = i;
    });
    if (!this.seenAbyss && level.inHall(player.tileX, player.tileZ) === 22) {
      this.seenAbyss = true;
      this.ui.message('深渊浴场。这里的水没有底。', 5);
    }
  }

  _exit() {
    const { level, player } = this;
    const c = level.ch(player.tileX, player.tileZ);
    if ((c === 'X' || c === 'E') && player.pos.z < 5.5) this.win();
  }

  _hints() {
    const h = HINTS[this.hintI];
    if (h && this.playT > h[0]) {
      this.ui.message(h[1], h[2]);
      this.hintI++;
    }
  }

  _prompt() {
    const { props, player } = this;
    if (this.state !== 'playing') return [null, 0];
    if (!this.input.locked && !DEBUG) return ['点击画面以控制视角', 0];
    if (this.valveTarget >= 0) {
      const v = props.valves[this.valveTarget];
      return [`按住 E 转动${v.name}`, v.progress];
    }
    const p = player.pos;
    if (!this.doorOpened && p.distanceTo(DOOR_POS) < 3.2) return ['加压门锁死了。泵房的阀门也许能打开它', 0];
    if (!this.gateOpened && Math.hypot(p.x - GATE_POS.x, p.z - GATE_POS.z) < 6 && p.z < 16) {
      return [this.props.gateT > 0 ? '闸门正在升起……' : `闸门紧闭 · 阀门 ${this.valvesDone()}/${props.valves.length}`, 0];
    }
    return [null, 0];
  }

  // ------------------------------------------------------------------ death & respawn
  die(info) {
    if (this.state !== 'playing') return;
    this.state = 'dying';
    this.death = info;
    this.deathT = 0;
    this.stats.deaths++;
    this.player.frozen = true;
    this.props.valves.forEach((v, i) => this.props.setValve(i, v.progress, false));
    if (info.source === 'drown') this.audio.drown();
    else this.audio.caught();
    this.player.shake = Math.max(this.player.shake, info.source === 'drown' ? 0.2 : 1);
  }

  _dyingCamera(dt) {
    const { player } = this;
    const info = this.death;
    const p = player.pos;
    if (info.maw) {
      _v.subVectors(info.maw, p);
      const d = _v.length();
      const yaw = Math.atan2(-_v.x, -_v.z);
      const pitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
      player.yaw += wrapPi(yaw - player.yaw) * Math.min(1, dt * 5);
      player.pitch += (clamp(pitch, -1.4, 1.4) - player.pitch) * Math.min(1, dt * 5);
      // dragged toward the mouth
      if (d > 1.6 && this.deathT > 0.25) p.addScaledVector(_v, Math.min(d - 1.6, dt * 5.5) / d);
    } else {
      p.y -= dt * 0.35;
      player.pitch += (0.9 - player.pitch) * Math.min(1, dt * 0.8);
    }
  }

  _dying(dt) {
    this.deathT += dt;
    const T = this.deathT;
    const drown = this.death.source === 'drown';
    this.hurt = clamp(T / 0.5, 0, 1) * (drown ? 0.35 : 0.7);
    this.fade = clamp((T - (drown ? 1.4 : 1.1)) / 1.4, 0, 1);
    if (T > 1.3 && !this.deathShown) {
      this.deathShown = true;
      const [a, b] = DEATH_TEXT[this.death.source] || DEATH_TEXT.colossus;
      this.ui.showDeath(a, b);
    }
    if (T > 4.4) this.respawn();
  }

  respawn() {
    const { player, props } = this;
    const c = props.checkpoints[this.cp];
    this.deathShown = false;
    this.death = null;
    this.drowned = false;
    player.frozen = false;
    player.spawn(c.x, c.z, c.yaw);
    this.lastPos.copy(player.pos);
    this.colossus.reset();
    this.lurkers.reset();
    this.director.reset();
    this.drifter.reset(false);
    this.leviathan.reset();
    for (const c of this.dome) c.reset(false);
    for (const d of this.domeDrifters) d.reset(false);
    this.chasing = false;
    this.chaseHold = 0;
    this.hurt = 0;
    this.state = 'playing';
    this.ui.show(null);
    this.audio.respawn();
    this.ui.message(c.start ? '你又回到了起点。' : '你在救生圈旁醒来，浑身湿冷。', 4);
  }

  win() {
    if (this.state !== 'playing') return;
    this.state = 'won';
    this.winT = 0;
    this.player.frozen = true;
    this.audio.win();
    this.audio.setTension(0);
  }

  _winning(dt) {
    this.winT += dt;
    this.player.pos.z -= dt * 0.8;
    this.player.pitch += (0.25 - this.player.pitch) * Math.min(1, dt);
    this.fade = clamp((this.winT - 0.8) / 2.2, 0, 1);
    if (this.winT > 3.4 && this.state === 'won' && !this.winShown) {
      this.winShown = true;
      this.input.enabled = false;
      this.input.exitLock();
      const s = this.stats;
      const m = Math.floor(this.playT / 60), sec = Math.floor(this.playT % 60);
      this.ui.showWin([
        ['用时', `${m} 分 ${String(sec).padStart(2, '0')} 秒`],
        ['被吞没', `${s.deaths} 次`],
        ['被发现', `${s.spotted} 次`],
        ['游过的距离', `${Math.round(s.swim)} 米`],
        ['点亮的检查点', `${s.cps} / ${this.props.checkpoints.length}`],
      ]);
    }
  }

  // ------------------------------------------------------------------ audio, HUD, post
  _audioFrame(dt) {
    const { audio, player, camera } = this;
    camera.getWorldDirection(_dir);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    audio.setListener(camera.position, _dir, _up);
    audio.setUnderwater(camera.position.y < 0);
    const threat = this.threat();
    const alert = this.colossus.aggro || this.director.chasing || this.whale?.chasing || this.crab?.chasing;
    this.spottedCool -= dt;
    if (alert) {
      this.chaseHold = 2.5;
      if (!this.chasing && this.state === 'playing') {
        this.chasing = true;
        audio.chaseStart();
      }
    } else if (this.chasing) {
      this.chaseHold -= dt;
      if (this.chaseHold <= 0) {
        this.chasing = false;
        if (this.state === 'playing') audio.lostThem();
      }
    }
    if (this.state === 'won') {
      audio.setTension(0);
      audio.setHeartbeat(0);
    } else {
      audio.setTension(this.chasing ? Math.max(0.85, threat) : threat);
      const breath = player.breath / player.breathMax;
      audio.setHeartbeat(Math.max(clamp((threat - 0.3) / 0.7, 0, 1), player.underwater ? clamp((0.35 - breath) / 0.35, 0, 1) : 0));
    }
    audio.setBreath(player.breath / player.breathMax);
    audio.update(dt);
  }

  threat() {
    let k = Math.max(this.colossus.threat, this.director.threat, this.lurkers.threat || 0, this.drifter.threat, this.leviathan.threat);
    for (const c of this.dome) k = Math.max(k, c.threat);
    for (const d of this.domeDrifters) k = Math.max(k, d.threat);
    return k;
  }

  _hud(dt) {
    const { player } = this;
    const [prompt, progress] = this._prompt();
    this.ui.updateHud(dt, {
      breath: player.breath / player.breathMax,
      showBreath: this.state === 'playing' && (player.underwater || player.breath < player.breathMax - 0.5),
      // the eye tracks being noticed, not the ambient presence of an awake creature (<= 0.3)
      threat: this.state === 'playing' ? clamp((this.threat() - 0.3) / 0.7, 0, 1) : 0,
      alert: this.chasing,
      valves: this.valvesDone(),
      valvesTotal: this.props.valves.length,
      prompt,
      progress,
      depth: this.state === 'playing' && player.depthWarn > 0,
      flashlight: player.flashlight,
    });
  }

  _postFx(dt, t) {
    const { post, player, camera } = this;
    const u = post.u;
    const playing = this.state !== 'title';
    if (this.state === 'playing' || this.state === 'title') {
      this.fade = damp(this.fade, 0, 1.6, dt);
      this.hurt = damp(this.hurt, 0, 2, dt);
    }
    const alert = this.chasing;
    const target = playing ? (alert ? 0.55 + 0.35 * this.threat() : this.threat() * 0.35) : 0;
    this.danger = damp(this.danger, target, 3, dt);
    this.under = damp(this.under, camera.position.y < 0 ? 1 : 0, 10, dt);
    this.surfaceFx = Math.max(0, this.surfaceFx - dt * 0.6);
    u.uTime.value = t;
    u.uUnder.value = this.under;
    u.uDanger.value = this.danger;
    u.uFade.value = this.fade;
    u.uHurt.value = this.hurt;
    u.uBreath.value = playing && player.underwater ? player.breath / player.breathMax : 1;
    u.uSurface.value = this.surfaceFx;

    // flashlight: a slightly lagging beam from the right shoulder
    const on = playing && player.flashlight && this.state !== 'won' ? 1 : 0;
    this.flOn = damp(this.flOn, on, 14, dt);
    camera.getWorldDirection(_dir);
    _fl.copy(G.uFlDir.value).lerp(_dir, 1 - Math.exp(-12 * dt)).normalize();
    G.uFlDir.value.copy(_fl);
    _v.set(0.18, -0.2, 0).applyQuaternion(camera.quaternion);
    G.uFlPos.value.copy(camera.position).add(_v);
    const flick = Math.sin(t * 61) * Math.sin(t * 17.3) > 0.985 ? 0.4 : 1;
    G.uFlOn.value = this.flOn * flick;
  }
}

const ui = new UI();
const game = new Game(ui);
game.boot().catch((err) => {
  console.error(err);
  ui.showError();
});
