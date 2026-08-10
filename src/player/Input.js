// Keyboard + pointer-lock mouse input.

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.buttons = [false, false, false];
    this.justPressed = new Set();
    this.clicked = [false, false, false];
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const c = e.code;
      if (!this.keys.has(c)) this.justPressed.add(c);
      this.keys.add(c);
      if (['Space', 'Tab', 'F3', 'F5'].includes(c) && this.locked) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (!this.locked) return;
      this.buttons[e.button] = true;
      this.clicked[e.button] = true;
    };
    this._onMouseUp = (e) => { this.buttons[e.button] = false; };
    this._onWheel = (e) => { if (this.locked) { this.wheel += Math.sign(e.deltaY); e.preventDefault(); } };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) { this.keys.clear(); this.buttons = [false, false, false]; }
      this.onLockChange?.(this.locked);
    };
    this._onBlur = () => { this.keys.clear(); this.buttons = [false, false, false]; };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  requestLock() { this.dom.requestPointerLock?.(); }
  exitLock() { document.exitPointerLock?.(); }

  down(code) { return this.keys.has(code); }
  pressed(code) { return this.justPressed.has(code); }

  endFrame() {
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    this.justPressed.clear();
    this.clicked = [false, false, false];
  }
}
