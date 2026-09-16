import { useEffect, useMemo, useRef } from "react";
import { useI18n, flagFor } from "../i18n";
import PlayerCard from "../components/PlayerCard";
import type { RunMatch, RunPayload } from "../types";

interface Props {
  run: RunPayload | null;
  revealed: number;
  runError: string | null;
  revealedMatches: RunMatch[];
  maxShownDay: number;
  onNext: () => void;
  onAll: () => void;
  onJump: () => void;
  onFF?: () => void;
  ffRunning?: boolean;
  scrollToId?: number | null;
  onOpen: (m: RunMatch) => void;
  onStart: () => void;
  onFinish: () => void;
}

interface Row {
  id: number;
  name: string;
  p: number;
  w: number;
  d: number;
  l: number;
  gf: number;
  ga: number;
  gd: number;
  pts: number;
}

export default function Overview({
  run,
  revealed,
  runError,
  revealedMatches,
  maxShownDay,
  onNext,
  onAll,
  onJump,
  onFF,
  ffRunning,
  scrollToId,
  onOpen,
  onStart,
  onFinish,
}: Props) {
  const focusId = run?.focus_team_id ?? null;
  const total = run?.matches.length ?? 0;
  const { t, stage, country } = useI18n();
  const focusRef = useRef<HTMLButtonElement | null>(null);

  // Scroll the target score-row into view whenever scrollToId changes.
  useEffect(() => {
    if (scrollToId == null) return;
    const el = document.querySelector<HTMLButtonElement>(
      `.score-row[data-id="${scrollToId}"]`,
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollToId]);

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    const letterOf = new Map<number, string>();
    for (const g of run?.groups ?? []) {
      for (const t of g.teams) letterOf.set(t.id, g.name);
    }
    for (const g of run?.groups ?? []) {
      map.set(
        g.name,
        g.teams.map((t) => ({
          id: t.id,
          name: t.name,
          p: 0,
          w: 0,
          d: 0,
          l: 0,
          gf: 0,
          ga: 0,
          gd: 0,
          pts: 0,
        })),
      );
    }
    for (const m of revealedMatches) {
      if (m.stage_key !== "GROUP") continue;
      const homeA = letterOf.get(m.home_team_id);
      const awayA = letterOf.get(m.away_team_id);
      const letter = homeA && awayA === homeA ? homeA : m.stage_name.endsWith(homeA ?? "") ? homeA : awayA;
      const rows = letter ? map.get(letter) : undefined;
      if (!rows) continue;
      const h = rows.find((r) => r.id === m.home_team_id);
      const a = rows.find((r) => r.id === m.away_team_id);
      if (!h || !a) continue;
      h.p += 1; a.p += 1;
      h.gf += m.home_score; h.ga += m.away_score;
      a.gf += m.away_score; a.ga += m.home_score;
      if (m.home_score > m.away_score) { h.w += 1; a.l += 1; h.pts += 3; }
      else if (m.home_score < m.away_score) { a.w += 1; h.l += 1; a.pts += 3; }
      else { h.d += 1; a.d += 1; h.pts += 1; a.pts += 1; }
    }
    for (const rows of map.values()) {
      for (const r of rows) r.gd = r.gf - r.ga;
      rows.sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.name.localeCompare(y.name));
    }
    return map;
  }, [run, revealedMatches]);

  const table = useMemo(() => {
    interface Entry {
      id: number;
      name: string;
      team_id: number;
      team_name: string;
      photo?: string | null;
      goals: number;
      assists: number;
    }
    const by = new Map<number, Entry>();
    const entry = (id: number, name: string, team_id: number, team_name: string, photo?: string | null) => {
      let e = by.get(id);
      if (!e) {
        e = { id, name, team_id, team_name, photo, goals: 0, assists: 0 };
        by.set(id, e);
      }
      return e;
    };
    for (const m of revealedMatches) {
      for (const g of m.goals) {
        const teamName = m.home_team_id === g.team_id ? m.home_team_name : m.away_team_name;
        entry(g.scorer_id, g.scorer, g.team_id, teamName, g.scorer_photo).goals += 1;
        if (g.assist_id != null && g.assist) {
          entry(g.assist_id, g.assist, g.team_id, teamName, g.assist_photo).assists += 1;
        }
      }
    }
    const all = [...by.values()];
    const scorers = all
      .filter((e) => e.goals > 0)
      .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name))
      .slice(0, 12);
    const assisters = all
      .filter((e) => e.assists > 0)
      .sort((a, b) => b.assists - a.assists || b.goals - a.goals || a.name.localeCompare(b.name))
      .slice(0, 12);
    return { scorers, assisters };
  }, [revealedMatches]);

  const byDay = useMemo(() => {
    const m = new Map<number, RunMatch[]>();
    for (const r of revealedMatches) {
      const arr = m.get(r.day) ?? [];
      arr.push(r);
      m.set(r.day, arr);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [revealedMatches]);

  const allRevealed = total > 0 && revealed >= total;
  const champion = run?.champion ?? null;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            {run
              ? t("cup.title", { year: run.year, host: run.host ?? "" })
              : t("step.tournament")}
          </h1>
          <p className="hint">
            {focusId ? t("cup.managing") : t("cup.neutral")}{" "}
            {run ? t("cup.revealed", { day: maxShownDay || 0, revealed, total }) : ""}
          </p>
        </div>
      </div>

      {runError && (
        <div className="empty bar">
          <p className="error">{t("cup.startError", { msg: runError })}</p>
          <button className="btn primary big" onClick={onStart}>{t("cup.retry")}</button>
        </div>
      )}
      {!run && !runError && (
        <div className="bar">
          <p className="hint">{t("cup.startHint")}</p>
          <button className="btn primary big" onClick={onStart}>{t("cup.start")}</button>
        </div>
      )}

      {run && (
        <>
          <div className="cmd-bar bar">
            {!allRevealed && (
              <>
                <button className="btn primary big" onClick={onNext}>
                  {revealed === 0
                    ? t("cup.playDay1")
                    : t("cup.playDay", { day: maxShownDay + 1 })}
                </button>
                {focusId != null && (
                  <>
                    <button className="btn big" onClick={onJump}>{t("cup.jump")}</button>
                    <button className="btn big" onClick={onFF} disabled={ffRunning}>
                      {ffRunning ? "⏳…" : t("cup.ff")}
                    </button>
                  </>
                )}
                <button className="btn secondary big" onClick={onAll}>{t("cup.playAll")}</button>
              </>
            )}
            {allRevealed && champion && (
              <div className="champ-line">🏆 {t("cup.champion", { team: champion })}</div>
            )}
            <button className="btn secondary big corners" onClick={onFinish}>
              {allRevealed ? t("cup.ceremonies") : t("cup.skipCeremonies")}
            </button>
          </div>

          <div className="split">
            <div className="group-tables">
              {[...groups.entries()].map(([letter, rows]) => (
                <div key={letter} className="table-card">
                  <h2 className="table-title">{stage(letter)}</h2>
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th></th><th className="l">{t("cup.team")}</th>
                        <th>{t("cup.p")}</th><th>{t("cup.w")}</th><th>{t("cup.d")}</th><th>{t("cup.l")}</th>
                        <th>{t("cup.gf")}</th><th>{t("cup.ga")}</th><th>{t("cup.gd")}</th><th>{t("cup.pts")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.id} className={focusId === r.id ? "focus-row" : ""}>
                          <td className="num">{i + 1}</td>
                          <td className="l team-cell">{flagFor(r.name)} {country(r.name)}</td>
                          <td className="num">{r.p}</td>
                          <td className="num">{r.w}</td>
                          <td className="num">{r.d}</td>
                          <td className="num">{r.l}</td>
                          <td className="num">{r.gf}</td>
                          <td className="num">{r.ga}</td>
                          <td className="num">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                          <td className="num strong">{r.pts}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            <div className="side-col">
              {table.scorers.length > 0 && (
                <div className="table-card">
                  <h2 className="table-title">{t("cup.scorers")}</h2>
                  <div className="stat-list">
                    {table.scorers.map((s, i) => (
                      <PlayerCard
                        key={s.id}
                        player={{ id: s.id, name: s.name, photo_url: s.photo }}
                        variant="stat"
                        tone={s.id % 4}
                        number={i + 1}
                        sub={country(s.team_name)}
                        right={`${s.goals}`}
                      />
                    ))}
                  </div>
                </div>
              )}
              {table.assisters.length > 0 && (
                <div className="table-card">
                  <h2 className="table-title">{t("cup.assisters")}</h2>
                  <div className="stat-list">
                    {table.assisters.map((s, i) => (
                      <PlayerCard
                        key={s.id}
                        player={{ id: s.id, name: s.name, photo_url: s.photo }}
                        variant="stat"
                        tone={s.id % 4}
                        number={i + 1}
                        sub={country(s.team_name)}
                        right={`${s.assists}`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <h2 className="sec-title">{t("cup.recent")}
            {allRevealed && <span className="dim"> {t("cup.complete")}</span>}
          </h2>
          {byDay.length === 0 && <p className="hint">{t("cup.noMatches")}</p>}
          {byDay.map(([day, ms]) => (
            <div key={day} className="day-block">
              <h3 className="day-title">{t("match.day", { day })}</h3>
              {ms.map((m) => (
                <button
                  key={m.id}
                  data-id={m.id}
                  ref={m.id === scrollToId ? focusRef : undefined}
                  className={"score-row" + (m.id === scrollToId ? " ff-target" : "")}
                  onClick={() => onOpen(m)}
                >
                  <span className="score-stage">{stage(m.stage_name)}</span>
                  <span className="score-teams">
                    <span className={m.home_team_id === focusId ? "focus-tag" : ""}>{flagFor(m.home_team_name)} {country(m.home_team_name)}</span>
                    <span className="score">{m.home_score}–{m.away_score}</span>
                    <span className={m.away_team_id === focusId ? "focus-tag" : ""}>{flagFor(m.away_team_name)} {country(m.away_team_name)}</span>
                  </span>
                  <span className="score-note">
                    {m.extra_time ? t("cup.noteAet") : m.penalties ? t("cup.notePens") : ""}
                    {(m.home_team_id === focusId || m.away_team_id === focusId) && m.momentum ? " ⚡" : ""}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}