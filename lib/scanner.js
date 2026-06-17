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

// 8-K items worth analyzing — earnings releases, material contracts, strategic announcements, exec changes
const VALUABLE_8K_ITEMS = new Set(['2.02', '1.01', '7.01', '8.01', '5.02', '1.05']);

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

/* ─── SIC code lookup + sector classifier ─────────────────────────────────── */
const _sicCache = {};
async function getSICCode(cik) {
  if (_sicCache[cik] !== undefined) return _sicCache[cik];
  try {
    const padded = String(parseInt(cik, 10)).padStart(10, '0');
    const res = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, { headers: { 'User-Agent': UA }, timeout: 10000 });
    if (!res.ok) { _sicCache[cik] = null; return null; }
    const data = await res.json();
    _sicCache[cik] = data.sic ? String(data.sic) : null;
    return _sicCache[cik];
  } catch { _sicCache[cik] = null; return null; }
}

function classifySector(sic) {
  const s = parseInt(sic || '0', 10);

  // Semiconductors & Storage
  if ((s >= 3670 && s <= 3679) || s === 3577 || s === 3572 || s === 3699)
    return {
      name: 'Semiconductors/Storage',
      patternA: 'AI/data-center demand, flash or memory ASP uplift, hyperscaler design wins, HBM or CXL adoption, gross margin expansion from premium mix',
      patternB: 'inventory normalization, sequential revenue recovery from cycle trough, HBM ramp, DRAM/NAND pricing recovery, capex discipline, data-center attribution',
      patternC: 'GPU cluster buildout, AI inference/training infrastructure, HPC partnerships, capacity utilization ramp from near zero',
    };

  // Software, Cloud, IT Services
  if (s >= 7370 && s <= 7379)
    return {
      name: 'Software/Cloud',
      patternA: 'ARR re-acceleration, NRR expansion, new AI module adoption, enterprise land-and-expand, operating leverage inflecting',
      patternB: 'seat/license destocking ending, sequential net new ARR recovery, AI co-pilot upsell driving premium tier mix shift',
      patternC: 'AI-native platform buildout, GPU-backed inference API, foundational model infrastructure, early committed enterprise ARR from AI workloads',
    };

  // Biotech & Pharma
  if ((s >= 2830 && s <= 2836) || (s >= 8000 && s <= 8099))
    return {
      name: 'Healthcare/Biotech',
      patternA: 'GLP-1 adjacent demand surge, new indication approval driving volume, royalty inflection, biosimilar entry capturing share',
      patternB: 'clinical pipeline recovering from setback, sequential patient enrollment recovery, premium formulation mix shift (e.g. extended-release), payer coverage normalization',
      patternC: 'cell/gene therapy platform buildout from near zero, committed manufacturing capex, early compassionate-use or named-patient revenue, FDA fast-track designation',
    };

  // Chemicals & Specialty Materials
  if (s >= 2800 && s <= 2899)
    return {
      name: 'Chemicals/Materials',
      patternA: 'specialty grade premiums, defense or EV supply agreements, margin expansion from high-value product mix, structural supply constraint in niche market',
      patternB: 'spread recovery from trough, utilization ramp from low levels, destocking ending at key customers, premium specialty mix displacing commodity',
      patternC: 'greenfield specialty plant buildout, committed offtake agreements, new electrolyte or advanced material for AI/EV, capacity utilization ramp ahead',
    };

  // Steel, Metals, Mining
  if ((s >= 3310 && s <= 3399) || (s >= 1000 && s <= 1499))
    return {
      name: 'Metals/Mining',
      patternA: 'critical mineral supply agreements (lithium, copper, rare earth), defense procurement wins, structural supply deficit commentary',
      patternB: 'spread recovery, utilization ramp from trough, service center destocking ending, premium product (EV-grade, high-strength) mix shift',
      patternC: 'greenfield critical mineral mine or processing facility, offtake agreements with EV/battery OEMs, capex committed with visible demand ramp',
    };

  // Industrial Equipment & Machinery
  if (s >= 3500 && s <= 3569)
    return {
      name: 'Industrials/Equipment',
      patternA: 'data center cooling wins, reshoring capex tailwind, electrification demand, defense modernization contracts',
      patternB: 'dealer inventory normalization, sequential order recovery from trough, precision/automation upsell driving ASP lift',
      patternC: 'new automation or robotics platform from near zero, committed capex for AI-adjacent manufacturing, early hyperscaler or OEM partnerships',
    };

  // Energy & Utilities
  if ((s >= 1300 && s <= 1382) || (s >= 4900 && s <= 4939))
    return {
      name: 'Energy/Utilities',
      patternA: 'data center power offtake agreements, grid modernization contracts, nuclear restart demand, LNG export ramp',
      patternB: 'utilization recovery from low levels, sequential realized price improvement, premium power product mix (firm capacity vs. merchant)',
      patternC: 'greenfield data center power infrastructure, dedicated nuclear or gas peaker for AI campus, committed long-term offtake from hyperscalers',
    };

  // Aerospace & Defense
  if ((s >= 3760 && s <= 3769) || s === 3812 || s === 3489)
    return {
      name: 'Aerospace/Defense',
      patternA: 'hypersonic or directed-energy program wins, space infrastructure contracts, multi-year IDIQ awards expanding TAM',
      patternB: 'program recovery from budget pause, sequential deliveries resuming, premium next-gen platform mix replacing legacy',
      patternC: 'new space or autonomous systems venture from near zero, committed DoD or NATO contracts, capacity buildout ahead of delivery schedule',
    };

  // REITs & Real Estate
  if (s >= 6500 && s <= 6552)
    return {
      name: 'REITs/Real Estate',
      patternA: 'data center land or campus acquisition, cap rate compression from AI tenant demand, NOI inflection from hyperscaler leases',
      patternB: 'occupancy recovery from trough, sequential same-store NOI improvement, premium tenant (data center, life science) mix replacing commodity office',
      patternC: 'greenfield data center campus buildout, committed hyperscaler leases, power capacity expansion for AI workloads',
    };

  // Telecom
  if (s >= 4810 && s <= 4899)
    return {
      name: 'Telecom',
      patternA: 'private 5G enterprise contracts, edge compute wins, fiber-to-data-center backhaul demand',
      patternB: 'churn recovery, sequential ARPU improvement, premium enterprise/IoT mix displacing consumer voice',
      patternC: 'AI-native network infrastructure buildout, committed enterprise private network contracts, capacity utilization ramp from near zero',
    };

  // Default — broad tech/other
  return {
    name: 'Other',
    patternA: 'structural demand shift, new market entry, margin expansion, management confident non-hedging language',
    patternB: 'cyclical recovery from trough, sequential improvement, premium product or service mix shift',
    patternC: 'greenfield platform buildout from near zero, committed customer demand, capacity utilization ramp ahead',
  };
}

