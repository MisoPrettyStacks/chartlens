// ChartLens — free chart analyzer. All data is real (Coinbase + Yahoo Finance via
// the repo's data publisher); all signals are deterministic technical-analysis
// rules with cited values. Nothing is predicted, backfilled, or hallucinated.
const DATA_URL = 'https://raw.githubusercontent.com/MisoPrettyStacks/chartlens/data/bars.json';
const $ = (id) => document.getElementById(id);
const state = { data: null, market: 'crypto', symbol: 'BTC-USD', tf: '15m', mode: 'scalp', bars: [],
  liveBars: [], view: { n: null, off: 0 }, lastDraw: 0, wsLive: false, kalshi: { sym: null, t0: null, v: null }, lastPrice: null, _hoverI: null, _geom: null,
  showTriangles: (() => { try { return localStorage.getItem('chartlens.triangles') === '1'; } catch { return false; } })(), _tri: null, _triHover: false };
const TFSEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '12h': 43200, '1d': 86400 };
const defaultN = (tf) => tf === '1m' ? 120 : tf === '5m' ? 120 : tf === '15m' ? 96 : tf === '1h' ? 120 : tf === '6h' ? 120 : tf === '12h' ? 120 : 180;

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
  // crypto timeframes all come straight from Coinbase live, so every frame is
  // available even when the published file doesn't carry it (notably 1m)
  const isCrypto = state.data.symbols[state.symbol]?.market === 'crypto';
  for (const tf of ['1m', '5m', '15m', '1h', '6h', '12h', '1d']) {
    const b = document.createElement('button');
    b.textContent = tf;
    b.className = state.tf === tf ? 'on' : '';
    b.disabled = !(avail[tf] || isCrypto);
    b.style.opacity = b.disabled ? 0.35 : 1;
    b.title = b.disabled ? 'not published for this symbol' : '';
    b.onclick = () => { state.tf = tf; hideCandleTip(); render(); };
    tfs.appendChild(b);
  }
}
function selectSymbol(id) {
  state.symbol = id;
  state.lastPrice = null; // no stale live price from the previous symbol
  const s = state.data.symbols[id];
  if (s && s.market !== state.market) { state.market = s.market; buildMarkets(); }
  if (s && s.market !== 'crypto' && !s.tfs[state.tf]) state.tf = '15m'; // extended symbols skip 5m; crypto frames all come live from Coinbase
  hideCandleTip();
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
  // Coinbase has no 12h granularity — build 12h candles from its 6h ones
  const gran = tf === '12h' ? 21600 : TFSEC[tf];
  if (!gran) return null;
  // no start/end: Coinbase returns the latest ~300 candles incl. the forming one
  const r = await fetch(`https://api.exchange.coinbase.com/products/${id}/candles?granularity=${gran}`);
  if (!r.ok) return null;
  const raw = await r.json();
  if (!Array.isArray(raw) || !raw.length) return null;
  // raw: [time, low, high, open, close, volume]
  const bars = raw.map(([t, l, h, o, c, v]) => ({ t, o, h, l, c, v })).sort((a, b) => a.t - b.t);
  if (tf !== '12h') return bars;
  const out = [];
  for (const b of bars) {
    const bucket = Math.floor(b.t / 43200) * 43200;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l);
      last.c = b.c; last.v += b.v;
    } else out.push({ t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}
async function refreshCryptoLive() {
  const sym = state.symbol, tf = state.tf;
  const s = state.data?.symbols[sym];
  if (!s || s.market !== 'crypto') return;
  try {
    const bars = await fetchCoinbaseBars(sym, tf);
    if (state.symbol !== sym || state.tf !== tf) return; // switched away mid-fetch — drop stale bars
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
  const sym = state.symbol;
  if (!KALSHI_SYMS.includes(sym)) { state.kalshi = { sym: null, t0: null, v: null }; return; }
  const t0 = Math.floor(Date.now() / 1000 / 900) * 900;
  // cache is keyed on SYMBOL + window — a stale target from another symbol
  // would nuke the price scale (e.g. BTC's ~$81k on XRP's $1.30 chart)
  if (state.kalshi.sym === sym && state.kalshi.t0 === t0 && state.kalshi.v != null) return;
  state.kalshi = { sym, t0, v: null }; // clear the old symbol's target right away
  if (state.liveBars.length) drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  try {
    const r = await fetch(`https://api.exchange.coinbase.com/products/${sym}/candles?granularity=60`);
    if (!r.ok) return;
    const raw = await r.json();
    if (!Array.isArray(raw)) return;
    const bar = raw.find(([t]) => t === t0 - 60);
    if (!bar) return;
    const [, l, h, , c] = bar;
    if (state.symbol !== sym) return; // switched away mid-fetch — don't paint a stale target
    state.kalshi = { sym, t0, v: (h + l + c) / 3 };
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

/* ---------------- triangle patterns (auto-drawn, toggleable) ---------------- */
// Looks for a triangle in the recent bars: lines through the latest swing
// highs and swing lows that squeeze toward each other until they would meet.
// Least-squares fits over the last few swing points; the pattern only counts
// when it is long enough, the swing points actually sit near their lines,
// price is still inside the lines, and the lines meet reasonably soon.
// Classified by slope: both closing in = symmetrical; top flat + bottom
// rising = ascending; top falling + bottom flat = descending. It draws the
// shape the chart is making — it does not predict which way price breaks out.
function findTriangle(bars) {
  const n = bars.length;
  if (n < 60) return null;
  const k = 2, from = Math.max(0, n - 140);
  const highs = [], lows = [];
  for (let i = from + k; i < n - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (bars[i].h < bars[i - j].h || bars[i].h < bars[i + j].h) isH = false;
      if (bars[i].l > bars[i - j].l || bars[i].l > bars[i + j].l) isL = false;
    }
    if (isH) highs.push({ i, v: bars[i].h });
    if (isL) lows.push({ i, v: bars[i].l });
  }
  if (highs.length < 2 || lows.length < 2) return null;
  // merge same-side points a couple of bars apart (double tops/bottoms):
  // keep the more extreme one, so the fits span the pattern's real length
  const dedupe = (pts, isHigh) => {
    const out = [];
    for (const p of pts) {
      const lastP = out[out.length - 1];
      if (lastP && p.i - lastP.i <= 2 * k) {
        if (isHigh ? p.v > lastP.v : p.v < lastP.v) out[out.length - 1] = p;
      } else out.push(p);
    }
    return out;
  };
  const swingHighs = dedupe(highs, true), swingLows = dedupe(lows, false);
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  const seg = bars.slice(from);
  const avgR = seg.reduce((a, b) => a + (b.h - b.l), 0) / Math.max(seg.length, 1);
  const fit = (pts) => {
    const cnt = pts.length;
    const sx = pts.reduce((a, p) => a + p.i, 0), sy = pts.reduce((a, p) => a + p.v, 0);
    const sxx = pts.reduce((a, p) => a + p.i * p.i, 0), sxy = pts.reduce((a, p) => a + p.i * p.v, 0);
    const den = cnt * sxx - sx * sx;
    const slope = den === 0 ? 0 : (cnt * sxy - sx * sy) / den;
    const icept = (sy - slope * sx) / cnt;
    return { m: slope, b: icept, at: (x) => slope * x + icept };
  };
  for (const take of [4, 3, 2]) {
    const hp = swingHighs.slice(-take), lp = swingLows.slice(-take);
    if (hp.length < 2 || lp.length < 2) continue;
    const hf = fit(hp), lf = fit(lp);
    const startI = Math.min(hp[0].i, lp[0].i);
    const endI = n - 1;
    if (endI - startI < 12) continue; // too short to call a pattern
    const gapStart = hf.at(startI) - lf.at(startI);
    const gapEnd = hf.at(endI) - lf.at(endI);
    if (!(gapStart > 0) || !(gapEnd > 0) || gapEnd > gapStart * 0.95) continue; // lines must be squeezing
    if (hf.m === lf.m) continue;
    const apex = (lf.b - hf.b) / (hf.m - lf.m);
    if (!(apex > endI) || apex - endI > 160) continue; // must meet, and reasonably soon
    const tol = gapStart * 0.45 + avgR;
    if (hp.some((p) => Math.abs(p.v - hf.at(p.i)) > tol)) continue;
    if (lp.some((p) => Math.abs(p.v - lf.at(p.i)) > tol)) continue;
    const last = bars[endI].c;
    if (last < lf.at(endI) - gapEnd * 0.1 || last > hf.at(endI) + gapEnd * 0.1) continue; // price still inside
    // a side counts as sloped when its line travels a real share of the
    // pattern's starting height across the pattern; otherwise it's flat
    const span = endI - startI;
    const FLATV = 0.15 * gapStart;
    const sideOf = (f) => Math.abs(f.m) * span <= FLATV ? 'flat' : f.m < 0 ? 'falling' : 'rising';
    const upSide = sideOf(hf), dnSide = sideOf(lf);
    let type = null;
    if (upSide === 'falling' && dnSide === 'rising') type = 'Symmetrical triangle';
    else if (upSide === 'flat' && dnSide === 'rising') type = 'Ascending triangle';
    else if (upSide === 'falling' && dnSide === 'flat') type = 'Descending triangle';
    if (!type) continue;
    return { type, startI, endI, apexI: Math.round(apex), hiAt: hf.at, loAt: lf.at };
  }
  return null;
}

/* ---------------- last closed bar verdict ---------------- */
// Where the most recently FINISHED bar closed inside its own high–low range:
// close in the upper half of the range = CLOSED IN TOP, lower half = CLOSED
// IN BOTTOM. The still-forming bar is never judged — on the live chart the
// bar that gets judged is exactly the second-to-last one, and the verdict
// flips the moment that bar finishes. Returns null when no bar has finished
// yet, or when the finished bar never moved (no top/bottom to speak of).
function lastClosedVerdict(bars, tf) {
  const tfS = TFSEC[tf] || 900;
  const nowMs = Date.now();
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if ((b.t + tfS) * 1000 > nowMs) continue; // still forming — not judged
    if (!(b.h > b.l)) return null;
    const pos = (b.c - b.l) / (b.h - b.l);
    return { bar: b, pos, inTop: pos >= 0.5 };
  }
  return null;
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
  if (state.kalshi && state.kalshi.sym === state.symbol && state.kalshi.v != null)
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
  // triangle pattern, when toggled on: shaded shape plus both trendlines
  // extended toward the point where they would meet, labeled by name
  const tri = state.showTriangles ? findTriangle(bars) : null;
  state._tri = tri; // kept so mouse hover can price the lines and the tip
  if (tri) {
    const viFrom = Math.max(tri.startI - startIdx, 0);
    const fromFull = startIdx + viFrom;
    const viEnd = tri.endI - startIdx;
    const capFull = Math.min(tri.apexI, startIdx + N + CONE - 1);
    const viCap = capFull - startIdx;
    if (viEnd >= 0 && viFrom < N + CONE) {
      ctx.beginPath();
      ctx.moveTo(X(viFrom), Y(tri.hiAt(fromFull)));
      ctx.lineTo(X(viEnd), Y(tri.hiAt(tri.endI)));
      ctx.lineTo(X(viEnd), Y(tri.loAt(tri.endI)));
      ctx.lineTo(X(viFrom), Y(tri.loAt(fromFull)));
      ctx.closePath(); ctx.fillStyle = 'rgba(124,58,237,.07)'; ctx.fill();
      ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 1.6; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(X(viFrom), Y(tri.hiAt(fromFull))); ctx.lineTo(X(viCap), Y(tri.hiAt(capFull))); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(viFrom), Y(tri.loAt(fromFull))); ctx.lineTo(X(viCap), Y(tri.loAt(capFull))); ctx.stroke();
      ctx.fillStyle = '#7c3aed'; ctx.font = '600 11px system-ui';
      ctx.fillText(tri.type, X(viFrom) + 4, Math.max(pad.t + 10, Y(tri.hiAt(fromFull)) - 6));
    }
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
  // zone labels live on the right side of the plot, right-aligned against the
  // price axis (same vertical de-collision as before)
  ctx.textAlign = 'right';
  for (const L of zLabels) {
    const z = L.z, y = Y(z.v);
    ctx.strokeStyle = z.c; ctx.lineWidth = z.dash.length ? 1.2 : 1.8;
    ctx.setLineDash(z.dash); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = z.c;
    ctx.fillText(`${z.label ? z.label + ' ' : ''}${z.v.toFixed(dec(state.symbol))}`, W - pad.r - 4, L.ly);
  }
  ctx.textAlign = 'left';
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
  // remember this frame's geometry so the candle-hover tooltip can map the
  // mouse back to a candle, and re-draw the hover highlight on every repaint
  // (live ticks redraw constantly; the highlight must survive them)
  state._geom = { bs, startIdx, cw, pad, W, H, lo, hi };
  if (state._hoverI != null && state._hoverI < bs.length) {
    const hx = X(state._hoverI);
    ctx.fillStyle = 'rgba(79,70,229,.08)';
    ctx.fillRect(hx - cw / 2, pad.t, cw, H - pad.t - pad.b);
    ctx.strokeStyle = 'rgba(79,70,229,.55)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, Y(bs[state._hoverI].h)); ctx.lineTo(hx, Y(bs[state._hoverI].l));
    ctx.stroke();
    ctx.strokeRect(hx - bw / 2 - 1, Y(bs[state._hoverI].h), bw + 2, Y(bs[state._hoverI].l) - Y(bs[state._hoverI].h));
  }
  // last closed bar verdict — large letters across the top of the plot. It
  // names the bar that just finished (the small line underneath says which
  // bar and how far up its range the close landed) and stays up until the
  // next bar closes and replaces it.
  const verdict = lastClosedVerdict(bars, state.tf);
  if (verdict) {
    const label = verdict.inTop ? 'CLOSED IN TOP' : 'CLOSED IN BOTTOM';
    const plotW = W - pad.l - pad.r;
    let fs = 30;
    ctx.font = `800 ${fs}px system-ui`;
    const tw = ctx.measureText(label).width;
    if (tw > plotW - 16) { fs = Math.max(15, Math.floor(fs * (plotW - 16) / tw)); ctx.font = `800 ${fs}px system-ui`; }
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(255,255,255,.9)'; ctx.shadowBlur = 7;
    ctx.fillStyle = verdict.inTop ? '#16a34a' : '#dc2626';
    ctx.fillText(label, pad.l + plotW / 2, pad.t + fs + 4);
    ctx.shadowBlur = 0;
    ctx.font = '600 11px system-ui'; ctx.fillStyle = '#5b6478';
    ctx.fillText(`${timeLblOf(verdict.bar.t, state.tf)} PT bar · close ${Math.round(verdict.pos * 100)}% of the way up its range`, pad.l + plotW / 2, pad.t + fs + 22);
    ctx.textAlign = 'left';
  }
  const isLive = state.wsLive && state.data.symbols[state.symbol]?.market === 'crypto';
  $('spanpill').textContent = `${state.symbol} · ${state.tf} · ${isLive ? '● LIVE' : 'delayed ~15 min'} · scroll to zoom, drag to pan, double-click to reset, hover a candle for a plain-English read`;
  $('legend').innerHTML = `<span><b style="color:#f59e0b">—</b> EMA12</span><span><b style="color:#4f46e5">—</b> EMA26</span><span><b style="color:rgba(79,70,229,.45)">- -</b> ATR cone</span><span><b style="color:#16a34a">—</b> support/target</span><span><b style="color:#dc2626">—</b> resistance/stop</span>` +
    ((state.kalshi && state.kalshi.sym === state.symbol && state.kalshi.v != null) ? `<span><b style="color:#111">- -</b> Kalshi target</span>` : ``) +
    (liveV != null ? `<span><b style="color:#2563eb">- -</b> live price</span>` : ``) +
    (tri ? `<span><b style="color:#7c3aed">—</b> triangle pattern</span>` : ``);
}

/* ---------------- candle hover: plain-English read of one candle ---------------- */
// Explains a single candle the way you'd explain it to a friend: where price
// started and ended, how far it swung, what the thin lines (wicks) mean, and
// whether the move was bigger or quieter than the candles around it. It only
// describes what already happened — it never predicts or advises.
function explainCandle(bars, gi) {
  const b = bars[gi];
  if (!b) return null;
  const sym = state.symbol;
  const tfSec = TFSEC[state.tf] || 900;
  const durName = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '6h': '6 hours', '12h': '12 hours', '1d': 'this day' }[state.tf] || 'period';
  const chg = b.c - b.o;
  const chgPct = b.o ? (chg / b.o) * 100 : 0;
  const range = b.h - b.l;
  const body = Math.abs(chg);
  const upper = b.h - Math.max(b.o, b.c);
  const lower = Math.min(b.o, b.c) - b.l;
  const dir = chg > 0 ? 'up' : chg < 0 ? 'dn' : 'flat';
  const badgeTxt = dir === 'flat' ? 'FLAT' : `${dir === 'up' ? 'UP' : 'DOWN'} ${chg >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`;
  const fmtT = (t) => new Date(t * 1000).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Los_Angeles' });
  const dayStr = new Date(b.t * 1000).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Los_Angeles' });
  const title = state.tf === '1d' ? dayStr : `${dayStr} · ${fmtT(b.t)} – ${fmtT(b.t + tfSec)} PT`;
  const name = state.data?.symbols[sym]?.name || sym;
  const parts = [];
  if (range <= 0) {
    parts.push(`Price sat completely still during this candle — it opened and closed at ${fmtP(sym, b.c)} and never moved.`);
  } else {
    parts.push(dir === 'flat'
      ? `During these ${durName}, price ended almost exactly where it started (${fmtP(sym, b.c)}), even though it swung between ${fmtP(sym, b.l)} and ${fmtP(sym, b.h)} along the way.`
      : `During these ${durName}, price went ${dir === 'up' ? 'up' : 'down'} — it started at ${fmtP(sym, b.o)} and ended at ${fmtP(sym, b.c)}, a move of ${chg >= 0 ? '+' : '−'}${fmtP(sym, Math.abs(chg))} (${chg >= 0 ? '+' : ''}${chgPct.toFixed(2)}%). Along the way it reached as high as ${fmtP(sym, b.h)} and as low as ${fmtP(sym, b.l)} — a total swing of ${fmtP(sym, range)}.`);
    if (body / range >= 0.7)
      parts.push(`Almost the whole candle is solid, which just means ${dir === 'dn' ? 'sellers' : 'buyers'} stayed in charge the whole time and the other side barely pushed back.`);
    else if (body / range <= 0.2 && dir !== 'flat')
      parts.push(`The solid part of the candle is tiny compared with the swing — buyers and sellers fought hard, but neither side really won this one. That kind of tug-of-war often means people are undecided.`);
    if (upper / range >= 0.4 && upper > body)
      parts.push(`See the long thin line sticking out of the top? Buyers pushed the price up to ${fmtP(sym, b.h)}, but sellers dragged it back down before the candle closed — the high didn't hold.`);
    if (lower / range >= 0.4 && lower > body)
      parts.push(`See the long thin line poking out of the bottom? Sellers pushed the price down to ${fmtP(sym, b.l)}, but buyers pulled it back up before the close — the low didn't hold.`);
    // how this candle compares with the ones before it
    const prevs = bars.slice(Math.max(0, gi - 20), gi);
    if (prevs.length >= 5) {
      const avgRange = prevs.reduce((a, p) => a + (p.h - p.l), 0) / prevs.length;
      if (avgRange > 0) {
        const rr = range / avgRange;
        if (rr >= 1.6) parts.push(`That swing was much bigger than usual — about ${rr.toFixed(1)} times the size of the candles right before it. Something got people's attention during this one.`);
        else if (rr <= 0.55) parts.push(`This was a quiet candle — its swing was only about ${Math.round(rr * 100)}% of the usual size lately. Not much happened.`);
      }
      const withVol = prevs.filter((p) => p.v > 0);
      if (b.v > 0 && withVol.length >= 5) {
        const avgVol = withVol.reduce((a, p) => a + p.v, 0) / withVol.length;
        if (avgVol > 0) {
          const vr = b.v / avgVol;
          if (vr >= 1.6) parts.push(`Trading was busier than usual, too — about ${vr.toFixed(1)} times the typical amount changed hands.`);
          else if (vr <= 0.6) parts.push(`Trading was thin — only about ${Math.round(vr * 100)}% of the usual amount changed hands, so fewer people were involved in this move.`);
        }
      }
    }
  }
  const prev = gi > 0 ? bars[gi - 1] : null;
  if (prev && range > 0) {
    if (b.h > prev.h && b.l < prev.l) parts.push(`It also stretched both above and below the candle before it — a wider battle than the previous one.`);
    else if (b.h > prev.h && chg > 0) parts.push(`It also reached higher than the candle before it — the upward push carried a bit further.`);
    else if (b.l < prev.l && chg < 0) parts.push(`It also dipped lower than the candle before it — the downward push carried a bit further.`);
  }
  const stillForming = gi === bars.length - 1 && (b.t + tfSec) * 1000 > Date.now();
  if (stillForming) parts.push(`Heads up: this is the candle that's still happening right now, so its shape can keep changing until the ${durName === 'this day' ? 'day' : durName} is over.`);
  const html = `<div class="ct-head"><b>${name} · ${title}</b><span class="ct-badge ${dir}">${badgeTxt}</span></div>` +
    `<div class="ct-ohlc">Open ${fmtP(sym, b.o)} · High ${fmtP(sym, b.h)} · Low ${fmtP(sym, b.l)} · Close ${fmtP(sym, b.c)}</div>` +
    parts.map((p) => `<p>${p}</p>`).join('') +
    `<div class="ct-foot">Just what happened in this window — it doesn't say what happens next.</div>`;
  return html;
}
function hideCandleTip() {
  const tip = $('candleTip');
  if (tip) tip.style.display = 'none';
  state._hoverI = null;
  state._triHover = false;
}
// position the tooltip next to the mouse, flipped when it would overflow
function placeTip(tip, x, y, rect) {
  let left = x + 16, top = y + 16;
  if (left + tip.offsetWidth > rect.width - 6) left = x - tip.offsetWidth - 16;
  if (top + tip.offsetHeight > rect.height - 6) top = y - tip.offsetHeight - 16;
  tip.style.left = Math.max(2, left) + 'px';
  tip.style.top = Math.max(2, top) + 'px';
}
/* Hovering the triangle itself: anywhere along either trendline shows that
   line's price at that exact spot; hovering the tip (apex) shows the price
   where the two lines meet, and when they would meet. */
function triHoverAt(g, x, y) {
  const tri = state._tri;
  if (!tri || !state.showTriangles) return null;
  const plotSlots = (g.W - g.pad.l - g.pad.r) / g.cw;
  const fromFull = Math.max(tri.startI, g.startIdx);
  const capFull = Math.min(tri.apexI, g.startIdx + plotSlots - 1);
  const gx = g.startIdx + (x - g.pad.l) / g.cw - 0.5;
  if (gx < fromFull - 0.5 || gx > capFull + 0.5) return null;
  const Yp = (v) => g.pad.t + (1 - (v - g.lo) / (g.hi - g.lo)) * (g.H - g.pad.t - g.pad.b);
  // the tip hotspot is the visible pointed end of the lines: when the exact
  // crossing sits a little past the right edge, the lines still visibly
  // converge to the edge — hovering that end counts as hovering the tip
  const effI = Math.min(tri.apexI, capFull);
  const effPrice = (tri.hiAt(effI) + tri.loAt(effI)) / 2;
  const ax = g.pad.l + (effI - g.startIdx + 0.5) * g.cw, ay = Yp(effPrice);
  // forgiving zone around the pointed end — the lines converge to a sliver
  // there, so a tight radius would make the tip nearly impossible to hit
  if (Math.abs(x - ax) <= 24 && Math.abs(y - ay) <= 17)
    return { kind: 'apex', tri, price: tri.hiAt(tri.apexI) };
  const dHi = Math.abs(y - Yp(tri.hiAt(gx))), dLo = Math.abs(y - Yp(tri.loAt(gx)));
  if (Math.min(dHi, dLo) <= 12) {
    // snapped to the candle column under the pointer: the read shows that
    // candle's time and the line's price at that candle (no in-between
    // minutes like 11:46), and the wider band keeps the box from dropping
    // out while sliding along the line
    const part = dHi <= dLo ? 'hi' : 'lo';
    const snapI = Math.max(Math.ceil(fromFull), Math.min(Math.round(gx), Math.floor(capFull)));
    const barsArr = state.liveBars || [];
    let tLbl = '';
    if (barsArr.length) {
      const tfS = TFSEC[state.tf] || 900;
      const tt = snapI < barsArr.length ? barsArr[snapI].t
        : barsArr[barsArr.length - 1].t + (snapI - (barsArr.length - 1)) * tfS;
      tLbl = timeLblOf(tt, state.tf) + ' PT';
    }
    return { kind: part, tri, price: part === 'hi' ? tri.hiAt(snapI) : tri.loAt(snapI), tLbl };
  }
  return null;
}
function showTriTip(cv, hit, x, y, rect) {
  const tip = $('candleTip');
  if (!tip) return;
  const { tri } = hit;
  const price = fmtP(state.symbol, hit.price);
  let head, body;
  if (hit.kind === 'apex') {
    head = `${tri.type} · the tip`;
    const tfSec = TFSEC[state.tf] || 900;
    const lastBar = state.liveBars[tri.endI];
    const when = lastBar ? new Date((lastBar.t + (tri.apexI - tri.endI) * tfSec) * 1000)
      .toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Los_Angeles' }) + ' PT' : '';
    body = `<p>This is the tip of the triangle — the point where the ceiling line and the floor line meet. If the squeeze kept going, the two lines would cross at about <b>${price}</b>${when ? `, around ${when}` : ''}.</p>`;
  } else if (hit.kind === 'hi') {
    head = `${tri.type} · top line`;
    body = `<p>This is the top line of the triangle — the ceiling the recent highs keep bumping into. Right where you're hovering, that ceiling sits at <b>${price}</b>${hit.tLbl ? ` — that spot on the line is at <b>${hit.tLbl}</b>` : ''}.</p>`;
  } else {
    head = `${tri.type} · bottom line`;
    body = `<p>This is the bottom line of the triangle — the floor the recent lows keep bouncing off. Right where you're hovering, that floor sits at <b>${price}</b>${hit.tLbl ? ` — that spot on the line is at <b>${hit.tLbl}</b>` : ''}.</p>`;
  }
  tip.innerHTML = `<div class="ct-head"><b>${head}</b><span class="ct-badge flat">${price}</span></div>` + body +
    `<div class="ct-foot">The price of the line itself at this spot — the lines describe the pattern, they don't predict where price goes next.</div>`;
  tip.style.display = 'block';
  if (state._hoverI != null) { state._hoverI = null; drawChart(state.liveBars, analyze(state.liveBars, state.mode)); }
  state._triHover = true;
  placeTip(tip, x, y, rect);
}

/* ---------------- mouse: wheel zoom, drag pan, double-click reset ---------------- */
(function initMouse() {
  const cv = $('chart');
  let dragX = null, dragOff = 0;
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    hideCandleTip();
    const cur = state.view.n || defaultN(state.tf);
    const next = Math.round(cur * (e.deltaY > 0 ? 1.18 : 1 / 1.18));
    state.view.n = Math.max(30, Math.min(state.liveBars.length, next));
    drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => { hideCandleTip(); dragX = e.clientX; dragOff = state.view.off; cv.style.cursor = 'grabbing'; });
  window.addEventListener('mousemove', (e) => {
    if (dragX == null || !state.liveBars.length) return;
    const n = state.view.n || defaultN(state.tf);
    const cw = (cv.clientWidth - 72) / n;
    state.view.off = Math.max(0, Math.round(dragOff + (dragX - e.clientX) / Math.max(cw, 1)));
    drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  });
  window.addEventListener('mouseup', () => { dragX = null; cv.style.cursor = 'crosshair'; });
  cv.addEventListener('dblclick', () => {
    hideCandleTip();
    state.view = { n: null, off: 0 };
    drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  });
  // hover: the triangle lines/tip get priced first; otherwise map the mouse
  // x to a candle and explain it in plain words
  cv.addEventListener('mousemove', (e) => {
    if (dragX != null || !state._geom || !state.liveBars.length) return;
    const g = state._geom, tip = $('candleTip');
    if (!tip) return;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x >= g.pad.l && x <= g.W - g.pad.r && y >= g.pad.t && y <= g.H - g.pad.b) {
      const hit = triHoverAt(g, x, y);
      if (hit) { showTriTip(cv, hit, x, y, rect); return; }
    }
    if (state._triHover) hideCandleTip(); // slid off the lines — back to candle hover
    const i = Math.round((x - g.pad.l) / g.cw - 0.5);
    if (i < 0 || i >= g.bs.length || y < g.pad.t || y > g.H - g.pad.b) {
      if (state._hoverI != null) { hideCandleTip(); drawChart(state.liveBars, analyze(state.liveBars, state.mode)); }
      return;
    }
    if (i !== state._hoverI) {
      const html = explainCandle(state.liveBars, g.startIdx + i);
      if (!html) { hideCandleTip(); return; }
      state._hoverI = i;
      tip.innerHTML = html;
      tip.style.display = 'block';
      drawChart(state.liveBars, analyze(state.liveBars, state.mode));
    }
    placeTip(tip, x, y, rect);
  });
  cv.addEventListener('mouseleave', () => {
    if (state._hoverI != null || state._triHover) { const had = state._hoverI != null; hideCandleTip(); if (had) drawChart(state.liveBars, analyze(state.liveBars, state.mode)); }
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
  if (newCandle || now - state.lastDraw > 500) { // a bar close redraws NOW, never waits on the 500ms tick throttle
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

/* Bar-close snap refresh: even when no trade prints in the first seconds of
   a new bar, land a REST refresh just after each bar boundary so the
   CLOSED IN TOP / CLOSED IN BOTTOM verdict flips the moment the bar
   finishes. Re-arms itself every bar and follows timeframe switches (it
   re-reads state.tf each round). No-op for stocks/forex — their verdict
   updates when the next published file lands instead. */
function scheduleBoundaryRefresh() {
  const sec = TFSEC[state.tf] || 900;
  const nowS = Date.now() / 1000;
  const nextClose = (Math.floor(nowS / sec) + 1) * sec;
  setTimeout(() => { refreshCryptoLive(); scheduleBoundaryRefresh(); }, Math.max(300, (nextClose - nowS) * 1000 + 300));
}

/* ---------------- init ---------------- */
document.querySelectorAll('#modes button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#modes button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state.mode = b.dataset.mode;
    // scalp → fast frames, swing → slow frames
    state.tf = state.mode === 'scalp' ? '5m' : '1d';
    hideCandleTip();
    buildSyms(); render();
  };
});
/* triangle pattern toggle: remembered in this browser */
const triBtn = $('triBtn');
if (triBtn) {
  const syncTriBtn = () => {
    triBtn.textContent = `Triangles: ${state.showTriangles ? 'On' : 'Off'}`;
    triBtn.classList.toggle('on', state.showTriangles);
  };
  triBtn.onclick = () => {
    state.showTriangles = !state.showTriangles;
    try { localStorage.setItem('chartlens.triangles', state.showTriangles ? '1' : '0'); } catch {}
    syncTriBtn();
    drawChart(state.liveBars, analyze(state.liveBars, state.mode));
  };
  syncTriBtn();
}
window.addEventListener('resize', () => drawChart(state.liveBars, analyze(state.liveBars, state.mode)));
(async () => {
  try { await loadData(); connectWS(); scheduleBoundaryRefresh(); jRender(); setInterval(pollData, 60000); setInterval(refreshCryptoLive, 60000); setInterval(refreshKalshiTarget, 60000); }
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
