'use strict';
const fetch = require('node-fetch');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KEY         = 'sandisk_radar_results';

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

module.exports = { enabled, load, save };