/* ─── Parse 8-K items from filing index ───────────────────────────────────── */
async function get8KItems(indexUrl) {
  try {
    const res = await fetch(indexUrl, { headers: { 'User-Agent': UA }, timeout: 15000 });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const text = $('body').text();
    // EDGAR index pages list items like "Item 2.02" or "2.02 Results of Operations"
    const matches = text.match(/\b(\d\.\d{2})\b/g) || [];
    return [...new Set(matches)];
  } catch { return []; }
}

/* ─── Fetch most recent EDGAR filings ─────────────────────────────────────── */
async function fetchRecentFilings(targetDate) {
  // targetDate: 'YYYY-MM-DD' for historical, or null for today
  let dateb, cutoffStart;
  if (targetDate) {
    const d = new Date(targetDate);
    const dayAfter = new Date(d); dayAfter.setDate(d.getDate() + 1);
    dateb = dayAfter.toISOString().slice(0, 10).replace(/-/g, '');
    cutoffStart = d; // only filings on that exact date
  } else {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dateb = tomorrow.toISOString().slice(0, 10).replace(/-/g, '');
    cutoffStart = new Date();
    cutoffStart.setDate(cutoffStart.getDate() - 7);
  }

  const tickerMap = await getTickerMap();
  const cutoff7  = cutoffStart;

  const filings = [];
  for (const type of ['10-K', '10-Q', '8-K']) {
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

      if (updated && new Date(updated) < cutoff7) continue;

      const cikM = link.match(/CIK=(\d+)/i) || link.match(/\/edgar\/data\/(\d+)\//i);
      if (!link || !cikM) continue;

      const nameM       = title.match(/^(?:10-[KQ]|8-K|Annual Report|Quarterly Report|Current Report)\s*[-–]\s*(.+?)\s*\(\d+\)\s*\(.*?\)\s*$/i);
      const companyName = nameM ? nameM[1].trim() : title;
      const cikInt      = String(parseInt(cikM[1], 10));
      const ticker      = (title.match(/\(([A-Z]{1,5})\)\s*$/)?.[1]) || tickerMap[cikInt] || '';

      filings.push({ type, ticker, cik: cikInt, companyName, link, updated, summary: '' });
    }
  }
  return filings;
}

