import { useEffect, useState } from "react";
import { useI18n, flagFor } from "../i18n";
import LiveMatch from "../components/LiveMatch";
import type { RunMatch } from "../types";

export default function Lab() {
  const { t } = useI18n();
  const [match, setMatch] = useState<RunMatch | null>(null);
  const [homeXG, setHomeXG] = useState(1.5);
  const [awayXG, setAwayXG] = useState(1.0);
  const [seed, setSeed] = useState(12345);

  const generateMatch = () => {
    // Create a mock match for testing
    const mockMatch: RunMatch = {
      id: 1,
      day: 1,
      stage_key: "F",
      stage_name: "Final",
      home_team_id: 1,
      away_team_id: 2,
      home_team_name: "Brazil",
      away_team_name: "Germany",
      home_score: 2,
      away_score: 1,
      extra_time: false,
      penalties: null,
      result_label: "2–1",
      goals: [
        { minute: 12, extra_time: false, team_id: 1, scorer_id: 1, scorer: "Pelé", scorer_photo: null, shirt_number: 10, assist_id: null, assist: null, assist_photo: null, own_goal: false },
        { minute: 45, extra_time: false, team_id: 2, scorer_id: 2, scorer: "Müller", scorer_photo: null, shirt_number: 13, assist_id: null, assist: null, assist_photo: null, own_goal: false },
        { minute: 67, extra_time: false, team_id: 1, scorer_id: 3, scorer: "Ronaldo", scorer_photo: null, shirt_number: 9, assist_id: 1, assist: "Pelé", assist_photo: null, own_goal: false },
      ],
      reds: [
        { minute: 89, extra_time: false, team_id: 2, player_id: 4, player: "Kahn", player_photo: null, shirt_number: 1 },
      ],
      unavailable: [],
      date: null,
      momentum: { home: Array(90).fill(0.5), away: Array(90).fill(0.5) },
      bans: [],
      events: [
        { minute: 46, extra_time: false, kind: "strategy", team_id: 1, detail: "attacking", out_player: null, out_player_photo: null, in_player: null, in_player_photo: null },
        { minute: 62, extra_time: false, kind: "sub", team_id: 1, detail: "", out_player: "Pelé", out_player_photo: null, in_player: "Zico", in_player_photo: null },
        { minute: 75, extra_time: false, kind: "tactics", team_id: 1, detail: "4-3-3", out_player: null, out_player_photo: null, in_player: null, in_player_photo: null },
        { minute: 78, extra_time: false, kind: "sub", team_id: 2, detail: "", out_player: "Beckenbauer", out_player_photo: null, in_player: "Breitner", in_player_photo: null },
      ],
      added_time_ht: 2,
      added_time_ft: 5,
      added_time_et1: 0,
      added_time_et2: 0,
    };
    setMatch(mockMatch);
  };

  useEffect(() => {
    generateMatch();
  }, [seed]);

  if (!match) return <div className="lab-page">Loading...</div>;

  const isFocus = match.home_team_id === 1 || match.away_team_id === 1;

  return (
    <div className="lab-page">
      <div className="lab-header">
        <h1>🔬 Live Match Lab</h1>
        <p className="hint">Hidden page for testing live match dialog. Not accessible from main navigation.</p>
      </div>

      <div className="lab-controls">
        <div className="control-group">
          <label>
            {t("lab.homeXG")} (xG)
            <input
              type="range"
              min="0.1"
              max="4.5"
              step="0.1"
              value={homeXG}
              onChange={(e) => setHomeXG(parseFloat(e.target.value))}
            />
            <span>{homeXG.toFixed(1)}</span>
          </label>
        </div>
        <div className="control-group">
          <label>
            {t("lab.awayXG")} (xG)
            <input
              type="range"
              min="0.1"
              max="4.5"
              step="0.1"
              value={awayXG}
              onChange={(e) => setAwayXG(parseFloat(e.target.value))}
            />
            <span>{awayXG.toFixed(1)}</span>
          </label>
        </div>
        <div className="control-group">
          <label>
            {t("lab.seed")}
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(parseInt(e.target.value) || 12345)}
            />
          </label>
        </div>
        <button className="btn primary" onClick={generateMatch}>
          {t("lab.regenerate")}
        </button>
      </div>

      <div className="lab-match-info">
        <div className="team-info">
          <span className="flag">{flagFor(match.home_team_name)}</span>
          <span className="name">{match.home_team_name}</span>
          <span className="xg">xG: {homeXG}</span>
        </div>
        <div className="vs">vs</div>
        <div className="team-info">
          <span className="flag">{flagFor(match.away_team_name)}</span>
          <span className="name">{match.away_team_name}</span>
          <span className="xg">xG: {awayXG}</span>
        </div>
      </div>

      <div className="lab-live-match">
        <LiveMatch
          match={match}
          focusTeamId={isFocus ? match.home_team_id : null}
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
    </div>
  );
}
