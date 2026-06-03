'use strict';
require('dotenv').config();
const fetch   = require('node-fetch');
const xml2js  = require('xml2js');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');
const store   = require('./store');

const DATA_FILE      = path.join(__dirname, '../data/results.json');
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const CONTACT_EMAIL  = process.env.CONTACT_EMAIL || 'research@sandiskradar.com';
const UA             = `SanDiskRadar/1.0 (contact: ${CONTACT_EMAIL})`;

/* ─── SEC ticker lookup (CIK → ticker) ────────────────────────────────────── */
let _tickerMap = null;
async function getTickerMap() {
  if (_tickerMap) return _tickerMap;
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA }, timeout: 10000 });
    if (!res.ok) return {};
    const data = await res.json();
    _tickerMap = {};
    for (const e of Object.values(data)) _tickerMap[String(e.cik_str)] = e.ticker;
    console.log(`  Ticker map loaded: ${Object.keys(_tickerMap).length} entries`);
    return _tickerMap;
  } catch { return {}; }
}

/* ─── Fetch most recent EDGAR filings ─────────────────────────────────────── */
async function fetchRecentFilings() {
  // dateb=tomorrow ensures getcurrent returns filings even on weekends/holidays
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateb = tomorrow.toISOString().slice(0, 10).replace(/-/g, '');

  const tickerMap = await getTickerMap();
  const cutoff90  = new Date();
  cutoff90.setDate(cutoff90.getDate() - 90);

  const filings = [];
  for (const type of ['10-K', '10-Q']) {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}&dateb=${dateb}&owner=include&count=100&search_text=&output=atom`;
    const res  = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    if (!res.ok) throw new Error(`EDGAR ${type} → HTTP ${res.status}`);
    const xml    = await res.text();
    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: true });
    const entries = parsed?.feed?.entry || [];
    console.log(`  RSS ${type}: ${entries.length} entries`);

    for (const e of entries) {
      const raw    = e.title?.[0];
      const title  = typeof raw === 'object' ? (raw._ || '') : (raw || '');
      const link   = e.link?.[0]?.$.href || '';
      const updated= e.updated?.[0] || '';

      if (updated && new Date(updated) < cutoff90) continue;

      // Link is an archive URL: /Archives/edgar/data/{CIK}/...
      const cikM = link.match(/CIK=(\d+)/i) || link.match(/\/edgar\/data\/(\d+)\//i);
      if (!link || !cikM) continue;

      // Title format: "10-Q - Company Name (CIK) (TICKER)"
      const nameM       = title.match(/^(?:10-[KQ]|Annual Report|Quarterly Report)\s*[-–]\s*(.+?)\s*\(\d+\)\s*\(.*?\)\s*$/i);
      const companyName = nameM ? nameM[1].trim() : title;
      const cikInt      = String(parseInt(cikM[1], 10));
      const ticker      = (title.match(/\(([A-Z]{1,5})\)\s*$/)?.[1]) || tickerMap[cikInt] || '';

      filings.push({ type, ticker, cik: cikInt, companyName, link, updated, summary: '' });
    }
  }
  return filings;
}

/* ─── XBRL company facts fallback (for iXBRL filings that need JS) ────────── */
async function fetchXBRLFacts(cik) {
  try {
    const padded = String(parseInt(cik, 10)).padStart(10, '0');
    const url    = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
    const res    = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    if (!res.ok) return '';
    const data   = await res.json();
    const gaap   = data?.facts?.['us-gaap'] || {};

    const want = [
      ['Revenues',                                              'Revenue'],
      ['RevenueFromContractWithCustomerExcludingAssessedTax',   'Revenue'],
      ['GrossProfit',                                           'Gross Profit'],
      ['NetIncomeLoss',                                         'Net Income'],
      ['OperatingIncomeLoss',                                   'Operating Income'],
      ['ResearchAndDevelopmentExpense',                         'R&D Expense'],
      ['EarningsPerShareDiluted',                               'EPS (diluted)'],
      ['CashAndCashEquivalentsAtCarryingValue',                 'Cash'],
      ['CommonStockSharesOutstanding',                          'Shares Outstanding'],
    ];

    const lines = [`XBRL Financial Facts — ${data.entityName || ''} (CIK ${parseInt(cik,10)})`];
    for (const [key, label] of want) {
      const metric = gaap[key];
      if (!metric?.units) continue;
      const unitKey = Object.keys(metric.units)[0];
      const entries = (metric.units[unitKey] || [])
        .filter(e => e.form === '10-Q' || e.form === '10-K')
        .sort((a, b) => new Date(b.end) - new Date(a.end));
      if (!entries.length) continue;
      const latest = entries[0];
      const prev   = entries.find(e => e.end !== latest.end);
      const fmt    = v => unitKey === 'USD'
        ? (Math.abs(v) >= 1e9 ? `$${(v/1e9).toFixed(2)}B` : `$${(v/1e6).toFixed(1)}M`)
        : v;
      const yoy = prev ? ` (prev: ${fmt(prev.val)})` : '';
      lines.push(`  ${label}: ${fmt(latest.val)}${yoy} — period ending ${latest.end} [${latest.form}]`);
    }
    return lines.join('\n');
  } catch { return ''; }
}

/* ─── Fetch filing text — HTML parse with XBRL API fallback ───────────────── */
async function fetchFilingText(indexUrl, cik) {
  try {
    const res  = await fetch(indexUrl, { headers: { 'User-Agent': UA }, timeout: 15000 });
    if (!res.ok) return fetchXBRLFacts(cik);
    const html = await res.text();
    const $    = cheerio.load(html);
    let docUrl = '';

    // Pass 1: primary document — row where Type column = 10-K or 10-Q
    $('table.tableFile tr').each((_, row) => {
      if (docUrl) return;
      const cells   = $(row).find('td');
      const docType = cells.eq(3).text().trim().toUpperCase();
      const href    = cells.eq(2).find('a').attr('href') || '';
      if ((docType === '10-Q' || docType === '10-K') && href.match(/\.(htm|html)$/i))
        docUrl = href.startsWith('http') ? href : 'https://www.sec.gov' + href;
    });

    // Pass 2: fallback — first non-exhibit, non-viewer HTM
    if (!docUrl) {
      $('table.tableFile tr').each((_, row) => {
        if (docUrl) return;
        const cells = $(row).find('td');
        const desc  = cells.eq(1).text().toLowerCase();
        const href  = cells.eq(2).find('a').attr('href') || '';
        if (href.match(/\.(htm|html)$/i)
            && !desc.includes('exhibit') && !desc.includes('ex-')
            && !href.includes('viewer') && !href.includes('xbrl')) {
          docUrl = href.startsWith('http') ? href : 'https://www.sec.gov' + href;
        }
      });
    }

    if (!docUrl) return fetchXBRLFacts(cik);

    const docRes = await fetch(docUrl, { headers: { 'User-Agent': UA }, timeout: 20000 });
    if (!docRes.ok) return fetchXBRLFacts(cik);
    const docHtml = await docRes.text();
    const $d = cheerio.load(docHtml);
    $d('script,style,head').remove();
    const text = $d('body').text().replace(/\s+/g,' ').trim();

    // If JS-only page, fall back to XBRL API
    if (text.length < 500 || text.includes('Please enable JavaScript')) {
      return fetchXBRLFacts(cik);
    }
    return text.substring(0, 15000);
  } catch { return fetchXBRLFacts(cik); }
}

/* ─── Claude analysis ─────────────────────────────────────────────────────── */
async function analyzeWithClaude(filing, text) {
  const prompt = `You are a top-tier equity analyst evaluating SEC filings against THREE pre-breakout archetypes. Each archetype describes the exact filing pattern that preceded a massive multi-year stock move.

ARCHETYPE 1 — SANDISK (structural demand wave + margin expansion):
SanDisk's pre-breakout signals: revenue re-accelerating on structural AI/data-center demand, gross margins expanding rapidly, FCF turning positive, management using unusually confident non-hedging language, TAM expanding into new markets. Core pattern: company caught at the intersection of TWO structural demand waves simultaneously (e.g. flash storage + mobile/cloud data explosion).

ARCHETYPE 2 — MICRON (cyclical trough + AI product inflection):
Micron's signals before its 2023-2024 AI-driven rally: sequential revenue/margin recovery from a severe cycle trough (each quarter improving even if YoY still negative), explicit HBM or AI-specific product ramp with premium ASPs, customer inventory normalization commentary, management maintaining capex discipline through the down-cycle, explicit data-center/AI attribution as the new demand driver. BROADER PATTERN: any cyclical business (memory, industrial semi, specialty materials, components) where sequential recovery is meeting a new AI/structural tailwind that drives premium product mix shift.

ARCHETYPE 3 — NEBIUS (AI infrastructure buildout from near zero):
Nebius Group's signals before its big move: pure-play GPU/AI cloud infrastructure being built from near-zero revenue, massive committed capex to frontier AI hardware (H100/H200-class clusters), strong AI/ML engineering leadership from an established major tech company, early enterprise customer traction for AI training and inference, management language framing a decade-long infrastructure opportunity. BROADER PATTERN: any company making a clear new-entity pivot or greenfield buildout specifically for AI infrastructure — burning cash intentionally with committed customer demand and a visible capacity utilization ramp ahead.

FILING:
Company: ${filing.companyName}
Ticker: ${filing.ticker || 'N/A'}
Type: ${filing.type} | Filed: ${(filing.updated||'').substring(0,10)}
Text excerpt: ${text ? text.substring(0,12000) : '[No text — use company name and sector knowledge]'}

Return ONLY valid JSON (no markdown fences):
{
  "ticker": "${filing.ticker || 'N/A'}",
  "companyName": "${filing.companyName}",
  "filingType": "${filing.type}",
  "filedDate": "${(filing.updated||'').substring(0,10)}",
  "sector": "<Technology|Healthcare|Consumer|Industrial|Financial|Energy|Space & Defense|Biotech|Other>",
  "signalScore": <0-100 overall signal quality integer>,
  "scores": {
    "revenueGrowth": <0-25>,
    "marginExpansion": <0-20>,
    "managementConviction": <0-18>,
    "tamExpansion": <0-15>,
    "fcfInflection": <0-12>,
    "structuralDemand": <0-10>
  },
  "keyMetrics": [
    {"label": "Revenue Growth", "value": "e.g. +47% YoY", "trend": "up|down|flat"},
    {"label": "Gross Margin",   "value": "e.g. 68%",      "trend": "up|down|flat"},
    {"label": "FCF",            "value": "e.g. $42M",     "trend": "up|down|flat"},
    {"label": "Key KPI",        "value": "most relevant metric", "trend": "up|down|flat"}
  ],
  "signals": [
    {"type": "growth",     "title": "...", "quote": "<30-word exact/near-exact filing quote>", "insight": "why this matters"},
    {"type": "management", "title": "...", "quote": "<30-word quote>",                         "insight": "what this language signals"},
    {"type": "catalyst",   "title": "...", "quote": "<30-word quote>",                         "insight": "upcoming inflection"},
    {"type": "risk",       "title": "...", "quote": "<30-word quote>",                         "insight": "key risk to monitor"}
  ],
  "verdict": "<2-3 sentences: honest early-buyer verdict. Which archetype(s) does this match and why?>",
  "sandiskSimilarity": <0-100 — match to Archetype 1: structural demand + margin expansion>,
  "micronSimilarity":  <0-100 — match to Archetype 2: cyclical recovery + AI product inflection>,
  "nebiusSimilarity":  <0-100 — match to Archetype 3: AI infrastructure buildout from near zero>,
  "archetypeBreakdowns": {
    "sandisk": {
      "revenueAcceleration":    <0-25, structural re-acceleration not one-time>,
      "marginExpansion":        <0-20, gross/operating margin trajectory>,
      "managementConviction":   <0-18, non-hedging confident language>,
      "tamExpansion":           <0-15, new market entry signals>,
      "fcfInflection":          <0-12, FCF turning positive>,
      "structuralWaveAlignment":<0-10, caught at intersection of 2+ demand waves>,
      "keySignal": "<one sentence: the single strongest SanDisk-pattern evidence in this filing, or why it does not match>"
    },
    "micron": {
      "sequentialRecovery":     <0-25, each quarter improving even if YoY negative>,
      "aiProductInflection":    <0-25, HBM-type or AI-specific product ramp with premium ASPs>,
      "inventoryNormalization": <0-20, customer inventory burn commentary>,
      "capexDiscipline":        <0-15, spending wisely through the cycle>,
      "premiumMixShift":        <0-15, moving up the value chain to higher-margin products>,
      "keySignal": "<one sentence: the single strongest Micron-pattern evidence, or why it does not match>"
    },
    "nebius": {
      "revenueRampFromZero":    <0-25, near-zero to meaningful revenue in short time>,
      "committedCapex":         <0-25, committed spend on frontier AI hardware>,
      "aiEngineeringDepth":     <0-20, leadership or team pedigree from major tech co>,
      "enterpriseTraction":     <0-15, early paying customers for AI training or inference>,
      "infrastructureMoat":     <0-15, unique positioning or barrier to replication>,
      "keySignal": "<one sentence: the single strongest Nebius-pattern evidence, or why it does not match>"
    }
  },
  "shouldHighlight": <true if any similarity score >= 65>
}

SCORING RULES: Be honest. Most companies score 20-45 on each similarity. Score 65+ only for genuine pattern matches with multiple signals firing simultaneously. A cyclical semi showing sequential recovery + HBM ramp would score Micron 70-80. An AI infra company with committed GPU capex + early enterprise traction would score Nebius 70-85. A company with >40% revenue growth + expanding margins + new market entry scores SanDisk 75-85.`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 2200,
        messages:   [{ role: 'user', content: prompt }],
      }),
      timeout: 60000,
    });

    if (res.status === 429 || res.status === 529) {
      if (attempt < 2) {
        const waitSec = 30 * (attempt + 1);
        console.log(`  Anthropic rate limit. Retrying in ${waitSec}s (attempt ${attempt+1}/2)…`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw new Error(`Anthropic ${res.status}: ${(await res.text()).substring(0,150)}`);
    }

    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).substring(0,100)}`);
    const data = await res.json();
    const raw  = data.content?.[0]?.text || '';
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s===-1||e===-1) throw new Error('No JSON from Claude');
    return JSON.parse(raw.slice(s,e+1));
  }
}

