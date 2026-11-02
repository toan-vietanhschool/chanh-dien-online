import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../../assets/js/camera.js');
const C = globalThis.CDCamera;

const DT = 1 / 60;
// Advances the camera by `secs` in 60 fps steps.
function run(cam, secs, reduce = false) {
  for (let i = Math.round(secs / DT); i > 0; i--) C.update(cam, DT, reduce);
}

function fakeCtx() {
  const calls = [];
  let depth = 0, gradients = 0;
  const rec = (name) => (...a) => calls.push([name, ...a]);
  return {
    calls,
    get depth() { return depth; },
    get gradients() { return gradients; },
    fillStyle: null, globalAlpha: 1,
    save() { depth++; calls.push(['save']); },
    restore() { depth--; calls.push(['restore']); },
    translate: rec('translate'), scale: rec('scale'), fillRect: rec('fillRect'),
    setTransform: rec('setTransform'), transform: rec('transform'),
    createRadialGradient() { gradients++; return { addColorStop() {} }; },
  };
}

test('rest is identity', () => {
  const cam = C.create();
  C.update(cam, 0.016, true);
  assert.equal(cam.zoom, 1);
  assert.equal(cam.x, 540);
  assert.equal(cam.y, 960);
  assert.equal(cam.bars, 0);
  assert.equal(cam.busy, false);
});

test('shot eases in, holds, eases out', () => {
  const cam = C.create();
  assert.equal(C.shot(cam, { x: 300, y: 1600, zoom: 1.6, hold: 2, ease: 1 }), true);
  assert.equal(cam.busy, true);
  run(cam, 0.5);
  assert.ok(cam.zoom > 1 && cam.zoom < 1.6, 'mid ease-in zoom ' + cam.zoom);
  run(cam, 1);
  assert.ok(Math.abs(cam.zoom - 1.6) <= 0.001, 'hold zoom ' + cam.zoom);
  run(cam, 3.5);
  assert.ok(Math.abs(cam.zoom - 1) <= 0.001, 'rest zoom ' + cam.zoom);
  assert.equal(cam.busy, false);
});

test('clamp keeps edges hidden', () => {
  const cam = C.create();
  C.shot(cam, { x: 0, y: 1920, zoom: 1.6, hold: 2, ease: 1 });
  run(cam, 1.2);
  assert.ok(Math.abs(cam.zoom - 1.6) <= 0.001);
  assert.ok(cam.x - 540 / 1.6 >= -1e-9, 'left edge ' + cam.x);
  assert.ok(cam.y + 960 / 1.6 <= 1920 + 1e-9, 'bottom edge ' + cam.y);
  // every frame of the way in and out stays inside the stage too
  const c2 = C.create();
  C.shot(c2, { x: 1080, y: 0, zoom: 2.5, hold: 0.5, ease: 0.8 });
  for (let i = 0; i < 200; i++) {
    C.update(c2, DT);
    const hw = 540 / c2.zoom, hh = 960 / c2.zoom;
    assert.ok(c2.zoom >= 1);
    assert.ok(c2.x - hw >= -1e-9 && c2.x + hw <= 1080 + 1e-9, 'x ' + c2.x);
    assert.ok(c2.y - hh >= -1e-9 && c2.y + hh <= 1920 + 1e-9, 'y ' + c2.y);
  }
});

test('priority', () => {
  const cam = C.create();
  assert.equal(C.shot(cam, { x: 540, y: 960, zoom: 1.6, hold: 3, ease: 1, priority: 2 }), true);
  run(cam, 1.5); // holding at 1.6
  assert.equal(C.shot(cam, { x: 200, y: 200, zoom: 2.4, hold: 1, priority: 1 }), false);
  const before = cam.zoom;
  assert.equal(C.shot(cam, { x: 200, y: 200, zoom: 2.4, hold: 1, priority: 3 }), true);
  C.update(cam, DT);
  assert.ok(Math.abs(cam.zoom - before) < 0.05, 'jumped from ' + before + ' to ' + cam.zoom);
  run(cam, 1.3);
  assert.ok(Math.abs(cam.zoom - 2.4) <= 0.001, 'reached cut-in target ' + cam.zoom);
});

