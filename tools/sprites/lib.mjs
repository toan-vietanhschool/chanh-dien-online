// Pure post-processing helpers for sprite strips. No I/O, no sharp.
// Every image is { data: Uint8Array (RGBA), width, height }.

export const ALPHA_ON = 16; // a pixel counts as "opaque" when alpha > ALPHA_ON
export const DEFAULT_CELL = Object.freeze({ w: 192, h: 240, ax: 96, ay: 232 });

const MIN_GAP = 4; // gaps narrower than this are merged into one figure
const SPECK_RATIO = 0.02; // strips with < 2% of the biggest strip's pixels are noise
const BRIDGE_RATIO = 0.1; // a column with <= 10% of a run's typical opaque height is a bridge
const BRIDGE_INSET = 0.2; // never cut in the outer 20% of a run
const FOOT_BAND = 0.06; // bottom 6% of the figure decides the anchor x
const TORSO_BAND = [0.2, 0.5]; // fraction of figure height: shoulders to waist

const idx = (img, x, y) => (y * img.width + x) * 4;

function copyImage(img) {
  return { data: new Uint8Array(img.data), width: img.width, height: img.height };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Spill suppression relative to the key colour: channels that are high in the
// key colour get pulled down to the level of the low channels.
function despill(data, i, hi, lo) {
  if (!hi.length || !lo.length) return;
  const s = Math.min(...hi.map((c) => data[i + c])) - Math.max(...lo.map((c) => data[i + c]));
  if (s > 0) for (const c of hi) data[i + c] -= s;
}

/**
 * Key out a flat background. Images whose four corners already have alpha < 255
 * are returned unchanged (as a copy). Distance is the max per-channel difference.
 */
export function keyBackground(img, tol = 40, soft = 60) {
  const { width: w, height: h } = img;
  const corners = [idx(img, 0, 0), idx(img, w - 1, 0), idx(img, 0, h - 1), idx(img, w - 1, h - 1)];
  const out = copyImage(img);
  if (corners.every((i) => img.data[i + 3] < 255)) return out;

  const bg = [0, 1, 2].map((c) => median(corners.map((i) => img.data[i + c])));
  const hi = [0, 1, 2].filter((c) => bg[c] >= 128);
  const lo = [0, 1, 2].filter((c) => bg[c] < 128);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2]));
    if (dist <= tol) {
      d[i + 3] = 0;
    } else if (dist < tol + soft) {
      d[i + 3] = Math.round((d[i + 3] * (dist - tol)) / soft);
      despill(d, i, hi, lo);
    } else if (dist < tol + 2 * soft) {
      despill(d, i, hi, lo); // opaque but still near the key colour: remove tint only
    }
  }
  return out;
}

function opaqueColumns(img) {
  const cols = new Uint32Array(img.width);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) if (img.data[idx(img, x, y) + 3] > ALPHA_ON) cols[x]++;
  return cols;
}

/** Split a horizontal strip into n figures by column projection. */
export function splitFrames(img, n) {
  const cols = opaqueColumns(img);
  const runs = [];
  for (let x = 0; x < img.width; x++) {
    if (!cols[x]) continue;
    const last = runs[runs.length - 1];
    if (last && x - last.x1 - 1 < MIN_GAP) last.x1 = x;
    else runs.push({ x0: x, x1: x });
  }
  const mass = runs.map((r) => cols.slice(r.x0, r.x1 + 1).reduce((a, b) => a + b, 0));
  const biggest = Math.max(0, ...mass);
  let strips = runs.filter((_, i) => mass[i] >= biggest * SPECK_RATIO);
  while (strips.length < n) {
    const cut = cutAtBridge(cols, strips);
    if (!cut) break;
    strips = cut;
  }
  if (strips.length !== n) throw new Error(`expected ${n} frames, found ${strips.length}`);
  return strips;
}

// Figures whose outstretched hands touch a neighbour form one wide run. Cut the widest run
// at its thinnest interior column if that column is a thin bridge; the cut column is dropped.
function cutAtBridge(cols, strips) {
  const widest = strips.reduce((w, s) => (s.x1 - s.x0 > w.x1 - w.x0 ? s : w));
  const inset = Math.floor((widest.x1 - widest.x0 + 1) * BRIDGE_INSET);
  let best = -1;
  for (let x = widest.x0 + inset; x <= widest.x1 - inset; x++) if (best < 0 || cols[x] < cols[best]) best = x;
  const typical = median(Array.from(cols.slice(widest.x0, widest.x1 + 1)).filter(Boolean));
  if (best < 0 || cols[best] > typical * BRIDGE_RATIO) return null;
  return strips.flatMap((s) => (s === widest ? [{ x0: s.x0, x1: best - 1 }, { x0: best + 1, x1: s.x1 }] : [s]));
}

