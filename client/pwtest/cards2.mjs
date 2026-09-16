import { chromium } from 'playwright';

const BASE = 'http://localhost:8080';
const log = (...args) => console.log('PASS', ...args);
const fail = (...args) => { console.log('FAIL', ...args); process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 1200 }, locale: 'en' })).newPage();
page.on('pageerror', e => { console.error('PAGE-ERROR', e.message); process.exitCode = 1; });

// Seed tournaments, open app, pick team + tournament
await page.goto(BASE + '?seed');
await sleep(1500);
await page.click('.cup-card:not([disabled]):first-child');   // 2026 (verified flow)
await sleep(800);
await page.click('.team-card:first-child');                  // Argentina (rated 1st)
await sleep(2500);

// --- Font check ---
const ff = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
console.log('  body font-family:', ff);
if (/Google Sans/.test(ff)) log('font switched to Google Sans (body)');
else console.log('WARN body font has no Google Sans:', ff);
const btnFf = await page.evaluate(() => getComputedStyle(document.querySelector('button')).fontFamily);
if (/Google Sans/.test(btnFf)) log('buttons use Google Sans');
else console.log('WARN button font:', btnFf);

// --- Roster: mini cards + uppercase country names ---
await page.waitForSelector('.pcard.pc-mini', { timeout: 6000 });
const miniW = await page.locator('.pcard.pc-mini').first().evaluate(el => el.getBoundingClientRect().width);
const miniH = await page.locator('.pcard.pc-mini').first().evaluate(el => el.getBoundingClientRect().height);
console.log('  mini card size:', miniW, 'x', miniH);
if (miniW > 50 && miniH > 70) log('squad pick cards are 25% larger than the picker minis');
else fail(`squad card not enlarged: ${miniW} x ${miniH}`);

const surn = await page.locator('.pcard.pc-mini .pc-surname').first().innerText();
if (surn === surn.toUpperCase()) log('mini surname uppercase');
else fail('mini surname not uppercase');

// --- Start cup, land on the tournament hub ---
await page.click('.btn-row .btn.primary');
await page.waitForSelector('.hub', { timeout: 10000 });
await sleep(700);
const totalRows = await page.locator('.match-row').count();
if (totalRows >= 32) log(`tournament hub lists all ${totalRows} matches`);
else fail(`too few matches on hub: ${totalRows}`);
if (await page.locator('.cmd-bar').count() === 0) log('old step-navigation .cmd-bar is gone from the hub');
else fail('legacy .cmd-bar still present on the hub');

// --- Play must be gated on a chosen formation ---
// With real 2026 groups the focus team can sit in a late group (A–I play
// first), so simulate the non-focus matches until the focus match is "next".
for (let sims = 0; sims < 130; sims++) {
  const nextPlay = page.locator('.match-row.next .btnm.play');
  if ((await nextPlay.count()) > 0) break;
  const sim = page.locator('.match-row.next .btnm.simulate');
  if ((await sim.count()) === 0) break;
  await sim.click();
  await sleep(300);
}
const playGate = page.locator('.match-row.next .btnm.play');
if ((await playGate.count()) === 0) {
  fail('no play gate on the next match after simulating through early groups');
} else if (await playGate.isDisabled()) log('Play disabled until a formation is chosen');
else fail('Play enabled without a formation');

// The status line must say "played", not "revealed"
const headText = await page.locator('.page-head .hint').innerText();
console.log('  hub status:', headText);
if (/played|jugados/i.test(headText)) log('status line counts "played" matches');
else console.log('WARN status line wording:', headText);

// --- Lineup: inline formation editor (player-first flow, no AUTO labels) ---
await page.waitForSelector('.form-editor .pc-pick', { timeout: 8000 });
const markerTexts = await page.locator('.form-editor .slot-marker').allTextContents();
console.log('  marker texts sample:', markerTexts.slice(0, 6));
const autoLeft = markerTexts.filter(t => /auto/i.test(t)).length;
if (autoLeft === 0) log('no "auto" labels on pitch markers');
else fail(`"auto" still on ${autoLeft} markers: ${JSON.stringify(markerTexts)}`);

const clearTitle = await page.locator('.form-editor .slot-marker').first().getAttribute('title');
console.log('  empty marker title:', clearTitle);
if (await page.locator('.form-confirm .btn.primary').count() === 0) {
  log('no "Use this lineup" button (lineup applies by itself)');
} else fail('confirm button still present');
if (await page.locator('.form-confirm .hint').count()) log('form panel hints that the lineup is auto-applied');
else console.log('WARN no auto-apply hint in form-confirm');

