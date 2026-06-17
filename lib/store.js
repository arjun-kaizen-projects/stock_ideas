'use strict';
const fetch = require('node-fetch');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KEY         = 'sandisk_radar_results';
const SIGNALS_KEY = 'signal_first_dates';

const enabled = () => !!(REDIS_URL && REDIS_TOKEN);

async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
    timeout: 10000,
  });
  return res.json();
}

async function load() {
  if (!enabled()) return null;
  try {
    const r = await redisCmd('GET', KEY);
    return r.result ? JSON.parse(r.result) : null;
  } catch(e) {
    console.error('[store] load failed:', e.message);
    return null;
  }
}

async function save(data) {
  if (!enabled()) return false;
  try {
    await redisCmd('SET', KEY, JSON.stringify(data));
    return true;
  } catch(e) {
    console.error('[store] save failed:', e.message);
    return false;
  }
}

// Load the first-signal-date registry { TICKER: "YYYY-MM-DD", ... }
async function loadSignalDates() {
  if (!enabled()) return {};
  try {
    const r = await redisCmd('GET', SIGNALS_KEY);
    return r.result ? JSON.parse(r.result) : {};
  } catch(e) {
    console.error('[store] loadSignalDates failed:', e.message);
    return {};
  }
}

// PERMANENT RECORD — DO NOT DELETE, EXPIRE, OR OVERWRITE EXISTING ENTRIES.
// This stores the date each ticker first appeared as a signal. It is the source
// of truth for return calculations. Entries are append-only: once a ticker's
// first date is set it is never changed, even if the ticker appears again years later.
// The Redis key has no TTL — it must live forever.
async function recordSignalDates(filings) {
  if (!enabled()) return;
  try {
    const existing = await loadSignalDates();
    let changed = false;
    for (const f of filings) {
      if (!f.ticker || !f.filedDate) continue;
      const date = (f.filedDate||'').substring(0, 10);
      if (!existing[f.ticker]) {
        existing[f.ticker] = date;
        changed = true;
        console.log(`[store] First signal recorded: ${f.ticker} → ${date}`);
      }
    }
    // KEEPTTL ensures no expiry is ever set on this key
    if (changed) await redisCmd('SET', SIGNALS_KEY, JSON.stringify(existing), 'KEEPTTL');
  } catch(e) {
    console.error('[store] recordSignalDates failed:', e.message);
  }
}

// Adhoc historical scans — stored with 24h TTL, never merged into main results
const ADHOC_KEY = 'sandisk_radar_adhoc';

async function loadAdhoc() {
  if (!enabled()) return [];
  try {
    const r = await redisCmd('GET', ADHOC_KEY);
    return r.result ? JSON.parse(r.result) : [];
  } catch(e) {
    console.error('[store] loadAdhoc failed:', e.message);
    return [];
  }
}

async function saveAdhoc(filings) {
  if (!enabled()) return false;
  try {
    // Merge with existing adhoc results (different dates may have been scanned)
    const existing = await loadAdhoc();
    const existingLinks = new Set(existing.map(f => f.link));
    const merged = [...filings.filter(f => !existingLinks.has(f.link)), ...existing]
      .slice(0, 500);
    // EX = expire in seconds (86400 = 24 hours)
    await redisCmd('SET', ADHOC_KEY, JSON.stringify(merged), 'EX', 86400);
    return true;
  } catch(e) {
    console.error('[store] saveAdhoc failed:', e.message);
    return false;
  }
}

module.exports = { enabled, load, save, loadSignalDates, recordSignalDates, loadAdhoc, saveAdhoc };
