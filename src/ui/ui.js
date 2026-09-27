// DOM overlay: loading, title and pause menus, settings/help dialogs, death and win screens, HUD.
// Everything is static markup in index.html; this module only toggles and fills it (textContent only).

const STORE_KEY = 'drowned-halls.settings';
export const DEFAULT_SETTINGS = { quality: 'medium', sens: 1, fov: 72, volume: 0.8, invertY: false };
const QUALITIES = ['low', 'medium', 'high'];

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function loadSettings() {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return s;
    const v = JSON.parse(raw);
    if (QUALITIES.includes(v.quality)) s.quality = v.quality;
    if (Number.isFinite(v.sens)) s.sens = clamp(v.sens, 0.3, 2.5);
    if (Number.isFinite(v.fov)) s.fov = clamp(v.fov, 60, 95);
    if (Number.isFinite(v.volume)) s.volume = clamp(v.volume, 0, 1);
    s.invertY = v.invertY === true;
  } catch (err) {
    console.warn('settings: could not read saved settings', err);
  }
  return s;
}

function saveSettings(s) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch (err) {
    console.warn('settings: could not save settings', err);
  }
}

export class UI {
  constructor() {
    this.settings = loadSettings();
    this.handlers = {};
    this.modal = null;
    this.modalTrigger = null;
    this.msgTimer = 0;
    this.hudCache = {};
    this.screens = ['loading', 'title', 'pause', 'death', 'win', 'error'].reduce((o, id) => ((o[id] = $(id)), o), {});
    this.hud = {
      root: $('hud'),
      valves: $('hud-valves'),
      valvesN: $('hud-valves').querySelector('b'),
      valvesT: $('hud-valves').querySelector('span'),
      eye: $('hud-eye'),
      pupil: $('hud-eye').querySelector('.eye-pupil'),
      lid: $('hud-eye').querySelector('.eye-lid'),
      breath: $('hud-breath'),
      breathFill: $('hud-breath-fill'),
      prompt: $('hud-prompt'),
      promptText: $('hud-prompt-text'),
      ring: $('hud-ring'),
      depth: $('hud-depth'),
      msg: $('hud-msg'),
      flash: $('hud-flash'),
    };
    this._bindMenus();
    this._bindSettings();
    document.addEventListener('keydown', (e) => this._modalKey(e), true);
  }

  /** name → callback: start, resume, restart, quit, again, settings(settings), hover, click */
  on(name, fn) { this.handlers[name] = fn; }
  _emit(name, arg) { if (this.handlers[name]) this.handlers[name](arg); }

  // ------------------------------------------------------------------ screens
  setLoading(p, text) {
    const v = Math.round(clamp(p, 0, 1) * 100);
    $('load-fill').style.width = `${v}%`;
    $('load-bar').setAttribute('aria-valuenow', String(v));
    if (text) $('load-step').textContent = text;
  }

  /** Show one full-screen layer (or none) and the HUD when playing. */
  show(name) {
    for (const [id, el] of Object.entries(this.screens)) {
      const on = id === name;
      el.hidden = !on;
      if (id === 'loading') el.setAttribute('aria-busy', on ? 'true' : 'false');
    }
    this.hud.root.hidden = !(name === null || name === 'death');
    const first = { title: 'btn-start', pause: 'btn-resume', win: 'btn-again' }[name];
    if (first) $(first).focus({ preventScroll: true });
  }

  showError() { this.show('error'); }

  setObjective(text) { $('pause-objective').textContent = text; }

  showDeath(title, sub) {
    $('death-title').textContent = title;
    $('death-sub').textContent = sub;
    this.show('death');
  }

  /** stats: [[label, value], ...] */
  showWin(stats) {
    const dl = $('win-stats');
    dl.replaceChildren();
    for (const [k, v] of stats) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    this.show('win');
  }

  _bindMenus() {
    const click = (id, fn) => $(id).addEventListener('click', () => { this._emit('click'); fn(); });
    click('btn-start', () => this._emit('start'));
    click('btn-resume', () => this._emit('resume'));
    click('btn-restart', () => this._emit('restart'));
    click('btn-quit', () => this._emit('quit'));
    click('btn-again', () => this._emit('again'));
    click('btn-win-title', () => this._emit('quit'));
    for (const id of ['btn-settings', 'btn-settings2']) click(id, () => this.openModal('settings', $(id)));
    for (const id of ['btn-help', 'btn-help2']) click(id, () => this.openModal('help', $(id)));
    click('settings-close', () => this.closeModal());
    click('help-close', () => this.closeModal());
    for (const b of document.querySelectorAll('button')) {
      b.addEventListener('mouseenter', () => this._emit('hover'));
    }
    for (const m of ['settings', 'help']) {
      $(m).addEventListener('mousedown', (e) => { if (e.target === $(m)) this.closeModal(); });
    }
  }

