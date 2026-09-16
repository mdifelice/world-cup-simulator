import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'pwtest-shots');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 1050 }, locale: 'en' })).newPage();
page.on('pageerror', e => console.error('PAGE-ERROR', e.message));

const file = join(HERE, 'tournament-hub-mockups.html');
await page.goto('file://' + file);
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + '/16-tournament-hub-mockups.png', fullPage: true });

console.log('written');
await browser.close();