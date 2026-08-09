// Player inventory: 9 hotbar slots + 27 storage, plus a crafting grid and the
// cursor stack used while dragging.

import { ITEMS } from './Items.js';

export const HOTBAR = 9;
export const STORAGE = 27;
export const TOTAL = HOTBAR + STORAGE;

/** The test `active()` asks: a hand with something in it has something to do. */
const NON_EMPTY = () => true;

/**
 * What the right button can do with an item, *before* the world is consulted.
 *
 * The item half of the fall-through rule — see `_hasUse` in main.js, which is
 * the other half and does nothing but resolve the two conditional answers below
 * against the cell under the crosshair. Split here rather than written out in
 * one place because main.js builds a game on import and cannot be loaded by a
 * test, and this is the part with a wrong answer nobody would see: a new item
 * kind that forgets to declare itself is an item that silently lets the offhand
 * act over the top of it.
 *
 *  - `'any'`  the item is the action and the cell has no say: it places, it is
 *             food, it draws, it carries a liquid, it fishes. The main hand
 *             holding one of these is never talked over, which is what stops a
 *             torch in the left hand from being a second chance at a placement
 *             the right hand just refused.
 *  - `'soil'` a shovel: it tills, and only where there is soil.
 *  - `'seed'` seeds: they sow, and only into farmland with room above.
 *  - `'none'` nothing. A pickaxe, an axe, a sword, an ingot, an empty hand.
 *             This is the set the offhand can act over.
 *
 * @param {number} item an item id
 * @returns {'any'|'soil'|'seed'|'none'}
 */
export function useKind(item) {
  const def = ITEMS[item];
  if (!item || !def) return 'none';
  if (def.block !== undefined) return 'any';
  if (def.food) return 'any';
  if (def.bow) return 'any';
  if (def.carries || def.name === 'bucket') return 'any';
  if (def.tool?.kind === 'rod') return 'any';
  if (def.tool?.kind === 'shovel') return 'soil';
  if (def.name === 'seeds') return 'seed';
  return 'none';
}

export class Slot {
  constructor(item = 0, count = 0, wear = 0) {
    this.item = item; this.count = count; this.wear = wear;
  }
  get empty() { return !this.item || this.count <= 0; }
  get def() { return ITEMS[this.item]; }
  clear() { this.item = 0; this.count = 0; this.wear = 0; return this; }
  set(item, count, wear = 0) { this.item = item; this.count = count; this.wear = wear; return this; }
  copy() { return new Slot(this.item, this.count, this.wear); }
  sameAs(o) {
    return !o.empty && o.item === this.item && (ITEMS[this.item]?.stack ?? 64) > 1;
  }
  toJSON() { return this.empty ? 0 : [this.item, this.count, this.wear]; }
  static fromJSON(v) { return Array.isArray(v) ? new Slot(v[0], v[1], v[2] || 0) : new Slot(); }
}

export class Inventory {
  constructor() {
    this.slots = Array.from({ length: TOTAL }, () => new Slot());
    this.craft = Array.from({ length: 9 }, () => new Slot());   // 3x3, 2x2 uses 0,1,3,4
    /**
     * Worn armour, only for as long as it takes to pay for it.
     *
     * The four worn slots are gone — see Skills.js for what replaced them. What
     * is left here is a one-shot: `fromJSON` unpacks a save's `armour` key into
     * this array and nothing else ever writes it, so the loader can find the set
     * the player was wearing, convert it to skill points and take it. It is not
     * saved, not rendered and not part of the inventory; `takeLegacyArmour`
     * empties it, and on a save written since the conversion it is already
     * empty. Deleting the key outright would have been simpler and would also
     * have silently thrown away the one thing the conversion is owed.
     * @type {Slot[]}
     */
    this.legacyArmour = [];
    /**
     * The left hand — one stack you carry but are not holding.
     *
     * Kept out of `slots` for the same reason `armour` is, and the reason is
     * sharper here: a torch in the offhand is exactly the sort of thing a
     * recipe wants (a torch is fuel, a stick is in half the tree), and anything
     * that walks the carried inventory would spend it. Crafting costs, the
     * "Can Craft" sidebar, the merchant's sell list and `remove` all iterate
     * `slots`, so staying out of that array is what makes the offhand a place
     * you can put something and expect to find it there.
     */
    this.offhand = new Slot();
    this.cursor = new Slot();
    this.selected = 0;
    this.onChange = null;
  }

  changed() { this.onChange?.(); }

