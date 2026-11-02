// node build.mjs <skin> [--allow-mismatch]
// raw/<skin>/<action>.png -> assets/sprites/<skin>.webp + manifest.json + out/<skin>_check.png
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  keyBackground, splitFrames, measure, placeInCell, normScale, findFeet, transitionIssues, cushionRatios, matchCushion, SEATED_MIN_GR, ALPHA_ON,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RAW = join(HERE, 'raw');
const OUT = join(HERE, 'out');
const SPRITES = join(ROOT, 'assets', 'sprites');
const MANIFEST = join(SPRITES, 'manifest.json');
const RED = [230, 20, 20, 255];
const BLUE = [30, 60, 200, 255];

class UserError extends Error {}

async function readRgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

function crop(img, x0, x1) {
  const w = x1 - x0 + 1;
  const data = new Uint8Array(w * img.height * 4);
  for (let y = 0; y < img.height; y++)
    data.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x1 + 1) * 4), y * w * 4);
  return { data, width: w, height: img.height };
}

function opaqueHeight(img) {
  let top = -1, bottom = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] > ALPHA_ON) { if (top < 0) top = y; bottom = y; break; }
  return top < 0 ? 0 : bottom - top + 1;
}

// Composite src (RGBA cell) over dst at (dx, dy), alpha "over".
function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      const a = src.data[s + 3] / 255;
      if (!a) continue;
      const d = ((dy + y) * dst.width + dx + x) * 4;
      const da = dst.data[d + 3] / 255;
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++)
        dst.data[d + c] = Math.round((src.data[s + c] * a + dst.data[d + c] * da * (1 - a)) / oa);
      dst.data[d + 3] = Math.round(oa * 255);
    }
}

function canvas(width, height) {
  return { data: new Uint8Array(width * height * 4), width, height };
}

function checker(width, height, size = 12) {
  const img = canvas(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = ((x / size | 0) + (y / size | 0)) % 2 ? 150 : 110;
      img.data.set([v, v, v, 255], (y * width + x) * 4);
    }
  return img;
}

function hline(img, y, rgba) { for (let x = 0; x < img.width; x++) img.data.set(rgba, (y * img.width + x) * 4); }
function vline(img, x, y0, y1, rgba) { for (let y = y0; y < y1; y++) img.data.set(rgba, (y * img.width + x) * 4); }

const whole = (img) => ({ x0: 0, x1: img.width - 1 });

// Key, split and measure one raw strip (no scaling yet). cushionRef: recolour a too-red cushion.
function prepare(img, a, name, cushionRef = null) {
  const keyed = cushionRef ? matchCushion(keyBackground(img), cushionRef) : keyBackground(img);
  let strips;
  try {
    strips = splitFrames(keyed, a.frames);
  } catch (e) {
    throw new UserError(`${name}: ${e.message}`);
  }
  const frames = strips.map((s) => crop(keyed, s.x0, s.x1));
  return { frames, ms: frames.map((f) => measure(f, whole(f))) };
}

function place(name, prep, scale, cell, mOf = (m) => m) {
  return prep.frames.map((f, i) => {
    const c = placeInCell(f, mOf(prep.ms[i]), scale, cell);
    if (c.clipped) console.warn(`build: WARNING ${name} frame ${i + 1} was clipped`);
    return c;
  });
}

// Walk rows: torso centre on ax, lowest pixel (feet) on ay, one median scale per strip.
function buildWalk(name, prep, a, extra, cell) {
  const scale = normScale(prep.ms, a.rule, a.targetH) * extra;
  return { cells: place(name, prep, scale, cell, (m) => ({ ...m, cx: m.tx })), scale };
}

/**
 * Seated rows share one placement so they line up through the cushion:
 * sit_down frame 0's feet land on the last walk_back frame's feet, its standing body
 * (top..feet) is as tall as the walk, and every seated frame puts its cushion where that
 * placement put frame 0's cushion. idle/bow/thank are scaled so their first frame is as
 * tall as the last sit_down frame.
 */
