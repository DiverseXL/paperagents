/**
 * One-off favicon generator for PaperAgents.
 *
 * Takes the approved artwork (public/favicon-source.png — a torn note with a
 * hand-drawn star, black ink on off-white) and produces the favicon set:
 * 16/32/48/180/192/512 PNGs plus app/favicon.ico (16+32+48 combined).
 *
 * The source has a paper-grain background, so sharp's .trim() alone finds no
 * uniform border. Instead the artwork's bounding box is computed by scanning
 * raw pixels for luminance that differs from the background (corner patches),
 * the box is cropped, centered on a square #F7F5F0 canvas, and resized.
 * No redrawing or reinterpretation of the artwork — pure processing.
 *
 * Run: node scripts/generate-favicons.mjs
 */
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = "./public/favicon-source.png";
const PAPER = { r: 247, g: 245, b: 240 }; // --paper from globals.css
const LUM_THRESHOLD = 15; // |lum - bg| above this counts as artwork
const MARGIN_FRAC = 0.03; // breathing room around the artwork, as a fraction

const SIZES = [
  { file: "public/favicon-16.png", size: 16 },
  { file: "public/favicon-32.png", size: 32 },
  { file: "public/favicon-48.png", size: 48 },
  { file: "public/apple-touch-icon.png", size: 180 },
  { file: "public/icon-192.png", size: 192 },
  { file: "public/icon-512.png", size: 512 },
];

if (!existsSync(SRC)) {
  console.error(`Source not found: ${SRC}`);
  process.exit(1);
}

// ── 1. Locate the artwork's bounding box ────────────────────────────────
const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
const { width: w, height: h, channels: ch } = info;

const patchLum = (x0, y0) => {
  let sum = 0, n = 0;
  for (let y = y0; y < y0 + 10; y++) {
    for (let x = x0; x < x0 + 10; x++) {
      const i = (y * w + x) * ch;
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
  }
  return sum / n;
};
const bgLum =
  (patchLum(0, 0) + patchLum(w - 10, 0) + patchLum(0, h - 10) + patchLum(w - 10, h - 10)) / 4;

let minX = w, minY = h, maxX = -1, maxY = -1;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * ch;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (Math.abs(lum - bgLum) > LUM_THRESHOLD) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) {
  console.error("No artwork found in source image.");
  process.exit(1);
}

// ── 2. Crop, then pad to a square #F7F5F0 canvas with a small margin ──────
// (extend() pads with the paper color — no compositing needed.)
const artW = maxX - minX + 1;
const artH = maxY - minY + 1;
const margin = Math.max(4, Math.round(Math.max(artW, artH) * MARGIN_FRAC));
const side = Math.max(artW, artH) + margin * 2;

const artwork = await sharp(SRC)
  .extract({ left: minX, top: minY, width: artW, height: artH })
  .flatten({ background: PAPER }) // kill any stray alpha; bake the paper tone
  .png()
  .toBuffer();

const padTop = Math.round((side - artH) / 2);
const padLeft = Math.round((side - artW) / 2);
const square = await sharp(artwork)
  .extend({
    top: padTop + margin,
    bottom: side - artH - padTop + margin,
    left: padLeft + margin,
    right: side - artW - padLeft + margin,
    background: PAPER,
  })
  .png()
  .toBuffer();

console.log(
  `artwork bbox: x ${minX}-${maxX} (w ${artW}), y ${minY}-${maxY} (h ${artH}) | ` +
    `square canvas: ${side}x${side} | bg luminance: ${bgLum.toFixed(1)}`
);

// ── 3. Render every size, verify, and report ────────────────────────────
const icoInputs = [];
for (const { file, size } of SIZES) {
  const buf = await sharp(square).resize(size, size).png().toBuffer();
  await writeFile(file, buf);
  const meta = await sharp(buf).metadata();
  const bytes = statSync(file).size;
  const ok = meta.width === size && meta.height === size && bytes > 0;
  console.log(`${ok ? "OK " : "FAIL"} ${file} -> ${meta.width}x${meta.height} png, ${bytes} bytes`);
  if (size === 16 || size === 32 || size === 48) icoInputs.push(buf);
}

// ── 4. Combine 16/32/48 into app/favicon.ico ────────────────────────────
await mkdir(dirname("./app/favicon.ico"), { recursive: true });
const ico = await pngToIco(icoInputs);
await writeFile("./app/favicon.ico", ico);
console.log(`OK  app/favicon.ico -> ${ico.length} bytes (16+32+48 combined)`);
