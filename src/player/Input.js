// Keyboard + pointer-lock mouse input.
//
// Everything downstream of this file — movement, mining, placing, eating,
// drawing a bow — is written against four things: `keys`, `mouseDX/DY`,
// `buttons` and `clicked`, and every one of the action paths in main.js is
// additionally gated on `locked`. That gate is not paranoia, it is what stops a
// click on the pause menu from also swinging the axe behind it.
//
// It is also why the game was unplayable on a phone. Pointer Lock does not
// exist on a touch device: `requestPointerLock` rejects with NotAllowedError,
// `locked` never becomes true, `_onMouseMove` returns at its first line, and
// every `input.clicked[n] && input.locked` in main.js is false forever. Look,
// mine and place were not broken by a bug; they were absent by construction.
//
// Rather than thread a second input model through nine thousand lines of
// consumers, touch mode makes this object tell the same four lies a locked
// mouse tells: `locked` is true, the deltas arrive in `mouseDX/DY`, the buttons
// go down and up, and synthetic key codes stand in for the keys a thumb has no
// room for. TouchControls.js is the only thing that writes them. The consumers
// never learn the difference, which is the point — desktop behaviour is
// untouched because none of the desktop paths are edited at all.
export class Input {
  constructor(domElement) {
    this.dom = domElement;
    /** Touch mode: set once by TouchControls, never unset. See the note above. */
    this.touch = false;
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
    // The three mouse handlers bail in touch mode. `locked` is forced true
    // there, so without this gate the compatibility mouse events a browser
    // synthesises after a tap — Chrome fires a mousedown/mouseup pair at the
    // release point unless the touch was preventDefault'd, and one slipping
    // through is enough — would land as a real click and mine whatever the
    // crosshair happened to be on. The touch layer preventDefaults as well;
    // this is the belt to that pair of braces.
    this._onMouseMove = (e) => {
      if (!this.locked || this.touch) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (!this.locked || this.touch) return;
      this.buttons[e.button] = true;
      this.clicked[e.button] = true;
    };
    this._onMouseUp = (e) => { if (!this.touch) this.buttons[e.button] = false; };
    this._onWheel = (e) => { if (this.locked && !this.touch) { this.wheel += Math.sign(e.deltaY); e.preventDefault(); } };
    this._onLockChange = () => {
      // Never in touch mode. It cannot legitimately fire there — nothing ever
      // holds the lock — but if some other page on the same document did take
      // it and drop it, this would read `locked = false` and main.js's
      // `onLockChange` would pause the game under the player's thumbs.
      if (this.touch) return;
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

  /**
   * Enter touch mode, permanently. Called once, by TouchControls, only when the
   * device actually has a coarse pointer.
   *
   * `locked` going true here is the whole trick: it is read as "the player is
   * driving the world rather than a menu" by every action in main.js, and on a
   * phone that is true from the moment the world is up. The menus do not need
   * it turned off again, because they are DOM overlays that cover the touch
   * layer and the layer hides itself under them.
   */
  enableTouch() {
    this.touch = true;
    this.locked = true;
    this.buttons = [false, false, false];
    this.keys.clear();
  }

  // Both no-ops in touch mode. `requestLock` in particular is called from a
  // dozen places in main.js and UI.js on paths a phone still walks — closing
  // the inventory, clicking a hotbar cell — and on a touch device each one
  // would be a rejected promise and a NotAllowedError in the console.
  requestLock() { if (!this.touch) this.dom.requestPointerLock?.(); }
  exitLock() { if (!this.touch) document.exitPointerLock?.(); }

  // --- what the touch layer writes ------------------------------------------
  // Synthetic keys, so a thumb-sized button can stand in for a key that the
  // rest of the game already knows how to read. `hold` is for anything the game
  // samples per frame (Space to keep swimming up, Ctrl to stay crouched); `tap`
  // is for the one-shot `pressed()` reads (E, Escape). A tap sets `justPressed`
  // without ever entering `keys`, because `endFrame` clears the first and not
  // the second, and a key that went down and never came up would jam.

  /** Hold or release a synthetic key. Idempotent, so a repeat is free. */
  hold(code, down) {
    if (down) {
      if (!this.keys.has(code)) { this.justPressed.add(code); this.keys.add(code); }
    } else this.keys.delete(code);
  }

  /** Fire a synthetic key for exactly one frame. */
  tap(code) { this.justPressed.add(code); }

  down(code) { return this.keys.has(code); }
  pressed(code) { return this.justPressed.has(code); }

  endFrame() {
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    this.justPressed.clear();
    this.clicked = [false, false, false];
  }
}
