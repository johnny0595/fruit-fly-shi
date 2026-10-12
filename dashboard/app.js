/* Fly Brain Trader: data, playback, chart, nervous-system map and panels. */
const $ = (id) => document.getElementById(id);
const C = {};
for (const k of ["void", "deck", "plate", "seam", "ink", "dim", "faint", "chitin", "long", "flee", "sugar", "bitter", "loom", "leg"])
  C[k] = getComputedStyle(document.documentElement).getPropertyValue("--" + k).trim();
const NAMES = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", DOGE: "Dogecoin", XRP: "XRP", AVAX: "Avalanche", LTC: "Litecoin", ADA: "Cardano" };
const ROLE = { sugar: 1, bitter: 2, leg_sugar: 3, leg_bitter: 3, looming: 4, mn9: 5, proboscis: 5, giant_fibre: 6, ttmn: 6, mdn: 7, p9: 8 };
const ROLE_COLOR = () => ["#dfe9ff", C.sugar, C.bitter, C.leg, C.loom, C.long, C.flee, C.bitter, "#9ad1ff"];
const DUR = { escape: 3000, stonks: 2300, hold: 650, exit: 1300, retreat: 1500, idle: 520 };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const S = { sel: 0, i: 0, playing: !reduced, speed: 1, ev: "idle", t: 0, dur: 500, follow: false, lab: null };
let B, EXPS, W, role, X, Y, CLS, spikeCache = [];

