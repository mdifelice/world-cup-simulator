import { useMemo } from "react";
import { flagFor, useI18n } from "../i18n";
import type { RunMatch } from "../types";

interface Props {
  match: RunMatch;
  focusTeamId?: number | null;
  onClose: () => void;
}

export default function MatchDetail({ match: m, focusTeamId, onClose }: Props) {
  const { t, stage, country } = useI18n();

  const focused = (teamId: number) => focusTeamId != null && focusTeamId === teamId;
  const flagName = (n: string) => [flagFor(n), country(n)].filter(Boolean).join(" ");

  const sorted = useMemo(
    () => [...m.goals].sort((a, b) => b.minute - a.minute || Number(b.extra_time) - Number(a.extra_time)),
    [m.goals],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-head">
          <div>
            <div className="share-title">{stage(m.stage_name)}</div>
          </div>
          <button className="live-x" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>

        <div className="detail-score">
          <div className={"vs-team" + (focused(m.home_team_id) ? " focus" : "")}>
            <span className="vs-name">{flagName(m.home_team_name)}</span>
            <span className="vs-score">{m.home_score}</span>
          </div>
          <div className="vs-dash">–</div>
          <div className={"vs-team" + (focused(m.away_team_id) ? " focus" : "")}>
            <span className="vs-name">{flagName(m.away_team_name)}</span>
            <span className="vs-score">{m.away_score}</span>
          </div>
        </div>

        {(m.extra_time || m.penalties) && (
          <p className="match-label">
            {m.extra_time ? t("match.aet") : ""}
            {m.extra_time && m.penalties ? " · " : ""}
            {m.penalties
              ? t("match.pensScore", {
                  home: m.penalties.home_score,
                  away: m.penalties.away_score,
                })
              : ""}
          </p>
        )}

        {m.goals.length > 0 && (
          <div className="detail-goals">
            {sorted.map((g, i) => (
              <div key={i} className="goal-row">
                <span className="goal-side" aria-hidden>
                  {g.scorer_photo ? (
                    <img className="goal-photo" src={g.scorer_photo} alt="" />
                  ) : null}
                  <span className="goal-info">
                    <span className="goal-ball" aria-hidden>⚽</span>
                    <span className="goal-player">
                      {g.shirt_number ? `${g.shirt_number} - ` : ""}
                      {g.scorer}
                    </span>
                    {g.own_goal ? (
                      <span className="og-badge">{t("match.ownGoal")}</span>
                    ) : null}
                    {g.assist ? <span className="dim"> · {t("match.assist", { name: g.assist })}</span> : null}
                  </span>
                </span>
                <span className="goal-min">{g.minute}'{g.extra_time ? ` ${t("match.etShort")}` : ""}</span>
                <span className={`goal-team${focused(g.team_id) ? " focus-tag" : ""}`}>
                  {flagFor(g.team_id === m.home_team_id ? m.home_team_name : m.away_team_name)}
                </span>
              </div>
            ))}
          </div>
        )}

        {(m.reds ?? []).length > 0 && (
          <div className="detail-goals reds-card">
            {[...(m.reds ?? [])]
              .sort((a, b) => a.minute - b.minute)
              .map((r, i) => (
                <div key={i} className="goal-row red-row">
                  <span className="goal-side" aria-hidden>
                    {r.player_photo ? (
                      <img className="goal-photo" src={r.player_photo} alt="" />
                    ) : null}
                    <span className="goal-info">
                      <span className="goal-ball" aria-hidden>🟥</span>
                      <span className="goal-player">{r.player}</span>
                    </span>
                  </span>
                  <span className="goal-min">{r.minute}'{r.extra_time ? ` ${t("match.etShort")}` : ""}</span>
                  <span className={`goal-team${focused(r.team_id) ? " focus-tag" : ""}`}>
                    {flagFor(r.team_id === m.home_team_id ? m.home_team_name : m.away_team_name)}
                  </span>
                </div>
              ))}
          </div>
        )}

        {m.penalties && m.penalties.kicks.length > 0 && (
          <div className="pens-card">
            <h3>{t("match.pens")}</h3>
            <div className="detail-pens">
              <div className="pens-side pens-home">
                <span className="pens-side-label">{flagFor(m.home_team_name)} {t("match.pensHome")}</span>
                {m.penalties.kicks
                  .filter((k) => k.team_id === m.home_team_id)
                  .map((k) => (
                    <div key={`${k.round}-${k.team_id}`} className="pen-row">
                      <span className="pen-num">{k.round}</span>
                      <span className="pen-taker">{k.taker}</span>
                      <span
                        className={"pen-kick" + (k.scored ? " scored" : " missed")}
                      >
                        {k.scored ? "✓" : "✕"}
                      </span>
                    </div>
                  ))}
              </div>
              <div className="pens-side pens-away">
                <span className="pens-side-label">{t("match.pensAway")} {flagFor(m.away_team_name)}</span>
                {m.penalties.kicks
                  .filter((k) => k.team_id === m.away_team_id)
                  .map((k) => (
                    <div key={`${k.round}-${k.team_id}`} className="pen-row">
                      <span className="pen-num">{k.round}</span>
                      <span className="pen-taker">{k.taker}</span>
                      <span
                        className={"pen-kick" + (k.scored ? " scored" : " missed")}
                      >
                        {k.scored ? "✓" : "✕"}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}