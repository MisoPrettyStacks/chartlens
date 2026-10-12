// ChartLens data publisher: fetches real candles for crypto (Coinbase),
// stocks + forex (Yahoo Finance) — all free, no API keys — and publishes
// bars.json to the `data` branch every 15 minutes. No placeholders, no demo
// data: if a fetch fails, that symbol/timeframe is omitted, never faked.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const SYMBOLS = [
  // crypto — Coinbase public candles
  { id: 'BTC-USD', market: 'crypto', name: 'Bitcoin', src: 'coinbase' },
  { id: 'ETH-USD', market: 'crypto', name: 'Ethereum', src: 'coinbase' },
  { id: 'XRP-USD', market: 'crypto', name: 'XRP', src: 'coinbase' },
  { id: 'SOL-USD', market: 'crypto', name: 'Solana', src: 'coinbase' },
  // stocks — Yahoo Finance
  { id: 'AAPL', market: 'stocks', name: 'Apple', src: 'yahoo' },
  { id: 'NVDA', market: 'stocks', name: 'Nvidia', src: 'yahoo' },
  { id: 'TSLA', market: 'stocks', name: 'Tesla', src: 'yahoo' },
  { id: 'MSFT', market: 'stocks', name: 'Microsoft', src: 'yahoo' },
  { id: 'AMD', market: 'stocks', name: 'AMD', src: 'yahoo' },
  { id: 'SPY', market: 'stocks', name: 'S&P 500 ETF', src: 'yahoo' },
  // forex — Yahoo Finance
  { id: 'EURUSD=X', market: 'forex', name: 'EUR / USD', src: 'yahoo' },
  { id: 'GBPUSD=X', market: 'forex', name: 'GBP / USD', src: 'yahoo' },
  { id: 'USDJPY=X', market: 'forex', name: 'USD / JPY', src: 'yahoo' },
];

const TFS = [
  { tf: '5m', cb: 300, yh: ['5m', '5d'] },
  { tf: '15m', cb: 900, yh: ['15m', '1mo'] },
  { tf: '1h', cb: 3600, yh: ['1h', '3mo'] },
  { tf: '1d', cb: 86400, yh: ['1d', '1y'] },
];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchT(url, ms = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: c.signal });
    if (!r.ok) return null;
    return r;
  } catch { return null; }
  finally { clearTimeout(t); }
}

// [t, o, h, l, c, v] — t in seconds
async function coinbaseCandles(product, gran) {
  const r = await fetchT(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}`);
  if (!r) return null;
  const raw = await r.json();
  if (!Array.isArray(raw) || !raw.length) return null;
  // raw: [time, low, high, open, close, volume]
  return raw.map(([t, l, h, o, c, v]) => [t, o, h, l, c, v]).sort((a, b) => a[0] - b[0]);
}

async function yahooCandles(symbol, interval, range) {
  const r = await fetchT(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`);
  if (!r) return null;
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  const ts = res?.timestamp;
  if (!res || !q || !Array.isArray(ts) || !ts.length) return null;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push([ts[i], +o.toFixed(5), +h.toFixed(5), +l.toFixed(5), +c.toFixed(5), q.volume?.[i] ?? null]);
  }
  return out.length > 10 ? out : null;
}

async function publishAPI(files) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || 'MisoPrettyStacks/chartlens';
  if (!token) throw new Error('GITHUB_TOKEN missing');
  const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'chartlens' };
  const gh = async (method, path, payload) => {
    const r = await fetch(`https://api.github.com${path}`, {
      method, headers: H, body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${txt.slice(0, 120)}`);
    return txt ? JSON.parse(txt) : null;
  };
  let base = null;
  try { base = (await gh('GET', `/repos/${repo}/git/ref/heads/data`)).object.sha; } catch { base = null; }
  const tree = await gh('POST', `/repos/${repo}/git/trees`, {
    base_tree: base || undefined,
    tree: await Promise.all(Object.entries(files).map(async ([path, content]) => {
      const blob = await gh('POST', `/repos/${repo}/git/blobs`, {
        content: Buffer.from(content).toString('base64'), encoding: 'base64',
      });
      return { path, mode: '100644', type: 'blob', sha: blob.sha };
    })),
  });
  const commit = await gh('POST', `/repos/${repo}/git/commits`, {
    message: `data ${new Date().toISOString().slice(0, 16)}`, tree: tree.sha, parents: base ? [base] : [],
  });
  if (base) await gh('PATCH', `/repos/${repo}/git/refs/heads/data`, { sha: commit.sha });
  else await gh('POST', `/repos/${repo}/git/refs`, { ref: 'refs/heads/data', sha: commit.sha });
  log('published @', commit.sha.slice(0, 8));
}

async function main() {
  const out = { generated: new Date().toISOString(), symbols: {} };
  for (const s of SYMBOLS) {
    const tfs = {};
    for (const { tf, cb, yh } of TFS) {
      let bars = null;
      try {
        bars = s.src === 'coinbase' ? await coinbaseCandles(s.id, cb) : await yahooCandles(s.id, yh[0], yh[1]);
      } catch (e) { log('fetch fail', s.id, tf, e.message); }
      if (bars) { tfs[tf] = bars; log('ok', s.id, tf, bars.length); }
      else log('MISSING', s.id, tf, '(omitted — never faked)');
      await sleep(s.src === 'yahoo' ? 400 : 200);
    }
    if (Object.keys(tfs).length) out.symbols[s.id] = { market: s.market, name: s.name, tfs };
  }
  await publishAPI({ 'bars.json': JSON.stringify(out) });
  log('done, symbols:', Object.keys(out.symbols).length);
}
main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
