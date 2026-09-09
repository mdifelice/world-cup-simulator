export type PositionType = "GK" | "DF" | "MF" | "FW";

export interface Slot {
  pos: PositionType;
  /** x = 0 (own goal) → 100 (opponent goal) */
  x: number;
  /** y = 0 (top) → 100 (bottom) */
  y: number;
}

export interface Formation {
  id: string;
  label: string;
  slots: Slot[];
}

const df = (n: number, y0: number, y1: number, x = 30): Slot[] =>
  Array.from({ length: n }, (_, i) => ({
    pos: "DF",
    x,
    y: y0 + ((y1 - y0) * i) / (n - 1 || 1),
  }));
const mf = (n: number, y0: number, y1: number, x = 55): Slot[] =>
  Array.from({ length: n }, (_, i) => ({
    pos: "MF",
    x,
    y: y0 + ((y1 - y0) * i) / (n - 1 || 1),
  }));
const fw = (n: number, y0: number, y1: number, x = 82): Slot[] =>
  Array.from({ length: n }, (_, i) => ({
    pos: "FW",
    x,
    y: y0 + ((y1 - y0) * i) / (n - 1 || 1),
  }));

const GK: Slot = { pos: "GK", x: 12, y: 50 };

export const FORMATIONS: Formation[] = [
  { id: "4-4-2", label: "4-4-2", slots: [GK, ...df(4, 20, 80), ...mf(4, 15, 85), ...fw(2, 35, 65)] },
  { id: "4-3-3", label: "4-3-3", slots: [GK, ...df(4, 20, 80), ...mf(3, 30, 70), ...fw(3, 15, 85)] },
  { id: "4-2-3-1", label: "4-2-3-1", slots: [GK, ...df(4, 20, 80), ...mf(2, 38, 62), ...mf(3, 20, 80), ...fw(1, 50, 50)] },
  { id: "3-5-2", label: "3-5-2", slots: [GK, ...df(3, 25, 75), ...mf(5, 10, 90), ...fw(2, 35, 65)] },
  { id: "3-4-3", label: "3-4-3", slots: [GK, ...df(3, 25, 75), ...mf(4, 20, 80), ...fw(3, 15, 85)] },
  { id: "5-3-2", label: "5-3-2", slots: [GK, ...df(5, 12, 88), ...mf(3, 30, 70), ...fw(2, 35, 65)] },
  { id: "4-5-1", label: "4-5-1", slots: [GK, ...df(4, 20, 80), ...mf(5, 10, 90), ...fw(1, 50, 50)] },
  { id: "3-3-4", label: "3-3-4", slots: [GK, ...df(3, 25, 75), ...mf(3, 30, 70), ...fw(4, 15, 85)] },
];

export const POSITION_ORDER: PositionType[] = ["GK", "DF", "MF", "FW"];

export const positionColor: Record<PositionType, string> = {
  GK: "#e0b400",
  DF: "#2f7dd1",
  MF: "#3bbf6b",
  FW: "#e05a3a",
};