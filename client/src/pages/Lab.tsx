import { useEffect, useState } from "react";
import { useI18n, flagFor } from "../i18n";
import LiveMatch from "../components/LiveMatch";
import type { Goal, LiveEvent, RedCard, RunMatch } from "../types";

const emptyGoal = (): Goal => ({
  minute: 1,
  extra_time: false,
  team_id: 1,
  scorer_id: 0,
  scorer: "New",
  scorer_photo: null,
  shirt_number: undefined,
  assist_id: null,
  assist: null,
  assist_photo: null,
  own_goal: false,
});

const emptyRed = (): RedCard => ({
  minute: 1,
  extra_time: false,
  team_id: 1,
  player_id: 0,
  player: "New",
  player_photo: null,
  shirt_number: undefined,
});

const emptyEvent = (): LiveEvent => ({
  minute: 1,
  extra_time: false,
  kind: "sub",
  team_id: 1,
  detail: "",
  out_player: null,
  out_player_photo: null,
  in_player: null,
  in_player_photo: null,
});

const DEFAULT_HOME_TEAM = "Brazil";
const DEFAULT_AWAY_TEAM = "Germany";

export default function Lab() {
  const { t } = useI18n();
  const [match, setMatch] = useState<RunMatch | null>(null);

  // Config state
  const [homeTeam, setHomeTeam] = useState(DEFAULT_HOME_TEAM);
  const [awayTeam, setAwayTeam] = useState(DEFAULT_AWAY_TEAM);
  const [homeScore, setHomeScore] = useState(2);
  const [awayScore, setAwayScore] = useState(1);
  const [extraTime, setExtraTime] = useState(false);
  const [penalties, setPenalties] = useState<RunMatch["penalties"]>(null);
  const [addedTimeHt, setAddedTimeHt] = useState(2);
  const [addedTimeFt, setAddedTimeFt] = useState(5);
  const [addedTimeEt1, setAddedTimeEt1] = useState(0);
  const [addedTimeEt2, setAddedTimeEt2] = useState(0);

  // Goals
  const [goals, setGoals] = useState<Goal[]>([
    { minute: 12, extra_time: false, team_id: 1, scorer_id: 1, scorer: "Pelé", scorer_photo: null, shirt_number: 10, assist_id: null, assist: null, assist_photo: null, own_goal: false },
    { minute: 45, extra_time: false, team_id: 2, scorer_id: 2, scorer: "Müller", scorer_photo: null, shirt_number: 13, assist_id: null, assist: null, assist_photo: null, own_goal: false },
    { minute: 67, extra_time: false, team_id: 1, scorer_id: 3, scorer: "Ronaldo", scorer_photo: null, shirt_number: 9, assist_id: 1, assist: "Pelé", assist_photo: null, own_goal: false },
  ]);

  // Red cards
  const [reds, setReds] = useState<RedCard[]>([
    { minute: 89, extra_time: false, team_id: 2, player_id: 4, player: "Kahn", player_photo: null, shirt_number: 1 },
  ]);

  // Events
  const [events, setEvents] = useState<LiveEvent[]>([
    { minute: 46, extra_time: false, kind: "strategy", team_id: 1, detail: "attacking", out_player: null, out_player_photo: null, in_player: null, in_player_photo: null },
    { minute: 62, extra_time: false, kind: "sub", team_id: 1, detail: "", out_player: "Pelé", out_player_photo: null, in_player: "Zico", in_player_photo: null },
    { minute: 75, extra_time: false, kind: "tactics", team_id: 1, detail: "4-3-3", out_player: null, out_player_photo: null, in_player: null, in_player_photo: null },
    { minute: 78, extra_time: false, kind: "sub", team_id: 2, detail: "", out_player: "Beckenbauer", out_player_photo: null, in_player: "Breitner", in_player_photo: null },
  ]);

  const buildMatch = (): RunMatch => ({
    id: 1,
    day: 1,
    stage_key: "F",
    stage_name: "Final",
    home_team_id: 1,
    away_team_id: 2,
    home_team_name: homeTeam,
    away_team_name: awayTeam,
    home_score: homeScore,
    away_score: awayScore,
    extra_time: extraTime,
    penalties,
    result_label: `${homeScore}–${awayScore}${extraTime ? " aet" : ""}${penalties ? ` (${penalties.home_score}–${penalties.away_score} pens)` : ""}`,
    goals,
    reds,
    unavailable: [],
    date: null,
    momentum: { home: Array(90 + (extraTime ? 30 : 0)).fill(0.5), away: Array(90 + (extraTime ? 30 : 0)).fill(0.5) },
    bans: [],
    events,
    added_time_ht: addedTimeHt,
    added_time_ft: addedTimeFt,
    added_time_et1: addedTimeEt1,
    added_time_et2: addedTimeEt2,
  });

  const regenerate = () => {
    setMatch(buildMatch());
  };

  // Auto-regenerate when config changes
  useEffect(() => {
    regenerate();
  }, [
    homeTeam, awayTeam, homeScore, awayScore, extraTime, penalties,
    addedTimeHt, addedTimeFt, addedTimeEt1, addedTimeEt2,
    goals, reds, events
  ]);

  if (!match) return <div className="lab-page">Loading...</div>;

  const updateGoal = (i: number, field: keyof Goal, value: string | number | boolean) => {
    setGoals(g => g.map((goal, idx) => idx === i ? { ...goal, [field]: value } : goal));
  };

  const updateRed = (i: number, field: keyof RedCard, value: string | number | boolean) => {
    setReds(r => r.map((red, idx) => idx === i ? { ...red, [field]: value } : red));
  };

  const updateEvent = (i: number, field: keyof LiveEvent, value: string | number | boolean) => {
    setEvents(e => e.map((evt, idx) => idx === i ? { ...evt, [field]: value } : evt));
  };

  const addGoal = () => setGoals(g => [...g, emptyGoal()]);
  const addRed = () => setReds(r => [...r, emptyRed()]);
  const addEvent = () => setEvents(e => [...e, emptyEvent()]);

  const removeGoal = (i: number) => setGoals(g => g.filter((_, idx) => idx !== i));
  const removeRed = (i: number) => setReds(r => r.filter((_, idx) => idx !== i));
  const removeEvent = (i: number) => setEvents(e => e.filter((_, idx) => idx !== i));

  if (!match) return <div className="lab-page">Loading...</div>;

  return (
    <div className="lab-page">
      <div className="lab-header">
        <h1>🔬 Live Match Lab</h1>
        <p className="hint">Hidden page for testing live match dialog. Configure the match in the sidebar.</p>
      </div>

      <div className="lab-layout">
        <aside className="lab-sidebar">
          <div className="lab-section">
            <h3>{t("lab.teams")}</h3>
            <div className="lab-field">
              <label>{t("lab.homeTeam")}</label>
              <input value={homeTeam} onChange={(e) => setHomeTeam(e.target.value)} />
            </div>
            <div className="lab-field">
              <label>{t("lab.awayTeam")}</label>
              <input value={awayTeam} onChange={(e) => setAwayTeam(e.target.value)} />
            </div>
          </div>

          <div className="lab-section">
            <h3>{t("lab.score")}</h3>
            <div className="lab-field-row">
              <div className="lab-field">
                <label>{t("lab.homeScore")}</label>
                <input type="number" min="0" max="20" value={homeScore} onChange={(e) => setHomeScore(parseInt(e.target.value) || 0)} />
              </div>
              <div className="lab-field">
                <label>{t("lab.awayScore")}</label>
                <input type="number" min="0" max="20" value={awayScore} onChange={(e) => setAwayScore(parseInt(e.target.value) || 0)} />
              </div>
            </div>
            <div className="lab-field">
              <label>
                <input type="checkbox" checked={extraTime} onChange={(e) => setExtraTime(e.target.checked)} />
                {t("lab.extraTime")}
              </label>
            </div>
            {extraTime && (
              <div className="lab-field-row">
                <div className="lab-field">
                  <label>{t("lab.pensHome")}</label>
                  <input type="number" min="0" max="10" value={penalties?.home_score ?? 0} onChange={(e) => setPenalties({ ...(penalties ?? { home_score: 0, away_score: 0, winner_id: 1, sudden_death: false, kicks: [] }), home_score: parseInt(e.target.value) || 0 })} />
                </div>
                <div className="lab-field">
                  <label>{t("lab.pensAway")}</label>
                  <input type="number" min="0" max="10" value={penalties?.away_score ?? 0} onChange={(e) => setPenalties({ ...(penalties ?? { home_score: 0, away_score: 0, winner_id: 1, sudden_death: false, kicks: [] }), away_score: parseInt(e.target.value) || 0 })} />
                </div>
              </div>
            )}
          </div>

          <div className="lab-section">
            <h3>{t("lab.addedTime")}</h3>
            <div className="lab-field-row">
              <div className="lab-field">
                <label>{t("lab.addedTimeHt")}</label>
                <input type="number" min="0" max="10" value={addedTimeHt} onChange={(e) => setAddedTimeHt(parseInt(e.target.value) || 0)} />
              </div>
              <div className="lab-field">
                <label>{t("lab.addedTimeFt")}</label>
                <input type="number" min="0" max="10" value={addedTimeFt} onChange={(e) => setAddedTimeFt(parseInt(e.target.value) || 0)} />
              </div>
            </div>
            {extraTime && (
              <div className="lab-field-row">
                <div className="lab-field">
                  <label>{t("lab.addedTimeEt1")}</label>
                  <input type="number" min="0" max="5" value={addedTimeEt1} onChange={(e) => setAddedTimeEt1(parseInt(e.target.value) || 0)} />
                </div>
                <div className="lab-field">
                  <label>{t("lab.addedTimeEt2")}</label>
                  <input type="number" min="0" max="5" value={addedTimeEt2} onChange={(e) => setAddedTimeEt2(parseInt(e.target.value) || 0)} />
                </div>
              </div>
            )}
          </div>

          <div className="lab-section">
            <h3>{t("lab.goals")}</h3>
            {goals.map((g, i) => (
              <div key={i} className="lab-event-row">
                <input type="number" min="1" max={extraTime ? 120 : 90} value={g.minute} onChange={(e) => updateGoal(i, "minute", parseInt(e.target.value) || g.minute)} />
                <select value={g.team_id} onChange={(e) => updateGoal(i, "team_id", parseInt(e.target.value))}>
                  <option value={1}>{homeTeam}</option>
                  <option value={2}>{awayTeam}</option>
                </select>
                <input value={g.scorer} onChange={(e) => updateGoal(i, "scorer", e.target.value)} placeholder="Scorer" />
                <input type="checkbox" checked={g.extra_time} onChange={(e) => updateGoal(i, "extra_time", e.target.checked)} />
                <button className="btn danger" onClick={() => removeGoal(i)}>✕</button>
              </div>
            ))}
            <button className="btn secondary" onClick={addGoal}>+ {t("lab.addGoal")}</button>
          </div>

          <div className="lab-section">
            <h3>{t("lab.redCards")}</h3>
            {reds.map((r, i) => (
              <div key={i} className="lab-event-row">
                <input type="number" min="1" max={extraTime ? 120 : 90} value={r.minute} onChange={(e) => updateRed(i, "minute", parseInt(e.target.value) || r.minute)} />
                <select value={r.team_id} onChange={(e) => updateRed(i, "team_id", parseInt(e.target.value))}>
                  <option value={1}>{homeTeam}</option>
                  <option value={2}>{awayTeam}</option>
                </select>
                <input value={r.player} onChange={(e) => updateRed(i, "player", e.target.value)} placeholder="Player" />
                <input type="checkbox" checked={r.extra_time} onChange={(e) => updateRed(i, "extra_time", e.target.checked)} />
                <button className="btn danger" onClick={() => removeRed(i)}>✕</button>
              </div>
            ))}
            <button className="btn secondary" onClick={addRed}>+ {t("lab.addRed")}</button>
          </div>

          <div className="lab-section">
            <h3>{t("lab.events")}</h3>
            {events.map((evt, i) => (
              <div key={i} className="lab-event-row">
                <input type="number" min="1" max={extraTime ? 120 : 90} value={evt.minute} onChange={(ev) => updateEvent(i, "minute", parseInt(ev.target.value) || evt.minute)} />
                <select value={evt.kind} onChange={(ev) => updateEvent(i, "kind", ev.target.value as LiveEvent["kind"])}>
                  <option value="sub">{t("lab.sub")}</option>
                  <option value="injury">{t("lab.injury")}</option>
                  <option value="strategy">{t("lab.strategy")}</option>
                  <option value="tactics">{t("lab.tactics")}</option>
                </select>
                <select value={evt.team_id} onChange={(ev) => updateEvent(i, "team_id", parseInt(ev.target.value))}>
                  <option value={1}>{homeTeam}</option>
                  <option value={2}>{awayTeam}</option>
                </select>
                <input value={evt.detail ?? ""} onChange={(ev) => updateEvent(i, "detail", ev.target.value)} placeholder="Detail" />
                <input value={evt.out_player ?? ""} onChange={(ev) => updateEvent(i, "out_player", ev.target.value)} placeholder="Out" />
                <input value={evt.in_player ?? ""} onChange={(ev) => updateEvent(i, "in_player", ev.target.value)} placeholder="In" />
                <input type="checkbox" checked={evt.extra_time} onChange={(ev) => updateEvent(i, "extra_time", ev.target.checked)} />
                <button className="btn danger" onClick={() => removeEvent(i)}>✕</button>
              </div>
            ))}
            <button className="btn secondary" onClick={addEvent}>+ {t("lab.addEvent")}</button>
          </div>

          <button className="btn primary lab-regenerate" onClick={regenerate}>{t("lab.regenerate")}</button>
        </aside>

        <main className="lab-main">
          <div className="lab-match-info">
            <div className="team-info">
              <span className="flag">{flagFor(match.home_team_name)}</span>
              <span className="name">{match.home_team_name}</span>
              <span className="xg">Score: {match.home_score}</span>
            </div>
            <div className="vs">vs</div>
            <div className="team-info">
              <span className="flag">{flagFor(match.away_team_name)}</span>
              <span className="name">{match.away_team_name}</span>
              <span className="xg">Score: {match.away_score}</span>
            </div>
          </div>

          <div className="lab-live-match">
            <LiveMatch
              match={match}
              focusTeamId={match.home_team_id}
              onReveal={() => {}}
              onClose={() => {}}
            />
          </div>

          <div className="lab-debug">
            <h3>{t("lab.debugInfo")}</h3>
            <pre>{JSON.stringify({
              addedTime: {
                ht: match.added_time_ht,
                ft: match.added_time_ft,
                et1: match.added_time_et1,
                et2: match.added_time_et2,
              },
              events: match.events,
              goals: match.goals,
              reds: match.reds,
            }, null, 2)}</pre>
          </div>
        </main>
      </div>
    </div>
  );
}