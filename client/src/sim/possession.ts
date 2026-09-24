/** Per-event possession engine.
 *
 * The match is simulated minute-by-minute as a series of player-vs-player
 * duels: an attacking team carries the ball through the pitch zones (build-up,
 * midfield, final third, penalty box) by winning pass / dribble contests, then
 * converts when a shot beats the keeper. Every contest is a roll pitting two
 * specific players (from their XI, adjusted by form/morale and the team's
 * formation/strategy shape) against each other, so tactics, sendings-off and
 * scoreboard changes visibly bend the flow minute by minute.
 *
 * The engine is pure: it only reads the two team shapes and draws from the
 * injected `unit()` random source, which keeps it deterministic under the same
 * per-match seed.
 */
import type { Strategy } from "../types";

export const clampN = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

export interface PlayerRow {
  id: number;
  name: string;
  position: string;
  overall: number;
  aggression?: number;
}

export interface ShapeInputs {
  id: number;
  name: string;
  xi: PlayerRow[];
  strategy: Strategy;
  formation: string;
  redMinute: number | null;
  form: number;
  morale: number;
  /** Team strength rating (0–100). Anchors a small per-player quality bonus so
   *  comfortably stronger teams bend duels their way without the raw squad
   *  spread dictating every contest. */
  rating: number;
}

export interface PlayShape {
  id: number;
  name: string;
  strategy: Strategy;
  formation: string;
  redMinute: number | null;
  gk: PlayerRow | null;
  df: PlayerRow[];
  mf: PlayerRow[];
  fw: PlayerRow[];
  outfield: PlayerRow[];
  dfAv: number;
  mfAv: number;
  fwAv: number;
  gkAv: number;
  /** Forward-leaning coefficient: attacking > 0, defensive < 0. */
  risk: number;
  /** Space conceded behind: attacking gives more room, defensive digs in. */
  space: number;
  /** Pressing intensity when defending in the opponent's half. */
  press: number;
  /** Deep block bias: higher means the team defends deeper / shoots from range. */
  deep: number;
}

const familyOf = (pos: string): "GK" | "DF" | "MF" | "FW" => {
  if (pos === "GK") return "GK";
  if (["CB", "LB", "RB", "RWB", "LWB"].includes(pos)) return "DF";
  if (["CDM", "CM", "CAM", "LM", "RM"].includes(pos)) return "MF";
  return "FW";
};

const shapeCoeffs = (s: Strategy) => {
  switch (s) {
    case "attacking":
      return { risk: 1.0, space: 0.16, press: 0.55, deep: 0.3 };
    case "defensive":
      return { risk: -0.75, space: -0.1, press: 0.24, deep: 0.9 };
    default:
      return { risk: 0, space: 0, press: 0.38, deep: 0.55 };
  }
};

const avg = (xs: PlayerRow[]): number =>
  xs.length ? xs.reduce((s, p) => s + p.overall, 0) / xs.length : 60;

/** Rating bonus per point of team rating above the 75 anchor. */
const RATING_BIAS = 0.45;

/** Build the play shape of a team from its XI and tactical choices. */
export function shapeOf(inp: ShapeInputs): PlayShape {
  const df: PlayerRow[] = [];
  const mf: PlayerRow[] = [];
  const fw: PlayerRow[] = [];
  let gk: PlayerRow | null = null;
  for (const p of inp.xi) {
    const copy: PlayerRow = {
      ...p,
      overall: clampN(
        p.overall + (inp.form - 0.5) * 4 + (inp.morale - 0.5) * 4 + (inp.rating - 75) * RATING_BIAS,
        30,
        99,
      ),
    };
    const fam = familyOf(p.position);
    if (fam === "GK") gk = copy;
    else if (fam === "DF") df.push(copy);
    else if (fam === "MF") mf.push(copy);
    else fw.push(copy);
  }
  const coeffs = shapeCoeffs(inp.strategy);
  return {
    id: inp.id,
    name: inp.name,
    strategy: inp.strategy,
    formation: inp.formation,
    redMinute: inp.redMinute,
    gk,
    df,
    mf,
    fw,
    outfield: [...df, ...mf, ...fw],
    dfAv: avg(df),
    mfAv: avg(mf),
    fwAv: avg(fw),
    gkAv: gk ? gk.overall : 60,
    ...coeffs,
  };
}

