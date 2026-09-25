// bracket-dom.mjs — Playwright assertions that the *rendered* bracket matches
// what sim/bracketLayout.ts declares. Uses fresh context per edition to avoid
// SPA shell caching.
import { chromium } from "playwright";

const HOST = "http://127.0.0.1:8080";
const browser = await chromium.launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runEditionInFreshContext(year) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1400 }, locale: "en" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGE-ERROR", e.message));
  page.on("dialog", (d) => d.accept());

  await page.goto(HOST + "?seed", { waitUntil: "networkidle" });
  await page.waitForSelector(".cup-card", { timeout: 15000 });

  await page
    .locator(".cup-card:not(.disabled)")
    .filter({ has: page.locator("span.cup-year", { hasText: String(year) }) })
    .first()
    .click();
  await sleep(600);
  await page.getByRole("button", { name: /spectator|interactive/i }).click();
  await page.waitForSelector(".match-row", { timeout: 10000 });

  // Reveal everything with single FF click (auto-stops on completion).
  const ff = page.locator(".top-actions button").filter({ hasText: /fast forward|ff/i }).first();
  if (await ff.count()) await ff.click();
  await page.waitForSelector(".champ-card", { timeout: 45000 }).catch(() => {});
  await sleep(800);

  const dashed = await page.locator('.bk-lines polyline[stroke-dasharray]').count();
  const total = await page.locator('.bk-lines polyline').count();
  const cols = await page.locator('.bk-col-label').allTextContents();
  console.log(
    `${year}: cols=[${cols.map((c) => c.replace(/\s+/g, " ").trim()).join(", ")}] polylines=${total} dashed=${dashed}`
  );

  await ctx.close();
  return { dashed, total };
}

const assert = (c, msg) => { if (!c) throw new Error(msg); };

const c1930 = await runEditionInFreshContext(1930);
const c1978 = await runEditionInFreshContext(1978);
const c2026 = await runEditionInFreshContext(2026);

assert(c1930.dashed === 1, "1930 must render exactly one dashed THIRD-UP spine");
assert(c1978.dashed === 0, "1978 must render NO dashed spine (no third-place round)");
assert(c2026.dashed === 1, "2026 must render exactly one dashed spine");

await browser.close();
console.log("bracket DOM assertions OK");