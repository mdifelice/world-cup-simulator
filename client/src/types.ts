export interface WorldCup {
  id: number;
  year: number;
  host: string;
  winner: string | null;
  start_date: string | null;
  end_date: string | null;
  group_count: number;
}

export interface Team {
  id: number;
  name: string;
  code: string | null;
  flag: string | null;
  rating: number;
}

export interface Participant {
  id: number;
  name: string;
  code: string | null;
  flag: string | null;
  rating: number;
  group_letter: string | null;
}

export interface Player {
  id: number;
  team_id: number;
  name: string;
  position: "GK" | "DF" | "MF" | "FW" | string;
  shirt_number: number | null;
  rating: number;
}

export type MatchStage =
  | "GROUP"
  | "R16"
  | "QF"
  | "SF"
  | "Final"
  | "ThirdPlace"
  | string;

export interface SimMatch {
  id: number;
  worldcup_id: number;
  stage: MatchStage;
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

export interface AuthResponse {
  token: string;
  user: { id: number; username: string; created_at: string };
}

export interface SimulateResponse {
  simulated: number;
  champion: string | null;
}

export const STAGES: { label: string; stages: string[] }[] = [
  { label: "Group stage", stages: ["GROUP"] },
  { label: "Round of 16", stages: ["R16"] },
  { label: "Quarter-finals", stages: ["QF"] },
  { label: "Semi-finals", stages: ["SF"] },
  { label: "Third place", stages: ["ThirdPlace"] },
  { label: "Final", stages: ["Final"] },
];