function decode(b64, Type) {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Type(u.buffer);
}
const pct = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%";
const usd = (v) => "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const price = (v) => v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 3) : v.toFixed(5);
const coin = (p) => p.split("-")[0];
const when = (iso, full) => new Date(iso).toLocaleString("en-US", full ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" } : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const fly = () => W.flies[S.sel];
const cs = () => fly().candles;

/* ---------- load ---------- */
async function getJSON(url) { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(url); return r.json(); }
(async function boot() {
  try {
    const brain = await getJSON("brain.json");
    B = brain.brain; EXPS = brain.experiments;
    let live = null;
    try { live = await getJSON("live.json"); } catch {}
    W = live && live.flies?.[0]?.candles?.length > 1 ? live : await getJSON("swarm.json");
  } catch (e) {
    $("loading").textContent = "No data yet. Run `uv run flybrain export`, then reload.";
    return;
  }
  X = decode(B.x, Uint16Array); Y = decode(B.y, Uint16Array); CLS = decode(B.cls, Uint8Array);
  role = new Uint8Array(B.n);
  for (const [g, ids] of Object.entries(B.groups)) for (const i of ids) role[i] = Math.max(role[i], ROLE[g] || 0);
  decodeSpikes();
  S.follow = W.live;
  S.i = W.live ? Math.max(1, cs().length - 48) : firstInteresting(); // live: play the last 4 h, then follow
  S.stage = new FlyStage($("gl"), chartCv);
  $("loading").hidden = true;
  buildStatic();
  enter(S.i);
  requestAnimationFrame(loop);
  if (W.live) setInterval(poll, 20000);
})();

function decodeSpikes() {
  spikeCache = W.flies.map((f) => ({ from: f.spikes.from, idx: decode(f.spikes.idx, Uint32Array), cnt: decode(f.spikes.cnt, Uint8Array), off: decode(f.spikes.off, Uint32Array) }));
}
function firstInteresting() {
  const c = cs(); const k = c.findIndex((x, i) => i > 0 && x.action === "FEED" && c[i - 1].pos === 0);
  return Math.max(1, k - 3);
}
async function poll() {
  try {
    const next = await getJSON("live.json");
    if (next.updated === W.updated) return;
    const atEnd = S.i >= cs().length - 1;
    W = next; decodeSpikes();
    buildSwarm(); buildTrades(); drawTrack();
    if (S.follow && atEnd) enter(Math.min(S.i + 1, cs().length - 1));
    else S.i = Math.min(S.i, cs().length - 1);
    status();
  } catch {}
}

/* ---------- events ---------- */
function eventAt(i, f = S.sel) {
  const c = W.flies[f].candles, x = c[i], pv = c[i - 1];
  if (x.action === "ESCAPE") return "escape";
  if (x.action === "FEED") return !pv || pv.pos === 0 ? "stonks" : "hold";
  if (x.action === "RETREAT") return "retreat";
  return pv && pv.pos > 0 ? "exit" : "idle";
}
function enter(i) {
  S.i = i; S.ev = eventAt(i); S.dur = DUR[S.ev]; S.t = 0;
  const c = cs()[i];
  drawChart(); S.stage?.chartChanged();
  updateOverlay(); updateSwarm(); updateTrace(); drawEquity(); drawTrack(); status();
  if (S.ev === "stonks") cash(c.pos);
  if (S.ev === "stonks" || S.ev === "escape" || S.ev === "exit" || S.ev === "retreat") meme(S.ev);
  else $("meme").hidden = true;
}
function advance() {
  const n = cs().length;
  if (S.i < n - 1) return enter(S.i + 1);
  if (W.live) { S.ev = cs()[S.i].pos > 0 ? "hold" : "idle"; S.t = 0; S.dur = DUR[S.ev]; $("meme").hidden = true; return; }
  enter(1);
}

/* ---------- main loop ---------- */
let last = performance.now();
function loop(now) {
  const dt = Math.min(60, now - last); last = now;
  if (S.playing) { S.t += dt * S.speed; if (S.t >= S.dur) advance(); }
  const p = Math.min(1, S.t / S.dur), c = cs()[S.i];
  S.stage.frame(dt, S.ev, p, { pos: c.pos, groom: S.i % 5 < 3 });
  if (S.ev === "escape") {
    const m = $("meme");
    if (p > 0.24 && m.hidden) meme("escape", true);
    if (p < 0.24) m.hidden = true;
    $("sub").textContent = sub(c, p);
  }
  if ((S.ev === "stonks" || S.ev === "exit" || S.ev === "retreat") && p > 0.8) $("meme").hidden = true;
  drawCNS(dt);
  requestAnimationFrame(loop);
}

/* ---------- stage overlay ---------- */
function sub(c, p) {
  const o = c.out, pos = Math.round(c.pos * 100);
  return {
    idle: S.i % 5 < 3 ? "No signal. Grooming." : "Watching the chart.",
    stonks: `Price up → sugar → MN9 ${o.mn9.toFixed(0)} Hz → BUY ${pos}%`,
    hold: `Still eating · MN9 ${o.mn9.toFixed(0)} Hz · ${pos}% long`,
    exit: "Sugar gone · MN9 quiet · sold",
    escape: p < 0.28 ? `Crash looming → Giant Fibre ${o.giant_fibre.toFixed(0)} Hz` : o.ttmn > 0 ? `TTMn jump muscle ${o.ttmn.toFixed(0)} Hz → SELL EVERYTHING` : "Escape command → SELL EVERYTHING",
    retreat: "MDN fires → walks backwards → cuts the position",
  }[S.ev];
}
function updateOverlay() {
  const f = fly(), c = cs()[S.i], pv = cs()[S.i - 1] || c, sym = coin(f.product);
  $("caption").innerHTML = `This fly trades ${NAMES[sym] || sym}<small>${B.n.toLocaleString()} real neurons · brain + nerve cord · paper money</small>`;
  const ch = c.c / pv.c - 1;
  $("hudL").innerHTML = `<span>${f.product} · ${W.granularity >= 3600 ? W.granularity / 3600 + "h" : W.granularity / 60 + "m"}</span><b>$${price(c.c)}</b><span class="${ch >= 0 ? "up" : "down"}">${pct(ch, 2)}</span>`;
  const eq = W.start_cash * c.eq;
  $("hudR").innerHTML = `<span>fly account</span><b class="${c.eq >= 1 ? "up" : "down"}">${usd(eq)}</b><span>hodl ${usd(W.start_cash * c.hodl)}</span>`;
  const o = c.out, chip = (label, v, col) => `<span class="chip ${v > 0 ? "on" : ""}" style="--c:${col}">${label} ${v.toFixed(0)}${typeof v === "number" && label !== "NEURONS" ? " Hz" : ""}</span>`;
  $("chips").innerHTML = chip("MN9", o.mn9, C.long) + chip("GIANT FIBRE", o.giant_fibre, C.flee) + chip("TTMn", o.ttmn, C.flee) + chip("MDN", o.mdn, C.bitter) +
    `<span class="chip on" style="--c:${C.chitin}">${o.active.toLocaleString()} SPIKING</span>`;
  $("sub").textContent = sub(c, 0);
  $("when").textContent = when(c.t, true) + " UTC";
}
function meme(ev, force) {
  const m = $("meme");
  if (ev === "escape" && !force) { m.hidden = true; return; }
  const cfg = {
    stonks: ["STONKS", C.long, "M-120 70 L-60 25 L-20 48 L45 -10 L80 8 L150 -70", -6],
    escape: ["NOT STONKS", C.flee, "M-150 -60 L-80 -10 L-40 -30 L30 30 L70 10 L150 80", 5],
    exit: ["SOLD", "#c7cfdb", "", 0],
    retreat: ["BACKING OFF", C.bitter, "", 3],
  }[ev];
  const [text, col, path, rot] = cfg;
  const head = path ? path.split(" ").slice(-2) : null;
  m.innerHTML = (path ? `<svg viewBox="-200 -110 400 220" aria-hidden="true"><path d="${path}" fill="none" stroke="#000" stroke-width="30" stroke-linejoin="miter"/><path d="${path}" fill="none" stroke="${col}" stroke-width="18" stroke-linejoin="miter"/><circle cx="${head[0].slice(1)}" cy="${head[1]}" r="22" fill="${col}" stroke="#000" stroke-width="6"/></svg>` : "") +
    `<b style="transform:rotate(${rot}deg)">${text}</b>`;
  m.hidden = false; m.classList.remove("pop"); void m.offsetWidth; if (!reduced) m.classList.add("pop");
}
function cash(pos) {
  if (reduced) return;
  const layer = $("cashLayer"), stage = $("stage");
  for (let k = 0; k < 6 + pos * 10; k++) {
    const d = document.createElement("span");
    d.className = "cash"; d.textContent = "$";
    d.style.left = 52 + (Math.random() - 0.4) * 22 + "%"; d.style.top = 62 + Math.random() * 10 + "%";
    d.style.setProperty("--r", (Math.random() - 0.5) * 60 + "deg"); d.style.animationDelay = Math.random() * 0.5 + "s";
    layer.appendChild(d); setTimeout(() => d.remove(), 2200);
  }
}

/* ---------- the trading screen (texture on the 3D monitor) ---------- */
const chartCv = document.createElement("canvas"); chartCv.width = 1600; chartCv.height = 900;
function drawChart() {
  const g = chartCv.getContext("2d"), f = fly(), c = cs(), i = S.i, N = 64;
  const s = Math.max(0, i - N + 1), win = c.slice(s, i + 1);
  const L = 40, R = 1440, top = 92, bot = 600, itop = 650, ibot = 860;
  const bw = (R - L) / N, x = (j) => R - (i - j + 0.5) * bw;  // newest candle at the right edge
  g.fillStyle = "#070a10"; g.fillRect(0, 0, 1600, 900);
  // header
  g.fillStyle = "#e9edf3"; g.font = "800 40px 'Bricolage Grotesque', sans-serif"; g.textAlign = "left";
  g.fillText(`${f.product}`, L, 58);
  g.font = "500 22px 'IBM Plex Mono', monospace"; g.fillStyle = "#8b95a7";
  g.fillText(`${W.granularity >= 3600 ? W.granularity / 3600 + "H" : W.granularity / 60 + "M"} · FLY #${S.sel + 1} · BANC CNS`, L + g.measureText(f.product).width * 1.9 + 30, 56);
  const cur = c[i], ch = cur.c / c[Math.max(0, i - 1)].c - 1;
  g.textAlign = "right"; g.font = "600 40px 'IBM Plex Mono', monospace"; g.fillStyle = ch >= 0 ? C.long : C.flee;
  g.fillText(`$${price(cur.c)}  ${pct(ch, 2)}`, 1570, 58);
  // scale
  let lo = Math.min(...win.map((k) => k.l)), hi = Math.max(...win.map((k) => k.h)); const pad = (hi - lo) * 0.08 || hi * 0.01; lo -= pad; hi += pad;
  const y = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
  const step = niceStep((hi - lo) / 6);
  g.font = "500 20px 'IBM Plex Mono', monospace"; g.textAlign = "left";
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    g.strokeStyle = "#141b27"; g.lineWidth = 1; g.beginPath(); g.moveTo(L, y(v)); g.lineTo(R, y(v)); g.stroke();
    g.fillStyle = "#566174"; g.fillText(price(v), R + 14, y(v) + 7);
  }
  // position held during each candle
  for (let j = s + 1; j <= i; j++) {
    const p = c[j - 1].pos; if (p <= 0) continue;
    g.fillStyle = `rgba(57,217,138,${0.05 + p * 0.13})`; g.fillRect(x(j) - bw / 2, top, bw, bot - top);
  }
  // volume
  const vmax = Math.max(...win.map((k) => k.v)) || 1;
  for (let j = s; j <= i; j++) { const k = c[j]; g.fillStyle = k.c >= k.o ? "rgba(38,194,129,.18)" : "rgba(240,82,74,.18)"; const h = (k.v / vmax) * 90; g.fillRect(x(j) - bw * 0.35, bot - h, bw * 0.7, h); }
  // candles
  for (let j = s; j <= i; j++) {
    const k = c[j], up = k.c >= k.o, col = up ? "#26c281" : "#f0524a";
    g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(x(j), y(k.h)); g.lineTo(x(j), y(k.l)); g.stroke();
    g.fillStyle = col; const yt = y(Math.max(k.o, k.c)), yb = y(Math.min(k.o, k.c));
    g.fillRect(x(j) - bw * 0.33, yt, bw * 0.66, Math.max(2, yb - yt));
    if (j === i) { g.strokeStyle = "#fff"; g.lineWidth = 2; g.strokeRect(x(j) - bw * 0.45, y(k.h) - 6, bw * 0.9, y(k.l) - y(k.h) + 12); }
  }
  // the fly's decisions
  g.textAlign = "center"; g.font = "700 18px 'IBM Plex Mono', monospace";
  for (let j = Math.max(1, s); j <= i; j++) {
    const k = c[j], pv = c[j - 1];
    if (k.action === "FEED" && pv.pos === 0) { tri(g, x(j), y(k.l) + 16, 1, C.long); g.fillStyle = C.long; g.fillText(`BUY ${Math.round(k.pos * 100)}%`, x(j), y(k.l) + 52); }
    if (k.action === "ESCAPE") { g.strokeStyle = C.flee; g.lineWidth = 4; const cx = x(j), cy = y(k.h) - 20; g.beginPath(); g.moveTo(cx - 9, cy - 9); g.lineTo(cx + 9, cy + 9); g.moveTo(cx + 9, cy - 9); g.lineTo(cx - 9, cy + 9); g.stroke(); g.fillStyle = C.flee; g.fillText("FLEE", cx, cy - 18); }
    if (k.action === "RETREAT" && pv.pos > 0) { tri(g, x(j), y(k.h) - 16, -1, C.bitter); }
  }
  // last price line
  g.setLineDash([8, 8]); g.strokeStyle = "rgba(233,237,243,.55)"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(L, y(cur.c)); g.lineTo(R, y(cur.c)); g.stroke(); g.setLineDash([]);
  g.fillStyle = ch >= 0 ? "#26c281" : "#f0524a"; g.fillRect(R + 4, y(cur.c) - 17, 152, 34);
  g.fillStyle = "#05070b"; g.font = "700 20px 'IBM Plex Mono', monospace"; g.textAlign = "left"; g.fillText(price(cur.c), R + 12, y(cur.c) + 7);
  // time axis
  g.fillStyle = "#566174"; g.font = "500 18px 'IBM Plex Mono', monospace"; g.textAlign = "center";
  for (let j = s; j <= i; j += 12) g.fillText(when(c[j].t, j === s), x(j), bot + 26);
  // neural indicator pane: the chart only a fly has
  g.fillStyle = "#0b1018"; g.fillRect(L, itop, R - L, ibot - itop);
  g.textAlign = "left"; g.font = "600 18px 'IBM Plex Mono', monospace";
  g.fillStyle = C.long; g.fillText("MN9 feeding Hz", L + 10, itop + 24);
  g.fillStyle = C.flee; g.fillText("Giant Fibre escape", L + 210, itop + 24);
  g.fillStyle = "#566174"; g.fillText("← motor neurons of the fly's own CNS", L + 440, itop + 24);
  const mid = itop + (ibot - itop) * 0.62;
  g.strokeStyle = "#1d2533"; g.beginPath(); g.moveTo(L, mid); g.lineTo(R, mid); g.stroke();
  for (let j = s; j <= i; j++) {
    const o = c[j].out, hM = Math.min(1, o.mn9 / 60) * (mid - itop - 40), hG = Math.min(1, o.giant_fibre / 200) * (ibot - mid - 8);
    g.fillStyle = C.long; g.fillRect(x(j) - bw * 0.3, mid - hM, bw * 0.6, hM);
    g.fillStyle = C.flee; g.fillRect(x(j) - bw * 0.3, mid, bw * 0.6, hG);
  }
  g.font = "800 120px 'Bricolage Grotesque', sans-serif"; g.fillStyle = "rgba(255,255,255,.025)"; g.textAlign = "center";
  g.fillText(coin(f.product), (L + R) / 2, (top + bot) / 2 + 40);
}
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p; return 10 * p; }
function tri(g, x, y, dir, col) { g.fillStyle = col; g.beginPath(); g.moveTo(x, y - 12 * dir); g.lineTo(x - 11, y + 8 * dir); g.lineTo(x + 11, y + 8 * dir); g.closePath(); g.fill(); }