// Player-first: arm a player card, then tap a slot
await page.locator('.form-editor .pc-pick').nth(1).click(); // arm player #2
await sleep(300);
const armedSel = await page.locator('.form-editor .pc-pick .pc-selected').count();
console.log('  armed pc-selected cards:', armedSel);
if (armedSel === 1) log('player card arms on click (selected ring)');
else fail(`armed cards not 1: ${armedSel}`);

const filledBefore = await page.locator('.form-editor .slot-marker.filled').count();
await page.locator('.form-editor .slot-marker:not(.filled)').first().click(); // tap target slot
await sleep(400);
const filledAfter = await page.locator('.form-editor .slot-marker.filled').count();
console.log('  slots filled before/after:', filledBefore, filledAfter);
if (filledAfter === filledBefore + 1) log('player-first flow: player → slot assigns');
else fail(`assignment failed: ${filledBefore} -> ${filledAfter}`);

const armedAfter = await page.locator('.form-editor .pc-pick .pc-selected').count();
if (armedAfter === 0) log('armed player cleared after placing');
else console.log('WARN armed still selected after placement');

// Auto-pick must give way once the user has chosen a player by hand
const autoChip = page.locator('.form-editor .btn.secondary.chip');
if (await autoChip.isDisabled()) log('Auto-pick disables once a player is chosen by hand');
else fail('Auto-pick still enabled after a manual pick');
await page.locator('.form-editor .slot-marker.filled .slot-clear').first().click(); // unselect
await sleep(300);
if (await page.locator('.form-editor .slot-marker.filled').count() === 0) log('unselecting clears the slot');
else console.log('WARN slot still filled after unselect');
if (!(await autoChip.isDisabled())) log('clearing a pick re-enables Auto-pick');
else fail('Auto-pick stayed disabled after clearing');

// Auto + apply — the pitch stays on screen (no summary panel replaces it)
const pickGroups = await page.locator('.form-editor .pick-group').count();
const miniPicks = await page.locator('.form-editor .pick-grid .pcard.pc-mini').count();
if (pickGroups >= 4 && miniPicks >= 20) {
  log(`position-grouped picker: ${pickGroups} rows (GK/DF/MF/FW), ${miniPicks} mini cards`);
} else fail(`picker layout wrong: ${pickGroups} groups / ${miniPicks} mini cards`);
await autoChip.click();
await page.waitForSelector('.form-confirm .chip.ok', { timeout: 9000 });
await sleep(1500);
const fill11 = await page.locator('.form-editor .slot-marker.filled').count();
console.log('  pitch marker count after auto-apply:', fill11, '(editor stays visible)');
if (fill11 === 11) log('the full XI stays on the pitch after auto-apply (pitch not hidden)');
else fail(`pitch not fully filled after auto-apply: ${fill11}`);
if (await page.locator('.form-summary').count() === 0) log('no summary panel replaces the pitch');
else fail('old summary panel still present');
const sumNames = await page.locator('.form-editor .slot-marker.filled').evaluateAll((els) =>
  els.map((e) => (e.getAttribute('title') || '').split(' — ')[0]));
if (new Set(sumNames).size === 11) log('no player appears in two positions (distinct XI)');
else fail('duplicate player in the XI: ' + JSON.stringify(sumNames));
const persistsHint = await page.evaluate(() =>
  /set once|used for every match|vale para todo el Mundial/i.test(document.body.innerText));
if (!persistsHint) log('no "set once" text remains in the formation panel');
else fail('stale "set once" hint still visible');

// --- Unselecting a player must disable the Play button again ---
await page.locator('.form-editor .slot-marker.filled').last().dblclick();
await sleep(500);
if ((await playGate.count()) && (await playGate.isDisabled())) {
  log('clearing a player disables Play again');
} else fail('Play still enabled with an incomplete lineup');

// Complete the XI again and the lineup applies on its own → Play enabled
const emptyLabel = await page.locator('.form-editor .slot-marker:not(.filled)').first().innerText();
const famOf = (l) =>
  /GK/.test(l) ? 0 : /DF|WB|CB|RB|LB/.test(l) ? 1 : /MF|DM|CM|AM|WM/.test(l) ? 2 : 3;
const famIdx = famOf(emptyLabel);
const pickIdx = await page
  .locator('.form-editor .pick-group')
  .nth(famIdx)
  .locator('.pc-pick')
  .evaluateAll((els) => els.findIndex((e) => !e.querySelector('.pc-stamp')));
