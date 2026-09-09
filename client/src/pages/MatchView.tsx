import { useI18n } from "../i18n";
import type { RunMatch } from "../types";

interface Props {
  match: RunMatch;
  focusTeamId: number | null;
  shirtNumbers: boolean;
  onBack: () => void;
  onOpenPrev: () => void;
}

const GOLD = "#ffd75e";

export default function MatchView({ match: m, focusTeamId, onBack, onOpenPrev }: Props) {
  const { t, stage } = useI18n();

  const isFocus =
    focusTeamId != null &&
    (m.home_team_id === focusTeamId || m.away_team_id === focusTeamId);

  const momentum = isFocus && m.momentum ? m.momentum : null;
  const series = momentum
    ? focusTeamId === m.away_team_id
      ? momentum.away
      : momentum.home
    : null;

  const len = series ? series.length : 0;
  const lengthLabel = m.extra_time ? 120 : 90;
  const W = 1000;
  const H = 110;
  const pts = (series ?? []).map((v, i) => {
    const x = (i / Math.max(1, len - 1)) * W;
    const y = H - 8 - v * (H - 24);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const isAwayFocusMomentum =
    momentum != null && focusTeamId === m.away_team_id;

  const goalMarks = m.goals.map((g, i) => {
    const x = (g.minute / lengthLabel) * W;
    const ownGoalColor =
      g.team_id === focusTeamId ? GOLD : "rgba(255,255,255,0.65)";
    const note = g.extra_time ? ` ${t("match.etShort")}` : "";
    return { x, g, ownGoalColor, note, key: i };
  });

  const tick = (min: number, label: string) => {
    const x = (min / lengthLabel) * W;
    return (
      <g key={min}>
        <line x1={x} y1={0} x2={x} y2={H} stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
        <text x={x + 3} y={H - 2} fill="rgba(255,255,255,0.45)" fontSize="11">
          {label}
        </text>
      </g>
    );
  };

  const resultLabel = `${m.home_score}–${m.away_score}` +
    (m.extra_time ? ` · ${t("match.aet")}` : "") +
    (m.penalties ? ` · ${t("match.pens")}` : "");

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{stage(m.stage_name)}</h1>
          <p className="hint">{t("match.day", { day: m.day })}</p>
        </div>
        <div className="btn-row">
          <button className="btn secondary" onClick={onOpenPrev}>{t("match.prev")}</button>
          <button className="btn" onClick={onBack}>{t("match.back")}</button>
        </div>
      </div>

      <div className="match-vs">
        <div className={"vs-team" + (m.home_team_id === focusTeamId ? " focus" : "")}>
          <span className="vs-name">{m.home_team_name}</span>
          <span className="vs-score">{m.home_score}</span>
        </div>
        <div className="vs-dash">–</div>
        <div className={"vs-team" + (m.away_team_id === focusTeamId ? " focus" : "")}>
          <span className="vs-name">{m.away_team_name}</span>
          <span className="vs-score">{m.away_score}</span>
        </div>
      </div>
      <p className="match-label">{resultLabel}</p>

      {momentum && series && series.length > 0 && (
        <div className="chart-card">
          <div className="chart-head">
            <span className="dot" style={{ background: GOLD }}></span>
            {focusTeamId != null && (
              <span className="chart-title">
                {t("match.momentum", {
                  team:
                    m.home_team_id === focusTeamId
                      ? m.home_team_name
                      : m.away_team_name,
                })}
              </span>
            )}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} className="momentum" preserveAspectRatio="none">
            {tick(0, "0'")}
            {tick(45, t("match.ht"))}
            {tick(90, m.extra_time ? "90'" : t("match.ft"))}
            {m.extra_time && tick(120, t("match.ft"))}
            <polygon
              points={`0,${H} ${pts.join(" ")} ${W},${H}`}
              fill={GOLD}
              opacity="0.22"
            />
            <polyline
              points={pts.join(" ")}
              fill="none"
              stroke={GOLD}
              strokeWidth="2.5"
              vectorEffect="non-scaling-stroke"
            />
            {goalMarks.map(({ x, g, ownGoalColor, note, key }) =>
              isFocus && !isAwayFocusMomentum && g.team_id !== focusTeamId ? null : (
                <g key={key}>
                  <line x1={x} y1={12} x2={x} y2={H} stroke={ownGoalColor} strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
                  <circle cx={x} cy={14} r={5} fill={ownGoalColor} stroke="#222" strokeWidth="1" />
                  <text x={x + 8} y={16} fill="rgba(255,255,255,0.85)" fontSize="11">
                    {g.minute}
                    {note}
                  </text>
                </g>
              ),
            )}
          </svg>
        </div>
      )}

      {m.penalties && (
        <div className="pens-card">
          <h3>
            {t("match.shootout", {
              score: `${m.penalties.home_score}–${m.penalties.away_score}`,
              winner:
                m.penalties.winner_id === m.home_team_id
                  ? m.home_team_name
                  : m.away_team_name,
            })}
          </h3>
          <div className="pen-grid">
            {m.penalties.kicks.map((k, i) => (
              <span key={i} className={"pen-kick " + (k.scored ? "scored" : "missed")}>
                {k.scored ? "✓" : "✗"} {k.taker}
              </span>
            ))}
          </div>
        </div>
      )}

      {m.goals.length > 0 && (
        <div className="goals-card">
          <h3>{t("match.goals")}</h3>
          {m.goals.map((g, i) => (
            <div key={i} className="goal-row">
              <span className="goal-min">{g.minute}'{g.extra_time ? ` ${t("match.etShort")}` : ""}</span>
              <span className="goal-scorer">
                {g.scorer}
                {g.assist ? <span className="dim"> · {t("match.assist", { name: g.assist })}</span> : null}
              </span>
              <span className="goal-team">
                {m.home_team_id === g.team_id ? m.home_team_name : m.away_team_name}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}