// Health over whatever you are actually fighting.
//
// The brief is one sentence: a bar so the player can decide continue or run.
// Everything here follows from that and from its failure mode, which is a
// screen of nameplates over every animal ever clubbed. So this is not a
// nameplate system. A body earns a bar by trading blows *with the player* —
// your swing, your arrow, or its paw — and loses it again a few seconds after
// the last one. Two monsters brawling with each other paint nothing: the only
// three doors into `engage` are wired in main.js to the three wires a player
// blow crosses, and mob-on-mob damage crosses none of them.
//
// Drawn into one 2D canvas of its own rather than a DOM node per body. Ten
// bodies is ten fillRect pairs on a context that is already allocated, against
// ten absolutely-positioned elements whose transforms the compositor has to
// reconcile every frame; and the canvas can be switched off with one
// `display` write when nothing is in a fight, which is nearly always.
//
// It owns its own element and its own styling because `src/ui/` and
// `index.html` belong to other work. The canvas sits at z-index 19, one under
// `#hud`, so the hotbar, the crosshair and every menu overlay paint on top of
// it and it can never fight the chrome for the screen.

import * as THREE from 'three';
import { nearestTo } from '../game/Wrap.js';

/**
 * Seconds a fight stays live after the last blow, from either side.
 *
 * Six, and it is a timeout rather than a range test or an "is it still
 * chasing" question, because those two both flicker: a husk that steps behind
 * a rock is still the fight you are in, and a bar that blinks out and back is
 * worse than no bar. Six is long enough to cover a bow reload and a retreat
 * and short enough that a cow you hit once on the way past is off the screen
 * before you reach the next field.
 */
const HOLD = 6;
/** The tail of HOLD spent fading, so it leaves rather than vanishing. */
const FADE = 0.8;
/**
 * The most bars drawn at once, nearest first.
 *
 * A pack of eight husks is a real thing on Umbra at night and eight bars is
 * the clutter the brief rules out. Four is what fits across a phone in
 * landscape without stacking into each other, and the four nearest are the
 * four the decision is about.
 */
const MAX_BARS = 4;
/** Past this many blocks a fight is not a fight you are in. */
const FAR = 40;

/** Half-width and half-height of the box around the crosshair no bar enters. */
const KEEP_OUT_W = 66;
const KEEP_OUT_H = 52;

const _head = new THREE.Vector3();
const _ndc = new THREE.Vector3();

export class CombatBars {
  constructor() {
    const c = document.createElement('canvas');
    c.id = 'combat-bars';
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;'
      + 'z-index:19;pointer-events:none;display:none';
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d');
    /** mob -> { left, max, ghost } */
    this.fights = new Map();
    this._w = 0;
    this._h = 0;
    this._dpr = 0;
  }

  /**
   * A blow landed between this body and the player, in either direction.
   *
   * Called with the mob only. Which way the blow went does not change what is
   * drawn — the question the bar answers is "how much of this thing is left",
   * and that is the same question whether you opened the fight or it did.
   */
  engage(mob) {
    if (!mob || mob.health <= 0) return;
    const f = this.fights.get(mob);
    // `max` is taken from the body and not from the species: `_spawnHealth`
    // hardens hostiles with world age and bosses with difficulty, so a spec
    // lookup would draw a boss at 40% on the frame it spawned. Read once at
    // the first blow, when the body is still whole, then raised if it is ever
    // seen higher — a healed villager must not overflow its own trough.
    if (f) {
      f.left = HOLD;
      if (mob.health > f.max) f.max = mob.health;
      return;
    }
    const spec = mob.spec ?? {};
    this.fights.set(mob, {
      left: HOLD,
      max: Math.max(mob.health, spec.health ?? spec.hp ?? 1),
      ghost: mob.health,
    });
  }

  /** Nothing is fighting anything: leaving the world, dying, the main menu. */
  clear() {
    if (this.fights.size) this.fights.clear();
    if (this.canvas.style.display !== 'none') this.canvas.style.display = 'none';
  }

