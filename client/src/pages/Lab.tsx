import { useEffect, useMemo, useState, useRef } from "react";
import { useI18n, flagFor } from "../i18n";
import { LiveMatch } from "../components/LiveMatch";
import MatchDetail from "../components/MatchDetail";
import type { Participant, Player, RunMatch, Strategy, Tournament, LiveMatchControls } from "../types";
import { STRATEGIES } from "../types";
import type { LabTeam } from "../sim/run";
import { playLabMatch, randomSeed } from "../sim/run";
import { api } from "../api";

interface HistoryEntry {
  id: number;
  ts: number;
  source: string;
  match: RunMatch;
}

interface Score {
  h: number;
  a: number;
}

const HISTORY_KEY = "wcs_lab_history";
const HISTORY_CAP = 20;
const SCORES_CAP = 2000;

const clampOverall = (v: number) => Math.max(30, Math.min(99, Math.round(v)));

const strategyShift = (s: Strategy | undefined): number =>
  s === "attacking" ? 2 : s === "defensive" ? -1 : 0;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* storage full/blocked — history stays in memory */
  }
}

function statsFrom(scores: Score[]) {
  let h = 0;
  let a = 0;
  let hw = 0;
  let dr = 0;
  let aw = 0;
  let mh = 0;
  let ma = 0;
  for (const s of scores) {
    h += s.h;
    a += s.a;
    if (s.h > s.a) hw++;
    else if (s.h === s.a) dr++;
    else aw++;
    mh = Math.max(mh, s.h);
    ma = Math.max(ma, s.a);
  }
  const n = scores.length;
  return {
    n,
    homeAvg: n ? h / n : 0,
    awayAvg: n ? a / n : 0,
    totalAvg: n ? (h + a) / n : 0,
    homePct: n ? (hw / n) * 100 : 0,
    drawPct: n ? (dr / n) * 100 : 0,
    awayPct: n ? (aw / n) * 100 : 0,
    maxH: mh,
    maxA: ma,
  };
}

