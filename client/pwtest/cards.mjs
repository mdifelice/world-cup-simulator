import { chromium } from 'playwright';

const BASE = 'http://localhost:8080';
const log = (...args) => console.log('PASS', ...args);
const fail = (...args) => { console.log('FAIL', ...args); process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 1050 }, locale: 'en' });
const page = await context.newPage();
page.on('pageerror', e => { console.error('PAGE-ERROR', e.message); process.exitCode = 1; });

// Seed tournaments, open app
await page.goto(BASE + '?seed');
await sleep(1500);

// Pick 2026 → first focus team (Argentina)
await page.click('.cup-card:not([disabled]):last-child');
await sleep(800);
await page.click('.team-card:first-child');
await sleep(2500);

// --- Roster card check ---
await page.waitForSelector('.pc-grid', { timeout: 6000 });
const pcardCount = await page.locator('.pcard').count();
console.log('  roster pcards:', pcardCount);
if (pcardCount >= 20) log('roster "grid" cards rendered');
else fail(`roster card count ${pcardCount} too low`);

const surname = await page.locator('.pcard .pc-surname').first().innerText();
console.log('  first surname:', surname);
if (surname && surname === surname.toUpperCase()) log('surname rendered uppercase');
else fail(`surname not uppercase: ${JSON.stringify(surname)}`);

const tt = await page.locator('.pcard .pc-surname').first().evaluate(el => getComputedStyle(el).textTransform);
if (tt === 'uppercase') log('surname uppercase via CSS (single line ellipsis expected)');
else console.log('WARN text-transform:', tt);

// Same-surname players must stay distinct via number + title name
const distinctSurnames = await page.locator('.pcard .pc-surname').evaluateAll(ns => new Set(ns.map(n => n.textContent)).size);
console.log('  distinct surnames (dup names expected):', distinctSurnames, '/', pcardCount);

const num = await page.locator('.pcard .pc-num').first().innerText();
if (num) log('shirt number pill present on card');
else fail('no number pill');

const starText = await page.locator('.pcard .pc-stars').first().innerText();
if (starText && /[★☆]/.test(starText)) log('stars present on card');
else fail(`stars missing: ${JSON.stringify(starText)}`);

const titleName = await page.locator('.pcard').first().getAttribute('title');
console.log('  card title:', titleName);
if (titleName && /— (GK|DF|MF|FW|[A-Z]{2,3}) —/.test(titleName)) log('full name only in tooltip');
else console.log('WARN card title format:', titleName);

if (await page.locator('.player-row').count() === 0) log('no legacy .player-row left');
else console.log('WARN legacy .player-row left');

// Start the cup → overview
await page.click('.btn.big.primary');
await sleep(2000);

// --- Lineup pick list check (Argentina's first match needs a lineup) ---
await page.waitForSelector('.cmd-bar .btn.primary.big', { timeout: 8000 });
await page.click('.cmd-bar .btn.primary.big'); // Play matchday 1
await page.waitForSelector('.pc-pick', { timeout: 8000 });
await sleep(800);

const pickRows = await page.locator('.pc-pick').count();
console.log('  lineup pick rows:', pickRows);
if (pickRows >= 20) log('lineup pick-list cards rendered');
else fail(`pick row count ${pickRows} too low`);

const pickSurname = await page.locator('.pc-pick .pc-surname').first().innerText();
if (pickSurname && pickSurname === pickSurname.toUpperCase()) log('pick surname uppercase');
else fail(`pick surname not uppercase: ${JSON.stringify(pickSurname)}`);

const pickStars = await page.locator('.pc-pick .pc-stars').first().innerText();
if (pickStars && /[★☆]/.test(pickStars)) log('pick card shows slot-fit stars');
else fail(`pick stars missing: ${JSON.stringify(pickStars)}`);

// Auto-pick fills the XI
await page.click('.btn.secondary.big');
await sleep(500);
const dimmedCount = await page.locator('.pc-pick .pc-dimmed').count();
const stampCount = await page.locator('.pc-pick .pc-stamp').count();
console.log('  dimmed picks:', dimmedCount, 'stamps:', stampCount);
if (dimmedCount >= 9) log('used picks dimmed');
else fail(`dimmed picks only ${dimmedCount}`);

