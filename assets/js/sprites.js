/* Chánh Điện Online — shared sprite runtime (classic script, no modules, no deps).
 * Exposes window.CDSprites (globalThis.CDSprites):
 *   loadSheets(base, version) -> Promise<{get(skin) -> Sheet|null}>  never rejects; bad/missing sheet => null
 *   frameOf(action, t) -> column index for a time-based action, -1 when a one-shot action has finished
 *   drawFrame(ctx, sheet, actionName, frame, x, y, k, flip) -> px height above the feet (for labels/halo)
 *   makePath(points) -> {length, at(s, out?) -> {x,y}}  centripetal Catmull-Rom, arc-length parametrised
 *   newActor(x, y, seated) -> Actor
 *   walk(a, points, then)      then: 'sit' | 'gone'; path starts at (a.x,a.y); keeps a.v; state 'walk' ('exit' if 'gone')
 *   enqueue(a, action, delay=0)  'bow' | 'thank'; max 2 queued, dedupes; ignored while leaving
 *   leave(a, exitPoints, delay=0)  seated: wait delay s, stand_up, then 'exit' along exitPoints; walking: exit now
 *   step(a, dt, sheet|null, speedAt(y), k)  advance one frame
 *   updateDir(a, vx, vy)       facing with hysteresis (used by step; exported for tests)
 *   waveDelay(rowFromFront) -> seconds;  WAVE_ROW_DELAY = 0.18
 * Actor fields pages may read: x, y, state, action, frame, flip, dir, queue, v.
 *   state: 'walk'|'sit_down'|'idle'|'act'|'stand_up'|'exit'|'gone'.  Release the seat once state is 'exit' or 'gone'.
 *   Draw with: drawFrame(ctx, sheet, a.action, a.frame, a.x, a.y, k, a.flip)
 */
