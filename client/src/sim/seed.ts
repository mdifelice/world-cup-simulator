// seed.ts — client-side port of the WCS deterministic engine primitives.
//
// Parity contract: this module reproduces byte-for-byte the oracle fixture
// committed at
//   server/tests/fixtures/seed_1231231231231231231.json
// (fixed seed 1231231231231231231). All constants below are lifted verbatim
// from server/src/sim.rs (Rng) and server/src/detail.rs (str_key, splitmix64,
// match_seed, poisson). The parity check is emitted deterministically with the
// same seed and compared 1:1 against that fixture — any divergence is silent
// drift flagged red. Do not hand-tune.

const MASK = (1n << 64n) - 1n;
const UNIT_DIV = 2 ** 53;

/** sim.rs:18-44 — xorshift64: from_seed(s) = Rng(s|1); next(); unit()=next()>>11/2^53. */
export class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = seed | 1n;
  }
  static from_seed(seed: bigint): Rng {
    return new Rng(seed);
  }
  next(): bigint {
    let x = this.s;
    x ^= x << 13n;
    x &= MASK;
    x ^= x >> 7n;
    x ^= x << 17n;
    x &= MASK;
    this.s = x;
    return x;
  }
  unit(): number {
    return Number(this.next() >> 11n) / UNIT_DIV;
  }
}

/** detail.rs:158-163 — splitmix64 finalizer. */
export function splitmix64(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

/** detail.rs:166-170 — str_key: FNV-rotate fold (rotate_left(8), add, mul). */
export function str_key(s: string): bigint {
  const bytes = new TextEncoder().encode(s);
  let acc = 0x243f6a8885a308d3n;
  for (const b of bytes) {
    acc = ((acc << 8n) | (acc >> 56n)) & MASK;
    acc = (acc + BigInt(b)) & MASK;
    acc = (acc * 0x100000001b3n) & MASK;
  }
  return acc;
}

/** detail.rs:149-156 — match_seed(run_seed, key, day, home, away, knockout) -> u64|1. */
export function match_seed(
  run_seed: bigint,
  key: string,
  day: number,
  home: bigint,
  away: bigint,
  knockout: boolean,
): bigint {
  let x = run_seed ^ str_key(key);
  const fields: bigint[] = [BigInt(day), home, away, knockout ? 1n : 0n];
  for (const v of fields) {
    x ^= v;
    x = splitmix64(x);
  }
  return x | 1n;
}

/** detail.rs:120-146 / sim.rs:46-64 — poisson via Knuth inversion (k cap 8). */
export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  const el = Math.exp(-lambda);
  let p = 1;
  let k = 0;
  do {
    p *= rng.unit();
    k++;
  } while (k < 8 && p > el);
  // sim.rs:60-64 — Knuth exit: k counts draws made; the committed oracle's
  // groups are k−1 (the final draw that crossed p≤el is not counted). The
  // fixture (poisson_low/mid/high) is the byte-truth; 0≤result≤8.
  return k - 1;
}