export default function Lab() {
  const { t } = useI18n();
  const [showLiveMatch, setShowLiveMatch] = useState(false);
  const [showSummary, setShowSummary] = useState<RunMatch | null>(null);
  const [generating, setGenerating] = useState(false);
  const [seedInput, setSeedInput] = useState("");
  // Match format toggles.
  const [extraTime, setExtraTime] = useState(false);
  const [usePens, setUsePens] = useState(false);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedTournamentId, setSelectedTournamentId] = useState<number | null>(null);
  const [teams, setTeams] = useState<Participant[]>([]);
  const [selectedHomeTeamId, setSelectedHomeTeamId] = useState<number | null>(null);
  const [selectedAwayTeamId, setSelectedAwayTeamId] = useState<number | null>(null);
  const [match, setMatch] = useState<RunMatch | null>(null);

  // Lab-only overrides (never persisted): squads + per-team stat sliders
  // feeding the client-side run engine.
  const [squads, setSquads] = useState<Record<number, Player[]>>({});
  const [strategies, setStrategies] = useState<Record<number, Strategy>>({});
  const [teamShifts, setTeamShifts] = useState<Record<number, number>>({});

  // Match history (localStorage-persisted across sessions).
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  // Every generated scoreline, for the aggregate panel (session-scoped).
  const [allScores, setAllScores] = useState<Score[]>([]);

  // Load tournaments on mount
  useEffect(() => {
    api.tournaments().then((tournaments) => {
      setTournaments(tournaments);
      // Auto-select 2026 tournament if available
      const wc2026 = tournaments.find((t) => t.year === 2026);
      if (wc2026) {
        setSelectedTournamentId(wc2026.id);
      }
    }).catch(() => {});
  }, []);

  // Load teams when tournament selected
  useEffect(() => {
    if (!selectedTournamentId) {
      setTeams([]);
      return;
    }
    api.participants(selectedTournamentId).then((teams) => {
      setTeams(teams);
      // Auto-select Argentina vs Spain for 2026
      if (teams.length > 0) {
        const argentina = teams.find((t) => t.name === "Argentina");
        const spain = teams.find((t) => t.name === "Spain");
        if (argentina && spain) {
          setSelectedHomeTeamId(argentina.id);
          setSelectedAwayTeamId(spain.id);
        }
      }
    }).catch(() => setTeams([]));
  }, [selectedTournamentId]);

  // Load the two squads when both teams are picked (stats come from the
  // server; simulation itself is entirely client-side).
  useEffect(() => {
    if (!selectedTournamentId || !selectedHomeTeamId || !selectedAwayTeamId) return;
    const ids = [...new Set([selectedHomeTeamId, selectedAwayTeamId])];
    ids.forEach(async (teamId) => {
      if (squads[teamId]) return;
      try {
        const players = await api.players(teamId, selectedTournamentId);
        setSquads((cur) => ({ ...cur, [teamId]: players }));
      } catch {
        /* keep previously loaded squads */
      }
    });
  }, [selectedTournamentId, selectedHomeTeamId, selectedAwayTeamId]);

  const selectedTournament = useMemo(
    () => tournaments.find((tr) => tr.id === selectedTournamentId) ?? null,
    [tournaments, selectedTournamentId],
  );

  const sortedTeams = useMemo(
    () => [...teams].sort((a, b) => a.name.localeCompare(b.name)),
    [teams],
  );

  const teamLabel = (id: number | null, fallback: string): string => {
    if (id == null) return fallback;
    return teams.find((tm) => tm.id === id)?.name ?? `Team ${id}`;
  };

  const liveMatchRef = useRef<LiveMatchControls>(null);

  // Keyboard shortcuts for live match
  useEffect(() => {
    if (!showLiveMatch) return;
    const handleKey = (e: KeyboardEvent) => {
      // Only handle keys when no input element is focused
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        liveMatchRef.current?.togglePause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        liveMatchRef.current?.stepBackward();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        liveMatchRef.current?.stepForward();
      }
    };
    window.addEventListener("keydown", handleKey, true); // Use capture phase
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [showLiveMatch]);

  const squadsReady =
    selectedHomeTeamId != null &&
    selectedAwayTeamId != null &&
    (squads[selectedHomeTeamId]?.length ?? 0) > 0 &&
    (squads[selectedAwayTeamId]?.length ?? 0) > 0;

  // -----------------------------------------------------------------------
  // Lab engines
  // -----------------------------------------------------------------------

  /** Effective rating for a player honoring the team stat slider + strategy. */
  const effectiveOverall = (p: Player, teamId: number): number =>
    clampOverall((p.rating ?? p.overall) + (teamShifts[teamId] ?? 0) + strategyShift(strategies[teamId]));

  const buildLabTeam = (teamId: number): LabTeam | null => {
    const team = teams.find((tm) => tm.id === teamId);
    if (!team) return null;
    const players = (squads[teamId] ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      positions: p.positions?.length ? p.positions : [p.position],
      photo_url: p.photo_url ?? null,
      shirt_number: p.shirt_number,
      overall: effectiveOverall(p, teamId),
      aggression: p.aggression ?? 60,
      leadership: p.leadership ?? null,
    }));
    if (players.length === 0) return null;
    return {
      id: team.id,
      name: team.name,
      code: team.code,
      rating: team.rating,
      pedigree: team.pedigree,
      home_support: team.home_support,
      form: team.form,
      morale: team.morale,
      players,
    };
  };

  const recordScore = (h: number, a: number) => {
    setAllScores((cur) => [...cur, { h, a }].slice(-SCORES_CAP));
  };

  const addHistory = (run: RunMatch) => {
    setHistory((cur) => {
      const entry: HistoryEntry = { id: Date.now() + Math.random(), ts: Date.now(), source: "engine", match: run };
      const next = [entry, ...cur].slice(0, HISTORY_CAP);
      persistHistory(next);
      return next;
    });
  };

  const removeHistory = (id: number) => {
    setHistory((cur) => {
      const next = cur.filter((e) => e.id !== id);
      persistHistory(next);
      return next;
    });
  };

  const clearHistory = () => {
    setHistory([]);
    persistHistory([]);
    setAllScores([]);
  };

  const resolveSeed = (): bigint => {
    const s = seedInput.trim();
    if (/^\d+$/.test(s)) return BigInt(s);
    return BigInt(randomSeed());
  };

  const generateEngine = (live: boolean) => {
    if (!selectedTournament || !selectedHomeTeamId || !selectedAwayTeamId) return;
    const home = buildLabTeam(selectedHomeTeamId);
    const away = buildLabTeam(selectedAwayTeamId);
    if (!home || !away || home.players.length === 0 || away.players.length === 0) return;
    setGenerating(true);
    // Let the paint flush so the "Generating…" state shows before the work.
    setTimeout(() => {
      const seed = resolveSeed();
      setSeedInput(seed.toString());
      const run = playLabMatch(selectedTournament.id, selectedTournament.year, home, away, seed, {
        extraTime,
        penalties: usePens,
      });
      recordScore(run.home_score, run.away_score);
      addHistory(run);
      setMatch(run);
      setShowSummary(null);
      if (live) setShowLiveMatch(true);
      else setShowSummary(run);
      setGenerating(false);
    }, 30);
  };

  const stats = useMemo(() => statsFrom(allScores), [allScores]);

  return (
    <div className="lab-page">
      <div className="lab-header lab-header-row">
        <div>
          <h1>🔬 Live Match Lab</h1>
          <p className="hint">Pick two teams, tweak their stats, then simulate or play the match live.</p>
        </div>
        <div className="lab-toolbar">
          <div className="lab-toolgroup">
            <label>{t("lab.seed")}</label>
            <div className="lab-seed-row">
              <input
                className="lab-seed-input"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder={t("lab.seedRandom")}
                inputMode="numeric"
              />
              <button
                className="btn secondary"
                title={t("lab.seedRandom")}
                onClick={() => setSeedInput(randomSeed().toString())}
              >
                🎲
              </button>
            </div>
          </div>
          <div className="lab-toolgroup">
            <label>&nbsp;</label>
            <button className="btn primary" onClick={() => generateEngine(true)} disabled={generating || !squadsReady}>
              {generating ? t("lab.generating") : t("lab.play")}
            </button>
          </div>
          <div className="lab-toolgroup">
            <label>&nbsp;</label>
            <button className="btn primary" onClick={() => generateEngine(false)} disabled={generating || !squadsReady}>
              {generating ? t("lab.generating") : t("lab.simulate")}
            </button>
          </div>
          <div className="lab-toolgroup lab-format">
            <label>{t("lab.format")}</label>
            <div className="lab-format-row">
              <label className="lab-format-label">
                <input type="checkbox" checked={extraTime} onChange={(e) => setExtraTime(e.target.checked)} />
                {t("lab.extraTime")}
              </label>
              <label className="lab-format-label">
                <input type="checkbox" checked={usePens} onChange={(e) => setUsePens(e.target.checked)} />
                {t("lab.pens")}
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="lab-layout">
        <aside className="lab-sidebar">
          <div className="lab-section">
            <h3>{t("lab.tournament")}</h3>
            <div className="lab-field">
              <label>{t("lab.selectTournament")}</label>
              <select value={selectedTournamentId ?? ""} onChange={(e) => setSelectedTournamentId(e.target.value ? parseInt(e.target.value) : null)}>
                <option value="">{t("lab.selectTournamentPlaceholder")}</option>
                {tournaments.map(tr => (
                  <option key={tr.id} value={tr.id}>{tr.year} - {tr.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="lab-section">
            <h3>{t("lab.teams")}</h3>
            <div className="lab-field-row">
              <div className="lab-field">
                <label>{t("lab.homeTeam")}</label>
                <select value={selectedHomeTeamId ?? ""} onChange={(e) => setSelectedHomeTeamId(e.target.value ? parseInt(e.target.value) : null)}>
                  <option value="">{t("lab.selectTeam")}</option>
                  {sortedTeams.map(tm => (
                    <option key={tm.id} value={tm.id}>{tm.name}</option>
                  ))}
                </select>
              </div>
              <div className="lab-field">
                <label>{t("lab.awayTeam")}</label>
                <select value={selectedAwayTeamId ?? ""} onChange={(e) => setSelectedAwayTeamId(e.target.value ? parseInt(e.target.value) : null)}>
                  <option value="">{t("lab.selectTeam")}</option>
                  {sortedTeams.map(tm => (
                    <option key={tm.id} value={tm.id}>{tm.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {selectedHomeTeamId != null && selectedAwayTeamId != null && (
            <div className="lab-section">
              <h3>{t("lab.overrides")}</h3>
              {[
                { id: selectedHomeTeamId, side: "home" },
                { id: selectedAwayTeamId, side: "away" },
              ].map((side) => {
                const sid = side.id;
                const squad = squads[sid] ?? [];
                return (
                  <div key={side.side} className="lab-ov-team">
                    <h4>{teamLabel(sid, t("lab.selectTeam"))}</h4>
                    <div className="lab-field-row">
                      <div className="lab-field">
                        <label>{t("lab.strategy")}</label>
                        <select
                          value={strategies[sid] ?? "normal"}
                          onChange={(e) =>
                            setStrategies((cur) => ({
                              ...cur,
                              [sid]: e.target.value as Strategy,
                            }))
                          }
                        >
                          {STRATEGIES.map((s) => (
                            <option key={s} value={s}>{t(`lab.strat.${s}`)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="lab-field">
                        <label>
                          {t("lab.teamShift")} · ({teamShifts[sid] ?? 0})
                        </label>
                        <input
                          type="range"
                          min={-20}
                          max={20}
                          step={1}
                          value={teamShifts[sid] ?? 0}
                          onChange={(e) =>
                            setTeamShifts((cur) => ({
                              ...cur,
                              [sid]: parseInt(e.target.value) || 0,
                            }))
                          }
                        />
                      </div>
                    </div>
                    {(squad.length ?? 0) === 0 && (
                      <p className="hint">{t("lab.squadLoading")}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        <main className="lab-main">
          {showLiveMatch && match ? (
            <div className="lab-live-match">
              <LiveMatch
                ref={liveMatchRef}
                match={match}
                focusTeamId={match.home_team_id}
                onReveal={() => {}}
                onClose={() => setShowLiveMatch(false)}
              />
            </div>
          ) : (
            <>
              <div className="lab-section lab-allstats">
                <h3>{t("lab.allStats")}</h3>
                {stats.n === 0 ? (
                  <p className="hint">{t("lab.historyEmpty")}</p>
                ) : (
                  <div className="lab-bulk-result">
                    <h4>{t("lab.bulkResult", { n: stats.n })}</h4>
                    <table>
                      <tbody>
                        <tr><td>{t("lab.avgHome")}</td><td>{stats.homeAvg.toFixed(2)}</td></tr>
                        <tr><td>{t("lab.avgAway")}</td><td>{stats.awayAvg.toFixed(2)}</td></tr>
                        <tr><td>{t("lab.avgTotal")}</td><td>{stats.totalAvg.toFixed(2)}</td></tr>
                        <tr><td>{t("lab.pctHome")}</td><td>{stats.homePct.toFixed(1)}%</td></tr>
                        <tr><td>{t("lab.pctDraw")}</td><td>{stats.drawPct.toFixed(1)}%</td></tr>
                        <tr><td>{t("lab.pctAway")}</td><td>{stats.awayPct.toFixed(1)}%</td></tr>
                        <tr><td>{t("lab.maxScore")}</td><td>{stats.maxH}–{stats.maxA}</td></tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="lab-section">
                <div className="lab-section-head">
                  <h3>{t("lab.history")}</h3>
                  {(history.length > 0 || stats.n > 0) && (
                    <button className="btn danger" onClick={clearHistory}>
                      {t("lab.clearAll")}
                    </button>
                  )}
                </div>
                {history.length === 0 && <p className="hint">{t("lab.historyEmpty")}</p>}
                <ul className="lab-history">
                  {history.map((entry) => (
                    <li key={entry.id} className="lab-history-entry">
                      <button
                        className="lab-history-main"
                        onClick={() => {
                          setMatch(entry.match);
                          setShowLiveMatch(false);
                          setShowSummary(entry.match);
                        }}
                        title={new Date(entry.ts).toLocaleString()}
                      >
                        <span className={`lab-source lab-source-${entry.source}`}>{t(`lab.source.${entry.source}`)}</span>
                        <span className="lab-history-score">
                          {flagFor(entry.match.home_team_name)} {entry.match.home_team_name} {entry.match.home_score}–{entry.match.away_score} {entry.match.away_team_name} {flagFor(entry.match.away_team_name)}
                        </span>
                      </button>
                      <button className="btn secondary" onClick={() => {
                        setMatch(entry.match);
                        setShowSummary(null);
                        setShowLiveMatch(true);
                      }}>
                        {t("lab.replay")}
                      </button>
                      <button className="btn danger" onClick={() => removeHistory(entry.id)}>🗑</button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </main>
      </div>

      {showSummary && (
        <MatchDetail match={showSummary} onClose={() => setShowSummary(null)} />
      )}
    </div>
  );
}