  /**
   * Hand over whatever armour the loaded save was wearing, once.
   *
   * Returns the pieces and empties the field in the same breath, so a second
   * caller — or the same caller after a stray refresh — gets nothing. That is
   * belt and braces: `Skills.redeemArmour` refuses a second conversion on its
   * own, and this makes sure a second attempt cannot destroy the pieces without
   * being paid for them either.
   * @returns {Slot[]} the non-empty worn pieces
   */
  takeLegacyArmour() {
    const worn = this.legacyArmour.filter((s) => !s.empty);
    this.legacyArmour = [];
    return worn;
  }

  held() { return this.slots[this.selected]; }
  heldDef() { return ITEMS[this.slots[this.selected].item] || null; }

  /**
   * The slot that actually *does* things: the main hand, or the offhand when
   * the main hand is empty.
   *
   * Until now the offhand only carried and displayed, which left it with no
   * purpose at all for anyone who was not deliberately posing with a torch. An
   * empty right hand is the one moment where deferring to the left is
   * unambiguous — there is nothing to choose between, so nothing can be taken
   * from you by surprise — and it means a torch in the offhand is placeable, a
   * pickaxe there still mines, and food there still feeds you.
   *
   * Deliberately **not** what `held()` returns. Display, the hotbar highlight
   * and the view model all ask that question and want the literal hand: if this
   * were folded into `held()` the same torch would be drawn in both fists at
   * once, because the right hand's model and the left hand's model would each
   * be handed the same item.
   *
   * Consumption follows the actor, because this returns the slot itself — if
   * the left hand placed the torch, the left hand's stack is the one that goes
   * down by one.
   */
  active() {
    return this.actingSlot(NON_EMPTY);
  }
  activeDef() { return ITEMS[this.active().item] || null; }

  /**
   * The same question as `active()`, asked of a hand that knows what it is being
   * asked to do.
   *
   * `active()` is this with the test "is there anything in this hand at all",
   * which is why it is written in terms of this one rather than beside it: an
   * empty main hand is the degenerate case of a main hand with nothing to do.
   *
   * The general case is the right button. A shovel and a torch, aimed at stone:
   * the shovel has no answer for stone, so the torch goes down. Aimed at dirt
   * the shovel tills, because tilling *is* an answer and the main hand is never
   * talked over. `hasAction` is supplied by the caller and is the only place
   * that decides what "no answer" means — see `_hasUse` in main.js, which is
   * where the world, the aim and the item table all are.
   *
   * The last line is the tie-break: when neither hand claims the click, the main
   * hand is still the one that acted, so an empty-handed punch, a wear tick or a
   * refusal message is charged to the hand the player thinks they are using.
   *
   * @param {(slot: Slot) => boolean} hasAction
   * @returns {Slot} the hand that acts. Never null; may be empty.
   */
  actingSlot(hasAction) {
    const main = this.slots[this.selected];
    if (!main.empty && hasAction(main)) return main;
    if (!this.offhand.empty && hasAction(this.offhand)) return this.offhand;
    return main.empty ? this.offhand : main;
  }

  /**
   * Trade the selected hotbar stack for the offhand stack — the F key.
   *
   * A straight swap rather than a merge, even when the two hold the same item.
   * Merging is what a slot click does and it is right there; a swap key that
   * sometimes swapped and sometimes silently stacked would be a key you could
   * not predict, and the one case it would fire on — two half stacks of torches
   * — is the case where you wanted the torch to stay in the left hand.
   */
  swapOffhand() {
    const held = this.held();
    const t = held.copy();
    held.set(this.offhand.item, this.offhand.count, this.offhand.wear);
    this.offhand.set(t.item, t.count, t.wear);
    // `set` will happily write (0, 0) from an empty source; normalise both ends
    // so `empty` is true for the reason it is meant to be true.
    if (held.count <= 0) held.clear();
    if (this.offhand.count <= 0) this.offhand.clear();
    this.changed();
  }

  /**
   * @param {number} [wear] how used the item is, for the things that carry it.
   *   Only ever meaningful for a stack of one — a tool — because that is the
   *   only kind of item with durability, and two tools at different wear are
   *   not interchangeable anyway. Stacking is left alone: a stackable item's
   *   wear is always 0, so there is nothing to merge or lose.
   *
   *   It exists because leaving it out silently repaired things. `Drops.spawn`
   *   stores wear, the merge test compares it, the save round-trips it, and
   *   every producer — dropping by hand, a broken kiln, a broken crate, your
   *   own death pack — passes it in. `Drops` even hands it to the pickup
   *   callback. It was thrown away at this one step, where a slot was filled
   *   with the default of 0, so an almost-broken pickaxe came back off the
   *   floor as good as new. Dying repaired your whole toolkit.
   * @returns {number} how many were actually taken in
   */
  add(itemId, count = 1, wear = 0) {
    if (!itemId || count <= 0) return 0;
    const max = ITEMS[itemId]?.stack ?? 64;
    let left = count;
    if (max > 1) {
      for (let i = 0; i < TOTAL && left > 0; i++) {
        const s = this.slots[i];
        if (s.item === itemId && s.count < max) {
          const take = Math.min(max - s.count, left);
          s.count += take; left -= take;
        }
      }
    }
    for (let i = 0; i < TOTAL && left > 0; i++) {
      const s = this.slots[i];
      if (s.empty) {
        const take = Math.min(max, left);
        s.set(itemId, take, max === 1 ? wear : 0);
        left -= take;
      }
    }
    if (left !== count) this.changed();
    return count - left;
  }