/* ─── Main ────────────────────────────────────────────────────────────────── */
let _scanRunning = false;
async function runDailyScan() {
  if (_scanRunning) { console.log('  Scan already in progress, skipping.'); return { success:false, error:'already running' }; }
  _scanRunning = true;
  console.log(`[${new Date().toISOString()}] SEC scan starting (last 3 business days)…`);
  try { return await _doScan(); } finally { _scanRunning = false; }
}

async function _doScan() {

  let existing = { lastUpdated: null, totalScanned: 0, filings: [] };
  const stored = await store.load();
  if (stored) {
    existing = stored;
    console.log(`  Loaded ${existing.filings?.length || 0} existing results from Upstash`);
  } else if (fs.existsSync(DATA_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(_){}
  }

  let todayFilings = [];
  try {
    todayFilings = await fetchRecentFilings();
    console.log(`  EDGAR: ${todayFilings.length} filings`);
  } catch(e) {
    console.error('  EDGAR failed:', e.message);
    return { success:false, error:e.message };
  }

  const seenLinks = new Set((existing.filings||[]).map(f=>f.link));
  const toProcess = todayFilings.filter(f => !seenLinks.has(f.link)).slice(0, 25);
  console.log(`  New to analyze: ${toProcess.length}`);

  const results = [];
  for (const filing of toProcess) {
    try {
      console.log(`  → ${filing.companyName} (${filing.type})`);
      const text     = await fetchFilingText(filing.link, filing.cik);
      const analysis = await analyzeWithClaude(filing, text);
      analysis.link  = filing.link;
      analysis.cik   = filing.cik;
      results.push(analysis);
      await new Promise(r => setTimeout(r, 2000)); // 2s gap between calls
    } catch(e) {
      console.error(`  ✗ ${filing.companyName}: ${e.message}`);
    }
  }

  const merged = [...results, ...(existing.filings||[])]
    .filter((f,i,arr) => arr.findIndex(x=>x.link===f.link)===i)
    .sort((a,b) => (b.signalScore||0)-(a.signalScore||0))
    .slice(0, 300);

  const output = { lastUpdated: new Date().toISOString(), totalScanned: (existing.totalScanned||0)+toProcess.length, filings: merged };
  const saved = await store.save(output);
  if (saved) {
    console.log(`  Results saved to Upstash`);
  } else {
    fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
    fs.writeFileSync(DATA_FILE, JSON.stringify(output,null,2));
  }
  console.log(`[${new Date().toISOString()}] Done. +${results.length} new, ${merged.length} total.`);
  return { success:true, newCount:results.length, totalCount:merged.length };
}

if (require.main===module) runDailyScan().then(console.log).catch(e=>{console.error(e);process.exit(1);});
module.exports = { runDailyScan };
