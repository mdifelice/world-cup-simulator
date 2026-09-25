import type { TeamSetup } from "./types";
import { slotsFor } from "../types";

/** Position-weighted overall rating, mirror of server/src/sim.rs position_weights. */
const WEIGHTS: Record<string, [string, number][]> = {
  GK: [["reflexes", 0.22], ["handling", 0.18], ["aerial", 0.15], ["positioning", 0.2], ["composure", 0.25], ["decisions", 0.05], ["concentration", 0.06], ["leadership", 0.04]],
  CB: [["tackling", 0.3], ["positioning", 0.2], ["strength", 0.2], ["pace", 0.1], ["composure", 0.1], ["passing", 0.1], ["decisions", 0.06], ["aggression", 0.05], ["concentration", 0.07], ["leadership", 0.04]],
  LB: [["stamina", 0.2], ["pace", 0.2], ["tackling", 0.2], ["positioning", 0.15], ["passing", 0.15], ["dribbling", 0.1], ["decisions", 0.05], ["aggression", 0.04], ["concentration", 0.06]],
  RB: [["stamina", 0.2], ["pace", 0.2], ["tackling", 0.2], ["positioning", 0.15], ["passing", 0.15], ["dribbling", 0.1], ["decisions", 0.05], ["aggression", 0.04], ["concentration", 0.06]],
  CDM: [["tackling", 0.28], ["passing", 0.2], ["positioning", 0.2], ["stamina", 0.12], ["composure", 0.12], ["vision", 0.08], ["decisions", 0.06], ["aggression", 0.07], ["concentration", 0.06], ["leadership", 0.05]],
  CM: [["passing", 0.3], ["vision", 0.2], ["stamina", 0.15], ["composure", 0.15], ["dribbling", 0.1], ["tackling", 0.1], ["decisions", 0.07], ["concentration", 0.05], ["leadership", 0.05]],
  CAM: [["passing", 0.25], ["vision", 0.25], ["dribbling", 0.2], ["composure", 0.15], ["stamina", 0.15], ["decisions", 0.07], ["concentration", 0.05]],
  LM: [["pace", 0.2], ["dribbling", 0.2], ["passing", 0.2], ["stamina", 0.15], ["vision", 0.15], ["shooting", 0.1], ["decisions", 0.05], ["concentration", 0.05]],
  RM: [["pace", 0.2], ["dribbling", 0.2], ["passing", 0.2], ["stamina", 0.15], ["vision", 0.15], ["shooting", 0.1], ["decisions", 0.05], ["concentration", 0.05]],
  LW: [["pace", 0.25], ["dribbling", 0.25], ["shooting", 0.2], ["passing", 0.1], ["composure", 0.1], ["vision", 0.1], ["decisions", 0.04], ["concentration", 0.04]],
  RW: [["pace", 0.25], ["dribbling", 0.25], ["shooting", 0.2], ["passing", 0.1], ["composure", 0.1], ["vision", 0.1], ["decisions", 0.04], ["concentration", 0.04]],
  ST: [["shooting", 0.3], ["pace", 0.2], ["dribbling", 0.15], ["positioning", 0.15], ["strength", 0.1], ["composure", 0.1], ["decisions", 0.07], ["concentration", 0.05], ["leadership", 0.03]],
  CF: [["shooting", 0.3], ["pace", 0.2], ["dribbling", 0.15], ["positioning", 0.15], ["strength", 0.1], ["composure", 0.1], ["decisions", 0.07], ["concentration", 0.05], ["leadership", 0.03]],
};

export const GK_DAMP = 3;

export function compositeRating(position: string, attrs: Record<string, number>): number {
  if (position === "GK") {
    // Keeper overall is the damped plain shot-stopping mean (mirror of server:
    // composite_rating uses gk_plain_mean, not the weighted GK list, so
    // world-class keepers land ~88 instead of a ~+4.5-inflated 95.7).
    const f = ["reflexes", "handling", "kicking", "positioning", "composure", "aerial", "strength", "pace", "decisions", "concentration", "leadership"];
    return f.reduce((s, k) => s + (attrs[k] ?? 60), 0) / f.length - GK_DAMP;
  }
  const w = WEIGHTS[position] ?? [["passing", 0.4], ["vision", 0.3], ["composure", 0.3], ["decisions", 0.1], ["concentration", 0.1], ["leadership", 0.1]];
  let num = 0;
  let den = 0;
  for (const [k, weight] of w) {
    const v = attrs[k] ?? 60;
    num += v * weight;
    den += weight;
  }
  return den === 0 ? 60 : num / den;
}

