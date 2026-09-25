// helpers.ts — shared test plumbing for the wcs-client sim suite.
//
// The tests run under `tsx --test` (see package.json) so they can import the
// app's TypeScript modules directly. Oracle fixtures are committed gzipped
// under tests/fixtures/ (regenerate with `node scripts/fetch-oracles.mjs`);
// a fixed seed makes every suite deterministic.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRun, type Oracle } from "../src/sim/run.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Every seeded edition, oldest to newest. */
export const EDITIONS = [
  1930, 1934, 1938, 1950, 1954, 1958, 1962, 1966, 1970, 1974, 1978, 1982,
  1986, 1990, 1994, 1998, 2002, 2006, 2010, 2014, 2018, 2022, 2026,
] as const;

export function oracleFor(year: number): Oracle {
  const raw = readFileSync(join(here, "fixtures", `oracle-${year}.json.gz`));
  return JSON.parse(gunzipSync(raw).toString()) as Oracle;
}

/** Fixed base seed for every run in the suite (matches the old det pattern). */
export const RUN_SEED = 1234567890123456789n;

/** Run a full edition with the suite's canonical seed. */
export function run(year: number) {
  return generateRun(oracleFor(year), { seed: RUN_SEED, focus_team_id: null });
}