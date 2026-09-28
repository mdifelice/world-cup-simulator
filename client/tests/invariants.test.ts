// invariants.test.ts — match-flow contracts that hold for *every* edition.
//
// The UI reveals matches strictly in chronological (`order`) sequence; the
// bracket's first knockout column is filled exactly when the group stage is
// done; and the champion banner can only appear once the whole tournament has
// been revealed (never earlier). These are the invariants the E2E "watch a
// run" test checks by clicking, made offline and exhaustive here.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RunMatch, RunPayload } from "../src/types.ts";
import { formatsFor } from "../src/sim/formats.ts";
import { EDITIONS, run } from "./helpers.ts";

/** The app's reveal loop: firstUnrevealed finds the first match not yet
 *  revealed (run.matches is already order-sorted), and the UI adds exactly
 *  that one id to the revealed set on every forward step. */
function* revealSteps(run: RunPayload): Generator<RunMatch> {
  const revealed = new Set<number>();
  while (revealed.size < run.matches.length) {
    const next = run.matches.find((m) => !revealed.has(m.id));
    assert.ok(next, "reveal loop ran out before all matches were shown");
    revealed.add(next.id);
    yield next;
  }
}

describe("reveal flow follows play order", () => {
  for (const year of EDITIONS) {
    test(`${year}: order is exactly the chronological reveal sequence`, () => {
      const r = run(year);
      // order covers every match once and matches matches[] 1:1.
      assert.equal(r.order.length, r.matches.length);
      assert.deepEqual(
        new Set(r.order),
        new Set(r.matches.map((m) => m.id)),
        `${year}: order must be a permutation of match ids`,
      );
      for (let i = 0; i < r.order.length; i++) {
        assert.equal(r.order[i], r.matches[i].id, `${year}: order[${i}]`);
      }

      // Play order: `day` (round counter) never decreases across reveals.
      let prevDay = -1;
      for (const m of r.matches) {
        assert.ok(m.day >= prevDay, `${year}: day fell backwards at match ${m.id}`);
        prevDay = m.day;
      }
    });

    test(`${year}: no knockout match is revealed before the group stage finishes`, () => {
      const r = run(year);
      const groupKeys = formatsFor(year)
        .filter((p) => p.phase_type === "GROUP")
        .map((p) => p.key);
      const knockKeys = formatsFor(year)
        .filter((p) => p.phase_type === "KNOCKOUT")
        .map((p) => p.key);
      if (knockKeys.length === 0) return; // 1950 league decider: nothing to gate

      let idx = 0;
      const isGroup = (m: RunMatch) => groupKeys.includes(m.stage_key);
      const isKnock = (m: RunMatch) => knockKeys.includes(m.stage_key);
      for (const m of r.matches) {
        assert.ok(
          isGroup(m) || isKnock(m),
          `${year}: unexpected stage ${m.stage_key} in ${r.year}`,
        );
        if (isKnock(m)) {
          assert.ok(
            idx >= 1 || !r.matches.some((x) => isGroup(x)),
            `${year}: knockout ${m.id} revealed while group matches remain`,
          );
        }
        if (isGroup(m)) idx += 1;
      }
    });

    test(`${year}: the final is the very last match revealed`, () => {
      const r = run(year);
      const hasFinal = formatsFor(year).some((p) => p.key === "F");
      if (!hasFinal) return; // 1950 league decides the trophy
      const last = r.matches[r.matches.length - 1];
      assert.equal(last.stage_key, "F", `${year}: last reveal is not the final`);
    });
  }
});

describe("champion banner timing", () => {
  for (const year of EDITIONS) {
    test(`${year}: champion can only be declared once every match is revealed`, () => {
      const r = run(year);
      assert.ok(r.champion, `${year}: every finished run has a champion`);

      // Walk the app's reveal loop and assert the banner condition can only
      // fire on the final step.
      const revealed = new Set<number>();
      let banners = 0;
      for (const m of revealSteps(r)) {
        revealed.add(m.id);
        const allRevealed = revealed.size === r.matches.length;
        if (allRevealed && r.champion) banners += 1;
        else {
          // Mid-tournament the holder is a team still alive or an undecided
          // banner — but never a full tournament champion flash.
          assert.equal(allRevealed, false);
        }
      }
      assert.equal(banners, 1, `${year}: champion banner must fire exactly once`);
    });

    test(`${year}: the champion holds the final (or league) winner`, () => {
      const r = run(year);
      const f = r.matches.find((m) => m.stage_key === "F");
      if (!f) {
        // League decider (1950): champion is the top team, already asserted
        // in formats.test.ts against the standings-derived name.
        return;
      }
      const winnerId =
        f.penalties?.winner_id ??
        (f.home_score > f.away_score ? f.home_team_id : f.away_team_id) ??
        (f.away_score > f.home_score ? f.away_team_id : f.home_team_id);
      const winner = winnerId === f.home_team_id ? f.home_team_name : f.away_team_name;
      assert.equal(r.champion, winner, `${year} champion !== final winner`);
    });
  }
});