function buildSeated(preps, walkCells, walkH, cell) {
  const sit = preps.sit_down;
  const feet0 = findFeet(sit.frames[0], whole(sit.frames[0]), { minGR: SEATED_MIN_GR });
  if (!feet0) throw new UserError('sit_down frame 1: no bare feet found (skin colour) to anchor on');
  const m0 = sit.ms[0];
  const scale = walkH / (feet0.y - m0.top + 1);
  const walkLast = walkCells[walkCells.length - 1];
  const wf = findFeet(walkLast, whole(walkLast)) || { x: cell.ax, y: cell.ay };
  const seatCell = {
    ...cell,
    ax: wf.x + (m0.cx - feet0.x) * scale,
    ay: wf.y + (m0.bottom - feet0.y) * scale,
  };
  if (seatCell.ay > cell.h - 1) console.warn(`build: WARNING cushion bottom y ${seatCell.ay.toFixed(1)} is outside the cell`);
  const rows = { sit_down: { cells: place('sit_down', sit, scale, seatCell), scale } };
  const last = sit.ms[sit.ms.length - 1];
  const lastH = (last.bottom - last.top + 1) * scale;
  for (const name of ['idle', 'bow', 'thank']) {
    const s = normScale(preps[name].ms, 'first', lastH);
    rows[name] = { cells: place(name, preps[name], s, seatCell), scale: s };
  }
  return { rows, seatCell };
}

function transitionNumbers(rows) {
  const lastOf = (n) => rows[n].cells[rows[n].cells.length - 1];
  const feetOf = (c, opts) => {
    const f = findFeet(c, whole(c), opts);
    return f && { feetX: f.x, feetY: f.y, h: f.y - measure(c, whole(c)).top + 1 };
  };
  const seat = (c) => {
    const m = measure(c, whole(c));
    return { top: m.top, bottom: m.bottom, cx: m.cx };
  };
  return {
    walk: feetOf(lastOf('walk_back')),
    sit: feetOf(rows.sit_down.cells[0], { minGR: SEATED_MIN_GR }),
    sitLast: seat(lastOf('sit_down')),
    idle: seat(rows.idle.cells[0]),
  };
}

function printTransitions(t) {
  const f = (v) => v.toFixed(1);
  if (t.walk && t.sit) {
    console.log(`build: walk_back last -> sit_down 1: feet (${f(t.walk.feetX)}, ${t.walk.feetY}) -> ` +
      `(${f(t.sit.feetX)}, ${t.sit.feetY}), standing h ${t.walk.h} -> ${t.sit.h} ` +
      `(${f((100 * (t.sit.h - t.walk.h)) / t.walk.h)}%)`);
  }
  console.log(`build: sit_down last -> idle: top ${t.sitLast.top} -> ${t.idle.top}, ` +
    `bottom ${t.sitLast.bottom} -> ${t.idle.bottom}, cx ${f(t.sitLast.cx)} -> ${f(t.idle.cx)}`);
}

async function encodeSheet(cfg, skin, rows, cw, ch) {
  const sheet = canvas(cw * cfg.maxCols, ch * cfg.rows.length);
  cfg.rows.forEach((name, r) => {
    if (rows[name].cells.length > cfg.maxCols) throw new UserError(`${name} has more than ${cfg.maxCols} frames`);
    rows[name].cells.forEach((c, i) => blit(sheet, c, i * cw, r * ch));
  });
  const webp = await sharp(Buffer.from(sheet.data), { raw: { width: sheet.width, height: sheet.height, channels: 4 } })
    .webp({ quality: 82, alphaQuality: 90, effort: 6 })
    .toBuffer();
  const kb = webp.length / 1024;
  if (kb > cfg.maxSheetKB) throw new UserError(`${skin}.webp is ${kb.toFixed(0)} KB, over the ${cfg.maxSheetKB} KB budget`);
  return { webp, kb };
}