/* ─── XBRL company facts fallback ─────────────────────────────────────────── */
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

/* ─── Fetch filing text ────────────────────────────────────────────────────── */
async function fetchFilingText(indexUrl, cik, filingType) {
  try {
    const res  = await fetch(indexUrl, { headers: { 'User-Agent': UA }, timeout: 15000 });
    if (!res.ok) return fetchXBRLFacts(cik);
    const html = await res.text();
    const $    = cheerio.load(html);
    let docUrl = '';

    const targetTypes = filingType === '8-K'
      ? ['8-K', 'EX-99.1', '8-K/A']
      : ['10-Q', '10-K'];

    // Pass 1: primary document by type
    $('table.tableFile tr').each((_, row) => {
      if (docUrl) return;
      const cells   = $(row).find('td');
      const docType = cells.eq(3).text().trim().toUpperCase();
      const href    = cells.eq(2).find('a').attr('href') || '';
      if (targetTypes.some(t => docType.includes(t)) && href.match(/\.(htm|html)$/i))
        docUrl = href.startsWith('http') ? href : 'https://www.sec.gov' + href;
    });

    // Pass 2: fallback — first non-exhibit HTM
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

    if (text.length < 500 || text.includes('Please enable JavaScript')) {
      return fetchXBRLFacts(cik);
    }
    return text.substring(0, 15000);
  } catch { return fetchXBRLFacts(cik); }
}

