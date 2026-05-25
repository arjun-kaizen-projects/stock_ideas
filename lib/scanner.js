'use strict';
require('dotenv').config();
const fetch   = require('node-fetch');
const xml2js  = require('xml2js');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const DATA_FILE     = path.join(__dirname, '../data/results.json');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'research@sandiskradar.com';
const UA            = `SanDiskRadar/1.0 (contact: ${CONTACT_EMAIL})`;

/* ─── Fetch EDGAR filings from last 3 business days via EFTS ──────────────── */
async function fetchRecentFilings() {
  // Walk back until we have 3 business days
  const end = new Date();
  const start = new Date();
  for (let bdays = 0; bdays < 3; ) {
    start.setDate(start.getDate() - 1);
    if (start.getDay() !== 0 && start.getDay() !== 6) bdays++;
  }
  const fmt = d => d.toISOString().slice(0, 10);
  const startStr = fmt(start);
  const endStr   = fmt(end);
  console.log(`  Date range: ${startStr} → ${endStr}`);

  const filings = [];
  for (const form of ['10-K', '10-Q']) {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22%22&forms=${form}&dateRange=custom&startdt=${startStr}&enddt=${endStr}`;
    const res  = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    if (!res.ok) throw new Error(`EDGAR EFTS ${form} → HTTP ${res.status}`);
    const data = await res.json();
    const hits  = data?.hits?.hits || [];
    console.log(`  EFTS ${form}: ${hits.length} hits`);

    for (const hit of hits) {
      const src    = hit._source || {};
      const cikInt = parseInt(src.cik || '0', 10);
      // _id is the accession number (may have dashes already or not)
      const accId   = hit._id || '';
      const accNo   = accId.includes('-') ? accId
                    : accId.replace(/(\d{10})(\d{2})(\d{6})/, '$1-$2-$3');
      const accFlat = accNo.replace(/-/g, '');
      const link    = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accFlat}/${accNo}-index.htm`;
      const ticker  = src.ticker || (Array.isArray(src.tickers) ? src.tickers[0] : '') || '';
      filings.push({
        type:        form,
        ticker,
        cik:         String(cikInt),
        companyName: src.entity_name || src.company_name || '',
        link,
        updated:     src.file_date || '',
        summary:     '',
      });
    }
  }
  return filings;
}

/* ─── Fetch filing text (15 k chars) ─────────────────────────────────────── */
async function fetchFilingText(indexUrl) {
  try {
    const res  = await fetch(indexUrl, { headers: { 'User-Agent': UA }, timeout: 15000 });
    if (!res.ok) return '';
    const html = await res.text();
    const $    = cheerio.load(html);
    let docUrl = '';
    $('table.tableFile tr').each((_, row) => {
      if (docUrl) return;
      const cells = $(row).find('td');
      const desc  = cells.eq(1).text().toLowerCase();
      const href  = cells.eq(2).find('a').attr('href') || '';
      if (href.match(/\.(htm|html)$/i) && !desc.includes('exhibit') && !desc.includes('ex-')) {
        docUrl = href.startsWith('http') ? href : 'https://www.sec.gov' + href;
      }
    });
    if (!docUrl) return '';
    const docRes = await fetch(docUrl, { headers: { 'User-Agent': UA }, timeout: 20000 });
    if (!docRes.ok) return '';
    const docHtml = await docRes.text();
    const $d = cheerio.load(docHtml);
    $d('script,style,head').remove();
    return $d('body').text().replace(/\s+/g,' ').trim().substring(0, 15000);
  } catch { return ''; }
}

/* ─── Claude analysis ─────────────────────────────────────────────────────── */
async function analyzeWithClaude(filing, text) {
  const prompt = `You are a top-tier equity analyst hunting for the next SanDisk — stocks with early-filing signals that precede massive multi-year moves. SanDisk's signals were: revenue re-accelerating on structural AI/data-center demand, gross margins expanding, FCF turning positive, management using unusually confident non-hedging language, and TAM expansion into new markets.

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
  "signalScore": <0-100 integer>,
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
  "verdict": "<2-3 sentences: honest early-buyer verdict. Would you have bought this? What is the bull case hidden in these pages?>",
  "sandiskSimilarity": <0-100>,
  "shouldHighlight": <true if signalScore >= 65>
}

SCORING RULES: Be honest. Most companies score 20-45. Score 65+ only for genuine acceleration stories with multiple signal types firing simultaneously. Score 80+ only for SanDisk-level density. A company with >40% YoY revenue growth + expanding margins + confident management language + new market entry would score ~75-85.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1400, messages:[{role:'user', content:prompt}] }),
    timeout: 60000,
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).substring(0,100)}`);
  const data = await res.json();
  const raw  = (data.content||[]).map(b=>b.text||'').join('');
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s===-1||e===-1) throw new Error('No JSON from Claude');
  return JSON.parse(raw.slice(s,e+1));
}

/* ─── Main ────────────────────────────────────────────────────────────────── */
async function runDailyScan() {
  console.log(`[${new Date().toISOString()}] SEC scan starting (last 3 business days)…`);

  let existing = { lastUpdated: null, totalScanned: 0, filings: [] };
  if (fs.existsSync(DATA_FILE)) {
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
      const text     = await fetchFilingText(filing.link);
      const analysis = await analyzeWithClaude(filing, text);
      analysis.link  = filing.link;
      analysis.cik   = filing.cik;
      results.push(analysis);
      await new Promise(r => setTimeout(r, 800));
    } catch(e) {
      console.error(`  ✗ ${filing.companyName}: ${e.message}`);
    }
  }

  const merged = [...results, ...(existing.filings||[])]
    .filter((f,i,arr) => arr.findIndex(x=>x.link===f.link)===i)
    .sort((a,b) => (b.signalScore||0)-(a.signalScore||0))
    .slice(0, 300);

  const output = { lastUpdated: new Date().toISOString(), totalScanned: (existing.totalScanned||0)+toProcess.length, filings: merged };
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  fs.writeFileSync(DATA_FILE, JSON.stringify(output,null,2));
  console.log(`[${new Date().toISOString()}] Done. +${results.length} new, ${merged.length} total.`);
  return { success:true, newCount:results.length, totalCount:merged.length };
}

if (require.main===module) runDailyScan().then(console.log).catch(e=>{console.error(e);process.exit(1);});
module.exports = { runDailyScan };
