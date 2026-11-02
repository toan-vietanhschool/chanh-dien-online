// Tests for assets/js/sprites.js (classic script that sets globalThis.CDSprites).
// Run from repo root: node --test tools/sprites/test/runtime.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../../assets/js/sprites.js');
const S = globalThis.CDSprites;

const realFetch = globalThis.fetch;
const fakeFetch = (manifest) => async () => ({ ok: true, json: async () => manifest });
const restoreFetch = () => { globalThis.fetch = realFetch; };

// ---------- Task 3: frameOf / loadSheets / drawFrame ----------

test('frameOf yoyo with hold', () => {
  const a = { frames: 6, fps: 10, yoyo: true, hold: 0.5 };
  assert.equal(S.frameOf(a, 0), 0);
  assert.equal(S.frameOf(a, 0.55), 5);
  assert.equal(S.frameOf(a, 1.0), 5);
  assert.equal(S.frameOf(a, 1.15), 4);
  assert.equal(S.frameOf(a, 1.65), -1);
});

test('frameOf reverse', () => {
  const a = { frames: 5, fps: 10, reverse: true };
  assert.equal(S.frameOf(a, 0), 4);
  assert.equal(S.frameOf(a, 0.45), 0);
  assert.equal(S.frameOf(a, 0.6), -1);
});

test('frameOf loop wraps and one-shot ends', () => {
  assert.equal(S.frameOf({ frames: 4, fps: 10, loop: true }, 0.45), 0);
  assert.equal(S.frameOf({ frames: 5, fps: 8 }, 0.3), 2);
  assert.equal(S.frameOf({ frames: 5, fps: 8 }, 0.7), -1);
});

test('loadSheets survives missing manifest', async (t) => {
  t.after(restoreFetch);
  globalThis.fetch = async () => { throw new Error('x'); };
  const sheets = await S.loadSheets('/assets/sprites/', '2');
  assert.equal(sheets.get('man'), null);
});

test('loadSheets rejects bad manifest', async (t) => {
  t.after(restoreFetch);
  const goodSkin = {
    src: 'man.webp', seatH: 150,
    actions: { idle: { row: 4, frames: 1, loop: true }, bow: { row: -1, frames: 6, fps: 8 } },
  };
  globalThis.fetch = fakeFetch({ version: 2, cell: [0, 240], anchor: [96, 232], skins: { man: goodSkin } });
  let sheets = await S.loadSheets('/assets/sprites/', '2');
  assert.equal(sheets.get('man'), null);

  globalThis.fetch = fakeFetch({ version: 2, cell: [192, 240], anchor: [96, 232], alias: { master: 'man' }, skins: { man: goodSkin } });
  sheets = await S.loadSheets('/assets/sprites/', '2');
  assert.equal(sheets.get('man'), null);
  assert.equal(sheets.get('master'), null);
  assert.equal(sheets.get('__proto__'), null);
  assert.equal(sheets.get('constructor'), null);
});

test('loadSheets appends version to manifest url', async (t) => {
  t.after(restoreFetch);
  let url = '';
  globalThis.fetch = async (u) => { url = u; return { ok: false, json: async () => ({}) }; };
  const sheets = await S.loadSheets('/assets/sprites/', '2');
  assert.equal(url, '/assets/sprites/manifest.json?v=2');
  assert.equal(sheets.get('man'), null);
});

test('drawFrame returns seated or standing height and picks the right cell', () => {
  const calls = [];
  const ctx = {
    drawImage: (...args) => calls.push(args),
    save() {}, restore() {}, translate() {}, scale() {},
  };
  const sheet = { img: {}, cell: [192, 240], anchor: [96, 232], seatH: 150, actions: fakeSheet().actions };
  assert.equal(S.drawFrame(ctx, sheet, 'idle', 0, 100, 200, 0.5, false), 75);
  assert.equal(S.drawFrame(ctx, sheet, 'sit_down', 4, 100, 200, 0.5, false), 75);
  assert.equal(S.drawFrame(ctx, sheet, 'sit_down', 1, 100, 200, 0.5, false), 112);
  assert.equal(S.drawFrame(ctx, sheet, 'walk_side', 2, 100, 200, 1, false), 224);
  const last = calls[calls.length - 1];
  assert.deepEqual(last.slice(1), [384, 240, 192, 240, 4, -32, 192, 240]);
});

