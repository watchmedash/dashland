/**
 * The phone. A thumbstick, a look surface, and the five buttons a hand can
 * reach without letting go of the device.
 *
 * WHY THIS FILE EXISTS, in one paragraph, because the reason is not obvious
 * from the diff: the game's entire input model is pointer lock plus mousemove
 * deltas, and pointer lock does not exist on a touch device. `requestPointerLock`
 * rejects, `Input.locked` never goes true, `_onMouseMove` returns at its first
 * line, and every action in main.js is written as `input.clicked[n] &&
 * input.locked`. Look was dead, mine and place were dead with it, and no amount
 * of tapping could revive any of them. Measured rather than assumed: thirteen
 * trusted `touchmove` events across the canvas moved the camera by exactly
 * zero, and produced zero `mousemove`s to move it with.
 *
 * The fix is deliberately not a second input model. This file writes into the
 * same four fields a locked mouse writes into — `keys`, `mouseDX/DY`, `buttons`,
 * `clicked` — and `Input.enableTouch()` forces `locked` true. Every consumer
 * downstream is byte-identical, on both platforms, because none of them were
 * edited. See the header of Input.js.
 *
 * WHAT WAS TRIED AND REJECTED
 *
 *   Tap-to-place and long-press-to-mine on the look surface. It is the obvious
 *   scheme and it is wrong here for two reasons. Mining is a *hold*: main.js
 *   samples `buttons[0]` every frame and a block takes a second or more, so the
 *   gesture has to survive the thumb drifting, which a long-press does not.
 *   And placing has to be aimable — the raycast goes through the crosshair at
 *   screen centre, not through the touch point — so a tap that both aims and
 *   commits cannot exist. Dragging to aim and then pressing a button is the
 *   only shape that works. Dedicated buttons also keep the look surface pure,
 *   which matters more than it sounds: a surface that sometimes commits an
 *   action is a surface you stop dragging confidently.
 *
 *   An analogue stick feeding a float. Movement in main.js is four boolean key
 *   reads (`KeyW`/`KeyA`/`KeyS`/`KeyD`) and a fifth for sprint. There is no
 *   analogue axis to feed, and inventing one would mean editing Player. The
 *   stick therefore quantises to the same eight directions a keyboard has, and
 *   spends its remaining information on the one analogue thing the game does
 *   have: pushed past the rim is a sprint.
 *
 * The art is Kenney's Mobile Controls (CC0), shipped as nine SVGs under
 * `public/touch/`. They are used as `mask-image`, not as `img`: the sprites are
 * flat white, and masking lets the same wood, brass and ink line the rest of the
 * HUD is built from paint straight through them. A grey Kenney button laid over
 * this HUD reads as a different game's overlay; the same silhouette cut out of
 * brass reads as part of it.
 */

/** Pixels of drag per pixel of mouse movement. A mouse hand travels much
 *  further than a thumb pinned to a screen, so the raw delta is far too slow at
 *  the shared `Input.sensitivity`. Multiplied here rather than by raising that
 *  constant, so the desktop feel and the player's own sensitivity setting (which
 *  still multiplies both) are untouched. */
const LOOK_GAIN = 2.6;

/** Stick radius in CSS px, and the two thresholds on it. Inside DEAD the stick
 *  is centred; past SPRINT it is also holding Shift. */
const STICK_R = 52;
const DEAD = 0.24;
const SPRINT = 0.86;

/** Is the app being drawn side-on inside an upright window?
 *
 *  The stylesheet turns `#app` a quarter turn on a portrait touch device, which
 *  the browser handles for hit testing - a button is where it looks - but not
 *  for coordinates. `clientX/Y` stay the *window's*, so a thumb dragged towards
 *  the top of the phone as the player holds it arrives here as a drag to the
 *  left, and both the look surface and the stick read raw deltas. This is the
 *  one media query in the game that JavaScript has to agree with; it is the same
 *  condition as the last block of style.css and has to stay that way. */
const rotated = () =>
  matchMedia('(orientation: portrait) and (pointer: coarse)').matches;

/** Turn a window-space delta back into an app-space one. `rotate(90deg)` sends
 *  app (x, y) to window (-y, x), so the way back is (y, -x). */
function unrotate(dx, dy) {
  return rotated() ? { dx: dy, dy: -dx } : { dx, dy };
}

