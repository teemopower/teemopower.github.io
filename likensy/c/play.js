"use strict";
(() => {
  const PKG = "com.adaptationapps.likensy";
  const NS = "http://www.w3.org/2000/svg";
  const $ = id => document.getElementById(id);
  const board = $("board"), targetSvg = $("target");
  const TOOLS = [["move", "Move"], ["circle", "Circle"], ["ellipse", "Oval"], ["rect", "Box"], ["rrect", "Rounded"], ["triangle", "Triangle"], ["line", "Line"], ["polygon", "Shape"], ["arc", "Arc"]];
  let target, payload, shapes = [], history = [], selected = -1, tool = "circle", color = 0, ghost = false, draft = [], preview = null;

  const snapGrid = v => Math.round(v / 32) * 32;
  const snapSize = v => Math.max(16, Math.round(Math.abs(v) / 16) * 16);
  const snapAngle = (d, step = 15) => { const k = Math.round(d / step) * step; return Math.abs(d - k) <= 8 ? k : d; };

  function anchorsOf(except) {
    const a = [];
    shapes.forEach((s, i) => { if (i === except) return; const b = LK.bounds(LK.rings(s)); a.push({ x: s.cx, y: s.cy }, { x: s.cx, y: b.t }, { x: s.cx, y: b.b }, { x: b.l, y: s.cy }, { x: b.r, y: s.cy }); });
    return a;
  }
  function snapper() {
    let held = null;
    return (x, y, anchors) => {
      if (held && Math.hypot(held.x - x, held.y - y) <= 20) return held;
      held = null;
      let best = null, bd = 1e9; for (const p of anchors) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
      if (best && bd <= 14) { held = best; if (navigator.vibrate) navigator.vibrate(5); return best; }
      return { x: snapGrid(x), y: snapGrid(y) };
    };
  }

  // ---------- drawing ----------
  function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function drawShape(s, fill, parent, opacity = 1) {
    const g = el("g", { transform: `rotate(${-s.rotation} ${s.cx} ${s.cy})`, opacity }, parent);
    const w = s.w, h = s.h, x = s.cx - w / 2, y = s.cy - h / 2;
    switch (s.kind) {
      case "circle": case "ellipse": el("ellipse", { cx: s.cx, cy: s.cy, rx: w / 2, ry: h / 2, fill }, g); break;
      case "rect": el("rect", { x, y, width: w, height: h, fill }, g); break;
      case "rrect": el("rect", { x, y, width: w, height: h, rx: s.corner, fill }, g); break;
      case "triangle": el("polygon", { points: `${s.cx},${y} ${s.cx + w / 2},${y + h} ${s.cx - w / 2},${y + h}`, fill }, g); break;
      case "polygon": el("polygon", { points: s.points.map(p => `${s.cx + p.x},${s.cy + p.y}`).join(" "), fill }, g); break;
      case "polyline": el("polyline", { points: s.points.map(p => `${s.cx + p.x},${s.cy + p.y}`).join(" "), fill: "none", stroke: fill, "stroke-width": LK.STROKE, "stroke-linecap": "round", "stroke-linejoin": "round" }, g); break;
      case "line": el("line", { x1: s.cx - w / 2, y1: s.cy, x2: s.cx + w / 2, y2: s.cy, stroke: fill, "stroke-width": LK.STROKE, "stroke-linecap": "round" }, g); break;
      case "arc": {
        const r = w / 2, a0 = (-90 - s.sweep / 2) * Math.PI / 180, a1 = (-90 + s.sweep / 2) * Math.PI / 180;
        const p0 = [s.cx + r * Math.cos(a0), s.cy + r * Math.sin(a0)], p1 = [s.cx + r * Math.cos(a1), s.cy + r * Math.sin(a1)];
        el("path", { d: `M${p0[0]},${p0[1]} A${r},${r} 0 ${s.sweep > 180 ? 1 : 0} 1 ${p1[0]},${p1[1]}`, fill: "none", stroke: fill, "stroke-width": LK.STROKE, "stroke-linecap": "round" }, g);
      }
    }
    return g;
  }
  function render() {
    board.innerHTML = "";
    const dots = el("g", { fill: "#DCD2C1" }, board);
    for (let y = 32; y < 1000; y += 32) for (let x = 32; x < 1000; x += 32) el("circle", { cx: x, cy: y, r: 2 }, dots);
    if (ghost) target.shapes.forEach(s => drawShape(s, target.palette[s.color], board, 0.2));
    shapes.forEach(s => drawShape(s, target.palette[s.color], board));
    draft.forEach((p, i) => { el("circle", { cx: p.x, cy: p.y, r: 8, fill: "#1C1916" }, board); if (i) el("line", { x1: draft[i - 1].x, y1: draft[i - 1].y, x2: p.x, y2: p.y, stroke: "#1C1916", "stroke-width": 4 }, board); });
    if (preview) drawShape(preview, target.palette[preview.color], board, 0.85);
    if (selected >= 0 && shapes[selected]) {
      const s = shapes[selected], b = LK.bounds(LK.rings(s));
      el("rect", { x: b.l - 8, y: b.t - 8, width: b.r - b.l + 16, height: b.b - b.t + 16, fill: "none", stroke: "#1C1916", "stroke-width": 3, "stroke-dasharray": "10 8" }, board);
      if (s.kind !== "polygon") { const h = handle(s); el("circle", { cx: h.x, cy: h.y, r: 18, fill: "#fff", stroke: "#1C1916", "stroke-width": 4 }, board); }
    }
    $("selbar").classList.toggle("hidden", selected < 0);
    $("closePoly").classList.toggle("hidden", !(tool === "polygon" && draft.length));
    $("done").classList.toggle("hidden", tool === "polygon" && draft.length > 0);
    $("done").disabled = !shapes.length;
    $("undo").disabled = !history.length;
    $("ghostBtn").textContent = ghost ? "Hide guide" : "Show guide";
  }
  function rotP(p, deg, cx, cy) { const a = -deg * Math.PI / 180; return { x: cx + p.x * Math.cos(a) - p.y * Math.sin(a), y: cy + p.x * Math.sin(a) + p.y * Math.cos(a) }; }
  function handle(s) {
    if (s.kind === "line") return rotP({ x: s.w / 2, y: 0 }, s.rotation, s.cx, s.cy);
    if (s.kind === "circle" || s.kind === "arc") return rotP({ x: s.w / 2 * 0.707, y: s.w / 2 * 0.707 }, s.rotation, s.cx, s.cy);
    return rotP({ x: s.w / 2, y: s.h / 2 }, s.rotation, s.cx, s.cy);
  }
  const hits = (s, p, slop) => { const rs = LK.rings(s); if (LK.covers(rs, p.x, p.y)) return true; const b = LK.bounds(rs); return p.x > b.l - slop && p.x < b.r + slop && p.y > b.t - slop && p.y < b.b + slop && Math.max(b.r - b.l, b.b - b.t) < slop * 3; };

  function make(a, b) {
    const tap = Math.hypot(b.x - a.x, b.y - a.y) < 12, dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    const base = { kind: tool, color, cx: a.x, cy: a.y, rotation: 0, corner: 0, points: [], sweep: 180 };
    switch (tool) {
      case "circle": { const d = tap ? 160 : snapSize(2 * Math.hypot(dx, dy)); return Object.assign(base, { w: d, h: d }); }
      case "ellipse": return Object.assign(base, { w: tap ? 192 : snapSize(2 * dx), h: tap ? 128 : snapSize(2 * dy) });
      case "rect": return Object.assign(base, { w: tap ? 160 : snapSize(2 * dx), h: tap ? 160 : snapSize(2 * dy) });
      case "rrect": return Object.assign(base, { w: tap ? 160 : snapSize(2 * dx), h: tap ? 128 : snapSize(2 * dy), corner: 16 });
      case "triangle": return Object.assign(base, { w: tap ? 192 : snapSize(2 * dx), h: tap ? 160 : snapSize(2 * dy) });
      case "arc": { const d = tap ? 256 : snapSize(2 * Math.hypot(dx, dy)); return Object.assign(base, { w: d, h: d }); }
      case "line": return tap ? Object.assign(base, { w: 160, h: 0 }) : lineFrom(base, a, b);
    }
    return null;
  }
  function lineFrom(base, a, b) {
    const len = Math.hypot(b.x - a.x, b.y - a.y); if (len < 16) return null;
    let deg = Math.atan2(-(b.y - a.y), b.x - a.x) * 180 / Math.PI; deg = snapAngle(deg);
    const r = deg * Math.PI / 180, e = { x: a.x + len * Math.cos(r), y: a.y - len * Math.sin(r) };
    return Object.assign({}, base, { cx: (a.x + e.x) / 2, cy: (a.y + e.y) / 2, w: len, h: 0, rotation: deg });
  }
  const commit = next => { history.push(shapes); if (history.length > 200) history.shift(); shapes = next; };

  // ---------- input ----------
  function toBoard(ev) { const r = board.getBoundingClientRect(); return { x: (ev.clientX - r.left) * 1000 / r.width, y: (ev.clientY - r.top) * 1000 / r.height }; }
  let drag = null;
  board.addEventListener("pointerdown", ev => {
    board.setPointerCapture(ev.pointerId);
    const p0 = toBoard(ev), slop = 22 * 1000 / board.getBoundingClientRect().width, snap = snapper();
    if (tool === "move") { const hit = shapes.map((s, i) => i).reverse().find(i => hits(shapes[i], p0, slop)); if (hit !== undefined) selected = hit; else if (selected >= 0 && !hits(shapes[selected], p0, slop) && Math.hypot(handle(shapes[selected]).x - p0.x, handle(shapes[selected]).y - p0.y) > slop * 1.4) selected = -1; }
    const sel = selected >= 0 ? shapes[selected] : null;
    let mode = "place";
    if (sel && sel.kind !== "polygon" && Math.hypot(handle(sel).x - p0.x, handle(sel).y - p0.y) <= slop * 1.4) mode = "resize";
    else if (sel && hits(sel, p0, slop)) mode = "move";
    else if (tool === "move") mode = "none";
    else if (tool === "polygon") mode = "poly";
    const anchors = anchorsOf(mode === "place" ? -1 : selected);
    const start = mode === "place" ? snap(p0.x, p0.y, anchors) : p0;
    drag = { mode, p0, start, snap, anchors, base: shapes, sel, moved: false, slop };
    if (mode === "place") preview = make(start, start);
    render();
  });
  board.addEventListener("pointermove", ev => {
    if (!drag) return;
    const p = toBoard(ev);
    if (!drag.moved && Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y) > drag.slop * 0.5) drag.moved = true;
    if (!drag.moved) return;
    if (drag.mode === "place") { const end = tool === "line" ? drag.snap(p.x, p.y, drag.anchors) : p; preview = make(drag.start, end); }
    else if (drag.mode === "move") { const s = drag.sel, c = drag.snap(s.cx + p.x - drag.p0.x, s.cy + p.y - drag.p0.y, drag.anchors); shapes = drag.base.map((x, i) => i === selected ? Object.assign({}, s, { cx: c.x, cy: c.y }) : x); }
    else if (drag.mode === "resize") {
      const s = drag.sel;
      if (s.kind === "line") { const a = rotP({ x: -s.w / 2, y: 0 }, s.rotation, s.cx, s.cy), e = drag.snap(p.x, p.y, drag.anchors), n = lineFrom(s, a, e); if (n) shapes = drag.base.map((x, i) => i === selected ? n : x); }
      else {
        const t = s.rotation * Math.PI / 180, dx = p.x - s.cx, dy = p.y - s.cy, lx = dx * Math.cos(t) - dy * Math.sin(t), ly = dx * Math.sin(t) + dy * Math.cos(t);
        const n = (s.kind === "circle" || s.kind === "arc") ? (d => Object.assign({}, s, { w: d, h: d }))(snapSize(2 * Math.hypot(lx, ly))) : Object.assign({}, s, { w: snapSize(2 * lx), h: snapSize(2 * ly) });
        shapes = drag.base.map((x, i) => i === selected ? n : x);
      }
    }
    render();
  });
  board.addEventListener("pointerup", ev => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode === "place") { const s = preview || make(d.start, d.start); preview = null; if (s) { commit(shapes.concat([s])); selected = shapes.length - 1; if (navigator.vibrate) navigator.vibrate(12); } }
    else if (d.mode === "move" || d.mode === "resize") {
      if (d.moved) { history.push(d.base); }
      else if (d.mode === "move" && tool !== "move" && tool !== "polygon") { const q = snapper()(d.p0.x, d.p0.y, d.anchors), s = make(q, q); if (s) { commit(shapes.concat([s])); selected = shapes.length - 1; } }
    }
    else if (d.mode === "poly") { selected = -1; draft.push(d.snap(d.p0.x, d.p0.y, d.anchors)); }
    render();
  });

  // ---------- controls ----------
  function buildControls() {
    const cs = $("colors"); cs.innerHTML = "";
    target.palette.forEach((c, i) => { const b = document.createElement("button"); b.className = "swatch" + (i === color ? " on" : ""); b.style.background = c; b.setAttribute("aria-label", "Colour " + (i + 1));
      // A new colour is for the next shape; it repaints a shape only when that shape was picked up with Move.
      b.onclick = () => { color = i; if (tool === "move" && selected >= 0) { if (shapes[selected].color !== i) commit(shapes.map((s, k) => k === selected ? Object.assign({}, s, { color: i }) : s)); } else selected = -1; buildControls(); render(); }; cs.appendChild(b); });
    const ts = $("tools"); ts.innerHTML = "";
    TOOLS.forEach(([k, label]) => { const b = document.createElement("button"); b.textContent = label; if (k === tool) b.className = "on";
      b.onclick = () => { tool = k; if (k !== "move") selected = -1; if (k !== "polygon") draft = []; buildControls(); render(); }; ts.appendChild(b); });
  }
  $("selbar").addEventListener("click", ev => {
    const act = ev.target.dataset.act; if (!act || selected < 0) return;
    const s = shapes[selected];
    if (act === "turnL" || act === "turnR") { let r = s.rotation + (act === "turnL" ? 15 : -15); r = ((r + 180) % 360 + 360) % 360 - 180; commit(shapes.map((x, i) => i === selected ? Object.assign({}, x, { rotation: r }) : x)); }
    if (act === "copy") { commit(shapes.concat([Object.assign({}, s, { cx: s.cx + 32, cy: s.cy + 32 })])); selected = shapes.length - 1; }
    if (act === "del") { commit(shapes.filter((_, i) => i !== selected)); selected = -1; }
    render();
  });
  $("undo").onclick = () => { if (history.length) { shapes = history.pop(); selected = -1; render(); } };
  $("ghostBtn").onclick = () => { ghost = !ghost; render(); };
  $("closePoly").onclick = () => {
    if (draft.length >= 3) {
      const l = Math.min(...draft.map(p => p.x)), r = Math.max(...draft.map(p => p.x)), t = Math.min(...draft.map(p => p.y)), b = Math.max(...draft.map(p => p.y));
      const cx = (l + r) / 2, cy = (t + b) / 2;
      commit(shapes.concat([{ kind: "polygon", color, cx, cy, w: r - l, h: b - t, rotation: 0, corner: 0, points: draft.map(p => ({ x: p.x - cx, y: p.y - cy })), sweep: 180 }]));
    }
    draft = []; render();
  };

  const COLOR_NAMES = { "rgb(28,25,22)": "black", "rgb(212,69,46)": "red", "rgb(200,136,20)": "yellow", "rgb(45,107,69)": "green", "rgb(47,95,138)": "blue", "rgb(122,74,42)": "brown", "rgb(229,143,160)": "pink", "rgb(251,248,241)": "white", "rgb(242,208,107)": "light yellow", "rgb(181,101,74)": "clay", "rgb(59,58,63)": "grey", "rgb(123,91,166)": "purple", "rgb(224,123,46)": "orange", "rgb(140,199,161)": "mint", "rgb(43,45,79)": "night blue", "rgb(239,230,214)": "cream" };
  function part(i) { const s = target.shapes[i]; return `The ${COLOR_NAMES[target.palette[s.color]] || ""} ${LK.LABEL[s.kind]}`.replace("  ", " "); }
  const WHY = { missing: "is missing", place: "is in the wrong place", big: "is too big", small: "is too small", turn: "needs turning", shape: "is the wrong shape" };

  $("done").onclick = () => {
    selected = -1; render();
    const s = LK.score(target, shapes);
    const r = $("result"); r.classList.remove("hidden");
    const store = storeLink();
    if (s.stars) {
      r.innerHTML = `<div class="card"><h2>${["", "You got it!", "Close!", "Likeness!"][s.stars]}</h2><div class="stars">${"★".repeat(s.stars)}${"☆".repeat(3 - s.stars)}</div>
        <p>Get Likensy to keep your stars, send ${esc(target.author || "your friend")} one back and start a streak.</p>
        <a class="pill red" href="${store}">Get Likensy</a><button class="pill ghost" id="again">Play again</button></div>`;
    } else {
      r.innerHTML = `<div class="card"><h2>Not yet</h2><div class="misses">${s.misses.slice(0, 4).map(m => `<div>• ${esc(part(m.target))} ${WHY[m.why]}.</div>`).join("")}</div>
        <button class="pill" id="again">Keep going</button></div>`;
    }
    $("again").onclick = () => r.classList.add("hidden");
  };
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function storeLink() {
    const ref = encodeURIComponent("c=LS1." + payload);
    return `https://play.google.com/store/apps/details?id=${PKG}&referrer=${ref}`;
  }

  // ---------- start ----------
  async function start() {
    const hash = decodeURIComponent(location.hash || location.search || "");
    try {
      target = await LK.decode(hash);
      payload = hash.slice(hash.indexOf("LS1.") + 4).match(/^[A-Za-z0-9_-]+/)[0];
    } catch (e) {
      $("app").classList.add("hidden"); $("error").classList.remove("hidden");
      if (String(e.message) === "newer") $("errmsg").textContent = "This challenge was made with a newer Likensy. Get the latest version to play it.";
      if (!hash) $("errmsg").textContent = "Open a challenge link from a friend to play.";
      return;
    }
    $("from").textContent = (target.author ? `From ${target.author}` : "From a friend") + (target.title ? ` · ${target.title}` : "");
    targetSvg.innerHTML = ""; target.shapes.forEach(s => drawShape(s, target.palette[s.color], targetSvg));
    $("get").href = storeLink();
    try { const saved = sessionStorage.getItem("lk." + payload.slice(0, 40)); if (saved) shapes = JSON.parse(saved); } catch (e) {}
    buildControls(); render();
    setInterval(() => { try { sessionStorage.setItem("lk." + payload.slice(0, 40), JSON.stringify(shapes)); } catch (e) {} }, 2000);
  }
  if (!("DecompressionStream" in window)) { $("app").classList.add("hidden"); $("error").classList.remove("hidden"); $("errmsg").textContent = "Your browser is too old to open this challenge. Get Likensy to play it."; }
  else start();
})();