/* ---------- central nervous system map ---------- */
let cnsBase = null, cnsBox = null;
function sizeCNS() {
  const cv = $("cns"), dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const Wc = cv.width, Hc = cv.height, pad = 0.05;
  const s = Math.min((Wc * (1 - 2 * pad)) / B.width, (Hc * (1 - 2 * pad)) / B.height);
  cnsBox = { s, ox: (Wc - B.width * s) / 2, oy: (Hc - B.height * s) / 2, dpr };
  const counts = new Uint16Array(Wc * Hc), tint = new Uint8Array(Wc * Hc);
  for (let i = 0; i < B.n; i++) {
    if (X[i] === 65535) continue;
    const px = cx(i) | 0, py = cy(i) | 0;
    if (px < 0 || py < 0 || px >= Wc || py >= Hc) continue;
    counts[py * Wc + px]++; tint[py * Wc + px] = CLS[i];
  }
  const vnc = B.classes.indexOf("ventral_nerve_cord_intrinsic"), optic = B.classes.indexOf("optic_lobe_intrinsic");
  const img = new ImageData(Wc, Hc), d = img.data;
  for (let p = 0; p < counts.length; p++) {
    const n = counts[p]; if (!n) continue;
    const a = Math.min(1, 0.2 + Math.log1p(n) / 3), t = tint[p];
    const [r, gg, b] = t === vnc ? [58, 118, 128] : t === optic ? [62, 80, 118] : [84, 104, 150];
    d[p * 4] = r; d[p * 4 + 1] = gg; d[p * 4 + 2] = b; d[p * 4 + 3] = a * 170;
  }
  cnsBase = document.createElement("canvas"); cnsBase.width = Wc; cnsBase.height = Hc;
  cnsBase.getContext("2d").putImageData(img, 0, 0);
  labels = makeLabels();
}
const cx = (i) => cnsBox.ox + (X[i] / 65000) * cnsBox.s;
const cy = (i) => cnsBox.oy + (Y[i] / 65000) * cnsBox.s;
let labels = [];
function makeLabels() {
  const defs = [
    ["sugar", "Sugar taste", C.sugar, "in"], ["bitter", "Bitter taste", C.bitter, "in"], ["leg_sugar", "Leg taste", C.leg, "in"],
    ["looming", "Looming (LC4/LPLC2)", C.loom, "in"], ["mn9", "MN9 · feed", C.long, "out"], ["giant_fibre", "Giant Fibre", C.flee, "out"],
    ["ttmn", "TTMn · jump muscle", C.flee, "out"], ["mdn", "MDN · back up", C.bitter, "out"],
  ];
  const out = defs.map(([k, name, col, side]) => {
    const ids = (B.groups[k] || []).filter((i) => X[i] !== 65535);
    if (!ids.length) return null;
    let sx = 0, sy = 0; for (const i of ids) { sx += cx(i); sy += cy(i); }
    return { k, name, col, side, ids, x: sx / ids.length, y: sy / ids.length };
  }).filter(Boolean);
  for (const side of ["in", "out"]) {
    const L = out.filter((l) => l.side === side).sort((a, b) => a.y - b.y);
    let prev = -1e9; const gap = 30 * cnsBox.dpr;
    for (const l of L) { l.ly = Math.max(l.y, prev + gap); prev = l.ly; }
  }
  return out;
}
let cnsAcc = 0;
function drawCNS(dt) {
  const cv = $("cns");
  if (!cnsBase || cv.width !== Math.round(cv.clientWidth * Math.min(devicePixelRatio || 1, 2))) sizeCNS();
  if (!cnsBase) return;
  cnsAcc += dt; if (cnsAcc < 33) return; cnsAcc = 0; // ~30 fps is plenty
  const g = cv.getContext("2d"), dpr = cnsBox.dpr, colors = ROLE_COLOR();
  g.globalCompositeOperation = "source-over"; g.fillStyle = "#070a10"; g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(cnsBase, 0, 0);
  g.globalCompositeOperation = "lighter";
  const firing = {};
  if (S.lab) {
    const e = S.lab, tEnd = e.t, s1 = Math.round(tEnd / e.dt), s0 = Math.round((tEnd - 6) / e.dt);
    let lo = 0, hi = e.steps.length; while (lo < hi) { const m = (lo + hi) >> 1; e.steps[m] < s0 ? (lo = m + 1) : (hi = m); }
    for (let j = lo; j < e.steps.length && e.steps[j] <= s1; j++) {
      const i = e.neurons[j], a = 1 - (s1 - e.steps[j]) * e.dt / 6; dot(g, i, a, colors, dpr); firing[role[i]] = 1;
    }
    $("cnsInfo").textContent = `${e.name} · t = ${tEnd.toFixed(1)} ms`;
  } else {
    const sp = spikeCache[S.sel], j = S.i - sp.from;
    if (j >= 0 && j < sp.off.length - 1) {
      for (let k = sp.off[j]; k < sp.off[j + 1]; k++) {
        const n = sp.cnt[k]; if (Math.random() > Math.min(1, 0.15 + n / 12)) continue;
        const i = sp.idx[k]; dot(g, i, Math.min(1, 0.4 + Math.log1p(n) / 3), colors, dpr); if (role[i]) firing[role[i]] = 1;
      }
    }
    $("cnsInfo").textContent = `${coin(fly().product)} fly · ${cs()[S.i].out.active.toLocaleString()} spiking`;
  }
  g.globalCompositeOperation = "source-over";
  g.font = `600 ${11 * dpr}px 'IBM Plex Mono', monospace`; g.textBaseline = "middle";
  for (const l of labels) {
    const on = firing[ROLE[l.k]], lx = l.side === "in" ? 10 * dpr : cv.width - 10 * dpr;
    g.globalAlpha = on ? 1 : 0.45;
    g.strokeStyle = l.col; g.lineWidth = dpr; g.beginPath(); g.moveTo(l.x, l.y);
    g.lineTo(l.side === "in" ? lx + g.measureText(l.name).width + 6 * dpr : lx - g.measureText(l.name).width - 6 * dpr, l.ly); g.stroke();
    g.fillStyle = l.col; g.beginPath(); g.arc(l.x, l.y, (on ? 4 : 2.5) * dpr, 0, 7); g.fill();
    g.textAlign = l.side === "in" ? "left" : "right"; g.fillText(l.name, lx, l.ly);
  }
  g.globalAlpha = 1;
}
function dot(g, i, a, colors, dpr) {
  if (X[i] === 65535) return;
  const r = role[i], s = (r ? 2.6 : 1.8) * dpr;
  g.globalAlpha = a; g.fillStyle = colors[r]; g.fillRect(cx(i) - s / 2, cy(i) - s / 2, s, s);
}

