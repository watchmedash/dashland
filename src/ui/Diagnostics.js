// A readout for a device with no console.
//
// This exists because of a bug I could not find. The report was "settings menu
// won't open, pause does nothing, the game lags and I can't move" on the phone,
// and every one of those symptoms is invisible from the outside: the game
// catches errors inside its own frame loop and logs them once (see the
// `setAnimationLoop` handler in main.js), which on a desktop is a line in a
// console and on a phone is nothing at all. Three attempts to reproduce it on
// the desktop build - dev server, production build, and the real touch layer via
// `?touch=1` - all came back clean.
//
// So rather than guess a fourth time, the app can say what is happening to it.
//
// WHAT IT ANSWERS, in one line, because the three reported symptoms have three
// different causes and this tells them apart at a glance:
//
//   fps    a game that is genuinely lagging reads low here. A game that is
//          simulating fine while the controls are dead reads 60, and that is a
//          completely different bug.
//   state  'playing' means the world is live. If a pause press does nothing and
//          this still says 'playing', the press never arrived. If it says
//          'paused' and no card is on screen, the press arrived and the OVERLAY
//          is what failed.
//   modal  whether the game thinks a screen is already open, which is the one
//          state in which Escape closes something instead of pausing - and would
//          look exactly like "pause does nothing".
//   err    the last error the frame loop swallowed, which is the thing there has
//          been no way to see.
//
// It is off unless asked for. `?diag=1` turns it on anywhere, and on the packaged
// app it can be turned on from Settings, because that is the build with no other
// way to look.

const HISTORY = 60;

export class Diagnostics {
  constructor() {
    this.el = null;
    this.on = false;
    this.lastError = '';
    this._frames = [];
    this._t = 0;
    // Errors that never reach a console: the frame loop's, and anything that
    // escapes a handler entirely.
    window.addEventListener('error', (e) => this.note(e.message));
    window.addEventListener('unhandledrejection', (e) => {
      this.note('rejected: ' + (e.reason?.message ?? String(e.reason)));
    });
  }

  /** Record an error. Cheap and always on, so the readout has something to show
   *  the moment it is switched on rather than only from that point forward. */
  note(msg) {
    if (!msg) return;
    this.lastError = String(msg).slice(0, 120);
    if (this.el) this._paint();
  }

  show(on) {
    this.on = !!on;
    if (!this.on) { this.el?.remove(); this.el = null; return; }
    if (this.el) return;
    const d = document.createElement('div');
    d.id = 'diag';
    // Inline, and deliberately: this has to work on a build whose stylesheet is
    // the thing under suspicion.
    d.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
      'font:11px/1.5 ui-monospace,monospace', 'color:#cfe',
      'background:rgba(6,8,14,.82)', 'padding:2px 6px',
      'pointer-events:none', 'white-space:pre-wrap', 'word-break:break-word',
    ].join(';');
    document.body.appendChild(d);
    this.el = d;
  }

  /**
   * One frame's worth. Called from the frame loop, so it must cost nothing when
   * it is off - which is the first line.
   */
  tick(dt, game) {
    if (!this.on) return;
    this._frames.push(dt);
    if (this._frames.length > HISTORY) this._frames.shift();
    // Repaint four times a second. A readout that changes every frame is one
    // nobody can read a number off.
    this._t += dt;
    if (this._t < 0.25) return;
    this._t = 0;
    this._game = game;
    this._paint();
  }

  _paint() {
    if (!this.el) return;
    const g = this._game;
    const n = this._frames.length;
    const avg = n ? this._frames.reduce((a, b) => a + b, 0) / n : 0;
    const fps = avg > 0 ? Math.round(1 / avg) : 0;
    const bits = [
      `fps ${String(fps).padStart(2)}`,
      `state ${g?.state ?? '?'}`,
      `modal ${g?.ui?.anyModalOpen ? 'YES' : 'no'}`,
      `screen ${g?.ui?.screen ?? '-'}`,
      `touch ${g?.touch ? 'on' : 'off'}`,
    ];
    this.el.textContent = bits.join('  ')
      + (this.lastError ? `\nerr: ${this.lastError}` : '');
  }
}
