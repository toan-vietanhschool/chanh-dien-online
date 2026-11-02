// UI frames (name tag, speech bubble, banner, side card) for Chánh Điện.
//   node frames.mjs gen <tag|tag_s|bubble|banner|card>   one Codex image generation -> raw/ui/<name>.png
//   node frames.mjs build                          raw/ui/*.png -> assets/ui/*.webp + frames.json + out/ui_preview.png
// Every generation is appended to raw/ui/gen-log.jsonl (the credit counter).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, renameSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RAW = join(HERE, 'raw', 'ui');
const OUT = join(HERE, 'out');
const DEST = join(ROOT, 'assets', 'ui');
const IMAGES = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images');
// Model and reasoning effort for every Codex call; override with CODEX_MODEL / CODEX_EFFORT.
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-6-sol';
const CODEX_EFFORT = process.env.CODEX_EFFORT || 'low';
const TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const REFS = ['assets/hall.jpg', 'assets/fx_banner.png'];
const EXTRA_REFS = { tag_s: ['tools/sprites/raw/ui/tag.png'] };

function fail(msg, extra = '') {
  console.error(`frames: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

/* ------------------------------------------------------------------ prompts */

const PREAMBLE = 'Use your image generation tool exactly once to create ONE new image. Do not write files, do not run shell commands, do not edit anything in the workspace. The attached images are STYLE references only (a painted Vietnamese Buddhist temple hall and a red-and-gold lacquer banner): copy their painting style, materials, warm candle-lit gold and deep red lacquer palette.';
const RULES = 'Strict rules: a single UI frame element seen straight from the front, flat, perfectly left-right symmetric. It is a RECTANGULAR panel, NOT a scroll: no rolled ends, no rods, no tassels hanging outside. The element fills about 90% of the canvas width and is centred. The centre area is completely plain and flat, filled solid with the panel material colour (never with the background colour, no hole, no window), with no pattern, no texture detail, no gradient banding, so it can be stretched by 9-slice scaling. All ornaments stay inside the outer 20% of each side (corners and ends); the straight edges between the corners are simple and uniform. Absolutely no text, no letters, no characters, no symbols, no numbers, no watermark. No drop shadow, no glow outside the shape, no perspective, no scenery. Background: plain flat solid #FF00FF magenta, one uniform colour everywhere around the element, NOT a checkerboard or transparency pattern.';

const PROMPTS = {
  tag: 'Element: a slim horizontal pill-shaped name plate (aspect about 6:1, fully rounded semicircle ends). Centre: smooth dark lacquer brown (#2a140a). A thin crisp gold rim (#e2b04f with a #ffd98a highlight) runs all the way round. Each rounded end carries one tiny simple gold lotus-petal or auspicious-cloud end-cap ornament, bold and simple, so it still reads clearly when the whole plate is shrunk to 24 pixels tall. Keep the rim and end-caps thick and high-contrast; no fine filigree.',
  bubble: 'Element: a speech bubble made of warm cream rice paper / parchment (#f6e9cf, very subtle paper fibre only near the rim). Shape: a rounded rectangle (aspect about 3:1, generous rounded corners) with a subtle thin gold border (#e2b04f) and a small neat triangular tail pointing straight down from the exact bottom centre. Tiny delicate gold cloud-scroll accents in the four corners only. The tail is small (about 12% of the bubble height) and has the same gold border.',
  banner: 'Element: a wide horizontal announcement panel (aspect about 3.2:1) of deep red lacquer (#7e1d12 to #8f2414), framed by a gold border (#e2b04f, highlights #ffd98a). Ornate gold corner motifs in all four corners: lotus flowers and auspicious swirling clouds (like the corners of the reference banner), plus a small lotus ornament at the middle of the top edge and the bottom edge. The large centre area is plain flat red lacquer for text.',
  // Crowd variant of tag (counts against tag's 2-generation budget): same plate, no end-caps.
  tag_s: 'Element: a slim horizontal pill-shaped name plate (aspect about 6:1, fully rounded semicircle ends), the SAME plate as the attached name-plate reference (third image) but WITHOUT any end-cap ornaments: no lotus, no scrolls, nothing inside the ends. Centre: smooth dark lacquer brown (#2a140a). One bold crisp gold rim (#e2b04f with a #ffd98a highlight along the top) runs all the way round, with a thin dark red-brown outline outside it. Keep the rim thick and high-contrast so it reads at 20 pixels tall.',
  card: 'Element: a vertical side panel (aspect about 3:4) of very dark brown-black lacquer (#1c0d07), with a gold double border (two thin parallel gold lines, #e2b04f, with a dark gap between them) and small gold corner ornaments (a little lotus or cloud scroll) in the four corners. The large centre is plain flat dark lacquer for a text list.',
};

/* --------------------------------------------------------------------- gen */

// Prefer the npm-installed CLI (codex.js) so no shell is needed; CODEX_JS overrides.
function codexCommand() {
  if (process.env.CODEX_JS) return [process.execPath, [process.env.CODEX_JS]];
  const nodeDir = dirname(process.execPath);
  for (const mods of [join(nodeDir, 'node_modules'), join(nodeDir, '..', 'lib', 'node_modules')]) {
    const js = join(mods, '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(js)) return [process.execPath, [js]];
  }
  return ['codex', []];
}

function killTree(child) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else child.kill('SIGKILL');
}

function runCodex(args, prompt) {
  const [cmd, pre] = codexCommand();
  return new Promise((done) => {
    const child = spawn(cmd, [...pre, ...args], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); done({ code: -1, out: `${out}\n${e.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, out, timedOut }); });
    child.stdin.end(prompt);
  });
}

