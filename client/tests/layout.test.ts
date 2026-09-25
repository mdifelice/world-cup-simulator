// layout.test.ts — bracket geometry is pure data with golden numbers.
//
// The bracket is a pure function of (matches, order, scale): box positions,
// centers and the connector polylines are computed by layoutBracket() with no
// team/reveal state involved. These tests lock the geometry for the three
// structural extremes — 1930 (short, 4-group → SF spine), 1978 (no SF, no
// dashed THIRD spine, second-round group) and 2026 (tall 48-team R32 spine) —
// plus a standard 32-team edition, straight from committed oracle fixtures.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { layoutBracket, geomFor, groupStageDone } from "../src/sim/bracketLayout.ts";
import type { BracketLayout, Col } from "../src/sim/bracketLayout.ts";
import { formatsFor } from "../src/sim/formats.ts";
import { run } from "./helpers.ts";

const col = (l: BracketLayout, key: string): Col => {
  const c = l.cols.find((x) => x.key === key);
  if (!c) throw new Error(`no column ${key} in ${l.cols.map((x) => x.key).join(",")}`);
  return c;
};

const line = (l: BracketLayout, key: string) =>
  l.lines.find((x) => x.key === key) ?? null;

/** Round a coordinates string to integers for stable goldens. */
const ints = (s: string) =>
  s
    .split(" ")
    .map((pt) => pt.split(",").map((n) => Math.round(Number(n))).join(","))
    .join(" ");

describe("bracket geometry golden numbers", () => {
  test("1930 — short spine: SF → F, THIRD below F with a rising dashed leg", () => {
    const r = run(1930);
    const l = layoutBracket(r.matches, r.order);

    // Columns: SF, F, THIRD (side). No R16/R32/QF in this format.
    assert.deepEqual(l.cols.map((c) => c.key), ["SF", "F", "THIRD"]);

    const geom = geomFor(1);
    const top = geom.labelH + geom.pad; // 32
    const slot = geom.boxH + geom.gapY; // 62
    const boxH = geom.boxH;

    // SF boxes centered on the first two slots, F centered mid-SF.
    assert.deepEqual(col(l, "SF").centers, [top + boxH / 2, top + slot + boxH / 2]);
    const sfMid = (top + boxH / 2 + top + slot + boxH / 2) / 2;
    assert.deepEqual(col(l, "F").centers, [sfMid]);

    // THIRD sits in the final's column, directly below it.
    const third = col(l, "THIRD");
    const fCenter = col(l, "F").centers[0];
    assert.equal(third.x, col(l, "F").x);
    assert.deepEqual(
      third.centers,
      [fCenter + geom.boxH + geom.gapY * 3],
    );

    // Solid feeds from SF into F.
    const feeds = l.lines.filter((x) => x.dashed === false && x.key.startsWith("SF-"));
    assert.equal(feeds.length, 2); // two SF losers flow into the F box

    // Dashed THIRD-UP spine exists (1930 has an SF) and rises a short leg to
    // the bottom of the SF feeds when cy falls below them.
    const dash = line(l, "THIRD-UP");
    assert.ok(dash, "1930 must draw the THIRD-UP dashed spine");
    assert.equal(dash.dashed, true);
    const parts = dash.points.split(" ");
    assert.equal(parts.length, 3); // two on the y=cy run + one vertical leg
    // Horizontal run at `cy` lies below both SF centers (short bracket).
    const cy = third.centers[0];
    assert.ok(cy > Math.max(...col(l, "SF").centers));
    // The leg rises to the SF bottom (SF[1] = the lower feed center).
    const [, , legPoint] = parts;
    const legY = Number(legPoint.split(",")[1]);
    assert.equal(legY, Math.round(col(l, "SF").centers[1]));
  });

  test("1978 — second-round group: no SF, so no dashed THIRD spine", () => {
    const r = run(1978);
    const l = layoutBracket(r.matches, r.order);

    // No R16/QF/SF columns. The bracket is F-only (+ THIRD side column).
    assert.deepEqual(l.cols.map((c) => c.key), ["F", "THIRD"]);
    assert.equal(line(l, "THIRD-UP"), null, "1978 has no SF to attach the THIRD spine to");

    // Even so the F box is present and the THIRD column is drawn in its column.
    assert.equal(col(l, "F").matches.length, 1);
    assert.equal(col(l, "THIRD").matches.length, 1);
    assert.equal(col(l, "THIRD").x, col(l, "F").x);
  });

  test("2026 — tall 48-team spine: R32 → R16 → QF → SF → F, THIRD below final", () => {
    const r = run(2026);
    const l = layoutBracket(r.matches, r.order);

    assert.deepEqual(l.cols.map((c) => c.key), ["R32", "R16", "QF", "SF", "F", "THIRD"]);
    assert.equal(col(l, "R32").matches.length, 16);
    assert.equal(col(l, "R16").matches.length, 8);
    assert.equal(col(l, "QF").matches.length, 4);
    assert.equal(col(l, "SF").matches.length, 2);
    assert.equal(col(l, "F").matches.length, 1);
    assert.equal(col(l, "THIRD").matches.length, 1);

    // Next-round centers are midpoints of their two feeders' centers.
    const fourth = (a: number, b: number) => (a + b) / 2;
    for (let i = 0; i < 8; i++) {
      assert.equal(
        col(l, "R16").centers[i],
        fourth(col(l, "R32").centers[2 * i], col(l, "R32").centers[2 * i + 1]),
        `R16 center ${i}`,
      );
    }

    // THIRD dashed spine present and its horizontal run sits *inside* the SF
    // feeds' span in this tall bracket → pure 2-point line, no vertical leg.
    const dash = line(l, "THIRD-UP");
    assert.ok(dash, "2026 must draw the THIRD-UP dashed spine");
    const third = col(l, "THIRD");
    const cy = third.centers[0];
    const sf = col(l, "SF");
    assert.ok(cy >= Math.min(...sf.centers) && cy <= Math.max(...sf.centers));
    assert.equal(dash.points.split(" ").length, 2); // no vertical leg needed
    void fourth;
  });

  test("2022 — standard 32-team spine", () => {
    const r = run(2022);
    const l = layoutBracket(r.matches, r.order);

    assert.deepEqual(l.cols.map((c) => c.key), ["R16", "QF", "SF", "F", "THIRD"]);
    assert.equal(col(l, "R16").matches.length, 8);
    assert.equal(col(l, "THIRD").x, col(l, "F").x);
    assert.ok(line(l, "THIRD-UP"), "2022 draws the dashed THIRD spine");

    // Polylines for a standard spine: R16→QF 8 feeds, QF→SF 4, SF→F 2,
    // plus F→THIRD dashed.
    const feeds = l.lines.filter((x) => x.dashed === false).length;
    assert.equal(feeds, 14);
  });
});

