import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import { STAGES, type SimMatch } from "../types";
import type { GameState } from "../App";

interface Props {
  state: GameState;
  setState: Dispatch<SetStateAction<GameState>>;
  onRestart: () => void;
}

interface Row {
  teamId: number;
  team: string;
  pts: number;
  gf: number;
  ga: number;
  gd: number;
}

const emptyRow = (m: SimMatch, home: boolean): Row => ({
  teamId: home ? m.home_team_id : m.away_team_id,
  team: home ? m.home_team_name : m.away_team_name,
  pts: 0,
  gf: 0,
  ga: 0,
  gd: 0,
});

function standings(ms: SimMatch[]): Map<number, Row> {
  const map = new Map<number, Row>();
  ms.forEach((m) => {
    const home = map.get(m.home_team_id) ?? emptyRow(m, true);
    const away = map.get(m.away_team_id) ?? emptyRow(m, false);
    if (m.status === "played" && m.home_score != null && m.away_score != null) {
      home.gf += m.home_score;
      home.ga += m.away_score;
      away.gf += m.away_score;
      away.ga += m.home_score;
      if (m.home_score > m.away_score) home.pts += 3;
      else if (m.home_score < m.away_score) away.pts += 3;
      else {
        home.pts += 1;
        away.pts += 1;
      }
    }
    map.set(home.teamId, home);
    map.set(away.teamId, away);
  });
  return map;
}

