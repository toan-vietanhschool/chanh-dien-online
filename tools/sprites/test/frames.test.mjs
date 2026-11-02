import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../assets/js/ui-frames.js'), 'utf8');

// Runs the classic script in a fresh sandbox and returns its CDFrames.
function loadRuntime(extra = {}) {
  const sandbox = { console: { warn() {} }, ...extra };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SRC, sandbox);
  return sandbox.CDFrames;
}

function fakeCtx() {
  const calls = [];
  return { calls, drawImage: (...a) => calls.push(a) };
}

const IMG = { naturalWidth: 200, naturalHeight: 80 };
const frame = (over = {}) => ({ img: IMG, w: 200, h: 80, slice: [20, 40, 20, 40], pad: [20, 40, 20, 40], scale: 0.5, parts: {}, ...over });

// Collapses the 9 destination rects into their x and y edge lists, checking they tile the box.
function assertTiles(calls, x, y, w, h) {
  assert.equal(calls.length, 9);
  const rects = calls.map((c) => c.slice(5, 9));
  for (let row = 0; row < 3; row++) {
    const r = rects.slice(row * 3, row * 3 + 3);
    assert.equal(r[0][0], x, 'row starts at x');
    assert.equal(r[1][0], r[0][0] + r[0][2], 'left|centre share an edge');
    assert.equal(r[2][0], r[1][0] + r[1][2], 'centre|right share an edge');
    assert.ok(Math.abs(r[2][0] + r[2][2] - (x + w)) < 1e-9, 'row ends at x+w');
    for (const q of r) assert.ok(q[2] >= 0 && q[3] >= 0, 'no negative sizes');
  }
  for (let col = 0; col < 3; col++) {
    const c = [rects[col], rects[3 + col], rects[6 + col]];
    assert.equal(c[0][1], y, 'column starts at y');
    assert.equal(c[1][1], c[0][1] + c[0][3]);
    assert.equal(c[2][1], c[1][1] + c[1][3]);
    assert.ok(Math.abs(c[2][1] + c[2][3] - (y + h)) < 1e-9, 'column ends at y+h');
  }
}

test('nine draws 9 tiles that cover the box exactly', () => {
  const F = loadRuntime();
  for (const [x, y, w, h] of [[10, 20, 300, 120], [3.7, 8.2, 141.3, 47.9], [0, 0, 24, 24], [100, 50, 18, 7]]) {
    const ctx = fakeCtx();
    const k = F.nine(ctx, frame(), x, y, w, h);
    assert.ok(k > 0);
    assertTiles(ctx.calls, x, y, w, h);
  }
});

test('nine samples the source in 9 slices that tile the frame rect', () => {
  const F = loadRuntime();
  const ctx = fakeCtx();
  F.nine(ctx, frame(), 0, 0, 400, 100);
  const src = ctx.calls.map((c) => c.slice(1, 5));
  assert.deepEqual(src[0], [0, 0, 40, 20]);
  assert.deepEqual(src[4], [40, 20, 120, 40]);
  assert.deepEqual(src[8], [160, 60, 40, 20]);
  for (const c of ctx.calls) assert.equal(c[0], IMG);
});

test('corner scale shrinks so tiny boxes never overlap their corners', () => {
  const F = loadRuntime();
  const f = frame();
  assert.equal(F.scale(f, 1000, 1000), 0.5);            // frame.scale when there is room
  assert.equal(F.scale(f, 1000, 16), 16 / 40);           // limited by height (top+bottom = 40)
  assert.equal(F.scale(f, 32, 1000), 32 / 80);           // limited by width (left+right = 80)
  assert.equal(F.scale(f, 1000, 1000, 2), 2);            // explicit k wins when it fits
});

test('null frame is a no-op so callers fall back to rr()', () => {
  const F = loadRuntime();
  const ctx = fakeCtx();
  assert.equal(F.nine(ctx, null, 0, 0, 100, 30), 0);
  assert.equal(F.nine(ctx, undefined, 0, 0, 100, 30), 0);
  assert.equal(F.nine(ctx, frame(), 0, 0, 0, 30), 0);
  assert.equal(F.part(ctx, null, 'tail', 50, 30, 1), false);
  assert.equal(F.part(ctx, frame(), 'tail', 50, 30, 1), false, 'frame without that part');
  assert.equal(ctx.calls.length, 0);
});

test('part draws once, centred, with row ay on the box edge', () => {
  const F = loadRuntime();
  const ctx = fakeCtx();
  const TAIL = { naturalWidth: 20, naturalHeight: 16 };
  assert.equal(F.part(ctx, frame({ parts: { tail: { img: TAIL, w: 20, h: 16, ay: 4 } } }), 'tail', 100, 50, 0.5), true);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], TAIL);
  assert.deepEqual(ctx.calls[0].slice(1), [95, 48, 10, 8]);
});

// --- load() with stubbed fetch + Image ---

function stubs(manifest, broken = new Set()) {
  class Image {
    set src(v) {
      this._src = v;
      const name = v.split('/').pop().split('?')[0];
      queueMicrotask(() => {
        if (broken.has(name)) return this.onerror && this.onerror();
        this.naturalWidth = 200; this.naturalHeight = 80; this.onload && this.onload();
      });
    }
    get src() { return this._src; }
  }
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    if (manifest === null) return { ok: false, status: 404, json: async () => ({}) };
    if (manifest === 'throw') throw new Error('offline');
    return { ok: true, status: 200, json: async () => manifest };
  };
  return { Image, fetch, seen };
}

test('load resolves frames and returns null for missing images', async () => {
  const s = stubs({
    tag: { src: 'tag.webp', slice: [20, 40, 20, 40], scale: 0.25, pad: [10, 50, 10, 50],
      parts: { tail: { src: 'tail.webp', ay: 5 }, gone: { src: 'gone.webp', ay: 0 }, evil: { src: '../tail.webp', ay: 0 } } },
    card: { src: 'card.webp', slice: [10, 10, 10, 10] },
    evil: { src: '../x.webp', slice: [1, 1, 1, 1] },
    huge: { src: 'tag.webp', slice: [50, 150, 50, 150] },
  }, new Set(['card.webp', 'gone.webp']));
  const F = loadRuntime({ Image: s.Image, fetch: s.fetch });
  const lib = await F.load('/assets/ui/', 7);
  assert.equal(s.seen[0], '/assets/ui/frames.json?v=7');
  const tag = lib.get('tag');
  assert.ok(tag);
  assert.equal(tag.scale, 0.25);
  assert.deepEqual(Array.from(tag.pad), [10, 50, 10, 50]);
  assert.equal(tag.img.src, '/assets/ui/tag.webp?v=7');
  assert.deepEqual(Object.keys(tag.parts), ['tail'], 'failed or unsafe parts are dropped, the frame survives');
  assert.equal(tag.parts.tail.ay, 5);
  assert.equal(tag.parts.tail.img.src, '/assets/ui/tail.webp?v=7');
  assert.equal(lib.get('card'), null, 'image failed to load');
  assert.equal(lib.get('evil'), null, 'path in src rejected');
  assert.equal(lib.get('huge'), null, 'slice larger than image rejected');
  assert.equal(lib.get('nope'), null);
});

test('load never rejects', async () => {
  for (const m of [null, 'throw', 42]) {
    const s = stubs(m);
    const F = loadRuntime({ Image: s.Image, fetch: s.fetch });
    const lib = await F.load('/ui/', 'x');
    assert.equal(lib.get('tag'), null);
  }
  const F = loadRuntime(); // no fetch, no Image at all
  const lib = await F.load('/ui/');
  assert.equal(lib.get('tag'), null);
});
