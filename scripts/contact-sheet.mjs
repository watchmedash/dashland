// Build a labelled contact sheet of every variant in the given categories, so
// material choices are made by looking rather than guessing.
//   node scripts/contact-sheet.mjs Grass Ground Sand > sheet.png

import sharp from 'sharp';
import fs from 'node:fs';
import { listVariants, materialFiles, loadMap } from './texlib.mjs';

const CELL = 128;
const COLS = 10;

const categories = process.argv.slice(2);
if (!categories.length) {
  console.error('usage: node scripts/contact-sheet.mjs <Category> [...]');
  process.exit(1);
}

const rows = [];
for (const cat of categories) {
  const variants = listVariants(cat);
  for (let i = 0; i < variants.length; i += COLS) {
    rows.push({ cat, chunk: variants.slice(i, i + COLS), first: i === 0 });
  }
}

const W = CELL * COLS;
const H = CELL * rows.length;
const composites = [];

for (let r = 0; r < rows.length; r++) {
  const { cat, chunk } = rows[r];
  for (let c = 0; c < chunk.length; c++) {
    const files = materialFiles(cat, chunk[c]);
    if (!files?.diffuse) continue;
    try {
      const buf = await loadMap(files.diffuse)
        .resize(CELL, CELL, { fit: 'cover' })
        .png()
        .toBuffer();
      composites.push({ input: buf, left: c * CELL, top: r * CELL });
    } catch (e) {
      console.error(`skip ${cat}/${chunk[c]}: ${e.message}`);
    }
  }
  // label strip
  const label = Buffer.from(
    `<svg width="${W}" height="18"><rect width="${W}" height="18" fill="rgba(0,0,0,.72)"/>`
    + `<text x="4" y="13" font-family="monospace" font-size="12" fill="#ffd27f">${cat}  →  ${chunk.join('  ')}</text></svg>`,
  );
  composites.push({ input: label, left: 0, top: r * CELL });
}

await sharp({ create: { width: W, height: H, channels: 3, background: '#111' } })
  .composite(composites)
  .png()
  .toFile('sheet.png');

console.log(`wrote sheet.png  ${W}x${H}  (${rows.length} rows)`);
