# SanDisk Radar 📡
### Daily SEC Filing Intelligence — Finding the Next 10× Before Wall Street Does

A fully automated web application that fetches every 10-K and 10-Q filed with the SEC each day, runs AI analysis on each filing using Claude, scores them against the **SanDisk Signal Framework**, and surfaces the companies most likely to be the next big multi-bagger.

---

## What It Does

Every weekday at 7 am ET, the server:
1. Pulls all new 10-K and 10-Q filings from EDGAR's live RSS feed
2. Fetches the actual filing text from each document
3. Sends each filing to Claude for deep analysis
4. Scores each company across 6 signal dimensions (0–100)
5. Saves results — new filings are added, the full history is kept

You visit the website and see a ranked list of every filing analyzed, sorted by signal strength.

---

## The SanDisk Signal Framework

SanDisk ran 1,200% after spinning off from Western Digital. Its pre-run filings showed:

| Signal | Max Points | What It Looks For |
|---|---|---|
| Revenue Growth | 25 | >30% YoY acceleration |
| Margin Expansion | 20 | Gross/operating margin improving |
| Management Conviction | 18 | Unusually direct, non-hedging language |
| TAM Expansion | 15 | New markets, products, geographies |
| FCF Inflection | 12 | Free cash flow turning positive |
| Structural Demand | 10 | Structural vs cyclical tailwind |
| **Total** | **100** | |

Companies scoring **65+** are flagged as High Signal. Companies scoring **80+** are rare and warrant deep due diligence.

---

## Quick Start (5 Minutes)

### 1. Prerequisites
- **Node.js** v18+ — [nodejs.org](https://nodejs.org)
- **Anthropic API key** — free at [console.anthropic.com](https://console.anthropic.com)

### 2. Install
```bash
cd sandisk-radar
npm install
```

### 3. Configure
```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### 4. Run your first scan
```bash
node lib/scanner.js
# This fetches today's EDGAR filings and analyzes each one
# Takes 2–5 minutes depending on filing volume
```

### 5. Start the server
```bash
npm start
# Visit http://localhost:3000
```

That's it. The server auto-scans every weekday at 7 am ET.

---

## Project Structure

```
sandisk-radar/
├── server.js          # Express server + cron scheduler
├── lib/
│   └── scanner.js     # SEC EDGAR fetcher + Claude analyzer
├── public/
│   └── index.html     # Full front-end (search, filter, modal)
├── data/
│   └── results.json   # Grows daily (auto-created on first scan)
├── .env.example       # Copy to .env and fill in your key
└── package.json
```

---

## Deploying to the Cloud (Free)

### Option A: Render.com (Recommended, Free Tier)
1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo
4. Set environment variables: `ANTHROPIC_API_KEY`, `CONTACT_EMAIL`
5. Build command: `npm install`
6. Start command: `node server.js`
7. Done — your site is live 24/7

### Option B: Railway.app
1. `railway login && railway init`
2. `railway up`
3. Set env vars in the Railway dashboard

### Option C: Vercel (Serverless)
Works but requires converting to Vercel serverless functions. Use Render instead for the cron scheduler.

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/results` | GET | All analyzed filings, sorted by score |
| `GET /api/results?minScore=65` | GET | Only high-signal filings |
| `POST /api/scan` | POST | Trigger a manual scan (header: `x-scan-secret`) |
| `GET /api/health` | GET | Server health check |

---

## Cost Estimate

Each filing analysis uses ~2,000 tokens (prompt + response).

| Volume | Daily Cost (Claude Sonnet) |
|---|---|
| 25 filings/day | ~$0.06/day · $1.80/month |
| 50 filings/day | ~$0.12/day · $3.60/month |
| 100 filings/day | ~$0.24/day · $7.20/month |

The scanner caps at 25 filings per run by default. Adjust in `lib/scanner.js` line: `slice(0, 25)`.

---

## Disclaimer

This tool is for **informational and educational purposes only**. Signal scores are qualitative assessments based on AI analysis of public filings. Nothing here is investment advice. Always conduct your own due diligence and consult a qualified financial advisor before making any investment decisions. Past filing patterns that preceded stock moves do not guarantee future results.

---

## License
MIT
