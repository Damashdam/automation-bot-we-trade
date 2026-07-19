/**
 * X/Twitter scraper — two-layer strategy:
 *
 * 1. Nitter RSS  (lightweight, no browser, tries multiple community instances)
 * 2. Playwright  (full browser, uses saved session cookies as fallback)
 *
 * If both fail the function returns [] and the job skips this cycle.
 *
 * To replace with an official API, implement fetchLatestPosts() with the
 * same ScrapedPost return shape and swap the import in monitorXProfile.ts.
 */

import axios, { AxiosError } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

export interface ScrapedPost {
  post_id: string;
  post_url: string;
  text: string;
  timestamp?: string;
  media_url?: string;
}

const COOKIES_PATH = path.resolve(
  process.env.COOKIES_PATH ||
    path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'x-cookies.json'),
);
const MAX_POSTS = 20;
const REQUEST_TIMEOUT_MS = 15_000;

// ─── Nitter RSS layer ────────────────────────────────────────────────────────

// Community-run Nitter instances. Update this list from:
// https://github.com/zedeus/nitter/wiki/Instances
// Note: many instances were shut down after X blocked the guest API in 2024.
// If all fail the bot falls back to Playwright automatically.
const NITTER_INSTANCES = [
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.unixfox.eu',
  'https://nitter.1d4.us',
  'https://nitter.mint.lgbt',
  'https://nitter.kavin.rocks',
  'https://nitter.rawbit.ninja',
];

function extractPostId(url: string): string {
  const m = url.match(/\/status\/(\d+)/);
  return m ? m[1] : '';
}

function toXUrl(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, 'https://x.com');
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function tryNitterRSS(username: string): Promise<ScrapedPost[] | null> {
  for (const inst of NITTER_INSTANCES) {
    try {
      const url = `${inst}/${username}/rss`;
      logger.debug('Trying Nitter RSS', { url });

      const resp = await axios.get<string>(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS/2.0)' },
        validateStatus: (s) => s === 200,
      });

      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const parsed = parser.parse(resp.data as string);
      const raw = parsed?.rss?.channel?.item ?? [];
      const items: unknown[] = Array.isArray(raw) ? raw : [raw];

      const posts: ScrapedPost[] = [];
      for (const item of items.slice(0, MAX_POSTS)) {
        const i = item as Record<string, unknown>;
        const link = String(i['link'] || i['guid'] || '');
        if (!link) continue;

        const postUrl = toXUrl(link);
        const postId = extractPostId(postUrl);
        if (!postId) continue;

        const titleText = stripHtml(String(i['title'] || '')).replace(/^@\w+:\s*/i, '');
        const descText = stripHtml(String(i['description'] || ''));
        const text = descText.length > titleText.length ? descText : titleText;
        if (!text) continue;

        const enc = i['enclosure'] as Record<string, unknown> | undefined;
        posts.push({
          post_id: postId,
          post_url: postUrl,
          text,
          timestamp: String(i['pubDate'] || ''),
          media_url: enc?.['@_url'] ? String(enc['@_url']) : undefined,
        });
      }

      logger.info('Nitter RSS succeeded', { instance: inst, count: posts.length });
      return posts;
    } catch (err) {
      const msg =
        err instanceof AxiosError
          ? `${err.message} (HTTP ${err.response?.status ?? 'no-resp'})`
          : (err as Error).message;
      logger.debug('Nitter instance failed', { instance: inst, reason: msg });
    }
  }
  return null;
}

// ─── Playwright layer ────────────────────────────────────────────────────────

async function tryPlaywright(username: string): Promise<ScrapedPost[] | null> {
  if (!fs.existsSync(COOKIES_PATH)) {
    logger.warn(
      'No saved X session cookies found — run "npm run auth" once to log in and save them.',
      { cookiesPath: COOKIES_PATH },
    );
    return null;
  }

  try {
    const state = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8')) as {
      cookies?: Array<{ name: string; value: string }>;
    };
    const hasAuth = (state.cookies ?? []).some((c) => c.name === 'auth_token' && c.value);
    if (!hasAuth) {
      logger.warn(
        'X cookies are guest-only (no auth_token) — run "npm run auth" and finish login before closing.',
      );
      return null;
    }
  } catch {
    logger.warn('Could not read X cookies file — run npm run auth');
    return null;
  }

  // Lazy-require so the app starts even if playwright isn't installed
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    logger.warn('Playwright not installed — skipping browser fallback');
    return null;
  }

  logger.info('Falling back to Playwright scraper');

  const chromePath = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({
    ...(chromePath
      ? { executablePath: chromePath }
      : { channel: 'chrome' as const }),
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const ctx = await browser.newContext({
      storageState: COOKIES_PATH,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await ctx.newPage();

    await page.goto(`https://x.com/${username}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Detect redirect to login (session expired or cookies invalid)
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
      throw new Error('Redirected to login page — session expired. Run: npm run auth');
    }

    // Give the timeline time to render (X is often slow / rate-limited)
    await page.waitForTimeout(3_000);

    const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
    if (/this page is down/i.test(pageText) || /something went wrong/i.test(pageText)) {
      throw new Error('X returned an error page ("This page is down"). Retry later or re-run npm run auth.');
    }
    if (/sign in|log in to x/i.test(pageText) && !pageText.includes('@')) {
      throw new Error('Not logged in — cookies are guest-only. Run: npm run auth and complete login.');
    }

    // Wait for at least one tweet article to appear
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 45_000 });

    const posts = await page.evaluate(
      ({ maxPosts, handle }: { maxPosts: number; handle: string }) => {
        const articles = Array.from(
          document.querySelectorAll('article[data-testid="tweet"]'),
        ).slice(0, maxPosts);

        return articles.map((el) => {
          const textEl = el.querySelector('[data-testid="tweetText"]');
          const text = textEl?.textContent?.trim() ?? '';

          const timeEl = el.querySelector('time[datetime]');
          const timestamp = timeEl?.getAttribute('datetime') ?? '';

          const linkEl = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
          const href = linkEl?.href ?? '';
          const idMatch = href.match(/\/status\/(\d+)/);
          const postId = idMatch ? idMatch[1] : '';
          const postUrl = postId ? `https://x.com/${handle.toLowerCase()}/status/${postId}` : '';

          const imgEl = el.querySelector('img[src*="pbs.twimg.com/media"]') as HTMLImageElement | null;
          const mediaUrl = imgEl?.src ?? '';

          return { post_id: postId, post_url: postUrl, text, timestamp, media_url: mediaUrl || undefined };
        }).filter((p) => p.post_id && p.text);
      },
      { maxPosts: MAX_POSTS, handle: username },
    );

    logger.info('Playwright scrape succeeded', { count: posts.length });
    return posts as ScrapedPost[];
  } catch (err) {
    logger.error('Playwright scrape failed', { error: (err as Error).message });
    return null;
  } finally {
    await browser.close();
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

async function fetchForUsername(username: string): Promise<ScrapedPost[]> {
  const nitterResult = await tryNitterRSS(username);
  if (nitterResult !== null) return nitterResult;

  const playwrightResult = await tryPlaywright(username);
  if (playwrightResult !== null) return playwrightResult;

  logger.error('All scraping strategies failed for account — skipping', { username });
  return [];
}

export async function fetchLatestPosts(): Promise<ScrapedPost[]> {
  const raw = process.env.TARGET_X_USERNAMES || process.env.TARGET_X_USERNAME || 'StockMKTNewz';
  const usernames = raw.split(',').map((u) => u.trim()).filter(Boolean);

  const results = await Promise.all(usernames.map(fetchForUsername));
  return results.flat();
}
