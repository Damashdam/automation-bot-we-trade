# WeTrade News Bot

Monitors [@StockMKTNewz](https://x.com/StockMKTNewz) on X/Twitter, filters for market-relevant posts, rewrites them into short Hebrew WhatsApp updates, and delivers them via WhatsApp.

## How it works

```
Cron (every N min)
  → scrape Nitter RSS (public Twitter mirror, no login needed)
  → filter for market/stocks/macro/crypto relevance
  → generate Hebrew WhatsApp message via GPT-4o-mini
  → send via WhatsApp Cloud API (Meta) or Twilio
  → store result in SQLite to prevent duplicates
```

---

## Quick start

### 1. Copy the env file and fill in your credentials

```bash
cp .env.example .env
```

Edit `.env` — the required fields are:

| Variable | What to put there |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI key from [platform.openai.com](https://platform.openai.com/api-keys) |
| `WHATSAPP_API_TOKEN` | Meta permanent access token (see WhatsApp setup below) |
| `WHATSAPP_PHONE_NUMBER_ID` | From Meta Developer > WhatsApp > API Setup |
| `TARGET_WHATSAPP_NUMBER` | Destination number in international format e.g. `972501234567` |

### 2. Install dependencies

```bash
npm install
```

Playwright uses your locally installed **Google Chrome** — no extra browser download needed.

### 3. Log in to X once (saves your session for automated scraping)

```bash
npm run auth
```

This opens a real browser window. Log in to X/Twitter normally.
When you can see your home feed, close the window.
Your session is saved to `data/x-cookies.json` and will be reused automatically.

> **Why is this needed?**  
> The free Nitter RSS mirrors that used to work without login were mostly shut down
> in 2024 after X blocked the API they relied on. Playwright with your saved session
> is the most reliable free option. Your credentials are never stored — only browser cookies.

### 4. Test without sending (recommended before going live)

This fetches real posts and prints the generated Hebrew messages to your terminal — **nothing is sent to WhatsApp**.

```bash
npm run test:fetch
```

### 5. Run the live bot

```bash
# Development
npm run dev

# Production (build first)
npm run build
npm start
```

---

## WhatsApp Cloud API setup (Meta — recommended free option)

1. Go to [developers.facebook.com](https://developers.facebook.com) and create a new App → choose **Business**.
2. Add the **WhatsApp** product to your app.
3. Under **WhatsApp > API Setup**:
   - Copy the **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - Generate a **Permanent Token** (System User with `whatsapp_business_messaging` permission) → `WHATSAPP_API_TOKEN`
4. Add your personal number as a **test recipient** during development.
5. Set `TARGET_WHATSAPP_NUMBER` to your number without `+` (e.g. `972501234567` for Israel).

The Meta free tier allows messages to verified test numbers. For production use you need a verified business and approved message templates (or you can use session messages).

---

## Twilio setup (alternative)

1. Sign up at [twilio.com](https://www.twilio.com)
2. Activate the WhatsApp Sandbox.
3. Fill in `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`.
4. Set `WHATSAPP_PROVIDER=twilio` in `.env`.

---

## Configuration reference

```env
TARGET_X_USERNAME=StockMKTNewz      # Twitter/X account to monitor
CHECK_INTERVAL_MINUTES=5             # How often to poll (min 1)
OPENAI_MODEL=gpt-4o-mini            # Change to gpt-4o for higher quality
LOG_LEVEL=info                       # error | warn | info | debug
DATABASE_URL=./data/wetrade.db       # SQLite file path
```

---

## Project structure

```
src/
  index.ts                  ← entry point, cron scheduler
  scraper/
    xScraper.ts             ← Nitter RSS fetcher (swap here for official API)
  filters/
    postFilter.ts           ← keyword-based relevance filter
  ai/
    generateHebrewUpdate.ts ← OpenAI prompt → Hebrew WhatsApp message
  whatsapp/
    sendWhatsappMessage.ts  ← Meta Cloud API or Twilio delivery
  db/
    database.ts             ← SQLite via node:sqlite (built-in, no compilation)
  jobs/
    monitorXProfile.ts      ← orchestrates one full monitor cycle
  utils/
    logger.ts               ← Winston logger (console + files)

data/
  wetrade.db                ← SQLite database (auto-created)
logs/
  combined.log
  error.log
```

---

## Database schema

```sql
CREATE TABLE processed_posts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id           TEXT    UNIQUE NOT NULL,   -- tweet ID (dedup key)
  post_url          TEXT    NOT NULL,
  original_text     TEXT    NOT NULL,
  generated_message TEXT,                      -- Hebrew WhatsApp message
  sent_to_whatsapp  INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

## Example generated output

Given the English post:
> Apple seeks Trump administration approval to buy CXMT memory chips — a Chinese company on the US blacklist for alleged military ties

The bot generates:

```
*אפל חייבת את זה*

אפל מבקשת אישור מממשל טראמפ לרכוש שבבי זיכרון מחברת CXMT, חברה סינית שנמצאת ברשימה השחורה של ארה״ב בשל קשרים עם הצבא הסיני

•••••••••📖📈🧠••••••••
*ווי טרייד🇮🇱*
Wetrade-il.com
לא המלצה לפעולה
```

---

## Replacing the scraper with the official X API

The scraper is isolated in `src/scraper/xScraper.ts`. It exports a single function:

```typescript
export async function fetchLatestPosts(): Promise<ScrapedPost[]>
```

To switch to the official X API (or any other source), create a new file that implements the same `ScrapedPost` interface and `fetchLatestPosts()` signature, and update the import in `src/jobs/monitorXProfile.ts`.

---

## Known limitations & notes

- **Scraping layer**: Nitter RSS mirrors are tried first (fast, lightweight). Most were shut down after X blocked their API in 2024, so Playwright is now the reliable fallback. If both fail, the cycle is skipped gracefully.
- **Session cookies expire** roughly every 30 days. Re-run `npm run auth` to refresh.
- **X bot detection**: Even with valid cookies, X may occasionally challenge the browser. If scraping starts failing consistently, check logs and re-run `npm run auth`.
- **X API costs** $100/month minimum for the Basic plan (as of 2025). If you want guaranteed reliability, switch to it and swap `src/scraper/xScraper.ts`.
- **WhatsApp delivery**: Meta's Cloud API requires a verified Business account for unrestricted messaging. In sandbox/test mode, you can only message verified test numbers.
- **`node:sqlite`** is marked experimental in Node v22–v23 but is stable for this workload.