  /**
   * One pass: age the fights, project the survivors, paint.
   *
   * `active` is false for every state that is not play, and the whole function
   * short-circuits to a hidden canvas rather than to a cleared one — a paused
   * game should not be drawing bars over a frozen fight, and `display:none`
   * costs nothing to keep set.
   */
  update(dt, camera, active) {
    if (!active || !this.fights.size) {
      if (this.fights.size && !active) this.clear();
      else if (this.canvas.style.display !== 'none') this.canvas.style.display = 'none';
      return;
    }

    const draw = [];
    for (const [mob, f] of this.fights) {
      f.left -= dt;
      // A corpse is not a decision. The bar goes the moment the thing does,
      // rather than draining to zero and lingering over a death animation.
      if (f.left <= 0 || mob.health <= 0 || mob.dying > 0) {
        this.fights.delete(mob);
        continue;
      }
      if (mob.health > f.max) f.max = mob.health;
      nearestTo(_head, camera.position, mob.position);
      const up = mob.up;
      // `tall` is the body's height rounded UP to whole cells, because it is
      // there for the collision walk; hanging the bar off it floats a bunny
      // most of a block over its own ears. `baseHeight * grown` is the height
      // the model is actually drawn at.
      const lift = (mob.baseHeight ? mob.baseHeight * (mob.grown ?? 1) : (mob.tall ?? 1)) + 0.3;
      if (up) { _head.x += up.x * lift; _head.y += up.y * lift; _head.z += up.z * lift; }
      else _head.y += lift;
      const dist = _head.distanceTo(camera.position);
      if (dist > FAR) continue;
      _ndc.copy(_head).project(camera);
      // Behind the eye, or off the sides. `z > 1` is the near/far clip and is
      // the only test that catches a body directly behind you, where x and y
      // are mirrored back into range and would otherwise draw.
      if (_ndc.z > 1 || _ndc.x < -1.1 || _ndc.x > 1.1 || _ndc.y < -1.1 || _ndc.y > 1.1) continue;
      draw.push({ mob, f, ndc: { x: _ndc.x, y: _ndc.y }, dist });
    }

    if (!draw.length) {
      if (this.canvas.style.display !== 'none') this.canvas.style.display = 'none';
      return;
    }
    // Nearest first, then cut. The thing about to reach you is the thing the
    // continue-or-run call is about.
    draw.sort((a, b) => a.dist - b.dist);
    if (draw.length > MAX_BARS) draw.length = MAX_BARS;

    this._sync();
    const { ctx } = this;
    ctx.clearRect(0, 0, this._w, this._h);
    // Roughly the HUD's own scale rule: full size on a monitor, easing down on
    // a landscape phone, where the chrome is already too big.
    const s = Math.max(0.68, Math.min(1, this._w / 1280));
    for (const d of draw) this._paint(d, s, dt);
    if (this.canvas.style.display !== 'block') this.canvas.style.display = 'block';
  }

