// The turning year.
//
// A season is a slow modifier on things that already exist rather than a system
// of its own: what colour the world is, how fast a crop fills out, and whether
// falling water arrives as rain or snow. Nothing here owns any state the rest of
// the game could disagree with — it is a pure function of how many days have
// passed, and that count is the same one the day/night clock advances.

/**
 * Days in each season, so a full year is twelve.
 *
 * The temptation is to make a year long enough to feel like a year. It is the
 * wrong instinct here: a season nobody sees change is indistinguishable from a
 * palette choice, and a planet you can walk around in four minutes does not
 * pretend to real scale anywhere else either. Three days means a session
 * crosses at least one boundary and the change reads as *weather over time*
 * rather than as a setting.
 */
export const DAYS_PER_SEASON = 3;
export const SEASONS = 4;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS;

/**
 * Per-season modifiers.
 *
 * `color` is the hue the living world moves toward and `strength` is how far.
 * `growth` scales crop time, and `cold` forces precipitation to fall as snow at
 * any latitude.
 *
 * This began as a colour to *multiply* by, which is the obvious way to tint
 * something and cannot work here. Two rounds of raising the numbers proved it:
 * a leaf's final colour is its texture times its biome tint, and the leaf
 * texture is itself green, so scaling the red channel brightens a green leaf
 * rather than turning it gold — at (1.95, 1.0, 0.40), nearly double red, the
 * canopy was still plainly green. You cannot multiply a hue out of a surface
 * that already has one.
 *
 * So the shader takes the *brightness* of what it would have drawn and gives it
 * this hue instead. Texture detail and shading survive because they live in the
 * brightness; the colour is simply replaced.
 */
const TABLE = [
  { name: 'Spring', color: [0.45, 0.80, 0.32], strength: 0.30, growth: 1.25, cold: 0 },
  { name: 'Summer', color: [0.40, 0.72, 0.34], strength: 0.00, growth: 1.00, cold: 0 },
  { name: 'Autumn', color: [1.00, 0.58, 0.13], strength: 0.85, growth: 0.72, cold: 0 },
  // Frost, not moonlight. A bluer winter than this reads as night-time even at
  // noon, because foliage in shade is already blue from the sky light.
  { name: 'Winter', color: [0.86, 0.89, 0.93], strength: 0.72, growth: 0.28, cold: 1 },
];

/**
 * Rec. 601 luma. Each season's colour is divided by its own luminance before
 * use, so re-hueing a surface never changes how bright it is — otherwise
 * autumn's dark gold would double as a dimmer switch and winter's pale blue
 * would blow the world out.
 */
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
for (const s of TABLE) {
  const l = luma(s.color) || 1;
  s.norm = [s.color[0] / l, s.color[1] / l, s.color[2] / l];
}

/**
 * The altitude, in blocks above sea level, at and above which ground stays
 * under snow.
 *
 * This is the one number the whole snow system turns on, and it lives here
 * rather than inside Weather or inside the game loop because two separate rules
 * read it: whether falling water arrives as snow (`Weather.update`) and whether
 * the ground itself is white (`Game._tickSeasonSnow`). Those two have to agree.
 * Snow settling onto bare grass, or a snowfield standing in the rain, is the
 * kind of disagreement a player reads as a bug rather than as weather, and two
 * copies of one threshold is how a threshold drifts away from itself.
 *
 * Summer puts the line at 9, which is the shoulder of the mountains: mean land
 * is R_SURFACE and alpine ground begins 3.8 above it, so 9 leaves the peaks
 * white through the warm half of the year and clears everything below them.
 * Winter walks it down to 0, which is sea level, so in deep winter every land
 * column is under snow. That 9-to-0 sweep is not new and not invented here: it
 * is the expression Weather already carried inline, moved rather than rewritten,
 * kept to the digit so lifting it out changes nothing about the sky.
 *
 * There is no separate, lower line for the poles, and it was tried: giving the
 * SNOW and TUNDRA biomes a six-block discount, on the reasoning that ground
 * frozen by latitude should not answer to a season the way a mountainside does.
 * Measured on seed 4242, standing in the ice cap, it made the whole feature
 * invisible. The snow around that spot lies between altitude 3 and 15 with the
 * bulk of it at 8 to 12 — a *cap* is high ground, that is what makes it cold —
 * so a summer line at 3 left 355 of 359 snow columns untouched. One line for
 * the whole planet retreats the cap to its high half in high summer and takes
 * it back down to sea level in deep winter, which is the seasonal effect this
 * is for, and it is one number rather than two that have to be kept in step.
 *
 * @param {number} chill 0..1, the season's `cold`.
 */
export const snowLine = (chill) => 9 - chill * 9;

/**
 * How much of a season is spent easing into the next.
 *
 * Seasons that switch on a day boundary announce themselves as a bug — the
 * grass changes colour between one frame and the next while you are standing on
 * it. The last third of every season is a crossfade into the one after, which is
 * also roughly how autumn actually behaves.
 */
const BLEND = 0.34;

const lerp = (a, b, t) => a + (b - a) * t;

export class Seasons {
  constructor(day = 0) {
    /** Days elapsed since the world began, fractional. */
    this.day = day;
    /** Hue for the living world, already normalised to luminance 1. */
    this.color = [1, 1, 1];
    this.strength = 0;
    this.growth = 1;
    this.cold = 0;
    this._apply();
  }

  advance(days) {
    if (!(days > 0)) return;
    this.day += days;
    this._apply();
  }

  /** 0..3, which season it is right now. */
  get index() {
    return Math.floor((this.day % DAYS_PER_YEAR) / DAYS_PER_SEASON);
  }

  /** 0..1 through the current season. */
  get progress() {
    return ((this.day % DAYS_PER_YEAR) / DAYS_PER_SEASON) % 1;
  }

  get name() { return TABLE[this.index].name; }

  /** Which day of the current season, 1-based, for the HUD. */
  get dayOfSeason() { return Math.floor(this.progress * DAYS_PER_SEASON) + 1; }

  /** The year, 1-based. */
  get year() { return Math.floor(this.day / DAYS_PER_YEAR) + 1; }

  _apply() {
    const a = TABLE[this.index];
    const b = TABLE[(this.index + 1) % SEASONS];
    // Nothing happens until the last stretch of the season, then it eases over.
    const p = this.progress;
    const t = p <= 1 - BLEND ? 0 : smooth((p - (1 - BLEND)) / BLEND);
    for (let n = 0; n < 3; n++) this.color[n] = lerp(a.norm[n], b.norm[n], t);
    this.strength = lerp(a.strength, b.strength, t);
    this.growth = lerp(a.growth, b.growth, t);
    this.cold = lerp(a.cold, b.cold, t);
  }

  toJSON() { return +this.day.toFixed(4); }
  fromJSON(d) { this.day = typeof d === 'number' && d >= 0 ? d : 0; this._apply(); }
}

function smooth(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