(function (root) {
  'use strict';
  const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const DEFAULT_FPS = 8, DEFAULT_STRIDE = 22;
  const SEATED = { idle: 1, bow: 1, thank: 1 };
  const DIR_ACTION = { back: 'walk_back', side: 'walk_side', front: 'walk_front' };

  // ---------- manifest + sheets ----------
  const isInt = (n, min) => Number.isInteger(n) && n >= min;
  const pos = (n, def) => (typeof n === 'number' && n > 0 && isFinite(n) ? n : def); // optional fields: bad => default
  const isPair = (p, ok) => Array.isArray(p) && p.length === 2 && ok(p[0]) && ok(p[1]);
  const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

  const warn = (msg) => { if (root.console) root.console.warn('[CDSprites] ' + msg); };
  const validAction = (a) => isObj(a) && isInt(a.row, 0) && isInt(a.frames, 1);

  /** Returns why a manifest skin entry is unusable, or '' when it is fine. */
  function skinProblem(s) {
    if (!isObj(s) || typeof s.src !== 'string' || !/^[\w.-]+$/.test(s.src)) return 'src must be a plain file name';
    if (!pos(s.seatH, 0)) return 'seatH must be a positive number';
    if (!isObj(s.actions)) return 'actions missing';
    const bad = Object.keys(s.actions).find((k) => !validAction(s.actions[k]));
    return bad ? 'action ' + bad + ' needs integer row >= 0 and frames >= 1' : '';
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (typeof Image === 'undefined') return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function loadSkin(m, name, s, base, q) {
    const img = await loadImage(base + s.src + q);
    if (!img) { if (typeof Image !== 'undefined') warn('skin ' + name + ': image failed to load'); return null; }
    const keys = Object.keys(s.actions);
    const fits = keys.every((k) => {
      const a = s.actions[k];
      return (a.row + 1) * m.cell[1] <= img.naturalHeight && a.frames * m.cell[0] <= img.naturalWidth;
    });
    if (!fits) { warn('skin ' + name + ': image smaller than its rows/frames'); return null; }
    return { img, cell: m.cell, anchor: m.anchor, seatH: s.seatH, actions: s.actions };
  }

  async function loadSheets(base, version) {
    const map = new Map();
    let alias = {};
    try {
      const q = '?v=' + encodeURIComponent(version);
      const res = await fetch(base + 'manifest.json' + q);
      if (!res || !res.ok) throw new Error('manifest ' + (res && res.status));
      const m = await res.json();
      const isNum = (n) => typeof n === 'number' && isFinite(n);
      if (!isObj(m) || !isPair(m.cell, (n) => isInt(n, 1)) || !isPair(m.anchor, isNum) || !isObj(m.skins)) {
        throw new Error('bad manifest');
      }
      if (isObj(m.alias)) alias = m.alias;
      const names = Object.keys(m.skins).filter((n) => {
        const why = skinProblem(m.skins[n]);
        if (why) warn('skin ' + n + ' dropped: ' + why);
        return !why;
      });
      const sheets = await Promise.all(names.map((n) => loadSkin(m, n, m.skins[n], base, q).catch(() => null)));
      names.forEach((n, i) => { if (sheets[i]) map.set(n, sheets[i]); });
    } catch (e) {
      warn('sheets unavailable, using static sprites: ' + (e && e.message));
    }
    return {
      get(skin) {
        const name = hasOwn(alias, skin) && typeof alias[skin] === 'string' ? alias[skin] : skin;
        return map.get(name) || null;
      },
    };
  }

  // ---------- frames + drawing ----------
  function frameOf(act, t) {
    const n = act.frames, fps = pos(act.fps, DEFAULT_FPS);
    const i = Math.floor(Math.max(0, t) * fps);
    if (act.loop) return i % n;
    if (act.yoyo) {
      const hold = pos(act.hold, 0), up = n / fps;
      if (t < up) return Math.min(i, n - 1);
      if (t < up + hold) return n - 1;
      const j = Math.floor((t - up - hold) * fps); // 0 -> frame n-2
      return j < n - 1 ? n - 2 - j : -1;
    }
    if (i >= n) return -1;
    return act.reverse ? n - 1 - i : i;
  }

  function drawFrame(ctx, sheet, name, frame, x, y, k, flip) {
    const act = sheet.actions[name] || sheet.actions.idle;
    const cw = sheet.cell[0], ch = sheet.cell[1], ax = sheet.anchor[0], ay = sheet.anchor[1];
    if (!act) return (ay - 8) * k;
    const f = clamp(frame | 0, 0, act.frames - 1);
    if (sheet.img) {
      const sx = f * cw, sy = act.row * ch;
      if (flip) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(-1, 1);
        ctx.drawImage(sheet.img, sx, sy, cw, ch, -ax * k, -ay * k, cw * k, ch * k);
        ctx.restore();
      } else {
        ctx.drawImage(sheet.img, sx, sy, cw, ch, x - ax * k, y - ay * k, cw * k, ch * k);
      }
    }
    const seated = SEATED[name] === 1 || ((name === 'sit_down' || name === 'stand_up') && f === act.frames - 1);
    return seated ? sheet.seatH * k : (ay - 8) * k;
  }

  // ---------- path: centripetal Catmull-Rom with arc-length table ----------
  const SAMPLES = 24;

  function makePath(points) {
    const P = [];
    for (const p of points) {
      const q = P[P.length - 1];
      if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) P.push({ x: p.x, y: p.y });
    }
    const segs = Math.max(1, P.length - 1);
    const xs = new Float64Array(segs * SAMPLES + 1), ys = new Float64Array(xs.length), cum = new Float64Array(xs.length);
    xs[0] = P[0].x; ys[0] = P[0].y;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      let d0 = Math.pow(Math.hypot(p1.x - p0.x, p1.y - p0.y), 0.5);
      let d1 = Math.pow(Math.hypot(p2.x - p1.x, p2.y - p1.y), 0.5);
      let d2 = Math.pow(Math.hypot(p3.x - p2.x, p3.y - p2.y), 0.5);
      if (d1 < 1e-4) d1 = 1;
      if (d0 < 1e-4) d0 = d1; // repeated endpoint
      if (d2 < 1e-4) d2 = d1;
      const tan = (a, b, c, e0, e1) => ((b - a) / e0 - (c - a) / (e0 + e1) + (c - b) / e1) * d1;
      const tx1 = tan(p0.x, p1.x, p2.x, d0, d1), ty1 = tan(p0.y, p1.y, p2.y, d0, d1);
      const tx2 = tan(p1.x, p2.x, p3.x, d1, d2), ty2 = tan(p1.y, p2.y, p3.y, d1, d2);
      const cx2 = -3 * p1.x + 3 * p2.x - 2 * tx1 - tx2, cx3 = 2 * p1.x - 2 * p2.x + tx1 + tx2;
      const cy2 = -3 * p1.y + 3 * p2.y - 2 * ty1 - ty2, cy3 = 2 * p1.y - 2 * p2.y + ty1 + ty2;
      for (let j = 1; j <= SAMPLES; j++) {
        const u = j / SAMPLES, n = i * SAMPLES + j;
        xs[n] = p1.x + u * (tx1 + u * (cx2 + u * cx3));
        ys[n] = p1.y + u * (ty1 + u * (cy2 + u * cy3));
        cum[n] = cum[n - 1] + Math.hypot(xs[n] - xs[n - 1], ys[n] - ys[n - 1]);
      }
    }
    if (P.length === 1) { xs.fill(P[0].x); ys.fill(P[0].y); }
    const last = xs.length - 1, length = cum[last];
    return {
      length,
      at(s, out) {
        const o = out || { x: 0, y: 0 };
        s = clamp(s, 0, length);
        let lo = 0, hi = last;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
        const span = cum[hi] - cum[lo], f = span > 0 ? (s - cum[lo]) / span : 0;
        o.x = xs[lo] + (xs[hi] - xs[lo]) * f;
        o.y = ys[lo] + (ys[hi] - ys[lo]) * f;
        return o;
      },
    };
  }

  // ---------- actors ----------
  const ACCEL = 5;          // 1/s, how fast v approaches its target
  const MIN_SPEED = 10;     // px/s floor so a walk always terminates
  const RAMP_IN = 60, RAMP_OUT = 90, RAMP_MIN = 0.2;
  const SIDE_RATIO = 1.4, VERT_RATIO = 1.0;
  const QUEUE_MAX = 2;
  const WAVE_ROW_DELAY = 0.18;

  function newActor(x, y, seated) {
    return {
      x, y, v: 0, state: seated ? 'idle' : 'walk', dir: 'back', flip: false,
      action: seated ? 'idle' : 'walk_back', frame: 0,
      queue: [], qAt: [], cur: null,
      t: 0, clock: 0, path: null, s: 0, boost: 0, dist: 0, then: 'sit',
      exitPts: null, leaveAt: 0,
    };
  }

  function setState(a, state, action) { a.state = state; a.action = action; a.t = 0; a.frame = 0; }

  function walk(a, points, then) {
    const moving = (a.state === 'walk' || a.state === 'exit') && a.v > 0;
    a.path = makePath([{ x: a.x, y: a.y }].concat(points));
    a.s = 0;
    a.boost = moving ? RAMP_IN : 0; // retarget mid-walk: no second ramp-in
    a.then = then === 'gone' ? 'gone' : 'sit';
    a.state = a.then === 'gone' ? 'exit' : 'walk';
    a.action = DIR_ACTION[a.dir];
  }

  function enqueue(a, action, delay) {
    if (a.exitPts || a.state === 'stand_up' || a.state === 'exit' || a.state === 'gone') return;
    const q = a.queue;
    if (q.length >= QUEUE_MAX || q[q.length - 1] === action) return;
    if (a.state === 'act' && a.cur === action) return;
    q.push(action);
    a.qAt.push(a.clock + Math.max(0, delay || 0));
  }

  function leave(a, exitPoints, delay) {
    a.queue.length = 0;
    a.qAt.length = 0;
    if (a.state === 'stand_up' || a.state === 'exit' || a.state === 'gone') return;
    if (a.state === 'walk') { walk(a, exitPoints, 'gone'); return; }
    a.exitPts = exitPoints;
    a.leaveAt = a.clock + Math.max(0, delay || 0);
  }

  function updateDir(a, vx, vy) {
    const ax = Math.abs(vx), ay = Math.abs(vy);
    if (ax > SIDE_RATIO * ay) a.dir = 'side';
    else if (ay > VERT_RATIO * ax) a.dir = vy < 0 ? 'back' : 'front';
    if (a.dir === 'side') { if (ax > 0) a.flip = vx < 0; } else a.flip = false;
  }

  function arrive(a, sheet) {
    a.v = 0;
    a.path = null;
    a.flip = false;
    if (a.then === 'gone') setState(a, 'gone', a.action);
    else if (sheet) setState(a, 'sit_down', 'sit_down');
    else setState(a, 'idle', 'idle');
  }

  function moveStep(a, dt, sheet, speedAt, k) {
    const p = a.path;
    if (!p) return arrive(a, sheet);
    if (!sheet) { p.at(p.length, a); return arrive(a, sheet); }
    const rem = p.length - a.s;
    if (rem >= 1) {
      const ramp = clamp(Math.min((a.s + a.boost) / RAMP_IN, rem / RAMP_OUT), RAMP_MIN, 1);
      const target = Math.max(speedAt(a.y) * ramp, MIN_SPEED);
      a.v += (target - a.v) * Math.min(1, dt * ACCEL);
      const d = Math.min(a.v * dt, rem);
      const ox = a.x, oy = a.y;
      a.s += d;
      a.dist += d;
      p.at(a.s, a);
      updateDir(a, a.x - ox, a.y - oy);
      const want = DIR_ACTION[a.dir];
      a.action = sheet.actions[want] ? want : 'walk_back'; // missing side/front row: fall back to walk_back
      const act = sheet.actions[a.action];
      a.frame = act ? Math.floor(a.dist / Math.max(1e-3, pos(act.stride, DEFAULT_STRIDE) * k)) % act.frames : 0;
    }
    if (p.length - a.s < 1) { p.at(p.length, a); arrive(a, sheet); }
  }

  function actStep(a, dt, sheet) {
    a.t += dt;
    if (a.state === 'idle') {
      if (a.exitPts && a.clock >= a.leaveAt) setState(a, 'stand_up', 'stand_up');
      else if (a.queue.length && a.clock >= a.qAt[0]) {
        a.cur = a.queue.shift();
        a.qAt.shift();
        setState(a, 'act', a.cur);
      } else {
        const idle = sheet && sheet.actions.idle;
        a.frame = idle ? frameOf(idle, a.clock) : 0;
        return;
      }
    }
    const act = sheet && sheet.actions[a.action];
    const f = act ? frameOf(act, a.t) : -1;
    if (f >= 0) { a.frame = f; return; }
    if (a.state === 'stand_up') {
      const pts = a.exitPts;
      a.exitPts = null;
      walk(a, pts, 'gone');
      a.dir = 'front';
      a.action = DIR_ACTION.front;
    } else {
      a.cur = null;
      setState(a, 'idle', 'idle');
    }
  }

  function step(a, dt, sheet, speedAt, k) {
    a.clock += dt;
    if (a.state === 'walk' || a.state === 'exit') moveStep(a, dt, sheet, speedAt, k);
    else if (a.state !== 'gone') actStep(a, dt, sheet);
  }

  function waveDelay(rowFromFront) { return rowFromFront * WAVE_ROW_DELAY + Math.random() * 0.08; }

  const api = {
    loadSheets, frameOf, drawFrame, makePath, newActor, walk, enqueue, leave, step, updateDir,
    waveDelay, WAVE_ROW_DELAY,
  };
  root.CDSprites = api;
})(globalThis);
