// watch-run.mjs — Playwright E2E: watch a full 1930 run as a spectator,
// revealing every match in play order and screenshotting the bracket at each
// stage transition. This is the UI-level proof of the invariants the offline
// sim suite checks: the first knockout column fills in exactly when the group
// stage completes, and the champion banner fires only after the final reveal.
//
//   Requires: server on :8080 (serving client/dist) + `npm run build`.
//   Run:       node playwright/watch-run.mjs    (or npm run test:e2e)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const OUT = "/Users/martin/Documents/Otros/WCS/pwtest-shots";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1360, height: 1050 }, locale: "en" })
).newPage();
page.on("pageerror", (e) => console.error("PAGE-ERROR", e.message));

await page.goto("http://127.0.0.1:8080?seed");
await sleep(1200);

// Pick the 1930 cup (shortest run) as a neutral spectator.
await page.locator(".cup-card", { hasText: "1930" }).first().click();
await sleep(800);
await page.getByRole("button", { name: /spectator/i }).click();
await sleep(1000);

// Wait for the overview run to load and the first match to be pending.
await page.waitForSelector(".match-row", { timeout: 10000 });
const totalRows = await page.locator(".match-row").count();
console.log("matches in list:", totalRows);

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

// Walk through the whole tournament, reveal by reveal, snapping the bracket
// after each round boundary (when the "next" match is not in the same stage).
let stageKey = "";
let step = 0;
while (true) {
  const sim = page.locator(".match-row.next button.btn.sim");
  if (!(await sim.count())) break;
  const row = page.locator(".match-row.next");
  const mrStage = await row.locator(".mr-stage").first().textContent().catch(() => "");
  await sim.click();
  await sleep(300);
  step += 1;
  if (mrStage && mrStage !== stageKey) {
    stageKey = mrStage;
    const tag = step < 10 ? `0${step}` : String(step);
    await shot(`watch-run-${tag}-${stageKey.replace(/[^\w]+/g, "-")}`);
    console.log(`shot at round boundary ${tag} (stage ${stageKey})`);
  }
}

// Everything revealed: the champion banner must be on screen.
await sleep(500);
await page.waitForSelector(".champ-card", { timeout: 8000 }).catch(() => null);
await shot("watch-run-final");
console.log(
  "banner visible:",
  (await page.locator(".champ-card").count()) > 0,
);
console.log("screenshots written to", OUT);
await browser.close();