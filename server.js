'use strict';
require('dotenv').config();
const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');
const fs       = require('fs');
const { runDailyScan } = require('./lib/scanner');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data/results.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── API: get results ── */
app.get('/api/results', (req, res) => {
  if (!fs.existsSync(DATA)) return res.json({ lastUpdated: null, filings: [], totalScanned: 0 });
  try {
    const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    // allow filter by score threshold
    const min  = parseInt(req.query.minScore || '0', 10);
    if (min > 0) data.filings = data.filings.filter(f => (f.signalScore || 0) >= min);
    res.json(data);
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
    <title>SanDisk Radar — Running Scan</title>
    <style>body{font-family:monospace;background:#0e0e0e;color:#c9932a;padding:2rem;font-size:14px}
    h2{color:#f5f2eb;margin-bottom:1rem}.done{color:#4caf50;font-size:1.2rem;margin-top:1rem}</style>
    </head><body>
    <h2>📡 SanDisk Radar — SEC Scan Running</h2>
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

/* ── API: health ── */
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ── Schedule: run every weekday at 7am ET ── */
cron.schedule('0 12 * * 1-5', async () => {
  console.log('[CRON] Running scheduled daily scan');
  try { await runDailyScan(); }
  catch(e) { console.error('[CRON] Scan failed:', e.message); }
}, { timezone: 'America/New_York' });

app.listen(PORT, () => {
  console.log(`SanDisk Radar running on http://localhost:${PORT}`);
  console.log('Scan scheduled: weekdays 7am ET');
});
