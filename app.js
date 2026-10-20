// ChartLens — free chart analyzer. All data is real (Coinbase + Yahoo Finance via
// the repo's data publisher); all signals are deterministic technical-analysis
// rules with cited values. Nothing is predicted, backfilled, or hallucinated.
const DATA_URL = 'https://raw.githubusercontent.com/MisoPrettyStacks/chartlens/data/bars.json';
const $ = (id) => document.getElementById(id);
const state = { data: null, market: 'crypto', symbol: 'BTC-USD', tf: '15m', mode: 'scalp', bars: [],
  liveBars: [], view: { n: null, off: 0 }, lastDraw: 0, wsLive: false, kalshi: { t0: null, v: null }, lastPrice: null };
const TFSEC = { '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };
const defaultN = (tf) => tf === '5m' ? 120 : tf === '15m' ? 96 : tf === '1h' ? 120 : 180;

const DECIMALS = { 'BTC-USD': 2, 'ETH-USD': 2, 'XRP-USD': 4, 'SOL-USD': 2, 'EURUSD=X': 5, 'GBPUSD=X': 5, 'USDJPY=X': 3 };
const dec = (s) => DECIMALS[s] ?? 2;
const fmtP = (s, v) => v == null || !isFinite(v) ? '—' : v.toFixed(dec(s));
// bottom-axis time label (bar open time, Pacific) — shared by gridlines + labels
const timeLblOf = (t, tf) => {
  const d = new Date(t * 1000);
  return tf === '1d'
    ? d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Los_Angeles' })
    : d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Los_Angeles' });
};

/* ---------------- data ---------------- */
async function loadData() {
  const r = await fetch(DATA_URL + '?t=' + Date.now());
  if (!r.ok) throw new Error('data unavailable');
  state.data = await r.json();
  const g = state.data.generated ? new Date(state.data.generated) : null;
  $('asof').textContent = g ? 'data · ' + g.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) + ' PT' : 'waiting for publisher';
  buildMarkets();
  selectSymbol(state.symbol);
}

function symbolsOf(market) {
  return Object.entries(state.data.symbols).filter(([, s]) => s.market === market);
}
function buildMarkets() {
  const mk = $('markets'); mk.innerHTML = '';
  for (const m of ['crypto', 'stocks', 'forex']) {
    const b = document.createElement('button');
    b.textContent = m[0].toUpperCase() + m.slice(1);
    b.className = state.market === m ? 'on' : '';
    b.onclick = () => { state.market = m; buildMarkets(); buildSyms(); };
    mk.appendChild(b);
  }
}
function buildSyms() {
  const el = $('syms'); el.innerHTML = '';
  const syms = symbolsOf(state.market);
  // quick picks (first 8) — the full universe is in the lookup box
  for (const [id, s] of syms.slice(0, 8)) {
    const b = document.createElement('button');
    b.textContent = s.name;
    b.className = state.symbol === id ? 'on' : '';
    b.onclick = () => selectSymbol(id);
    el.appendChild(b);
  }
  if (syms.length > 8) {
    const more = document.createElement('span');
    more.className = 'muted';
    more.style.cssText = 'font-size:12px;align-self:center';
    more.textContent = `+${syms.length - 8} more — use lookup ↑`;
    el.appendChild(more);
  }
  const tfs = $('tfs'); tfs.innerHTML = '';
  const avail = state.data.symbols[state.symbol]?.tfs || {};
  for (const tf of ['5m', '15m', '1h', '1d']) {
    const b = document.createElement('button');
    b.textContent = tf;
    b.className = state.tf === tf ? 'on' : '';
    b.disabled = !avail[tf];
    b.style.opacity = avail[tf] ? 1 : 0.35;
    b.title = avail[tf] ? '' : 'not published for this symbol';
    b.onclick = () => { state.tf = tf; render(); };
    tfs.appendChild(b);
  }
}
function selectSymbol(id) {
  state.symbol = id;
  const s = state.data.symbols[id];
  if (s && s.market !== state.market) { state.market = s.market; buildMarkets(); }
  if (s && !s.tfs[state.tf]) state.tf = '15m'; // extended symbols skip 5m
  buildSyms();
  render();
}
function getBars() {
  const s = state.data.symbols[state.symbol];
  const bars = s && s.tfs[state.tf];
  return bars ? bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })) : [];
}

