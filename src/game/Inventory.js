// Player inventory: 9 hotbar slots + 27 storage, plus a crafting grid and the
// cursor stack used while dragging.

import { ITEMS } from './Items.js';

export const HOTBAR = 9;
export const STORAGE = 27;
export const TOTAL = HOTBAR + STORAGE;

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

  /** @returns {number} how many were actually taken in */
  add(itemId, count = 1) {
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
        s.set(itemId, take);
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

  /** Consume one of the held stack (placing a block). */
  consumeHeld(n = 1) {
    const s = this.held();
    if (s.empty) return false;
    s.count -= n;
    if (s.count <= 0) s.clear();
    this.changed();
    return true;
  }

  /** Apply tool wear; returns true if the tool broke. */
  damageHeld(amount = 1) {
    const s = this.held();
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
      const taken = this.add(s.item, s.count);
      if (taken < s.count) spill.push({ item: s.item, count: s.count - taken });
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
    this.selected = data.selected || 0;
    this.changed();
  }
}
