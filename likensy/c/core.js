// Likensy challenge player: the same scene-graph scorer and LS1 link format as the app.
// Board 1000 x 1000, y down; rotation in degrees counter-clockwise; raw DEFLATE + base64url payloads.
"use strict";
const LK = (() => {
  const KINDS = ["circle", "ellipse", "rect", "rrect", "triangle", "line", "polyline", "arc", "polygon"];
  const LABEL = { circle: "circle", ellipse: "oval", rect: "rectangle", rrect: "rounded rectangle", triangle: "triangle", line: "line", polyline: "path", arc: "arc", polygon: "shape" };
  const STROKE = 28, DIAG = Math.hypot(1000, 1000);
  const BANDS = {
    1: { center: 0.12, lo: 0.55, hi: 1.8, rot: 25, iou: 0.35 },
    2: { center: 0.07, lo: 0.75, hi: 1.33, rot: 12, iou: 0.55 },
    3: { center: 0.045, lo: 0.85, hi: 1.18, rot: 8, iou: 0.7 },
  };

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
    const sn = u8(); if (sn < 1 || sn > 40) throw new Error("bad");
    const shapes = [];
    for (let i = 0; i < sn; i++) {
      const kind = KINDS[u8()]; if (!kind) throw new Error("bad");
      const color = u8(); if (color >= pn) throw new Error("bad");
      const s = { kind, color, cx: i16(), cy: i16(), w: i16(), h: i16(), rotation: i16() / 10, corner: 0, points: [], sweep: 180 };
      if (kind === "rrect") s.corner = i16();
      else if (kind === "polygon" || kind === "polyline") { const n = u8(); for (let k = 0; k < n; k++) s.points.push({ x: i16(), y: i16() }); }
      else if (kind === "arc") s.sweep = i16() / 10;
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
    }
    return [];
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
  function iou(a, b, grid = 72) {
    const ra = rings(a), rb = rings(b), ba = bounds(ra), bb = bounds(rb);
    const l = Math.min(ba.l, bb.l), t = Math.min(ba.t, bb.t), r = Math.max(ba.r, bb.r), btm = Math.max(ba.b, bb.b);
    const sx = (r - l) / grid, sy = (btm - t) / grid; if (sx <= 0 || sy <= 0) return 0;
    let both = 0, either = 0;
    for (let i = 0; i < grid; i++) { const y = t + (i + 0.5) * sy;
      for (let j = 0; j < grid; j++) { const x = l + (j + 0.5) * sx;
        const A = x >= ba.l && x <= ba.r && y >= ba.t && y <= ba.b && covers(ra, x, y);
        const B = x >= bb.l && x <= bb.r && y >= bb.t && y <= bb.b && covers(rb, x, y);
        if (A || B) either++; if (A && B) both++; } }
    return either ? both / either : 0;
  }
  function angleGap(a, b, period) { if (period <= 0) return 0; let d = Math.abs(a - b) % period; if (d > period / 2) d = period - d; return d; }

  // ---------- scorer ----------
  const roundish = s => (s.kind === "circle" || s.kind === "ellipse") && Math.abs(s.w - s.h) <= 0.05 * Math.max(s.w, s.h);
  const boxy = k => k === "rect" || k === "rrect";
  function period(s) {
    switch (s.kind) {
      case "circle": return 0;
      case "ellipse": return roundish(s) ? 0 : 180;
      case "rect": case "rrect": return Math.abs(s.w - s.h) <= 0.05 * Math.max(s.w, s.h) ? 90 : 180;
      case "line": return 180;
      default: return 360;
    }
  }
  function eligible(t, p) {
    if (t.color !== p.color) return false;
    if (t.kind === p.kind) return true;
    if (roundish(t) && roundish(p)) return true;
    if (boxy(t.kind) && boxy(p.kind)) return (t.kind === "rrect" ? t.corner : p.corner) <= 2;
    return false;
  }
  function fit(ti, t, pi, p) {
    const center = Math.hypot(p.cx - t.cx, p.cy - t.cy) / DIAG;
    const rw = Math.max(p.w, 4) / Math.max(t.w, 4);
    const rh = t.kind === "line" ? rw : Math.max(p.h, 4) / Math.max(t.h, 4);
    const pp = period(p), per = Math.min(period(t), pp === 0 ? period(t) : pp);
    const r = angleGap(t.rotation, p.rotation, per);
    const ov = iou(t, Object.assign({}, p, { cx: t.cx, cy: t.cy }));
    const sizeErr = Math.max(Math.abs(Math.log(rw)), Math.abs(Math.log(rh)));
    const cost = 0.4 * center + 0.25 * Math.min(sizeErr / Math.log(2), 1) + 0.1 * (r / 180) + 0.25 * (1 - ov);
    return { target: ti, player: pi, center, lo: Math.min(rw, rh), hi: Math.max(rw, rh), rot: r, iou: ov, cost };
  }
  const meets = (f, b) => f.center <= b.center && f.lo >= b.lo && f.hi <= b.hi && f.rot <= b.rot && f.iou >= b.iou;

  function hungarian(cost) {
    const rows = cost.length; if (!rows) return [];
    const cols = cost[0].length, n = Math.max(rows, cols);
    const a = []; for (let i = 0; i <= n; i++) { a.push(new Float64Array(n + 1)); }
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) a[i + 1][j + 1] = cost[i][j];
    const u = new Float64Array(n + 1), v = new Float64Array(n + 1), p = new Int32Array(n + 1), way = new Int32Array(n + 1);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0; const minv = new Float64Array(n + 1).fill(Infinity), used = new Uint8Array(n + 1);
      do {
        used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= n; j++) if (!used[j]) { const cur = a[i0][j] - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < delta) { delta = minv[j]; j1 = j; } }
        for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const out = new Array(rows).fill(-1);
    for (let j = 1; j <= n; j++) { const i = p[j]; if (i >= 1 && i <= rows && j <= cols) out[i - 1] = j - 1; }
    return out;
  }

  function score(target, player) {
    const req = target.required.length ? target.required : target.shapes.map((_, i) => i);
    const fits = req.map(() => new Array(player.length).fill(null));
    const cost = req.map(() => new Array(player.length).fill(1e6));
    req.forEach((ti, r) => player.forEach((p, pi) => { const t = target.shapes[ti]; if (eligible(t, p)) { const f = fit(ti, t, pi, p); fits[r][pi] = f; cost[r][pi] = f.cost; } }));
    const pick = player.length ? hungarian(cost) : req.map(() => -1);
    const chosen = [], misses = [];
    req.forEach((ti, r) => {
      const f = pick[r] >= 0 ? fits[r][pick[r]] : null;
      if (!f) { misses.push({ target: ti, why: "missing" }); return; }
      chosen.push(f);
      if (!meets(f, BANDS[1])) misses.push({ target: ti, why: f.center > BANDS[1].center ? "place" : f.hi > BANDS[1].hi ? "big" : f.lo < BANDS[1].lo ? "small" : f.rot > BANDS[1].rot ? "turn" : "shape" });
    });
    const used = new Set(chosen.map(f => f.player)); const leftovers = player.filter((_, i) => !used.has(i)).length;
    let stars = 1;
    if (misses.length) stars = 0; else if (chosen.every(f => meets(f, BANDS[3])) && leftovers <= 1) stars = 3; else if (chosen.every(f => meets(f, BANDS[2]))) stars = 2;
    return { stars, misses, fits: chosen, ok: new Set(chosen.filter(f => meets(f, BANDS[1])).map(f => f.target)) };
  }

  return { decode, deflateRaw, bytesToB64url, rings, bounds, covers, score, LABEL, STROKE };
})();
if (typeof module !== "undefined") module.exports = LK;