  /** Match the backing store to the viewport, only when it actually moved. */
  _sync() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Capped at 2: bars are flat rectangles and eight-line text, and a 3x
    // phone buffer is three times the fill for nothing anyone can see.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this._w && h === this._h && dpr === this._dpr) return;
    this._w = w; this._h = h; this._dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _paint(d, s, dt) {
    const { mob, f } = d;
    const ctx = this.ctx;
    const frac = Math.max(0, Math.min(1, mob.health / f.max));
    // The ghost is the old reading catching up, so a blow reads as a chunk
    // coming off rather than as a bar that is simply shorter than last time.
    f.ghost += (mob.health - f.ghost) * Math.min(1, dt * 6);
    const ghost = Math.max(frac, Math.min(1, f.ghost / f.max));

    // Width carries the stakes. The brief asks for "far tougher than expected"
    // to be legible in the first second, and a fixed-width bar cannot say it:
    // a bunny at 4 health and a boss at 135 both draw a full bar and both look
    // like one fight. Square root rather than linear so the whole range from 3
    // to 135 fits on a phone while the low end stays distinguishable.
    const bw = Math.round((44 + 13 * Math.sqrt(f.max)) * s);
    const bh = Math.round(7 * s);
    const cx = (d.ndc.x * 0.5 + 0.5) * this._w;
    const cy = (1 - (d.ndc.y * 0.5 + 0.5)) * this._h;

    const fs = Math.round(11 * s);
    const labelH = fs + Math.round(4 * s);
    const label = mob.label ?? mob.spec?.label ?? '';
    ctx.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`;
    // The name is centred on the bar and a long one is wider than a short
    // creature's trough, so the keep-out below has to be measured against the
    // whole mark and not against the bar alone.
    const markW = Math.max(bw, label ? Math.ceil(ctx.measureText(label.toUpperCase()).width) + 6 : 0);
    let top = cy - bh - labelH;

    // Never over the sight. The crosshair, its look-at label and whatever is
    // being aimed at all live in one box in the middle of the screen; a bar
    // that lands in it is lifted clear above, and only pushed below if there
    // is no room above the box, which happens when you are looking sharply up.
    const kx = this._w / 2, ky = this._h / 2;
    // Not scaled by `s`: the crosshair is 20px on every screen, so the room it
    // needs is 20px on every screen too. Shrinking the box with the bars is
    // how a phone ended up with a name across the sight.
    const kw = KEEP_OUT_W, kh = KEEP_OUT_H;
    if (Math.abs(cx - kx) < kw + markW / 2 && top < ky + kh && top + labelH + bh > ky - kh) {
      // The 5 is the name's drop shadow, which spreads past the glyphs and
      // would otherwise smudge the edge of the box it was just moved out of.
      const lifted = ky - kh - labelH - bh - 5;
      top = lifted > 6 ? lifted : ky + kh + 5;
    }
    top = Math.round(Math.max(4, Math.min(this._h - labelH - bh - 4, top)));
    const left = Math.round(Math.max(4 + (markW - bw) / 2,
      Math.min(this._w - bw - 4 - (markW - bw) / 2, cx - bw / 2)));

    // The last three-quarters of a second, spent leaving.
    const a = f.left < FADE ? f.left / FADE : 1;
    ctx.globalAlpha = a;

    if (label) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(0,0,0,.95)';
      ctx.shadowBlur = 4 * s;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = 'rgba(247,238,222,.92)';
      ctx.fillText(label.toUpperCase(), left + bw / 2, top + fs);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }

    const by = top + labelH;
    // Trough, then the ghost, then the blood. Parchment and brass to sit with
    // the rest of the HUD; the fill is the one saturated thing on it.
    ctx.fillStyle = 'rgba(18,14,11,.78)';
    ctx.fillRect(left - 1, by - 1, bw + 2, bh + 2);
    ctx.fillStyle = 'rgba(86,41,10,.9)';
    ctx.fillRect(left - 1, by - 1, bw + 2, 1);
    ctx.fillRect(left - 1, by + bh, bw + 2, 1);
    if (ghost > frac) {
      ctx.fillStyle = 'rgba(247,238,222,.42)';
      ctx.fillRect(left, by, Math.round(bw * ghost), bh);
    }
    ctx.fillStyle = '#cf4630';
    ctx.fillRect(left, by, Math.round(bw * frac), bh);
    ctx.fillStyle = 'rgba(255,180,150,.42)';
    ctx.fillRect(left, by, Math.round(bw * frac), Math.max(1, Math.round(bh / 3)));

    // A notch every ten health. The width already says "this one is big"; the
    // notches say how big, without printing a number to read mid-swing.
    if (f.max > 12) {
      ctx.fillStyle = 'rgba(18,14,11,.55)';
      for (let n = 10; n < f.max; n += 10) {
        ctx.fillRect(left + Math.round(bw * (n / f.max)), by, 1, bh);
      }
    }
    ctx.globalAlpha = 1;
  }
}
