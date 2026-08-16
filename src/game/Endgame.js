// The end of the game: sixty-four gold carrots, sixteen bosses, and a planet
// that stops making monsters.
//
// --- why this is not just sixteen more spawns --------------------------------
//
// Everything else in `Mobs.js` exists only inside the despawn ring. The list is
// what is within a hundred and forty-five units of the player, the save writes
// that list, and a cow you walked away from is not remembered as a cow — the
// spawner simply makes another one somewhere else. That is right for a
// population and wrong for an individual, and the sixteen are individuals: one
// of each, on a face the player may not be standing on, alive at the health it
// was last left at, and gone for good once it is down.
//
// So the roster lives here rather than in the mob list. This file holds the
// sixteen records, decides where each one stands, materialises one into a real
// mob when the player comes near enough for the ground to exist, takes its
// health back when they walk away, and remembers which are dead. The mob list
// is a view of this, never the other way round.
//
// --- held, not counted -------------------------------------------------------
//
// The door is sixty-four gold carrots **held in the bag**, not sixty-four
// collected over the world's life. Two reasons, and both are already written
// down elsewhere in the codebase:
//
//   The item says so. `Items.js` gives the gold carrot no `food`, no `seed`, no
//   recipe and no shelf in the shop, and the note there explains why in exactly
//   these terms: "a carrot that could be eaten is a carrot that can be eaten by
//   mistake when you are sixty-three of the way to whatever you were collecting
//   them for". An item deliberately made impossible to spend is an item whose
//   held count only ever goes up. A lifetime counter would make all of that
//   care pointless.
//
//   Nothing else in this game keeps a per-world lifetime tally. `game.stats` is
//   three counters for the slot summary and `Achievements.js` is explicitly per
//   *player* rather than per planet. A new number in the save that only this
//   feature reads would be a fourth kind of progress record.
//
// Held is also the only version a player can check: the answer to "how far am I
// through this" is the stack in the bag. Once the door has been opened it stays
// open — `triggered` is written to the save — so spending, dropping or losing
// the carrots afterwards changes nothing.

import { F, D, R_MIN, R_SEA, cidx, FACE_ROLE } from '../world/Constants.js';
import { cellToWorld } from '../world/Sphere.js';
import { BOSS_ROSTER } from './Mobs.js';
import { itemIdOf } from './Items.js';

/** The door. */
export const CARROTS_NEEDED = 64;

/** How many of them there are, which is also the win condition. */
export const BOSS_COUNT = BOSS_ROSTER.length;

const GOLD_CARROT = itemIdOf('gold_carrot');

/**
 * Cells of clear space between two bosses on the same face.
 *
 * A face is 416 cells across and carries eight of them, so the ground is not
 * short of room. 60 is chosen against the despawn ring rather than against the
 * face: at roughly a unit per cell it is well inside 145, so two neighbours can
 * be up at once and a player can be fighting one while another walks over —
 * which is the whole of the owner's "aggressive to other mobs" if they meet.
 * Much more and the sixteen would be sixteen separate errands.
 */
const BOSS_SPREAD = 60;

/** Kept off the seams, where a body would spend its life stepping across. */
const EDGE_MARGIN = 12;

/** How many columns the placement will look at before it gives up on a face. */
const PLACE_TRIES = 4000;

/**
 * A boss is materialised a little inside the ring it would be despawned at, so
 * it cannot appear and vanish on alternate frames while the player walks the
 * boundary. The same 25-unit margin `spawnFar` uses, for the same reason.
 */
const MATERIALISE_MARGIN = 25;

const _w = [0, 0, 0];

export class Endgame {
  /**
   * @param {import('../world/Planet.js').Planet} planet
   * @param {import('./Mobs.js').Mobs} mobs
   */
  constructor(planet, mobs) {
    this.planet = planet;
    this.mobs = mobs;
    this.reset();
    // Told by `Mobs._die`, which is the single door out of being alive.
    mobs.onBossDown = (mob) => this._down(mob);
  }

  /** Raised the frame the last of the sixteen goes down. main.js reads it. */
  onWin = null;
  /** Raised once, the frame the sixteen are placed. */
  onBegin = null;

  reset() {
    this.triggered = false;
    this.won = false;
    /**
     * One record per boss, in `BOSS_ROSTER` order.
     *
     * `col` is where it stands and `hp` is what it has left; `live` is the mob
     * currently representing it, if the player happens to be close enough for
     * there to be one. Nothing outside this file holds a record.
     */
    this.roster = BOSS_ROSTER.map((b) => ({
      type: b.type, face: b.face, aquatic: b.aquatic,
      col: -1, hp: 0, dead: false, live: null,
    }));
    /**
     * Faces whose hostile spawning has been switched off, for good.
     *
     * A set of face indices rather than a pair of booleans, because `Mobs` asks
     * it about a column's face and does not care which two faces the endgame
     * happened to use.
     */
    this.shut = new Set();
    this.mobs.hostileShut = this.shut;
  }

