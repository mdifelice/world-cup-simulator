import type { RunPayload } from "../types";

interface Props {
  run: RunPayload;
  teamId: number | null;
  onReplay: () => void;
  onHistory: () => void;
  onHome: () => void;
}

export default function Finals({ run, teamId, onReplay, onHistory, onHome }: Props) {
  const medal = (a: RunPayload["awards"]["golden"], title: string, cls: string) =>
    a ? (
      <div className={"medal " + cls}>
        <span className="medal-title">{title}</span>
        <span className="medal-name">{a.name}</span>
        <span className="medal-team">{a.team_name}</span>
        <span className="medal-pos">{a.position}</span>
        <span className="medal-stats">
          {a.games} apps · {a.goals} goals · {a.assists} assists
        </span>
        <span className="medal-score">score {a.score.toFixed(1)}</span>
      </div>
    ) : null;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>🏆 {run.year} World Cup — {run.host ?? ""}</h1>
          <p className="hint">Final celebrations and awards.</p>
        </div>
      </div>

      {run.champion && (
        <div className="champ-banner">
          <span className="champ-trophy">🏆</span>
          <div>
            <div className="champ-line big">{run.champion}</div>
            <div className="champ-sub">World Champions · {run.year}</div>
          </div>
        </div>
      )}

      <div className="medal-row">
        {medal(run.awards.golden, "GOLDEN BALL", "gold")}
        {medal(run.awards.silver, "SILVER BALL", "silver")}
        {medal(run.awards.bronze, "BRONZE BALL", "bronze")}
      </div>

      {run.awards.top_scorers.length > 0 && (
        <div className="table-card wide">
          <h2 className="table-title">Golden Boot race — final</h2>
          <table className="mini-table">
            <thead>
              <tr>
                <th></th><th className="l">Player</th><th className="l">Team</th>
                <th>Pos</th><th>Goals</th><th>Assists</th>
              </tr>
            </thead>
            <tbody>
              {run.awards.top_scorers.slice(0, 20).map((s, i) => (
                <tr key={i} className={teamId === s.team_id ? "focus-row" : ""}>
                  <td className="num">{i + 1}</td>
                  <td className="l">{s.name}</td>
                  <td className="l dim">{s.team_name}</td>
                  <td className="l dim">{s.position}</td>
                  <td className="num strong">{s.goals}</td>
                  <td className="num">{s.assists}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="cmd-bar bar">
        {run.run_id != null ? (
          <span className="chip ok">Run saved · history #{run.run_id}</span>
        ) : (
          <span className="chip">Not saved (sign in to keep a history)</span>
        )}
        <button className="btn primary big" onClick={onReplay}>🔁 Play it again</button>
        <button className="btn big" onClick={onHistory}>History</button>
        <button className="btn secondary big" onClick={onHome}>New tournament</button>
      </div>
    </section>
  );
}