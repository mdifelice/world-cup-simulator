// bracketLayout.ts — pure, data-driven bracket geometry.
//
// The bracket SVG is produced entirely from *match structure* (stage keys plus
// their play order) — team names, scores and reveal state never move a box.
// That makes the geometry a pure function of `(matches, order, scale)`, which
// the tests can exercise offline with golden numbers per edition.
//
// All layout decisions that used to live inside React's useMemo now live here
// as plain data: columns, box centers, connector polylines, and the THIRD-place
// dashed spine. The component only renders what this module returns.

import type { RunMatch } from "../types";

// Knockout stage keys, in the order they are played. `THIRD` is laid out as a
// side column below the final.
export const KO_ORDER = ["R32", "R16", "QF", "SF", "F", "THIRD"] as const;

export const BOX_W = 124;
export const BOX_H = 48;
export const GAP_X = 38;
export const GAP_Y = 14;
export const PAD = 12;
export const LABEL_H = 20;
/** Gap between a column's boxes and its "THIRD"/side label baseline. */
const THIRD_LABEL_GAP = 16;

export interface Col {
  key: string;
  name: string;
  matches: RunMatch[];
  x: number;
  centers: number[];
  labelTop?: number;
}

export interface Line {
  key: string;
  points: string;
  dashed: boolean;
}

export interface BracketLayout {
  cols: Col[];
  width: number;
  height: number;
  lines: Line[];
}

/** Scaled geometry for a layout multiplier (1 = sidebar size). */
export interface BracketGeom {
  boxW: number;
  boxH: number;
  gapX: number;
  gapY: number;
  pad: number;
  labelH: number;
  thirdLabelGap: number;
}

export function geomFor(scale: number): BracketGeom {
  return {
    boxW: BOX_W * scale,
    boxH: BOX_H * scale,
    gapX: GAP_X * scale,
    gapY: GAP_Y * scale,
    pad: PAD * scale,
    labelH: LABEL_H * scale,
    thirdLabelGap: THIRD_LABEL_GAP * scale,
  };
}

/** True once every group match has been revealed — the gate that lets the
 *  first knockout column stop showing "TBD". Pure so tests can drive the
 *  exact reveal scheme the app uses. */
export function groupStageDone(matches: RunMatch[], revealedIds: Set<number>): boolean {
  const groups = matches.filter(
    (m) => m.stage_key === "GROUP" || m.stage_key === "GROUP2",
  );
  return groups.length > 0 && groups.every((m) => revealedIds.has(m.id));
}

/**
 * Compute the full bracket layout from match structure alone.
 *
 * Guarantees (all asserted by client/tests/layout.test.ts):
 * - column order follows `KO_ORDER` minus absent stages; `THIRD` is a side
 *   column in the final's column, drawn below it;
 * - first knockout column boxes stack evenly by play order;
 * - each later box is centred on the midpoint of its two feeders;
 * - connector polylines run box-right → column-mid → child-top;
 * - the THIRD dashed spine is drawn only when the edition has a semi-final
 *   (1974/78 second-round formats have none, so no spine).
 */
export function layoutBracket(
  matches: RunMatch[],
  order: number[],
  geom: BracketGeom = geomFor(1),
): BracketLayout {
  const { boxW, boxH, gapX, gapY, pad, labelH, thirdLabelGap } = geom;

  const rank = new Map(order.map((id, i) => [id, i]));
  const byStage = new Map<string, RunMatch[]>();
  for (const k of KO_ORDER) byStage.set(k, []);
  for (const m of matches) {
    const list = byStage.get(m.stage_key);
    if (list) list.push(m);
  }
  for (const list of byStage.values()) {
    list.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }
  const keys = KO_ORDER.filter((k) => (byStage.get(k)?.length ?? 0) > 0);
  const mainKeys = keys.filter((k) => k !== "THIRD");

  const slot = boxH + gapY;
  const top = labelH + pad;
  const cols: Col[] = [];
  let py = top;
  let px = pad;
  for (let r = 0; r < mainKeys.length; r++) {
    const key = mainKeys[r];
    const list = byStage.get(key) ?? [];
    const centers: number[] = [];
    if (r === 0) {
      for (let i = 0; i < list.length; i++)
        centers.push(top + i * slot + boxH / 2);
    } else {
      const prev = cols[r - 1].centers;
      for (let j = 0; j < list.length; j++) {
        const a = prev[2 * j];
        const b = prev[2 * j + 1];
        centers.push(b == null ? a ?? top : (a + b) / 2);
      }
    }
    const first = list[0];
    cols.push({
      key,
      name: first?.stage_name ?? key,
      matches: list,
      x: px,
      centers,
    });
    px += boxW + gapX;
    py = Math.max(py, ...centers.map((c) => c + boxH / 2));
  }

  const lines: Line[] = [];
  for (let r = 1; r < cols.length; r++) {
    const cur = cols[r];
    const prev = cols[r - 1];
    for (let j = 0; j < cur.matches.length; j++) {
      const childY = cur.centers[j];
      const midX = cur.x - gapX / 2;
      for (const fi of [2 * j, 2 * j + 1]) {
        const fy = prev.centers[fi];
        if (fy == null) continue;
        const fx = prev.x + boxW;
        lines.push({
          key: `${prev.key}-${fi}-${cur.key}-${j}`,
          points: `${fx},${fy} ${midX},${fy} ${midX},${childY} ${cur.x},${childY}`,
          dashed: false,
        });
      }
    }
  }

  // Third-place match: drawn directly below the final, in the final's column,
  // and fed by the two semi-final losers.
  let third: Col | null = null;
  const thirdMatches = byStage.get("THIRD") ?? [];
  const finalCol = cols.find((c) => c.key === "F");
  if (thirdMatches.length > 0) {
    const x = finalCol?.x ?? px;
    const fy = finalCol?.centers[0];
    const cy = (fy ?? top) + boxH + gapY * 3;
    third = {
      key: "THIRD",
      name: thirdMatches[0]?.stage_name ?? "THIRD",
      matches: thirdMatches,
      x,
      centers: [cy],
      labelTop: cy - boxH / 2 - thirdLabelGap,
    };
    // The dashed connector joins the spine wherever the horizontal run at cy
    // first meets the solid incoming vertical, and only when a semi-final
    // (and therefore a spine to attach to) actually exists.
    if (finalCol && cols.some((c) => c.key === "SF")) {
      const midX = x - gapX / 2;
      const childY = finalCol.centers[0] ?? top;
      const sfCol = cols.find((c) => c.key === "SF");
      const solidTop = Math.min(
        sfCol?.centers[0] ?? childY,
        sfCol?.centers[1] ?? childY,
        childY,
      );
      const solidEnd = Math.max(
        sfCol?.centers[0] ?? childY,
        sfCol?.centers[1] ?? childY,
        childY,
      );
      const touchY = cy < solidTop ? solidTop : cy > solidEnd ? solidEnd : cy;
      const vertical = touchY === cy ? "" : ` ${midX},${touchY}`;
      lines.push({
        key: "THIRD-UP",
        points: `${x},${cy} ${midX},${cy}${vertical}`,
        dashed: true,
      });
    }
    py = Math.max(py, cy + boxH / 2);
  }

  const allCols = third ? [...cols, third] : cols;
  const width = px + boxW + pad;
  const height = py + pad;
  return { cols: allCols, width, height, lines };
}