/* ---------- swarm tiles ---------- */
function buildStatic() {
  const totalN = B.n * W.flies.length;
  $("tagline").innerHTML = `${W.flies.length} fruit-fly nervous systems · <b>${B.n.toLocaleString()}</b> neurons and <b>${(B.n_edges / 1e6).toFixed(1)}M</b> connections each (BANC brain + nerve cord) · paper trading · nothing trained`;
  $("activeOf").textContent = `of ${B.n.toLocaleString()} neurons`;
  buildSwarm(); buildTrades(); buildLab(); buildModel();
  $("play").onclick = () => { S.playing = !S.playing; $("play").textContent = S.playing ? "Pause" : "Play"; };
  $("play").textContent = S.playing ? "Pause" : "Play";
  $("speed").onchange = (e) => (S.speed = +e.target.value);
  $("next").onclick = () => { const c = cs(); for (let j = S.i + 1; j < c.length; j++) if (["stonks", "escape"].includes(eventAt(j))) { S.follow = false; return enter(j); } };
  $("liveBtn").hidden = !W.live; $("liveBtn").onclick = () => { S.follow = true; enter(cs().length - 1); };
  const track = $("track");
  const seek = (ev) => { const r = track.getBoundingClientRect(); const k = Math.round(((ev.clientX - r.left) / r.width) * (cs().length - 1)); S.follow = false; enter(Math.max(1, Math.min(cs().length - 1, k))); };
  track.onpointerdown = (ev) => { seek(ev); track.setPointerCapture(ev.pointerId); };
  track.onpointermove = (ev) => { if (ev.buttons) seek(ev); };
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
    document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
    if (b.dataset.tab !== "lab") stopLab();
  }));
  addEventListener("resize", () => { cnsBase = null; drawEquity(); drawTrack(); });
}
function buildSwarm() {
  $("swarm").innerHTML = W.flies.map((f, k) => `
    <button class="fly" data-k="${k}" aria-pressed="${k === S.sel}">
      <span class="row"><span class="sym">${coin(f.product)}</span><span class="act" data-act></span></span>
      <canvas data-spark></canvas>
      <span class="row"><span class="pnl" data-pnl></span><span class="vs" data-vs></span></span>
      <span class="meter"><i data-meter></i></span>
    </button>`).join("");
  $("swarm").querySelectorAll(".fly").forEach((b) => (b.onclick = () => { S.sel = +b.dataset.k; $("swarm").querySelectorAll(".fly").forEach((x) => x.setAttribute("aria-pressed", x === b)); cnsBase = cnsBase; enter(S.i); }));
  updateSwarm();
}
function updateSwarm() {
  $("swarm").querySelectorAll(".fly").forEach((b) => {
    const f = W.flies[+b.dataset.k], c = f.candles[S.i]; if (!c) return;
    const act = b.querySelector("[data-act]"); act.textContent = c.action === "idle" ? "IDLE" : c.action; act.className = "act " + c.action;
    const pnl = c.eq - 1; b.querySelector("[data-pnl]").textContent = pct(pnl); b.querySelector("[data-pnl]").className = "pnl " + (pnl >= 0 ? "up" : "down");
    b.querySelector("[data-vs]").textContent = `hodl ${pct(c.hodl - 1)}`;
    b.querySelector("[data-meter]").style.width = c.pos * 100 + "%";
    spark(b.querySelector("[data-spark]"), f.candles, S.i);
  });
}
function spark(cv, c, i) {
  const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth * dpr, h = cv.clientHeight * dpr; if (!w) return;
  cv.width = w; cv.height = h; const g = cv.getContext("2d");
  const s = Math.max(0, i - 40), win = c.slice(s, i + 1);
  const lo = Math.min(...win.map((k) => k.l)), hi = Math.max(...win.map((k) => k.h)), y = (v) => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4), bw = w / 41;
  win.forEach((k, j) => {
    if (j && win[j - 1].pos > 0) { g.fillStyle = "rgba(57,217,138,.16)"; g.fillRect(j * bw, 0, bw, h); }
    g.fillStyle = k.c >= k.o ? "#26c281" : "#f0524a";
    g.fillRect(j * bw + bw * 0.45, y(k.h), Math.max(1, bw * 0.1), y(k.l) - y(k.h));
    g.fillRect(j * bw + bw * 0.15, y(Math.max(k.o, k.c)), bw * 0.7, Math.max(1, y(Math.min(k.o, k.c)) - y(Math.max(k.o, k.c))));
    if (k.action === "ESCAPE") { g.fillStyle = C.flee; g.beginPath(); g.arc(j * bw + bw / 2, 4 * dpr, 2.2 * dpr, 0, 7); g.fill(); }
  });
}

