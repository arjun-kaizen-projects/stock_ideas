'use strict';
require('dotenv').config();
const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');
const fs       = require('fs');
const store    = require('./lib/store');
const { runDailyScan } = require('./lib/scanner');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data/results.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

/* ── API: get results ── */
app.get('/api/results', async (req, res) => {
  try {
    let data = await store.load();
    if (!data) {
      if (!fs.existsSync(DATA)) return res.json({ lastUpdated: null, filings: [], totalScanned: 0 });
      data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    }
    const min = parseInt(req.query.minScore || '0', 10);
    if (min > 0) data.filings = data.filings.filter(f => (f.signalScore || 0) >= min);
    // Attach first-signal dates so frontend can use them for return calculations
    data.signalFirstDates = await store.loadSignalDates();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/signal-dates', async (req, res) => {
  try {
    res.json(await store.loadSignalDates());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── API: trigger scan manually (POST from app) ── */
app.post('/api/scan', async (req, res) => {
  const secret = req.headers['x-scan-secret'];
  if (process.env.SCAN_SECRET && secret !== process.env.SCAN_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await runDailyScan();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Browser-friendly GET scan trigger ── */
app.get('/run-scan', async (req, res) => {
  const secret = req.query.secret || '';
  if (process.env.SCAN_SECRET && secret !== process.env.SCAN_SECRET)
    return res.send('❌ Wrong secret. Add ?secret=YOUR_SECRET to the URL.');
  res.setHeader('Content-Type', 'text/html');
  res.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Next10X Radar — Running Scan</title>
    <style>body{font-family:monospace;background:#0e0e0e;color:#c9932a;padding:2rem;font-size:14px}
    h2{color:#f5f2eb;margin-bottom:1rem}.done{color:#4caf50;font-size:1.2rem;margin-top:1rem}</style>
    </head><body>
    <h2>📡 Next10X Radar — SEC Scan Running</h2>
    <p>Fetching today's EDGAR filings and analyzing with Claude…</p>
    <p style="color:#6b6b6b">This page will update when complete. Do not close this tab.</p>
    <pre id="log">`);
  try {
    // Stream log output to browser
    const origLog   = console.log.bind(console);
    const origError = console.error.bind(console);
    console.log = (...args) => {
      origLog(...args);
      try { res.write(args.join(' ') + '\n'); } catch(_) {}
    };
    console.error = (...args) => {
      origError(...args);
      try { res.write('ERR: ' + args.join(' ') + '\n'); } catch(_) {}
    };
    const result = await runDailyScan();
    console.log   = origLog;
    console.error = origError;
    res.write(`</pre><div class="done">✅ Scan complete! ${result.newCount || 0} new filings analyzed. ${result.totalCount || 0} total in database.</div>`);
    res.write(`<p style="margin-top:1rem"><a href="/" style="color:#c9932a">← Go back to the dashboard</a></p>`);
  } catch(e) {
    res.write(`\n❌ Error: ${e.message}`);
  }
  res.write('</body></html>');
  res.end();
});

/* ── API: stock price history (proxy to Yahoo Finance) ── */
app.get('/api/stock-history', async (req, res) => {
  const { ticker, from } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const period1 = from ? Math.floor(new Date(from).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400 * 365;
    const period2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data' });
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const prices = timestamps.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] })).filter(p => p.close != null);
    res.json({ ticker, prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── API: scan status ── */
app.get('/api/scan-status', (_, res) => {
  const { isRunning, startedAt, progress } = require('./lib/scanner').getScanStatus();
  res.json({ isRunning, startedAt, progress });
});

/* ── API: health ── */
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ── Schedule: run every weekday at 7am ET ── */
cron.schedule('0 12 * * 1-5', async () => {
  console.log('[CRON] Running scheduled daily scan');
  try { await runDailyScan(); }
  catch(e) { console.error('[CRON] Scan failed:', e.message); }
}, { timezone: 'America/New_York' });

app.listen(PORT, () => {
  console.log(`Next10X Radar running on http://localhost:${PORT}`);
  console.log('Scan scheduled: weekdays 7am ET');
  // Run a scan on every startup so deploys always pull fresh data
  setTimeout(() => {
    console.log('[STARTUP] Running post-deploy scan…');
    runDailyScan().catch(e => console.error('[STARTUP] Scan failed:', e.message));
  }, 5000);
});