// ---------- Task 4: path, motion, state machine ----------

function fakeSheet() {
  return {
    img: null, cell: [192, 240], anchor: [96, 232], seatH: 150,
    actions: {
      walk_back: { row: 0, frames: 6, stride: 22, loop: true },
      walk_side: { row: 1, frames: 6, stride: 22, loop: true },
      walk_front: { row: 2, frames: 6, stride: 22, loop: true },
      sit_down: { row: 3, frames: 5, fps: 8 },
      stand_up: { row: 3, frames: 5, fps: 8, reverse: true },
      idle: { row: 4, frames: 1, loop: true },
      bow: { row: 5, frames: 6, fps: 8, yoyo: true, hold: 0.6 },
      thank: { row: 6, frames: 4, fps: 6, yoyo: true, hold: 0.8 },
    },
  };
}
const DT = 1 / 60;
const speed = (v) => () => v;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Step until pred(a) or max steps; returns list of distinct states seen in order. */
function run(a, sheet, sp, pred, max = 5000) {
  const seen = [a.state];
  for (let i = 0; i < max && !pred(a); i++) {
    S.step(a, DT, sheet, sp, 1);
    if (seen[seen.length - 1] !== a.state) seen.push(a.state);
  }
  return seen;
}

test('path endpoints and monotonic length', () => {
  const pts = [{ x: 540, y: 2020 }, { x: 540, y: 1500 }, { x: 700, y: 1480 }];
  const p = S.makePath(pts);
  assert.ok(dist(p.at(0), pts[0]) <= 0.5);
  assert.ok(dist(p.at(p.length), pts[2]) <= 0.5);
  assert.ok(dist(p.at(p.length + 100), pts[2]) <= 0.5, 'clamps above length');
  assert.ok(dist(p.at(-5), pts[0]) <= 0.5, 'clamps below 0');
  const step = p.length / 50;
  let prev = p.at(0);
  for (let i = 1; i <= 50; i++) {
    const cur = p.at(i * step);
    const d = dist(prev, cur);
    assert.ok(Math.abs(d - step) <= step * 0.15, `sample ${i}: ${d} vs ${step}`);
    prev = cur;
  }
});

