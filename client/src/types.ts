export interface Tournament {
  id: number;
  name: string;
  year: number;
  host: string;
  winner: string | null;
  ready: boolean;
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
  /** All positions the player can cover (primary first). */
  positions?: string[];
  shirt_number: number | null;
  overall: number;
  /** Player portrait/badge image URL (optional; cards fall back to a silhouette). */
  photo_url?: string | null;
  /** Market-style rating (0–100); drives the stars. Falls back to `overall`. */
  rating?: number;
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
  /** Slot -> player ids, one per occurrence in the formation's slot order
   *  (two "DF" slots take two ids). Missing slots are auto-filled by the server. */
  starting: Record<string, number[]>;
}

export const FORMATIONS: Record<string, readonly string[]> = {
  "5-3-2": ["GK", "RWB", "DF", "DF", "DF", "LWB", "DMF", "DMF", "AMF", "FW", "FW"],
  "5-4-1": ["GK", "RWB", "DF", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW"],
  "4-5-1": ["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "DMF", "LMF", "AMF", "FW"],
  "4-4-2": ["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW", "FW"],
  "4-3-3": ["GK", "RWB", "DF", "DF", "LWB", "DMF", "DMF", "AMF", "RFW", "FW", "LFW"],
  "3-5-2": ["GK", "DF", "DF", "DF", "RMF", "DMF", "DMF", "LMF", "AMF", "FW", "FW"],
  "3-4-3": ["GK", "DF", "DF", "DF", "RMF", "DMF", "LMF", "AMF", "RFW", "FW", "LFW"],
};

export const STRATEGIES: Strategy[] = ["defensive", "normal", "attacking"];

/** Slot list after the strategy tweak. A 3-4-3 reshapes its four-man midfield
 *  completely: defensive → 3 DMF + 1 AMF, normal → 1 DMF + 1 RMF + 1 LMF +
 *  1 AMF, attacking → 1 DMF + 3 AMF. Other formations use the generic swap
 *  (defensive: AMF → DMF, attacking: DMF → AMF). */
export function slotsFor(formation: string, strategy: Strategy): string[] {
  const slots = [...(FORMATIONS[formation] ?? FORMATIONS["4-4-2"])];
  if (formation === "3-4-3" && slots.length >= 8) {
    // Slots 4..8 are the midfield line after GK + three DF.
    const mid: string[] =
      strategy === "defensive"
        ? ["DMF", "DMF", "DMF", "AMF"]
        : strategy === "attacking"
          ? ["DMF", "AMF", "AMF", "AMF"]
          : ["RMF", "DMF", "LMF", "AMF"];
    slots.splice(4, 4, ...mid);
    return slots;
  }
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

/** Best effective rating a player brings among any of their positions. */
export function bestEffectiveIn(positions: string[], overall: number, slot: string): number {
  if (positions.length === 0) return effectiveIn("MF", overall, slot);
  let best = -Infinity;
  for (const pos of positions) {
    best = Math.max(best, effectiveIn(pos, overall, slot));
  }
  return best;
}

/** Positions a player can cover (granular string list). */
export function playerPositions(player: Player): string[] {
  if (player.positions && player.positions.length > 0) return player.positions;
  return [player.position];
}

/** Set of family codes for a list of positions. */
export function positionFamilies(positions: string[]): Set<"GK" | "DF" | "MF" | "FW"> {
  return new Set(positions.map(positionFamily));
}

// ---------------------------------------------------------------------------
// Full-run replay payloads (POST /api/tournaments/{id}/run)
// ---------------------------------------------------------------------------

export interface RunTeam {
  id: number;
  name: string;
  tla?: string;
  code?: string | null;
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
  scorer_photo?: string | null;
  assist_id: number | null;
  assist: string | null;
  assist_photo?: string | null;
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

/** Short display name: just the surname (cards show the last name only). */
export function playerSurname(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return parts[0];
  const last = parts[parts.length - 1];
  // Handle compound surnames with particles (de, del, van, von, di, da, do, etc.)
  const particles = ["de", "del", "de la", "van", "von", "di", "da", "do", "dos", "du"];
  const pLower = parts[0].toLowerCase();
  if (particles.includes(pLower)) {
    if (parts.length >= 2) return `${parts[0]} ${last}`;
    return last;
  }
  return last;
}

/** Full display name: shows "De Paul" instead of just "Paul". */
export function playerDisplayName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return parts[0];
  const particles = ["de", "del", "de la", "van", "von", "di", "da", "do", "dos", "du"];
  const pLower = parts[0].toLowerCase();
  if (particles.includes(pLower) && parts.length >= 2) {
    return `${parts[0]} ${parts[parts.length - 1]}`;
  }
  return name;
}

/** Number of stars (0..5) a rating maps to on cards. */
export function ratingStars(rating: number): number {
  if (rating >= 90) return 5;
  if (rating >= 82) return 4;
  if (rating >= 74) return 3;
  if (rating >= 66) return 2;
  if (rating >= 58) return 1;
  return 0;
}

/** ★★★☆☆ string for a star count (clamped 0..5). */
export function starsString(count: number): string {
  const n = Math.max(0, Math.min(5, Math.round(count)));
  return "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);
}