/* ─── Build sector-aware Claude prompt ────────────────────────────────────── */
function buildPrompt(filing, text, sector) {
  return `You are a top-tier equity analyst evaluating SEC filings against THREE universal pre-breakout archetypes. Each archetype describes a pattern that preceded massive multi-year stock moves across many sectors — not just tech.

ARCHETYPE 1 — STRUCTURAL DEMAND SHIFT (SanDisk pattern):
Universal pattern: a company caught at the intersection of TWO structural demand waves simultaneously, causing revenue re-acceleration, rapid gross margin expansion, FCF inflection, and management using unusually confident non-hedging language.
Original example: SanDisk — flash storage + mobile/cloud data explosion driving ASP uplift and margin expansion.
For ${sector.name} companies, look for: ${sector.patternA}

ARCHETYPE 2 — CYCLICAL TROUGH + PREMIUM MIX SHIFT (Micron pattern):
Universal pattern: sequential recovery from a severe cycle trough (improving each period even if YoY still negative), while a new premium product or customer segment drives a structural mix shift toward higher margins.
Original example: Micron — DRAM/NAND inventory normalization + HBM ramp for AI with premium ASPs.
For ${sector.name} companies, look for: ${sector.patternB}

ARCHETYPE 3 — GREENFIELD PLATFORM BUILDOUT (Nebius pattern):
Universal pattern: a company building a new platform from near-zero revenue with committed customer demand, massive intentional capex, and a clear capacity utilization ramp visible ahead. CRITICALLY — this archetype is defined as much by WHO is building it as WHAT they are building. The original Nebius was led by Arkady Volozh, who founded Yandex and built it into a $30B company before returning to build Nebius. This "second act" founder pattern — proven builder, high insider ownership, technical DNA, long-term orientation — is the single strongest predictor that the buildout will succeed.
Original example: Nebius — GPU/AI cloud infrastructure built from scratch with hyperscaler-grade H100 clusters and early enterprise traction, led by the founder of Yandex with deep insider ownership.
For ${sector.name} companies, look for: ${sector.patternC}

MANAGEMENT SIGNALS TO LOOK FOR IN FILINGS (all sectors, especially Archetype 3):
— Founder still CEO or CTO: the same person who founded the company is still running it (look for founding date vs. tenure in Item 10 bios)
— Serial entrepreneur with prior exit at scale: biography mentions founding or leading a prior company that was sold or IPO'd at >$500M (look in Item 10, proxy, or 8-K exec appointment)
— Significant insider ownership: founders or executives own >10% of shares outstanding (look in beneficial ownership table, proxy DEF 14A, or 10-K Item 12)
— Technical founder not financial engineer: CEO/CTO has engineering, CS, or science background — not purely an MBA or finance background (look at education and early career in bios)
— Second-act builder: founder stepped away from prior company (exit, IPO, or acquisition) and has returned to build something new — highest conviction signal
— Tier-1 team pedigree: key hires from NVIDIA, Google DeepMind, Meta AI, OpenAI, Yandex, etc. mentioned in filings or press releases referenced in 8-Ks
— Language of long-term orientation: management explicitly frames a decade-long opportunity, not quarterly guidance — they talk about infrastructure cycles, not near-term EPS

FILING:
Company: ${filing.companyName}
Ticker: ${filing.ticker || 'N/A'}
Sector: ${sector.name}
Type: ${filing.type} | Filed: ${(filing.updated||'').substring(0,10)}
Text excerpt: ${text ? text.substring(0,12000) : '[No text — use company name and sector knowledge]'}

Return ONLY valid JSON (no markdown fences):
{
  "ticker": "${filing.ticker || 'N/A'}",
  "companyName": "${filing.companyName}",
  "filingType": "${filing.type}",
  "filedDate": "${(filing.updated||'').substring(0,10)}",
  "sector": "${sector.name}",
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
    {"label": "Key KPI",        "value": "most relevant sector metric", "trend": "up|down|flat"}
  ],
  "signals": [
    {"type": "growth",     "title": "...", "quote": "<30-word exact/near-exact filing quote>", "insight": "why this matters"},
    {"type": "management", "title": "...", "quote": "<30-word quote>",                         "insight": "what this language signals"},
    {"type": "catalyst",   "title": "...", "quote": "<30-word quote>",                         "insight": "upcoming inflection"},
    {"type": "risk",       "title": "...", "quote": "<30-word quote>",                         "insight": "key risk to monitor"}
  ],
  "verdict": "<2-3 sentences: honest early-buyer verdict. Which archetype(s) does this match and why? Use sector-appropriate language.>",
  "sandiskSimilarity": <0-100 — match to Archetype 1: structural demand shift + margin expansion>,
  "micronSimilarity":  <0-100 — match to Archetype 2: cyclical trough + premium mix shift>,
  "nebiusSimilarity":  <0-100 — match to Archetype 3: greenfield platform buildout from near zero>,
  "archetypeBreakdowns": {
    "sandisk": {
      "revenueAcceleration":    <0-25, structural re-acceleration not one-time>,
      "marginExpansion":        <0-20, gross/operating margin trajectory>,
      "managementConviction":   <0-18, non-hedging confident language>,
      "tamExpansion":           <0-15, new market entry signals>,
      "fcfInflection":          <0-12, FCF turning positive>,
      "structuralWaveAlignment":<0-10, caught at intersection of 2+ demand waves>,
      "keySignal": "<one sentence: strongest Archetype 1 evidence in this filing, or why it does not match>"
    },
    "micron": {
      "sequentialRecovery":     <0-25, each period improving even if YoY negative>,
      "aiProductInflection":    <0-25, premium product or service ramp with margin uplift>,
      "inventoryNormalization": <0-20, customer/channel destocking ending>,
      "capexDiscipline":        <0-15, spending wisely through the cycle>,
      "premiumMixShift":        <0-15, moving up the value chain to higher-margin products>,
      "keySignal": "<one sentence: strongest Archetype 2 evidence in this filing, or why it does not match>"
    },
    "nebius": {
      "revenueRampFromZero":    <0-20, near-zero to meaningful revenue in short time>,
      "committedCapex":         <0-20, committed spend on buildout with visible demand ahead>,
      "founderLedTeam":         <0-15, founder still CEO/CTO — same person who started the company>,
      "serialEntrepreneurTrack":<0-15, prior exit or IPO at scale >$500M mentioned in bios>,
      "insiderOwnership":       <0-10, founders/executives own >10% — skin in the game>,
      "technicalFounderDNA":    <0-10, engineering/science background, not purely financial>,
      "tierOnePedigree":        <0-10, key hires from NVIDIA/Google/Meta/OpenAI or equivalent>,
      "enterpriseTraction":     <0-10, early paying customers or committed offtake agreements>,
      "keySignal": "<one sentence: strongest Archetype 3 evidence — lead with management if relevant, otherwise the strongest business signal, or why it does not match>"
    }
  },
  "shouldHighlight": <true if any similarity score >= 65>
}

SCORING RULES: Be honest and sector-calibrated. Most companies score 20-45 on each similarity. Score 65+ only for genuine pattern matches with multiple signals firing simultaneously. Apply the archetype patterns to the ${sector.name} sector vocabulary — the underlying economic pattern matters, not the exact tech terminology. A chemical company with spread recovery + EV-grade premium mix shift scores Micron 70-80. A defense contractor winning hypersonic contracts + margin expansion scores SanDisk 70-80. A greenfield critical minerals miner with committed lithium offtake scores Nebius 70-85.

NEBIUS SCORING SPECIAL RULE: Management quality is the PRIMARY signal for Archetype 3, not the business metrics. A company with a proven founder still at the helm, prior exit at scale, and high insider ownership should score Nebius 60+ even if revenue is still near zero — that is exactly the pattern. A hired-gun CEO with no founding history running a greenfield buildout scores 20 points lower than an identical business led by a serial founder. Look hard at Item 10 management bios and the beneficial ownership table in every filing.`;
}

