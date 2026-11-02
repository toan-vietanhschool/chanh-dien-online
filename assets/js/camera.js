/* Chánh Điện Online — cinematic camera (classic script, no modules, no deps). All coordinates are stage space.
 * Exposes window.CDCamera (globalThis.CDCamera):
 *   create({w=1080, h=1920, ambient=true, minGap=2}) -> cam
 *     Pages may read cam.x, cam.y (centre), cam.zoom (>= 1), cam.bars (0..1 letterbox), cam.busy (a shot is active).
 *   shot(cam, {x, y, zoom, hold=2, priority=1, bars=0, ease=1.2}) -> accepted?
 *     Eases from wherever the camera is to the target over `ease` s, holds `hold` s, eases back to rest (centre, zoom 1).
 *     Accepted when no shot is active, or priority >= the active shot's (a cut-in eases, never jumps).
 *     When idle, priority <= the last accepted shot's is rejected for minGap s after it ended (anti-spam).
 *     Also rejected while the last update() had reduce = true.
 *   release(cam)                     end the hold early and ease back to rest
 *   update(cam, dt, reduce=false)    advance one frame (easeInOutCubic; no allocations).
 *     Idle + ambient + !reduce: zoom = 1 + 0.0125(1 - cos(t·2π/24)) with a ±6 px x drift.
 *     reduce: zoom 1, no ambient, any active shot snaps to rest. The visible rect never leaves the stage.
 *   begin(ctx, cam) ... draw the world ... end(ctx, cam)
 *     Composes with ctx's current transform (translate/scale, never setTransform). Identity at rest.
 *     end() draws letterbox bars (bars·110 px each) and a cached vignette (alpha 0.35·bars) in stage space.
 *   worldToScreen(cam, x, y, out?) -> {x, y}   where a world point lands on the stage (DOM followers)
 *   screenToWorld(cam, x, y, out?) -> {x, y}   inverse, for pointer hit-testing
 */
