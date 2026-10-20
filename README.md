# Chart-Lenz

 chart analyzer — live candles, transparent rule-based signals, scalp & swing modes for crypto, stocks, and forex.

**How it works:** a scheduled publisher fetches real candles every 15 minutes (Coinbase for crypto, Yahoo Finance for stocks/forex — all free, no API keys) to the `data` branch. The page renders live candlestick charts and runs a deterministic technical-analysis engine: EMA trend, RSI, MACD, Bollinger, ATR, swing support/resistance. Every signal lists its reasons with the actual indicator values. Nothing is predicted, backfilled, or hallucinated.

**Features**
- Crypto (BTC, ETH, XRP, SOL), stocks (AAPL, NVDA, TSLA, MSFT, AMD, SPY), forex (EUR/USD, GBP/USD, USD/JPY)
- Timeframes 5m / 15m / 1h / 1d · Scalp & Swing modes
- Triangles
- Entry / stop-loss / target zones drawn on the chart (ATR-based)
- Position-size risk calculator
- Chart screenshot upload + optional vision-AI readout via your own free Gemini key (runs in your browser, key never leaves it)
- Trade journal (localStorage)

**Research only — not financial advice.** Signals describe the chart; they do not predict the future.