/* ---------- top status ---------- */
function status() {
  const tot = W.flies.reduce((a, f) => a + W.start_cash * (f.candles[S.i]?.eq ?? 1), 0);
  const hodl = W.flies.reduce((a, f) => a + W.start_cash * (f.candles[S.i]?.hodl ?? 1), 0);
  const start = W.start_cash * W.flies.length;
  const pill = W.live ? `<span class="pill live"><i></i>LIVE · since ${when(W.started, true)}</span>` : `<span class="pill">REPLAY · BACKTEST</span>`;
  $("status").innerHTML = pill + [
    ["Swarm", usd(tot), tot >= start ? "up" : "down"], ["vs buy & hold", usd(hodl), hodl >= start ? "up" : "down"],
    ["Flies", W.flies.length, ""], ["Neurons", (B.n * W.flies.length).toLocaleString(), ""],
  ].map(([k, v, c]) => `<div class="kpi"><span>${k}</span><b class="${c}">${v}</b></div>`).join("");
}

/* ---------- decision trace ---------- */
const SENSES = [["sugar", "Sugar taste", "labellum · 3-candle momentum up", C.sugar, 200], ["bitter", "Bitter taste", "labellum · momentum down", C.bitter, 200],
  ["leg_sugar", "Sweet ground", "legs · 24-candle trend up", C.leg, 150], ["leg_bitter", "Bitter ground", "legs · trend down", C.leg, 150], ["looming", "Looming", "LC4/LPLC2 · crash candle", C.loom, 150]];