async function build(skin, { allowMismatch = false } = {}) {
  const cfg = JSON.parse(readFileSync(join(HERE, 'prompts.json'), 'utf8'));
  const [cw, ch] = cfg.cell;
  const cell = { w: cw, h: ch, ax: cfg.anchor[0], ay: cfg.anchor[1] };
  const extra = cfg.skinScale[skin] ?? 1;

  const missing = cfg.rows.map((r) => join(RAW, skin, `${r}.png`)).filter((f) => !existsSync(f));
  if (missing.length) {
    throw new UserError(`missing raw image(s) for skin "${skin}":\n  ${missing.map((f) => relative(ROOT, f)).join('\n  ')}\n` +
      `generate them with: node gen.mjs ${skin} <action>`);
  }

  const preps = {};
  const recolour = (cfg.cushionMatch || {})[skin] || [];
  for (const name of cfg.rows) {
    let ref = null;
    if (recolour.includes(name)) {
      if (!preps.idle) throw new UserError(`cushionMatch: idle must be built before ${name}`);
      ref = cushionRatios(preps.idle.frames[0], whole(preps.idle.frames[0]));
      console.log(`build: ${name} cushion recoloured to idle ratios G/R ${ref.gr.toFixed(2)} B/R ${ref.br.toFixed(2)}`);
    }
    preps[name] = prepare(await readRgba(join(RAW, skin, `${name}.png`)), cfg.actions[name], name, ref);
  }

  const rows = {};
  for (const name of cfg.rows.filter((r) => r.startsWith('walk_'))) {
    rows[name] = buildWalk(name, preps[name], cfg.actions[name], extra, cell);
  }
  const seated = buildSeated(preps, rows.walk_back.cells, cfg.actions.walk_back.targetH * extra, cell);
  Object.assign(rows, seated.rows);
  for (const name of cfg.rows) console.log(`build: ${name.padEnd(10)} ${rows[name].cells.length} frames, scale ${rows[name].scale.toFixed(3)}`);
  console.log(`build: seated rows put the cushion bottom centre at (${seated.seatCell.ax.toFixed(1)}, ${seated.seatCell.ay.toFixed(1)})`);
  const seatH = opaqueHeight(rows.idle.cells[0]);

  const t = transitionNumbers(rows);
  printTransitions(t);
  const issues = transitionIssues(t);
  if (issues.length) {
    const msg = `transition mismatch for "${skin}":\n  ${issues.join('\n  ')}`;
    if (!allowMismatch) throw new UserError(`${msg}\n(re-run with --allow-mismatch to write the sheet anyway)`);
    console.warn(`build: WARNING ${msg}`);
  }

  const { webp, kb } = await encodeSheet(cfg, skin, rows, cw, ch);
  mkdirSync(SPRITES, { recursive: true });
  writeFileSync(join(SPRITES, `${skin}.webp`), webp);
  writeManifest(cfg, skin, seatH);
  await writeCheck(cfg, skin, rows, cell);
  console.log(`build: wrote assets/sprites/${skin}.webp (${kb.toFixed(1)} KB), manifest, out/${skin}_check.png; seatH ${seatH}`);
}

function writeManifest(cfg, skin, seatH) {
  const actions = {};
  cfg.rows.forEach((name, row) => {
    const { frames, stride, fps, loop, yoyo, hold } = cfg.actions[name];
    actions[name] = { row, frames, ...(stride && { stride }), ...(fps && { fps }), ...(loop && { loop }),
      ...(yoyo && { yoyo }), ...(hold && { hold }) };
  });
  for (const [name, d] of Object.entries(cfg.derived || {})) {
    actions[name] = { ...actions[d.from], ...(d.reverse && { reverse: true }) };
  }
  const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  const manifest = {
    version: 2, cell: cfg.cell, anchor: cfg.anchor, alias: cfg.alias,
    skins: { ...(prev.skins || {}), [skin]: { src: `${skin}.webp`, seatH, actions } },
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

// Check image: sheet rows on a checkerboard + transition pairs row, red anchor lines.
async function writeCheck(cfg, skin, rows, cell) {
  const last = (n) => rows[n].cells[rows[n].cells.length - 1];
  const first = (n) => rows[n].cells[0];
  const pairs = [
    [last('walk_back'), first('sit_down')],
    [last('sit_down'), first('idle')],
    [first('idle'), first('bow')],
    [first('idle'), first('thank')],
  ];
  const cols = Math.max(cfg.maxCols, pairs.length * 2);
  const img = checker(cell.w * cols, cell.h * (cfg.rows.length + 1));
  cfg.rows.forEach((name, r) => rows[name].cells.forEach((c, i) => blit(img, c, i * cell.w, r * cell.h)));
  const pr = cfg.rows.length;
  pairs.flat().forEach((c, i) => blit(img, c, i * cell.w, pr * cell.h));
  for (let r = 0; r <= cfg.rows.length; r++) hline(img, r * cell.h + cell.ay, RED);
  for (let c = 0; c < cols; c++) vline(img, c * cell.w + cell.ax, 0, img.height, RED);
  for (let r = 1; r <= cfg.rows.length; r++) hline(img, r * cell.h, BLUE);
  for (let p = 1; p < pairs.length; p++) vline(img, p * 2 * cell.w, pr * cell.h, img.height, BLUE);
  mkdirSync(OUT, { recursive: true });
  await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png().toFile(join(OUT, `${skin}_check.png`));
}

const skin = process.argv[2];
const allowMismatch = process.argv.includes('--allow-mismatch');
if (!skin || skin.startsWith('-')) {
  console.error('usage: node build.mjs <skin> [--allow-mismatch]');
  process.exit(1);
}
build(skin, { allowMismatch }).catch((e) => {
  console.error(`build: ${e instanceof UserError ? e.message : e.stack || e.message}`);
  process.exit(1);
});
