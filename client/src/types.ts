export interface Tournament {
  id: number;
  name: string;
  year: number;
  host: string;
  winner: string | null;
  start_date: string | null;
  end_date: string | null;
}

export interface Phase {
  id: number;
  tournament_id: number;
  seq: number;
  key: string;
  name: string;
  phase_type: "GROUP" | "KNOCKOUT" | string;
  group_count: number | null;
  entry_teams: number | null;
}

export interface TournamentDetail extends Tournament {
  phases: Phase[];
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

export const ATTRIBUTES = [
  "pace",
  "stamina",
  "strength",
  "dribbling",
  "passing",
  "shooting",
  "tackling",
  "vision",
  "positioning",
  "composure",
  "reflexes",
  "handling",
  "kicking",
  "aerial",
  "decisions",
  "aggression",
  "concentration",
  "leadership",
] as const;

export interface Player {
  id: number;
  team_id: number;
  name: string;
  position: (typeof POSITIONS)[number] | string;
  shirt_number: number | null;
  rating: number;
  pace: number;
  stamina: number;
  strength: number;
  dribbling: number;
  passing: number;
  shooting: number;
  tackling: number;
  vision: number;
  positioning: number;
  composure: number;
  reflexes: number;
  handling: number;
  kicking: number;
  aerial: number;
  decisions: number;
  aggression: number;
  concentration: number;
  leadership: number;
}

export interface SimMatch {
  id: number;
  tournament_id: number;
  stage: string;
  round_num: number;
  matchday: number | null;
  home_team_id: number;
  away_team_id: number;
  kickoff: string | null;
  home_team_name: string;
  away_team_name: string;
  home_score: number | null;
  away_score: number | null;
  status: "scheduled" | "played" | string;
}

export interface User {
  id: number;
  provider: string;
  provider_subject: string;
  display_name: string | null;
  email: string | null;
}

export interface SimulateResponse {
  simulated: number;
  champion: string | null;
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