const MOTOR = [["mn9", "MN9", "proboscis motor neuron · feed", C.long, 60], ["proboscis", "Proboscis pool", "35 motor neurons", C.long, 20],
  ["giant_fibre", "Giant Fibre", "DNp01 · escape command", C.flee, 200], ["ttmn", "TTMn", "jump muscle · nerve cord", C.flee, 30], ["mdn", "MDN", "moonwalker · walk backwards", C.bitter, 40]];
function updateTrace() {
  const c = cs()[S.i];
  const row = ([k, n, d, col, max], v) => `<div class="sig" style="--c:${col}"><span class="n">${n}<small>${d}</small></span><span class="v" style="color:${v > 0 ? col : C.faint}">${v.toFixed(0)} Hz</span><span class="b"><i style="width:${Math.min(100, (v / max) * 100)}%"></i></span></div>`;
  $("senses").innerHTML = SENSES.map((s) => row(s, c.in[s[0]])).join("");
  $("motor").innerHTML = MOTOR.map((m) => row(m, c.out[m[0]])).join("");
  $("active").textContent = c.out.active.toLocaleString();
  $("dnActive").textContent = `${c.out.dn_active} descending · ${c.out.motor_active} motor`;
  $("traceWhen").textContent = `${coin(fly().product)} · ${when(c.t, true)} UTC · momentum ${c.mz >= 0 ? "+" : ""}${(c.mz ?? 0).toFixed(2)}σ · trend ${(c.tz ?? 0) >= 0 ? "+" : ""}${(c.tz ?? 0).toFixed(2)}σ`;
  const col = c.action === "FEED" ? C.long : c.action === "ESCAPE" ? C.flee : c.action === "RETREAT" ? C.bitter : C.dim;
  const say = { FEED: `Hold ${Math.round(c.pos * 100)}% of the account in ${coin(fly().product)}`, ESCAPE: "Sell everything, sit in cash", RETREAT: "Cut the position", idle: "Stay in cash" }[c.action];
  $("verdict").innerHTML = `<b style="color:${col}">${c.action === "idle" ? "IDLE" : c.action}</b><span>${say} for the next ${W.granularity >= 3600 ? W.granularity / 3600 + " hour" : W.granularity / 60 + " minutes"}</span>`;
}

