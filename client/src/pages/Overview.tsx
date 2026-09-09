import { useMemo } from "react";
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
  onOpen,
  onStart,
  onFinish,
}: Props) {
  const focusId = run?.focus_team_id ?? null;
  const total = run?.matches.length ?? 0;

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

  const scorers = useMemo(() => {
    const by = new Map<number, { name: string; team_id: number; team_name: string; position?: string; goals: number; assists: number }>();
    for (const m of revealedMatches) {
      for (const g of m.goals) {
        let s = by.get(g.scorer_id);
        if (!s) {
          s = {
            name: g.scorer,
            team_id: g.team_id,
            team_name: m.home_team_id === g.team_id ? m.home_team_name : m.away_team_name,
            goals: 0,
            assists: 0,
          };
          by.set(g.scorer_id, s);
        }
        s.goals += 1;
        if (g.assist_id != null && g.assist) {
          let as = by.get(g.assist_id);
          if (!as) {
            as = {
              name: g.assist,
              team_id: g.team_id,
              team_name: s.team_name,
              goals: 0,
              assists: 1,
            };
            by.set(g.assist_id, as);
          } else as.assists += 1;
        }
      }
    }
    return [...by.values()].sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name)).slice(0, 12);
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
          <h1>{run?.year} {run?.host ? `· ${run.host}` : ""} World Cup</h1>
          <p className="hint">
            {focusId ? `You are managing the tournament live.` : "Neutral view — no team in the dugout."}
            {" "}Matchday {maxShownDay || 0} of {run ? `revealed ${revealed}/${total}` : ""}.
          </p>
        </div>
      </div>

      {runError && (
        <div className="empty bar">
          <p className="error">Could not start the tournament: {runError}</p>
          <button className="btn primary big" onClick={onStart}>Retry</button>
        </div>
      )}
      {!run && !runError && (
        <div className="bar">
          <p className="hint">The draw is ready — time to kick off.</p>
          <button className="btn primary big" onClick={onStart}>Start the tournament</button>
        </div>
      )}

      {run && (
        <>
          <div className="cmd-bar bar">
            {!allRevealed && (
              <>
                <button className="btn primary big" onClick={onNext}>
                  {revealed === 0 ? "Play matchday 1" : `Play matchday ${maxShownDay + 1}`}
                </button>
                {focusId != null && (
                  <button className="btn big" onClick={onJump}>⚡ Jump to your match</button>
                )}
                <button className="btn secondary big" onClick={onAll}>Play all</button>
              </>
            )}
            {allRevealed && champion && (
              <div className="champ-line">🏆 {champion} are champions!</div>
            )}
            <button className="btn secondary big corners" onClick={onFinish}>
              {allRevealed ? "🏆 Ceremonies →" : "Skip to ceremonies →"}
            </button>
          </div>

          <div className="split">
            <div className="group-tables">
              {[...groups.entries()].map(([letter, rows]) => (
                <div key={letter} className="table-card">
                  <h2 className="table-title">{letter}</h2>
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th></th><th className="l">Team</th><th>P</th><th>W</th><th>D</th><th>L</th>
                        <th>GF</th><th>GA</th><th>GD</th><th>Pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.id} className={focusId === r.id ? "focus-row" : ""}>
                          <td className="num">{i + 1}</td>
                          <td className="l team-cell">{r.name}</td>
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
              {scorers.length > 0 && (
                <div className="table-card">
                  <h2 className="table-title">Top scorers</h2>
                  <table className="mini-table">
                    <tbody>
                      {scorers.map((s, i) => (
                        <tr key={i}>
                          <td className="num">{i + 1}</td>
                          <td className="l">{s.name}</td>
                          <td className="l dim">{s.team_name}</td>
                          <td className="num strong">{s.goals}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <h2 className="sec-title">Recent results
            {allRevealed && <span className="dim"> · tournament complete</span>}
          </h2>
          {byDay.length === 0 && <p className="hint">No matches played yet.</p>}
          {byDay.map(([day, ms]) => (
            <div key={day} className="day-block">
              <h3 className="day-title">Matchday {day}</h3>
              {ms.map((m) => (
                <button key={m.id} className="score-row" onClick={() => onOpen(m)}>
                  <span className="score-stage">{m.stage_name}</span>
                  <span className="score-teams">
                    <span className={m.home_team_id === focusId ? "focus-tag" : ""}>{m.home_team_name}</span>
                    <span className="score">{m.home_score}–{m.away_score}</span>
                    <span className={m.away_team_id === focusId ? "focus-tag" : ""}>{m.away_team_name}</span>
                  </span>
                  <span className="score-note">
                    {m.extra_time ? "AET" : m.penalties ? "Pens" : ""}
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