function meanOpaqueX(img, x0, x1, y0, y1) {
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (img.data[idx(img, x, y) + 3] > ALPHA_ON) { sum += x; count++; }
  return count ? sum / count : NaN;
}

/**
 * Vertical extent of a strip, the x centre of its lowest 6% (feet or cushion) as `cx`,
 * and the torso centre (opaque pixels 20%..50% down the figure) as `tx`.
 */
export function measure(img, { x0, x1 }) {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = x0; x <= x1; x++) {
      if (img.data[idx(img, x, y) + 3] > ALPHA_ON) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  if (top < 0) throw new Error(`empty frame at x ${x0}..${x1}`);
  const h = bottom - top + 1;
  const band = Math.max(1, Math.round(h * FOOT_BAND));
  const cx = meanOpaqueX(img, x0, x1, bottom - band + 1, bottom);
  const tx = meanOpaqueX(img, x0, x1, top + Math.round(h * TORSO_BAND[0]), top + Math.round(h * TORSO_BAND[1]) - 1);
  return { top, bottom, cx, tx: Number.isNaN(tx) ? cx : tx };
}

// G/R floor that separates feet (>= ~0.70) from a light cushion rim (~0.65). Only needed on a cushion.
export const SEATED_MIN_GR = 0.67;

// Bare skin, lit or in light shadow. Excludes brown cushions and robes (G <= 120 or dark).
export function isSkin(r, g, b, minGR = 0) {
  return r > 170 && g > 120 && b > 85 && r > g && g > b && r - b > 35 && g / r >= minGR && (r + g + b) / 3 > 140;
}

/**
 * Feet of a figure: the lowest row with at least `minCount` skin pixels, and the mean x of
 * the skin pixels in the band of rows just above it. Returns null when no skin is found.
 */
export function findFeet(img, { x0, x1 }, { minCount = 3, minGR = 0 } = {}) {
  const skinAt = (x, y) => {
    const i = idx(img, x, y);
    return img.data[i + 3] > 128 && isSkin(img.data[i], img.data[i + 1], img.data[i + 2], minGR);
  };
  let feetY = -1;
  for (let y = img.height - 1; y >= 0 && feetY < 0; y--) {
    let n = 0;
    for (let x = x0; x <= x1; x++) if (skinAt(x, y)) n++;
    if (n >= minCount) feetY = y;
  }
  if (feetY < 0) return null;
  const band = Math.max(2, Math.round(img.height * 0.02));
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, feetY - band + 1); y <= feetY; y++)
    for (let x = x0; x <= x1; x++) if (skinAt(x, y)) { sum += x; count++; }
  return { x: sum / count, y: feetY };
}

export const TRANSITION_LIMITS = Object.freeze({ feetDy: 2, feetDx: 3, heightPct: 0.03, seatPx: 2 });

/**
 * Transition mismatches measured on placed cells.
 * walk/sit: { feetX, feetY, h } for the last walk_back frame and sit_down frame 0 (h = feet - top + 1).
 * sitLast/idle: { top, bottom, cx } for the last sit_down frame and idle.
 */
export function transitionIssues({ walk, sit, sitLast, idle }, lim = TRANSITION_LIMITS) {
  const issues = [];
  const fmt = (v) => v.toFixed(1);
  if (!walk || !sit) {
    issues.push('walk_back -> sit_down: feet not found (no skin pixels)');
  } else {
    const dy = Math.abs(walk.feetY - sit.feetY);
    const dx = Math.abs(walk.feetX - sit.feetX);
    const dh = Math.abs(walk.h - sit.h) / walk.h;
    if (dy > lim.feetDy) issues.push(`walk_back -> sit_down: feet dy ${fmt(dy)} px > ${lim.feetDy}`);
    if (dx > lim.feetDx) issues.push(`walk_back -> sit_down: feet dx ${fmt(dx)} px > ${lim.feetDx}`);
    if (dh > lim.heightPct) issues.push(`walk_back -> sit_down: standing height differs ${fmt(dh * 100)}% > ${lim.heightPct * 100}%`);
  }
  for (const k of ['top', 'bottom', 'cx']) {
    const d = Math.abs(sitLast[k] - idle[k]);
    if (d > lim.seatPx) issues.push(`sit_down last -> idle: idle ${k} differs ${fmt(d)} px > ${lim.seatPx}`);
  }
  return issues;
}

function opaqueBox(img) {
  let x0 = img.width, x1 = -1, y0 = img.height, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[idx(img, x, y) + 3] > ALPHA_ON) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return { x0, x1, y0, y1 };
}

// Overlap of [a0,a1) with source pixel [p, p+1).
const overlap = (a0, a1, p) => Math.max(0, Math.min(a1, p + 1) - Math.max(a0, p));

/**
 * Scale a frame and place it in a cell so (cx, bottom) lands on (ax, ay).
 * Box filter on premultiplied RGBA. Anything outside the cell is clipped and
 * reported via console.warn; the result carries `clipped: boolean`.
 */