const attrDef = (v: number | null | undefined): number => (typeof v === "number" ? v : 60);

/** Build the above attrs for a server player (any of our 18 may be null). */
export function attrsFromServer(p: {
  pace?: number | null;
  stamina?: number | null;
  strength?: number | null;
  dribbling?: number | null;
  passing?: number | null;
  shooting?: number | null;
  tackling?: number | null;
  vision?: number | null;
  positioning?: number | null;
  composure?: number | null;
  reflexes?: number | null;
  handling?: number | null;
  kicking?: number | null;
  aerial?: number | null;
  decisions?: number | null;
  aggression?: number | null;
  concentration?: number | null;
  leadership?: number | null;
}): Record<string, number> {
  return {
    pace: attrDef(p.pace),
    stamina: attrDef(p.stamina),
    strength: attrDef(p.strength),
    dribbling: attrDef(p.dribbling),
    passing: attrDef(p.passing),
    shooting: attrDef(p.shooting),
    tackling: attrDef(p.tackling),
    vision: attrDef(p.vision),
    positioning: attrDef(p.positioning),
    composure: attrDef(p.composure),
    reflexes: attrDef(p.reflexes),
    handling: attrDef(p.handling),
    kicking: attrDef(p.kicking),
    aerial: attrDef(p.aerial),
    decisions: attrDef(p.decisions),
    aggression: attrDef(p.aggression),
    concentration: attrDef(p.concentration),
    leadership: attrDef(p.leadership),
  };
}

export interface TeamRating {
  attack: number;
  midfield: number;
  defence: number;
  gk: number;
}

function avg(nums: number[]): number {
  if (!nums.length) return 60;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Reduce a squad + formation + strategy to four team powers.
 * Formation shape: more forwards raise attack, more defenders raise defence.
 * Strategy: attacking shifts pressure forward, defensive sits deeper.
 */
export function teamRating(t: TeamSetup): TeamRating {
  const gk = t.players.find((p) => p.position === "GK");
  const outfield = t.players.filter((p) => p.position !== "GK");

  const df = outfield.filter((p) => isFamily(p, "DF")).map((p) => compositeRating(p.position, p.attrs));
  const mf = outfield.filter((p) => isFamily(p, "MF")).map((p) => compositeRating(p.position, p.attrs));
  const fw = outfield.filter((p) => isFamily(p, "FW")).map((p) => compositeRating(p.position, p.attrs));

  const dfAvg = avg(df);
  const mfAvg = avg(mf);
  const fwAvg = avg(fw);

  const slots = slotsFor(t.formation, t.strategy);
  const fwSlots = slots.filter((s) => slotFam(s) === "FW").length;
  const mfSlots = slots.filter((s) => slotFam(s) === "MF").length;
  const dfSlots = slots.filter((s) => slotFam(s) === "DF").length;

  let attack = fw.length ? fwAvg * 0.75 + mfAvg * 0.25 : mfAvg;
  let midfield = mfAvg * 0.55 + fwAvg * 0.25 + dfAvg * 0.2;
  let defence = dfAvg * 0.65 + mfAvg * 0.25 + fwAvg * 0.1;

  attack *= 1 + (fwSlots - 2) * 0.035;
  defence *= 1 + (dfSlots - 4) * 0.02;
  midfield *= 1 + (mfSlots - 3) * 0.01;

  if (t.strategy === "attacking") {
    attack *= 1.06;
    midfield *= 1.02;
    defence *= 0.95;
  } else if (t.strategy === "defensive") {
    attack *= 0.94;
    midfield *= 0.98;
    defence *= 1.06;
  }

  return {
    attack: Math.max(1, attack),
    midfield: Math.max(1, midfield),
    defence: Math.max(1, defence),
    gk: gk ? compositeRating("GK", gk.attrs) : 60,
  };
}

function isFamily(p: { position: string }, fam: "DF" | "MF" | "FW"): boolean {
  switch (p.position) {
    case "CB":
    case "LB":
    case "RB":
      return fam === "DF";
    case "CDM":
    case "CM":
    case "CAM":
    case "LM":
    case "RM":
      return fam === "MF";
    case "LW":
    case "RW":
    case "ST":
    case "CF":
      return fam === "FW";
    default:
      return fam === "MF";
  }
}

function slotFam(slot: string): "GK" | "DF" | "MF" | "FW" {
  if (slot === "GK") return "GK";
  if (slot === "FW" || slot === "RFW" || slot === "LFW") return "FW";
  if (slot === "DF" || slot === "RWB" || slot === "LWB") return "DF";
  return "MF";
}