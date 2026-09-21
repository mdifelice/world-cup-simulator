// parity3.mts — FINAL byte gate (v3.0, tool-written, no shell heredocs).
// Reads the committed fixture as RAW BYTES; regex-extracts each group's exact
// decimal tokens (never JSON.parse → never f64 → never u64 rounding).
// Port emits exact bigint decimals via seed.ts exports; compares 1:1 as
// strings. Exit 0 = byte parity proven. Node v26+: node parity3.mts.
import { readFileSync } from "node:fs";
import { Rng, splitmix64, str_key, match_seed, poisson } from "./seed.ts";

const PATH = "/Users/martin/Documents/Otros/WCS/server/tests/fixtures/seed_1231231231231231231.json";
const raw = readFileSync(PATH, "utf8");

function rawTokens(key: string): string[] {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return m[1].split(",").map((t) => t.trim().replace(/^"|"$/g, "")).filter((t) => t !== "" && t !== "null");
}

const SEED = 1231231231231231n;

const rngNext = (() => {
  const r = Rng.from_seed(SEED);
  const g: string[] = [];
  for (let i = 0; i < 16; i++) g.push(String(r.next()));
  return g;
})();

const rngUnit0 = (() => {
  const r = Rng.from_seed(0n);
  const g: string[] = [];
  for (let i = 0; i < 8; i++) g.push(String(r.unit()));
  return g;
})();
const rngUnit1 = (() => {
  const r = Rng.from_seed(1n);
  const g: string[] = [];
  for (let i = 0; i < 8; i++) g.push(String(r.unit()));
  return g;
})();

const pois = (lam: number): string[] => {
  const r = Rng.from_seed(SEED);
  return Array.from({ length: 10 }, () => String(poisson(r, lam)));
};

const groups: [string, string[]][] = [
  ["rng_next", rngNext],
  ["rng_unit_seed0", rngUnit0],
  ["rng_unit_seed1", rngUnit1],
  ["poisson_low", pois(0.9)],
  ["poisson_mid", pois(1.3)],
  ["poisson_high", pois(2.1)],
  ["splitmix64", [0n, 1n, SEED, (1n << 64n) - 1n].map((x) => String(splitmix64(x)))],
  ["str_key", ["G1", "KO16", "THIRD", "F", "poisson", ""].map((s) => String(str_key(s)))],
  ["match_seed_group", [
    String(match_seed(SEED, "G1", 1, 101n, 202n, false)),
    String(match_seed(SEED, "G1", 6, 303n, 404n, false)),
  ]],
  ["match_seed_ko", [
    String(match_seed(SEED, "KO16", 1, 101n, 202n, true)),
    String(match_seed(SEED, "THIRD", 1, 111n, 222n, true)),
    String(match_seed(SEED, "F", 1, 333n, 444n, true)),
  ]],
  ["live_minutes", (() => {
    const r = Rng.from_seed(match_seed(SEED, "F", 90, 0n, 0n, true));
    let lead = 0n;
    const g: string[] = [];
    for (let m = 1; m <= 90; m++) {
      let lh: number;
      let la: number;
      if (lead > 0n) { lh = 0.9; la = 2.1; }
      else if (lead < 0n) { lh = 2.1; la = 0.9; }
      else { lh = 1.3; la = 1.3; }
      const gh = poisson(r, lh);
      const ga = poisson(r, la);
      lead += BigInt(gh - ga);
      g.push(`${m}:${gh}:${ga}`);
    }
    return g;
  })()],
];

let fails = 0;
for (const [key, mine] of groups) {
  const oracle = rawTokens(key);
  if (oracle.length !== mine.length) {
    console.log(`COUNT ${key}: oracle=${oracle.length} port=${mine.length}`);
    fails++;
    continue;
  }
  for (let i = 0; i < oracle.length; i++) {
    if (oracle[i] !== mine[i]) {
      console.log(`DRIFT ${key}[${i}]: port=${mine[i]} oracle=${oracle[i]}`);
      fails++;
    }
  }
}
if (fails === 0) {
  console.log(`PARITY OK — ${groups.length} groups, all tokens raw-text byte-equal on seed ${SEED}`);
  process.exit(0);
} else {
  console.log(`${fails} drifted token(s)`);
  process.exit(1);
}