if (pickIdx < 0) {
  fail(`no unused ${famIdx} player to complete the XI`);
} else {
  await page.locator('.form-editor .pick-group').nth(famIdx).locator('.pc-pick').nth(pickIdx).click();
  await sleep(200);
  await page.locator('.form-editor .slot-marker:not(.filled)').first().click();
  await page.waitForSelector('.form-confirm .chip.ok', { timeout: 9000 });
  await sleep(1500);
  if (!(await playGate.isDisabled())) log('Play re-enables once the XI is complete again');
  else fail('Play still disabled after completing the lineup');
}

// --- Play the day-1 focus match in the modal; inspect the momentum chart ---
const nextPlay = page.locator('.match-row.next .btnm.play');
if (await nextPlay.count()) log('next match is a focus match → Play button');
else fail('next action is not a Play button');
if (!(await nextPlay.isDisabled())) log('Play enabled once the formation is set');
else fail('Play still disabled after a lineup was chosen');
await nextPlay.click();
await page.waitForSelector('.live-modal .momentum .mom-bar', { timeout: 15000 });
if (await page.locator('.live-modal .live-x').count() === 0) {
  log('modal cannot be closed while the match is playing');
} else fail('close (X) button visible during play');
await sleep(2200); // let a few minutes tick by

const labelNow = await page.locator('.live-modal .match-label').innerText().catch(() => null);
console.log('  match label during play:', labelNow, '| scoreboard:', await page.locator('.live-modal .vs-score').allTextContents());
if (labelNow != null && !labelNow.includes('–')) log('single score in the modal (label shows only the clock)');
else console.log('WARN duplicate score in the match label');

const bars = await page.locator('.live-modal .momentum .mom-bar').count();
const green = await page.locator('.live-modal .momentum .mom-bar.up').count();
const red = await page.locator('.live-modal .momentum .mom-bar.down').count();
console.log('  momentum bars (total/green/red):', bars, green, red);
if (bars >= 3) log('per-minute vertical bars render in the modal chart');
else fail(`too few bars: ${bars}`);
if (green + red === bars) log('bars colored green (you) / red (opponent)');
else console.log('WARN bar coloring mismatch', green, red, bars);

const midline = await page.locator('.live-modal .momentum [stroke-dasharray]').count();
if (midline >= 1) log('midline dashes split the chart in two');
else console.log('WARN midline not found', midline);

const legend = await page.locator('.live-modal .chart-legend .dot').count();
if (legend === 2) log('chart legend shows you/opponent dots');
else console.log('WARN legend dots:', legend);

