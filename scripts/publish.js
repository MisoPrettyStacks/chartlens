// ChartLens data publisher: fetches real candles for crypto (Coinbase),
// stocks + forex (Yahoo Finance) — all free, no API keys — and publishes
// bars.json to the `data` branch every 15 minutes. No placeholders, no demo
// data: if a fetch fails, that symbol/timeframe is omitted, never faked.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const CORE_TFS = ['5m', '15m', '1h', '1d'];
const EXT_TFS = ['15m', '1h', '1d']; // extended lookup universe skips 5m (rate-limit friendly)

const SYMBOLS = [
  // crypto — Coinbase public candles
  { id: 'BTC-USD', market: 'crypto', name: 'Bitcoin', src: 'coinbase', tfs: CORE_TFS },
  { id: 'ETH-USD', market: 'crypto', name: 'Ethereum', src: 'coinbase', tfs: CORE_TFS },
  { id: 'XRP-USD', market: 'crypto', name: 'XRP', src: 'coinbase', tfs: CORE_TFS },
  { id: 'SOL-USD', market: 'crypto', name: 'Solana', src: 'coinbase', tfs: CORE_TFS },
  // stocks — Yahoo Finance (core: full TFs)
  { id: 'AAPL', market: 'stocks', name: 'Apple', src: 'yahoo', tfs: CORE_TFS },
  { id: 'NVDA', market: 'stocks', name: 'Nvidia', src: 'yahoo', tfs: CORE_TFS },
  { id: 'TSLA', market: 'stocks', name: 'Tesla', src: 'yahoo', tfs: CORE_TFS },
  { id: 'MSFT', market: 'stocks', name: 'Microsoft', src: 'yahoo', tfs: CORE_TFS },
  { id: 'AMD', market: 'stocks', name: 'AMD', src: 'yahoo', tfs: CORE_TFS },
  { id: 'SPY', market: 'stocks', name: 'S&P 500 ETF', src: 'yahoo', tfs: CORE_TFS },
  // stocks — extended lookup universe
  { id: 'GOOGL', market: 'stocks', name: 'Alphabet', src: 'yahoo', tfs: EXT_TFS },
  { id: 'AMZN', market: 'stocks', name: 'Amazon', src: 'yahoo', tfs: EXT_TFS },
  { id: 'META', market: 'stocks', name: 'Meta', src: 'yahoo', tfs: EXT_TFS },
  { id: 'NFLX', market: 'stocks', name: 'Netflix', src: 'yahoo', tfs: EXT_TFS },
  { id: 'AVGO', market: 'stocks', name: 'Broadcom', src: 'yahoo', tfs: EXT_TFS },
  { id: 'CRM', market: 'stocks', name: 'Salesforce', src: 'yahoo', tfs: EXT_TFS },
  { id: 'ORCL', market: 'stocks', name: 'Oracle', src: 'yahoo', tfs: EXT_TFS },
  { id: 'PLTR', market: 'stocks', name: 'Palantir', src: 'yahoo', tfs: EXT_TFS },
  { id: 'COIN', market: 'stocks', name: 'Coinbase', src: 'yahoo', tfs: EXT_TFS },
  { id: 'MSTR', market: 'stocks', name: 'Strategy', src: 'yahoo', tfs: EXT_TFS },
  { id: 'JPM', market: 'stocks', name: 'JPMorgan', src: 'yahoo', tfs: EXT_TFS },
  { id: 'XOM', market: 'stocks', name: 'Exxon', src: 'yahoo', tfs: EXT_TFS },
  { id: 'WMT', market: 'stocks', name: 'Walmart', src: 'yahoo', tfs: EXT_TFS },
  { id: 'DIS', market: 'stocks', name: 'Disney', src: 'yahoo', tfs: EXT_TFS },
  { id: 'NKE', market: 'stocks', name: 'Nike', src: 'yahoo', tfs: EXT_TFS },
  { id: 'PYPL', market: 'stocks', name: 'PayPal', src: 'yahoo', tfs: EXT_TFS },
  { id: 'SHOP', market: 'stocks', name: 'Shopify', src: 'yahoo', tfs: EXT_TFS },
  { id: 'UBER', market: 'stocks', name: 'Uber', src: 'yahoo', tfs: EXT_TFS },
  { id: 'ABNB', market: 'stocks', name: 'Airbnb', src: 'yahoo', tfs: EXT_TFS },
  { id: 'SNOW', market: 'stocks', name: 'Snowflake', src: 'yahoo', tfs: EXT_TFS },
  { id: 'CRWD', market: 'stocks', name: 'CrowdStrike', src: 'yahoo', tfs: EXT_TFS },
  { id: 'PANW', market: 'stocks', name: 'Palo Alto', src: 'yahoo', tfs: EXT_TFS },
  { id: 'MRNA', market: 'stocks', name: 'Moderna', src: 'yahoo', tfs: EXT_TFS },
  { id: 'PFE', market: 'stocks', name: 'Pfizer', src: 'yahoo', tfs: EXT_TFS },
  { id: 'JNJ', market: 'stocks', name: 'J&J', src: 'yahoo', tfs: EXT_TFS },
  { id: 'KO', market: 'stocks', name: 'Coca-Cola', src: 'yahoo', tfs: EXT_TFS },
  { id: 'PEP', market: 'stocks', name: 'PepsiCo', src: 'yahoo', tfs: EXT_TFS },
  { id: 'MCD', market: 'stocks', name: "McDonald's", src: 'yahoo', tfs: EXT_TFS },
  { id: 'SBUX', market: 'stocks', name: 'Starbucks', src: 'yahoo', tfs: EXT_TFS },
  { id: 'F', market: 'stocks', name: 'Ford', src: 'yahoo', tfs: EXT_TFS },
  { id: 'GM', market: 'stocks', name: 'GM', src: 'yahoo', tfs: EXT_TFS },
  { id: 'QQQ', market: 'stocks', name: 'Nasdaq 100 ETF', src: 'yahoo', tfs: EXT_TFS },
  { id: 'DIA', market: 'stocks', name: 'Dow ETF', src: 'yahoo', tfs: EXT_TFS },
  { id: 'IWM', market: 'stocks', name: 'Russell 2000 ETF', src: 'yahoo', tfs: EXT_TFS },
  // forex — Yahoo Finance
  { id: 'EURUSD=X', market: 'forex', name: 'EUR / USD', src: 'yahoo', tfs: CORE_TFS },
  { id: 'GBPUSD=X', market: 'forex', name: 'GBP / USD', src: 'yahoo', tfs: CORE_TFS },
  { id: 'USDJPY=X', market: 'forex', name: 'USD / JPY', src: 'yahoo', tfs: CORE_TFS },
  // commodities — Yahoo Finance
  { id: 'CL=F', market: 'commodities', name: 'WTI crude oil', src: 'yahoo', tfs: CORE_TFS },
];

const TFDEF = {
  '5m': { cb: 300, yh: ['5m', '5d'] },
  '15m': { cb: 900, yh: ['15m', '1mo'] },
  '1h': { cb: 3600, yh: ['1h', '3mo'] },
  '1d': { cb: 86400, yh: ['1d', '1y'] },
};

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
    for (const tf of s.tfs) {
      const { cb, yh } = TFDEF[tf];
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