  count(itemId) {
    let n = 0;
    for (const s of this.slots) if (s.item === itemId) n += s.count;
    return n;
  }

  /**
   * How many of an item the acting hand can actually reach — the offhand
   * included.
   *
   * `count` deliberately walks `slots` alone, because the offhand is
   * deliberately *not* in `slots`: see the field's own note, that is what stops
   * a recipe, the merchant's sell list or the "Can Craft" sidebar spending the
   * torch you parked in your left hand. Ammunition is the one thing that wants
   * the opposite answer. A quiver is not a crafting reagent — you put arrows in
   * the left hand precisely so the bow could find them — and the bow reported
   * being out of them because the only place it looked was `slots`.
   *
   * Kept as its own pair of methods rather than folded into `count`/`remove`
   * for exactly the reason above: every other caller of those two is a place
   * the offhand must stay out of.
   */
  countWithOffhand(itemId) {
    if (!itemId) return 0;
    return (this.offhand.item === itemId ? this.offhand.count : 0) + this.count(itemId);
  }

  /**
   * Take `count` of an item, **the offhand first**, then storage.
   *
   * Minecraft's order, and the reasoning survives the port: the offhand is the
   * one slot you had to deliberately put something in, so it is a statement of
   * intent about which stack you want spent. Draining it first also means the
   * left hand empties visibly as you shoot — the quiver you can see is the
   * quiver that goes down — where storage-first would leave that stack frozen
   * at 12 for a hundred arrows and read as a broken counter.
   *
   * @returns {number} how many were actually taken
   */
  removeWithOffhand(itemId, count) {
    if (!itemId || count <= 0) return 0;
    let left = count;
    const o = this.offhand;
    if (o.item === itemId && o.count > 0) {
      const take = Math.min(o.count, left);
      o.count -= take;
      left -= take;
      if (o.count <= 0) o.clear();
    }
    if (left > 0) left -= this.remove(itemId, left);
    if (left !== count) this.changed();
    return count - left;
  }

  /** Take `count` of an item out of storage. Returns how many were removed. */
  remove(itemId, count) {
    let left = count;
    for (let i = TOTAL - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (s.item !== itemId) continue;
      const take = Math.min(s.count, left);
      s.count -= take;
      left -= take;
      if (s.count <= 0) s.clear();
    }
    return count - left;
  }

  hasRoom(itemId) {
    const max = ITEMS[itemId]?.stack ?? 64;
    return this.slots.some((s) => s.empty || (s.item === itemId && s.count < max));
  }

  /**
   * Is there room for *this many*, not merely for one?
   *
   * `hasRoom` answers the one-item question, which is the right question for
   * picking a drop up off the floor and the wrong one everywhere a transaction
   * hands over a batch. Three places asked it and then added more than one
   * without reading the result: crafting from the sidebar, selling to the
   * merchant, and handing over an errand. Each destroyed the surplus — craft
   * planks with one free slot and three of the four vanish; sell a gold ingot
   * with 63 coins in your last stack and eleven coins evaporate after the
   * merchant has already paid for them.
   */
  roomFor(itemId, count = 1) {
    if (!itemId || count <= 0) return true;
    const max = ITEMS[itemId]?.stack ?? 64;
    let room = 0;
    for (const s of this.slots) {
      if (s.empty) room += max;
      else if (max > 1 && s.item === itemId && s.count < max) room += max - s.count;
      if (room >= count) return true;
    }
    return false;
  }