/** How an AI coach reacts to the scoreboard and the clock (focus team exempt). */
export function aiStrategy(
  diff: number,
  minute: number,
  haveRed: boolean,
): Strategy {
  if (haveRed) return "defensive";
  if (diff < 0) return minute >= 50 ? "attacking" : "normal";
  if (diff > 0) return minute >= 72 ? "defensive" : "normal";
  return "normal";
}

/** Rebuild the tactical coefficients of a shape (strategy switch mid-match). */
export function retune(shape: PlayShape, strategy: Strategy, redMinute: number | null): void {
  if (shape.strategy === strategy && shape.redMinute === redMinute) return;
  shape.strategy = strategy;
  shape.redMinute = redMinute;
  Object.assign(shape, shapeCoeffs(strategy));
}

export interface MinuteResult {
  /** Set when the minute ends with a goal (team id + shooter). */
  goal: { teamId: number; scorer: PlayerRow } | null;
  shots: number;
  /** Cumulative minute scoring rate for home (above 0.5 favours home). */
  homePts: number;
  awayPts: number;
}

const pick = (unit: () => number, rows: PlayerRow[], skip?: number): PlayerRow | null => {
  if (!rows.length) return null;
  let total = 0;
  const weights = rows.map((p) => {
    const w = p.overall + (p.aggression ?? 50) * 0.2;
    total += w;
    return w;
  });
  let roll = unit() * total;
  for (let i = 0; i < rows.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return rows[i].id === skip ? (rows[i + 1] ?? rows[i]) : rows[i];
  }
  const last = rows[rows.length - 1];
  return last && last.id === skip ? (rows[0] ?? last) : last;
};

/** Family bias for the player finishing an in-box move: forwards convert most
 *  chances, while a box-to-box arrival or a set-piece header keeps the scorer
 *  mix close to real football (≈ 62% FW / 28% MF / 10% DF across a 4-3-3).
 *  Combined with player quality so the nimble striker still draws the lion's
 *  share of a team's shots. */
const FINISH_W: Record<"GK" | "FW" | "MF" | "DF", number> = { GK: 0, FW: 1.0, MF: 0.5, DF: 0.14 };

/** Weighted shot-taker across the whole outfield (family bias × quality).
 *  Mirrors `pick`'s single-unit draw so the RNG stream per match is unchanged. */
const finisherFor = (unit: () => number, s: PlayShape): PlayerRow | null => {
  const rows = s.outfield;
  if (!rows.length) return null;
  let total = 0;
  const weights = rows.map((p) => {
    const w = (FINISH_W[familyOf(p.position)] ?? 0) * (p.overall + (p.aggression ?? 50) * 0.2);
    total += w;
    return w;
  });
  let roll = unit() * total;
  for (let i = 0; i < rows.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return rows[i];
  }
  return rows[rows.length - 1];
};

const D = (p: number): number => Math.max(0.15, Math.min(0.75, p));

/**
 * Quality deltas are damped so a one-sided team bends the flow instead of
 * breaking it. The raw spread of a real squad (a 90-rated striker against a
 * 55-rated keeper) would otherwise hand every duel to the stronger side and
 * turn balanced matches into basketball scores; the sqrt curve keeps big gaps
 * significant but saturating, so a mismatch reads like football (2x/3x the
 * goals), not an arcade blowout.
 */
const damp = (d: number): number => Math.sign(d) * Math.sqrt(Math.abs(d));

