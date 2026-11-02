import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keyBackground, splitFrames, measure, placeInCell, normScale, findFeet, transitionIssues, cushionRatios, matchCushion, isSkin, SEATED_MIN_GR,
} from '../lib.mjs';

const ALPHA_ON = 16;

function blank(width, height, rgba = [0, 0, 0, 0]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { data, width, height };
}

function fillRect(img, x, y, w, h, rgba) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) img.data.set(rgba, (yy * img.width + xx) * 4);
}

function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}

// Lowest row containing an opaque pixel, and the mean x of opaque pixels on that row.
function lowestOpaqueRow(img) {
  for (let y = img.height - 1; y >= 0; y--) {
    let sum = 0, n = 0;
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > ALPHA_ON) { sum += x; n++; }
    }
    if (n) return { y, cx: sum / n };
  }
  return null;
}

test('keyBackground removes flat magenta', () => {
  const img = blank(60, 40, [255, 0, 255, 255]);
  fillRect(img, 25, 10, 10, 20, [255, 0, 0, 255]);
  const out = keyBackground(img);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 60; x++) {
      const inside = x >= 25 && x < 35 && y >= 10 && y < 30;
      const a = px(out, x, y)[3];
      if (inside) assert.equal(a, 255, `red pixel ${x},${y} must stay opaque`);
      else assert.equal(a, 0, `background pixel ${x},${y} must be transparent`);
    }
  }
});

test('keyBackground despills edges', () => {
  const img = blank(60, 40, [255, 0, 255, 255]);
  fillRect(img, 20, 10, 20, 20, [128, 128, 128, 255]);
  // Column of edge pixels: 50/50 mix of #808080 and #FF00FF.
  fillRect(img, 19, 10, 1, 20, [192, 64, 192, 255]);
  const out = keyBackground(img);
  const [r, g, , a] = px(out, 19, 20);
  assert.ok(a > 0 && a < 255, `edge alpha should be partial, got ${a}`);
  assert.ok(Math.abs(r - g) < 20, `edge should lose magenta tint, got R=${r} G=${g}`);
  // Interior grey is untouched.
  assert.deepEqual(px(out, 30, 20), [128, 128, 128, 255]);
});

test('keyBackground keeps images that already have alpha', () => {
  const img = blank(20, 20);
  fillRect(img, 5, 5, 10, 10, [255, 0, 255, 255]);
  const out = keyBackground(img);
  assert.deepEqual(px(out, 10, 10), [255, 0, 255, 255]);
});

test('splitFrames finds n figures', () => {
  const img = blank(80, 30);
  fillRect(img, 5, 5, 10, 20, [0, 0, 0, 255]);
  fillRect(img, 25, 5, 10, 20, [0, 0, 0, 255]);
  fillRect(img, 45, 5, 10, 20, [0, 0, 0, 255]);
  const strips = splitFrames(img, 3);
  assert.equal(strips.length, 3);
  assert.deepEqual(strips[0], { x0: 5, x1: 14 });
  assert.deepEqual(strips[2], { x0: 45, x1: 54 });
  assert.throws(() => splitFrames(img, 4), /expected 4 frames, found 3/);
});

test('splitFrames merges gaps narrower than 4 px', () => {
  const img = blank(60, 30);
  fillRect(img, 5, 5, 10, 20, [0, 0, 0, 255]);
  fillRect(img, 17, 5, 6, 20, [0, 0, 0, 255]); // 2 px gap -> same figure
  fillRect(img, 40, 5, 10, 20, [0, 0, 0, 255]);
  assert.deepEqual(splitFrames(img, 2), [{ x0: 5, x1: 22 }, { x0: 40, x1: 49 }]);
});

test('measure finds feet', () => {
  const img = blank(40, 50);
  fillRect(img, 12, 5, 10, 30, [10, 20, 30, 255]); // y 5..34, x 12..21
  const m = measure(img, { x0: 0, x1: 39 });
  assert.equal(m.top, 5);
  assert.equal(m.bottom, 34);
  assert.ok(Math.abs(m.cx - 16.5) <= 0.5, `cx ${m.cx}`);
});

test('placeInCell aligns anchor', () => {
  for (const h of [30, 18]) {
    const img = blank(40, 50);
    fillRect(img, 12, 5, 10, h, [200, 100, 50, 255]);
    const m = measure(img, { x0: 0, x1: 39 });
    const cell = placeInCell(img, m, 2);
    assert.equal(cell.width, 192);
    assert.equal(cell.height, 240);
    const low = lowestOpaqueRow(cell);
    assert.equal(low.y, 232, `block h=${h}: lowest opaque row`);
    assert.ok(Math.abs(low.cx - 96) <= 1, `block h=${h}: cx ${low.cx}`);
  }
});

