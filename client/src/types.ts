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
  "2-3-5": ["GK", "DF", "DF", "DMF", "DMF", "AMF", "RFW", "FW", "FW", "FW", "LFW"],
  "3-2-5": ["GK", "DF", "DF", "DF", "DMF", "DMF", "RFW", "FW", "FW", "FW", "LFW"],
  "4-2-4": ["GK", "RWB", "DF", "DF", "LWB", "DMF", "DMF", "RFW", "FW", "FW", "LFW"],
  "5-3-2": ["GK", "RWB", "DF", "DF", "DF", "LWB", "DMF", "DMF", "AMF", "FW", "FW"],
  "5-4-1": ["GK", "RWB", "DF", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW"],
  "4-5-1": ["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "DMF", "LMF", "AMF", "FW"],
  "4-4-2": ["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW", "FW"],
  "4-3-3": ["GK", "RWB", "DF", "DF", "LWB", "DMF", "DMF", "AMF", "RFW", "FW", "LFW"],
  "3-5-2": ["GK", "DF", "DF", "DF", "RMF", "DMF", "DMF", "LMF", "AMF", "FW", "FW"],
  "3-4-3": ["GK", "DF", "DF", "DF", "RMF", "DMF", "LMF", "AMF", "RFW", "FW", "LFW"],
};

/** Tactical eras: the default formation and the plausible set for each span.
 *  Mirrors the server's `era_formation` in detail.rs (defaults only). */
const ERAS: Array<{ max: number; default: string; allowed: string[] }> = [
  { max: 1954, default: "2-3-5", allowed: ["2-3-5", "3-2-5"] },
  { max: 1966, default: "4-2-4", allowed: ["2-3-5", "3-2-5", "4-2-4", "4-3-3"] },
  { max: 1974, default: "4-3-3", allowed: ["4-2-4", "4-3-3", "4-4-2"] },
  { max: 1998, default: "4-4-2", allowed: ["4-4-2", "4-3-3", "4-5-1", "5-3-2", "5-4-1", "3-5-2"] },
  { max: Infinity, default: "4-3-3", allowed: ["4-3-3", "4-4-2", "4-5-1", "5-3-2", "5-4-1", "3-5-2", "3-4-3"] },
];

function eraBucket(year: number) {
  return ERAS.find((e) => year > 0 && year <= e.max) ?? ERAS[0];
}

/** Tactical default for a given tournament year — older championships line up
 *  the way they actually did (WM/2-3-5, Brazil's 4-2-4, etc.). Mirrors the
 *  server's `era_formation` in detail.rs. */
export function eraFormation(year: number): string {
  return eraBucket(year).default;
}

/** The formations plausible for a tournament year, used to filter the lineup
 *  editor's chip grid (a 1930 run shouldn't offer a 5-man-back park-the-bus). */
export function eraFormations(year: number): string[] {
  return eraBucket(year).allowed;
}

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
  own_goal?: boolean;
  shirt_number?: number;
}

export interface Momentum {
  home: number[];
  away: number[];
}

export interface RedCard {
  minute: number;
  extra_time: boolean;
  team_id: number;
  player_id: number;
  player: string;
  player_photo?: string | null;
  shirt_number?: number;
}

/** A player out for this match, with the reason and total matches missed. */
export interface MatchBan {
  player_id: number;
  player: string;
  player_photo?: string | null;
  reason: "red" | "injury";
  matches: number;
}

/** One entry of the automatic live feed (tactics/strategy/sub/injury). */
export interface LiveEvent {
  minute: number;
  extra_time: boolean;
  kind: "tactics" | "strategy" | "sub" | "injury";
  team_id: number;
  detail?: string;
  out_player?: string | null;
  out_player_photo?: string | null;
  in_player?: string | null;
  in_player_photo?: string | null;
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
  reds?: RedCard[];
  unavailable?: number[];
  /** Real fixture date (group stage only; knockouts have none). */
  date?: string | null;
  momentum: Momentum | null;
  /** The focus team's banned players for this match, with match counts. */
  bans?: MatchBan[];
  /** Automatic live feed for the user's team's matches. */
  events?: LiveEvent[];
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
  photo?: string | null;
}

export interface TopScorer {
  player_id: number;
  name: string;
  team_id: number;
  team_name: string;
  position: string;
  goals: number;
  assists: number;
  photo?: string | null;
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
/** Nobiliary particles that are part of a surname (De Paul, Van Dijk, Di María). */
const SURNAME_PARTICLES = new Set([
  "de", "del", "della", "delle", "dello", "degli", "di", "da", "das", "do", "dos", "du",
  "van", "von", "der", "den", "ter", "te", "la", "le", "lo", "los", "las", "el", "al",
  "bin", "binti", "mac", "mc", "st", "saint", "sainte", "santa", "san", "ben", "af", "av",
  "o",
]);

function surnameStart(parts: string[]): number {
  let start = parts.length - 1;
  while (
    start > 0 &&
    SURNAME_PARTICLES.has(parts[start - 1].toLowerCase().replace(/\.$/, ""))
  ) {
    start--;
  }
  return start;
}

export function playerSurname(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? name;
  return parts.slice(surnameStart(parts)).join(" ");
}

/** Full display name: shows "De Paul" instead of just "Paul". */
export function playerDisplayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? name;
  if (surnameStart(parts) > 0) return parts.slice(surnameStart(parts)).join(" ");
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