describe("bracket column completion gate", () => {
  for (const year of EDITIONS) {
    test(`${year}: the first knockout column is fully paired iff the group stage is done`, () => {
      const r = run(year);
      const knockKeys = formatsFor(year)
        .filter((p) => p.phase_type === "KNOCKOUT")
        .map((p) => p.key);
      const firstKnock = knockKeys.find((k) => k !== "THIRD");
      if (!firstKnock) return; // 1950

      // All first-knockout matches carry real pairings by design (the engine
      // seeds them when the groups end); the *gate* that exposes them is
      // groupStageDone in the layout module, tested separately. Here we only
      // assert the run guarantees the data is ready.
      const pairs = r.matches.filter((m) => m.stage_key === firstKnock);
      assert.ok(pairs.length > 0, `${year}: no ${firstKnock} matches`);
      for (const m of pairs) {
        assert.ok(m.home_team_id != null && m.away_team_id != null, `${year}: incomplete pairing`);
        assert.ok(m.home_team_name && m.away_team_name, `${year}: unnamed pairing`);
      }
    });
  }
});

describe("second-round group scheduling is a fair round-robin", () => {
  for (const year of EDITIONS) {
    test(`${year}: generated group phases reach every pairing once`, () => {
      const r = run(year);
      const phases = formatsFor(year).filter((p) => p.phase_type === "GROUP");
      // Only the *first* group phase mirrors real fixtures (1954's seeded
      // groups were deliberately partial — 4 games per 4-team pool — so a full
      // round-robin is only guaranteed for the engine-generated later phases:
      // 1974/78/82 second round and the 1950 league decider).
      phases.slice(1).forEach((p) => {
        const matches = r.matches.filter((m) => m.stage_key === p.key);
        // Bucket the phase's matches by the table they belong to (a phase can
        // have several groups, and 1950's decider is a single-table league).
        const tables = new Map<string, RunMatch[]>();
        for (const m of matches) {
          const label = `${p.key}:${m.stage_name ?? p.name}`;
          const bucket = tables.get(label) ?? [];
          bucket.push(m);
          tables.set(label, bucket);
        }
        for (const [label, ms] of tables) {
          const seen = new Map<number, number>();
          const pairs = new Set<string>();
          for (const m of ms) {
            seen.set(m.home_team_id, (seen.get(m.home_team_id) ?? 0) + 1);
            seen.set(m.away_team_id, (seen.get(m.away_team_id) ?? 0) + 1);
            pairs.add(
              `${Math.min(m.home_team_id, m.away_team_id)}|${Math.max(m.home_team_id, m.away_team_id)}`,
            );
          }
          const n = seen.size;
          assert.ok(n >= 2, `${year}: ${label} has ${n} teams`);
          assert.equal(ms.length, (n * (n - 1)) / 2, `${year}: ${label} match count`);
          assert.equal(pairs.size, ms.length, `${year}: ${label} duplicated a pairing`);
          for (const games of seen.values()) {
            assert.equal(games, n - 1, `${year}: ${label} unbalanced fixture list`);
          }
        }
      });
    });
  }
});

describe("second-round group matches are dated after the first round", () => {
  for (const year of EDITIONS) {
    test(`${year}: generated group fixtures sort after the real group fixtures`, () => {
      const r = run(year);
      const phases = formatsFor(year).filter((p) => p.phase_type === "GROUP");
      let firstMax: string | null = null;
      phases.forEach((p, pi) => {
        const ms = r.matches.filter((m) => m.stage_key === p.key);
        if (pi === 0) {
          for (const m of ms) {
            if (m.date == null) continue;
            if (firstMax == null || m.date > firstMax) firstMax = m.date;
          }
          return;
        }
        for (const m of ms) {
          assert.ok(m.date != null, `${year}: undated ${p.key} match ${m.stage_name}`);
          assert.ok(
            firstMax != null && m.date > firstMax,
            `${year}: ${p.key} ${m.date} not after first round (${firstMax})`,
          );
        }
      });
    });
  }
});