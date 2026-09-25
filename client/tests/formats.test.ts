// formats.test.ts — edition config is declarative data, not `if` statements.
// For every seeded edition, the oracle the server serves must match the
// declarative FORMATS table (same phase keys, phase types and entrant counts),
// and a full run must visit exactly those knockout keys in that order. This
// pins the "one source of truth" both sides of the fork (server db.rs
// formats_for ↔ client src/sim/formats.ts) agree on.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatsFor } from "../src/sim/formats.ts";
import type { OraclePhase } from "../src/sim/run.ts";
import { EDITIONS, oracleFor, run } from "./helpers.ts";

/** Phases in the engine's play order, walking seq from the oracle. */
function phasesInOrder(oracle: { phases: OraclePhase[] }): OraclePhase[] {
  return oracle.phases.slice().sort((a, b) => a.seq - b.seq);
}

describe("declarative edition config", () => {
  for (const year of EDITIONS) {
    test(`oracle phases for ${year} match formatsFor(year)`, () => {
      const oracle = oracleFor(year);
      const expected = formatsFor(year);
      const actual = phasesInOrder(oracle);

      assert.equal(
        actual.length,
        expected.length,
        `phase count ${actual.length} != ${expected.length}`,
      );
      for (let i = 0; i < expected.length; i++) {
        assert.equal(actual[i].key, expected[i].key, `phase ${i} key`);
        assert.equal(actual[i].phase_type, expected[i].phase_type, `phase ${i} type`);
        assert.equal(
          actual[i].group_count ?? null,
          expected[i].group_count,
          `phase ${i} (${expected[i].key}) group_count`,
        );
        assert.equal(
          actual[i].entry_teams ?? null,
          expected[i].entry_teams,
          `phase ${i} (${expected[i].key}) entry_teams`,
        );
      }
    });

    test(`${year}: run visits every declared phase with the right knockout width`, () => {
      const expected = formatsFor(year);
      const run = awaitRun(year);

      // Every declared knockout round appears with entry_teams/2 matches
      // (each tie pairs two entrants).
      for (const phase of expected) {
        if (phase.phase_type !== "KNOCKOUT") continue;
        const m = run.matches.filter((x) => x.stage_key === phase.key);
        const entry = phase.entry_teams ?? 0;
        assert.equal(
          m.length,
          entry / 2,
          `${year} ${phase.key}: expected ${entry / 2} matches, got ${m.length}`,
        );
      }

      // Group phases never feed a knockout-less structure: a round-robin the
      // engine actually had to play produces matches too.
      for (const phase of expected) {
        if (phase.phase_type !== "GROUP") continue;
        const m = run.matches.filter((x) => x.stage_key === phase.key);
        assert.ok(m.length > 0, `${year} ${phase.key} played no matches`);
      }

      // The knockout sequence in reveal order strictly follows the declared
      // config order: R16 → R16 → … QF → … SF → … THIRD → F.
      const KO_RANK = ["R32", "R16", "QF", "SF", "F", "THIRD"];
      const koKeys = expected.filter((p) => p.phase_type === "KNOCKOUT").map((p) => p.key);
      // The knockout sequence in reveal order strictly follows the declared
      // config's own phase order (seq): SF → THIRD → F etc. — never out of
      // sequence, and the final must be the very last knockout reveal.
      const koSeq = new Map(expected.filter((p) => p.phase_type === "KNOCKOUT").map((p, i) => [p.key, i]));
      const seen = run.order
        .map((id) => run.matches.find((m) => m.id === id)?.stage_key ?? "?")
        .filter((k) => koSeq.has(k));
      const koMatchCount = koKeys.reduce(
        (acc, k) => acc + run.matches.filter((m) => m.stage_key === k).length,
        0,
      );
      assert.equal(seen.length, koMatchCount, `${year}: knockout reveal count`);
      for (let i = 1; i < seen.length; i++) {
        assert.ok(
          koSeq.get(seen[i])! >= koSeq.get(seen[i - 1])!,
          `${year}: knockout round ${seen[i]} revealed before ${seen[i - 1]}`,
        );
      }
      if (seen.length > 0) {
        assert.equal(seen[seen.length - 1], "F", `${year}: final is not the last knockout reveal`);
      }
    });

    test(`${year}: F (or league decider) declares a champion exactly once`, () => {
      const r = run(year);
      const finals = r.matches.filter((m) => m.stage_key === "F");
      const finished = r.order.every((id) =>
        r.matches.find((m) => m.id === id)?.stage_key === "F" ? finals.length === 1 : true,
      );
      assert.ok(r.champion, `${year}: no champion`);
      if (finals.length > 0) {
        assert.equal(finals.length, 1, `${year}: expected exactly one final`);
        const f = finals[0];
        const winnerId =
          f.penalties?.winner_id ??
          (f.home_score > f.away_score ? f.home_team_id : f.away_team_id);
        const winnerName = winnerId === f.home_team_id ? f.home_team_name : f.away_team_name;
        assert.equal(r.champion, winnerName, `${year}: champion != final winner`);
      }
      void finished;
    });
  }
});

function awaitRun(year: number) {
  return run(year);
}