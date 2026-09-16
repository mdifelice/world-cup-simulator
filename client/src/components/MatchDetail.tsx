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

  const labels: Record<string, string> = {
    home: flagName(m.home_team_name),
    away: flagName(m.away_team_name),
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-head">
          <div>
            <div className="share-title">
              {stage(m.stage_name)} · {t("match.day", { day: m.day })}
            </div>
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
                <span className="goal-min">
                  <span className="goal-ball" aria-hidden>⚽</span>
                  {g.minute}'{g.extra_time ? ` ${t("match.etShort")}` : ""}
                </span>
                <span className="goal-scorer">
                  {g.scorer}
                  {g.assist ? <span className="dim"> · {t("match.assist", { name: g.assist })}</span> : null}
                </span>
                <span className={`goal-team${focused(g.team_id) ? " focus-tag" : ""}`}>
                  {flagFor(g.team_id === m.home_team_id ? m.home_team_name : m.away_team_name)}{" "}
                  {country(g.team_id === m.home_team_id ? m.home_team_name : m.away_team_name)}
                </span>
              </div>
            ))}
          </div>
        )}

        {m.penalties && m.penalties.kicks.length > 0 && (
          <div className="pens-card">
            <h3>{t("match.pens")}</h3>
            <div className="detail-pens">
              <div className="detail-pens-col">
                <span className="flag">{flagFor(m.home_team_name)}</span>
                {m.penalties.kicks
                  .filter((k) => k.team_id === m.home_team_id)
                  .map((k, i) => (
                    <span key={i} className={"pen-kick" + (k.scored ? " scored" : " missed")}>
                      {k.taker} {k.scored ? "✓" : "✕"}
                    </span>
                  ))}
              </div>
              <div className="detail-pens-col">
                <span className="flag">{flagFor(m.away_team_name)}</span>
                {m.penalties.kicks
                  .filter((k) => k.team_id === m.away_team_id)
                  .map((k, i) => (
                    <span key={i} className={"pen-kick" + (k.scored ? " scored" : " missed")}>
                      {k.taker} {k.scored ? "✓" : "✕"}
                    </span>
                  ))}
              </div>
            </div>
          </div>
        )}

        {m.goals.length === 0 && (
          <div className="champ-banner">
            <p className="hint">
              {labels.home}–{labels.away} 0–0
            </p>
          </div>
        )}
      </div>
    </div>
  );
}