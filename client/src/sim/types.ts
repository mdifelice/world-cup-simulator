/** A player as the engine sees it: our 18 attributes (0-100), any key optional. */
export interface SimPlayer {
  id: number;
  name: string;
  position: string;
  attrs: Record<string, number>;
}

export type Strategy = "defensive" | "normal" | "attacking";

export interface TeamSetup {
  name: string;
  players: SimPlayer[];
  formation: string;
  strategy: Strategy;
}

export type GoalType = "open_play" | "penalty";

export interface SimGoal {
  minute: number;
  side: "home" | "away";
  type: GoalType;
  scorer_id: number;
  scorer_name: string;
  assist_id: number | null;
  assist_name: string | null;
}

export interface MatchInput {
  seed: number;
  home: TeamSetup;
  away: TeamSetup;
}

export interface MatchResult {
  seed: number;
  homeGoals: number;
  awayGoals: number;
  homeShots: number;
  awayShots: number;
  homeOnTarget: number;
  awayOnTarget: number;
  /** All goals, sorted by minute. */
  goals: SimGoal[];
  /** Combined goal minutes, sorted. */
  goalMinutes: number[];
  homeGoalsByTeam: number[];
  awayGoalsByTeam: number[];
}