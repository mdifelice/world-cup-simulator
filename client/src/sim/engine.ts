import { CAL, type Calibration, type ShotClass } from "./calibration";
import { mulberry32, poissonSample, weightedPick, type Rng } from "./random";
import { compositeRating, teamRating, type TeamRating } from "./ratings";
import type { MatchInput, MatchResult, SimGoal, SimPlayer } from "./types";

interface SideOutcome {
  shots: number;
  onTarget: number;
  goals: SimGoal[];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function playerFamily(pos: string): "GK" | "DF" | "MF" | "FW" {
  switch (pos) {
    case "GK":
      return "GK";
    case "CB":
    case "LB":
    case "RB":
    case "LWB":
    case "RWB":
      return "DF";
    case "LW":
    case "RW":
    case "ST":
    case "CF":
      return "FW";
    default:
      return "MF";
  }
}

function pickShooter(rng: Rng, players: SimPlayer[], w: Record<string, number>): SimPlayer {
  const weights = players.map((p) => Math.max(0, w[playerFamily(p.position)] ?? 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < players.length; i++) {
    r -= weights[i];
    if (r <= 0) return players[i];
  }
  return players[players.length - 1];
}

function bestForward(players: SimPlayer[]): SimPlayer | null {
  let best: SimPlayer | null = null;
  let bestR = -1;
  for (const p of players) {
    if (playerFamily(p.position) !== "FW") continue;
    const r = compositeRating(p.position, p.attrs);
    if (r > bestR) {
      bestR = r;
      best = p;
    }
  }
  return best;
}

function pickAssist(rng: Rng, players: SimPlayer[], shooterId: number, w: Record<string, number>): SimPlayer | null {
  const candidates = players.filter((p) => p.id !== shooterId);
  if (!candidates.length) return null;
  return pickShooter(rng, candidates, w);
}

function genSide(
  rng: Rng,
  side: "home" | "away",
  rating: TeamRating,
  opp: TeamRating,
  team: SimPlayer[],
  cals: Calibration,
): SideOutcome {
  const out: SideOutcome = { shots: 0, onTarget: 0, goals: [] };

  const penalty = rng() < cals.penaltyRatePerTeam;
  const attackPot = rating.attack / opp.defence;
  const midPot = rating.midfield / opp.midfield;
  const lambda = clamp(
    cals.shotsBase * Math.pow(attackPot, cals.attackExponent) * Math.pow(midPot, cals.midExponent),
    cals.shotsMin,
    cals.shotsMax,
  );
  const shots = poissonSample(rng, lambda);
  const total = penalty ? Math.max(1, shots) : shots;

  for (let i = 0; i < total; i++) {
    const isPenalty = penalty && i === 0;
    const minute = 1 + Math.floor(89 * Math.pow(rng(), cals.minutePower));

    let cls: ShotClass;
    let shooter: SimPlayer;
    if (isPenalty) {
      cls = "penalty";
      shooter = bestForward(team) ?? pickShooter(rng, team, cals.positionWeights);
    } else {
      cls = weightedPick(rng, cals.classWeights) as "six_yard" | "box" | "edge" | "long" | "set_piece";
      shooter = pickShooter(rng, team, cals.positionWeights);
    }

    out.shots++;

    let xg: number;
    if (isPenalty) {
      xg = cals.xgBase.penalty * (0.86 + 0.14 * rng());
    } else {
      const shooting = shooter.attrs.shooting ?? 60;
      const q = cals.qualityMin + (cals.qualityMax - cals.qualityMin) * rng();
      const tier = clamp(1 + (rating.attack - opp.defence) / 100, cals.minTierFactor, cals.maxTierFactor);
      const attMul = 0.8 + 0.35 * (shooting / 100);
      const defSupp = 0.9 + 0.2 * ((opp.defence + opp.gk) / 200);
      xg = clamp(
        cals.xgBase[cls] * q * tier * (attMul / defSupp) * cals.xgScale,
        0,
        cals.maxGoalProb,
      );
    }

    if (rng() < xg) {
      out.onTarget++;
      let assistId: number | null = null;
      let assistName: string | null = null;
      if (rng() < cals.assistRate) {
        const a = pickAssist(rng, team, shooter.id, cals.positionWeights);
        if (a) {
          assistId = a.id;
          assistName = a.name;
        }
      }
      out.goals.push({
        minute,
        side,
        type: isPenalty ? "penalty" : "open_play",
        scorer_id: shooter.id,
        scorer_name: shooter.name,
        assist_id: assistId,
        assist_name: assistName,
      });
    } else if (rng() < (isPenalty ? 0.6 : cals.onTargetProb)) {
      out.onTarget++;
    }
  }

  return out;
}

function scale(r: TeamRating, f: number): TeamRating {
  return { attack: r.attack * f, midfield: r.midfield * f, defence: r.defence * f, gk: r.gk };
}

/** One deterministic match between two setups. Same seed → same result. */
export function runMatch(input: MatchInput): MatchResult {
  const cals = CAL;
  const rng = mulberry32(input.seed);
  const homeR = scale(teamRating(input.home), cals.homeAdvantage);
  const awayR = teamRating(input.away);

  const home = genSide(rng, "home", homeR, awayR, input.home.players, cals);
  const away = genSide(rng, "away", awayR, homeR, input.away.players, cals);

  const goals = [...home.goals, ...away.goals].sort((a, b) => a.minute - b.minute);

  return {
    seed: input.seed,
    homeGoals: home.goals.length,
    awayGoals: away.goals.length,
    homeShots: home.shots,
    awayShots: away.shots,
    homeOnTarget: home.onTarget,
    awayOnTarget: away.onTarget,
    goals,
    goalMinutes: goals.map((g) => g.minute).sort((a, b) => a - b),
    homeGoalsByTeam: home.goals.map((g) => g.minute).sort((a, b) => a - b),
    awayGoalsByTeam: away.goals.map((g) => g.minute).sort((a, b) => a - b),
  };
}

export type { SimGoal, SimPlayer, Strategy } from "./types";