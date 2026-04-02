# Appliance Budget Picker

Interactive appliance comparison tool for our Clinton Hill Coops (Brooklyn, NY) kitchen renovation.

## What it does

- **Card-based picker** — click to select one appliance per category (Refrigerator, Dishwasher, Stove, Microwave, Sink)
- **Import from URL** — paste any appliance product page and a Cloudflare Worker scrapes the name, price, dimensions, and product image
- **AI-powered reviews** — Perplexity Sonar generates a contextual blurb for each appliance, factoring in compact NYC kitchen constraints and real user reviews
- **Live budget total** — sticky banner updates instantly as you mix and match

## Architecture

```
index.html (React SPA, no build step)
  ↓ POST
Cloudflare Worker (appliance-parser.nick-ed-palm.workers.dev)
  ├── Fetches product page HTML
  ├── Extracts: title, price, dimensions, og:image / JSON-LD image
  └── Calls Perplexity Sonar API for contextual blurb
```

## Files

| File | Description |
|------|-------------|
| `index.html` | Full React app (single file, opens in any browser) |
| `worker/index.js` | Cloudflare Worker — URL scraper + Perplexity blurb generator |

## Setup

### Frontend
Just open `index.html` in a browser. No build step needed.

### Worker
1. Deploy `worker/index.js` to Cloudflare Workers
2. Hardcode your `PERPLEXITY_API_KEY` in the worker (or use wrangler secrets)
3. Update `WORKER_URL` in `index.html` if your subdomain differs

## Cost

- **Cloudflare Workers**: Free tier (100K requests/day)
- **Perplexity Sonar**: ~$0.005 per blurb (~half a cent)
- **Total for personal use**: Essentially free

## Data source

Appliance options pulled from [this Google Doc](https://docs.google.com/document/d/1ktuUCSzGtgOfRnaT09UnwPNuuvW9JRGy_m_OG3B2g5s/edit).
