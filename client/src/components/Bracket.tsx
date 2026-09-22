import { useEffect, useMemo, useRef } from "react";
import { flagFor, useI18n } from "../i18n";
import type { RunMatch } from "../types";

interface Props {
  matches: RunMatch[];
  order: number[];
  revealedIds: Set<number>;
  focusId: number | null;
  codes: Map<number, string>;
  onOpen?: (m: RunMatch) => void;
  /** Layout multiplier for a larger popup view (1 = sidebar size). */
  scale?: number;
  /** Extra class on the scroll wrapper (e.g. "bk-lg" for popup typography). */
  className?: string;
}

// Knockout stage keys, in the order they are played. `THIRD` is laid out as a
// side column after the final.
const KO_ORDER = ["R32", "R16", "QF", "SF", "F", "THIRD"] as const;

const BOX_W = 150;
const BOX_H = 48;
const GAP_X = 38;
const GAP_Y = 14;
const PAD = 12;
const LABEL_H = 20;

interface Col {
  key: string;
  name: string;
  matches: RunMatch[];
  x: number;
  centers: number[];
  labelTop?: number;
}

interface Line {
  key: string;
  points: string;
  dashed: boolean;
}

export default function Bracket({
  matches,
  order,
  revealedIds,
  focusId,
  codes,
  onOpen,
  scale = 1,
  className,
}: Props) {
  const { t, stage } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastRevealedRef = useRef<number | null>(null);
  const R = scale;
  const boxW = BOX_W * R;
  const boxH = BOX_H * R;
  const gapX = GAP_X * R;
  const gapY = GAP_Y * R;
  const pad = PAD * R;
  const labelH = LABEL_H * R;

  const { cols, width, height, lines } = useMemo(() => {
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
        for (let i = 0; i < list.length; i++) centers.push(top + i * slot + boxH / 2);
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
        labelTop: cy - boxH / 2 - 16 * R,
      };
      if (finalCol) {
        const midX = x - gapX / 2;
        lines.push({
          key: "THIRD-UP",
          // The third-place match joins the bracket spine with a single
          // horizontal connector at its own height (no vertical rising leg).
          points: `${x},${cy} ${midX},${cy}`,
          dashed: true,
        });
      }
      py = Math.max(py, cy + boxH / 2);
    }

    const allCols = third ? [...cols, third] : cols;
    const width = px + boxW + pad;
    const height = py + pad;
    return { cols: allCols, width, height, lines };
  }, [matches, order, boxW, boxH, gapX, gapY, pad, labelH, R]);

  // Follow the newest revealed knockout match: scroll the bracket horizontally to
  // its column and vertically to its box inside the sidebar. Runs on every reveal
  // (not only when a new round starts) so the current match stays in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rank = new Map(order.map((id, i) => [id, i]));
    let newest: RunMatch | null = null;
    let col: Col | null = null;
    for (const c of cols) {
      for (const m of c.matches) {
        if (!revealedIds.has(m.id)) continue;
        if (!newest || (rank.get(m.id) ?? -1) > (rank.get(newest.id) ?? -1)) {
          newest = m;
          col = c;
        }
      }
    }
    if (!newest || !col || newest.id === lastRevealedRef.current) return;
    lastRevealedRef.current = newest.id;
    const colX = col.x;
    const boxId = newest.id;
    // Skip past the parent's own effect (which may jump the sidebar to the top on
    // a new round) by scrolling on the next frame.
    requestAnimationFrame(() => {
      el.scrollTo({
        left: Math.max(0, colX + boxW + pad - el.clientWidth),
        behavior: "smooth",
      });
      const parent = el.closest(".group-scroll") as HTMLElement | null;
      const box = el.querySelector<HTMLElement>(`.bk-box[data-id="${boxId}"]`);
      if (parent && box) {
        const delta =
          box.getBoundingClientRect().top - parent.getBoundingClientRect().top;
        if (delta < 8 || delta + box.offsetHeight > parent.clientHeight) {
          parent.scrollTo({ top: parent.scrollTop + delta - 44, behavior: "smooth" });
        }
      }
    });
  }, [cols, revealedIds, order]);

  const codeOf = (m: RunMatch, home: boolean) => {
    const id = home ? m.home_team_id : m.away_team_id;
    const name = home ? m.home_team_name : m.away_team_name;
    return codes.get(id) ?? name.slice(0, 3).toUpperCase();
  };

  if (cols.length === 0) return null;

  // Helper to get winner of a played match
  const winnerOf = (m: RunMatch): { id: number; name: string } | null => {
    if (!revealedIds.has(m.id)) return null;
    if (m.penalties) {
      const w = m.penalties.winner_id;
      if (w == null) return null;
      return { id: w, name: w === m.home_team_id ? m.home_team_name : m.away_team_name };
    }
    if (m.home_score === m.away_score) return null;
    const w = m.home_score > m.away_score ? m.home_team_id : m.away_team_id;
    return { id: w, name: w === m.home_team_id ? m.home_team_name : m.away_team_name };
  };

  return (
    <div className={"bracket-scroll" + (className ? ` ${className}` : "")} ref={scrollRef}>
      <div className="bk-canvas" style={{ width, height }}>
        <svg className="bk-lines" width={width} height={height}>
          {lines.map((l) => (
            <polyline
              key={l.key}
              points={l.points}
              fill="none"
              stroke="rgba(27,37,48,0.3)"
              strokeWidth="1.5"
              strokeDasharray={l.dashed ? "4 4" : undefined}
            />
          ))}
        </svg>
        {cols.map((c) => (
          <div key={c.key}>
            <span className="bk-col-label" style={{ left: c.x, top: c.labelTop ?? 0 }}>
              {stage(c.name)}
            </span>
            {c.matches.map((m, i) => {
              const played = revealedIds.has(m.id);
              const y = c.centers[i] - boxH / 2;
              const win = played
                ? m.penalties
                  ? m.penalties.winner_id
                  : m.home_score === m.away_score
                    ? null
                    : m.home_score > m.away_score
                      ? m.home_team_id
                      : m.away_team_id
                : null;
              return (
                <div
                  key={m.id}
                  data-id={m.id}
                  className={
                    "bk-box" +
                    (played ? " played" : "") +
                    (focusId != null &&
                    (m.home_team_id === focusId || m.away_team_id === focusId)
                      ? " focus"
                      : "")
                  }
                  style={{ left: c.x, top: y, width: boxW, height: boxH }}
                  onClick={played && onOpen ? () => onOpen(m) : undefined}
                  role={played && onOpen ? "button" : undefined}
                >
                  {played ? (
                    <>
                      <div className={"bk-line" + (win === m.home_team_id ? " win" : "")}>
                        <span className="bk-flag">{flagFor(m.home_team_name)}</span>
                        <span className="bk-code">{codeOf(m, true)}</span>
                        <span className="bk-sc">{m.home_score}</span>
                      </div>
                      <div className={"bk-line" + (win === m.away_team_id ? " win" : "")}>
                        <span className="bk-flag">{flagFor(m.away_team_name)}</span>
                        <span className="bk-code">{codeOf(m, false)}</span>
                        <span className="bk-sc">{m.away_score}</span>
                      </div>
                      {m.penalties && (
                        <div className="bk-pens">
                          {m.penalties.home_score}–{m.penalties.away_score} pens
                        </div>
                      )}
                    </>
                  ) : (
                      (() => {
                        const colIdx = cols.findIndex((col) => col.key === c.key);
                        if (colIdx <= 0) return <div className="bk-tbd">{t("match.tbd")}</div>;
                        const prevCol = cols[colIdx - 1];
                        const fa = prevCol.matches[2 * i];
                        const fb = prevCol.matches[2 * i + 1];
                        const qHome = fa ? winnerOf(fa) : null;
                        const qAway = fb ? winnerOf(fb) : null;
                        if (!qHome && !qAway) return <div className="bk-tbd">{t("match.tbd")}</div>;
                        const codeFromName = (name: string) => name.slice(0, 3).toUpperCase();
                        return (
                          <div className="bk-qual">
                            <div className="bk-line">
                              {qHome ? (
                                <>
                                  <span className="bk-flag">{flagFor(qHome.name)}</span>
                                  <span className="bk-code">{codeFromName(qHome.name)}</span>
                                </>
                              ) : (
                                <span className="bk-tbd-min">{t("match.tbd")}</span>
                              )}
                            </div>
                            <div className="bk-line">
                              {qAway ? (
                                <>
                                  <span className="bk-flag">{flagFor(qAway.name)}</span>
                                  <span className="bk-code">{codeFromName(qAway.name)}</span>
                                </>
                              ) : (
                                <span className="bk-tbd-min">{t("match.tbd")}</span>
                              )}
                            </div>
                          </div>
                        );
                      })()
                    )}
                 </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