// Confirm lineup → overview (matchday 1 simulated)
await page.click('.bar-hint .btn.big.primary');
await sleep(2000);

// --- Loop: Play all / confirm remaining focus lineups until ceremonies unlock ---
let ceremoniesPending = 0;
let guard = 0;
while (guard < 12) {
  guard += 1;
  const playAll = page.locator('.cmd-bar .btn.secondary.big:not(.corners)');
  if (await playAll.count()) {
    await playAll.click();
    await sleep(800);
  }
  // If the gate routed us into a lineup for the next focus match, auto-fill + confirm.
  if (await page.locator('.pc-pick').count()) {
    await page.click('.btn.secondary.big');
    await sleep(300);
    await page.click('.bar-hint .btn.big.primary');
    await sleep(1500);
    continue;
  }
  // Otherwise wait for revelation to finish.
  const corners = page.locator('.cmd-bar .btn.secondary.big.corners');
  if (await corners.count()) { ceremoniesPending = 1; break; }
  await sleep(1500);
}
console.log('  ceremonies button present:', ceremoniesPending > 0);
if (!ceremoniesPending) fail('tournament did not reveal to ceremonies');

// Overview scorer cards (side column) once everything is revealed
const overviewScorerCards = await page.locator('.side-col .pc-list .pcard').count();
console.log('  overview scorer cards:', overviewScorerCards);
if (overviewScorerCards >= 5) log('overview top-scorer cards rendered');
else console.log('WARN overview scorer cards:', overviewScorerCards);

const scorerRank = await page.locator('.side-col .pc-list .pcard .pc-num').first().innerText();
const scorerGoals = await page.locator('.side-col .pc-list .pcard .pc-goals b').first().innerText();
const scorerSub = await page.locator('.side-col .pc-list .pcard .pc-sub').first().innerText();
console.log('  scorer rank/goals/sub:', scorerRank, scorerGoals, scorerSub);
if (scorerRank && scorerGoals && scorerSub) log('scorer card shows rank + goals + team sub');
else console.log('WARN scorer card fields missing');

// Go to ceremonies
await page.click('.cmd-bar .btn.secondary.big.corners');
await sleep(1800);

// --- Finals verification ---
const medalCards = await page.locator('.pcard.pc-medal').count();
console.log('  medal cards:', medalCards);
if (medalCards >= 1) log('finals medal cards rendered');
else fail('no medal cards on finals');

const bands = await page.locator('.pcard .pc-band .band-pill').allTextContents();
console.log('  medal bands:', bands);
if (bands.length >= 1) log('medal band ribbons present');
else console.log('WARN no medal bands:', bands);

const ringGold = await page.locator('.pc-ring-gold').count();
const ringSilver = await page.locator('.pc-ring-silver').count();
const ringBronze = await page.locator('.pc-ring-bronze').count();
console.log('  rings gold/silver/bronze:', ringGold, ringSilver, ringBronze);
if (ringGold >= 1) log('gold ring on golden-ball card');
else console.log('WARN gold ring missing');

const medalStars = await page.locator('.pc-medal .pc-stars').first().innerText();
if (medalStars && /[★☆]/.test(medalStars)) log('medal card shows stars');
else console.log('WARN medal stars missing:', medalStars);

const medalScore = await page.locator('.pc-medal .pc-goals b').first().innerText();
if (medalScore && medalScore.includes('.')) log('medal card shows avg score');
else console.log('WARN medal score missing:', medalScore);

const bootRows = await page.locator('.table-card.wide .pc-list .pcard.pc-row').count();
console.log('  boot-race rows:', bootRows);
if (bootRows >= 5) log('boot race shown as row cards');
else console.log('WARN boot rows:', bootRows);

const rightStack = await page.locator('.pc-right-stack').count();
if (rightStack >= 1) log('boot race shows goals & assists blocks');
else console.log('WARN right stacks:', rightStack);

if (await page.locator('.medal-name, .medal-title').count() === 0) log('no legacy medal markup left');
else console.log('WARN legacy medal markup remains');

console.log('\n=== CARD REDESIGN VERIFICATION COMPLETE ===');
await browser.close();