describe("bracket geometry invariants across every edition", () => {
  for (const year of [1930, 1934, 1950, 1954, 1974, 1978, 1982, 1998, 2014, 2022, 2026]) {
    test(`${year} — columns mirror declared knockout config`, () => {
      const r = run(year);
      const l = layoutBracket(r.matches, r.order);
      const declaredKnockouts = formatsFor(year)
        .filter((p) => p.phase_type === "KNOCKOUT")
        .map((p) => p.key);
      // The layout columns are exactly the declared knockouts + THIRD side col.
      const colKeys = l.cols.map((c) => c.key);
      assert.deepEqual(
        colKeys.slice(0, colKeys.length - (colKeys.includes("THIRD") ? 1 : 0)),
        declaredKnockouts.filter((k) => k !== "THIRD"),
        `${year}: column keys must match the declared knockout config`,
      );
      void declaredKnockouts;
    });
  }
});

describe("groupStageDone gate", () => {
  test("true only once the full group stage (incl. a second group) is revealed", () => {
    for (const year of [1930, 1978, 1998, 2026]) {
      const r = run(year);
      const revealed = new Set<number>();
      const groupIds = r.matches.filter((m) => m.stage_key === "GROUP" || m.stage_key === "GROUP2").map((m) => m.id);
      assert.equal(groupStageDone(r.matches, revealed), false, `${year} before any reveal`);
      for (const id of groupIds.slice(0, -1)) {
        revealed.add(id);
        assert.equal(groupStageDone(r.matches, revealed), false, `${year} still one group match pending`);
      }
      revealed.add(groupIds[groupIds.length - 1]);
      assert.equal(groupStageDone(r.matches, revealed), true, `${year} last group match reveals the bracket`);
    }
  });
});