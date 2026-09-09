export interface Tournament {
  id: number;
  name: string;
  year: number;
  host: string;
  winner: string | null;
  start_date: string | null;
  end_date: string | null;
  shirt_numbers: boolean;
}

export interface Team {
  id: number;
  name: string;
  code: string | null;
  flag: string | null;
  rating: number;
  pedigree: number;
  home_support: number;
  form: number;
  morale: number;
}

export interface Participant extends Team {
  group_letter: string | null;
}

export const POSITIONS = [
  "GK",
  "CB",
  "LB",
  "RB",
  "LWB",
  "RWB",
  "CDM",
  "CM",
  "CAM",
  "LM",
  "RM",
  "LW",
  "RW",
  "ST",
  "CF",
] as const;

export interface Player {
  id: number;
  name: string;
  position: (typeof POSITIONS)[number] | string;
  shirt_number: number | null;
  overall: number;
}

export interface User {
  id: number;
  provider: string;
  provider_subject: string;
  display_name: string | null;
  email: string | null;
}

/** Maps a granular position to the coarse family used by formations/slots. */
export function positionFamily(pos: string): "GK" | "DF" | "MF" | "FW" {
  switch (pos) {
    case "GK":
      return "GK";
    case "CB":
    case "LB":
    case "RB":
    case "LWB":
    case "RWB":
      return "DF";
    case "CDM":
    case "CM":
    case "CAM":
    case "LM":
    case "RM":
      return "MF";
    case "LW":
    case "RW":
    case "ST":
    case "CF":
      return "FW";
    default:
      return "MF";
  }
}

// ---------------------------------------------------------------------------
// Formations, strategies and slot compatibility (mirror of server/src/models.rs)
// ---------------------------------------------------------------------------

export type Strategy = "defensive" | "normal" | "attacking";

export interface LineupConfig {
  formation: string;
  strategy: Strategy;
  /** Slot -> player id (missing slots are auto-filled by the server). */
  starting: Record<string, number>;
}

export const SLOTS = [
  "GK",
  "DF",
  "RWB",
  "LWB",
  "DMF",
  "RMF",
  "LMF",
  "AMF",
  "FW",
  "RFW",
  "LFW",
] as const;

