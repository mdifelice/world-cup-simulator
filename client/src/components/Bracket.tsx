import { useEffect, useMemo, useRef } from "react";
import { flagFor, useI18n } from "../i18n";
import type { RunMatch } from "../types";
import {
  geomFor,
  groupStageDone as groupStageDonePure,
  layoutBracket,
  type BracketLayout,
  type Col,
} from "../sim/bracketLayout";

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
  /** Show full (localised) country names instead of abbreviated codes. */
  fullName?: boolean;
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
  fullName = false,
}: Props) {
  const { t, stage, country } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastRevealedRef = useRef<number | null>(null);
  const R = scale;
  const geom = geomFor(R);

  // Knockout pairings are decided by the group phases that feed them, so the
  // first bracket column can be filled in as soon as those groups are done —
  // not only once each specific match is revealed.
  const groupStageDone = useMemo(
    () => groupStageDonePure(matches, revealedIds),
    [matches, revealedIds],
  );

  const { cols, width, height, lines }: BracketLayout = useMemo(
    () => layoutBracket(matches, order, geom),
    [matches, order, geom],
  );

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
        left: Math.max(0, colX + geom.boxW + geom.pad - el.clientWidth),
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

  const nameOf = (name: string) => (fullName ? country(name) : name.slice(0, 3).toUpperCase());
  const codeOf = (m: RunMatch, home: boolean) => {
    const id = home ? m.home_team_id : m.away_team_id;
    const name = home ? m.home_team_name : m.away_team_name;
    // With full names requested (Round of 16 / Round of 8) the name wins, so the
    // stage shows countries instead of three-letter codes.
    return fullName ? nameOf(name) : codes.get(id) ?? nameOf(name);
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
              const y = c.centers[i] - geom.boxH / 2;
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
                  style={{ left: c.x, top: y, width: geom.boxW, height: geom.boxH }}
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
                        // First knockout round: teams are known from group stage
                        // qualifiers as soon as the groups are done, so fill the
                        // bracket with the games then; keep them hidden only
                        // while a group phase is still in progress.
                        if (colIdx === 0) {
                          const hasHome = m.home_team_name && m.home_team_id;
                          const hasAway = m.away_team_name && m.away_team_id;
                          if (!groupStageDone || (!hasHome && !hasAway)) {
                            return <div className="bk-tbd">{t("match.tbd")}</div>;
                          }
                          return (
                            <div className="bk-qual">
                              <div className="bk-line">
                                {hasHome ? (
                                  <>
                                    <span className="bk-flag">{flagFor(m.home_team_name)}</span>
                                    <span className="bk-code">{codeOf(m, true)}</span>
                                  </>
                                ) : (
                                  <span className="bk-tbd-min">{t("match.tbd")}</span>
                                )}
                              </div>
                              <div className="bk-line">
                                {hasAway ? (
                                  <>
                                    <span className="bk-flag">{flagFor(m.away_team_name)}</span>
                                    <span className="bk-code">{codeOf(m, false)}</span>
                                  </>
                                ) : (
                                  <span className="bk-tbd-min">{t("match.tbd")}</span>
                                )}
                              </div>
                            </div>
                          );
                        }
                        // Subsequent rounds: feed from previous round winners
                        const prevCol = cols[colIdx - 1];
                        const fa = prevCol.matches[2 * i];
                        const fb = prevCol.matches[2 * i + 1];
                        const qHome = fa ? winnerOf(fa) : null;
                        const qAway = fb ? winnerOf(fb) : null;
                        if (!qHome && !qAway) return <div className="bk-tbd">{t("match.tbd")}</div>;
                        const labelWinner = (w: { id: number; name: string }) => w.name;
                        return (
                          <div className="bk-qual">
                            <div className="bk-line">
                              {qHome ? (
                                <>
                                  <span className="bk-flag">{flagFor(qHome.name)}</span>
                                  <span className="bk-code">{nameOf(labelWinner(qHome))}</span>
                                </>
                              ) : (
                                <span className="bk-tbd-min">{t("match.tbd")}</span>
                              )}
                            </div>
                            <div className="bk-line">
                              {qAway ? (
                                <>
                                  <span className="bk-flag">{flagFor(qAway.name)}</span>
                                  <span className="bk-code">{nameOf(labelWinner(qAway))}</span>
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
