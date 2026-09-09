import { useI18n } from "../i18n";
import type { RunPayload } from "../types";

interface Props {
  run: RunPayload;
  teamId: number | null;
  onReplay: () => void;
  onHistory: () => void;
  onHome: () => void;
}

export default function Finals({ run, teamId, onReplay, onHistory, onHome }: Props) {
  const { t } = useI18n();

  const medal = (a: RunPayload["awards"]["golden"], title: string, cls: string) =>
    a ? (
      <div className={"medal " + cls}>
        <span className="medal-title">{title}</span>
        <span className="medal-name">{a.name}</span>
        <span className="medal-team">{a.team_name}</span>
        <span className="medal-pos">{a.position}</span>
        <span className="medal-stats">
          {t("final.apps", { count: a.games, goals: a.goals, assists: a.assists })}
        </span>
        <span className="medal-score">{t("final.score", { score: a.score.toFixed(1) })}</span>
      </div>
    ) : null;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{t("final.title", { year: run.year, host: run.host ?? "" })}</h1>
          <p className="hint">{t("final.hint")}</p>
        </div>
      </div>

      {run.champion && (
        <div className="champ-banner">
          <span className="champ-trophy">🏆</span>
          <div>
            <div className="champ-line big">{run.champion}</div>
            <div className="champ-sub">{t("final.champions", { year: run.year })}</div>
          </div>
        </div>
      )}

      <div className="medal-row">
        {medal(run.awards.golden, t("final.golden"), "gold")}
        {medal(run.awards.silver, t("final.silver"), "silver")}
        {medal(run.awards.bronze, t("final.bronze"), "bronze")}
      </div>

      {run.awards.top_scorers.length > 0 && (
        <div className="table-card wide">
          <h2 className="table-title">{t("final.boot")}</h2>
          <table className="mini-table">
            <thead>
              <tr>
                <th></th><th className="l">{t("final.player")}</th><th className="l">{t("final.team")}</th>
                <th>{t("final.pos")}</th><th>{t("final.goals")}</th><th>{t("final.assists")}</th>
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
          <span className="chip ok">{t("final.saved", { id: run.run_id })}</span>
        ) : (
          <span className="chip">{t("final.notSaved")}</span>
        )}
        <button className="btn primary big" onClick={onReplay}>{t("final.replay")}</button>
        <button className="btn big" onClick={onHistory}>{t("final.history")}</button>
        <button className="btn secondary big" onClick={onHome}>{t("final.home")}</button>
      </div>
    </section>
  );
}