test('placeInCell does not bleed keyed background colour', () => {
  const img = blank(40, 50, [255, 0, 255, 0]); // transparent magenta
  fillRect(img, 12, 5, 10, 30, [128, 128, 128, 255]);
  const m = measure(img, { x0: 0, x1: 39 });
  const cell = placeInCell(img, m, 0.37);
  for (let i = 0; i < cell.data.length; i += 4) {
    if (cell.data[i + 3] > ALPHA_ON) {
      assert.ok(Math.abs(cell.data[i] - cell.data[i + 1]) < 4, 'no pink fringe after resampling');
    }
  }
});

test('normScale uses one scale per strip', () => {
  const ms = [100, 60, 100].map((h) => ({ top: 0, bottom: h - 1, cx: 0 }));
  assert.equal(normScale(ms, 'first', 200), 2);
  assert.equal(normScale(ms, 'last', 200), 2);
  assert.equal(normScale(ms, 'median', 200), 2);
  const ms2 = [50, 100, 80].map((h) => ({ top: 0, bottom: h - 1, cx: 0 }));
  assert.equal(normScale(ms2, 'median', 160), 2);
  assert.throws(() => normScale(ms2, 'bogus', 160), /rule/);
});

test('measure returns torso x independent of the legs', () => {
  const img = blank(60, 110);
  fillRect(img, 20, 0, 20, 60, [150, 150, 150, 255]); // head + torso, x 20..39
  fillRect(img, 6, 60, 10, 40, [150, 150, 150, 255]); // legs stepping left, x 6..15
  const m = measure(img, { x0: 0, x1: 59 });
  assert.ok(Math.abs(m.tx - 29.5) <= 0.5, `tx ${m.tx}`);
  assert.ok(Math.abs(m.cx - 10.5) <= 0.5, `cx ${m.cx}`);
});

const GREY = [150, 150, 150, 255];
const SKIN = [225, 175, 145, 255];
const CUSHION = [130, 75, 45, 255];
const CUSHION_LIGHT = [165, 105, 70, 255];

test('findFeet finds the lowest skin row standing on a cushion', () => {
  const img = blank(80, 100);
  fillRect(img, 10, 85, 60, 15, CUSHION); // cushion side, y 85..99
  fillRect(img, 10, 78, 60, 7, CUSHION_LIGHT); // lit cushion top, y 78..84
  fillRect(img, 25, 10, 20, 70, GREY); // body, y 10..79
  fillRect(img, 30, 80, 10, 9, SKIN); // feet on the cushion, x 30..39, y 80..88
  const f = findFeet(img, { x0: 0, x1: 79 });
  assert.equal(f.y, 88);
  assert.ok(Math.abs(f.x - 34.5) <= 0.5, `feet x ${f.x}`);
});

test('findFeet returns null when no skin is visible', () => {
  const img = blank(40, 40);
  fillRect(img, 5, 5, 30, 30, CUSHION);
  assert.equal(findFeet(img, { x0: 0, x1: 39 }), null);
});

test('transitionIssues passes aligned pairs and flags each mismatch', () => {
  const ok = {
    walk: { feetX: 96, feetY: 234, h: 224 },
    sit: { feetX: 97, feetY: 233, h: 220 },
    sitLast: { top: 100, bottom: 252, cx: 90 },
    idle: { top: 101, bottom: 252, cx: 91 },
  };
  assert.deepEqual(transitionIssues(ok), []);
  const bad = {
    walk: { feetX: 96, feetY: 234, h: 224 },
    sit: { feetX: 100, feetY: 231, h: 210 },
    sitLast: { top: 100, bottom: 252, cx: 90 },
    idle: { top: 104, bottom: 249, cx: 94 },
  };
  const issues = transitionIssues(bad).join('\n');
  assert.match(issues, /feet dy/);
  assert.match(issues, /feet dx/);
  assert.match(issues, /height/);
  assert.match(issues, /idle top/);
  assert.match(issues, /idle bottom/);
  assert.match(issues, /idle cx/);
  assert.deepEqual(transitionIssues({ ...ok, sit: null }).length, 1, 'missing feet is an issue');
});

test('splitFrames cuts figures joined by a thin bridge (e.g. an outstretched hand)', () => {
  const img = blank(90, 30);
  fillRect(img, 5, 5, 15, 20, [0, 0, 0, 255]);
  fillRect(img, 35, 5, 15, 20, [0, 0, 0, 255]);
  fillRect(img, 65, 5, 15, 20, [0, 0, 0, 255]);
  fillRect(img, 50, 20, 15, 2, [0, 0, 0, 255]); // hand of figure 2 touching figure 3
  const strips = splitFrames(img, 3);
  assert.equal(strips.length, 3);
  assert.deepEqual(strips[0], { x0: 5, x1: 19 });
  assert.equal(strips[1].x0, 35);
  assert.ok(strips[1].x1 >= 49 && strips[1].x1 < 64, `cut inside the bridge, got x1 ${strips[1].x1}`);
  assert.equal(strips[2].x1, 79);
  assert.equal(strips[2].x0, strips[1].x1 + 2, 'the cut column belongs to neither strip');
});

