/** Keyboard + pointer-lock mouse input with edge detection. */
export class Input {
  constructor(el) {
    this.el = el;
    this.down = new Set();
    this.pressed = new Set();
    this.dx = 0;
    this.dy = 0;
    this.sens = 1;
    this.invertY = false;
    this.locked = false;
    this.enabled = false;
    this.mouseDown = false;
    this.onLockChange = null;

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.ctrlKey && e.code === 'KeyW') e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.down.delete(e.code); });
    window.addEventListener('blur', () => { this.down.clear(); this.mouseDown = false; });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // clamp spikes that some browsers emit on lock
      this.dx += Math.max(-250, Math.min(250, e.movementX));
      this.dy += Math.max(-250, Math.min(250, e.movementY));
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) { this.mouseDown = true; this.pressed.add('Mouse0'); }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseDown = false; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) this.down.clear();
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  requestLock() {
    if (this.locked) return;
    try {
      const p = this.el.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => { this.locked = false; });
    } catch {
      this.locked = false;
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  key(code) { return this.down.has(code); }
  hit(code) { return this.pressed.has(code); }
  any(...codes) { return codes.some((c) => this.down.has(c)); }
  anyHit(...codes) { return codes.some((c) => this.pressed.has(c)); }

  consumeMouse() {
    const d = [this.dx * this.sens, this.dy * this.sens * (this.invertY ? -1 : 1)];
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  endFrame() { this.pressed.clear(); }
}
