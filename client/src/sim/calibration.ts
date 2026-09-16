/** Visible tuning knobs for the match engine. Targets calibrated in the Lab benchmark:
 *  2.5-2.7 goals/match, ~11-13 shots per team, ~10-12% conversion, deterministic per seed. */

export type ShotClass = "six_yard" | "box" | "edge" | "long" | "set_piece" | "penalty";

export interface Calibration {
  shotsBase: number;
  attackExponent: number;
  midExponent: number;
  shotsMin: number;
  shotsMax: number;
  minutePower: number;
  xgScale: number;
  classWeights: Record<ShotClass, number>;
  xgBase: Record<ShotClass, number>;
  qualityMin: number;
  qualityMax: number;
  onTargetProb: number;
  assistRate: number;
  penaltyRatePerTeam: number;
  positionWeights: Record<string, number>;
  homeAdvantage: number;
  maxGoalProb: number;
  maxTierFactor: number;
  minTierFactor: number;
}

export const CAL: Calibration = {
  shotsBase: 11.5,
  attackExponent: 0.55,
  midExponent: 0.15,
  shotsMin: 5,
  shotsMax: 18,
  minutePower: 0.85,
  xgScale: 0.65,
  classWeights: {
    six_yard: 0.1,
    box: 0.34,
    edge: 0.22,
    long: 0.22,
    set_piece: 0.12,
    penalty: 0,
  },
  xgBase: {
    six_yard: 0.38,
    box: 0.2,
    edge: 0.1,
    long: 0.045,
    set_piece: 0.055,
    penalty: 0.76,
  },
  qualityMin: 0.6,
  qualityMax: 1.35,
  onTargetProb: 0.31,
  assistRate: 0.62,
  penaltyRatePerTeam: 0.16,
  positionWeights: { GK: 0, DF: 0.3, MF: 1.2, FW: 2.4 },
  homeAdvantage: 1.02,
  maxGoalProb: 0.95,
  maxTierFactor: 1.25,
  minTierFactor: 0.75,
}