test('splitFrames does not cut through a solid figure', () => {
  const img = blank(60, 30);
  fillRect(img, 5, 5, 20, 20, [0, 0, 0, 255]);
  fillRect(img, 35, 5, 10, 20, [0, 0, 0, 255]);
  assert.throws(() => splitFrames(img, 3), /expected 3 frames, found 2/);
});

test('cushionRatios reads G/R and B/R of the non-skin bottom band', () => {
  const img = blank(40, 100);
  fillRect(img, 10, 10, 20, 70, GREY);
  fillRect(img, 5, 80, 30, 20, [100, 56, 27, 255]); // brown cushion, y 80..99
  const r = cushionRatios(img, { x0: 0, x1: 39 });
  assert.ok(Math.abs(r.gr - 0.56) < 0.01 && Math.abs(r.br - 0.27) < 0.01, JSON.stringify(r));
});

test('matchCushion turns a red cushion brown and leaves skin, robe and hair alone', () => {
  const img = blank(4, 1);
  img.data.set([126, 41, 37, 255], 0); // red cushion
  img.data.set([225, 175, 145, 255], 4); // skin
  img.data.set([150, 157, 170, 255], 8); // blue-grey robe
  img.data.set([60, 40, 30, 255], 12); // dark hair
  const out = matchCushion(img, { gr: 0.56, br: 0.27 });
  const [r, g, b] = px(out, 0, 0);
  assert.ok(Math.abs(g / r - 0.56) < 0.03 && Math.abs(b / r - 0.27) < 0.03, `cushion ${r},${g},${b}`);
  assert.ok(Math.abs((r + g + b) / 3 - (126 + 41 + 37) / 3) <= 1.5, 'luminance kept');
  assert.deepEqual(px(out, 1, 0), [225, 175, 145, 255]);
  assert.deepEqual(px(out, 2, 0), [150, 157, 170, 255]);
  assert.deepEqual(px(out, 3, 0), [60, 40, 30, 255]);
  assert.deepEqual(px(img, 0, 0), [126, 41, 37, 255], 'input not mutated');
});

test('isSkin with the cushion-safe G/R floor rejects light cushion rims, keeps feet', () => {
  assert.equal(isSkin(205, 133, 104, SEATED_MIN_GR), false, 'light cushion rim');
  assert.equal(isSkin(146, 80, 46, SEATED_MIN_GR), false, 'cushion top');
  assert.equal(isSkin(253, 189, 153, SEATED_MIN_GR), true, 'lit foot');
  assert.equal(isSkin(233, 165, 124, SEATED_MIN_GR), true, 'shaded foot');
  assert.equal(isSkin(204, 140, 104), true, 'without the floor, a foot in shadow (G/R 0.69) still counts');
  assert.equal(isSkin(200, 128, 100), true, 'without the floor, a darker sole (G/R 0.64) still counts');
});

test('findFeet with minGR skips a light cushion rim below the feet', () => {
  const img = blank(100, 100);
  fillRect(img, 10, 85, 80, 15, CUSHION);
  fillRect(img, 35, 10, 30, 70, GREY);
  fillRect(img, 40, 78, 20, 8, SKIN); // feet, y 78..85
  fillRect(img, 10, 90, 6, 6, [205, 133, 104, 255]); // light rim, y 90..95
  assert.equal(findFeet(img, { x0: 0, x1: 99 }).y, 95, 'plain skin test is fooled by the rim');
  const f = findFeet(img, { x0: 0, x1: 99 }, { minGR: SEATED_MIN_GR });
  assert.equal(f.y, 85);
  assert.ok(Math.abs(f.x - 49.5) <= 0.5, `feet x ${f.x}`);
});

test('findFeet ignores a few stray skin-coloured pixels below the feet', () => {
  const img = blank(100, 100);
  fillRect(img, 10, 85, 80, 15, CUSHION);
  fillRect(img, 35, 10, 30, 70, GREY);
  fillRect(img, 40, 78, 20, 8, SKIN); // feet, y 78..85
  fillRect(img, 12, 95, 1, 3, SKIN); // 1-px glint on the cushion rim, y 95..97
  const f = findFeet(img, { x0: 0, x1: 99 });
  assert.equal(f.y, 85);
  assert.ok(Math.abs(f.x - 49.5) <= 0.5, `feet x ${f.x}`);
});