const clock = await page.locator('.match-clock').first().innerText().catch(() => null);
console.log('  live clock:', clock);
if (clock != null && /\d+'/.test(clock)) log('live minute ticker runs inside the modal');
else console.log('WARN no ticking clock', clock);

// Wait for match end → primary button must be "Back to tournament"
await page.waitForSelector('.live-modal .match-actions', { timeout: 40000 });

// Goals list: newest first, and no country name next to the scorer
const goalRows = page.locator('.live-modal .goal-row');
const goalCount = await goalRows.count();
if (goalCount > 1) {
  const gmin = await goalRows.locator('.goal-min').allTextContents();
  const nums = gmin.map((s) => parseInt(String(s).split("'")[0].trim(), 10));
  console.log('  goal minutes (display order):', nums.join(','));
  const desc = nums.every((v, i) => i === 0 || nums[i - 1] >= v);
  if (desc) log('goals are listed newest first (descending minute)');
  else fail('goals not sorted descending: ' + nums.join(','));
} else console.log(`WARN only ${goalCount} goal row(s) this match`);
if ((await page.locator('.live-modal .goal-team').count()) === 0) {
  log('no country name next to goals in the modal');
} else fail('country name still next to goals');
if (goalCount > 0) {
  const anim = await page
    .locator('.live-modal .goal-row')
    .first()
    .evaluate((el) => getComputedStyle(el).animationName)
    .catch(() => null);
  if (anim === "goal-in") log('goal rows animate in smoothly ("goal-in")');
  else console.log('WARN goal-row animation:', anim);
}
const endLabel = await page.locator('.live-modal .match-label').innerText().catch(() => '');
if (!endLabel.includes('–')) log('score not duplicated next to the clock at match end');
else console.log('WARN score duplicated at match end:', endLabel);

const btns = await page.locator('.live-modal .match-actions .btn').allTextContents();
console.log('  match-end buttons:', JSON.stringify(btns));
if (btns.some(b => /Back to tournament/i.test(b))) {
  log('match end offers "Back to tournament" as the primary action');
} else fail('no Back to tournament at match end: ' + JSON.stringify(btns));
if (btns.some(b => /Next round/i.test(b))) fail('"Next round" button still present');
else log('no "Next round" button anymore');

// Click back → returns to the hub
await page.locator('.live-modal .match-actions .btn.primary.big').click();
await sleep(1200);
if (await page.locator('.hub').count()) log('match end returns to the tournament hub');
else {
  console.log('  body:', (await page.locator('body').innerText()).slice(0, 300));
  fail('did not land on the tournament hub');
}

// Revealed group tables now visible on the hub — codes + P/GD/Pts only
if (await page.locator('.stand-table').count()) log('group tables appear on the standings column');
else console.log('WARN no group table yet (no group match revealed)');
const head = await page.locator('.stand-table').first().locator('thead th').allTextContents();
console.log('  group table header:', JSON.stringify(head));
if (head.length === 5 && !['W', 'D', 'L', 'GF', 'GA'].some(h => head.includes(h))) {
  log('group table shows P · GD · Pts only');
} else fail('unexpected group columns: ' + JSON.stringify(head));
const cells = await page.locator('.stand-table .team-cell').allTextContents();
console.log('  group team cells:', JSON.stringify(cells.slice(0, 4)));
if (cells.some(c => /(?:^|\s)[A-Z]{3}$/.test(c.trim()))) log('group rows use 3-letter FIFA codes');
else fail('no FIFA codes in group table');
const overviewCellTransform = await page.evaluate(() => {
  const el = document.querySelector('.stand-table .team-cell');
  return el ? getComputedStyle(el).textTransform : null;
});
console.log('  team-cell text-transform (standings):', overviewCellTransform);
if (overviewCellTransform === 'uppercase') log('country names uppercase in group tables');
else console.log('WARN team-cell not uppercased on the hub');

// --- Fast-forward: simulates the rest of the current phase, stops at the focus match ---
const ffBtn = page.locator('.page-head .btn.ff');
if (await ffBtn.count() === 0) {
  console.log('WARN fast-forward button not rendered on the page head');
} else if (await ffBtn.isDisabled()) {
  const title = await ffBtn.getAttribute('title');
  console.log('  ff disabled, title:', title);
  console.log('WARN ff disabled right away (next match is the focus one)');
} else {
  const doneBefore = await page.locator('.match-row.done').count();
  await ffBtn.click();
  await sleep(1400);
  const doneAfter = await page.locator('.match-row.done').count();
  console.log('  done rows before/after ff:', doneBefore, doneAfter);
  if (doneAfter > doneBefore) log('fast-forward revealed the whole pending phase');
  else fail('fast-forward revealed nothing');
  const ffNextPlay = await page.locator('.match-row.next .btnm.play').count();
  const ffNextDisabled = await page.locator('.match-row.next .btnm.play').isDisabled();
  if (ffNextPlay === 1 && !ffNextDisabled) log('fast-forward stopped right before the focus match');
  else console.log('WARN next row after ff not a playable focus match');
  if (await page.locator('.match-row.next .btnm.simulate').count() === 0) {
    log('no simulate beyond the focus position (phase ended)');
  }
}

// --- Reveal everything: resumes through Play modals, simulates the rest ---
let guard = 0;
while (guard < 200) {
  guard += 1;
  const next = page.locator('.match-row.next');
  if ((await next.count()) === 0) break;
  const play = next.locator('.btnm.play');
  if ((await play.count()) > 0) {
    await play.click();
    await page.waitForSelector('.live-modal .match-actions', { timeout: 40000 });
    await page.click('.live-modal .match-actions .btn.primary.big');
    await sleep(400);
  } else {
    const sim = next.locator('.btnm.simulate');
    if ((await sim.count()) > 0) { await sim.click(); await sleep(120); }
    else break;
  }
}
await sleep(1200);
const doneRows = await page.locator('.match-row.done').count();
const nextLeft = await page.locator('.match-row.next').count();
console.log('  done rows / next left:', doneRows, nextLeft);
if (doneRows === totalRows && nextLeft === 0) log('entire tournament revealed on the hub');
else console.log(`WARN not fully revealed (${doneRows}/${totalRows}, next ${nextLeft})`);

const champCard = await page.locator('.champ-card .champ-line').innerText().catch(() => null);
if (champCard) log(`champion card shown: ${champCard.trim()}`);
else console.log('WARN no champion card after full reveal');

// Bracket columns now map to started phases only — no empty placeholders
const emptyCols = await page.locator('.bracket .br-col').evaluateAll(cols => cols.filter(c => !c.querySelector('.br-tie')).length);
console.log('  bracket columns without a tie:', emptyCols);
if (emptyCols === 0) log('bracket has no empty placeholder columns');
else fail(`bracket placeholder columns: ${emptyCols}`);

// Raw English "Quarter-finals"/"Semi-finals" must not leak through — stage()
// maps them to the dictionary in the active locale.
const rawStages = await page.evaluate(() =>
  /Quarter-finals|Semi-finals/i.test(document.body.innerText));
if (!rawStages) log('Quarter-finals / Semi-finals are translated (no raw stage names)');
else console.log('WARN raw "Quarter-finals / Semi-finals" still visible');

// Top scorers — now exactly a top-5 box, no g/a letter under the number
const scorerCards = await page.locator('.standings.scorers .pcard.pc-stat').count().catch(() => 0);
console.log('  scorer rows:', scorerCards);
if (scorerCards === 5) log('top scorers box shows exactly 5 players');
else console.log(`WARN scorer cards: ${scorerCards}`);
if (await page.locator('.standings.scorers .pcard.pc-stat .pc-photo').count()) {
  log('scorer rows show a circular avatar on the left');
} else fail('scorer rows have no circular photo');
const letterUnderNumber = await page.evaluate(() =>
  [...document.querySelectorAll('.standings.scorers .pc-goals')]
    .filter(el => el.querySelector('span')).length);
if (letterUnderNumber === 0) log('no G/A letter under the goals number');
else console.log(`WARN ${letterUnderNumber} g/a letters still listed`);

// Assists — a separate box below, also top 5
const assistsCard = page.locator('.col-card').filter({ hasText: /assist/i }).first();
if (await assistsCard.count()) {
  const assistRows = await assistsCard.locator('.pcard.pc-stat').count();
  console.log('  assist rows:', assistRows);
  if (assistRows === 5) log('own "Top assists" box shows exactly 5 players');
  else fail(`assist rows not 5: ${assistRows}`);
} else fail('assists box missing');

// Champion card opens the final summary modal (no image, no sharing API)
const champBtn = await page.locator('.champ-card .btn.primary');
if (await champBtn.count() === 0) {
  fail('champ card has no summary button');
} else {
  if (/view summary|ver resumen/i.test(await champBtn.innerText())) log('champ card offers "View summary"');
  else console.log('WARN summary button label:', await champBtn.innerText());
  await champBtn.click();
  await page.waitForSelector('.share-modal', { timeout: 8000 });
  if ((await page.locator('.share-modal .share-preview, .share-modal .share-img').count()) === 0) {
    log('no image preview / generator in the share modal');
  } else fail('image preview still rendered in the share modal');
  const podium = await page.locator('.share-modal .podium-row').count();
  if (podium === 3) log('share modal shows the full podium (1st/2nd/3rd)');
  else fail('share modal podium rows: ' + podium);
  if (await page.locator('.share-modal .share-block').count() >= 3) {
    log('share modal lists best players, top scorer and assists');
  } else fail('share modal prizes missing');
  const scorerRows = await page
    .locator('.share-modal .share-block')
    .nth(1)
    .locator('.share-row')
    .count();
  if (scorerRows === 3) log('top scorers block shows the 3 best scorers');
  else fail('top scorers rows: ' + scorerRows);
  const ratingInBest = await page
    .locator('.share-modal .share-block')
    .first()
    .locator('.share-num')
    .count();
  if (ratingInBest === 0) log('best players list shows no rating');
  else fail(`best players still show a rating: ${ratingInBest}`);
  const yourPos = await page.locator('.share-modal .your-pos').count();
  console.log('  your-position line:', yourPos ? 'shown (team outside podium)' : 'hidden (team on podium)');
  if (
    (await page
      .locator('.share-modal .share-actions .btn')
      .filter({ hasText: /view summary|ver resumen/i })
      .count()) === 1
  ) {
    log('share modal offers "View summary"');
  } else console.log('WARN no View summary button in share modal');
  const vsBtn = page.locator('.share-modal .share-actions .btn').first();
  await vsBtn.click();
  await sleep(600);
  const vsLabel = await vsBtn.innerText();
  if (/copied|copiado/i.test(vsLabel)) log('View summary copies the résumé (button shows "Copied!")');
  else console.log('WARN button did not switch to Copied:', vsLabel);
  if (
    (await page.locator('.share-modal .share-actions .btn').filter({ hasText: /play again/i }).count()) > 0
  ) {
    log('share modal offers "Play again"');
  } else console.log('WARN no Play again button in share modal');
  await page.locator('.share-modal .share-actions .btn').last().click();
  await sleep(500);
  if (await page.locator('.share-modal').count() === 0) log('share modal closes');
  else fail('share modal did not close');
}

console.log('\n=== HUB REDESIGN REGRESSION COMPLETE ===');
await browser.close();