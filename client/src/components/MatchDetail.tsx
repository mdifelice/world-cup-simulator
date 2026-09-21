import { useMemo } from "react";
import { flagFor, useI18n } from "../i18n";
import type { Goal, RedCard, RunMatch } from "../types";

interface Props {
  match: RunMatch;
  focusTeamId?: number | null;
  onClose: () => void;
}

type Incident = { kind: "goal"; g: Goal } | { kind: "red"; r: RedCard };

function incidentMinute(i: Incident) {
  return i.kind === "goal" ? i.g.minute : i.r.minute;
}
function incidentET(i: Incident) {
  return i.kind === "goal" ? i.g.extra_time : i.r.extra_time;
}
function incidentTeam(i: Incident) {
  return i.kind === "goal" ? i.g.team_id : i.r.team_id;
}
function incidentName(i: Incident) {
  return i.kind === "goal" ? i.g.scorer : i.r.player;
}
function incidentPhoto(i: Incident) {
  return i.kind === "goal" ? i.g.scorer_photo : i.r.player_photo;
}
function incidentNumber(i: Incident) {
  return i.kind === "goal" ? i.g.shirt_number : i.r.shirt_number;
}

export default function MatchDetail({ match: m, focusTeamId, onClose }: Props) {
  const { t, stage, country } = useI18n();

  const focused = (teamId: number) => focusTeamId != null && focusTeamId === teamId;
  const flagName = (n: string) => [flagFor(n), country(n)].filter(Boolean).join(" ");

  // Goals and cards share one timeline, ordered by time (newest first), ties
  // sorted by extra time then goals before cards.
  const incidents = useMemo(() => {
    const list: Incident[] = [
      ...(m.goals ?? []).map((g) => ({ kind: "goal" as const, g })),
      ...(m.reds ?? []).map((r) => ({ kind: "red" as const, r })),
    ];
    return list.sort((a, b) => {
      const byMin = incidentMinute(b) - incidentMinute(a);
      if (byMin !== 0) return byMin;
      const byEt = Number(incidentET(b)) - Number(incidentET(a));
      if (byEt !== 0) return byEt;
      return a.kind === "red" ? 1 : -1;
    });
  }, [m.goals, m.reds]);

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

        {incidents.length > 0 && (
          <div className="detail-goals">
            {incidents.map((inc, i) => (
              <div
                key={i}
                className={
                  "goal-row" + (inc.kind === "red" ? " red-row" : "")
                }
              >
                <span className="goal-ball" aria-hidden>
                  {inc.kind === "goal" ? "⚽" : "🟥"}
                </span>
                {incidentPhoto(inc) && (
                  <img
                    className="goal-photo"
                    src={incidentPhoto(inc)!}
                    alt=""
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                )}
                <span className="goal-player">
                  {incidentNumber(inc) != null
                    ? `${incidentNumber(inc)}. `
                    : ""}
                  {incidentName(inc)}
                  {inc.kind === "goal" && inc.g.own_goal ? (
                    <span className="og-badge">{t("match.ownGoal")}</span>
                  ) : null}
                </span>
                {inc.kind === "goal" && inc.g.assist ? (
                  <span className="goal-assist">
                    · {t("match.assist", { name: inc.g.assist })}
                  </span>
                ) : null}
                <span className="goal-end">
                  <span className="goal-min">
                    {incidentMinute(inc)}'
                    {incidentET(inc) ? ` ${t("match.etShort")}` : ""}
                  </span>
                  <span
                    className={`goal-team${focused(incidentTeam(inc)) ? " focus-tag" : ""}`}
                  >
                    {flagFor(
                      incidentTeam(inc) === m.home_team_id
                        ? m.home_team_name
                        : m.away_team_name,
                    )}
                  </span>
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