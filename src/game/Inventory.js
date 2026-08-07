// Player inventory: 9 hotbar slots + 27 storage, plus a crafting grid and the
// cursor stack used while dragging.

import { ITEMS, ARMOUR_SLOT_ORDER, armourReduction } from './Items.js';

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
    // Worn armour, in ARMOUR_SLOT_ORDER. Kept out of `slots` so nothing that
    // walks the carried inventory — crafting costs, the recipe sidebar, a
    // merchant's buy list — can quietly consume the boots off your feet.
    this.armour = Array.from({ length: ARMOUR_SLOT_ORDER.length }, () => new Slot());
    this.cursor = new Slot();
    this.selected = 0;
    this.onChange = null;
  }

  changed() { this.onChange?.(); }

  /** Fraction of an incoming blow the worn set absorbs, 0..0.8. */
  get protection() { return armourReduction(this.armour); }

  /** Which equipment slot an item belongs in, or -1 if it isn't armour. */
  static armourIndexOf(itemId) {
    const slot = ITEMS[itemId]?.armour?.slot;
    return slot ? ARMOUR_SLOT_ORDER.indexOf(slot) : -1;
  }

  /**
   * Spread `damage` across the worn pieces and drop any that give out.
   * @returns {number[]} indices of pieces that broke
   */
  wearArmour(damage = 1) {
    const broken = [];
    for (let i = 0; i < this.armour.length; i++) {
      const s = this.armour[i];
      if (s.empty) continue;
      const max = ITEMS[s.item]?.armour?.durability ?? 0;
      if (!max) continue;
      s.wear += damage;
      if (s.wear >= max) { s.clear(); broken.push(i); }
    }
    if (broken.length) this.changed();
    return broken;
  }

  held() { return this.slots[this.selected]; }
  heldDef() { return ITEMS[this.slots[this.selected].item] || null; }

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
    return {
      slots: this.slots.map((s) => s.toJSON()),
      armour: this.armour.map((s) => s.toJSON()),
      selected: this.selected,
    };
  }

  fromJSON(data) {
    if (!data) return;
    this.slots = Array.from({ length: TOTAL }, (_, i) => Slot.fromJSON(data.slots?.[i]));
    // Saves written before armour existed have no `armour` key at all, and
    // fromJSON(undefined) is already an empty slot — so they load bare-headed
    // rather than failing.
    this.armour = Array.from({ length: ARMOUR_SLOT_ORDER.length },
      (_, i) => Slot.fromJSON(data.armour?.[i]));
    this.selected = data.selected || 0;
    this.changed();
  }
}