  /** How many are still standing. */
  get standing() { return this.roster.reduce((n, r) => n + (r.dead ? 0 : 1), 0); }

  /**
   * The gate, asked once a second from the world tick.
   *
   * Cheap enough to ask every frame and asked on a clock anyway, because
   * `count` walks the bag and there is no reason for a hotbar scan to be in the
   * frame budget for a thing that can only happen once in a world's life.
   */
  check(inventory) {
    if (this.triggered || !GOLD_CARROT) return false;
    if (inventory.count(GOLD_CARROT) < CARROTS_NEEDED) return false;
    return this.begin();
  }

  /**
   * Place the sixteen and shut the two faces.
   *
   * Placement is decided here, once, off `colHeight` — the height field arrives
   * complete before any voxel does (see `Planet.setGlobals`), so a column on a
   * face nobody has ever walked on can be judged for height and for whether it
   * is under the sea. That is what makes "the spawn must work whether or not
   * the player is on those faces" true rather than deferred: the sixteen have
   * an address from this moment, and only their *bodies* wait for the ground to
   * stream in.
   */
  begin() {
    if (this.triggered) return false;
    const h = this.planet.colHeight;
    // Worldgen has not answered yet. Refusing rather than placing sixteen
    // bosses at column -1 — the tick will ask again next second.
    if (!h || !h.length) return false;
    for (const r of this.roster) {
      r.col = this._pick(r);
      r.hp = 0;
      r.dead = false;
      r.live = null;
      // A face with a boss on it is a face that has stopped making monsters.
      // Both faces are shut even if one boss could not be placed: the shutdown
      // is a statement about the endgame having started, not about a body.
      if (r.face !== undefined) {
        for (let f = 0; f < FACE_ROLE.length; f++) if (FACE_ROLE[f] === r.face) this.shut.add(f);
      }
    }
    this.triggered = true;
    this.onBegin?.();
    return true;
  }

  /**
   * A column on this boss's face that suits it.
   *
   * Two tests and a spacing rule, all three off the height field alone:
   *
   *   ground   above sea level, and not so high it is a peak the body would
   *            spend its life sliding off. `R_MIN + D` is the top of the array.
   *   water    the Deepmaw, and the opposite test — the column has to be sea
   *            bed with real depth over it, or the "placed on water" rule is a
   *            fish dropped on an ice sheet, which is the thing it forbids.
   *   spread   BOSS_SPREAD cells from every boss already placed on this face.
   *
   * The fallback is deliberate and is the last two lines: if nothing satisfies
   * the spacing after PLACE_TRIES, the best candidate found *without* it is
   * taken. A boss that failed to be placed is a boss that can never be killed,
   * and the game cannot be finished. Two of them standing closer together than
   * intended is a worse fight, not an unwinnable one.
   */
  _pick(rec) {
    const h = this.planet.colHeight;
    const f = FACE_ROLE.indexOf(rec.face);
    if (f < 0) return -1;
    const span = F - EDGE_MARGIN * 2;
    let fallback = -1;
    for (let t = 0; t < PLACE_TRIES; t++) {
      const i = EDGE_MARGIN + ((Math.random() * span) | 0);
      const j = EDGE_MARGIN + ((Math.random() * span) | 0);
      const col = cidx(f, i, j);
      const ground = h[col];
      if (!(ground > R_MIN + 2) || !(ground < R_MIN + D - 8)) continue;
      // Eight below the surface rather than three: the Deepmaw is drawn very
      // nearly four cells tall, and a body that size in four layers of water is
      // wedged rather than swimming.
      if (rec.aquatic ? !(ground < R_SEA - 8) : !(ground > R_SEA + 1)) continue;
      if (fallback < 0) fallback = col;
      let clear = true;
      for (const o of this.roster) {
        if (o === rec || o.col < 0) continue;
        const of = (o.col / (F * F)) | 0;
        if (of !== f) continue;
        const rem = o.col - of * F * F;
        if (Math.abs(((rem / F) | 0) - i) < BOSS_SPREAD
          && Math.abs((rem % F) - j) < BOSS_SPREAD) { clear = false; break; }
      }
      if (clear) return col;
    }
    return fallback;
  }

