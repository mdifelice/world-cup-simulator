import { useEffect, useMemo, useState } from "react";
import { flagFor, useI18n } from "../i18n";
import type { RunMatch } from "../types";

interface Props {
  match: RunMatch;
  focusTeamId: number | null;
  onReveal: (m: RunMatch) => void;
  onFF: (m: RunMatch) => void;
}

const GOLD = "#d8a418";
const UP = "#2da562";
const DOWN = "#c8443a";
const LIVE_MS = 150;

export default function LiveMatch({
  match: m,
  focusTeamId,
  onReveal,
  onFF,
}: Props) {
  const { t, stage, country } = useI18n();

  const lengthLabel = m.extra_time ? 120 : 90;
  const [min, setMin] = useState(0);

  useEffect(() => {
    setMin(0);
    const iv = setInterval(() => {
      setMin((cur) => (cur >= lengthLabel ? cur : cur + 1));
    }, LIVE_MS);
    return () => clearInterval(iv);
  }, [m.id, lengthLabel]);

  const done = min >= lengthLabel;

  // Reveal the result on the hub once the full match has been watched.
  useEffect(() => {
    if (done) onReveal(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const isFocus =
    focusTeamId != null &&
    (m.home_team_id === focusTeamId || m.away_team_id === focusTeamId);

  const momentum = isFocus && m.momentum ? m.momentum : null;
  const series = momentum
    ? focusTeamId === m.away_team_id
      ? momentum.away
      : momentum.home
    : null;

  const goalsUpTo = useMemo(
    () => m.goals.filter((g) => g.minute <= min),
    [m.goals, min],
  );
  const homeGoals = goalsUpTo.filter((g) => g.team_id === m.home_team_id).length;
  const awayGoals = goalsUpTo.filter((g) => g.team_id === m.away_team_id).length;

  const W = 900;
  const H = 70;
  const midY = H / 2;
  const maxHalf = (H - 18) / 2;
  const bw = W / lengthLabel;
  const bars = useMemo(() => {
    if (!series || series.length === 0) return [] as { m: number; x: number; up: boolean; h: number }[];
    const out: { m: number; x: number; up: boolean; h: number }[] = [];
    for (let mm = 1; mm <= Math.min(min, lengthLabel); mm++) {
      const s = series[Math.min(mm - 1, series.length - 1)];
      const d = s - 0.5;
      out.push({
        m: mm,
        x: ((mm - 0.5) / lengthLabel) * W,
        up: d >= 0,
        h: Math.max(1, Math.round(Math.abs(d) * 2 * maxHalf)),
      });
    }
    return out;
  }, [series, min, lengthLabel, W, maxHalf]);

  const isAwayFocusMomentum = momentum != null && focusTeamId === m.away_team_id;
  const focusName =
    m.home_team_id === focusTeamId ? m.home_team_name : m.away_team_name;

  const goalMarks = goalsUpTo.map((g, i) => {
    const x = (g.minute / lengthLabel) * W;
    const isFocusGoal =
      focusTeamId != null && g.team_id === focusTeamId
        ? !isAwayFocusMomentum
        : isAwayFocusMomentum;
    const y = isFocusGoal ? 8 : H - 8;
    const color = isFocusGoal ? GOLD : "rgba(27,37,48,0.55)";
    const note = g.extra_time ? ` ${t("match.etShort")}` : "";
    return { x, y, color, minute: g.minute, note, key: i };
  });

  const tick = (mmin: number, label: string) => {
    const x = (mmin / lengthLabel) * W;
    return (
      <g key={mmin}>
        <line x1={x} y1={0} x2={x} y2={H} stroke="rgba(27,37,48,0.15)" strokeWidth="1" />
        <text x={x + 3} y={H - 2} fill="rgba(27,37,48,0.5)" fontSize="9">
          {label}
        </text>
      </g>
    );
  };

  // The goals are listed newest first, the newest on top.
  const goalsSorted = useMemo(
    () =>
      goalsUpTo
        .map((g, i) => ({ g, i }))
        .sort((a, b) => b.g.minute - a.g.minute || b.i - a.i),
    [goalsUpTo],
  );

  const resultLabel = m.extra_time || m.penalties ? (
    (m.extra_time ? ` · ${t("match.aet")}` : "") +
    (m.penalties
      ? ` · ${t("match.pensScore", {
          home: m.penalties.home_score,
          away: m.penalties.away_score,
        })}`
      : "")
  ) : null;

  const flagName = (n: string) => [flagFor(n), country(n)].filter(Boolean).join(" ");

  return (
    <div className="live-modal">
      <div className="live-box">
      <div className="live-head">
        <span className="live-stage">
          {stage(m.stage_name)} · {t("match.day", { day: m.day })}
        </span>
        <button className="live-ff" onClick={() => onFF(m)}>
          ⏩ {t("hub.ff")}
        </button>
      </div>

      <div className="match-vs">
        <div className={"vs-team" + (m.home_team_id === focusTeamId ? " focus" : "")}>
          <span className="vs-name">{flagName(m.home_team_name)}</span>
          <span className="vs-score">{homeGoals}</span>
        </div>
        <div className="vs-dash">–</div>
        <div className={"vs-team" + (m.away_team_id === focusTeamId ? " focus" : "")}>
          <span className="vs-name">{flagName(m.away_team_name)}</span>
          <span className="vs-score">{awayGoals}</span>
        </div>
      </div>
      <p className="match-label">
        {done ? (
          resultLabel
        ) : (
          <span className="match-clock">{min}'</span>
        )}
      </p>

      {momentum && series && series.length > 0 && (
        <div className="chart-card">
          <div className="chart-head">
            <span className="chart-title">
              {t("match.momentum", { team: flagName(focusName) })}
            </span>
            <span className="chart-legend">
              <span className="dot" style={{ background: UP }}></span>
              {t("match.we")}
              <span className="dot" style={{ background: DOWN }}></span>
              {t("match.opp")}
            </span>
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} className="momentum" preserveAspectRatio="none">
            <line
              x1={0}
              y1={midY}
              x2={W}
              y2={midY}
              stroke="rgba(27,37,48,0.35)"
              strokeWidth="1.5"
              strokeDasharray="6 5"
              vectorEffect="non-scaling-stroke"
            />
            {tick(0, "0'")}
            {tick(45, t("match.ht"))}
            {tick(90, m.extra_time ? "90'" : t("match.ft"))}
            {m.extra_time && tick(120, t("match.ft"))}
            {done ? null : tick(Math.min(min, lengthLabel), min === 0 ? "" : `${min}'`)}
            {bars.map((b) => (
              <rect
                key={b.m}
                className={"mom-bar " + (b.up ? "up" : "down")}
                x={b.x - bw / 2 + 1}
                y={b.up ? midY - b.h : midY}
                width={Math.max(1, bw - 2)}
                height={b.h}
                rx={1.5}
                fill={b.up ? UP : DOWN}
              />
            ))}
            {goalMarks.map(({ x, y, color, minute, note, key }) => (
              <g key={key}>
                <line
                  x1={x}
                  y1={y === 8 ? 13 : H - 13}
                  x2={x}
                  y2={y}
                  stroke={color}
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  opacity="0.6"
                />
                <circle cx={x} cy={y} r={4} fill={color} stroke="#fff" strokeWidth="1" />
                <text x={x + 7} y={y + 3} fill="rgba(27,37,48,0.8)" fontSize="10">
                  {minute}
                  {note}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}

      {goalsUpTo.length > 0 && (
        <div className="goals-card">
          <h3>{t("match.goals")}</h3>
          {goalsSorted.map(({ g, i }) => (
            <div key={i} className="goal-row">
              <span className="goal-min">{g.minute}'{g.extra_time ? ` ${t("match.etShort")}` : ""}</span>
              <span className="goal-scorer">
                {g.scorer}
                {g.assist ? <span className="dim"> · {t("match.assist", { name: g.assist })}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}