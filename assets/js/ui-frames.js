/* Chánh Điện Online: 9-slice UI frames (classic script, no modules, no deps).
 * Exposes globalThis.CDFrames:
 *   load(base, version) -> Promise<{get(name) -> Frame|null, names()}>
 *       Never rejects. A missing or invalid frames.json or image makes get() return null,
 *       and the caller keeps its plain rr() drawing.
 *   nine(ctx, frame, x, y, w, h, k?) -> scale used (> 0), or 0 when frame is null (nothing drawn)
 *       Draws the frame 9-sliced into the rect. Corner insets are drawn at slice*k, where
 *       k = min(k ?? frame.scale, h/(top+bottom), w/(left+right)), so tiny boxes shrink the
 *       corners instead of overlapping them.
 *   scale(frame, w, h, k?) -> that same k (use it to scale frame.pad for text layout)
 *   part(ctx, frame, name, cx, edgeY, k) -> true if drawn. Extra pieces that must not be stretched
 *       (bubble 'tail', banner 'crestTop' / 'crestBottom'), centred on cx and aligned to the box edge
 *       at y = edgeY (top edge for crests on top, bottom edge for the tail). Pass the k nine() returned.
 * Frame: {name, img, w, h, slice:[t,r,b,l], pad:[t,r,b,l], scale, parts:{name:{img, w, h, ay}}}
 *   Each frame image is the body alone, so slice also works as CSS border-image-slice.
 *   All numbers are source image pixels; scale = display px per source px at normal size.
 *   A part is its own image; its row ay sits on edgeY. A part whose image fails is dropped, not the frame.
 */
(function (root) {
  'use strict';
  const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  const isQuad = (a) => Array.isArray(a) && a.length === 4 && a.every((n) => typeof n === 'number' && n >= 0 && isFinite(n));
  const isFile = (f) => typeof f === 'string' && /^[\w.-]+$/.test(f) && !/^\.+$/.test(f);
  const isPart = (p) => isObj(p) && isFile(p.src) && typeof p.ay === 'number' && isFinite(p.ay);
  const warn = (msg) => { if (root.console) root.console.warn('[CDFrames] ' + msg); };

  function loadImage(src) {
    return new Promise((resolve) => {
      const Img = root.Image;
      if (typeof Img !== 'function') return resolve(null);
      const im = new Img();
      im.onload = () => resolve(im.naturalWidth > 0 ? im : null);
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  async function loadParts(p, base, q) {
    const out = {};
    if (!isObj(p)) return out;
    const names = Object.keys(p).filter((n) => isPart(p[n]));
    const imgs = await Promise.all(names.map((n) => loadImage(base + p[n].src + q)));
    names.forEach((n, i) => {
      const im = imgs[i];
      if (im) out[n] = Object.freeze({ img: im, w: im.naturalWidth, h: im.naturalHeight, ay: p[n].ay });
      else warn('part ' + n + ': image failed to load');
    });
    return out;
  }

  /** Builds a Frame from a manifest entry and its loaded images, or returns null if they don't fit together. */
  function makeFrame(name, e, img, parts) {
    if (!img) return null;
    const W = img.naturalWidth, H = img.naturalHeight;
    const [t, r, b, l] = e.slice;
    if (l + r > W || t + b > H) { warn(name + ': slice larger than image'); return null; }
    return Object.freeze({
      name, img, w: W, h: H,
      slice: e.slice.slice(),
      pad: isQuad(e.pad) ? e.pad.slice() : e.slice.slice(),
      scale: typeof e.scale === 'number' && e.scale > 0 ? e.scale : 1,
      parts: Object.freeze(parts),
    });
  }

  async function load(base, version) {
    const frames = {};
    const api = { get: (n) => (Object.prototype.hasOwnProperty.call(frames, n) ? frames[n] : null), names: () => Object.keys(frames) };
    try {
      const q = version == null ? '' : '?v=' + encodeURIComponent(version);
      const res = await root.fetch(base + 'frames.json' + q);
      if (!res.ok) { warn('frames.json HTTP ' + res.status); return api; }
      const m = await res.json();
      if (!isObj(m)) return api;
      const names = Object.keys(m).filter((n) => {
        const e = m[n];
        const ok = isObj(e) && isFile(e.src) && isQuad(e.slice);
        if (!ok) warn(n + ': bad entry');
        return ok;
      });
      const imgs = await Promise.all(names.map((n) => loadImage(base + m[n].src + q)));
      const parts = await Promise.all(names.map((n, i) => (imgs[i] ? loadParts(m[n].parts, base, q) : {})));
      names.forEach((n, i) => {
        const f = makeFrame(n, m[n], imgs[i], parts[i]);
        if (f) frames[n] = f; else if (!imgs[i]) warn(n + ': image failed to load');
      });
    } catch (e) {
      warn('load failed: ' + (e && e.message));
    }
    return api;
  }

  function scale(frame, w, h, k) {
    const [t, r, b, l] = frame.slice;
    let s = typeof k === 'number' && k > 0 ? k : frame.scale;
    if (t + b > 0) s = Math.min(s, h / (t + b));
    if (l + r > 0) s = Math.min(s, w / (l + r));
    return s > 0 ? s : 0;
  }

  function nine(ctx, frame, x, y, w, h, k) {
    if (!frame || !frame.img || !(w > 0) || !(h > 0)) return 0;
    const s = scale(frame, w, h, k);
    if (!s) return 0;
    const [t, r, b, l] = frame.slice;
    const sw = frame.w, sh = frame.h;
    // Inner edges are rounded so neighbouring tiles share an exact pixel edge (no hairline seams).
    const x1 = Math.round(x + l * s), x2 = Math.max(x1, Math.round(x + w - r * s));
    const y1 = Math.round(y + t * s), y2 = Math.max(y1, Math.round(y + h - b * s));
    const dx = [x, x1, x2, x + w], dy = [y, y1, y2, y + h];
    const sx = [0, l, sw - r, sw], sy = [0, t, sh - b, sh];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        ctx.drawImage(frame.img,
          sx[col], sy[row], sx[col + 1] - sx[col], sy[row + 1] - sy[row],
          dx[col], dy[row], dx[col + 1] - dx[col], dy[row + 1] - dy[row]);
      }
    }
    return s;
  }

  function part(ctx, frame, name, cx, edgeY, k) {
    const p = frame && frame.parts && Object.prototype.hasOwnProperty.call(frame.parts, name) ? frame.parts[name] : null;
    if (!p || !(k > 0)) return false;
    ctx.drawImage(p.img, cx - (p.w * k) / 2, edgeY - p.ay * k, p.w * k, p.h * k);
    return true;
  }

  root.CDFrames = Object.freeze({ load, nine, scale, part });
})(globalThis);
