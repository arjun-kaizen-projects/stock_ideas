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

// Record first signal date for each new signal ticker (never overwrites existing)
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
      }
    }
    if (changed) await redisCmd('SET', SIGNALS_KEY, JSON.stringify(existing));
  } catch(e) {
    console.error('[store] recordSignalDates failed:', e.message);
  }
}

module.exports = { enabled, load, save, loadSignalDates, recordSignalDates };
