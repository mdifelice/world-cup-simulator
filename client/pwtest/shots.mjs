import { mkdirSync } from 'fs';
import { chromium } from 'playwright';

const OUT = '/Users/martin/Documents/Otros/WCS/pwtest-shots';
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 1050 }, locale: 'en' })).newPage();
page.on('pageerror', e => console.error('PAGE-ERROR', e.message));

await page.goto('http://localhost:8080?seed');
await sleep(1500);
await page.click('.cup-card:not([disabled]):last-child');
await sleep(800);
await page.click('.team-card:first-child');
await sleep(2500);
await page.screenshot({ path: OUT + '/01-roster.png', fullPage: true });

await page.click('.btn.big.primary');
await sleep(2000);
await page.click('.cmd-bar .btn.primary.big');
await page.waitForSelector('.pc-pick', { timeout: 8000 });
await sleep(800);
await page.screenshot({ path: OUT + '/02-lineup.png', fullPage: true });

await page.click('.btn.secondary.big');
await sleep(400);
await page.click('.bar-hint .btn.big.primary');
await sleep(2000);
let guard = 0;
while (guard < 12) {
  guard += 1;
  const a = page.locator('.cmd-bar .btn.secondary.big:not(.corners)');
  if (await a.count()) { await a.click(); await sleep(800); }
  if (await page.locator('.pc-pick').count()) {
    await page.click('.btn.secondary.big');
    await sleep(300);
    await page.click('.bar-hint .btn.big.primary');
    await sleep(1500);
    continue;
  }
  if (await page.locator('.cmd-bar .btn.secondary.big.corners').count()) break;
  await sleep(1500);
}
// finished; shot the overview with everything revealed + scorer list
await sleep(800);
await page.screenshot({ path: OUT + '/03-overview.png', fullPage: true });

const corners = page.locator('.cmd-bar .btn.secondary.big.corners');
if (await corners.count()) await corners.click();
else { await page.click('.cmd-bar .btn.secondary.big:not(.corners)'); await sleep(500); }
await sleep(1800);
await page.screenshot({ path: OUT + '/04-finals.png', fullPage: true });

console.log('screenshots written to', OUT);
await browser.close();