// A strike: where a bolt lands on the storm face, what it looks like, and what
// standing under it costs.
//
// ---- why this is a module and not four methods on Weather --------------------
//
// The same split Tornado.js makes, for the same reason and in the same words:
// Weather.js is a table of six numbers, a state and a lerp toward them, and it
// has no position, no planet and no player. Whether the sky strikes is a fact
// about the sky and is rolled there (`Weather.wantsStrike`); where the bolt
// lands, whether you were standing under it and what that takes off the bar all
// need a world, and they live here.
//
// ---- the storm is the face, not the weather ----------------------------------
//
// Tempest is a sealed face whose sky is its own — NINE-FACES.md section 3 says
// so directly, and `skyTimeOfDay` in main.js already holds Pyre at the cinder
// hour for exactly this reason. So the override is in the same shape: the caller
// tests the face, `Weather.update` holds `storm` for as long as the answer is
// yes, and the ordinary weather it interrupted is handed back on the way out.
// Nothing about the roll table changes, and no other face sees a strike land.
//
// ---- how often, and where ----------------------------------------------------
//
// STRIKE_RATE 0.3/s in Weather.js: a bolt somewhere every 3.3 seconds, which is
// what makes the face read as a permanent storm rather than as bad weather.
//
// Each one is then either AIMED or DISTANT, and that is the whole of the
// difficulty:
//
//   distant   30 to 95 cells out, on a random bearing. Light and sound only.
//             It can do no damage at any range it is allowed to land at.
//   aimed     inside AIM_R 6 cells of the player, uniform by area. Every one of
//             these costs something.
//
// `AIM_CHANCE * exposure` decides which, and **exposure is the mechanic**. It is
// `game.shelter`, the sky-exposure term the rain field already fades itself with
// — 1 under open sky, 0 with three solid layers anywhere overhead. Dig two cells
// into the gravel and the sky stops aiming at you. That is the lesson the face
// is built to teach, and it is the reason the terrain is deliberately flat: the
// shelter has to be one you made.
//
// ---- what it costs -----------------------------------------------------------
//
// Against a 20-point bar, by horizontal distance from where the bolt landed:
//
//     <= 1.5 cells   7    a direct hit, a third of the bar
//     <= 4.0 cells   4
//     <= 7.0 cells   2
//     beyond         0
//
// An aimed strike is sited uniformly by area inside 6 cells, so the three bands
// are hit 6.3%, 37.5% and 56.2% of the time: **3.1 damage in expectation per
// aimed strike.** At full exposure an aimed strike arrives every 8.3 seconds, so
// standing in the open on Tempest costs about 22 points a minute, against the
// 13.3 a fed player regenerates (1 per 4.5s in `_tickVitals`). Net, that is a
// full bar every two and a quarter minutes of ignoring it, and the first thing
// that happens is a 2 and then a 4 — you are told several times before a 7
// lands. A direct hit turns up roughly every two minutes in the open.
//
// The numbers are chosen against three failure modes:
//
//   - a bolt that kills outright. Nothing here can: the worst single event is
//     7, and it would take three of them inside the regen window, which at
//     6.3% each is about one run in four thousand.
//   - a bolt that is a rounding error. 22 a minute is comfortably over the
//     regen, so the open ground is a clock and not a scratch.
//   - death at random with no counterplay. Exposure is the counterplay and it
//     is total: at `shelter` 0 no strike is ever aimed at you, and the distant
//     ones cannot reach.
//
// `_takeHit` is called guarded, so the 0.5s immunity a mob blow sets also eats a
// bolt, and it is not soaked. Nothing is any more — the tolerance branch went
// with the six-branch tree and `Skills.soak` is the identity — but the kind is
// `lightning` precisely so that it is a kind of its own rather than quietly
// inheriting the discount.
//
// **It starts no fires and edits no blocks.** The ground is wet gravel and mud
// and a spreading fire on a face made of standing water is a mechanic nobody
// asked for. Not one call into `_applyEdits` exists in this file, so there is
// nothing here that a save has to remember.
//
// ---- legibility --------------------------------------------------------------
//
// Flash, bolt, crack, in that order and on one clock. The flash is
// `weather.lightning`, which main.js already turns into a sun-intensity spike;
// the bolt is drawn from the exact cell that was struck (see `Particles.bolt`);
// and the thunder is delayed behind the flash by the real distance, using the
// same 6.5s-at-two-kilometres wiring the constructor in main.js worked out for
// the global storm. One roll decides all three, so counting the seconds tells
// you what counting the seconds is supposed to tell you.