export const FORMATIONS: Record<string, readonly string[]> = {
  "5-3-2": ["GK", "RWB", "DF", "DF", "DF", "LWB", "DMF", "DMF", "AMF", "FW", "FW"],
  "5-4-1": ["GK", "RWB", "DF", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW"],
  "4-5-1": ["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "DMF", "LMF", "AMF", "FW"],
  "4-4-2": ["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW", "FW"],
  "4-3-3": ["GK", "RWB", "DF", "DF", "LWB", "DMF", "DMF", "AMF", "RFW", "FW", "LFW"],
  "3-5-2": ["GK", "DF", "DF", "DF", "RMF", "DMF", "DMF", "LMF", "AMF", "FW", "FW"],
  "3-4-3": ["GK", "DF", "DF", "DF", "RMF", "DMF", "DMF", "AMF", "RFW", "FW", "LFW"],
};

export const STRATEGIES: Strategy[] = ["defensive", "normal", "attacking"];

/** Slot list after the strategy tweak (defensive: AMF → DMF, attacking: DMF → AMF). */
export function slotsFor(formation: string, strategy: Strategy): string[] {
  const slots = [...(FORMATIONS[formation] ?? FORMATIONS["4-4-2"])];
  if (strategy === "defensive") {
    const i = slots.indexOf("AMF");
    if (i >= 0) slots[i] = "DMF";
  } else if (strategy === "attacking") {
    const i = slots.lastIndexOf("DMF");
    if (i >= 0) slots[i] = "AMF";
  }
  return slots;
}

function slotFamily(slot: string): "GK" | "DF" | "MF" | "FW" {
  if (slot === "GK") return "GK";
  if (slot === "DF" || slot === "RWB" || slot === "LWB") return "DF";
  if (slot === "FW" || slot === "RFW" || slot === "LFW") return "FW";
  return "MF";
}

/** (slot, penalty]) pairs a granular position covers naturally (mirrors the server). */
const POSITION_SLOTS: Record<string, [string, number][]> = {
  GK: [["GK", 0]],
  CB: [["DF", 0], ["LWB", 3], ["RWB", 3]],
  LB: [["LWB", 0], ["DF", 1], ["LMF", 2]],
  RB: [["RWB", 0], ["DF", 1], ["RMF", 2]],
  LWB: [["LWB", 0], ["LMF", 1], ["DF", 2], ["RWB", 4]],
  RWB: [["RWB", 0], ["RMF", 1], ["DF", 2], ["LWB", 4]],
  CDM: [["DMF", 0], ["AMF", 4], ["DF", 6]],
  CM: [["AMF", 0], ["DMF", 1], ["RMF", 1], ["LMF", 1]],
  CAM: [["AMF", 0], ["RMF", 3], ["LMF", 3], ["FW", 4], ["DMF", 5]],
  LM: [["LMF", 0], ["LFW", 1], ["AMF", 3], ["RMF", 3]],
  RM: [["RMF", 0], ["RFW", 1], ["AMF", 3], ["LMF", 3]],
  LW: [["LFW", 0], ["LMF", 1], ["FW", 2], ["RFW", 2]],
  RW: [["RFW", 0], ["RMF", 1], ["FW", 2], ["LFW", 2]],
  ST: [["FW", 0], ["RFW", 1], ["LFW", 1]],
  CF: [["FW", 0], ["RFW", 1], ["LFW", 1], ["AMF", 4]],
};

/** Out-of-position penalty index for a player (granular position) in a slot. */
export function slotPenalty(position: string, slot: string): number {
  for (const [s, p] of POSITION_SLOTS[position] ?? []) {
    if (s === slot) return p;
  }
  if (position === "GK" || slot === "GK") return 10;
  if (positionFamily(position) === slotFamily(slot)) return 6;
  return 9;
}

/** Effective (post-penalty) rating a player brings to a slot. */
export function effectiveIn(position: string, overall: number, slot: string): number {
  return overall - slotPenalty(position, slot) * 2;
}

// ---------------------------------------------------------------------------
// Full-run replay payloads (POST /api/tournaments/{id}/run)
// ---------------------------------------------------------------------------

export interface RunTeam {
  id: number;
  name: string;
}

export interface GroupInfo {
  name: string;
  teams: RunTeam[];
}

export interface PenKick {
  round: number;
  team_id: number;
  taker: string;
  scored: boolean;
}

export interface PenResult {
  home_score: number;
  away_score: number;
  winner_id: number;
  sudden_death: boolean;
  kicks: PenKick[];
}

export interface Goal {
  minute: number;
  extra_time: boolean;
  team_id: number;
  scorer_id: number;
  scorer: string;
  assist_id: number | null;
  assist: string | null;
}

export interface Momentum {
  home: number[];
  away: number[];
}

export interface RunMatch {
  id: number;
  day: number;
  stage_key: string;
  stage_name: string;
  home_team_id: number;
  away_team_id: number;
  home_team_name: string;
  away_team_name: string;
  home_score: number;
  away_score: number;
  extra_time: boolean;
  penalties: PenResult | null;
  result_label: string;
  goals: Goal[];
  momentum: Momentum | null;
}

export interface PlayerAward {
  player_id: number;
  name: string;
  team_id: number;
  team_name: string;
  position: string;
  games: number;
  goals: number;
  assists: number;
  score: number;
}

export interface TopScorer {
  player_id: number;
  name: string;
  team_id: number;
  team_name: string;
  position: string;
  goals: number;
  assists: number;
}

export interface Awards {
  golden: PlayerAward | null;
  silver: PlayerAward | null;
  bronze: PlayerAward | null;
  top_scorers: TopScorer[];
}

export interface RunPayload {
  run_id: number | null;
  tournament_id: number;
  tournament_name: string;
  year: number;
  host: string;
  shirt_numbers: boolean;
  focus_team_id: number | null;
  /** Deterministic base seed; echo it back when re-running with lineups. */
  seed: number;
  order: number[];
  matches: RunMatch[];
  groups: GroupInfo[];
  awards: Awards;
  champion: string | null;
}

export interface RunListItem {
  id: number;
  tournament_id: number;
  tournament_name: string;
  year: number;
  champion: string | null;
  created_at: string;
}