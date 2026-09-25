// formats.ts — declarative edition config (mirror of server/src/db.rs formats_for).
//
// Every World Cup's structure — which group phases exist, how many entrants
// each knockout round takes, whether a second-round group (1974/78/82) or a
// league decider (1950) replaces a straight knockout — is data, not code.
// The client engine consumes the server-delivered `oracle.phases`; this module
// is the *declarative* description of that same structure, used by the tests
// to assert the generated run conforms to the edition's real format
// (stage keys, entrant counts, THIRD/F presence) without hard-coded `if`s.

export interface PhaseSpec {
  key: string;
  name: string;
  phase_type: "GROUP" | "KNOCKOUT";
  seq: number;
  group_count: number | null;
  entry_teams: number | null;
}

const group = (name: string, groups: number, seq = 0): PhaseSpec => ({
  key: "GROUP",
  name,
  phase_type: "GROUP",
  seq,
  group_count: groups,
  entry_teams: null,
});

const league = (name: string, seq = 0): PhaseSpec => ({
  key: "FINAL",
  name,
  phase_type: "GROUP",
  seq,
  group_count: 1,
  entry_teams: null,
});

/** A round-robin phase with an explicit entrants cap (1974/78: 8 → 2×4,
 *  1982: 12 → 4×3). */
const groupRound = (
  key: string,
  name: string,
  groups: number,
  entry: number,
  seq = 0,
): PhaseSpec => ({
  key,
  name,
  phase_type: "GROUP",
  seq,
  group_count: groups,
  entry_teams: entry > 0 ? entry : null,
});

const knockout = (key: string, name: string, entry: number, seq = 0): PhaseSpec => ({
  key,
  name,
  phase_type: "KNOCKOUT",
  seq,
  group_count: null,
  entry_teams: entry,
});

/** Tournament structure per era — the exact mirror of `formats_for` in db.rs.
 *  Order matters: phases are played in array order. */
export const FORMATS: Record<number, PhaseSpec[]> = {
  // 1930: 4 groups, straight to the semi-finals.
  1930: [
    group("Group stage", 4),
    knockout("SF", "Semi-finals", 4, 1),
    knockout("THIRD", "Third place", 2, 2),
    knockout("F", "Final", 2, 3),
  ],
  // 1934 & 1938: pure knockout from 16 participants.
  1934: [
    knockout("R16", "Round of 16", 16, 0),
    knockout("QF", "Quarter-finals", 8, 1),
    knockout("SF", "Semi-finals", 4, 2),
    knockout("THIRD", "Third place", 2, 3),
    knockout("F", "Final", 2, 4),
  ],
  1938: [
    knockout("R16", "Round of 16", 16, 0),
    knockout("QF", "Quarter-finals", 8, 1),
    knockout("SF", "Semi-finals", 4, 2),
    knockout("THIRD", "Third place", 2, 3),
    knockout("F", "Final", 2, 4),
  ],
  // 1950: 4 groups, then a final round-robin league between the winners.
  1950: [group("Group stage", 4), league("Final round", 1)],
};

/** The stored format for an edition (same branch logic as formats_for — but as
 *  a single declarative table lookup, never scattered `if`s). */
export function formatsFor(year: number): PhaseSpec[] {
  if (year <= 1938 || year === 1950) {
    return FORMATS[year] ?? [];
  }
  if (year >= 1954 && year <= 1970) {
    return [
      group("Group stage", 4),
      knockout("QF", "Quarter-finals", 8, 1),
      knockout("SF", "Semi-finals", 4, 2),
      knockout("THIRD", "Third place", 2, 3),
      knockout("F", "Final", 2, 4),
    ];
  }
  if (year === 1974 || year === 1978) {
    return [
      group("Group stage", 4),
      groupRound("GROUP2", "Second round", 2, 0, 1),
      knockout("THIRD", "Third place", 2, 2),
      knockout("F", "Final", 2, 3),
    ];
  }
  if (year === 1982) {
    return [
      group("Group stage", 6),
      groupRound("GROUP2", "Second round", 4, 12, 1),
      knockout("SF", "Semi-finals", 4, 2),
      knockout("THIRD", "Third place", 2, 3),
      knockout("F", "Final", 2, 4),
    ];
  }
  if (year >= 1986 && year <= 1994) {
    return [
      group("Group stage", 6),
      knockout("R16", "Round of 16", 16, 1),
      knockout("QF", "Quarter-finals", 8, 2),
      knockout("SF", "Semi-finals", 4, 3),
      knockout("THIRD", "Third place", 2, 4),
      knockout("F", "Final", 2, 5),
    ];
  }
  if (year >= 1998 && year <= 2022) {
    return [
      group("Group stage", 8),
      knockout("R16", "Round of 16", 16, 1),
      knockout("QF", "Quarter-finals", 8, 2),
      knockout("SF", "Semi-finals", 4, 3),
      knockout("THIRD", "Third place", 2, 4),
      knockout("F", "Final", 2, 5),
    ];
  }
  // 2026+ : 48 teams → 12 groups → R32 → ...
  return [
    group("Group stage", 12),
    knockout("R32", "Round of 32", 32, 1),
    knockout("R16", "Round of 16", 16, 2),
    knockout("QF", "Quarter-finals", 8, 3),
    knockout("SF", "Semi-finals", 4, 4),
    knockout("THIRD", "Third place", 2, 5),
    knockout("F", "Final", 2, 6),
  ];
}