/* ---------- equity ---------- */
function drawEquity() {
  const cv = $("equity"), dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth * dpr, h = cv.clientHeight * dpr; if (!w) return;
  cv.width = w; cv.height = h; const g = cv.getContext("2d");
  const c = cs(), n = c.length;
  const swarm = c.map((_, j) => W.flies.reduce((a, f) => a + (f.candles[j]?.eq ?? 1), 0) / W.flies.length);
  const series = [[c.map((k) => k.hodl), C.faint, [5, 4], "hodl"], [swarm, C.chitin, [], "swarm"], [c.map((k) => k.eq), C.long, [], coin(fly().product) + " fly"]];
  const all = series.flatMap((s) => s[0]); let lo = Math.min(...all), hi = Math.max(...all); const pad = (hi - lo) * 0.08 || 0.01; lo -= pad; hi += pad;
  const L = 46 * dpr, R = w - 104 * dpr, T = 8 * dpr, Bm = h - 20 * dpr;
  const x = (j) => L + (j / (n - 1)) * (R - L), y = (v) => Bm - ((v - lo) / (hi - lo)) * (Bm - T);
  g.font = `500 ${10.5 * dpr}px 'IBM Plex Mono', monospace`; g.fillStyle = C.faint; g.textAlign = "right";
  for (let k = 0; k <= 3; k++) { const v = lo + ((hi - lo) * k) / 3; g.strokeStyle = C.seam; g.beginPath(); g.moveTo(L, y(v)); g.lineTo(R, y(v)); g.stroke(); g.fillText(pct(v - 1, 0), L - 6 * dpr, y(v) + 4 * dpr); }
  g.strokeStyle = "rgba(233,237,243,.25)"; g.beginPath(); g.moveTo(L, y(1)); g.lineTo(R, y(1)); g.stroke();
  g.textAlign = "center"; for (const k of [0, Math.floor(n / 2), n - 1]) g.fillText(when(c[k].t, true).split(",")[0], x(k), h - 5 * dpr);
  for (const [v, col, dash] of series) {
    g.setLineDash(dash.map((d) => d * dpr)); g.strokeStyle = col; g.lineWidth = 1.8 * dpr; g.beginPath();
    v.forEach((p, j) => (j ? g.lineTo(x(j), y(p)) : g.moveTo(x(j), y(p)))); g.stroke(); g.setLineDash([]);
  }
  // end labels, nudged apart so they never overlap
  const tags = series.map(([v, col, , name]) => ({ y: y(v[n - 1]), col, text: `${name} ${pct(v[n - 1] - 1)}` })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < tags.length; k++) tags[k].y = Math.max(tags[k].y, tags[k - 1].y + 13 * dpr);
  g.textAlign = "left";
  for (const t of tags) { g.fillStyle = t.col; g.fillText(t.text, R + 6 * dpr, t.y + 4 * dpr); }
  g.strokeStyle = C.ink; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(x(S.i), T); g.lineTo(x(S.i), Bm); g.stroke(); g.globalAlpha = 1;
  g.fillStyle = C.long; g.beginPath(); g.arc(x(S.i), y(c[S.i].eq), 3.5 * dpr, 0, 7); g.fill();
  const sm = fly().summary;
  $("eqInfo").textContent = `${coin(fly().product)} fly ${pct(sm.fly_return)} · hodl ${pct(sm.hodl_return)} · max drawdown ${pct(sm.fly_max_drawdown)}`;
}

/* ---------- scrubber ---------- */
function drawTrack() {
  const cv = $("trackCv"), dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth * dpr, h = cv.clientHeight * dpr; if (!w) return;
  cv.width = w; cv.height = h; const g = cv.getContext("2d"), c = cs(), n = c.length, x = (j) => (j / (n - 1)) * w;
  g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(0, h / 2 - 2 * dpr, w, 4 * dpr);
  g.fillStyle = C.chitin; g.fillRect(0, h / 2 - 2 * dpr, x(S.i), 4 * dpr);
  for (let j = 1; j < n; j++) {
    if (c[j].action === "ESCAPE") { g.fillStyle = C.flee; g.fillRect(x(j) - dpr, 2 * dpr, 2 * dpr, h / 2 - 5 * dpr); }
    else if (c[j].action === "FEED" && c[j - 1].pos === 0) { g.fillStyle = C.long; g.fillRect(x(j) - dpr, h / 2 + 3 * dpr, 2 * dpr, h / 2 - 5 * dpr); }
  }
  g.fillStyle = "#fff"; g.beginPath(); g.arc(x(S.i), h / 2, 5 * dpr, 0, 7); g.fill();
}