import * as THREE from 'three';
import { D } from '../world/Constants.js';
import { nearestTo, wrapDistH } from './Wrap.js';

/** Cells from the player an aimed strike may land within. */
export const AIM_R = 6;
/** Cells from the player a distant one lands between. */
export const FAR_MIN = 30, FAR_MAX = 95;
/**
 * How much of the strike rate is aimed at you under fully open sky.
 *
 * Multiplied by exposure, so 0.4 of 0.3/s is one aimed bolt every 8.3 seconds in
 * the open and none at all under a roof.
 */
const AIM_CHANCE = 0.4;

/** Distance bands, in cells, and what each takes off a 20-point bar. */
export const HURT = [[1.5, 7], [4.0, 4], [7.0, 2]];

/**
 * What a bolt that landed `far` cells away takes off the bar.
 *
 * Split out from the strike so the ladder can be asserted without a planet: the
 * numbers in the head of this file are the whole design and a table that has
 * quietly stopped matching them is exactly the drift this codebase keeps
 * getting bitten by.
 */
export function strikeDamage(far) {
  for (const [r, dmg] of HURT) if (far <= r) return dmg;
  return 0;
}

/** Seconds of delay per cell of distance. 6.5s at the far end of FAR_MAX. */
const SOUND_DELAY = 6.5 / FAR_MAX;

const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Bring one bolt down. Called from main.js when `Weather.wantsStrike` says so.
 *
 * @param {object} game needs `planet`, `player`, `particles`, `audio`,
 *   `weather`, `shelter` and `_takeHit`.
 * @returns {boolean} whether a bolt actually landed. Siting can fail — the
 *   column may not be built yet — and a caller that wants to know is told.
 */
export function strikeLightning(game) {
  const planet = game.planet;
  const p = game.player;
  if (!planet || !p) return false;

  const aimed = Math.random() < AIM_CHANCE * Math.max(0, Math.min(1, game.shelter ?? 1));
  // Uniform by AREA, not by radius. Sampling the radius flat crowds every bolt
  // into the middle and would make a direct hit four times as likely as the
  // damage table above says it is.
  const dist = aimed
    ? AIM_R * Math.sqrt(Math.random())
    : FAR_MIN + Math.random() * (FAR_MAX - FAR_MIN);
  const ang = Math.random() * Math.PI * 2;
  _p.set(p.position.x + Math.cos(ang) * dist, p.position.y, p.position.z + Math.sin(ang) * dist);

  const at = planet.cellAt(_p.x, _p.y, _p.z);
  if (!at) return false;
  let k = planet.surfaceK(at.col);
  if (k < 0) return false;
  // `surfaceK` answers with the bed under water and this face is 44% water, so
  // without this every second bolt would be drawn from the cloud to a point
  // several cells under the surface. Climb to the top of whatever is standing
  // in the column, water included.
  while (k + 1 < D && planet.liquidAt(at.col, k + 1)) k++;
  const wet = planet.liquidAt(at.col, k);

  // The top face of the struck cell, expressed as the copy of itself nearest the
  // player, so a bolt either side of the map's seam is drawn on the side the
  // player can see it from.
  planet.centerOf(at.col, k, _p);
  _p.y += 0.5;
  nearestTo(_p, p.position, _p);

  const far = wrapDistH(p.position, _p);
  const near = Math.max(0, 1 - far / FAR_MAX);

  game.particles?.bolt(_p);
  if (wet) game.particles?.splash(_p, _up, 1.1);
  else game.particles?.blast(_p, _up, 0.3);

  // The whole-sky flash. Distant strikes light the ground too, less: main.js
  // only spends the sun spike above 0.5, so the floor here is what decides
  // whether a bolt on the horizon is felt indoors as well as seen.
  const w = game.weather;
  if (w) w.lightning = Math.max(w.lightning, 0.55 + 0.45 * near);

  const strength = 0.85 + Math.random() * 0.35;
  setTimeout(() => game.audio?.thunder(strength, near), far * SOUND_DELAY * 1000);

  const dmg = strikeDamage(far);
  if (dmg > 0) game._takeHit?.(dmg, 'Lightning', true, 'lightning');
  return true;
}