(function (root) {
  'use strict';
  const BAR_H = 110, VIGNETTE = 0.35, AMB_ZOOM = 0.0125, AMB_PERIOD = 24, DRIFT_PX = 6, DRIFT_PERIOD = 37;
  const TAU = Math.PI * 2;
  const REST = 0, IN = 1, HOLD = 2, OUT = 3;
  const num = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
  const pos = (v, def) => (num(v, 0) > 0 ? v : def);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, p) => a * (1 - p) + b * p;
  const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(2 - 2 * p, 3) / 2);
  // Clamps a centre so the visible span [c - half/z, c + half/z] stays inside [0, 2·half].
  const fit = (c, half, z) => clamp(c, half / z, 2 * half - half / z);

  function create(o) {
    o = o || {};
    const w = pos(o.w, 1080), h = pos(o.h, 1920);
    return {
      w, h, ambient: o.ambient !== false, minGap: Math.max(0, num(o.minGap, 2)),
      x: w / 2, y: h / 2, zoom: 1, bars: 0, busy: false, reduce: false,
      // internal: phase timeline, priority bookkeeping, from/to/raw (unclamped) values, cached vignette
      phase: REST, pt: 0, hold: 0, ease: 0, prio: 0, clock: 0, endedAt: -Infinity, at: 0,
      fx: w / 2, fy: h / 2, fz: 1, fb: 0, tx: w / 2, ty: h / 2, tz: 1, tb: 0, rx: w / 2, ry: h / 2, rz: 1, rb: 0,
      vig: null, vigCtx: null,
    };
  }

  function aim(cam, fx, fy, fz, fb, tx, ty, tz, tb) {
    cam.fx = cam.rx = fx; cam.fy = cam.ry = fy; cam.fz = cam.rz = fz; cam.fb = cam.rb = fb;
    cam.tx = tx; cam.ty = ty; cam.tz = tz; cam.tb = tb;
  }

  function shot(cam, o) {
    o = o || {};
    const prio = num(o.priority, 1);
    if (cam.reduce) return false;
    if (cam.busy ? prio < cam.prio : prio <= cam.prio && cam.clock - cam.endedAt < cam.minGap) return false;
    const z = Math.max(1, num(o.zoom, 1)), hw = cam.w / 2, hh = cam.h / 2;
    cam.prio = prio; cam.busy = true; cam.phase = IN; cam.pt = 0;
    cam.hold = Math.max(0, num(o.hold, 2)); cam.ease = Math.max(0, num(o.ease, 1.2));
    aim(cam, cam.x, cam.y, cam.zoom, cam.bars, fit(num(o.x, hw), hw, z), fit(num(o.y, hh), hh, z), z, clamp(num(o.bars, 0), 0, 1));
    return true;
  }

  function out(cam, pt) {
    cam.phase = OUT; cam.pt = pt;
    aim(cam, cam.rx, cam.ry, cam.rz, cam.rb, cam.w / 2, cam.h / 2, 1, 0);
  }

  function finish(cam, over) {
    cam.busy = false; cam.phase = REST; cam.pt = 0; cam.at = 0;
    cam.endedAt = cam.clock - over;
    aim(cam, cam.w / 2, cam.h / 2, 1, 0, cam.w / 2, cam.h / 2, 1, 0);
  }

  function release(cam) {
    if (cam.phase === IN || cam.phase === HOLD) out(cam, 0);
  }

  function advance(cam, dt) {
    cam.pt += dt;
    for (;;) {
      if (cam.pt < (cam.phase === HOLD ? cam.hold : cam.ease)) break;
      cam.pt -= cam.phase === HOLD ? cam.hold : cam.ease;
      if (cam.phase === IN) { cam.phase = HOLD; cam.rx = cam.tx; cam.ry = cam.ty; cam.rz = cam.tz; cam.rb = cam.tb; }
      else if (cam.phase === HOLD) out(cam, cam.pt);
      else return finish(cam, cam.pt);
    }
    if (cam.phase === HOLD) return;
    const p = easeInOutCubic(cam.ease > 0 ? cam.pt / cam.ease : 1);
    cam.rx = lerp(cam.fx, cam.tx, p); cam.ry = lerp(cam.fy, cam.ty, p);
    cam.rz = lerp(cam.fz, cam.tz, p); cam.rb = lerp(cam.fb, cam.tb, p);
  }

  function update(cam, dt, reduce) {
    dt = num(dt, 0) > 0 ? dt : 0;
    cam.clock += dt;
    cam.reduce = !!reduce;
    if (reduce) { if (cam.busy) finish(cam, 0); cam.at = 0; }
    else if (cam.busy) advance(cam, dt);
    let x = cam.rx, z = cam.rz;
    if (!cam.busy && cam.ambient && !reduce) {
      cam.at += dt;
      const e = AMB_ZOOM * (1 - Math.cos(cam.at * TAU / AMB_PERIOD));
      z = 1 + e;
      x += DRIFT_PX * (e / (2 * AMB_ZOOM)) * Math.sin(cam.at * TAU / DRIFT_PERIOD); // drift scales with zoom slack
    }
    cam.zoom = z = Math.max(1, z);
    cam.x = fit(x, cam.w / 2, z);
    cam.y = fit(cam.ry, cam.h / 2, z);
    cam.bars = clamp(cam.rb, 0, 1);
    return cam;
  }

  function begin(ctx, cam) {
    ctx.save();
    ctx.translate(cam.w / 2, cam.h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
  }

  function end(ctx, cam) {
    ctx.restore();
    const b = cam.bars;
    if (!(b > 0)) return;
    const w = cam.w, h = cam.h, bh = b * BAR_H;
    if (cam.vigCtx !== ctx) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      cam.vig = g; cam.vigCtx = ctx;
    }
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, bh);
    ctx.fillRect(0, h - bh, w, bh);
    ctx.globalAlpha = VIGNETTE * b;
    ctx.fillStyle = cam.vig;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  function worldToScreen(cam, x, y, o) {
    o = o || {};
    o.x = (x - cam.x) * cam.zoom + cam.w / 2;
    o.y = (y - cam.y) * cam.zoom + cam.h / 2;
    return o;
  }

  function screenToWorld(cam, x, y, o) {
    o = o || {};
    o.x = (x - cam.w / 2) / cam.zoom + cam.x;
    o.y = (y - cam.h / 2) / cam.zoom + cam.y;
    return o;
  }

  const api = { create, shot, release, update, begin, end, worldToScreen, screenToWorld };
  root.CDCamera = api;
})(globalThis);
