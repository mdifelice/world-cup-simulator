import { useEffect, useMemo, useRef, useState } from "react";
import { flagFor, useI18n } from "../i18n";
import type { Goal, RedCard, RunMatch } from "../types";

interface Props {
  match: RunMatch;
  focusTeamId: number | null;
  onReveal: (m: RunMatch) => void;
  onClose: () => void;
}

const UP = "#2da562";
const DOWN = "#c8443a";
const LIVE_MS = 150;

export default function LiveMatch({
  match: m,
  focusTeamId,
  onReveal,
  onClose,
}: Props) {
  const { t, stage, country } = useI18n();

  const lengthLabel = m.extra_time ? 120 : 90;
  const [min, setMin] = useState(0);
  const pauseUntilRef = useRef(0);
  const halfPausedRef = useRef(false);

  useEffect(() => {
    setMin(0);
    pauseUntilRef.current = 0;
    halfPausedRef.current = false;
    const iv = setInterval(() => {
      setMin((cur) => {
        const now = Date.now();
        if (now < pauseUntilRef.current) return cur;
        // Pause once at half-time (45' or 90' in extra time) for a beat, then
        // advance on the first tick after the pause expires.
        const isHalf = (cur === 45 && lengthLabel === 90) || (cur === 90 && lengthLabel === 120);
        if (isHalf) {
          if (halfPausedRef.current) {
            halfPausedRef.current = false;
            return cur + 1;
          }
          pauseUntilRef.current = now + 1000; // 1 second pause
          halfPausedRef.current = true;
          return cur;
        }
        halfPausedRef.current = false;
        return cur >= lengthLabel ? cur : cur + 1;
      });
    }, LIVE_MS);
    return () => clearInterval(iv);
  }, [m.id, lengthLabel]);

  const done = min >= lengthLabel;

  // Commit the result to the hub as soon as the match ends, but keep the dialog
  // open so the user can watch the final score and close it manually.
  useEffect(() => {
    if (!done) return;
    onReveal(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  // Hidden shortcut: Ctrl+Shift+F jumps the live match straight to full time.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setMin((cur) => (cur >= lengthLabel ? cur : lengthLabel));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lengthLabel]);

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

  const redsUpTo = useMemo(
    () => (m.reds ?? []).filter((r) => r.minute <= min),
    [m.reds, min],
  );

  // Goals and cards share one timeline, newest first, ties by extra time then
  // goals before cards. Photos and shirt numbers ride along for the rows.
  type Incident =
    | { kind: "goal"; g: Goal }
    | { kind: "red"; r: RedCard };
  const incName = (i: Incident) => (i.kind === "goal" ? i.g.scorer : i.r.player);
  const incPhoto = (i: Incident) =>
    i.kind === "goal" ? i.g.scorer_photo : i.r.player_photo;
  const incNumber = (i: Incident) =>
    i.kind === "goal" ? i.g.shirt_number : i.r.shirt_number;
  const incMin = (i: Incident) => (i.kind === "goal" ? i.g.minute : i.r.minute);
  const incET = (i: Incident) => (i.kind === "goal" ? i.g.extra_time : i.r.extra_time);
  const incidents = useMemo(() => {
    const list: Incident[] = [
      ...(m.goals ?? []).map((g) => ({ kind: "goal" as const, g })),
      ...(m.reds ?? []).map((r) => ({ kind: "red" as const, r })),
    ];
    return list.filter((i) => incMin(i) <= min).sort((a, b) => {
      const byMin = incMin(b) - incMin(a);
      if (byMin !== 0) return byMin;
      const byEt = Number(incET(b)) - Number(incET(a));
      if (byEt !== 0) return byEt;
      return a.kind === "red" ? 1 : -1;
    });
  }, [m.goals, m.reds, min]);

  const W = 900;
  const H = 108;
  const midY = 52;
  const maxHalf = 18;
  const topLane = 14;
  const botLane = 90;
  const legendY = 104;
  const bw = W / lengthLabel;

  // The chart is stretched to the dialog width (preserveAspectRatio="none"), so
  // its text would be distorted. Counter-scale it back to a natural aspect.
  const svgRef = useRef<SVGSVGElement>(null);
  const [textSx, setTextSx] = useState(1);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth || W;
      const h = el.clientHeight || H;
      setTextSx(h / H / (w / W));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bars = useMemo(() => {
    if (!series || series.length === 0) return [] as { m: number; x: number; up: boolean; h: number }[];
    const out: { m: number; x: number; up: boolean; h: number }[] = [];
    // Each bar summarises the momentum of the last minute rather than a single
    // sample, smoothing the chart while keeping goal spikes visible.
    const ROLL = 1;
    for (let mm = 1; mm <= Math.min(min, lengthLabel); mm++) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, mm - ROLL); j < mm; j++) {
        sum += series[Math.min(j, series.length - 1)];
        n += 1;
      }
      const s = n > 0 ? sum / n : series[Math.min(mm - 1, series.length - 1)];
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

  const goalMarks = goalsUpTo.map((g, i) => {
    const x = (g.minute / lengthLabel) * W;
    const isFocusGoal =
      focusTeamId != null && g.team_id === focusTeamId
        ? !isAwayFocusMomentum
        : isAwayFocusMomentum;
    const y = isFocusGoal ? topLane : botLane;
    const note = g.extra_time ? ` ${t("match.etShort")}` : "";
    return { x, y, minute: g.minute, note, key: i };
  });

  const redMarks = redsUpTo.map((r, i) => {
    const x = (r.minute / lengthLabel) * W;
    const isFocusRed =
      focusTeamId != null && r.team_id === focusTeamId
        ? !isAwayFocusMomentum
        : isAwayFocusMomentum;
    const y = isFocusRed ? topLane : botLane;
    const note = r.extra_time ? ` ${t("match.etShort")}` : "";
    return { x, y, minute: r.minute, note, key: i };
  });

  // Continuous momentum gauge: the home team's live dominance (-1 away … +1
  // home) drives a green centre fill that always moves with the series.
  const gauge = useMemo(() => {
    if (!momentum || momentum.home.length === 0) return 0;
    const idx = Math.min(Math.max(min, 1), momentum.home.length) - 1;
    const v = (momentum.home[idx] - 0.5) * 2;
    return Math.max(-1, Math.min(1, v));
  }, [momentum, min]);

  const yourLead = focusTeamId === m.home_team_id ? gauge >= 0 : gauge <= 0;

  const tick = (mmin: number, label: string) => {
    const x = (mmin / lengthLabel) * W;
    return (
      <g key={mmin}>
        <line x1={x} y1={0} x2={x} y2={H} stroke="rgba(27,37,48,0.15)" strokeWidth="1" />
        <text
          transform={`translate(${x + 3} ${legendY}) scale(${textSx} 1)`}
          fill="rgba(27,37,48,0.5)"
          fontSize="9"
        >
          {label}
        </text>
      </g>
    );
  };

  // The goals are listed newest first, the newest on top.

  const resultLabel = m.extra_time || m.penalties ? (
    <>
      {m.extra_time ? ` · ${t("match.aet")}` : ""}
      {m.penalties ? (
        <span className="pens">
          {" · "}
          {t("match.pensScore", {
            home: m.penalties.home_score,
            away: m.penalties.away_score,
          })}
        </span>
      ) : null}
    </>
  ) : null;

  const flagName = (n: string) => [flagFor(n), country(n)].filter(Boolean).join(" ");
  const teamFlag = (teamId: number) =>
    flagFor(teamId === m.home_team_id ? m.home_team_name : m.away_team_name);

  return (
    <div className="live-modal">
      <div className="live-box">
      <div className="live-head">
        <span className="live-stage">{stage(m.stage_name)}</span>
        {done && (
          <button
            className="live-x"
            onClick={onClose}
            aria-label={t("match.close")}
            title={t("match.close")}
          >
            ✕
          </button>
        )}
      </div>

      <div className="match-vs">
        <div className={"vs-team" + (m.home_team_id === focusTeamId ? " focus" : "")}>
          <span className="vs-name">{flagName(m.home_team_name)}</span>
          <span
            key={`h${homeGoals}`}
            className={"vs-score" + (homeGoals > 0 ? " bump" : "")}
          >
            {homeGoals}
          </span>
        </div>
        <div className="vs-dash">–</div>
        <div className={"vs-team" + (m.away_team_id === focusTeamId ? " focus" : "")}>
          <span className="vs-name">{flagName(m.away_team_name)}</span>
          <span
            key={`a${awayGoals}`}
            className={"vs-score" + (awayGoals > 0 ? " bump" : "")}
          >
            {awayGoals}
          </span>
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
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="momentum"
            preserveAspectRatio="none"
          >
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
            {goalMarks.map(({ x, y, minute, note, key }) => (
              <g key={key}>
                <line
                  x1={x}
                  y1={y < midY ? midY - maxHalf : midY + maxHalf}
                  x2={x}
                  y2={y}
                  stroke="rgba(27,37,48,0.5)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  opacity="0.6"
                />
                <text
                  transform={`translate(${x} ${y}) scale(${textSx} 1)`}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="10"
                >
                  ⚽
                </text>
                <text
                  transform={`translate(${x + 17} ${y + 3}) scale(${textSx} 1)`}
                  fill="rgba(27,37,48,0.8)"
                  fontSize="10"
                >
                  {minute}
                  {note}
                </text>
              </g>
            ))}
            {redMarks.map(({ x, y, minute, note, key }) => (
              <g key={`r${key}`}>
                <line
                  x1={x}
                  y1={y < midY ? midY - maxHalf : midY + maxHalf}
                  x2={x}
                  y2={y}
                  stroke="rgba(200,67,61,0.55)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  opacity="0.7"
                />
                <rect
                  x={x - 2.5}
                  y={y - 5}
                  width={5}
                  height={10}
                  rx={1.2}
                  fill={DOWN}
                />
                <text
                  transform={`translate(${x - 7} ${y + 3}) scale(${textSx} 1)`}
                  textAnchor="end"
                  fill="rgba(27,37,48,0.8)"
                  fontSize="10"
                >
                  {minute}
                  {note}
                </text>
              </g>
            ))}
          </svg>

          <div className="mom-gauge">
            <div className="mg-track">
              <div className="mg-mid" />
              <div
                className="mg-fill"
                style={{
                  left: gauge >= 0 ? `${50 - gauge * 50}%` : "50%",
                  width: `${Math.abs(gauge) * 50}%`,
                  background: yourLead ? UP : DOWN,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {incidents.length > 0 && (
        <div className="goals-card">
          {incidents.map((i, idx) => (
            <div
              key={idx}
              className={"goal-row" + (i.kind === "red" ? " red-row" : "")}
            >
              <span className="goal-ball" aria-hidden>
                {i.kind === "goal" ? "⚽" : "🟥"}
              </span>
              {incPhoto(i) ? (
                <img
                  className="goal-photo"
                  src={incPhoto(i)!}
                  alt=""
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : null}
              <span className="goal-player">
                {incNumber(i) != null ? `${incNumber(i)} - ` : ""}
                {incName(i)}
                {i.kind === "goal" && i.g.own_goal ? (
                  <span className="og-badge">{t("match.ownGoal")}</span>
                ) : null}
              </span>
              {i.kind === "goal" && i.g.assist ? (
                <span className="goal-assist">
                  · {t("match.assist", { name: i.g.assist })}
                </span>
              ) : null}
              <span className="goal-end">
                <span className="goal-min">
                  {incMin(i)}'
                  {incET(i) ? ` ${t("match.etShort")}` : ""}
                </span>
                <span className="goal-team">{teamFlag(i.kind === "goal" ? i.g.team_id : i.r.team_id)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