  // ------------------------------------------------------------------ dialogs
  openModal(id, trigger) {
    if (this.modal) this.closeModal();
    this.modal = $(id);
    this.modalTrigger = trigger || document.activeElement;
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    if (id === 'settings') this._fillSettings();
    this.modal.hidden = false;
    const first = this.modal.querySelector(FOCUSABLE);
    if (first) first.focus({ preventScroll: true });
  }

  closeModal() {
    if (!this.modal) return;
    this.modal.hidden = true;
    this.modal = null;
    const t = this.modalTrigger;
    this.modalTrigger = null;
    if (t) {
      t.setAttribute('aria-expanded', 'false');
      if (typeof t.focus === 'function') t.focus({ preventScroll: true });
    }
  }

  get modalOpen() { return !!this.modal; }

  _modalKey(e) {
    if (!this.modal) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeModal();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = [...this.modal.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el.type === 'radio');
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!this.modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  // ------------------------------------------------------------------ settings
  _fillSettings() {
    const f = $('settings-form');
    const s = this.settings;
    for (const r of f.elements.quality) r.checked = r.value === s.quality;
    f.elements.sens.value = String(s.sens);
    f.elements.fov.value = String(s.fov);
    f.elements.volume.value = String(s.volume);
    f.elements.invertY.checked = s.invertY;
    this._outputs();
  }

  _outputs() {
    const f = $('settings-form');
    f.elements.sensOut.value = Number(f.elements.sens.value).toFixed(2);
    f.elements.fovOut.value = `${f.elements.fov.value}°`;
    f.elements.volOut.value = `${Math.round(Number(f.elements.volume.value) * 100)}`;
  }

  _bindSettings() {
    const f = $('settings-form');
    f.addEventListener('submit', (e) => e.preventDefault());
    const apply = () => {
      const q = [...f.elements.quality].find((r) => r.checked);
      this.settings = {
        quality: q ? q.value : this.settings.quality,
        sens: clamp(Number(f.elements.sens.value) || 1, 0.3, 2.5),
        fov: clamp(Number(f.elements.fov.value) || 72, 60, 95),
        volume: clamp(Number(f.elements.volume.value), 0, 1),
        invertY: f.elements.invertY.checked,
      };
      this._outputs();
      saveSettings(this.settings);
      this._emit('settings', this.settings);
    };
    f.addEventListener('input', apply);
    f.addEventListener('change', apply);
  }

  // ------------------------------------------------------------------ HUD
  message(text, seconds = 4) {
    const m = this.hud.msg;
    m.textContent = text;
    m.classList.add('show');
    this.msgTimer = seconds;
  }

  clearMessage() {
    this.msgTimer = 0;
    this.hud.msg.classList.remove('show');
  }

  _set(key, value, fn) {
    if (this.hudCache[key] === value) return;
    this.hudCache[key] = value;
    fn(value);
  }

  /**
   * s: { breath (0..1), showBreath, threat (0..1), alert, valves, valvesTotal, prompt (text|null), progress (0..1),
   *      depth, flashlight }
   */
  updateHud(dt, s) {
    const h = this.hud;
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) h.msg.classList.remove('show');
    }
    const b = Math.round(clamp(s.breath, 0, 1) * 100);
    this._set('breath', b, (v) => {
      h.breathFill.style.transform = `scaleX(${v / 100})`;
      h.breath.setAttribute('aria-valuenow', String(v));
    });
    this._set('breathShow', s.showBreath, (v) => h.breath.classList.toggle('show', v));
    this._set('breathLow', s.breath < 0.3, (v) => h.breath.classList.toggle('low', v));

    const th = Math.round(clamp(s.threat, 0, 1) * 20) / 20;
    this._set('threat', th, (v) => {
      h.eye.style.opacity = v < 0.05 ? '0' : String(0.35 + 0.65 * v);
      h.pupil.setAttribute('rx', String(1.5 + v * 5));
      h.lid.setAttribute('d', `M2 16 Q32 ${16 - 20 * (0.25 + 0.75 * v)} 62 16 Q32 ${16 + 20 * (0.25 + 0.75 * v)} 2 16 Z`);
    });
    this._set('alert', !!s.alert, (v) => h.eye.classList.toggle('alert', v));

    this._set('valvesTotal', s.valvesTotal, (v) => { h.valvesT.textContent = String(v); });
    this._set('valves', s.valves, (v) => {
      h.valvesN.textContent = String(v);
      h.valves.classList.toggle('done', v >= s.valvesTotal);
    });

    this._set('prompt', s.prompt || '', (v) => {
      h.prompt.hidden = !v;
      h.promptText.textContent = v;
    });
    const pr = Math.round(clamp(s.progress || 0, 0, 1) * 50) / 50;
    this._set('progress', pr, (v) => {
      h.ring.style.setProperty('--p', String(v));
      h.ring.style.visibility = v > 0 ? 'visible' : 'hidden';
    });
    this._set('depth', !!s.depth, (v) => { h.depth.hidden = !v; });
    this._set('flash', !!s.flashlight, (v) => h.flash.classList.toggle('on', v));
  }
}