/** Hold a hotbar cell this long and it starts dropping, then keeps dropping at
 *  this rate. 420ms is long enough that nobody selecting a slot ever reaches it
 *  — a tap is under 150ms — and short enough that it does not feel stuck.
 *  The repeat is what makes it usable at all: `_dropHeld` throws one item, and
 *  sixty-four separate long-presses to put down a stack of cobble is not a
 *  control, it is a punishment. */
const DROP_DELAY = 420;
const DROP_REPEAT = 190;
/** How far the thumb may wander and still be holding the cell, in CSS px. */
const DROP_SLOP = 16;

export class TouchControls {
  /**
   * Returns true only for a device whose *primary* pointer is a finger.
   *
   * Both halves are load-bearing and neither is enough alone. `maxTouchPoints`
   * is non-zero on any laptop with a touchscreen, and a small desktop window is
   * not a phone, so viewport width is out of the question as a test. `pointer:
   * coarse` is the browser's own answer to "is the thing driving this a
   * fingertip", and on a Surface it flips with the keyboard cover: docked it is
   * fine and the game stays on mouse and keyboard, folded back it is coarse and
   * the thumbs get their controls. That is the correct answer in both cases.
   *
   * `?touch=1` and `?touch=0` force it either way. That is not a debug hook we
   * forgot to remove: it is the escape hatch for the device that reports the
   * wrong thing, and a game that ships to phones will meet one.
   */
  static wanted() {
    const q = new URLSearchParams(location.search).get('touch');
    if (q === '1' || q === 'true') return true;
    if (q === '0' || q === 'false') return false;
    return (navigator.maxTouchPoints || 0) > 0
      && window.matchMedia?.('(pointer: coarse)').matches === true;
  }

  constructor(game) {
    this.game = game;
    this.input = game.input;
    this.input.enableTouch();
    document.body.classList.add('touch');

    /** pointerId -> the widget holding it, and how to let it go. One thumb per
     *  entry, so the stick and the look drag genuinely run at the same time
     *  rather than the second touch stealing the first one's element. */
    this.claims = new Map();
    /** Sneak is a toggle, not a hold. A hold would need a third thumb: on a
     *  phone the left one is on the stick and the right one is on the look
     *  surface for the whole of any moment you would want to sneak through. */
    this.sneak = false;
    this._shown = null;
    /** The hotbar cell being held down, if any. See `_wireHotbar`. */
    this._drop = null;

    this._build();
    this._wire();

    // Two words on a screen the player will open once. "Mouse" over a
    // sensitivity slider on a phone is simply wrong, and the slider is the one
    // setting a thumb genuinely needs to reach.
    const h = document.getElementById('set-head-look');
    if (h) h.textContent = 'Look';
  }

  // --- markup ---------------------------------------------------------------

  _build() {
    const root = document.createElement('div');
    root.id = 'touch';
    // Below #hud rather than above it, so the hotbar keeps its taps. The rack
    // and the offhand cell are the only things in the HUD that take a pointer
    // at all, and the look surface spans the whole screen; if the surface won
    // that overlap you could no longer choose what is in your hand.
    root.className = 'hidden';

    // The look surface is first in the tree and so lowest in it: everything
    // else sits on top and takes its own touches out of the drag.
    this.look = document.createElement('div');
    this.look.id = 'tc-look';
    root.appendChild(this.look);

    // ---- stick -------------------------------------------------------------
    this.stick = document.createElement('div');
    this.stick.id = 'tc-stick';
    this.nub = document.createElement('i');
    this.nub.className = 'tc-nub';
    this.stick.appendChild(this.nub);
    root.appendChild(this.stick);

    // ---- buttons -----------------------------------------------------------
    // Labels are one word or none. A button whose glyph is a hand does not also
    // need to say what a hand does.
    this.buttons = {};
    const mk = (id, icon, label, cls) => {
      const b = document.createElement('button');
      b.id = `tc-${id}`;
      b.className = `tc-btn ${cls || ''}`;
      b.type = 'button';
      b.setAttribute('aria-label', label);
      const i = document.createElement('i');
      i.className = `tc-ico ic-${icon}`;
      b.appendChild(i);
      root.appendChild(b);
      this.buttons[id] = b;
      return b;
    };
    mk('mine', 'mine', 'Mine', 'big');
    mk('use', 'use', 'Place', 'big');
    mk('jump', 'jump', 'Jump');
    mk('sneak', 'arrow down', 'Sneak');
    mk('bag', 'bag', 'Inventory', 'chip');
    mk('pause', 'pause', 'Pause', 'chip');

    document.body.appendChild(root);
    this.root = root;
  }