/* ---------------- live crypto candles (Coinbase REST, direct) ---------------- */
// The publisher commits bars.json roughly every 15 min when GitHub's scheduler
// cooperates — but that scheduler can lag hours. Coinbase's public candles API
// is CORS-enabled, so crypto charts backfill straight from the source and are
// always current to the forming candle; the WS feed then extends it tick by
// tick. Stocks/forex stay on the published file (Yahoo has no CORS API).
async function fetchCoinbaseBars(id, tf) {
  const gran = TFSEC[tf];
  if (!gran) return null;
  // no start/end: Coinbase returns the latest ~300 candles incl. the forming one
  const r = await fetch(`https://api.exchange.coinbase.com/products/${id}/candles?granularity=${gran}`);
  if (!r.ok) return null;
  const raw = await r.json();
  if (!Array.isArray(raw) || !raw.length) return null;
  // raw: [time, low, high, open, close, volume]
  return raw.map(([t, l, h, o, c, v]) => ({ t, o, h, l, c, v })).sort((a, b) => a.t - b.t);
}
async function refreshCryptoLive() {
  const s = state.data?.symbols[state.symbol];
  if (!s || s.market !== 'crypto') return;
  try {
    const bars = await fetchCoinbaseBars(state.symbol, state.tf);
    if (!bars || bars.length < 10) return;
    state.bars = bars;
    state.liveBars = bars.map((b) => ({ ...b }));
    // sync the cached published copy so timeframe switches stay fresh too
    if (state.data.symbols[state.symbol].tfs)
      state.data.symbols[state.symbol].tfs[state.tf] = bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
    $('asof').textContent = 'live · ' + new Date().toLocaleString('en-US',
      { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) + ' PT';
    const sig = analyze(state.liveBars, state.mode);
    drawChart(state.liveBars, sig);
    renderSignal(sig); renderLevels(sig); renderRisk(sig); renderFeed();
    const last = bars[bars.length - 1];
    state.lastPrice = last.c;
    $('pxpill').innerHTML = `${s.name} <b>${fmtP(state.symbol, last.c)}</b>`;
  } catch {}
}

/* Kalshi target (black dashed line): the current 15-min window's reference
   price. Kalshi's API blocks browser origins, so — same as the arena pages —
   it's the typical price (h+l+c)/3 of the Coinbase 1-minute bar in the minute
   before the window opened, standing in for Kalshi's 60-second average. */
const KALSHI_SYMS = ['BTC-USD', 'ETH-USD', 'XRP-USD', 'SOL-USD'];
async function refreshKalshiTarget() {
  if (!KALSHI_SYMS.includes(state.symbol)) { state.kalshi = { t0: null, v: null }; return; }
  const t0 = Math.floor(Date.now() / 1000 / 900) * 900;
  if (state.kalshi.t0 === t0 && state.kalshi.v != null) return; // same window — no refetch
  try {
    const r = await fetch(`https://api.exchange.coinbase.com/products/${state.symbol}/candles?granularity=60`);
    if (!r.ok) return;
    const raw = await r.json();
    if (!Array.isArray(raw)) return;
    const bar = raw.find(([t]) => t === t0 - 60);
    if (!bar) return;
    const [, l, h, , c] = bar;
    state.kalshi = { t0, v: (h + l + c) / 3 };
    if (state.liveBars.length) drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  } catch {}
}

/* ---------------- indicators (deterministic) ---------------- */
const closes = (bars) => bars.map((b) => b.c);
function sma(vals, p) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= p) sum -= vals[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function ema(vals, p) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < p) return out;
  const k = 2 / (p + 1);
  let e = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = e;
  for (let i = p; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsi(cl, p = 14) {
  const out = new Array(cl.length).fill(null);
  if (cl.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function macd(cl) {
  const e12 = ema(cl, 12), e26 = ema(cl, 26);
  const line = cl.map((_, i) => (e12[i] == null || e26[i] == null) ? null : e12[i] - e26[i]);
  const valid = line.filter((v) => v != null);
  const sigRaw = ema(valid, 9);
  const sig = new Array(cl.length).fill(null);
  let j = 0;
  for (let i = 0; i < cl.length; i++) if (line[i] != null) sig[i] = sigRaw[j++];
  const hist = cl.map((_, i) => (line[i] == null || sig[i] == null) ? null : line[i] - sig[i]);
  return { line, sig, hist };
}
function bollinger(cl, p = 20, m = 2) {
  const mid = sma(cl, p);
  return cl.map((_, i) => {
    if (mid[i] == null) return null;
    const slice = cl.slice(i - p + 1, i + 1);
    const mean = mid[i];
    const sd = Math.sqrt(slice.reduce((a, v) => a + (v - mean) ** 2, 0) / p);
    return { mid: mean, up: mean + m * sd, lo: mean - m * sd };
  });
}
function atr(bars, p = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < p + 1) return out;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let a = trs.slice(0, p).reduce((x, y) => x + y, 0) / p;
  out[p] = a;
  for (let i = p + 1; i < bars.length; i++) { a = (a * (p - 1) + trs[i - 1]) / p; out[i] = a; }
  return out;
}
// recent swing highs/lows (fractals) → support/resistance
function swingLevels(bars, lookback = 120, k = 2) {
  const n = bars.length, hi = [], lo = [];
  const from = Math.max(k, n - lookback);
  for (let i = from; i < n - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (bars[i].h < bars[i - j].h || bars[i].h < bars[i + j].h) isH = false;
      if (bars[i].l > bars[i - j].l || bars[i].l > bars[i + j].l) isL = false;
    }
    if (isH) hi.push(bars[i].h);
    if (isL) lo.push(bars[i].l);
  }
  const last = bars[n - 1].c;
  const res = [...new Set(hi)].filter((v) => v > last).sort((a, b) => a - b).slice(0, 3);
  const sup = [...new Set(lo)].filter((v) => v < last).sort((a, b) => b - a).slice(0, 3);
  return { res, sup };
}

/* ---------------- signal engine (rule-based, transparent) ---------------- */
// Indicators computed ONCE per series; scoring is then O(1) per bar, so the
// engine can be replayed over history for BUY/SELL markers honestly.
function computeAll(bars) {
  const cl = closes(bars);
  return { cl, e12: ema(cl, 12), e26: ema(cl, 26), e50: ema(cl, 50),
           rsi: rsi(cl), macd: macd(cl), bb: bollinger(cl), atr: atr(bars) };
}
function scoreAt(bars, ind, i, wantReasons) {
  const sym = state.symbol, px = bars[i].c, last = bars[i];
  const reasons = [];
  let score = 0;
  const add = (pts, txt) => { score += pts; if (wantReasons) reasons.push({ pts, txt }); };
  if (ind.e50[i] != null) add(px > ind.e50[i] ? 1 : -1, `Price ${fmtP(sym, px)} ${px > ind.e50[i] ? 'above' : 'below'} EMA50 ${fmtP(sym, ind.e50[i])} — ${px > ind.e50[i] ? 'uptrend' : 'downtrend'}`);
  if (ind.e12[i] != null && ind.e26[i] != null) add(ind.e12[i] > ind.e26[i] ? 1 : -1, `EMA12 ${ind.e12[i] > ind.e26[i] ? 'above' : 'below'} EMA26 — momentum ${ind.e12[i] > ind.e26[i] ? 'up' : 'down'}`);
  if (ind.rsi[i] != null) {
    const v = ind.rsi[i];
    if (v < 30) add(2, `RSI(14) ${v.toFixed(1)} — oversold`);
    else if (v > 70) add(-2, `RSI(14) ${v.toFixed(1)} — overbought`);
    else if (v < 40) add(1, `RSI(14) ${v.toFixed(1)} — soft`);
    else if (v > 60) add(-1, `RSI(14) ${v.toFixed(1)} — firm`);
    else add(0, `RSI(14) ${v.toFixed(1)} — neutral`);
  }
  if (ind.macd.hist[i] != null) {
    add(ind.macd.hist[i] > 0 ? 1 : -1, `MACD histogram ${ind.macd.hist[i] > 0 ? 'positive' : 'negative'} (${ind.macd.hist[i].toFixed(dec(sym) + 1)})`);
    if (ind.macd.hist[i - 1] != null && ((ind.macd.hist[i] > 0) !== (ind.macd.hist[i - 1] > 0)))
      add(ind.macd.hist[i] > 0 ? 1 : -1, `MACD histogram just flipped ${ind.macd.hist[i] > 0 ? 'up' : 'down'}`);
  }
  if (ind.bb[i]) {
    const pctB = (px - ind.bb[i].lo) / Math.max(ind.bb[i].up - ind.bb[i].lo, 1e-12);
    if (pctB < 0.15) add(1, `%B ${pctB.toFixed(2)} — pressing lower Bollinger band`);
    else if (pctB > 0.85) add(-1, `%B ${pctB.toFixed(2)} — pressing upper Bollinger band`);
    else add(0, `%B ${pctB.toFixed(2)} — mid-band`);
  }
  // breakout of recent 20-bar range (window ends at bar i)
  if (i >= 22) {
    const win = bars.slice(i - 21, i);
    const hh = Math.max(...win.map((b) => b.h));
    const ll = Math.min(...win.map((b) => b.l));
    if (px > hh) {
      let pts = 1;
      const vols = bars.slice(i - 20, i + 1).map((b) => b.v).filter((v) => v != null);
      if (vols.length > 10) {
        const avg = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
        if (last.v > avg * 1.5) { pts = 2; add(pts, `Breakout above 20-bar high ${fmtP(sym, hh)} on ${(last.v / avg).toFixed(1)}× volume`); }
        else add(pts, `Above 20-bar high ${fmtP(sym, hh)} — thin volume, weaker`);
      } else add(pts, `Breakout above 20-bar high ${fmtP(sym, hh)}`);
    } else if (px < ll) {
      let pts = -1;
      const vols = bars.slice(i - 20, i + 1).map((b) => b.v).filter((v) => v != null);
      if (vols.length > 10) {
        const avg = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
        if (last.v > avg * 1.5) { pts = -2; add(pts, `Breakdown below 20-bar low ${fmtP(sym, ll)} on ${(last.v / avg).toFixed(1)}× volume`); }
        else add(pts, `Below 20-bar low ${fmtP(sym, ll)} — thin volume, weaker`);
      } else add(pts, `Breakdown below 20-bar low ${fmtP(sym, ll)}`);
    }
  }
  return { score, reasons };
}
function analyze(bars, mode) {
  const n = bars.length;
  if (n < 60) return { error: `Insufficient data — only ${n} candles (need 60+).` };
  const ind = computeAll(bars);
  const i = n - 1, last = bars[i], px = last.c;
  const { score, reasons } = scoreAt(bars, ind, i, true);
  const bias = score >= 3 ? 'LONG' : score <= -3 ? 'SHORT' : 'NEUTRAL';
  const conviction = Math.min(100, Math.round(Math.abs(score) / 8 * 100));
  const atrV = ind.atr[i];
  const mult = mode === 'scalp' ? 1.5 : 2.0;
  const lv = swingLevels(bars);
  let entry = px, stop = null, targets = [];
  if (atrV != null && bias !== 'NEUTRAL') {
    const dir = bias === 'LONG' ? 1 : -1;
    stop = px - dir * mult * atrV;
    const risk = Math.abs(px - stop);
    targets = [px + dir * risk, px + dir * 2 * risk];
    // snap targets to nearby S/R when close
    const lvls = dir > 0 ? lv.res : lv.sup;
    targets = targets.map((t) => {
      const near = lvls.find((l) => Math.abs(l - t) / risk < 0.3);
      return near ?? t;
    });
  }
  return { bias, score, conviction, reasons, levels: lv, entry, stop, targets, atr: atrV, px, t: last.t };
}
// Historical BUY/SELL markers: replay the same rules over past bars.
// Hysteresis (score must fall back under ±1 before re-arming) prevents spam.
function findMarkers(bars, mode) {
  const n = bars.length;
  if (n < 70) return [];
  const ind = computeAll(bars);
  const out = [];
  let armedLong = true, armedShort = true;
  for (let i = 60; i < n; i++) {
    const { score } = scoreAt(bars, ind, i, false);
    if (score >= 3 && armedLong) {
      out.push({ i, dir: 'BUY', price: bars[i].c, t: bars[i].t, score });
      armedLong = false; armedShort = true;
    } else if (score <= -3 && armedShort) {
      out.push({ i, dir: 'SELL', price: bars[i].c, t: bars[i].t, score });
      armedShort = false; armedLong = true;
    } else if (Math.abs(score) < 1) { armedLong = armedShort = true; }
  }
  return out;
}

/* ---------------- chart ---------------- */
function drawChart(bars, sig) {
  const cv = $('chart'), ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (!bars.length) { ctx.fillStyle = '#6b768c'; ctx.fillText('No data for this symbol/timeframe yet.', 20, 40); return; }
  // zoom/pan view: n = visible bars, off = bars trimmed from the right edge
  const maxN = bars.length;
  const N = Math.max(30, Math.min(state.view.n || defaultN(state.tf), maxN));
  const off = Math.max(0, Math.min(state.view.off, maxN - N));
  const startIdx = maxN - N - off;
  const bs = bars.slice(startIdx, startIdx + N);
  // ATR volatility cone: projects the next CONE bars as ±ATR·√k. A volatility
  // envelope, not a prediction — it shows where price *could* go, not where it will.
  const CONE = 24;
  const cone = (sig && !sig.error && sig.atr != null && sig.atr > 0)
    ? { px: sig.px, atr: sig.atr, n: CONE } : null;
  const pad = { l: 8, r: 64, t: 10, b: 44 };
  let lo = Infinity, hi = -Infinity;
  for (const b of bs) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
  // include indicator/zone/cone extremes
  const cl = closes(bs);
  const e12 = ema(cl, 12), e26 = ema(cl, 26), bb = bollinger(cl);
  for (let i = 0; i < bs.length; i++) {
    for (const v of [e12[i], e26[i], bb[i]?.up, bb[i]?.lo]) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (cone) {
    const w = cone.atr * Math.sqrt(cone.n);
    lo = Math.min(lo, cone.px - w); hi = Math.max(hi, cone.px + w);
  }
  const zones = [];
  if (sig && !sig.error) {
    if (sig.stop != null) zones.push({ v: sig.stop, c: '#dc2626', dash: [5, 4], label: 'STOP' });
    for (const t of sig.targets) zones.push({ v: t, c: '#16a34a', dash: [5, 4], label: 'TGT' });
    if (sig.levels) for (const r of sig.levels.res) zones.push({ v: r, c: '#dc2626', dash: [2, 4], label: '' });
    if (sig.levels) for (const s of sig.levels.sup) zones.push({ v: s, c: '#16a34a', dash: [2, 4], label: '' });
    zones.push({ v: sig.entry, c: '#4f46e5', dash: [], label: 'ENTRY' });
  }
  if (state.kalshi && state.kalshi.v != null)
    zones.push({ v: state.kalshi.v, c: '#111111', dash: [7, 5], label: 'KALSHI TARGET' });
  // live price line (blue dashed): latest streamed trade, falls back to last close
  const liveV = state.lastPrice != null ? state.lastPrice : (bs.length ? bs[bs.length - 1].c : null);
  if (liveV != null) zones.push({ v: liveV, c: '#2563eb', dash: [4, 3], label: 'LIVE' });
  for (const z of zones) { lo = Math.min(lo, z.v); hi = Math.max(hi, z.v); }
  const rg = Math.max(hi - lo, 1e-9); lo -= rg * 0.06; hi += rg * 0.06;
  const cw = (W - pad.l - pad.r) / (N + CONE);
  const X = (i) => pad.l + (i + 0.5) * cw;
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  // gridlines + price labels
  ctx.font = '10px system-ui'; ctx.fillStyle = '#8a94a8'; ctx.strokeStyle = '#e8ecf4'; ctx.lineWidth = 1;
  for (let gLine = 0; gLine <= 5; gLine++) {
    const v = lo + (rg * 1.12) * gLine / 5, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(v.toFixed(dec(state.symbol)), W - pad.r + 4, y + 3);
  }
  // vertical time gridlines — shared positions with the bottom time labels,
  // extended CONE slots past the last candle so the axis runs into the future
  const tfSec = TFSEC[state.tf] || 900;
  const timeAt = (i) => i < bs.length ? bs[i].t : bs[bs.length - 1].t + (i - bs.length + 1) * tfSec;
  const widestLbl = Math.max(...bs.map((b) => ctx.measureText(timeLblOf(b.t)).width));
  const tStep = Math.max(1, Math.ceil((widestLbl + 16) / cw));
  const gridIdx = [];
  for (let i = 0; i < bs.length + CONE; i += tStep) gridIdx.push(i);
  for (const i of gridIdx) {
    const x = X(i);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
  }
  // bollinger band
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < bs.length; i++) {
    if (!bb[i]) continue;
    if (!started) { ctx.moveTo(X(i), Y(bb[i].up)); started = true; } else ctx.lineTo(X(i), Y(bb[i].up));
  }
  for (let i = bs.length - 1; i >= 0; i--) { if (bb[i]) ctx.lineTo(X(i), Y(bb[i].lo)); }
  ctx.closePath(); ctx.fillStyle = 'rgba(79,70,229,.06)'; ctx.fill();
  // candles
  const bw = Math.max(1.5, cw * 0.62);
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i], x = X(i), col = b.c >= b.o ? '#16a34a' : '#dc2626';
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke();
    const yo = Y(b.o), yc = Y(b.c);
    ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yo - yc)));
  }
  // EMAs
  const emaLine = (arr, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath();
    let s = false;
    for (let i = 0; i < bs.length; i++) {
      if (arr[i] == null) continue;
      if (!s) { ctx.moveTo(X(i), Y(arr[i])); s = true; } else ctx.lineTo(X(i), Y(arr[i]));
    }
    ctx.stroke();
  };
  emaLine(e12, '#f59e0b'); emaLine(e26, '#4f46e5');
  // volatility cone: shaded ±ATR·√k envelope over the next CONE slots
  if (cone) {
    ctx.beginPath();
    for (let k = 0; k <= cone.n; k++) {
      const x = X(N - 1 + k), y = Y(cone.px + cone.atr * Math.sqrt(k));
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    for (let k = cone.n; k >= 0; k--) ctx.lineTo(X(N - 1 + k), Y(cone.px - cone.atr * Math.sqrt(k)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(79,70,229,.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,70,229,.45)'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
    for (const sgn of [1, -1]) {
      ctx.beginPath();
      for (let k = 0; k <= cone.n; k++) {
        const x = X(N - 1 + k), y = Y(cone.px + sgn * cone.atr * Math.sqrt(k));
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#4f46e5'; ctx.font = '600 10px system-ui';
    ctx.fillText('ATR cone', X(N - 1 + 2), Y(cone.px + cone.atr * Math.sqrt(cone.n)) - 4);
  }
  // zones — text labels are pushed apart vertically so close levels never print over each other
  ctx.font = '600 10px system-ui';
  const zLabels = zones.map((z) => ({ z, y: Y(z.v), ly: Y(z.v) - 4 }));
  zLabels.sort((a, b) => a.ly - b.ly);
  let prevLy = -1e9;
  for (const L of zLabels) {
    if (L.ly < prevLy + 11) L.ly = prevLy + 11;
    prevLy = L.ly;
  }
  if (zLabels.length) { // shift the whole stack up if it would spill below the plot
    const over = prevLy - (H - pad.b - 3);
    if (over > 0) for (const L of zLabels) L.ly -= over;
  }
  for (const L of zLabels) {
    const z = L.z, y = Y(z.v);
    ctx.strokeStyle = z.c; ctx.lineWidth = z.dash.length ? 1.2 : 1.8;
    ctx.setLineDash(z.dash); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = z.c;
    ctx.fillText(`${z.label ? z.label + ' ' : ''}${z.v.toFixed(dec(state.symbol))}`, pad.l + 4, L.ly);
  }
  // BUY/SELL markers from the rule engine's own history
  const markers = findMarkers(bars, state.mode);
  const offM = startIdx;
  ctx.font = '700 9px system-ui';
  let lastBuyTextX = -1e9, lastSellTextX = -1e9;
  for (const m of markers) {
    const vi = m.i - offM;
    if (vi < 0 || vi >= bs.length) continue;
    const x = X(vi), isBuy = m.dir === 'BUY', col = isBuy ? '#16a34a' : '#dc2626';
    const y = isBuy ? Y(bs[vi].l) + 14 : Y(bs[vi].h) - 14;
    ctx.fillStyle = col;
    ctx.beginPath();
    if (isBuy) { ctx.moveTo(x, y - 7); ctx.lineTo(x - 6, y + 2); ctx.lineTo(x + 6, y + 2); }
    else { ctx.moveTo(x, y + 7); ctx.lineTo(x - 6, y - 2); ctx.lineTo(x + 6, y - 2); }
    ctx.closePath(); ctx.fill();
    // text only if it won't run into the previous same-side label
    const lastX = isBuy ? lastBuyTextX : lastSellTextX;
    if (x - lastX >= 30) {
      ctx.fillText(m.dir, x - 10, isBuy ? y + 12 : y - 10);
      if (isBuy) lastBuyTextX = x; else lastSellTextX = x;
    }
  }
  // time labels — drawn at the gridline positions (gridIdx), including the
  // future slots past the last candle; each clamped inside the plot.
  ctx.fillStyle = '#8a94a8'; ctx.font = '10px system-ui';
  const plotRight = W - pad.r;
  for (const i of gridIdx) {
    const lbl = timeLblOf(timeAt(i), state.tf);
    let x = X(i) - ctx.measureText(lbl).width / 2;
    if (x + ctx.measureText(lbl).width > plotRight - 2) x = plotRight - 2 - ctx.measureText(lbl).width;
    if (x < pad.l) continue;
    ctx.fillText(lbl, x, H - 8);
  }
  const isLive = state.wsLive && state.data.symbols[state.symbol]?.market === 'crypto';
  $('spanpill').textContent = `${state.symbol} · ${state.tf} · ${isLive ? '● LIVE' : 'delayed ~15 min'} · scroll to zoom, drag to pan, double-click to reset`;
  $('legend').innerHTML = `<span><b style="color:#f59e0b">—</b> EMA12</span><span><b style="color:#4f46e5">—</b> EMA26</span><span><b style="color:rgba(79,70,229,.45)">- -</b> ATR cone</span><span><b style="color:#16a34a">—</b> support/target</span><span><b style="color:#dc2626">—</b> resistance/stop</span>` +
    ((state.kalshi && state.kalshi.v != null) ? `<span><b style="color:#111">- -</b> Kalshi target</span>` : ``) +
    (liveV != null ? `<span><b style="color:#2563eb">- -</b> live price</span>` : ``);
}

/* ---------------- mouse: wheel zoom, drag pan, double-click reset ---------------- */
(function initMouse() {
  const cv = $('chart');
  let dragX = null, dragOff = 0;
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cur = state.view.n || defaultN(state.tf);
    const next = Math.round(cur * (e.deltaY > 0 ? 1.18 : 1 / 1.18));
    state.view.n = Math.max(30, Math.min(state.liveBars.length, next));
    drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => { dragX = e.clientX; dragOff = state.view.off; cv.style.cursor = 'grabbing'; });
  window.addEventListener('mousemove', (e) => {
    if (dragX == null || !state.liveBars.length) return;
    const n = state.view.n || defaultN(state.tf);
    const cw = (cv.clientWidth - 72) / n;
    state.view.off = Math.max(0, Math.round(dragOff + (dragX - e.clientX) / Math.max(cw, 1)));
    drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  });
  window.addEventListener('mouseup', () => { dragX = null; cv.style.cursor = 'crosshair'; });
  cv.addEventListener('dblclick', () => {
    state.view = { n: null, off: 0 };
    drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  });
})();

/* ---------------- panels ---------------- */
/* ---------------- stock lookup ---------------- */
(function initSearch() {
  const inp = $('search'), box = $('searchres');
  const hide = () => { box.style.display = 'none'; box.innerHTML = ''; };
  inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    if (!state.data || q.length < 1) { hide(); return; }
    const hits = Object.entries(state.data.symbols)
      .filter(([id, s]) => id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .slice(0, 8);
    if (!hits.length) { hide(); return; }
    box.innerHTML = '';
    for (const [id, s] of hits) {
      const d = document.createElement('div');
      d.innerHTML = `<span class="sym">${id.replace('=X', '')}</span><span class="nm">${s.name} · ${s.market}</span>`;
      d.onclick = () => { selectSymbol(id); inp.value = ''; hide(); };
      box.appendChild(d);
    }
    box.style.display = 'block';
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = box.querySelector('div');
      if (first) first.click();
    } else if (e.key === 'Escape') hide();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.searchwrap')) hide(); });
})();
/* ---------------- live tape + signal feed ---------------- */
function tapeChange(id) {
  const s = state.data.symbols[id];
  const bars = s && (s.tfs['1d'] || s.tfs['1h']);
  if (!bars || bars.length < 2) return null;
  const last = bars[bars.length - 1][4], prev = bars[bars.length - 2][4];
  return { px: last, chg: (last - prev) / prev * 100 };
}
function renderTape() {
  const el = $('tape'); el.innerHTML = '';
  for (const [id, s] of Object.entries(state.data.symbols)) {
    const c = tapeChange(id);
    if (!c) continue;
    const isLive = s.market === 'crypto' && state.wsLive;
    const d = document.createElement('div');
    d.className = 'tapeitem'; d.id = 'tape-' + id;
    d.innerHTML = `<b>${s.name}</b> <span class="px">${fmtP(id, c.px)}</span> <span class="${c.chg >= 0 ? 'up' : 'dn'}">${c.chg >= 0 ? '+' : ''}${c.chg.toFixed(2)}%</span><span class="tapetag ${isLive ? 'live' : 'delayed'}">${isLive ? 'LIVE' : '15-MIN'}</span>`;
    d.onclick = () => selectSymbol(id);
    el.appendChild(d);
  }
}
function tapeTick(id, price) {
  const d = $('tape-' + id);
  if (d) { const px = d.querySelector('.px'); if (px) px.textContent = fmtP(id, price); }
}
// Re-label tape chips + chart pill when the socket connects or drops, so the
// LIVE tag reflects reality instead of whatever state existed at first render.
function refreshTapeTags() {
  if (!state.data) return;
  for (const [id, s] of Object.entries(state.data.symbols)) {
    const d = $('tape-' + id);
    if (!d) continue;
    const tag = d.querySelector('.tapetag');
    if (!tag) continue;
    const isLive = s.market === 'crypto' && state.wsLive;
    tag.className = 'tapetag ' + (isLive ? 'live' : 'delayed');
    tag.textContent = isLive ? 'LIVE' : '15-MIN';
  }
}
function renderFeed() {
  const el = $('feed');
  const markers = findMarkers(state.liveBars, state.mode);
  if (!markers.length) { el.innerHTML = '<span class="muted">No BUY/SELL markers on this timeframe yet.</span>'; return; }
  const lastC = state.liveBars[state.liveBars.length - 1].c;
  el.innerHTML = markers.slice(-8).reverse().map((m) => {
    const ret = m.dir === 'BUY' ? (lastC - m.price) / m.price * 100 : (m.price - lastC) / m.price * 100;
    const t = new Date(m.t * 1000).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
    return `<div class="feeditem"><span><span class="${m.dir}">${m.dir}</span> ${t}</span><span>${fmtP(state.symbol, m.price)} <span class="${ret >= 0 ? 'win' : 'loss'}">${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%</span></span></div>`;
  }).join('');
}
function render() {
  refreshKalshiTarget();
  state.bars = getBars();
  state.liveBars = state.bars.map((b) => ({ ...b }));
  state.view = { n: null, off: 0 };
  const sig = analyze(state.liveBars, state.mode);
  drawChart(state.liveBars, sig);
  renderSignal(sig);
  renderLevels(sig);
  renderRisk(sig);
  renderTape();
  renderFeed();
  const s = state.data.symbols[state.symbol];
  const last = state.liveBars[state.liveBars.length - 1];
  state.lastPrice = last ? last.c : null;
  $('pxpill').innerHTML = s ? `${s.name} <b>${fmtP(state.symbol, last ? last.c : null)}</b>` : '—';
  refreshCryptoLive(); // crypto: replace published bars with live Coinbase candles
  const src = { crypto: 'Coinbase', stocks: 'Yahoo Finance', forex: 'Yahoo Finance' };
  $('srcs').textContent = `Sources: crypto — Coinbase public candles; stocks & forex — Yahoo Finance. Nothing simulated.`;
}
function renderSignal(sig) {
  const el = $('signal');
  if (sig.error) { el.innerHTML = `<p class="muted">${sig.error}</p>`; return; }
  const cls = sig.bias === 'LONG' ? 'long' : sig.bias === 'SHORT' ? 'short' : 'flat';
  el.innerHTML = `<span class="bias ${cls}">${sig.bias}</span>
    <div class="score">rule score ${sig.score > 0 ? '+' : ''}${sig.score} · conviction ${sig.conviction}% · ${state.mode} mode · ${state.tf}</div>
    <ul class="reasons">${sig.reasons.filter((r) => r.pts !== 0 || true).map((r) =>
      `<li>${r.pts > 0 ? '▲' : r.pts < 0 ? '▼' : '·'} ${r.txt}</li>`).join('')}</ul>
    ${sig.bias === 'NEUTRAL' ? '<p class="muted">No trade: signals conflict. Cash is a position.</p>' : ''}
    <div class="sigwarn">⚠️ Not financial advice — a rule-based chart readout, not a recommendation.</div>`;
}
function renderLevels(sig) {
  const el = $('levels');
  if (sig.error || !sig.levels) { el.innerHTML = '—'; return; }
  const { res, sup } = sig.levels;
  el.innerHTML = `<div class="lvls">
    <div>Resistance: ${res.length ? res.map((v) => `<span class="r">${fmtP(state.symbol, v)}</span>`).join(' · ') : '—'}</div>
    <div>Support: ${sup.length ? sup.map((v) => `<span class="s">${fmtP(state.symbol, v)}</span>`).join(' · ') : '—'}</div>
    ${sig.atr != null ? `<div>ATR(14): ${fmtP(state.symbol, sig.atr)}</div>` : ''}
  </div>`;
}
function renderRisk(sig) {
  const el = $('riskout');
  const acct = parseFloat($('acct').value), rp = parseFloat($('riskpct').value);
  if (!(acct > 0) || !(rp > 0) || sig.error || sig.bias === 'NEUTRAL' || sig.stop == null) {
    el.innerHTML = '<span class="muted">Enter account & risk % — needs a live signal with a stop.</span>'; return;
  }
  const riskUsd = acct * rp / 100;
  const perUnit = Math.abs(sig.entry - sig.stop);
  const size = perUnit > 0 ? riskUsd / perUnit : 0;
  const t1 = sig.targets[0], t2 = sig.targets[1];
  el.innerHTML = `Risk <b>$${riskUsd.toFixed(2)}</b> · size <b>${size < 1 ? size.toFixed(4) : size.toFixed(2)} units</b> @ ${fmtP(state.symbol, sig.entry)}<br>
    Stop ${fmtP(state.symbol, sig.stop)} · T1 ${fmtP(state.symbol, t1)} · T2 ${fmtP(state.symbol, t2)}`;
}
['acct', 'riskpct'].forEach((id) => $(id).addEventListener('input', () => renderRisk(analyze(state.liveBars, state.mode))));

/* ---------------- journal (localStorage) ---------------- */
const JKEY = 'chartlens.journal';
const jGet = () => { try { return JSON.parse(localStorage.getItem(JKEY) || '[]'); } catch { return []; } };
const jSet = (j) => localStorage.setItem(JKEY, JSON.stringify(j));
function jRender() {
  const j = jGet();
  const tb = document.querySelector('#jtable tbody'); tb.innerHTML = '';
  let wins = 0, losses = 0;
  for (const [idx, t] of j.entries()) {
    if (t.result === 'WIN') wins++; else if (t.result === 'LOSS') losses++;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${t.sym}</td><td>${t.dir}</td><td>${t.entry}</td><td>${t.stop}</td><td>${t.tgt}</td><td>${t.result || '—'}</td>`;
    const td = document.createElement('td');
    for (const r of ['WIN', 'LOSS']) {
      const b = document.createElement('button'); b.textContent = r;
      b.onclick = () => { const jj = jGet(); jj[idx].result = r; jSet(jj); jRender(); };
      td.appendChild(b);
    }
    const del = document.createElement('button'); del.textContent = '✕';
    del.onclick = () => { const jj = jGet(); jj.splice(idx, 1); jSet(jj); jRender(); };
    td.appendChild(del);
    tr.appendChild(td); tb.appendChild(tr);
  }
  const tot = wins + losses;
  $('jstats').textContent = tot ? `${tot} closed · ${wins}W/${losses}L · win rate ${(wins / tot * 100).toFixed(0)}%` : 'No closed trades yet.';
}
$('j_add').onclick = () => {
  const t = { sym: $('j_sym').value || state.symbol, dir: $('j_dir').value, entry: $('j_entry').value, stop: $('j_stop').value, tgt: $('j_tgt').value, result: null, at: Date.now() };
  if (!t.entry) return;
  const j = jGet(); j.unshift(t); jSet(j); jRender();
  for (const id of ['j_sym', 'j_entry', 'j_stop', 'j_tgt']) $(id).value = '';
};

/* ---------------- screenshot upload + optional Gemini vision ---------------- */
$('shot').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  const img = $('shotprev');
  img.src = URL.createObjectURL(f); img.style.display = 'block';
  const saved = localStorage.getItem('chartlens.gkey') || '';
  if (saved) $('gkey').value = saved;
  $('shotout').textContent = 'Screenshot loaded. Add your free Gemini key and hit Analyze for a vision readout, or use the live-data workup above.';
});
$('analyze').onclick = async () => {
  const f = $('shot').files[0];
  const out = $('shotout');
  if (!f) { out.textContent = 'Upload a chart screenshot first.'; return; }
  const key = $('gkey').value.trim();
  if (!key) { out.textContent = 'No Gemini key — the vision readout needs your free key (stored only in this browser). The rule-based workup above runs on live data with no key.'; return; }
  localStorage.setItem('chartlens.gkey', key);
  out.textContent = 'Analyzing screenshot…';
  try {
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f);
    });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [
        { text: 'You are a technical-analysis assistant. Describe ONLY what is objectively visible in this chart screenshot: trend direction, visible support/resistance levels with approximate prices, chart patterns, momentum, volume. Do not predict the future. End with: "This is chart description only, not financial advice."' },
        { inlineData: { mimeType: f.type || 'image/png', data: b64 } },
      ] }] }),
    });
    const j = await r.json();
    if (j.error) { out.textContent = 'Gemini API error: ' + (j.error.message || JSON.stringify(j.error).slice(0, 300)); return; }
    const txt = (j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '').trim();
    out.textContent = txt ? txt.slice(0, 4000) : 'No readout returned (empty response — try again or check your key).';
  } catch (e) { out.textContent = 'Vision request failed: ' + e.message; }
};

/* ---------------- live crypto price action (Coinbase WS matches) ---------------- */
// Real trades stream in and extend the forming candle tick-by-tick, so the
// chart moves live. Stocks/forex stay on the 15-min snapshots (labeled delayed).
const CRYPTO_IDS = ['BTC-USD', 'ETH-USD', 'XRP-USD', 'SOL-USD'];
function onTrade(pid, price, size, timeISO) {
  tapeTick(pid, price);
  if (pid !== state.symbol || !state.liveBars.length) return;
  state.lastPrice = price;
  if (state.data.symbols[pid]?.market !== 'crypto') return;
  const sec = TFSEC[state.tf] || 900;
  const bucket = Math.floor(new Date(timeISO).getTime() / 1000 / sec) * sec;
  const bars = state.liveBars;
  const last = bars[bars.length - 1];
  let newCandle = false;
  if (!last || bucket > last.t) {
    if (last && bucket > last.t + sec * 3) return; // gap vs publisher data — wait for refresh
    bars.push({ t: bucket, o: price, h: price, l: price, c: price, v: size || 0 });
    if (bars.length > 2500) bars.shift();
    newCandle = true;
  } else if (bucket === last.t) {
    last.c = price;
    if (price > last.h) last.h = price;
    if (price < last.l) last.l = price;
    last.v = (last.v || 0) + (size || 0);
  } else return; // late/out-of-order trade for an old bucket
  const s = state.data.symbols[state.symbol];
  $('pxpill').innerHTML = `${s.name} <b>${fmtP(state.symbol, price)}</b> <span class="muted">live</span>`;
  const now = Date.now();
  if (now - state.lastDraw > 500) {
    state.lastDraw = now;
    drawChart(bars, analyze(bars, state.mode));
    if (newCandle) { // refresh panels on candle close
      const sig = analyze(bars, state.mode);
      renderSignal(sig); renderLevels(sig); renderRisk(sig); renderFeed();
    }
  }
}
function connectWS() {
  let delay = 2000;
  const open = () => {
    const retry = () => {
      state.wsLive = false;
      refreshTapeTags();
      setTimeout(open, Math.min(delay, 30000));
      delay *= 2;
    };
    let ws;
    try { ws = new WebSocket('wss://ws-feed.exchange.coinbase.com'); } catch { retry(); return; }
    ws.onopen = () => {
      delay = 2000; state.wsLive = true;
      refreshTapeTags();
      ws.send(JSON.stringify({ type: 'subscribe', channels: [{ name: 'matches', product_ids: CRYPTO_IDS }] }));
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'match' && m.price) onTrade(m.product_id, parseFloat(m.price), parseFloat(m.size), m.time);
      } catch {}
    };
    ws.onclose = retry;
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  open();
}

/* ---------------- init ---------------- */
document.querySelectorAll('#modes button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#modes button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state.mode = b.dataset.mode;
    // scalp → fast frames, swing → slow frames
    state.tf = state.mode === 'scalp' ? '5m' : '1d';
    buildSyms(); render();
  };
});
window.addEventListener('resize', () => drawChart(state.liveBars, analyze(state.liveBars, state.mode)));
(async () => {
  try { await loadData(); connectWS(); jRender(); setInterval(pollData, 60000); setInterval(refreshCryptoLive, 60000); setInterval(refreshKalshiTarget, 60000); }
  catch (e) { $('asof').textContent = 'waiting for first data publish…'; }
})();
// Poll for a fresh publish every 60s; rebase silently (keeps zoom) when it arrives.
async function pollData() {
  try {
    const r = await fetch(DATA_URL + '?t=' + Date.now());
    if (!r.ok) return;
    const d = await r.json();
    if (!d.generated || !state.data || d.generated === state.data.generated) return;
    state.data = d;
    const g = new Date(d.generated);
    $('asof').textContent = 'data · ' + g.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) + ' PT';
    const nb = getBars();
    if (nb.length) {
      state.bars = nb;
      state.liveBars = nb.map((b) => ({ ...b }));
      const sig = analyze(state.liveBars, state.mode);
      drawChart(state.liveBars, sig);
      renderSignal(sig); renderLevels(sig); renderRisk(sig); renderFeed(); renderTape();
    } else renderTape();
  } catch {}
}