export default function Simulation({ state, setState, onRestart }: Props) {
  const [matches, setMatches] = useState<SimMatch[] | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!state.tournament) return;
    api
      .matches(state.tournament.id)
      .then((ms) => {
        setMatches(ms);
        setMessage((prev) =>
          prev ?? (ms.length ? "Fixture loaded. Hit simulate to play it out." : "No fixture yet."),
        );
      })
      .catch((e) => setError(e.message));
  }, [state.tournament]);

  useEffect(load, [load]);

  const userTeamId = state.team?.id ?? null;
  const boost = useMemo(() => {
    const filled = state.lineup.filter((p) => p);
    if (!filled.length) return 0;
    const avg =
      filled.reduce((s, p) => s + (p!.rating ?? 0), 0) / filled.length;
    return Math.max(0, Math.min(6, Math.round(avg - (state.team?.rating ?? 70))));
  }, [state.lineup, state.team]);

  const sim = async () => {
    if (!state.tournament || simulating) return;
    setSimulating(true);
    setError(null);
    try {
      const res = await api.simulate(state.tournament.id, userTeamId, boost);
      setMessage(`${res.simulated} matches simulated. Champion: ${res.champion ?? "—"}`);
      setState((st) => ({ ...st, champion: res.champion }));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSimulating(false);
    }
  };

  const byStage = useMemo(() => {
    const map = new Map<string, SimMatch[]>();
    matches?.forEach((m) => {
      const arr = map.get(m.stage) ?? [];
      arr.push(m);
      map.set(m.stage, arr);
    });
    return map;
  }, [matches]);

  const groupLetter = useCallback(
    (teamId: number): string => {
      return (
        state.participants.find((p) => p.id === teamId)?.group_letter ?? "?"
      );
    },
    [state.participants],
  );

  const groupMatches = useMemo(
    () => (matches ?? []).filter((m) => m.stage === "GROUP"),
    [matches],
  );

  const groupNames = useMemo(
    () => [...new Set(groupMatches.flatMap((m) => [groupLetter(m.home_team_id), groupLetter(m.away_team_id)]))].sort(),
    [groupMatches, groupLetter],
  );

  // Build a group table of any group letter that has >0 matches.
  const groupTables = useMemo(() => {
    return groupNames
      .map((g) => {
        const ms = groupMatches.filter(
          (m) => groupLetter(m.home_team_id) === g || groupLetter(m.away_team_id) === g,
        );
        const rows = [...standings(ms).values()].sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
        return { g, ms, rows };
      })
      .filter((t) => t.rows.length > 0);
  }, [groupMatches, groupLetter, groupNames]);

  const userMatches = useMemo(
    () =>
      (matches ?? [])
        .filter((m) => m.home_team_id === userTeamId || m.away_team_id === userTeamId)
        .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage)),
    [matches, userTeamId],
  );

  const userEliminated = useMemo(() => {
    if (!userTeamId || !matches) return false;
    const inKnockout = matches.some(
      (m) => m.stage !== "GROUP" && (m.home_team_id === userTeamId || m.away_team_id === userTeamId),
    );
    const played = userMatches.filter((m) => m.status === "played");
    if (!played.length && inKnockout) return true;
    return false;
  }, [userTeamId, matches, userMatches]);

  if (!state.tournament) return null;

  return (
    <section className="sim">
      <div className="sim-head">
        <div>
          <h1>
            {state.tournament.year} · {state.tournament.host}
          </h1>
          <p className="hint">
            Managing {state.team?.name} · {state.formation?.label} · tactical
            boost <b>+{boost}</b>
          </p>
        </div>
        <div className="sim-actions">
          <button
            className="btn primary big"
            onClick={sim}
            disabled={simulating || !matches}
          >
            {simulating
              ? "Simulating…"
              : matches?.some((m) => m.status === "played")
              ? "Re-simulate"
              : "Simulate tournament"}
          </button>
          <button className="btn ghost" onClick={onRestart}>
            Restart
          </button>
        </div>
      </div>

      {error && <p className="error">Simulation failed: {error}</p>}
      {!error && message && <p className="banner">{message}</p>}

      {state.champion && (
        <div className="trophy">🏆 {state.champion} are World Champions</div>
      )}

      <h2>Your journey</h2>
      {userMatches.length === 0 && (
        <p className="hint">No matches found for your team in this fixture.</p>
      )}
      {userMatches.length > 0 && (
        <div className="journey">
          {userMatches.map((m) => (
            <div key={m.id} className={"jcard" + (m.status === "played" ? " played" : "")}>
              <span className="stage">{stageLabel(m.stage)}</span>
              <span className="score">
                {m.status === "played"
                  ? `${m.home_team_name} ${m.home_score}–${m.away_score} ${m.away_team_name}`
                  : `${m.home_team_name} vs ${m.away_team_name}`}
              </span>
            </div>
          ))}
        </div>
      )}
      {userEliminated && <p className="hint warn">Out of the tournament.</p>}

      {groupTables.length > 0 && (
        <div className="group-tables">
          <h2>Groups</h2>
          <div className="group-grid">
            {groupTables.map(({ g, ms, rows }) => (
              <table key={g} className="group-table">
                <caption>Group {g === "?" ? "—" : g}</caption>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Pts</th>
                    <th>±</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.teamId}
                      className={
                        r.teamId === userTeamId ? "you" : i < 2 ? "through" : ""
                      }
                    >
                      <td>{r.team}</td>
                      <td>{r.pts}</td>
                      <td>
                        {r.gf}-{r.ga}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="fixture-mini">
                      {ms.map((m) => (
                        <span key={m.id}>
                          {m.status === "played"
                            ? `${short(m.home_team_name)} ${m.home_score}-${m.away_score} ${short(m.away_team_name)}`
                            : `${short(m.home_team_name)} v ${short(m.away_team_name)}`}
                        </span>
                      ))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            ))}
          </div>
        </div>
      )}

      <div className="bracket">
        <h2>Knockout bracket</h2>
        <div className="rounds">
          {STAGES.filter((s) => s.stages[0] !== "GROUP")
            .map((s) => {
              const ms = s.stages.flatMap((st) => byStage.get(st) ?? []);
              if (!ms.length) return null;
              return (
                <div key={s.label} className="round">
                  <h3>{s.label}</h3>
                  {ms.map((m) => (
                    <div
                      key={m.id}
                      className={"bcard" + (isUserMatch(m, userTeamId) ? " you" : "")}
                    >
                      <div className="bline">
                        <span className="bteam">{m.home_team_name}</span>
                        {m.status === "played" ? <b>{m.home_score}</b> : null}
                      </div>
                      <div className="bline">
                        <span className="bteam">{m.away_team_name}</span>
                        {m.status === "played" ? <b>{m.away_score}</b> : null}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })
            .filter(Boolean)}
        </div>
        {!matches?.some((m) => m.stage !== "GROUP") && (
          <p className="hint">
            Knockout rounds are drawn from the real group standings and appear
            after the group stage is simulated.
          </p>
        )}
      </div>
    </section>
  );
}

function short(n: string): string {
  return n.length > 14 ? n.slice(0, 12) : n;
}

function stageOrder(s: string): number {
  return STAGES.findIndex((x) => x.stages.includes(s));
}

function stageLabel(s: string): string {
  return STAGES.find((x) => x.stages.includes(s))?.label ?? s;
}

function isUserMatch(m: SimMatch, uid: number | null | undefined): boolean {
  return !!uid && (m.home_team_id === uid || m.away_team_id === uid);
}