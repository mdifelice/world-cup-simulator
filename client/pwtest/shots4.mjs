import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'pwtest-shots');
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://localhost:8080';

async function fillLineup(page) {
  // Auto-pick best XI, then confirm.
  await page.click('.form-editor .btn.secondary.chip');
  await sleep(250);
  await page.click('.form-confirm .btn.primary');
  await sleep(2600); // re-sim deterministic with the lineup
}

/** Reveal the next `n` matches in strict order, finishing any Play modals. */
async function revealN(page, n, opts = {}) {
  let revealed = 0;
  for (let i = 0; i < (opts.max ?? 200) && revealed < n; i++) {
    const next = page.locator('.match-row.next');
    if ((await next.count()) === 0) break;
    const play = next.locator('.btnm.play');
    if ((await play.count()) > 0) {
      await play.click();
      await page.waitForSelector('.live-modal', { timeout: 8000 });
      await sleep(2200);
      if (opts.modalShot && revealed === 0) {
        await page.screenshot({ path: OUT + opts.modalShot, fullPage: true });
      }
      // Wait for the match to finish, then go back to the hub.
      await page.waitForSelector('.live-modal .match-actions', { timeout: 30000 });
      await page.click('.live-modal .match-actions .btn.primary.big');
      await sleep(400);
    } else {
      const sim = next.locator('.btnm.simulate');
      if ((await sim.count()) > 0) {
        await sim.click();
        await sleep(120);
      }
    }
    revealed += 1;
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1050 }, locale: 'en' });
ctx.setDefaultTimeout(20000);
const page = await ctx.newPage();
page.on('pageerror', e => console.error('PAGE-ERROR', e.message));

// ---------- Part A: interactive focus run (Argentina) ----------
await page.goto(BASE + '?seed');
await sleep(1200);
await page.click('.cup-card:not([disabled]):first-child');   // 2026
await sleep(900);
await page.click('.team-card:first-child');                  // Brazil (rated 1st)
await sleep(2400);
await page.click('.btn-row .btn.primary');                   // Start the World Cup →
await page.waitForSelector('.hub', { timeout: 10000 });
await sleep(600);
await page.screenshot({ path: OUT + '/17-hub-start.png', fullPage: true });

await fillLineup(page);
await sleep(500);
await page.screenshot({ path: OUT + '/18-hub-lineup-set.png', fullPage: true });

await revealN(page, 7, { modalShot: '/19-live-modal.png', max: 20 });
await sleep(500);
await page.screenshot({ path: OUT + '/20-hub-groups.png', fullPage: true });

// ---------- Part B: neutral full replay (fast, no modals) ----------
const np = await ctx.newPage();
np.on('pageerror', e => console.error('PAGE-ERROR', e.message));
await np.goto(BASE + '?seed');
await sleep(1200);
await np.click('.cup-card:not([disabled]):first-child');
await sleep(900);
await np.click('.link');                                     // watch as neutral
await np.waitForSelector('.hub', { timeout: 10000 });
await sleep(600);
await np.screenshot({ path: OUT + '/21-hub-neutral.png', fullPage: true });

// Reveal the entire tournament (all matches are Simulate in neutral mode).
let guard = 0;
while (guard < 140) {
  guard += 1;
  const next = np.locator('.match-row.next');
  if ((await next.count()) === 0) break;
  const sim = next.locator('.btnm.simulate');
  if ((await sim.count()) === 0) break;
  await sim.click();
  await sleep(70);
}
await sleep(800);
await np.screenshot({ path: OUT + '/22-hub-neutral-complete.png', fullPage: true });

console.log('screenshots written to', OUT);
await browser.close();