/* ─── Claude analysis ─────────────────────────────────────────────────────── */
async function analyzeWithClaude(filing, text, sector) {
  const prompt = buildPrompt(filing, text, sector);

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
let _scanStartedAt = null;
let _scanProgress = { current: 0, total: 0, currentCompany: '' };

function getScanStatus() {
  return { isRunning: _scanRunning, startedAt: _scanStartedAt, progress: _scanProgress };
}

async function runDailyScan(targetDate) {
  if (_scanRunning) { console.log('  Scan already in progress, skipping.'); return { success:false, error:'already running' }; }
  _scanRunning = true;
  _scanStartedAt = new Date().toISOString();
  _scanProgress = { current: 0, total: 0, currentCompany: '' };
  console.log(`[${new Date().toISOString()}] SEC scan starting${targetDate ? ` for ${targetDate}` : ' (last 7 days)'}…`);
  try { return await _doScan(targetDate); } finally { _scanRunning = false; }
}

async function _doAdhocScan(targetDate) {
  let todayFilings = [];
  try {
    todayFilings = await fetchRecentFilings(targetDate);
    console.log(`  EDGAR (adhoc ${targetDate}): ${todayFilings.length} filings`);
  } catch(e) {
    console.error('  EDGAR failed:', e.message);
    return { success:false, error:e.message };
  }

  const annualQuarterly = todayFilings.filter(f => ['10-K','10-Q'].includes(f.type)).slice(0, 25);
  const new8Ks = todayFilings.filter(f => f.type === '8-K');
  const valuable8Ks = [];
  for (const filing of new8Ks) {
    if (valuable8Ks.length >= 15) break;
    const items = await get8KItems(filing.link);
    if (items.some(item => VALUABLE_8K_ITEMS.has(item))) {
      filing._8kItems = items;
      valuable8Ks.push(filing);
    }
  }

  const toProcess = [...annualQuarterly, ...valuable8Ks];
  console.log(`  Adhoc to analyze: ${toProcess.length}`);
  _scanProgress.total = toProcess.length;

  const results = [];
  for (const filing of toProcess) {
    _scanProgress.current++;
    _scanProgress.currentCompany = filing.companyName;
    try {
      console.log(`  → ${filing.companyName} (${filing.type})`);
      const sic      = await getSICCode(filing.cik);
      const sector   = classifySector(sic);
      const text     = await fetchFilingText(filing.link, filing.cik, filing.type);
      const analysis = await analyzeWithClaude(filing, text, sector);
      analysis.link     = filing.link;
      analysis.cik      = filing.cik;
      analysis._adhoc   = true;
      analysis._adhocDate = targetDate;
      if (filing._8kItems) analysis._8kItems = filing._8kItems;
      results.push(analysis);
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      console.error(`  ✗ ${filing.companyName}: ${e.message}`);
    }
  }

  await store.saveAdhoc(results);
  console.log(`[${new Date().toISOString()}] Adhoc done. +${results.length} analyzed for ${targetDate}.`);
  return { success:true, newCount:results.length, totalCount:results.length, allCount:results.length };
}

async function _doScan(targetDate) {
  // Historical adhoc scan — don't touch main store, save to adhoc with 24h TTL
  const isAdhoc = !!targetDate && new Date(targetDate) < new Date(Date.now() - 7 * 86400000);
  if (isAdhoc) return await _doAdhocScan(targetDate);

  let existing = { lastUpdated: null, totalScanned: 0, filings: [], allFilings: [] };
  const stored = await store.load();
  if (stored) {
    existing = stored;
    console.log(`  Loaded ${existing.filings?.length || 0} analyzed, ${existing.allFilings?.length || 0} total from Upstash`);
  } else if (fs.existsSync(DATA_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(_){}
  }

  let todayFilings = [];
  try {
    todayFilings = await fetchRecentFilings(targetDate);
    console.log(`  EDGAR: ${todayFilings.length} filings (10-K, 10-Q, 8-K)`);
  } catch(e) {
    console.error('  EDGAR failed:', e.message);
    return { success:false, error:e.message };
  }

  // Store ALL fetched filings (raw) for the By Date view
  const existingAllLinks = new Set((existing.allFilings||[]).map(f=>f.link));
  const newRawFilings = todayFilings
    .filter(f => !existingAllLinks.has(f.link))
    .map(f => ({
      ticker: f.ticker,
      companyName: f.companyName,
      filingType: f.type,
      filedDate: (f.updated||'').substring(0, 10),
      link: f.link,
      cik: f.cik,
    }));
  console.log(`  New raw filings to store: ${newRawFilings.length}`);

  const seenAnalyzedLinks = new Set((existing.filings||[]).map(f=>f.link));

  // 10-K and 10-Q: analyze all new, up to 25
  const annualQuarterly = todayFilings
    .filter(f => ['10-K','10-Q'].includes(f.type) && !seenAnalyzedLinks.has(f.link))
    .slice(0, 25);

  // 8-K: filter to valuable items only, cap at 15/day to control cost
  const new8Ks = todayFilings.filter(f => f.type === '8-K' && !seenAnalyzedLinks.has(f.link));
  const valuable8Ks = [];
  for (const filing of new8Ks) {
    if (valuable8Ks.length >= 15) break;
    const items = await get8KItems(filing.link);
    const hasValuableItem = items.some(item => VALUABLE_8K_ITEMS.has(item));
    if (hasValuableItem) {
      filing._8kItems = items;
      valuable8Ks.push(filing);
    }
  }

  const toProcess = [...annualQuarterly, ...valuable8Ks];
  console.log(`  New to analyze: ${annualQuarterly.length} (10-K/10-Q) + ${valuable8Ks.length} (8-K) = ${toProcess.length} total`);

  _scanProgress.total = toProcess.length;
  const results = [];
  for (const filing of toProcess) {
    _scanProgress.current++;
    _scanProgress.currentCompany = filing.companyName;
    try {
      console.log(`  → ${filing.companyName} (${filing.type})`);
      const sic    = await getSICCode(filing.cik);
      const sector = classifySector(sic);
      const text   = await fetchFilingText(filing.link, filing.cik, filing.type);
      const analysis = await analyzeWithClaude(filing, text, sector);
      analysis.link  = filing.link;
      analysis.cik   = filing.cik;
      if (filing._8kItems) analysis._8kItems = filing._8kItems;
      results.push(analysis);
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      console.error(`  ✗ ${filing.companyName}: ${e.message}`);
    }
  }

  // Merge analyzed filings (sorted by score)
  const mergedAnalyzed = [...results, ...(existing.filings||[])]
    .filter((f,i,arr) => arr.findIndex(x=>x.link===f.link)===i)
    .sort((a,b) => (b.signalScore||0)-(a.signalScore||0))
    .slice(0, 300);

  // Merge ALL raw filings (last 7 days), enriched with analysis where available
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const analysisLookup = new Map(mergedAnalyzed.map(r => [r.link, r]));

  const mergedAll = [...newRawFilings, ...(existing.allFilings||[])]
    .filter((f,i,arr) => arr.findIndex(x=>x.link===f.link)===i)
    .filter(f => f.filedDate && new Date(f.filedDate) >= sevenDaysAgo)
    .map(f => {
      const analysis = analysisLookup.get(f.link);
      return analysis ? { ...f, ...analysis } : f;
    })
    .sort((a,b) => new Date(b.filedDate||0) - new Date(a.filedDate||0));

  // Record first-signal dates for any ticker that hit a signal threshold
  const ARC_THRESH = 60, SCORE_THRESH = 60;
  const signalFilings = mergedAnalyzed.filter(f =>
    (f.signalScore||0) > SCORE_THRESH && (
      (f.sandiskSimilarity||0) >= ARC_THRESH ||
      (f.micronSimilarity||0)  >= ARC_THRESH ||
      (f.nebiusSimilarity||0)  >= ARC_THRESH
    )
  );
  await store.recordSignalDates(signalFilings);

  const output = {
    lastUpdated: new Date().toISOString(),
    totalScanned: (existing.totalScanned||0) + toProcess.length,
    filings: mergedAnalyzed,
    allFilings: mergedAll,
  };
  const saved = await store.save(output);
  if (saved) {
    console.log(`  Results saved to Upstash`);
  } else {
    fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
    fs.writeFileSync(DATA_FILE, JSON.stringify(output,null,2));
  }
  console.log(`[${new Date().toISOString()}] Done. +${results.length} analyzed, ${mergedAll.length} total filings tracked.`);
  return { success:true, newCount:results.length, totalCount:mergedAnalyzed.length, allCount:mergedAll.length };
}

if (require.main===module) runDailyScan().then(console.log).catch(e=>{console.error(e);process.exit(1);});
module.exports = { runDailyScan, getScanStatus };