test('path at() can write into an out object', () => {
  const p = S.makePath([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  const out = { x: -1, y: -1 };
  assert.equal(p.at(50, out), out);
  assert.ok(Math.abs(out.x - 50) < 0.5 && Math.abs(out.y) < 0.5);
});

test('walk accelerates then stops exactly', () => {
  const sheet = fakeSheet();
  const a = S.newActor(0, 400, false);
  const end = { x: 0, y: 0 };
  S.walk(a, [end], 'sit');
  const vs = [];
  let last = { x: a.x, y: a.y };
  for (let i = 0; i < 5000 && a.state === 'walk'; i++) {
    S.step(a, DT, sheet, speed(200), 1);
    if (i < 5) vs.push(a.v);
    assert.ok(a.y >= end.y - 1e-9, 'never overshoots');
    assert.ok(a.y <= last.y + 1e-9, 'never moves backward');
    last = { x: a.x, y: a.y };
  }
  for (let i = 1; i < 5; i++) assert.ok(vs[i] > vs[i - 1], `v increases at step ${i}`);
  assert.equal(a.state, 'sit_down');
  assert.ok(dist(a, end) < 1e-6);
});

test('walk frames follow distance not time', () => {
  const sheet = fakeSheet();
  const mk = () => { const a = S.newActor(0, 600, false); S.walk(a, [{ x: 0, y: 0 }], 'sit'); return a; };
  const slow = mk(), fast = mk();
  run(slow, sheet, speed(100), (a) => a.dist >= 120);
  run(fast, sheet, speed(200), (a) => a.dist >= 120);
  assert.equal(slow.frame, fast.frame);
  assert.equal(slow.frame, Math.floor(120 / 22) % 6);
  assert.equal(slow.action, 'walk_back');
});

test('direction has hysteresis', () => {
  const a = S.newActor(0, 0, false);
  assert.equal(a.dir, 'back');
  for (let i = 0; i < 30; i++) {
    const r = 1.2 + (i % 2 ? 0.15 : -0.15); // |vx|/|vy| oscillates 1.05..1.35
    S.updateDir(a, -r, -1);
    assert.equal(a.dir, 'back');
  }
  S.updateDir(a, -1.5, -1);
  assert.equal(a.dir, 'side');
  assert.equal(a.flip, true);
  for (let i = 0; i < 30; i++) {
    S.updateDir(a, -(1.2 + (i % 2 ? 0.15 : -0.15)), 1);
    assert.equal(a.dir, 'side');
  }
  S.updateDir(a, 0.5, 1);
  assert.equal(a.dir, 'front');
  S.updateDir(a, 0, 0);
  assert.equal(a.dir, 'front', 'zero velocity keeps dir');
});

test('straight diagonal walk keeps one direction', () => {
  const a = S.newActor(0, 0, false);
  S.walk(a, [{ x: -360, y: -300 }], 'sit'); // ratio 1.2
  const dirs = new Set();
  for (let i = 0; i < 30; i++) { S.step(a, DT, fakeSheet(), speed(200), 1); dirs.add(a.dir); }
  assert.deepEqual([...dirs], ['back']);
});

test('retarget keeps position and speed', () => {
  const sheet = fakeSheet();
  const a = S.newActor(0, 400, false);
  S.walk(a, [{ x: 0, y: 0 }], 'sit');
  run(a, sheet, speed(200), (x) => x.y <= 200);
  const before = { x: a.x, y: a.y, v: a.v, dist: a.dist };
  S.walk(a, [{ x: 100, y: 0 }], 'sit');
  assert.equal(a.x, before.x);
  assert.equal(a.y, before.y);
  assert.equal(a.v, before.v);
  assert.equal(a.dist, before.dist);
  S.step(a, DT, sheet, speed(200), 1);
  assert.ok(a.v >= before.v * 0.95, 'no ramp-in dip after retarget');
  assert.ok(dist(a, before) < before.v * DT + 1);
});

test('queue is capped and deduped', () => {
  const a = S.newActor(0, 0, true);
  S.enqueue(a, 'bow');
  S.enqueue(a, 'bow');
  S.enqueue(a, 'thank');
  S.enqueue(a, 'bow');
  assert.deepEqual(a.queue, ['bow', 'thank']);
  S.enqueue(a, 'bow');
  assert.ok(a.queue.length <= 2);
});

test('act ignores same action already playing', () => {
  const sheet = fakeSheet();
  const a = S.newActor(0, 0, true);
  S.enqueue(a, 'bow');
  S.step(a, DT, sheet, speed(200), 1);
  assert.equal(a.state, 'act');
  assert.equal(a.action, 'bow');
  S.enqueue(a, 'bow');
  assert.deepEqual(a.queue, []);
  const seen = run(a, sheet, speed(200), (x) => x.state === 'idle');
  assert.deepEqual(seen, ['act', 'idle']);
});

test('enqueue delay postpones the action', () => {
  const sheet = fakeSheet();
  const a = S.newActor(0, 0, true);
  S.enqueue(a, 'bow', 0.5);
  for (let i = 0; i < 25; i++) { S.step(a, DT, sheet, speed(200), 1); assert.equal(a.state, 'idle'); }
  run(a, sheet, speed(200), (x) => x.state === 'act', 30);
  assert.equal(a.state, 'act');
});

test('bow during walk waits for idle', () => {
  const sheet = fakeSheet();
  const a = S.newActor(0, 300, false);
  S.walk(a, [{ x: 0, y: 0 }], 'sit');
  S.enqueue(a, 'bow');
  const seen = run(a, sheet, speed(200), (x) => x.state === 'act');
  assert.deepEqual(seen, ['walk', 'sit_down', 'idle', 'act']);
});

test('leave from seat stands up then exits', () => {
  const sheet = fakeSheet();
  const a = S.newActor(500, 1000, true);
  S.enqueue(a, 'bow', 5);
  S.leave(a, [{ x: 540, y: 1025 }, { x: 540, y: 1300 }]);
  assert.deepEqual(a.queue, []);
  const seen = run(a, sheet, speed(200), (x) => x.state === 'gone');
  assert.deepEqual(seen, ['idle', 'stand_up', 'exit', 'gone']);
  assert.ok(dist(a, { x: 540, y: 1300 }) < 1e-6);
});

test('leave delay keeps the seat until the actor walks out', () => {
  const sheet = fakeSheet();
  const a = S.newActor(500, 1000, true);
  S.leave(a, [{ x: 540, y: 1300 }], 1);
  for (let i = 0; i < 55; i++) { S.step(a, DT, sheet, speed(200), 1); assert.equal(a.state, 'idle'); }
  const seen = run(a, sheet, speed(200), (x) => x.state === 'exit');
  assert.deepEqual(seen, ['idle', 'stand_up', 'exit']);
  S.enqueue(a, 'bow');
  assert.deepEqual(a.queue, [], 'leaving actors ignore new actions');
});

test('leave while walking heads out immediately', () => {
  const sheet = fakeSheet();
  const a = S.newActor(0, 400, false);
  S.walk(a, [{ x: 0, y: 0 }], 'sit');
  run(a, sheet, speed(200), (x) => x.y <= 300);
  S.leave(a, [{ x: 0, y: 500 }], 1.5);
  assert.equal(a.state, 'exit');
  const seen = run(a, sheet, speed(200), (x) => x.state === 'gone');
  assert.deepEqual(seen, ['exit', 'gone']);
});

test('step with null sheet snaps to seat', () => {
  const a = S.newActor(540, 2020, false);
  S.walk(a, [{ x: 540, y: 1500 }, { x: 700, y: 1480 }], 'sit');
  S.step(a, DT, null, speed(200), 1);
  assert.equal(a.state, 'idle');
  assert.ok(dist(a, { x: 700, y: 1480 }) < 1e-6);
});

test('null sheet leave still passes through exit', () => {
  const a = S.newActor(500, 1000, true);
  S.leave(a, [{ x: 540, y: 1300 }]);
  const seen = run(a, null, speed(200), (x) => x.state === 'gone', 10);
  assert.deepEqual(seen, ['idle', 'exit', 'gone']);
});

test('waveDelay front row first', () => {
  assert.equal(S.WAVE_ROW_DELAY, 0.18);
  for (let i = 0; i < 20; i++) assert.ok(S.waveDelay(0) < S.waveDelay(3));
});

test('missing walk_side row falls back to walk_back', () => {
  const sheet = fakeSheet();
  delete sheet.actions.walk_side;
  const a = S.newActor(0, 0, false);
  S.walk(a, [{ x: 400, y: 0 }], 'sit');
  for (let i = 0; i < 10; i++) S.step(a, DT, sheet, speed(200), 1);
  assert.equal(a.dir, 'side');
  assert.equal(a.action, 'walk_back');
});

test('bad optional fields fall back to defaults', () => {
  assert.equal(S.frameOf({ frames: 4, fps: 0 }, 0.2), 1); // default 8 fps
  assert.equal(S.frameOf({ frames: 4, fps: -3, loop: true }, 0.5), 0);
  const sheet = fakeSheet();
  sheet.actions.walk_back.stride = 0;
  const a = S.newActor(0, 300, false);
  S.walk(a, [{ x: 0, y: 0 }], 'sit');
  run(a, sheet, speed(200), (x) => x.dist >= 50);
  assert.equal(a.frame, Math.floor(a.dist / 22) % 6);
});

test('enqueue skips the action currently playing even with a queue', () => {
  const sheet = fakeSheet();
  const a = S.newActor(0, 0, true);
  S.enqueue(a, 'bow');
  S.step(a, DT, sheet, speed(200), 1);
  S.enqueue(a, 'thank');
  S.enqueue(a, 'bow');
  assert.deepEqual(a.queue, ['thank']);
});
