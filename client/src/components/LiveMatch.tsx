import { useEffect, useImperativeHandle, useMemo, useRef, useState, useCallback, forwardRef } from "react";
import { flagFor, useI18n } from "../i18n";
import type { Goal, LiveEvent, LiveMatchControls, PenKick, RedCard, RunMatch } from "../types";

interface Props {
  match: RunMatch;
  focusTeamId: number | null;
  onReveal: (m: RunMatch) => void;
  onClose: () => void;
}

const UP = "#2da562";
const DOWN = "#c8443a";
const BASE_LIVE_MS = 150;
// Between penalty kicks the reveal pauses a beat, mirroring the minute-to-minute
// tick but long enough to read each outcome.
const PEN_MS = 900;
// Base pause duration at boundaries (HT, FT, ET) - adjusted by speed
const BASE_PAUSE_MS = 1000;

export const LiveMatch = forwardRef<LiveMatchControls, Props>(({
  match: m,
  focusTeamId,
  onReveal,
  onClose,
}, ref) => {
  const { t, stage, country, speed } = useI18n();

  // Live match tick interval adjusted by speed selector
  const LIVE_MS = BASE_LIVE_MS / speed;
  const PAUSE_MS = BASE_PAUSE_MS / speed;
  const addedHT = m.added_time_ht ?? 0;
  const addedFT = m.added_time_ft ?? 0;
  const addedET1 = m.added_time_et1 ?? 0;
  const addedET2 = m.added_time_et2 ?? 0;
  const regulationLength = 90 + addedHT + addedFT;
  const extraTimeLength = m.extra_time ? 30 + addedET1 + addedET2 : 0;
  const totalLength = regulationLength + extraTimeLength;

  // Clock label: show 45' until added time starts, then 45+1, 45+2...
  // Same for 90', 105', 120'
  const clockLabel = (n: number) => {
    if (n < 45) return `${n}'`;
    if (n === 45) return `${n}'`;
    if (n <= 45 + addedHT) return `45+${n - 45}'`;
    if (n < 90) return `${n}'`;
    if (n === 90) return `${n}'`;
    if (n <= 90 + addedFT) return `90+${n - 90}'`;
    if (!m.extra_time) return `${n}'`;
    if (n < 105) return `${n}'`;
    if (n === 105) return `${n}'`;
    if (n <= 105 + addedET1) return `105+${n - 105}'`;
    if (n < 120) return `${n}'`;
    if (n === 120) return `${n}'`;
    return `120+${n - 120}'`;
  };

  const stopBoundaryHT = 45 + addedHT;
  const stopBoundaryFT = 90 + addedFT;
  const stopBoundaryET1 = m.extra_time ? 105 + addedET1 : 0;
  const stopBoundaryET2 = m.extra_time ? 120 + addedET2 : 0;
  const [min, setMin] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  // The tick interval reads the pause flag from a ref so toggling the pause
  // state never re-runs the interval effect (which used to reset the clock and
  // cancel the pause — pressing Space "restarted" the match).
  const isPausedRef = useRef(false);
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  const pauseUntilRef = useRef(0);
  const halfPausedRef = useRef(false);

  const pause = useCallback(() => setIsPaused(true), []);
  const play = useCallback(() => setIsPaused(false), []);
  const togglePause = useCallback(() => setIsPaused(p => !p), []);
  const stepForward = useCallback(() => setMin(cur => Math.min(cur + 1, totalLength)), [totalLength]);
  const stepBackward = useCallback(() => setMin(cur => Math.max(cur - 1, 0)), []);

  useImperativeHandle(ref, () => ({
    pause,
    play,
    togglePause,
    stepForward,
    stepBackward,
    isPaused,
    currentMinute: min,
    totalLength,
  }), [min, totalLength, isPaused]);

  // Reset the timeline only when a new match mounts — never when the pause
  // state flips.
  useEffect(() => {
    setMin(0);
    pauseUntilRef.current = 0;
    halfPausedRef.current = false;
    setIsPaused(false);
    isPausedRef.current = false;
  }, [m.id]);

  useEffect(() => {
    const iv = setInterval(() => {
      setMin((cur) => {
        if (isPausedRef.current) return cur;
        const now = Date.now();
        if (now < pauseUntilRef.current) return cur;
        // Pause at each boundary (HT, FT, ET halves) for a beat
        const isBoundary = cur === stopBoundaryHT || cur === stopBoundaryFT || cur === stopBoundaryET1 || cur === stopBoundaryET2;
        if (isBoundary) {
          if (halfPausedRef.current) {
            halfPausedRef.current = false;
            return cur + 1;
          }
          pauseUntilRef.current = now + PAUSE_MS;
          halfPausedRef.current = true;
          return cur;
        }
        halfPausedRef.current = false;
        return cur >= totalLength ? cur : cur + 1;
      });
    }, LIVE_MS);
    return () => clearInterval(iv);
  }, [m.id, totalLength, stopBoundaryHT, stopBoundaryFT, stopBoundaryET1, stopBoundaryET2, LIVE_MS, PAUSE_MS]);

  const done = min >= totalLength;

  // Commit the result to the hub as soon as the match ends, but keep the dialog
  // open so the user can watch the final score and close it manually.
  useEffect(() => {
    if (!done) return;
    onReveal(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  // Shootout: once the match ends (added time included), pause 1s, then reveal
  // each penalty kick one by one in the incidents row.
  const kicks = m.penalties?.kicks ?? [];
  const [penShown, setPenShown] = useState(0);
  const [pensGo, setPensGo] = useState(false);

  useEffect(() => {
    setPenShown(0);
    setPensGo(false);
  }, [m.id]);

  useEffect(() => {
    if (!done || !m.penalties || kicks.length === 0) {
      setPensGo(false);
      return;
    }
    const t = setTimeout(() => setPensGo(true), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, m.id]);

  useEffect(() => {
    if (!pensGo || kicks.length === 0) return;
    if (penShown >= kicks.length) return;
    const t = setTimeout(() => setPenShown((c) => c + 1), PEN_MS);
    return () => clearTimeout(t);
  }, [pensGo, penShown, kicks.length]);

  // Hidden shortcut: Ctrl+Shift+F jumps the live match straight to full time
  // and, when the match ended in a shootout, reveals every kick at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setMin((cur) => (cur >= totalLength ? cur : totalLength));
        if (kicks.length > 0) {
          setPensGo(true);
          setPenShown(kicks.length);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [totalLength, kicks.length]);

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

  // Goals, cards and events share one timeline, newest first, ties by extra time then
  // goals before cards before events. Penalty shootout kicks are appended in a later
  // lane (130+) so they always sort on top once revealed. Photos and shirt numbers ride
  // along for the rows.
  type Incident =
    | { kind: "goal"; g: Goal }
    | { kind: "red"; r: RedCard }
    | { kind: "event"; e: LiveEvent }
    | { kind: "pen"; k: PenKick; idx: number };
  const incMin = (i: Incident) =>
    i.kind === "goal"
      ? i.g.minute
      : i.kind === "red"
        ? i.r.minute
        : i.kind === "event"
          ? i.e.minute
          : 130 + i.idx;
  const incET = (i: Incident) =>
    i.kind === "goal"
      ? i.g.extra_time
      : i.kind === "red"
        ? i.r.extra_time
        : i.kind === "event"
          ? i.e.extra_time
          : false;
  const incidents = useMemo(() => {
    const list: Incident[] = [
      ...(m.goals ?? []).map((g) => ({ kind: "goal" as const, g })),
      ...(m.reds ?? []).map((r) => ({ kind: "red" as const, r })),
      ...(m.events ?? [])
        .filter((e) => e.kind === "sub" || e.kind === "injury")
        .map((e) => ({ kind: "event" as const, e })),
      ...kicks.slice(0, penShown).map((k, idx) => ({ kind: "pen" as const, k, idx })),
    ];
    return list
      .filter((i) => (i.kind === "pen" ? true : incMin(i) <= min))
      .sort((a, b) => {
        const byMin = incMin(b) - incMin(a);
        if (byMin !== 0) return byMin;
        const byEt = Number(incET(b)) - Number(incET(a));
        if (byEt !== 0) return byEt;
        const kindOrder = { goal: 0, red: 1, event: 2, pen: 3 };
        return kindOrder[a.kind] - kindOrder[b.kind];
      });
  }, [m.goals, m.reds, m.events, min, kicks, penShown]);

  const W = 900;
  const H = 108;
  const midY = 52;
  const maxHalf = 18;
  const topLane = 14;
  const botLane = 90;
  const legendY = 104;

  // Fixed axis showing full 90 minutes (+ added time) from the start,
  // with a small right margin so the FT label isn't cut off.
  const marginRatio = 0.04; // 4% right margin for FT label
  const visTotal = regulationLength / (1 - marginRatio);
  const bw = W / visTotal;

  // Period boundary chrono positions (used for line placement)
  const baseSH = 90 + addedHT + addedFT;
  const HT_CHRONO = 45 + addedHT;
  const FT_CHRONO = 90 + addedHT + addedFT;
  const ET1_CHRONO = baseSH + 15 + addedET1;

  // Period line positions on the fixed axis with right margin:
  // - HT line at (45+addedHT) / visTotal
  // - FT line at (90+addedHT+addedFT) / visTotal
  // - ET1 line at (baseSH+15+addedET1) / visTotal
  // - Final FT line at totalLength / visTotal
  const htLine = HT_CHRONO / visTotal;
  const ftLine = FT_CHRONO / visTotal;
  const et1Line = m.extra_time ? ET1_CHRONO / visTotal : 0;
  const et2Line = m.extra_time ? totalLength / visTotal : 0;

  // Map a chart minute to an index of the momentum series. The engine only builds
  // samples for the regulation (90) or extra-time (120) minutes, so added-time
  // minutes borrow the last sample of their half, and the second-half and
  // extra-time samples are reached at the duration the clock walks through.
  const sampleAt = (mm: number): number => {
    if (!series) return 0;
    if (mm <= 0) return 0;
    if (mm <= 45) return mm - 1;
    if (mm <= 45 + addedHT) return 44;
    if (mm <= 90 + addedHT) return mm - 1 - addedHT;
    if (mm <= 90 + addedHT + addedFT) return 89;
    if (m.extra_time) {
      if (mm <= 105 + addedHT + addedFT) return mm - 1 - addedHT - addedFT;
      if (mm <= 105 + addedHT + addedFT + addedET1) return 104;
      if (mm <= 120 + addedHT + addedFT + addedET1) return mm - 1 - addedHT - addedFT - addedET1;
      return Math.min(119, series.length - 1);
    }
    return Math.min(mm - 1, series.length - 1);
  };

  // Chronological slot of an incident on the fixed axis. Minute values overlap
  // across halves (e.g. 46' can be a first-half added-time goal or a second-half
  // one), so the rare added-time goals in the overlapping range lean on the
  // position of their more common regular-play counterpart.
  const seqForMinute = (v: number, et: boolean): number => {
    if (!et) return v <= 45 ? v : v + addedHT;
    if (!m.extra_time) return v + addedHT;
    const baseSH = 90 + addedHT + addedFT;
    if (v <= 105 + addedET1) return baseSH + (v - 90);
    if (v <= 120) return baseSH + 15 + addedET1 + (v - 105);
    return baseSH + 30 + addedET1 + (v - 120);
  };

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
    for (let mm = 1; mm <= Math.min(min, totalLength); mm++) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, mm - ROLL); j < mm; j++) {
        sum += series[sampleAt(j)];
        n += 1;
      }
      const s = n > 0 ? sum / n : series[sampleAt(mm)];
      const d = s - 0.5;
      out.push({
        m: mm,
        x: ((mm - 0.5) / visTotal) * W,
        up: d >= 0,
        h: Math.max(1, Math.round(Math.abs(d) * 2 * maxHalf)),
      });
    }
    return out;
  }, [series, min, visTotal, W, maxHalf]);

  const isAwayFocusMomentum = momentum != null && focusTeamId === m.away_team_id;

  const goalMarks = goalsUpTo.map((g, i) => {
    const x = (seqForMinute(g.minute, g.extra_time) / visTotal) * W;
    const isFocusGoal =
      focusTeamId != null && g.team_id === focusTeamId
        ? !isAwayFocusMomentum
        : isAwayFocusMomentum;
    const y = isFocusGoal ? topLane : botLane;
    let note = g.extra_time ? ` ${t("match.etShort")}` : "";
    if (g.penalty) note += ` ${t("match.penShort")}`;
    return { x, y, minute: g.minute, note, key: i };
  });

  const redMarks = redsUpTo.map((r, i) => {
    const x = (seqForMinute(r.minute, r.extra_time) / visTotal) * W;
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

  const tick = (p: number, label: string) => {
    const x = p * W;
    return (
      <g key={p}>
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
      {m.extra_time ? t("match.aet") : ""}
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

  // Running shootout tally while the kicks are being revealed.
  const penLive = done && pensGo && m.penalties != null && penShown < m.penalties.kicks.length;
  const penShownHome = kicks
    .slice(0, penShown)
    .filter((k) => k.team_id === m.home_team_id && k.scored).length;
  const penShownAway = kicks
    .slice(0, penShown)
    .filter((k) => k.team_id === m.away_team_id && k.scored).length;

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
          penLive ? (
            <span className="pens">
              {t("match.pensLive", { home: penShownHome, away: penShownAway })}
            </span>
          ) : (
            resultLabel
          )
        ) : (
          <span className="match-clock">{clockLabel(min)}</span>
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
            {tick(htLine, t("match.ht"))}
            {tick(ftLine, m.extra_time ? "90'" : t("match.ft"))}
            {m.extra_time && tick(et1Line, "105'")}
            {m.extra_time && tick(et2Line, t("match.ft"))}
            {done
              ? null
              : tick(Math.min(min, visTotal) / visTotal, min === 0 ? "" : clockLabel(min))}
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
          {incidents.map((i, idx) => {
            const isEvent = i.kind === "event";
            const event = isEvent ? i.e : null;
            const isPen = i.kind === "pen";
            const pen = isPen ? i.k : null;
            const eventIcon = isEvent
              ? event!.kind === "tactics"
                ? "📋"
                : event!.kind === "strategy"
                  ? "🎯"
                  : event!.kind === "sub"
                    ? "🔄"
                    : "⚕️"
              : isPen
                ? pen!.scored
                  ? "⚽"
                  : pen!.saved
                    ? "🧤"
                    : "✕"
                : i.kind === "goal"
                  ? "⚽"
                  : "🟥";
            const eventClass = isEvent
              ? ` event-row event-${event!.kind}`
              : i.kind === "red"
                ? " red-row"
                : isPen
                  ? " pen-inc"
                  : "";
            const playerName = isEvent
              ? event!.kind === "sub"
                ? `${event!.out_player_number != null ? `${event!.out_player_number}. ` : ""}${event!.out_player} → ${event!.in_player_number != null ? `${event!.in_player_number}. ` : ""}${event!.in_player}`
                : event!.kind === "injury"
                  ? `${event!.out_player_number != null ? `${event!.out_player_number}. ` : ""}${event!.out_player} (${t("match.injury")})`
                  : event!.detail || event!.kind
              : isPen
                ? pen!.taker
                : i.kind === "goal"
                  ? i.g.scorer
                  : i.r.player;
            const playerNumber = undefined;
            const playerPhoto = isEvent
              ? event!.in_player_photo ?? event!.out_player_photo
              : isPen
                ? null
                : i.kind === "goal"
                  ? i.g.scorer_photo
                  : i.r.player_photo;
            const teamId = isEvent
              ? event!.team_id
              : isPen
                ? pen!.team_id
                : i.kind === "goal"
                  ? i.g.team_id
                  : i.r.team_id;
            return (
              <div key={idx} className={"goal-row" + eventClass}>
                <span className="goal-ball" aria-hidden>
                  {eventIcon}
                </span>
                {playerPhoto ? (
                  <img
                    className="goal-photo"
                    src={playerPhoto}
                    alt=""
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <span className="goal-photo goal-photo-fallback" aria-hidden>
                    <svg viewBox="0 0 24 24" width="24" height="24">
                      <circle cx="12" cy="8" r="4.5" fill="currentColor" opacity="0.85" />
                      <path
                        d="M3.5 20.5c1.4-4.2 4.6-6 8.5-6s7.1 1.8 8.5 6"
                        fill="currentColor"
                        opacity="0.85"
                      />
                    </svg>
                  </span>
                )}
                <span className="goal-player">
                  {playerNumber != null ? `${playerNumber}. ` : ""}
                  {playerName}
                  {i.kind === "goal" && i.g.own_goal ? (
                    <span className="og-badge">{t("match.ownGoal")}</span>
                  ) : null}
                  {i.kind === "goal" && i.g.penalty ? (
                    <span className="pen-badge">{t("match.penShort")}</span>
                  ) : null}
                  {isPen ? (
                    <span
                      className={
                        "pen-out " + (pen!.scored ? "ok" : pen!.saved ? "sv" : "no")
                      }
                    >
                      {pen!.scored
                        ? t("match.penScored")
                        : pen!.saved
                          ? t("match.penSaved")
                          : t("match.penMissed")}
                    </span>
                  ) : null}
                </span>
                {isEvent && event!.kind === "sub" && (
                  <span className="goal-assist">{t("match.substitution")}</span>
                )}
                <span className="goal-end">
                  <span className="goal-min">
                    {isPen ? `P${pen!.round}` : `${incMin(i)}'`}
                    {!isPen && incET(i) ? ` ${t("match.etShort")}` : ""}
                  </span>
                  <span className="goal-team">{teamFlag(teamId)}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
});