test('minGap blocks spam', () => {
  const cam = C.create();
  assert.equal(C.shot(cam, { x: 400, y: 900, zoom: 1.4, hold: 0.5, ease: 0.5, priority: 1 }), true);
  let guard = 0;
  while (cam.busy && guard++ < 1000) C.update(cam, DT);
  assert.equal(cam.busy, false);
  assert.equal(C.shot(cam, { x: 400, y: 900, zoom: 1.4, priority: 1 }), false);
  run(cam, 2.1);
  assert.equal(C.shot(cam, { x: 400, y: 900, zoom: 1.4, hold: 0.5, ease: 0.5, priority: 1 }), true);
  // a strictly higher priority is never gap-blocked
  while (cam.busy && guard++ < 2000) C.update(cam, DT);
  assert.equal(C.shot(cam, { x: 400, y: 900, zoom: 1.4, priority: 2 }), true);
});

test('release eases back early', () => {
  const cam = C.create({ ambient: false });
  C.shot(cam, { x: 540, y: 960, zoom: 2, hold: 10, ease: 1 });
  run(cam, 1.5);
  C.release(cam);
  C.update(cam, DT);
  assert.ok(cam.zoom > 1.9, 'no snap on release ' + cam.zoom);
  run(cam, 1.1);
  assert.equal(cam.busy, false);
  assert.equal(cam.zoom, 1);
});

test('reduce disables motion', () => {
  const cam = C.create();
  C.shot(cam, { x: 300, y: 1600, zoom: 1.6, hold: 2, ease: 1 });
  run(cam, 1, true);
  assert.equal(cam.zoom, 1);
  assert.equal(cam.x, 540);
  assert.equal(cam.bars, 0);
});

test('ambient breathing is gentle and off when disabled', () => {
  const cam = C.create();
  run(cam, 12);
  assert.ok(cam.zoom > 1.02 && cam.zoom <= 1.025 + 1e-9, 'ambient peak ' + cam.zoom);
  assert.ok(Math.abs(cam.x - 540) <= 6);
  const still = C.create({ ambient: false });
  run(still, 12);
  assert.equal(still.zoom, 1);
  assert.equal(still.x, 540);
});

test('begin composes transform', () => {
  const ctx = fakeCtx();
  const cam = C.create();
  C.shot(cam, { x: 540, y: 960, zoom: 1.5, hold: 5, ease: 1, bars: 1 });
  run(cam, 1.5);
  assert.ok(Math.abs(cam.bars - 1) < 1e-9);
  for (let i = 0; i < 2; i++) {
    C.begin(ctx, cam);
    C.end(ctx, cam);
  }
  assert.ok(!ctx.calls.some((c) => c[0] === 'setTransform'), 'setTransform used');
  assert.equal(ctx.depth, 0, 'save/restore unbalanced');
  assert.deepEqual(ctx.calls.slice(0, 4), [['save'], ['translate', 540, 960], ['scale', 1.5, 1.5], ['translate', -540, -960]]);
  const rects = ctx.calls.filter((c) => c[0] === 'fillRect').slice(0, 3);
  assert.deepEqual(rects[0], ['fillRect', 0, 0, 1080, 110]);
  assert.deepEqual(rects[1], ['fillRect', 0, 1920 - 110, 1080, 110]);
  assert.equal(ctx.gradients, 1, 'vignette gradient must be cached');
  // at rest: no bars, nothing drawn after restore
  const ctx2 = fakeCtx(), rest = C.create();
  C.update(rest, DT, true);
  C.begin(ctx2, rest);
  C.end(ctx2, rest);
  assert.equal(ctx2.depth, 0);
  assert.ok(!ctx2.calls.some((c) => c[0] === 'fillRect'));
});

test('worldToScreen at rest is identity', () => {
  const cam = C.create();
  C.update(cam, DT, true);
  assert.deepEqual(C.worldToScreen(cam, 123, 456), { x: 123, y: 456 });
  // and maps through the zoom when a shot is held; screenToWorld inverts it
  const cam2 = C.create({ ambient: false });
  C.shot(cam2, { x: 540, y: 960, zoom: 2, hold: 5, ease: 0.5 });
  run(cam2, 1);
  assert.deepEqual(C.worldToScreen(cam2, 640, 1060), { x: 740, y: 1160 });
  const w = C.screenToWorld(cam2, 740, 1160);
  assert.ok(Math.abs(w.x - 640) < 1e-9 && Math.abs(w.y - 1060) < 1e-9);
});