function imagesNewerThan(dir, since) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...imagesNewerThan(p, since));
    else if (IMAGE_EXT.has(extname(e.name).toLowerCase())) {
      const mtime = statSync(p).mtimeMs;
      if (mtime > since) found.push({ path: p, mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

async function gen(name, extra = '') {
  if (!PROMPTS[name]) fail(`unknown frame "${name}" (${Object.keys(PROMPTS).join(', ')})`);
  const prompt = [PREAMBLE, PROMPTS[name], RULES, extra].filter(Boolean).join('\n\n');
  // "--" ends option parsing so the variadic -i cannot swallow the stdin marker.
  const args = ['exec', '-m', CODEX_MODEL, '-c', `model_reasoning_effort="${CODEX_EFFORT}"`,
    '--enable', 'image_generation', '-s', 'read-only', '--skip-git-repo-check',
    ...[...REFS, ...(EXTRA_REFS[name] || [])].flatMap((r) => ['-i', r]), '--', '-'];
  mkdirSync(RAW, { recursive: true });
  const start = Date.now();
  const { code, out, timedOut } = await runCodex(args, prompt);
  const session = (out.match(/session id:\s*([0-9a-f-]{36})/i) || [])[1] || null;
  // With a session id only that session's folder counts (concurrent Codex runs write to
  // generated_images too); the global search is a fallback for a clean exit without an id.
  const scoped = Boolean(session);
  let searchDir = null;
  if (session) searchDir = join(IMAGES, session);
  else if (code === 0) searchDir = IMAGES;
  const fresh = searchDir ? imagesNewerThan(searchDir, start) : [];
  appendFileSync(join(RAW, 'gen-log.jsonl'), JSON.stringify({
    at: new Date(start).toISOString(), frame: name, session, exit: code, timedOut,
    seconds: Math.round((Date.now() - start) / 1000), images: fresh.length, scoped,
  }) + '\n');
  if (timedOut) fail('codex timed out');
  if (!fresh.length) fail(`codex produced no image (exit ${code})`, out.slice(-3000));
  const dest = join(RAW, `${name}.png`);
  if (existsSync(dest)) renameSync(dest, join(RAW, `${name}.${Math.floor(statSync(dest).mtimeMs)}.png`));
  await sharp(fresh[0].path).png().toFile(dest);
  console.log(`frames: ${name} <- ${fresh[0].path} (${fresh.length} new, session ${session})`);
}

/* ------------------------------------------------------------------- build */

// Per frame: target source height or width of the body, display scale at "natural" size,
// which extra pieces to cut out so 9-slicing never stretches them, and centre translucency.
// pad (content insets): 'slice' = keep text off the whole inset (end-caps, corner clouds);
// 'band' = only off the border band (text may sit between corner ornaments); padX scales left/right.
const SPECS = {
  tag:    { height: 96, scale: 0.5, parts: [], pad: 'slice' },
  tag_s:  { height: 96, scale: 0.5, parts: [], pad: 'slice', padX: 0.6 },  // text may enter the round end, like today's rr()
  bubble: { height: 112, scale: 0.5, parts: ['tail'], pad: 'slice' },
  banner: { width: 1400, scale: 0.67, parts: ['crestTop', 'crestBottom'], pad: 'band' },
  card:   { width: 580, scale: 0.5, parts: [], pad: 'band', centreAlpha: 0.82 },
};
const KEY_TOL = 70, KEY_SOFT = 90;   // max-channel distance from the key colour: <= TOL gone, TOL..TOL+SOFT soft
const EDGE_THR = 14;                 // mean RGBA difference that counts as "not stretchable"
const SLICE_MARGIN = 3;
const STRONG_DIFF = 40, STRONG_N = 2, NEAR = 3;   // per-pixel difference / count for slice detection              // px added to every detected inset
const CENTRE_KEEP = 24;              // px of the plain centre kept after compacting
const WEBP = { quality: 82, alphaQuality: 90, effort: 6, smartSubsample: true };
const MAX_KB = 80;

// --- raw RGBA helpers ({data, width, height}) ---
const at = (img, x, y) => (y * img.width + x) * 4;
const blank = (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height });

async function readRaw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}
const toSharp = (img) => sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } });

