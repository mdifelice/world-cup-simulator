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