/** Fighter for the zone of a shape (build-up → midfield → attack → box). */
const fighterFor = (unit: () => number, s: PlayShape, z: number): PlayerRow | null => {
  if (z <= 1) return pick(unit, s.df.length ? s.df : s.outfield);
  if (z === 2) return pick(unit, s.mf.length ? s.mf : s.outfield);
  return pick(unit, s.fw.length ? s.fw : s.outfield);
};

/** Marker that presses the attacking player at a zone. */
const markerFor = (unit: () => number, s: PlayShape, z: number): PlayerRow | null => {
  if (z >= 3) return pick(unit, s.df.length ? s.df : s.outfield);
  if (z === 2) return pick(unit, s.mf.length ? s.mf : s.outfield);
  if (z === 1) return pick(unit, s.mf.length ? s.mf : s.outfield);
  return pick(unit, s.fw.length ? s.fw : s.outfield);
};

/** Simulate one minute of football between two shapes.
 *
 *  Each minute alternates a possession to both sides. A possession is a short
 *  chain of pass/dribble duels: winning duels moves the ball forward through
 *  the zones and, when the attacking side breaks into the box, ends in a shot.
 *  Losing a duel turns the ball over and the possession ends (no shot), which
 *  keeps shot counts and strike rates close to real football while the per-player
 *  duels still drive timing, momentum and sendings-off effects. */
export function simulateMinute(
  unit: () => number,
  home: PlayShape,
  away: PlayShape,
  minute: number,
): MinuteResult {
  let homePts = 0;
  let awayPts = 0;
  let shots = 0;
  let goal: MinuteResult["goal"] = null;
  const order = unit() < 0.5 ? [home, away] : [away, home];

  for (const atk of order) {
    if (goal) break;
    const def = atk.id === home.id ? away : home;
    const atkId = atk.id;
    const scoring = atkId === home.id ? (v: number) => (homePts += v) : (v: number) => (awayPts += v);
    const shortDef = def.redMinute != null && minute > def.redMinute;

    let z = 0;
    let inBox = false;
    for (let build = 0; build < 5 && !inBox; build++) {
      const fighter = fighterFor(unit, atk, z);
      const marker = markerFor(unit, def, z);
      if (!fighter || !marker) break;
      const markerVal =
        (z >= 3
          ? def.dfAv
          : z === 2
            ? def.mfAv
            : def.dfAv * 0.6 + def.mfAv * 0.4) + def.space * 18 + (shortDef ? 7 : 0);
      const atkVal = fighter.overall + atk.risk * 5;
      const pAdv = D(0.48 + damp(atkVal - markerVal) * 0.016);
      if (unit() < pAdv) {
        const jump = unit() < 0.14 + atk.risk * 0.06 ? 2 : 1;
        z = Math.min(4, z + jump);
        scoring(z);
        if (z >= 4) inBox = true;
      } else {
        // Turnover: a pressing side can win it straight back high in the box.
        if (z >= 2 && def.press > 0.45 && unit() < (def.press - 0.45) * 0.8) {
          z = 3;
          scoring(3);
          inBox = true;
        }
        break;
      }
    }

    if (!inBox) continue;

    // Shot in the box (from range when the block sits deep).
    const shooter = finisherFor(unit, atk);
    if (!shooter) continue;
    shots += 1;
    const gkOverall = def.gk ? def.gk.overall : def.gkAv;
    const fromRange = def.deep > 0.65 ? 1 : 0;
    const pGoal = Math.max(
      0.03,
      Math.min(
        0.28,
        0.085 +
          damp(shooter.overall - gkOverall) * 0.015 +
          atk.risk * 0.02 -
          fromRange * 0.05 +
          (shortDef ? 0.07 : 0),
      ),
    );
    scoring(3);
    if (unit() < pGoal) {
      goal = { teamId: atkId, scorer: shooter };
      scoring(8);
      break;
    }
  }

  return { goal, shots, homePts, awayPts };
}

/** Momentum sample (0..1; above 0.5 favours home) for a minute. */
export const momentumOf = (r: MinuteResult): number =>
  Math.max(0.08, Math.min(0.92, 0.5 + (r.homePts - r.awayPts) * 0.014));