function crop(img, x0, y0, w, h) {
  const out = blank(w, h);
  for (let y = 0; y < h; y++) out.data.set(img.data.subarray(at(img, x0, y0 + y), at(img, x0 + w, y0 + y)), y * w * 4);
  return out;
}
function paste(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) dst.data.set(src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4), at(dst, x0, y0 + y));
}
function flipY(img) {
  const out = blank(img.width, img.height);
  for (let y = 0; y < img.height; y++) paste(out, crop(img, 0, y, img.width, 1), 0, img.height - 1 - y);
  return out;
}
async function resize(img, f) {
  const width = Math.max(1, Math.round(img.width * f)), height = Math.max(1, Math.round(img.height * f));
  return readRaw(await toSharp(img).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer());
}

/** Key the background: flood-fill from the border, soft alpha + magenta despill on the boundary ring. */
function keyBackground(img) {
  const { width: w, height: h, data: d } = img;
  const border = [];
  for (let x = 0; x < w; x += 4) border.push(at(img, x, 0), at(img, x, h - 1));
  for (let y = 0; y < h; y += 4) border.push(at(img, 0, y), at(img, w - 1, y));
  const bg = [0, 1, 2].map((c) => median(border.map((i) => d[i + c])));
  const dist = (i) => Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2]));
  const out = { ...img, data: new Uint8ClampedArray(d) };
  const state = new Uint8Array(w * h); // 0 untouched, 1 background, 2 ring
  const queue = [];
  const push = (x, y) => { const p = y * w + x; if (!state[p] && dist(p * 4) <= KEY_TOL) { state[p] = 1; queue.push(p); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (queue.length) {
    const p = queue.pop(), x = p % w, y = (p / w) | 0;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  // ring: up to 3 px into the element from the keyed area (state 3 + pass)
  let ring = [];
  for (let p = 0; p < w * h; p++) if (state[p] === 1) out.data[p * 4 + 3] = 0;
  const grown = (q, pass) => state[q] === 1 || (state[q] >= 3 && state[q] < 3 + pass);
  for (let pass = 0; pass < 3; pass++) {
    const next = [];
    for (let p = 0; p < w * h; p++) {
      if (state[p]) continue;
      const x = p % w, y = (p / w) | 0;
      if ((x > 0 && grown(p - 1, pass)) || (x < w - 1 && grown(p + 1, pass)) || (y > 0 && grown(p - w, pass)) || (y < h - 1 && grown(p + w, pass))) next.push(p);
    }
    for (const p of next) state[p] = 3 + pass;
    ring = ring.concat(next);
  }
  for (const p of ring) {
    const i = p * 4, dd = dist(i);
    if (dd < KEY_TOL + KEY_SOFT) out.data[i + 3] = Math.round((255 * (dd - KEY_TOL)) / KEY_SOFT);
    const spill = Math.max(0, Math.min(out.data[i], out.data[i + 2]) - out.data[i + 1]); // magenta = R and B above G
    out.data[i] -= spill; out.data[i + 2] -= spill;
  }
  const interior = (() => { let n = 0; for (let p = 0; p < w * h; p++) if (!state[p] && dist(p * 4) <= KEY_TOL) n++; return n; })();
  return { img: out, bg, interior };
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function bbox(img, thr = 8) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[at(img, x, y) + 3] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { x0, y0, x1, y1 };
}
const trim = (img) => { const b = bbox(img); return crop(img, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1); };

/** Copy the left half onto the right, mirrored, so the frame is exactly symmetric. */
function mirrorX(img) {
  const out = { ...img, data: new Uint8ClampedArray(img.data) };
  const half = img.width >> 1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < half; x++) {
    const s = at(img, x, y), t = at(img, img.width - 1 - x, y);
    for (let c = 0; c < 4; c++) out.data[t + c] = img.data[s + c];
  }
  return out;
}

const opaqueInRow = (img, y) => { let n = 0; for (let x = 0; x < img.width; x++) if (img.data[at(img, x, y) + 3] > 128) n++; return n; };
function pxDiff(img, i, j) { const d = img.data; return (Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]) + Math.abs(d[i + 3] - d[j + 3])) / 4; }