export function placeInCell(frameImg, m, scale, cell = DEFAULT_CELL) {
  const { w, h, ax, ay } = cell;
  const src = frameImg;
  const out = { data: new Uint8Array(w * h * 4), width: w, height: h, clipped: false };
  // Continuous mapping: cell edge X maps to source edge sx.
  const sxOf = (X) => m.cx + 0.5 + (X - (ax + 0.5)) / scale;
  const syOf = (Y) => m.bottom + 1 + (Y - (ay + 1)) / scale;

  const box = opaqueBox(src);
  const cellX = (sx) => ax + 0.5 + (sx - m.cx - 0.5) * scale;
  const cellY = (sy) => ay + 1 + (sy - m.bottom - 1) * scale;
  if (box.x1 >= 0 && (cellX(box.x0) < 0 || cellX(box.x1 + 1) > w || cellY(box.y0) < 0 || cellY(box.y1 + 1) > h)) {
    out.clipped = true;
    console.warn(`placeInCell: frame overflows ${w}x${h} cell and was clipped`);
  }

  const area = 1 / (scale * scale);
  for (let Y = 0; Y < h; Y++) {
    const sy0 = syOf(Y);
    const sy1 = syOf(Y + 1);
    const py0 = Math.max(0, Math.floor(sy0));
    const py1 = Math.min(src.height - 1, Math.ceil(sy1) - 1);
    if (py1 < py0) continue;
    for (let X = 0; X < w; X++) {
      const sx0 = sxOf(X);
      const sx1 = sxOf(X + 1);
      const px0 = Math.max(0, Math.floor(sx0));
      const px1 = Math.min(src.width - 1, Math.ceil(sx1) - 1);
      if (px1 < px0) continue;
      let r = 0, g = 0, b = 0, a = 0;
      for (let py = py0; py <= py1; py++) {
        const wy = overlap(sy0, sy1, py);
        if (!wy) continue;
        for (let px = px0; px <= px1; px++) {
          const wgt = wy * overlap(sx0, sx1, px);
          if (!wgt) continue;
          const i = idx(src, px, py);
          const al = src.data[i + 3] * wgt;
          r += src.data[i] * al;
          g += src.data[i + 1] * al;
          b += src.data[i + 2] * al;
          a += al;
        }
      }
      if (!a) continue;
      const o = (Y * w + X) * 4;
      out.data[o] = Math.round(r / a);
      out.data[o + 1] = Math.round(g / a);
      out.data[o + 2] = Math.round(b / a);
      out.data[o + 3] = Math.min(255, Math.round(a / area));
    }
  }
  return out;
}

/** One scale for the whole strip: targetH / height of the frame picked by rule. */
export function normScale(measures, rule, targetH) {
  const heights = measures.map((m) => m.bottom - m.top + 1);
  let ref;
  if (rule === 'first') ref = heights[0];
  else if (rule === 'last') ref = heights[heights.length - 1];
  else if (rule === 'median') ref = median(heights);
  else throw new Error(`unknown rule "${rule}" (use first|last|median)`);
  return targetH / ref;
}

const CUSHION_BAND = 0.08; // bottom 8% of a seated figure is cushion

/** Colour ratios (G/R, B/R) of the cushion: non-skin opaque pixels in the bottom band. */
export function cushionRatios(img, strip) {
  const m = measure(img, strip);
  const y0 = m.bottom - Math.max(1, Math.round((m.bottom - m.top + 1) * CUSHION_BAND)) + 1;
  let r = 0, g = 0, b = 0;
  for (let y = y0; y <= m.bottom; y++)
    for (let x = strip.x0; x <= strip.x1; x++) {
      const i = idx(img, x, y);
      const [R, G, B, A] = img.data.subarray(i, i + 4);
      if (A === 255 && !isSkin(R, G, B)) { r += R; g += G; b += B; }
    }
  return { gr: g / r, br: b / r };
}

/**
 * Pull pixels that are clearly redder than the reference cushion (G/R well below ref.gr)
 * to the reference ratios, keeping luminance. Skin, greys, blues and dark browns are untouched.
 */
export function matchCushion(img, ref) {
  const out = copyImage(img);
  const d = out.data;
  const k = 3 / (1 + ref.gr + ref.br);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (d[i + 3] <= ALPHA_ON || r <= 50 || isSkin(r, g, b) || b / r >= 0.6) continue;
    const w = Math.min(1, Math.max(0, (ref.gr - 0.08 - g / r) / 0.1));
    if (!w) continue;
    const R = ((r + g + b) / 3) * k;
    d[i] = Math.round(r + w * (R - r));
    d[i + 1] = Math.round(g + w * (R * ref.gr - g));
    d[i + 2] = Math.round(b + w * (R * ref.br - b));
  }
  return out;
}