/* ---------- trades ---------- */
function buildTrades() {
  const rows = W.flies.flatMap((f, k) => f.trades.map((t) => ({ ...t, k, sym: coin(f.product) }))).sort((a, b) => b.entry.localeCompare(a.entry));
  $("trades").innerHTML = rows.map((t) => `<tr tabindex="0" data-k="${t.k}" data-t="${t.entry}">
    <td>${t.sym}</td><td>${when(t.entry, true)}</td><td>${t.exit ? when(t.exit, true) : "open"}</td><td>${t.candles}</td><td>${Math.round(t.max_pos * 100)}%</td>
    <td>${price(t.entry_price)}</td><td>${price(t.exit_price)}</td>
    <td><span class="tag ${t.reason}">${t.reason === "ESCAPE" ? "escape" : t.reason === "open" ? "still open" : t.reason === "RETREAT" ? "backed off" : "MN9 quiet"}</span></td>
    <td class="${t.ret >= 0 ? "up" : "down"}">${pct(t.ret, 2)}</td></tr>`).join("") || `<tr><td colspan="9" style="text-align:left;color:var(--dim)">No trades yet. The flies are watching.</td></tr>`;
  $("trades").querySelectorAll("tr[data-k]").forEach((tr) => {
    const go = () => { S.sel = +tr.dataset.k; S.follow = false; buildSwarm(); enter(Math.max(1, W.flies[S.sel].candles.findIndex((c) => c.t === tr.dataset.t))); $("stage").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" }); };
    tr.onclick = go; tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
  });
}

/* ---------- lab ---------- */
let labTimer = null;
function buildLab() {
  $("exps").innerHTML = EXPS.map((e, k) => `<button class="exp" data-k="${k}" aria-pressed="false"><b>${e.name}</b>
    <span>MN9 ${e.hz.mn9.toFixed(0)} · GF ${e.hz.giant_fibre.toFixed(0)} · TTMn ${e.hz.ttmn.toFixed(0)} Hz</span><span>${e.active.toLocaleString()} neurons fired</span></button>`).join("");
  $("exps").querySelectorAll(".exp").forEach((b) => (b.onclick = () => playLab(+b.dataset.k)));
  $("expNote").textContent = "Pick an experiment to replay every spike on the nervous-system map at 1/40 speed. These are the checks that the circuits behave like a real fly before the swarm is allowed to trade.";
}
function playLab(k) {
  const e = EXPS[k];
  S.lab = { name: e.name, dt: e.dt, t: 0, steps: decode(e.steps, Uint16Array), neurons: decode(e.neurons, Uint32Array) };
  $("exps").querySelectorAll(".exp").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.k === k));
  $("expNote").textContent = `${e.desc} ${e.spikes.toLocaleString()} spikes across ${e.active.toLocaleString()} neurons in ${e.ms} ms.`;
  clearInterval(labTimer);
  labTimer = setInterval(() => { if (!S.lab) return; S.lab.t += 0.4; if (S.lab.t > e.ms) S.lab.t = 0; }, 16);
  $("cns").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
}
function stopLab() { S.lab = null; clearInterval(labTimer); $("exps")?.querySelectorAll(".exp").forEach((b) => b.setAttribute("aria-pressed", "false")); }

function buildModel() {
  $("model").innerHTML = `
    <h4>What is real</h4>
    <p>The wiring. Each fly is the <b>BANC</b> connectome (Bates et al., Nature 2026): one female fly's entire central nervous system, brain and ventral nerve cord, reconstructed from electron microscopy. That is <b>${B.n.toLocaleString()} neurons</b> and <b>${(B.n_edges / 1e6).toFixed(1)} million connections</b> with their synapse counts. Every sensory and motor group used here is picked from the published annotations, not by hand.</p>
    <h4>What is modelled</h4>
    <p>Every neuron is a leaky integrate-and-fire unit with the parameters of <b>Shiu et al. (Nature 2024)</b>: 0.275 mV per synapse, 20 ms membrane, 5 ms synapses, 1.8 ms delay. A connection excites or inhibits depending on the sending neuron's transmitter, taken first from BANC's verified labels, then from the sign Shiu used for the matched FAFB neuron, then from BANC's prediction. Raw predictions alone leave the inhibitory APL neuron excitatory, and the olfactory system seizes. Each candle is one fresh ${W.brain_ms} ms trial from rest, as in Shiu's experiments.</p>
    <h4>What I made up</h4>
    <p>How the market reaches the senses and how muscles become trades. Rising 3-candle momentum drives the labellum's sugar neurons and falling momentum the bitter ones. The 24-candle trend drives leg taste neurons. A crash candle drives the LC4/LPLC2 looming detectors. On the way out, MN9's firing rate sets position size, MDN (walking backwards) halves it, and any Giant Fibre spike sells everything. TTMn, the jump muscle the Giant Fibre drives through the nerve cord, is shown but not needed for the decision.</p>
    <h4>What did not work</h4>
    <p>Smell and wind were wired in first. In this model the antennal lobe's reciprocal excitation runs away into a seizure that never stops, even at 10 Hz input. Real neurons tire and this model's do not, so those senses were removed rather than faked.</p>
    <h4>Should you trade with it?</h4>
    <p>No. It is a momentum filter built out of a fly. Nothing was fitted to prices, fees are charged at 0.1%, and every trade is paper.</p>`;
}
