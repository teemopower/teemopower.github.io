// Likensy challenge player: the same likeness judge and LS1 link format as the app.
// Board 1000 x 1000, y down; rotation in degrees counter-clockwise; raw DEFLATE + base64url payloads.
"use strict";
const LK = (() => {
  const KINDS = ["circle", "ellipse", "rect", "rrect", "triangle", "line", "polyline", "arc", "polygon", "stroke"];
  const LABEL = { circle: "circle", ellipse: "oval", rect: "rectangle", rrect: "rounded rectangle", triangle: "triangle", line: "line", polyline: "path", arc: "arc", polygon: "shape", stroke: "line" };
  const STROKE = 28, PEN = 16, OUTLINE = 14, MAX_SHAPES = 250;
  // The judge's settings. Keep in step with Judge.kt.
  const JUDGE = { pass: 60, tols: [16, 32, 56], span: 800, minSize: 80, partTol: 32, partOk: 0.55, partMissing: 0.35 };
  JUDGE.two = Math.min(JUDGE.pass + 15, 95); JUDGE.three = Math.min(JUDGE.pass + 27, 97);

  // ---------- link codec ----------
  function b64urlToBytes(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64url(b) { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function deflateRaw(bytes) {
    const cs = new CompressionStream("deflate-raw");
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
  }

  async function decode(text) {
    const at = text.indexOf("LS1.");
    if (at < 0) throw new Error("bad");
    const body = text.slice(at + 4).match(/^[A-Za-z0-9_-]+/)[0];
    const raw = await inflateRaw(b64urlToBytes(body));
    const v = new DataView(raw.buffer); let o = 0;
    const u8 = () => v.getUint8(o++); const i16 = () => { const x = v.getInt16(o, true); o += 2; return x; };
    const u16 = () => { const x = v.getUint16(o, true); o += 2; return x; }; const i32 = () => { const x = v.getInt32(o, true); o += 4; return x; };
    if (u8() !== 76 || u8() !== 83) throw new Error("bad");
    if (u8() !== 49) throw new Error("newer");
    const flags = u8(); if (u16() !== 1000 || u16() !== 1000) throw new Error("bad");
    const pn = u8(); if (pn < 1 || pn > 8) throw new Error("bad");
    const palette = []; for (let i = 0; i < pn; i++) { const r = u8(), g = u8(), b = u8(); palette.push(`rgb(${r},${g},${b})`); }
    const text8 = () => { const n = u8(); const s = new TextDecoder().decode(raw.slice(o, o + n)); o += n; return s; };
    const title = flags & 1 ? text8() : ""; const author = flags & 2 ? text8() : "";
    const sn = u8(); if (sn < 1 || sn > MAX_SHAPES) throw new Error("bad");
    const varint = () => { let x = 0, sh = 0; for (;;) { const b = u8(); x |= (b & 0x7f) << sh; if (b < 0x80) return x >>> 0; sh += 7; if (sh >= 28) throw new Error("bad"); } };
    const unzig = (x) => (x >>> 1) ^ -(x & 1);
    const shapes = [];
    for (let i = 0; i < sn; i++) {
      const kind = KINDS[u8()]; if (!kind) throw new Error("bad");
      const color = u8(); if (color >= pn) throw new Error("bad");
      const s = { kind, color, cx: i16(), cy: i16(), w: i16(), h: i16(), rotation: i16() / 10, corner: 0, points: [], sweep: 180 };
      if (kind === "rrect") s.corner = i16();
      else if (kind === "polygon" || kind === "polyline") { const n = u8(); for (let k = 0; k < n; k++) s.points.push({ x: i16(), y: i16() }); }
      else if (kind === "arc") s.sweep = i16() / 10;
      else if (kind === "stroke") {
        const n = varint(); if (n < 1 || n > 4000) throw new Error("bad");
        let px = 0, py = 0; for (let k = 0; k < n; k++) { px += unzig(varint()); py += unzig(varint()); s.points.push({ x: px, y: py }); }
      }
      shapes.push(s);
    }
    const rn = u8(); const required = []; for (let i = 0; i < rn; i++) required.push(u8());
    let social = null;
    if (flags & 4) {
      const lo = v.getUint32(o, true), hi = v.getInt32(o + 4, true); o += 8;
      social = { pairLo: lo, pairHi: hi, streak: u16(), best: u16(), sentDay: i32(), playedDay: i32() };
    }
    return { palette, shapes, required, title, author, social };
  }

  // ---------- geometry ----------
  function rot(p, deg, cx, cy) { const a = -deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return { x: cx + p.x * c - p.y * s, y: cy + p.x * s + p.y * c }; }
  function ellipsePts(rx, ry, n = 48) { const o = []; for (let i = 0; i < n; i++) { const t = 2 * Math.PI * i / n; o.push({ x: rx * Math.cos(t), y: ry * Math.sin(t) }); } return o; }
  function boxPts(w, h, r) {
    const hw = w / 2, hh = h / 2, rr = Math.min(r, hw, hh);
    if (rr <= 0.5) return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
    const out = [], cs = [[hw - rr, -hh + rr, -90], [hw - rr, hh - rr, 0], [-hw + rr, hh - rr, 90], [-hw + rr, -hh + rr, 180]];
    for (const [x, y, st] of cs) for (let k = 0; k <= 6; k++) { const t = (st + 90 * k / 6) * Math.PI / 180; out.push({ x: x + rr * Math.cos(t), y: y + rr * Math.sin(t) }); }
    return out;
  }
  function capsule(a, b, half = STROKE / 2) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x), out = [];
    for (let k = 0; k <= 8; k++) { const t = ang + Math.PI / 2 - Math.PI * k / 8; out.push({ x: b.x + half * Math.cos(t), y: b.y + half * Math.sin(t) }); }
    for (let k = 0; k <= 8; k++) { const t = ang - Math.PI / 2 - Math.PI * k / 8; out.push({ x: a.x + half * Math.cos(t), y: a.y + half * Math.sin(t) }); }
    return out;
  }
  function arcBand(r, sweep, n = 32) {
    const half = STROKE / 2, st = -90 - sweep / 2, o = [];
    for (let i = 0; i <= n; i++) { const t = (st + sweep * i / n) * Math.PI / 180; o.push({ x: (r + half) * Math.cos(t), y: (r + half) * Math.sin(t) }); }
    for (let i = 0; i <= n; i++) { const t = (st + sweep * (n - i) / n) * Math.PI / 180; o.push({ x: (r - half) * Math.cos(t), y: (r - half) * Math.sin(t) }); }
    return o;
  }
  function rings(s) {
    const R = (pts) => pts.map(p => rot(p, s.rotation, s.cx, s.cy));
    switch (s.kind) {
      case "circle": case "ellipse": return [R(ellipsePts(s.w / 2, s.h / 2))];
      case "rect": return [R(boxPts(s.w, s.h, 0))];
      case "rrect": return [R(boxPts(s.w, s.h, s.corner))];
      case "triangle": return [R([{ x: 0, y: -s.h / 2 }, { x: s.w / 2, y: s.h / 2 }, { x: -s.w / 2, y: s.h / 2 }])];
      case "polygon": return [R(s.points)];
      case "line": return [R(capsule({ x: -s.w / 2, y: 0 }, { x: s.w / 2, y: 0 }))];
      case "polyline": { const o = []; for (let i = 1; i < s.points.length; i++) o.push(R(capsule(s.points[i - 1], s.points[i]))); return o; }
      case "arc": return [R(arcBand(s.w / 2, s.sweep))];
      case "stroke": {
        const pts = s.points.map(p => ({ x: s.cx + p.x, y: s.cy + p.y }));
        if (pts.length === 1) return [capsule(pts[0], pts[0], s.w / 2)];
        const o = []; for (let i = 1; i < pts.length; i++) o.push(capsule(pts[i - 1], pts[i], Math.max(s.w / 2, 4))); return o;
      }
    }
    return [];
  }

  // The visible lines of a shape as evenly spaced points (what the judge compares).
  function ink(s, step = 8) {
    let path, closed = false;
    switch (s.kind) {
      case "stroke": path = s.points.map(p => ({ x: s.cx + p.x, y: s.cy + p.y })); break;
      case "line": path = [{ x: -s.w / 2, y: 0 }, { x: s.w / 2, y: 0 }].map(p => rot(p, s.rotation, s.cx, s.cy)); break;
      case "polyline": path = s.points.map(p => rot(p, s.rotation, s.cx, s.cy)); break;
      case "arc": {
        const r = s.w / 2, st = -90 - s.sweep / 2, n = 24; path = [];
        for (let i = 0; i <= n; i++) { const t = (st + s.sweep * i / n) * Math.PI / 180; path.push(rot({ x: r * Math.cos(t), y: r * Math.sin(t) }, s.rotation, s.cx, s.cy)); }
        break;
      }
      default: path = rings(s)[0] || []; closed = true;
    }
    return resample(closed && path.length ? path.concat([path[0]]) : path, step);
  }
  function resample(path, step) {
    if (!path.length) return [];
    const out = [path[0]]; let carry = 0;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1], b = path[k], len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len <= 0) continue;
      let d = step - carry;
      while (d <= len) { const t = d / len; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); d += step; }
      carry = len - (d - step);
    }
    return out;
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function simplify(path, eps = 2.5) {
    if (path.length < 3) return path;
    const keep = new Uint8Array(path.length); keep[0] = keep[path.length - 1] = 1;
    const st = [[0, path.length - 1]];
    while (st.length) {
      const [i, j] = st.pop(); let far = -1, dmax = eps;
      for (let k = i + 1; k < j; k++) { const d = segDist(path[k], path[i], path[j]); if (d > dmax) { dmax = d; far = k; } }
      if (far >= 0) { keep[far] = 1; st.push([i, far], [far, j]); }
    }
    return path.filter((_, k) => keep[k]);
  }
  function inside(ring, x, y) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }
  const covers = (rs, x, y) => rs.some(r => inside(r, x, y));
  function bounds(rs) { let l = 1e9, t = 1e9, r = -1e9, b = -1e9; for (const ring of rs) for (const p of ring) { l = Math.min(l, p.x); t = Math.min(t, p.y); r = Math.max(r, p.x); b = Math.max(b, p.y); } return { l, t, r, b }; }

  // ---------- likeness judge ----------
  function normalizer(pts) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const p of pts) { if (p.x < l) l = p.x; if (p.x > r) r = p.x; if (p.y < t) t = p.y; if (p.y > b) b = p.y; }
    const cx = (l + r) / 2, cy = (t + b) / 2, s = JUDGE.span / Math.max(r - l, b - t, JUDGE.minSize);
    return p => ({ x: (p.x - cx) * s + 500, y: (p.y - cy) * s + 500 });
  }
  function nearest(pts) {
    const cell = 70, grid = new Map(), key = (i, j) => i + "," + j;
    for (const p of pts) { const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(p); }
    return q => {
      const i0 = Math.floor(q.x / cell), j0 = Math.floor(q.y / cell); let best = 9999;
      for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) { const g = grid.get(key(i, j)); if (g) for (const p of g) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < best) best = d; } }
      return best;
    };
  }
  function starsFor(pc) { return pc >= JUDGE.three ? 3 : pc >= JUDGE.two ? 2 : pc >= JUDGE.pass ? 1 : 0; }

  function score(target, player) {
    const req = new Set(target.required.length ? target.required : target.shapes.map((_, i) => i));
    const tInk = target.shapes.map(s => ink(s)), tAll = tInk.flat(), pAll = player.flatMap(s => ink(s));
    if (!tAll.length) return { percent: 0, stars: 0, misses: [], ok: new Set(), extra: false };
    if (!pAll.length) return { percent: 0, stars: 0, misses: [...req].sort((a, b) => a - b).map(t => ({ target: t, why: "missing" })), ok: new Set(), extra: false };
    const tn = normalizer(tAll), pn = normalizer(pAll);
    const tPts = tAll.map(tn), pPts = pAll.map(pn);
    const tNear = nearest(tPts), pNear = nearest(pPts);
    const dT = tPts.map(pNear), dP = pPts.map(tNear);
    const owner = []; tInk.forEach((pts, i) => pts.forEach(() => owner.push(i)));
    const reqIdx = tPts.map((_, k) => k).filter(k => req.has(owner[k]));
    const byPart = new Map(); for (const k of reqIdx) (byPart.get(owner[k]) || byPart.set(owner[k], []).get(owner[k])).push(k);
    let fSum = 0;
    for (const tol of JUDGE.tols) {
      const inkR = reqIdx.filter(k => dT[k] <= tol).length / Math.max(reqIdx.length, 1);
      const parts = [...byPart.values()].map(ix => ix.filter(k => dT[k] <= tol).length / ix.length);
      const partR = parts.reduce((a, b) => a + b, 0) / parts.length;
      const r = (inkR + partR) / 2, p = dP.filter(d => d <= tol).length / dP.length;
      fSum += r + p === 0 ? 0 : 2 * r * p / (r + p);
    }
    const percent = Math.max(0, Math.min(100, Math.round(fSum / JUDGE.tols.length * 100)));
    const ok = new Set(), misses = [];
    for (const i of [...req].sort((a, b) => a - b)) {
      const ix = byPart.get(i); if (!ix) continue;
      const rec = ix.filter(k => dT[k] <= JUDGE.partTol).length / ix.length;
      if (rec >= JUDGE.partOk) ok.add(i); else misses.push({ target: i, why: rec < JUDGE.partMissing ? "missing" : "off" });
    }
    const precision = dP.filter(d => d <= JUDGE.partTol).length / dP.length;
    let stars = starsFor(percent); if (misses.length) stars = Math.min(stars, 1);
    return { percent, stars, misses, ok, extra: precision < 0.7 };
  }

  return { decode, deflateRaw, bytesToB64url, rings, bounds, covers, ink, simplify, score, LABEL, STROKE, PEN, OUTLINE, JUDGE };
})();
if (typeof module !== "undefined") module.exports = LK;
