'use strict';
require('dotenv').config();
const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');
const fs       = require('fs');
const store    = require('./lib/store');
const { runDailyScan, fetchQuote, score10xFeasibility } = require('./lib/scanner');
let privateStore, runPrivateScan;
try {
  privateStore   = require('./lib/private/store');
  runPrivateScan = require('./lib/private/scanner').runPrivateScan;
} catch(_) { /* private module not deployed — private features disabled */ }

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

/* ── API: one-time cleanup — remove large caps from stored results ── */
app.get('/api/cleanup-largecap', async (req, res) => {
  const secret = req.query.secret || '';
  if (process.env.SCAN_SECRET && secret !== process.env.SCAN_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  // Run async in background — return immediately
  res.json({ message: 'Cleanup started in background — check /api/results in ~2 minutes' });
  (async () => {
    try {
      // fetchQuote and score10xFeasibility imported at top of file
      const data = await store.load();
      if (!data) return;
      const MAX = 50e9;
      const filings = data.filings || [];
      // Fetch in small batches of 5 with delay to avoid Yahoo rate limits
      const BATCH = 5;
      for (let i = 0; i < filings.length; i += BATCH) {
        const batch = filings.slice(i, i + BATCH);
        await Promise.all(batch.map(async f => {
          if (f.marketCap || !f.ticker || f.ticker === 'N/A') return;
          const quote = await fetchQuote(f.ticker, f.cik).catch(() => null);
          if (quote?.marketCap) {
            const feas = score10xFeasibility(quote.marketCap);
            f.marketCap = quote.marketCap;
            f.marketCapLabel = feas.label;
            f.priceToSales = quote.priceToSales;
            f.priceToBook  = quote.priceToBook;
            f.tenxFeasibility = feas.score;
          }
        }));
        await new Promise(r => setTimeout(r, 500));
      }
      const kept = [], removed = [];
      for (const f of filings) {
        if (f.marketCap && f.marketCap > MAX) {
          removed.push(`${f.ticker} (${score10xFeasibility(f.marketCap).label})`);
        } else {
          kept.push(f);
        }
      }
      data.filings = kept;
      await store.save(data);
      console.log(`[CLEANUP] Done. Removed ${removed.length}: ${removed.join(', ')}`);
    } catch(e) { console.error('[CLEANUP] Error:', e.message); }
  })();
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
  const targetDate = req.query.date || null; // e.g. ?date=2026-05-13
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
    const result = await runDailyScan(targetDate);
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

/* ── API: adhoc historical results ── */
app.get('/api/adhoc-results', async (req, res) => {
  try {
    const filings = await store.loadAdhoc();
    res.json({ filings });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── API: remove a specific filing by ticker ── */
app.get('/api/remove-filing', async (req, res) => {
  const { ticker, company } = req.query;
  if (!ticker && !company) return res.status(400).json({ error: 'ticker or company required' });
  try {
    const data = await store.load();
    if (!data) return res.json({ removed: 0 });
    const before = data.filings.length;
    data.filings = data.filings.filter(f => {
      if (ticker && (f.ticker||'').toLowerCase() === ticker.toLowerCase()) return false;
      if (company && (f.companyName||'').toLowerCase().includes(company.toLowerCase())) return false;
      return true;
    });
    const removed = before - data.filings.length;
    await store.save(data);
    res.json({ removed, remaining: data.filings.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── API: scan status ── */
app.get('/api/scan-status', (_, res) => {
  const { isRunning, startedAt, progress } = require('./lib/scanner').getScanStatus();
  res.json({ isRunning, startedAt, progress });
});

/* ── API: health ── */
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ═══════════════════════════════════════════════════════
   PRIVATE MARKET ROUTES
   ═══════════════════════════════════════════════════════ */

const PRIVATE_DATA = path.join(__dirname, 'data/private-results.json');

/* ── API: get private market results ── */
app.get('/api/private/results', async (req, res) => {
  if (!privateStore) return res.json({ lastUpdated: null, companies: [], totalScanned: 0, ipoCandidates: [] });
  try {
    let data = await privateStore.load();
    if (!data) {
      if (!fs.existsSync(PRIVATE_DATA)) return res.json({ lastUpdated: null, companies: [], totalScanned: 0, ipoCandidates: [] });
      data = JSON.parse(fs.readFileSync(PRIVATE_DATA, 'utf8'));
    }
    const min = parseInt(req.query.minScore || '0', 10);
    if (min > 0) data.companies = data.companies.filter(c => (c.signalScore || 0) >= min);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── API: IPO candidates only ── */
app.get('/api/private/ipo-candidates', async (req, res) => {
  if (!privateStore) return res.json([]);
  try {
    let data = await privateStore.load();
    if (!data) {
      if (!fs.existsSync(PRIVATE_DATA)) return res.json([]);
      data = JSON.parse(fs.readFileSync(PRIVATE_DATA, 'utf8'));
    }
    res.json(data.ipoCandidates || data.companies?.filter(c => (c.ipoScore||0) >= 65) || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── API: private scan status ── */
app.get('/api/private/scan-status', (_, res) => {
  if (!runPrivateScan) return res.json({ isRunning: false, startedAt: null, progress: {} });
  const { isRunning, startedAt, progress } = require('./lib/private/scanner').getScanStatus();
  res.json({ isRunning, startedAt, progress });
});

/* ── Browser-friendly private scan trigger ── */
app.get('/run-private-scan', async (req, res) => {
  const secret = req.query.secret || '';
  if (process.env.SCAN_SECRET && secret !== process.env.SCAN_SECRET)
    return res.send('❌ Wrong secret.');
  const targetDate = req.query.date || null;
  const forceFull  = req.query.full === '1';
  res.setHeader('Content-Type', 'text/html');
  res.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>PrivateSignal — Running Scan</title>
    <style>body{font-family:monospace;background:#0a0f1e;color:#34d399;padding:2rem;font-size:14px}
    h2{color:#f5f2eb;margin-bottom:1rem}.done{color:#34d399;font-size:1.2rem;margin-top:1rem}</style>
    </head><body>
    <h2>🔍 PrivateSignal — Form D Scan Running</h2>
    <p>Fetching Form D filings, researching founders on LinkedIn & X, analyzing with Claude…</p>
    <p style="color:#6b7280">${forceFull ? 'Full 7-day scan.' : 'This may take 20–40 minutes.'} Do not close this tab.</p>
    <pre id="log">`);
  try {
    const origLog   = console.log.bind(console);
    const origError = console.error.bind(console);
    console.log = (...args) => { origLog(...args); try { res.write(args.join(' ') + '\n'); } catch {} };
    console.error = (...args) => { origError(...args); try { res.write('ERR: ' + args.join(' ') + '\n'); } catch {} };
    if (!runPrivateScan) throw new Error('Private scanner not available in this deployment.');
    const result = await runPrivateScan(targetDate, forceFull);
    console.log   = origLog;
    console.error = origError;
    res.write(`</pre><div class="done">✅ Done! +${result.newCount || 0} new companies analyzed. ${result.ipoCandidates || 0} IPO candidates identified.</div>`);
    res.write(`<p style="margin-top:1rem"><a href="/private.html" style="color:#34d399">← Back to Private Signal dashboard</a></p>`);
  } catch(e) {
    res.write(`\n❌ Error: ${e.message}`);
  }
  res.write('</body></html>');
  res.end();
});

/* ── Schedule: run every weekday at 7am ET ── */
cron.schedule('0 12 * * 1-5', async () => {
  console.log('[CRON] Running scheduled daily scan');
  try { await runDailyScan(); }
  catch(e) { console.error('[CRON] Scan failed:', e.message); }
}, { timezone: 'America/New_York' });

if (runPrivateScan) {
  cron.schedule('30 13 * * 1-5', async () => {
    console.log('[CRON] Running scheduled private market scan');
    try { await runPrivateScan(); }
    catch(e) { console.error('[CRON] Private scan failed:', e.message); }
  }, { timezone: 'America/New_York' });
}

app.listen(PORT, () => {
  console.log(`Next10X Radar running on http://localhost:${PORT}`);
  console.log('Scan scheduled: weekdays 7am ET');
  // Run a scan on startup only if data is stale (last scan >6 hours ago)
  // Auto-scan disabled — trigger manually via /run-scan or /run-private-scan
  console.log('[STARTUP] Ready. Trigger scans manually at /run-scan or /run-private-scan');
});
