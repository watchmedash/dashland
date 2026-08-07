// Shared helpers for reading the Lynocs PBR pack.
// The maps ship as 32-bit uncompressed BMPs (bottom-up BGRA) plus a PNG or BMP
// diffuse, so we need a tiny BMP decoder before handing anything to sharp.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const PACK = 'C:/Users/User/Desktop/model/Texture Pack by Lynocs';

/** Decode a 24/32-bit uncompressed BMP into {data: RGBA, width, height}. */
export function readBMP(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error(`not a BMP: ${file}`);
  const dataOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (compression !== 0 && compression !== 3) throw new Error(`compressed BMP unsupported: ${file}`);
  if (bpp !== 32 && bpp !== 24) throw new Error(`${bpp}bpp BMP unsupported: ${file}`);

  const bytes = bpp / 8;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = dataOffset + (bottomUp ? (height - 1 - y) : y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * bytes;
      const d = (y * width + x) * 4;
      out[d] = buf[s + 2];        // R  <- BMP stores BGR
      out[d + 1] = buf[s + 1];    // G
      out[d + 2] = buf[s];        // B
      out[d + 3] = bpp === 32 ? buf[s + 3] : 255;
    }
  }
  return { data: out, width, height };
}

/** Any pack map (bmp or png) as a sharp pipeline. */
export function loadMap(file) {
  if (file.toLowerCase().endsWith('.bmp')) {
    const { data, width, height } = readBMP(file);
    return sharp(data, { raw: { width, height, channels: 4 } });
  }
  return sharp(file);
}

/**
 * Resolve the files for one material variant, e.g. ('Grass', '3').
 * Diffuse is inconsistently named across the pack, so try the known variants.
 */
export function materialFiles(category, variant) {
  const dir = path.join(PACK, category, String(variant));
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const find = (...suffixes) => {
    for (const suf of suffixes) {
      const hit = files.find((f) => f.toLowerCase().endsWith(suf));
      if (hit) return path.join(dir, hit);
    }
    return null;
  };
  const diffuse = find('_diffuseoriginal.png', '_diffuseoriginal.bmp')
    || files.filter((f) => /^\d+\.(png|bmp|jpg)$/i.test(f)).map((f) => path.join(dir, f))[0]
    || null;
  return {
    dir,
    diffuse,
    normal: find('_normal.bmp', '_normal.png'),
    ao: find('_ao.bmp', '_ao.png'),
    smoothness: find('_smoothness.bmp', '_smoothness.png'),
    metallic: find('_metallic.bmp', '_metallic.png'),
    height: find('_height.bmp', '_height.png'),
  };
}

export function listVariants(category) {
  const dir = path.join(PACK, category);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
    .sort((a, b) => (+a || 0) - (+b || 0));
}
