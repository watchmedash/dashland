// The app icon, generated from the game's own mark.
//
// The APK shipped Capacitor's default icon, which is a stranger's logo on the
// owner's game. This draws the same nine-tile mark the loading screen and the
// title card carry - five continuous faces in a plus, four sealed corners, a
// violet seal between them - and writes every density Android asks for.
//
//   node scripts/make-icons.mjs
//
// Run it when the mark changes. It is not part of the build: an icon is a
// deliverable, not an artefact, and regenerating it on every `npm run build`
// would put five binary files in every diff.

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'android/app/src/main/res');

// The palette, matching the favicon in index.html and `.world-mark` in
// style.css. Four corners in their own colour, the plus in land, and the seal.
const INK = '#120c06';
const LAND = '#4d6d33';
const LAND_LIT = '#6f8f45';
const RIME = '#a8d2e8';
const UMBRA = '#4a4d78';
const AURORA = '#3a8f45';
const PYRE = '#8f2a12';
const SEAL = '#c450ff';

/**
 * The mark as an SVG, drawn on a 9x9 grid of three-unit cells.
 *
 * `pad` is the margin around it in the same units, and it is the whole
 * difference between the two icons this script writes: a legacy launcher icon
 * is the full square, while an adaptive FOREGROUND is cropped to roughly the
 * middle two thirds by the launcher's own mask, so its art has to sit inside
 * that or the corners of the mark are shaved off on a round-icon phone.
 */
function markSvg({ size, pad = 0, background = null }) {
  const span = 9 + pad * 2;
  const bg = background
    ? `<rect width="${span}" height="${span}" fill="${background}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges">
  ${bg}
  <g transform="translate(${pad} ${pad})">
    <rect width="9" height="9" fill="${INK}"/>
    <rect x="3" width="3" height="3" fill="${LAND}"/>
    <rect y="3" width="3" height="3" fill="${LAND}"/>
    <rect x="3" y="3" width="3" height="3" fill="${LAND_LIT}"/>
    <rect x="6" y="3" width="3" height="3" fill="${LAND}"/>
    <rect x="3" y="6" width="3" height="3" fill="${LAND}"/>
    <rect width="3" height="3" fill="${RIME}"/>
    <rect x="6" width="3" height="3" fill="${UMBRA}"/>
    <rect y="6" width="3" height="3" fill="${AURORA}"/>
    <rect x="6" y="6" width="3" height="3" fill="${PYRE}"/>
    <path d="M3 0v3H0M6 0v3h3M3 9V6H0M6 9V6h3" fill="none" stroke="${SEAL}" stroke-width=".6" stroke-linecap="square"/>
  </g>
</svg>`;
}

/** Density buckets, and the two sizes each one wants. */
const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

for (const [density, legacy, foreground] of DENSITIES) {
  const dir = join(RES, `mipmap-${density}`);
  await mkdir(dir, { recursive: true });

  // The legacy icon: full bleed, no padding. Old launchers draw it as-is.
  const square = await png(markSvg({ size: legacy }));
  await writeFile(join(dir, 'ic_launcher.png'), square);
  // The round one is the same square art. A round mask over a nine-tile grid
  // takes the corner tiles' outer corners and leaves the mark legible; drawing
  // a circle here instead would put a second silhouette inside the mask.
  await writeFile(join(dir, 'ic_launcher_round.png'), square);

  // The adaptive foreground: transparent, and inset so the launcher's mask
  // cannot crop the mark. 1.6 units of padding on a 9-unit mark leaves it at
  // 74% of the tile, comfortably inside the 66% safe zone once the 108dp
  // canvas is accounted for.
  await writeFile(
    join(dir, 'ic_launcher_foreground.png'),
    await png(markSvg({ size: foreground, pad: 1.6 })),
  );
  console.log(`  mipmap-${density}  ${legacy}px legacy, ${foreground}px foreground`);
}

// The colour behind the adaptive foreground, which is what shows through the
// padding above. The game's ink, so the icon has the same ground as the mark.
const colors = join(RES, 'values/ic_launcher_background.xml');
await mkdir(dirname(colors), { recursive: true });
await writeFile(colors, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${INK}</color>
</resources>
`);
console.log(`  values/ic_launcher_background.xml  ${INK}`);

// ...and a 512 for the store listings, which want one and will not take a PNG
// out of a mipmap folder.
await mkdir(join(ROOT, 'docs'), { recursive: true });
await writeFile(join(ROOT, 'docs/icon-512.png'), await png(markSvg({ size: 512 })));
console.log('  docs/icon-512.png  512px, for store listings');