  /**
   * Consume one of the held stack (placing a block).
   *
   * @param {number} [n]
   * @param {Slot} [s] the hand that did it, when the caller has already worked
   *   that out. Passed by every branch of the right-button chain, because
   *   `active()` answers "the main hand unless it is empty" and the button now
   *   resolves further than that: with a pickaxe in the right hand and bread in
   *   the left, defaulting here would have taken a bite out of the pickaxe.
   */
  consumeHeld(n = 1, s = this.active()) {
    // `active()`, not `held()`: whichever hand did the thing pays for it. With
    // `held()` an offhand placement would have taken a torch off an empty main
    // hand — which is to say off nothing, giving infinite torches to anyone who
    // emptied their hotbar slot.
    if (s.empty) return false;
    s.count -= n;
    if (s.count <= 0) s.clear();
    this.changed();
    return true;
  }

  /**
   * Apply tool wear; returns true if the tool broke.
   * @param {number} [amount]
   * @param {Slot} [s] the hand that swung, see `consumeHeld`.
   */
  damageHeld(amount = 1, s = this.active()) {
    // Same rule as consumeHeld: the tool that swung is the tool that wears.
    const def = ITEMS[s.item];
    if (!def?.tool) return false;
    s.wear += amount;
    if (s.wear >= def.tool.durability) { s.clear(); this.changed(); return true; }
    this.changed();
    return false;
  }

  // --- crafting -------------------------------------------------------------

  craftGrid(size) {
    return size === 2
      ? [this.craft[0], this.craft[1], this.craft[3], this.craft[4]]
      : this.craft;
  }

  consumeCraft(size) {
    const g = this.craftGrid(size);
    for (const s of g) {
      if (s.empty) continue;
      s.count--;
      if (s.count <= 0) s.clear();
    }
    this.changed();
  }

  /** Drop everything on the crafting grid back into storage. */
  clearCraft() {
    const spill = [];
    for (const s of this.craft) {
      if (s.empty) continue;
      // Wear rides along, both into the slot and into whatever spills onto the
      // floor. Without it, parking a nearly-broken sword in the craft grid and
      // closing the screen handed it back pristine.
      const taken = this.add(s.item, s.count, s.wear);
      if (taken < s.count) spill.push({ item: s.item, count: s.count - taken, wear: s.wear });
      s.clear();
    }
    this.changed();
    return spill;
  }

  // --- persistence ----------------------------------------------------------

  toJSON() {
    // No `armour` key any more. A save written by this build and opened by an
    // older one loses the worn set rather than corrupting anything — the old
    // loader defaults a missing key to four empty slots — and the pieces it
    // would have found have already been paid out as skill points.
    return {
      slots: this.slots.map((s) => s.toJSON()),
      selected: this.selected,
      // The two places items can be sitting that are not `slots`.
      //
      // Closing a screen returns both, and every deliberate exit routes through
      // that — but `beforeunload` and the ninety-second autosave do not. Shut
      // the tab with a stack on the cursor, or with anything in the craft grid,
      // and the save was written from `slots` alone and the stack was gone.
      cursor: this.cursor.toJSON(),
      craft: this.craft.map((s) => s.toJSON()),
    };
  }

  /**
   * The offhand's saved form, and its restore.
   *
   * Deliberately not inside `toJSON`/`fromJSON`: it rides in the save's
   * `player` object beside the chosen character, because it is a fact about the
   * person rather than about their bags — see `_savePayload`. Two small methods
   * rather than reaching into `inv.offhand` from the save code, so `Slot`'s
   * encoding stays this module's business.
   */
  offhandJSON() { return this.offhand.toJSON(); }
  loadOffhand(v) { this.offhand = Slot.fromJSON(v); this.changed(); }

  fromJSON(data) {
    if (!data) return;
    this.slots = Array.from({ length: TOTAL }, (_, i) => Slot.fromJSON(data.slots?.[i]));
    // Emptied here even though it is not in `data` — precisely because it is
    // not in `data`. `fromJSON` is the line that means "this inventory is now
    // that save's inventory", and a field it silently left alone would be a
    // field that survived the change of world. `_resetWorld` happens to build a
    // fresh Inventory today, so nothing is currently relying on this; that is a
    // property of the caller, not of this method. `loadOffhand` runs after.
    this.offhand.clear();
    // The worn set, read for the last time. Saves from before armour existed
    // and saves from after it was removed both have no `armour` key, and both
    // want the same answer — nothing to convert.
    this.legacyArmour = (data.armour || []).map((v) => Slot.fromJSON(v));
    // Restored, not dropped on the floor: a save written mid-drag should put
    // you back exactly where you were. Absent in older saves, where
    // `Slot.fromJSON(undefined)` is an empty slot, which is the right answer.
    this.cursor = Slot.fromJSON(data.cursor);
    this.craft = Array.from({ length: 9 }, (_, i) => Slot.fromJSON(data.craft?.[i]));
    this.selected = data.selected || 0;
    this.changed();
  }
}