  // --- claims ---------------------------------------------------------------

  /**
   * Hand a pointer to a widget, taking it off whoever had it.
   *
   * The steal is the point. A pointer id cannot legitimately go down twice
   * without coming up in between, so a claim still standing when the same id
   * arrives again is stale by definition — a `pointercancel` the browser
   * swallowed while it decided whether a gesture was its own, which is exactly
   * what happens on iOS when a drag starts near the bottom edge. Without this
   * the stale entry never clears, the guard at the top of every handler rejects
   * that id forever, and one of the player's two thumbs quietly stops working
   * for the rest of the session. Ids are not unique for long, either: Safari
   * recycles small integers, so this is reachable in ordinary play and not only
   * after a lost cancel.
   */
  _take(e, rec) {
    this.claims.get(e.pointerId)?.release?.();
    this.claims.set(e.pointerId, rec);
  }

  /** Release a pointer, if this widget is the one holding it. */
  _give(e, kind) {
    const c = this.claims.get(e.pointerId);
    if (!c || (kind && c.kind !== kind)) return false;
    this.claims.delete(e.pointerId);
    c.release?.();
    return true;
  }

  // --- events ---------------------------------------------------------------

  _wire() {
    // Pointer events rather than touch events, for the ids. Multi-touch here is
    // not a nicety — walking while looking is two thumbs down at once — and
    // `TouchList` bookkeeping to work out which finger moved is exactly what
    // `pointerId` already is. `setPointerCapture` then keeps a drag attached to
    // the widget it started on even once the thumb has slid off it, which on a
    // 52px stick is most drags.

    // The world under everything. Nothing here should ever scroll the page,
    // select text, raise a context menu or zoom; `touch-action: none` in the
    // stylesheet stops the first and third, and these stop the rest.
    const kill = (e) => e.preventDefault();
    document.addEventListener('contextmenu', kill);
    // iOS Safari has no `touch-action` answer to the double-tap zoom on some
    // versions, and `user-scalable=no` is ignored there by policy. A second tap
    // inside 300ms of the first, anywhere on the control layer, is swallowed.
    let lastTap = 0;
    this.root.addEventListener('touchend', (e) => {
      const now = performance.now();
      if (now - lastTap < 320) e.preventDefault();
      lastTap = now;
    }, { passive: false });

    // ---- look --------------------------------------------------------------
    this.look.addEventListener('pointerdown', (e) => {
      this._take(e, { kind: 'look', x: e.clientX, y: e.clientY });
      this.look.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.look.addEventListener('pointermove', (e) => {
      const c = this.claims.get(e.pointerId);
      if (!c || c.kind !== 'look') return;
      // Straight into the same accumulator a locked mouse fills. main.js reads
      // it once a frame and `endFrame` zeroes it, so several moves between two
      // frames add up rather than the last one winning, which is what keeps a
      // fast flick from being quantised down to one frame's worth.
      this.input.mouseDX += (e.clientX - c.x) * LOOK_GAIN;
      this.input.mouseDY += (e.clientY - c.y) * LOOK_GAIN;
      c.x = e.clientX; c.y = e.clientY;
      e.preventDefault();
    });
    const endLook = (e) => this._give(e, 'look');
    this.look.addEventListener('pointerup', endLook);
    this.look.addEventListener('pointercancel', endLook);

    // ---- stick -------------------------------------------------------------
    this.stick.addEventListener('pointerdown', (e) => {
      const r = this.stick.getBoundingClientRect();
      this._take(e, {
        kind: 'stick', cx: r.left + r.width / 2, cy: r.top + r.height / 2,
        release: () => {
          this.stick.classList.remove('on');
          this._walk(0, 0, false);
          this.nub.style.transform = '';
        },
      });
      this.stick.setPointerCapture(e.pointerId);
      this.stick.classList.add('on');
      this._stick(e);
      e.preventDefault();
    });
    this.stick.addEventListener('pointermove', (e) => {
      const c = this.claims.get(e.pointerId);
      if (c && c.kind === 'stick') { this._stick(e); e.preventDefault(); }
    });
    const endStick = (e) => this._give(e, 'stick');
    this.stick.addEventListener('pointerup', endStick);
    this.stick.addEventListener('pointercancel', endStick);

    // ---- buttons -----------------------------------------------------------
    // Mine and Place are holds, because both of them are: a block takes many
    // frames to break and main.js reads `buttons[0]` on every one of them, and
    // `buttons[2]` held is what eats food, draws a bow and keeps a line of
    // saplings going down. The `clicked` flag on press is what the one-shot
    // uses (a door, a bed, a merchant) read instead, and setting both is
    // exactly what a real mouse button does.
    this._holdBtn(this.buttons.mine, 0);
    this._holdBtn(this.buttons.use, 2);
    this._keyBtn(this.buttons.jump, 'Space');
    // Escape and E go through `justPressed` for one frame, which is how the
    // keyboard delivers them, so the same handler in main.js opens the same
    // screen with the same swallow-the-key logic.
    // The bag taps to the inventory and holds to Growth. See `_tapHoldBtn`.
    this._tapHoldBtn(this.buttons.bag, 'KeyE', 'KeyK');
    this._tapBtn(this.buttons.pause, 'Escape');
    this._toggleBtn(this.buttons.sneak);

    this._wireHotbar();
  }

  /**
   * Hold a hotbar cell to drop what is in it. Q, for a thumb.
   *
   * There was no way to put anything down at all on a phone: `Q` is the only
   * drop there is, `KeyQ` is read once a frame in `_interact`, and a thumb has
   * no keyboard. That is not an edge case — you pick up forty cobble clearing a
   * doorway and you are carrying them for the rest of the session.
   *
   * A sixth thumb button was the obvious answer and it is the wrong one. The
   * right hand already has four buttons and two of them are pressed constantly;
   * a fifth in reach would be pressed by accident, and one out of reach is one
   * you never use. The hotbar cell is already on screen, already the size of a
   * thumb, and already takes a tap — and it is the thing the drop is *about*,
   * so the gesture points at its own target. The count in the corner going down
   * is the confirmation, which is why nothing else is drawn to say it happened.
   *
   * The cell is selected first, exactly as the tap would have, so holding a
   * cell that is not the live one drops that cell rather than the live one.
   * `_dropHeld` only knows how to drop what is in your hand.
   *
   * Nothing here is preventDefault'd, and that is deliberate: the browser's
   * synthesised click is what selects the slot on an ordinary tap, and killing
   * the default would kill that with it. The long-press callout, the selection
   * and the context menu — the three things a hold would otherwise raise — are
   * already off, in `body.touch` and in the contextmenu handler above.
   */
  _wireHotbar() {
    const slots = this.game.ui?.hudSlots;
    if (!slots) return;
    slots.forEach((el, i) => {
      el.addEventListener('pointerdown', (e) => this._armDrop(el, i, e));
      // A thumb that wanders is a thumb that meant something else, so past a
      // finger's width of slop the hold is off. This is a `pointermove` test
      // and not `pointerleave` on purpose: a touch pointer is implicitly
      // captured by whatever it went down on, so the boundary events do not
      // fire until the finger lifts, by which time the drop has already run.
      el.addEventListener('pointermove', (e) => {
        const d = this._drop;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DROP_SLOP) this._cancelDrop();
      });
      const off = () => this._cancelDrop();
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
    });
  }

  _armDrop(el, i, e) {
    this._cancelDrop();
    const fire = () => {
      // Through the same two fields the keyboard uses: the selection the digit
      // keys write, and a `justPressed` Q. Every guard main.js puts on dropping
      // — no screen open, not a spectator, not dead — is therefore still in
      // force, because this is not a second path to it.
      this.game.inventory.selected = i;
      this.game.ui.refresh();
      this.input.tap('KeyQ');
    };
    this._drop = {
      el, x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        el.classList.add('tc-drop');
        // One short pulse, on the first drop only. It is the only signal that
        // the hold has been *taken*; after that the falling count says it. A
        // buzz per repeat would be a phone vibrating continuously while a stack
        // empties. Ignored on iOS, which has no Vibration API.
        navigator.vibrate?.(12);
        fire();
        this._drop.timer = setInterval(fire, DROP_REPEAT);
      }, DROP_DELAY),
    };
  }

  /** Stop a drop, armed or already running. `clearTimeout` and `clearInterval`
   *  are the same id space, so one call clears whichever this is. */
  _cancelDrop() {
    if (!this._drop) return;
    clearTimeout(this._drop.timer);
    clearInterval(this._drop.timer);
    this._drop.el.classList.remove('tc-drop');
    this._drop = null;
  }

  /**
   * A button that stays down for as long as the thumb is on it.
   *
   * `off` is stored on the claim rather than run from the pointerup handler, so
   * that a lost pointerup — the browser taking the gesture, the app going to the
   * background mid-press, the layer being hidden because a screen opened — still
   * releases it. A held Mine that is never released is a player mining a hole
   * through the planet from inside the inventory screen.
   */
  _pressBtn(el, off, on) {
    el.addEventListener('pointerdown', (e) => {
      this._take(e, { kind: 'btn', release: () => { el.classList.remove('on'); off(); } });
      el.setPointerCapture(e.pointerId);
      el.classList.add('on');
      on();
      e.preventDefault();
    });
    const up = (e) => this._give(e, 'btn');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** A mouse button, held. `clicked` on press as well, exactly as a real one. */
  _holdBtn(el, which) {
    this._pressBtn(el,
      () => { this.input.buttons[which] = false; },
      () => { this.input.buttons[which] = true; this.input.clicked[which] = true; });
  }

  /** A key, held. Space has to be a hold: it is also swim-up and climb. */
  _keyBtn(el, code) {
    this._pressBtn(el, () => this.input.hold(code, false), () => this.input.hold(code, true));
  }

  /**
   * A button with a second screen behind a hold of it. The bag, and Growth.
   *
   * The skill tree was unreachable on a phone. It is on `K`, `K` is the only
   * way in, and a thumb has no keyboard — while the game went on raising a
   * toast telling the player to press it every time they earned a point. Two
   * defects in one: the toast named a key that does not exist, and behind the
   * lie there was genuinely no door.
   *
   * A sixth thumb button is what this is instead of, for the reason written out
   * over `_wireHotbar`: the right hand already has four and two of them are
   * pressed constantly. This is the same answer drop got — put the second
   * meaning on a hold of the control the first meaning already lives on. Growth
   * belongs on the bag rather than anywhere else because the two screens are
   * the same question ("what have I got"), because both are things you open
   * between fights rather than during one, and because a hold is exactly right
   * for the rarer of a pair.
   *
   * DROP_DELAY, not a number of its own: one hold length across the whole layer
   * is what makes a hold feel like a gesture rather than a per-button quirk.
   *
   * The cost is that the bag now opens on release rather than on press. That is
   * the unavoidable half of the trade — a screen opened on press cannot then be
   * taken back if the thumb stays down — and at a tap of well under 150ms it is
   * not perceptible. The `on` class going on at press is what keeps the button
   * feeling immediate while that plays out.
   */
  _tapHoldBtn(el, tapCode, holdCode) {
    let timer = null, held = false;
    el.addEventListener('pointerdown', (e) => {
      clearTimeout(timer);
      held = false;
      el.classList.add('on');
      timer = setTimeout(() => {
        held = true;
        // The same short pulse the drop hold uses, and the only signal that the
        // hold has been taken: the screen it opens arrives a frame later and
        // says the rest.
        navigator.vibrate?.(12);
        this.input.tap(holdCode);
        el.classList.remove('on');
      }, DROP_DELAY);
      e.preventDefault();
    });
    const up = () => {
      clearTimeout(timer);
      timer = null;
      el.classList.remove('on');
      if (!held) this.input.tap(tapCode);
      held = false;
    };
    el.addEventListener('pointerup', up);
    // Not `up`: a cancelled gesture is one the player did not finish, and
    // opening the inventory because iOS took the touch away is worse than
    // opening nothing.
    el.addEventListener('pointercancel', () => {
      clearTimeout(timer);
      timer = null;
      held = false;
      el.classList.remove('on');
    });
  }

  /** A button that fires a key for one frame. */
  _tapBtn(el, code) {
    el.addEventListener('pointerdown', (e) => {
      this.input.tap(code);
      el.classList.add('on');
      e.preventDefault();
    });
    const off = () => el.classList.remove('on');
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
  }

  /** Sneak. Latches, and shows that it has. */
  _toggleBtn(el) {
    el.addEventListener('pointerdown', (e) => {
      this.sneak = !this.sneak;
      el.classList.toggle('on', this.sneak);
      this.input.hold('ControlLeft', this.sneak);
      e.preventDefault();
    });
  }

  // --- stick maths ----------------------------------------------------------

  _stick(e) {
    const c = this.claims.get(e.pointerId);
    let dx = e.clientX - c.cx;
    let dy = e.clientY - c.cy;
    const d = Math.hypot(dx, dy) || 1;
    // The nub is clamped to the rim but the *reading* is not: a thumb that
    // slides past the edge of a 52px pad should still be running, and the
    // sprint threshold is on the unclamped length so it can be reached at all.
    const clamped = Math.min(d, STICK_R);
    this.nub.style.transform = `translate(${(dx / d) * clamped}px, ${(dy / d) * clamped}px)`;
    const n = d / STICK_R;
    this._walk(dx / d, dy / d, n >= SPRINT, n);
  }

  /**
   * Turn a direction into the four keys the game actually reads.
   *
   * Quantised to eight ways rather than four: a 45 degree band each, so the
   * diagonals are as wide as the cardinals and a thumb held at 40 degrees walks
   * forward-and-left rather than flickering between two cardinals as it wobbles.
   * Screen +y is down, and forward is -y.
   */
  _walk(ux, uy, sprint, n = 0) {
    const on = n >= DEAD;
    const w = on && uy < -0.383;
    const s = on && uy > 0.383;
    const a = on && ux < -0.383;
    const d = on && ux > 0.383;
    this.input.hold('KeyW', w);
    this.input.hold('KeyS', s);
    this.input.hold('KeyA', a);
    this.input.hold('KeyD', d);
    this.input.hold('ShiftLeft', on && sprint);
  }

  // --- visibility -----------------------------------------------------------

  /**
   * Called once a frame from the game loop. Cheap: it compares against the last
   * answer and only touches the DOM when it changes, because writing a class
   * every frame is a style recalculation every frame for no reason.
   *
   * The layer goes away under any screen. It has to: the look surface covers
   * the viewport, and the inventory is a DOM overlay whose slots are tapped.
   * Leaving the surface up would mean dragging on the bag turned the camera
   * behind it, and every held key would still be held while you crafted.
   */
  sync() {
    const g = this.game;
    // 'paused' is a value of `state`, not a flag beside it, so the first test
    // already covers the pause menu and the death card.
    const on = (g.state === 'playing' || g.state === 'spectating')
      && !g.ui.screenOpen && !g.ui.skillsOpen;
    if (on === this._shown) return;
    this._shown = on;
    this.root.classList.toggle('hidden', !on);
    // Everything the thumbs were holding is released on the way out, or the
    // player walks into the inventory screen and keeps walking inside it. Sneak
    // is a state of the player rather than of a thumb, so it survives the trip
    // and is put back on the way in — closing a screen should not stand you up
    // on the ledge you were creeping along.
    if (!on) this._release();
    else {
      this.buttons.sneak.classList.toggle('on', this.sneak);
      this.input.hold('ControlLeft', this.sneak);
    }
  }

  _release() {
    // A repeating drop is a timer rather than a claim, and it is the one thing
    // here that would go on running with the layer gone: the hotbar is behind
    // the inventory screen, and a stack quietly emptying itself while the
    // player crafts is exactly the class of bug the claims below exist to stop.
    this._cancelDrop();
    // Through each claim's own release, not by clearing the map: the claim is
    // what knows the button it lit and the field it set.
    for (const c of [...this.claims.values()]) c.release?.();
    this.claims.clear();
    this._walk(0, 0, false);
    this.input.hold('Space', false);
    this.input.buttons[0] = false;
    this.input.buttons[2] = false;
    this.input.hold('ControlLeft', false);
    this.nub.style.transform = '';
    this.stick.classList.remove('on');
    for (const b of Object.values(this.buttons)) b.classList.remove('on');
  }
}
