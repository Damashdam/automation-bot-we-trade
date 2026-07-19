/**
 * One-time interactive auth script.
 * Run:  npm run auth
 *
 * Opens Chrome so you can log in to X manually.
 * Saves cookies only after a real login (auth_token present).
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const COOKIES_PATH = path.resolve(
  process.env.COOKIES_PATH || path.join(process.cwd(), 'data', 'x-cookies.json'),
);

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });

  console.log('Opening Chrome — log in to X/Twitter.');
  console.log('IMPORTANT: stay until you see your home feed.');
  console.log('The script waits until login succeeds (auth_token cookie).');
  console.log('Then you can close the window, or it will auto-save.\n');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await ctx.newPage();
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 10 * 60 * 1000; // 10 minutes to log in
  let loggedIn = false;

  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://x.com');
    const hasAuth = cookies.some((c) => c.name === 'auth_token' && c.value);
    const hasCt0 = cookies.some((c) => c.name === 'ct0' && c.value);
    if (hasAuth && hasCt0) {
      // Confirm we're not still on the login flow
      const url = page.url();
      if (!url.includes('/i/flow/login') && !url.includes('/login')) {
        loggedIn = true;
        break;
      }
      // Even on login URL, auth cookies mean we're done — go home to verify
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' }).catch(() => {});
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(1500);
  }

  if (!loggedIn) {
    await browser.close();
    console.error('\nLogin was NOT completed — cookies were NOT saved.');
    console.error('Run again: npm run auth');
    console.error('Log in fully until you see the home timeline.');
    process.exit(1);
  }

  await page.waitForTimeout(2000);
  await ctx.storageState({ path: COOKIES_PATH });
  await browser.close();

  console.log(`\nLogged-in session saved to: ${COOKIES_PATH}`);
  console.log('You can now run: npm run dev');
}

main().catch((err) => {
  console.error('Auth failed:', err.message);
  process.exit(1);
});