  /**
   * Bodies in, bodies out.
   *
   * The mob list is only ever a view of the roster, so this is the one place
   * the two are reconciled and it runs both ways every tick:
   *
   *   out   a boss the player has walked away from was released by the mob
   *         manager's own despawn ring. Its health comes back to the record
   *         before the reference is dropped, so walking off and returning is
   *         not a way to heal one.
   *   in    a boss the player has come back to is spawned again, at the health
   *         the record kept, once the ground under its column has streamed in.
   *
   * Nothing here can spawn a dead one: `dead` is set by `_down` and never
   * cleared, which is the whole of "they also never respawn".
   */
  update(player) {
    if (!this.triggered || !player) return;
    const near = this.mobs.despawnRadius - MATERIALISE_MARGIN;
    for (const r of this.roster) {
      if (r.live) {
        // Still ours? A released body is off the list and its `pos` has stopped
        // moving; a dead one has already been through `_down`.
        if (r.live.released || r.live.health <= 0) {
          if (!r.dead) r.hp = Math.max(1, Math.round(r.live.health));
          r.live = null;
        } else {
          // Kept current rather than only read at the hand-back, so a save
          // taken mid-fight records the bar the player can see.
          r.hp = Math.max(1, Math.round(r.live.health));
          continue;
        }
      }
      if (r.dead || r.col < 0) continue;
      if (this._distance(r, player) > near) continue;
      const mob = this.mobs.spawnBoss(r.type, r.col);
      if (!mob) continue;                    // ground not built yet; ask again
      // A record with health in it is a boss that has been fought. A fresh one
      // takes whatever `_spawnHealth` gave it, which is where the world's age
      // and its difficulty are applied.
      if (r.hp > 0) mob.health = Math.min(mob.health, r.hp);
      else r.hp = mob.health;
      r.live = mob;
    }
  }

  /** World-space distance from the player to where this boss stands. */
  _distance(rec, player) {
    const f = (rec.col / (F * F)) | 0;
    const rem = rec.col - f * F * F;
    const k = this.planet.colHeight[rec.col] - R_MIN;
    cellToWorld(f, ((rem / F) | 0) + 0.5, (rem % F) + 0.5, k, _w);
    return Math.hypot(_w[0] - player.position.x, _w[1] - player.position.y,
      _w[2] - player.position.z);
  }

  /** One of them is down. Idempotent, because `_die` is not the only caller. */
  _down(mob) {
    const r = this.roster.find((x) => x.live === mob || x.type === mob.type);
    if (!r || r.dead) return;
    r.dead = true;
    r.hp = 0;
    r.live = null;
    if (this.standing === 0 && !this.won) {
      this.won = true;
      this.onWin?.();
    }
  }

  toJSON() {
    if (!this.triggered) return null;
    return {
      v: 1,
      w: this.won ? 1 : 0,
      // Face indices rather than roles, because that is what the shutdown is
      // asked about and what a column answers.
      s: [...this.shut],
      /**
       * One row per boss: type, column, down, health left.
       *
       * Keyed by type rather than by position, because the roster is derived
       * from the species table and a save must not depend on that order
       * surviving an edit.
       *
       * Four fields and not three, and the fourth is the one that matters.
       * Death and health were folded together first - zero meant dead - and
       * that reads a boss the player has never been near, whose record honestly
       * holds no health at all yet, as a corpse. Clamping it to 1 instead is
       * the same bug pointing the other way: sixteen bosses that load with one
       * point of health each. So `down` is its own flag and 0 health means "not
       * fought yet, take whatever `_spawnHealth` gives it".
       */
      b: this.roster.map((r) => [r.type, r.col, r.dead ? 1 : 0, Math.max(0, r.hp | 0)]),
    };
  }

  /**
   * @param {object|null} data whatever `toJSON` last wrote, or nothing at all —
   *   which is every world saved before the endgame existed and every world
   *   that has not reached it. Both are the same state and neither needs a
   *   version bump: an absent key reads as "not triggered", which is true.
   */
  fromJSON(data) {
    this.reset();
    if (!data || !data.b) return;
    this.triggered = true;
    this.won = !!data.w;
    for (const f of data.s || []) this.shut.add(f | 0);
    for (const [type, col, down, hp] of data.b) {
      const r = this.roster.find((x) => x.type === type);
      // A species that has since been removed from the table. Skipped rather
      // than restored, exactly as `Mobs.fromJSON` skips an unknown `d.t`.
      if (!r) continue;
      r.col = col | 0;
      r.dead = !!down;
      r.hp = r.dead ? 0 : Math.max(0, hp | 0);
    }
  }
}