/**
 * Cuts the ornament that sticks out above the top edge (crest) and patches the edge under it with a
 * plain column copied from beside it. Returns {img (patched), part, ay} or null when nothing sticks out.
 * ay = rows of the part above the box's top edge.
 */
function extractTop(img) {
  const { width: W, height: H } = img;
  let E = 0;
  while (E < H && opaqueInRow(img, E) < W * 0.5) E++;
  if (E === 0 || E >= H) return null;
  let x0 = W, x1 = -1;
  for (let y = 0; y < E; y++) for (let x = 0; x < W; x++) if (img.data[at(img, x, y) + 3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  if (x1 < 0) return null;
  // Below the edge the ornament (scrolls) can be wider than what sticks out: grow the range while
  // columns still differ from a plain reference column at 30% / 70% of the width.
  const depthMax = Math.min(H, E + Math.round(H * 0.45));
  const differs = (x, refX) => { let n = 0; for (let y = E; y < depthMax; y++) if (pxDiff(img, at(img, x, y), at(img, refX, y)) > STRONG_DIFF) n++; return n >= STRONG_N; };
  const refL = Math.round(W * 0.3), refR = W - 1 - refL;
  while (x0 > refL + 6 && differs(x0 - 1, refL)) x0--;
  while (x1 < refR - 6 && differs(x1 + 1, refR)) x1++;
  const m = 3;
  const cx0 = Math.max(0, x0 - m), cx1 = Math.min(W - 1, x1 + m), ref = cx0 - 2;
  let end = E, gap = 0;
  for (let y = E; y < depthMax && gap < 4; y++) {
    let n = 0;
    for (let x = cx0; x <= cx1; x++) if (pxDiff(img, at(img, x, y), at(img, refL, y)) > STRONG_DIFF) n++;
    if (n >= STRONG_N) { end = y; gap = 0; } else gap++;
  }
  end = Math.min(H - 1, end + 3);
  const part = crop(img, cx0, 0, cx1 - cx0 + 1, end + 1);
  const out = { ...img, data: new Uint8ClampedArray(img.data) };
  for (let y = 0; y <= end; y++) for (let x = cx0; x <= cx1; x++) {
    const t = at(out, x, y);
    if (y < E) out.data[t + 3] = 0;
    else for (let c = 0; c < 4; c++) out.data[t + c] = img.data[at(img, ref, y) + c];
  }
  return { img: out, part, ay: E };
}
function extractBottom(img) {
  const r = extractTop(flipY(img));
  if (!r) return null;
  return { img: flipY(r.img), part: flipY(r.part), ay: r.part.height - r.ay };
}

/** Inset where columns (rows) stop differing from the centre column (row): everything outside must not stretch. */
function detectSlice(img) {
  const { width: W, height: H } = img;
  const cx = W >> 1, cy = H >> 1;
  // A line is "not stretchable" when at least STRONG_N pixels differ strongly from the line NEAR px
  // closer to the centre: ornaments and curves do, a plain edge or a slow lacquer gradient does not.
  const strong = (i, j) => (pxDiff(img, i, j) > STRONG_DIFF ? 1 : 0);
  const colAt = (x, x2) => { let n = 0; for (let y = 0; y < H; y++) n += strong(at(img, x, y), at(img, x2, y)); return n; };
  const rowAt = (y, y2) => { let n = 0; for (let x = 0; x < W; x++) n += strong(at(img, x, y), at(img, x, y2)); return n; };
  const colDiff = (x) => colAt(x, x < cx ? x + NEAR : x - NEAR);
  const rowDiff = (y) => rowAt(y, y < cy ? y + NEAR : y - NEAR);
  const last = (n, f) => { let k = -1; for (let i = 0; i < n; i++) if (f(i) >= STRONG_N) k = i; return k; };
  const l = last(cx - 2, colDiff) + 1, r = last(cx - 2, (i) => colDiff(W - 1 - i)) + 1;
  const t = last(cy - 2, rowDiff) + 1, b = last(cy - 2, (i) => rowDiff(H - 1 - i)) + 1;
  const fit = (v, n) => Math.min(Math.floor(n / 2) - 1, v + SLICE_MARGIN);
  return [fit(t, H), fit(r, W), fit(b, H), fit(l, W)];
}

/** Thickness of the frame band at the middle of each side: distance until the pixel matches the centre. */
function borderBand(img) {
  const { width: W, height: H } = img;
  const c = at(img, W >> 1, H >> 1);
  const run = (n, idx) => { for (let i = 0; i < n; i++) if (pxDiff(img, idx(i), c) <= EDGE_THR * 1.5) return i; return n; };
  return [
    run(H >> 1, (i) => at(img, W >> 1, i)), run(W >> 1, (i) => at(img, W - 1 - i, H >> 1)),
    run(H >> 1, (i) => at(img, W >> 1, H - 1 - i)), run(W >> 1, (i) => at(img, i, H >> 1)),
  ];
}

/** Drops the middle of the plain centre: 9-slice only needs the insets plus a thin stretchable strip. */
function compact(img, [t, r, b, l]) {
  const keepW = Math.min(img.width - l - r, CENTRE_KEEP), keepH = Math.min(img.height - t - b, CENTRE_KEEP);
  const W = l + keepW + r, H = t + keepH + b;
  const cx = l + ((img.width - l - r - keepW) >> 1), cy = t + ((img.height - t - b - keepH) >> 1);
  const xs = [[0, l], [cx, keepW], [img.width - r, r]], ys = [[0, t], [cy, keepH], [img.height - b, b]];
  const out = blank(W, H);
  let oy = 0;
  for (const [sy, sh] of ys) {
    let ox = 0;
    for (const [sx, sw] of xs) { if (sw && sh) paste(out, crop(img, sx, sy, sw, sh), ox, oy); ox += sw; }
    oy += sh;
  }
  return out;
}

function translucentCentre(img, alpha) {
  const c = at(img, img.width >> 1, img.height >> 1);
  const out = { ...img, data: new Uint8ClampedArray(img.data) };
  for (let i = 0; i < out.data.length; i += 4) {
    const d = Math.max(Math.abs(img.data[i] - img.data[c]), Math.abs(img.data[i + 1] - img.data[c + 1]), Math.abs(img.data[i + 2] - img.data[c + 2]));
    if (d < 28) out.data[i + 3] = Math.round(out.data[i + 3] * alpha);
  }
  return out;
}

async function buildFrame(name, spec) {
  const src = join(RAW, `${name}.png`);
  if (!existsSync(src)) fail(`missing ${relative(ROOT, src)}; run: node frames.mjs gen ${name}`);
  const keyed = keyBackground(await readRaw(src));
  if (keyed.interior > 50) console.warn(`frames: ${name}: ${keyed.interior} key-coloured pixels inside the element were kept`);
  let img = mirrorX(trim(keyed.img));
  const parts = {};
  for (const p of spec.parts) {
    const r = p === 'crestTop' ? extractTop(img) : extractBottom(img); // tail and crestBottom hang below
    if (!r) { console.warn(`frames: ${name}: no ${p} found`); continue; }
    img = r.img; parts[p] = r;
  }
  if (spec.parts.length) {
    // re-trim the body; parts keep their ay (relative to the edge), so only the body moves
    img = trim(img);
  }
  const f = spec.height ? spec.height / img.height : spec.width / img.width;
  img = await resize(img, f);
  const slice = detectSlice(img);
  const band = borderBand(img);
  const pad = slice.map((s, i) => {
    const p = spec.pad === 'slice' ? s : Math.min(s, band[i] + Math.round(0.05 * Math.min(img.width, img.height)));
    return i % 2 ? Math.round(p * (spec.padX || 1)) : p;
  });
  img = compact(img, slice);
  if (spec.centreAlpha) img = translucentCentre(img, spec.centreAlpha);

  // Body alone in <name>.webp (so slice doubles as CSS border-image-slice); each part in its own file.
  const entry = { src: `${name}.webp`, slice, pad, scale: spec.scale };
  const bufs = { [name]: await encode(img, entry.src) };
  for (const [p, r] of Object.entries(parts)) {
    const src = `${name}_${p.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}.webp`;
    bufs[p] = await encode(await resize(r.part, f), src);
    (entry.parts ||= {})[p] = { src, ay: Math.round(r.ay * f) };
  }
  console.log(`frames: ${name}.webp ${img.width}x${img.height} ${(bufs[name].length / 1024).toFixed(1)} KB slice=${slice} pad=${pad}` +
    (entry.parts ? ` parts=${Object.entries(entry.parts).map(([p, e]) => `${e.src}(${(bufs[p].length / 1024).toFixed(1)} KB)`).join(',')}` : ''));
  return { entry, bufs };
}

async function encode(img, src) {
  const buf = await toSharp(img).webp(WEBP).toBuffer();
  if (buf.length / 1024 > MAX_KB) fail(`${src} is ${(buf.length / 1024).toFixed(1)} KB (> ${MAX_KB})`);
  writeFileSync(join(DEST, src), buf);
  return buf;
}

async function build() {
  mkdirSync(DEST, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const manifest = {};
  const built = {};
  for (const [name, spec] of Object.entries(SPECS)) {
    if (!existsSync(join(RAW, `${name}.png`))) { console.warn(`frames: skipping ${name} (no raw image)`); continue; }
    built[name] = await buildFrame(name, spec);
    manifest[name] = built[name].entry;
  }
  writeFileSync(join(DEST, 'frames.json'), JSON.stringify(manifest, null, 1).replace(/\[\s+([^\]{]*?)\s+\]/g, (m, a) => `[${a.replace(/\s+/g, '')}]`) + '\n');
  await preview(manifest, built);
}

/* ----------------------------------------------------------------- preview */

// Draws with the real runtime (assets/js/ui-frames.js) so the preview uses the exact same 9-slice math.
async function loadRuntime() {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(ROOT, 'assets/js/ui-frames.js'), 'utf8'), sandbox);
  return sandbox.CDFrames;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FONT = "'Be Vietnam Pro','Segoe UI',sans-serif";
const SERIF = "'Noto Serif','Cambria','Georgia',serif";

async function preview(manifest, built) {
  const F = await loadRuntime();
  const frames = {};
  const asImg = async (buf) => { const m = await sharp(buf).metadata(); return { naturalWidth: m.width, naturalHeight: m.height, buf }; };
  for (const [n, e] of Object.entries(manifest)) {
    const img = await asImg(built[n].bufs[n]);
    const parts = {};
    for (const [p, pe] of Object.entries(e.parts || {})) {
      const pi = await asImg(built[n].bufs[p]);
      parts[p] = { img: pi, w: pi.naturalWidth, h: pi.naturalHeight, ay: pe.ay };
    }
    frames[n] = { name: n, img, w: img.naturalWidth, h: img.naturalHeight, slice: e.slice, pad: e.pad, scale: e.scale, parts };
  }
  const W = 1080, H = 1500;
  const ops = [];   // sharp composite inputs
  const svg = [];   // text + labels
  const ctx = {
    drawImage(im, ...a) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 4 ? [0, 0, im.naturalWidth, im.naturalHeight, ...a] : a;
      const x = Math.round(dx), y = Math.round(dy), w = Math.round(dx + dw) - x, h = Math.round(dy + dh) - y;
      if (sw < 1 || sh < 1 || w < 1 || h < 1) return;
      ops.push(sharp(im.buf).extract({ left: sx, top: sy, width: sw, height: sh }).resize(w, h, { fit: 'fill' }).png().toBuffer().then((input) => ({ input, left: x, top: y })));
    },
  };
  const label = (x, y, t) => svg.push(`<text x="${x}" y="${y}" font-family="${FONT}" font-size="15" fill="#c9ad84">${esc(t)}</text>`);
  const text = (x, y, t, fs, fill, opts = '') => svg.push(`<text x="${x}" y="${y}" font-family="${FONT}" font-weight="600" font-size="${fs}" fill="${fill}" text-anchor="middle" dominant-baseline="central" ${opts}>${esc(t)}</text>`);
  // Width as librsvg renders it (same font stack as the text layer), via trim of a lone text SVG.
  const textW = async (t, fs, weight = 600) => {
    const w = Math.ceil(t.length * fs) + 40;
    const one = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${fs * 2}"><text x="10" y="${fs * 1.4}" font-family="${FONT}" font-weight="${weight}" font-size="${fs}" fill="#fff">${esc(t)}</text></svg>`);
    const { info } = await sharp(one).trim().toBuffer({ resolveWithObject: true });
    return info.width;
  };

  // 1) name tags: today's sizes (fs 15..30 -> h = fs*1.5), Vietnamese names
  let y = 40;
  const tagRows = [['tag_s', 15], ['tag_s', 16], ['tag', 16], ['tag_s', 21], ['tag', 21], ['tag', 30]].filter(([n]) => frames[n]);
  label(20, y - 14, 'tags: ' + tagRows.map(([n, fs]) => `${n} h${Math.round(fs * 1.5)}`).join(' / ') + '   (dashed line = width of the current rr() tag)');
  const names = ['Từ Tâm', 'Nguyễn Thanh', 'Diệu Hạnh', 'Huệ Ân', 'Phước Lộc', 'Sư Trụ Trì'];
  for (const [tn, fs] of tagRows) {
    const h = Math.round(fs * 1.5);
    const fr = frames[tn];
    let x = 20;
    for (const n of names.slice(0, fs >= 30 ? 3 : fs >= 21 ? 4 : 6)) {
      const k = F.scale(fr, 1e6, h);
      const tw = await textW(n, fs);
      const w = Math.round(tw + (fr.pad[1] + fr.pad[3]) * k);
      const today = Math.round(tw + fs);   // overlay tag(): text + pad*2, pad = fs*.5
      svg.push(`<rect x="${x + (w - today) / 2}" y="${y + h + 2}" width="${today}" height="1" fill="none" stroke="#9fd" stroke-dasharray="3 2"/>`);
      F.nine(ctx, fr, x, y, w, h);
      text(x + w / 2, y + h / 2 + 1, n, fs, fs >= 30 ? '#ffd98a' : '#f6e9cf');
      x += w + 6;
    }
    y += h + 18;
  }

  // 2) bubbles
  y += 30;
  label(20, y - 14, 'bubble: h = 29 / 42 / 64 px');
  let x = 20;
  for (const [fs, t] of [[18, 'sư'], [18, 'Nguyện cầu cha mẹ mạnh khỏe'], [26, 'Nam mô A Di Đà Phật'], [40, 'Bình an']]) {
    const h = Math.round(fs * 1.6), w = Math.round((await textW(t, fs, 500)) + fs * 1.1);
    const k = F.nine(ctx, frames.bubble, x, y, w, h);
    F.part(ctx, frames.bubble, 'tail', x + w / 2, y + h, k);
    text(x + w / 2, y + h / 2 + 1, t, fs, '#3a1a08');
    x += w + 24;
  }
  y += 100;

  // 3) banners: overlay gift (940 wide), chant (860), and smaller web widths
  label(20, y - 14, 'banner: 940x230, 600x150, 380x110');
  for (const [bw, bh, bx] of [[940, 230, 70], [600, 150, 20], [380, 110, 650]]) {
    const k = F.nine(ctx, frames.banner, bx, y, bw, bh);
    F.part(ctx, frames.banner, 'crestTop', bx + bw / 2, y, k);
    F.part(ctx, frames.banner, 'crestBottom', bx + bw / 2, y + bh, k);
    const s = bh / 230;
    svg.push(`<text x="${bx + bw / 2}" y="${y + bh * 0.36}" font-family="${SERIF}" font-weight="700" font-size="${Math.round(52 * s)}" fill="#ffd98a" text-anchor="middle" dominant-baseline="central">Tâm Đăng</text>`);
    text(bx + bw / 2, y + bh * 0.66, 'thành tâm dâng Hoa hồng ×3 · công đức 3', Math.round(32 * s), '#f6e9cf');
    if (bw === 940) y += bh + 40;
  }
  y += 170;

  // 4) cards: overlay side cards (290 wide), web board (170x90), gate form (360x260)
  label(20, y - 14, 'card: 290x330, 170x92, 360x250');
  for (const [cw, ch, cx] of [[290, 330, 20], [170, 92, 330], [360, 250, 520]]) {
    F.nine(ctx, frames.card, cx, y, cw, ch);
    const s = cw >= 290 ? 1 : 0.5;
    svg.push(`<text x="${cx + cw / 2}" y="${y + 40 * s + 6}" font-family="${SERIF}" font-weight="700" font-size="${Math.round(30 * s)}" fill="#ffd98a" text-anchor="middle">✦ Công Đức ✦</text>`);
    ['1. Nguyên Thanh  99', '2. Tâm Đăng  3'].forEach((t, i) => svg.push(`<text x="${cx + cw / 2}" y="${y + (90 + i * 36) * s}" font-family="${FONT}" font-size="${Math.round(25 * s)}" fill="#f6e9cf" text-anchor="middle">${esc(t)}</text>`));
  }

  const bg = await sharp(join(ROOT, 'assets/hall.jpg')).resize(W, H, { fit: 'cover', position: 'bottom' }).modulate({ brightness: 0.8 }).png().toBuffer();
  const tiles = await Promise.all(ops);
  const textLayer = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg.join('')}</svg>`);
  const file = join(OUT, 'ui_preview.png');
  await sharp(bg).composite([...tiles, { input: textLayer, left: 0, top: 0 }]).png().toFile(file);
  // 2x zoom of the tiny tags so legibility can be judged pixel by pixel
  await sharp(file).extract({ left: 0, top: 20, width: 540, height: 200 }).resize(1080, 400, { kernel: 'nearest' }).png().toFile(join(OUT, 'ui_preview_tags_zoom.png'));
  console.log(`frames: preview -> ${relative(ROOT, file)}`);
}

/* -------------------------------------------------------------------- main */

const [cmd, arg, ...rest] = process.argv.slice(2);
if (cmd === 'gen') gen(arg, rest.join(' ')).catch((e) => fail(e.message));
else if (cmd === 'build') build().catch((e) => fail(e.stack || e.message));
else fail('usage: node frames.mjs gen <tag|tag_s|bubble|banner|card> [extra prompt] | build');
