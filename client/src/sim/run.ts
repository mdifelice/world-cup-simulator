// run.ts — client-side tournament run engine.
//
// Port of the former server engine (server/src/detail.rs + the phase helpers
// from server/src/sim.rs and fixture.rs) so the full World Cup run — phases,
// group tables, knockouts, extra time/penalties, momentum, live events,
// suspensions, awards — is simulated entirely in the browser. The server now
// only supplies raw data through the run oracle (`GET /api/tournaments/{id}/oracle`).
//
// Determinism: every match is seeded with `match_seed(run_seed, key, day,
// home, away, knockout)` (see seed.ts). Same oracle + same seed + same lineups
// → identical run, so committing a lineup only ever changes that match.

import { Rng, match_seed } from "./seed";
import {
  aiStrategy,
  momentumOf,
  type MinuteResult,
  type PlayShape,
  type PlayerRow,
  retune,
  shapeOf,
  simulateMinute,
} from "./possession";
import {
  slotPenalty,
  slotsFor,
  positionFamily,
  eraFormation,
  famPenalty,
  parsePosItem,
  type LineupConfig,
  type Goal,
  type Momentum,
  type RedCard,
  type MatchBan,
  type LiveEvent,
  type PenKick,
  type PenResult,
  type GroupInfo,
  type RunMatch,
  type RunPayload,
  type RunTeam,
  type Awards,
  type PlayerAward,
  type TopScorer,
  type PlayerStat,
  type Strategy,
} from "../types";

// ---------------------------------------------------------------------------
// Oracle data (server provides this — no simulation involved)
// ---------------------------------------------------------------------------

export interface OracleTournament {
  id: number;
  name: string;
  year: number;
  host: string;
  shirt_numbers: boolean;
}

export interface OraclePhase {
  id: number;
  tournament_id: number;
  seq: number;
  key: string;
  name: string;
  phase_type: string;
  group_count: number | null;
  entry_teams: number | null;
}

export interface OracleTeam {
  id: number;
  name: string;
  code: string | null;
  rating: number;
  pedigree: number;
  home_support: number;
  form: number;
  morale: number;
}

export interface OraclePlayer {
  id: number;
  name: string;
  position: string;
  positions: string[];
  photo_url: string | null;
  shirt_number: number | null;
  overall: number;
  aggression: number;
  leadership: number | null;
}

export interface OracleSquad {
  generated: boolean;
  players: OraclePlayer[];
}

export interface OracleGroup {
  name: string;
  team_ids: number[];
}

export interface OracleFixture {
  home_team_id: number;
  away_team_id: number;
  matchday: number | null;
  kickoff: string | null;
}

export interface Oracle {
  tournament: OracleTournament;
  phases: OraclePhase[];
  participants: OracleTeam[];
  squads: Record<number, OracleSquad>;
  groups: OracleGroup[];
  fixtures: OracleFixture[];
}

export interface RunOptions {
  /** Deterministic base seed. Omitted → a random one is minted. */
  seed?: bigint;
  focus_team_id: number | null;
  /** Per-match lineup configs keyed by "{stage_key}|{day}|{home}|{away}". */
  lineups?: Record<string, LineupConfig>;
}

// Expected-goals calibration (mirrors detail.rs).
const BASE_GOALS = 0.88;
const HOME_FACTOR = 1.08;

// ---------------------------------------------------------------------------
// Squad model
// ---------------------------------------------------------------------------

interface SquadPlayer {
  id: number;
  name: string;
  position: string;
  positions: string[];
  photo_url: string | null;
  shirt_number: number | null;
  overall: number;
  aggression: number;
}

/** Best (lowest) slot penalty across a player's positions — mirrors
 *  models.rs `best_slot_penalty`, plus each position's familiarity cost. */
function bestSlotPenalty(positions: string[], slot: string): number {
  if (!positions.length) return slotPenalty("MF", slot) + famPenalty(100);
  let best = Infinity;
  for (const item of positions) {
    const { position, family } = parsePosItem(item);
    const p = slotPenalty(position, slot) + famPenalty(family);
    if (p < best) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Phase helpers (ports of sim.rs + fixture.rs)
// ---------------------------------------------------------------------------

/** detail.rs max_subs_for */
function maxSubsFor(year: number): number {
  if (year >= 2022) return 5;
  if (year >= 1998) return 3;
  return 2;
}

/** fixture.rs round_robin — circle method, (home, away, round). */
function roundRobin(teams: number[]): Array<[number, number, number]> {
  const n = teams.length;
  const out: Array<[number, number, number]> = [];
  if (n < 2) return out;
  const list: number[] = [];
  for (let i = 1; i < n; i++) list.push(i);
  const rounds = n % 2 === 0 ? n - 1 : n;
  let idx = 0;
  while (idx < rounds) {
    const pairs: Array<[number, number]> = [[0, list[0]]];
    let k = 1;
    while (k + 1 < list.length) {
      pairs.push([list[k], list[k + 1]]);
      k += 2;
    }
    for (const [i, j] of pairs) {
      const [h, a] = idx % 2 === 0 ? [i, j] : [j, i];
      out.push([teams[h], teams[a], idx + 1]);
    }
    list.unshift(list.pop() as number);
    idx += 1;
  }
  return out;
}

/** sim.rs is_first_group_phase */
function isFirstGroupPhase(phases: OraclePhase[], idx: number): boolean {
  for (let i = 0; i < idx; i++) {
    if (phases[i].phase_type === "GROUP") return false;
  }
  return true;
}

/** sim.rs next_entry */
function nextEntry(phases: OraclePhase[], idx: number): number {
  const p = phases[idx + 1];
  if (!p) return 8;
  if (p.entry_teams != null) return p.entry_teams;
  if (p.group_count != null) return p.group_count * 4;
  return 8;
}

/** sim.rs group_assignments (persist ignored — this is an in-memory engine). */
function groupAssignments(
  oracle: Oracle,
  phase: OraclePhase,
  qualifiers: number[],
  first: boolean,
): number[][] {
  let groups: number[][];
  if (first) {
    const loaded = oracle.groups.map((g) => g.team_ids).filter((t) => t.length > 0);
    if (loaded.length > 0) {
      groups = loaded;
    } else {
      const count = (phase.group_count ?? 1) > 0 ? (phase.group_count ?? 1) : 1;
      const per = Math.ceil(qualifiers.length / count);
      groups = [];
      for (let i = 0; i < qualifiers.length; i += Math.max(per, 1)) {
        groups.push(qualifiers.slice(i, i + Math.max(per, 1)));
      }
    }
  } else if (phase.group_count === 1) {
    groups = [qualifiers.slice()];
  } else {
    const count = phase.group_count ?? 1;
    const per = Math.ceil(qualifiers.length / count);
    groups = [];
    for (let i = 0; i < qualifiers.length; i += per) {
      groups.push(qualifiers.slice(i, i + per));
    }
  }
  // Never produce a group with no teams.
  return groups.filter((g) => g.length > 0);
}

interface StandingRow {
  team_id: number;
  points: number;
  gf: number;
  ga: number;
}

const gd = (r: StandingRow) => r.gf - r.ga;

/** Sort a group table by points, GD, GF (no name tiebreak inside advance). */
function sortTable(rows: StandingRow[]): StandingRow[] {
  return rows.slice().sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (gd(y) !== gd(x)) return gd(y) - gd(x);
    return y.gf - x.gf;
  });
}

/** sim.rs advance */
function advance(tables: StandingRow[][], entry: number): [number[], number] {
  const m = tables.length;
  if (m === 0) return [[], 0];
  const k = Math.floor(entry / m);
  const q: number[] = [];
  for (let rank = 0; rank < k; rank++) {
    for (const t of tables) {
      if (t[rank]) q.push(t[rank].team_id);
    }
  }
  const fill = entry - q.length;
  if (fill > 0) {
    const rest = tables.flatMap((t) => t.slice(k));
    rest.sort((x, y) => {
      if (y.points !== x.points) return y.points - x.points;
      if (gd(y) !== gd(x)) return gd(y) - gd(x);
      return y.gf - x.gf;
    });
    for (const s of rest.slice(0, fill)) q.push(s.team_id);
  }
  return [q, m];
}

/** sim.rs group_pairings */
function groupPairings(q: number[], m: number): Array<[number, number]> {
  const n = q.length;
  if (n % 2 !== 0) throw new Error("odd number of qualifiers for knockout");
  const winners = q.slice(0, Math.min(m, n));
  const runners = q.slice(Math.min(m, n), 2 * Math.min(m, n));
  const rest = q.slice(2 * Math.min(m, n));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < winners.length; i++) {
    const r = runnerFor(i, winners.length, runners);
    if (r != null) out.push([winners[i], r]);
    else out.push([winners[i], winners[(i + 1) % winners.length]]);
  }
  for (let c = 0; c + 1 < rest.length; c += 2) {
    out.push([rest[c], rest[c + 1]]);
  }
  return out;
}

function runnerFor(i: number, winners: number, runners: number[]): number | null {
  if (!runners.length) return null;
  return runners[(i + 1) % Math.min(winners, runners.length)];
}

/** sim.rs seeded_pairings — best vs worst bracket. */
function seededPairings(q: number[]): Array<[number, number]> {
  const n = q.length;
  if (n % 2 !== 0) throw new Error("odd number of participants for knockout");
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n / 2; i++) out.push([q[i], q[n - 1 - i]]);
  return out;
}

/** sim.rs next_pairings */
function nextPairings(winners: number[]): Array<[number, number]> {
  if (winners.length % 2 !== 0) throw new Error("odd number of winners for knockout round");
  const out: Array<[number, number]> = [];
  for (let i = 0; i < winners.length; i += 2) out.push([winners[i], winners[i + 1]]);
  return out;
}

/** fixture.rs real_group_schedule — per-group per-round matchdays. */
function realGroupSchedule(oracle: Oracle): Array<Array<Array<[number, number]>>> | null {
  const groups = oracle.groups;
  if (groups.length === 0) return null;
  const rows = oracle.fixtures;
  const scheduled = rows.length > 0;
  if (!scheduled) return null;
  const schedule: Array<Array<Array<[number, number]>>> = [];
  for (const g of groups) {
    const members = g.team_ids.slice();
    const byRound: Array<Array<[number, number]>> = [];
    for (const f of rows) {
      if (members.includes(f.home_team_id) || members.includes(f.away_team_id)) {
        const round = f.matchday != null ? Math.max(f.matchday, 1) : 1;
        while (byRound.length < round) byRound.push([]);
        byRound[round - 1].push([f.home_team_id, f.away_team_id]);
      }
    }
    if (byRound.every((r) => r.length === 0)) return null;
    schedule.push(byRound);
  }
  return schedule;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface Perf {
  name: string;
  team_id: number;
  position: string;
  photo: string | null;
  games: number;
  rating_sum: number;
  goals: number;
  assists: number;
  clean_sheets: number;
}

class Engine {
  readonly oracle: Oracle;
  readonly tournamentId: number;
  readonly year: number;
  readonly shirtNumbers: boolean;
  readonly focus: number | null;
  readonly runSeed: bigint;
  readonly lineups: Record<string, LineupConfig>;

  rng: Rng;
  matches: RunMatch[] = [];
  order: number[] = [];
  groups: GroupInfo[] = [];
  perfs = new Map<number, Perf>();
  teamNames = new Map<number, string>();
  teamCodes = new Map<number, string>();
  kickoffs = new Map<string, string>();
  squads = new Map<number, SquadPlayer[]>();
  teamBonus = new Map<number, number>();
  champion: string | null = null;
  nextId = 1;
  day = 0;
  quals: number[];
  prevWinners: number[] = [];
  prevLosers: number[] = [];
  groupCount = 0;
  playedGroups = false;
  standings: StandingRow[] = [];
  currentGroups: number[][] = [];
  groupMetaBuilt = false;
  formShift = new Map<number, number>();
  moraleShift = new Map<number, number>();
  suspensions = new Map<number, [number, "red" | "injury"]>();

  constructor(oracle: Oracle, opts: RunOptions) {
    this.oracle = oracle;
    this.tournamentId = oracle.tournament.id;
    this.year = oracle.tournament.year;
    this.shirtNumbers = oracle.tournament.shirt_numbers;
    this.focus = opts.focus_team_id;
    this.runSeed = opts.seed ?? (BigInt(Date.now()) ^ (BigInt(Math.floor(Math.random() * 2 ** 31)) << 21n));
    this.lineups = opts.lineups ?? {};
    this.rng = new Rng(1n); // re-seeded per match inside playMatch

    for (const f of this.oracle.fixtures) {
      if (!f.kickoff) continue;
      const [h, a] =
        f.home_team_id < f.away_team_id
          ? [f.home_team_id, f.away_team_id]
          : [f.away_team_id, f.home_team_id];
      this.kickoffs.set(`${h}|${a}`, f.kickoff);
    }
    // Participants arrive ordered by team rating (matching the server order).
    this.quals = this.oracle.participants.map((t) => t.id);
  }

  // -------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------

  teamName(teamId: number): string {
    const cached = this.teamNames.get(teamId);
    if (cached != null) return cached;
    const t = this.oracle.participants.find((p) => p.id === teamId);
    const name = t?.name ?? "?";
    this.teamNames.set(teamId, name);
    return name;
  }

  teamCode(teamId: number): string | null {
    const cached = this.teamCodes.get(teamId);
    if (cached != null) return cached;
    const t = this.oracle.participants.find((p) => p.id === teamId);
    const code = t?.code ?? null;
    if (code != null) this.teamCodes.set(teamId, code);
    return code;
  }

  teamContext(teamId: number) {
    const t = this.oracle.participants.find((p) => p.id === teamId);
    return {
      pedigree: t?.pedigree ?? 50,
      home_support: t?.home_support ?? 50,
      form: t?.form ?? 50,
      morale: t?.morale ?? 55,
    };
  }

  squad(teamId: number): SquadPlayer[] {
    const cached = this.squads.get(teamId);
    if (cached) return cached;
    const or = this.oracle.squads[teamId] ?? { generated: true, players: [] };
    const s: SquadPlayer[] = or.players.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      positions: p.positions,
      photo_url: p.photo_url,
      shirt_number: p.shirt_number,
      overall: p.overall,
      aggression: p.aggression,
    }));
    this.squads.set(teamId, s);
    return s;
  }

  /// sim.rs base_strength + this.strength() (with form/morale drift).
  strength(teamId: number, knockout: boolean): number {
    const or = this.oracle.squads[teamId];
    const t = this.oracle.participants.find((p) => p.id === teamId);
    let base: number;
    if (or && !or.generated && or.players.length > 0) {
      base = or.players.reduce((s, p) => s + p.overall, 0) / or.players.length;
    } else {
      base = t?.rating ?? 70;
    }
    const ctx = this.teamContext(teamId);
    let lead = 60;
    if (or && !or.generated && or.players.length > 0) {
      const sum = or.players.reduce((s, p) => s + (p.leadership ?? 60), 0);
      lead = sum / or.players.length;
    }
    const form = (ctx.form - 50) * 0.06;
    const morale = (ctx.morale - 55) * 0.04;
    const pedigree = (ctx.pedigree - 50) * (knockout ? 0.06 : 0.03);
    const leadership = (lead - 60) * 0.05;
    const baseStrength = clamp(base + form + morale + pedigree + leadership, 40, 99);
    const fs = (this.formShift.get(teamId) ?? 0) * 0.06;
    const ms = (this.moraleShift.get(teamId) ?? 0) * 0.04;
    return clamp(baseStrength + fs + ms, 40, 99);
  }

  xg(home: number, away: number, knockout: boolean): [number, number] {
    const h = this.strength(home, knockout);
    const a = this.strength(away, knockout);
    const homeSupport = this.teamContext(home).home_support;
    const hf = Math.min(h + (homeSupport - 50) * 0.04, 99);
    const hx = clamp(BASE_GOALS * Math.exp((hf - a) / 20) * HOME_FACTOR, 0.1, 4.5);
    const ax = clamp(BASE_GOALS * Math.exp((a - hf) / 20), 0.1, 4.5);
    return [hx, ax];
  }

  // -------------------------------------------------------------------
  // XI selection
  // -------------------------------------------------------------------

  suspended(playerId: number): boolean {
    const s = this.suspensions.get(playerId);
    return s != null && s[0] > 0;
  }

  pickXi(teamId: number): SquadPlayer[] {
    const squad = this.squad(teamId);
    const slots = slotsFor(eraFormation(this.year), "normal");
    const df = slots.filter((s) => s === "DF" || s === "RWB" || s === "LWB").length;
    const mf = slots.filter((s) => s === "DMF" || s === "AMF" || s === "RMF" || s === "LMF").length;
    const fw = slots.filter((s) => s === "FW" || s === "RFW" || s === "LFW").length;
    const chosen: SquadPlayer[] = [];
    const used = new Set<number>();
    const families: Array<[string, number]> = [["GK", 1], ["DF", df], ["MF", mf], ["FW", fw]];
    for (const [family, count] of families) {
      const pool = squad
        .filter((p) => positionFamily(p.position) === family && !this.suspended(p.id) && !used.has(p.id))
        .slice()
        .sort((a, b) => b.overall - a.overall);
      for (const p of pool.slice(0, count)) {
        used.add(p.id);
        chosen.push({ ...p });
      }
    }
    if (chosen.length === 0) {
      chosen.push(
        ...squad.filter((p) => !this.suspended(p.id)).slice(0, 11).map((p) => ({ ...p })),
      );
    } else {
      const rest = squad
        .filter((p) => !this.suspended(p.id) && !used.has(p.id))
        .slice()
        .sort((a, b) => b.overall - a.overall);
      for (const p of rest.slice(0, 11 - chosen.length)) chosen.push({ ...p });
    }
    return chosen;
  }

  pickXiFor(teamId: number, cfg: LineupConfig | null): SquadPlayer[] {
    if (cfg) return this.xiFromConfig(teamId, cfg);
    return this.pickXi(teamId);
  }

  xiFromConfig(teamId: number, cfg: LineupConfig): SquadPlayer[] {
    const squad = this.squad(teamId);
    const slots = slotsFor(cfg.formation, cfg.strategy);
    const used = new Set<number>();
    const xi: SquadPlayer[] = [];
    const occurrence = new Map<string, number>();
    for (const slot of slots) {
      const occ = occurrence.get(slot) ?? 0;
      occurrence.set(slot, occ + 1);
      const assigned = cfg.starting[slot]?.[occ];
      const base =
        assigned != null &&
        !used.has(assigned) &&
        !this.suspended(assigned) &&
        squad.some((p) => p.id === assigned)
          ? squad.find((p) => p.id === assigned) ?? null
          : this.bestForSlot(squad, slot, used);
      if (base) {
        // Clone so the slot penalty never mutates the cached squad row
        // (the server works on cloned SquadPlayers the same way).
        const pick = { ...base };
        const penalty = bestSlotPenalty(pick.positions, slot);
        pick.overall = clamp(pick.overall - penalty * 2, 30, 99);
        used.add(pick.id);
        xi.push(pick);
      }
    }
    return xi;
  }

  bestForSlot(squad: SquadPlayer[], slot: string, used: Set<number>): SquadPlayer | null {
    let best: SquadPlayer | null = null;
    let bestEff = -Infinity;
    for (const p of squad) {
      if (used.has(p.id) || this.suspended(p.id)) continue;
      const eff = p.overall - bestSlotPenalty(p.positions, slot) * 2;
      if (eff > bestEff) {
        bestEff = eff;
        best = p;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------
  // Match detail helpers
  // -------------------------------------------------------------------

  pickField(xi: SquadPlayer[]): SquadPlayer | null {
    if (!xi.length) return null;
    return xi[Math.floor(this.rng.unit() * xi.length) % xi.length];
  }

  pickSubOut(xi: SquadPlayer[], diff: number, subbedOut: Set<number>): SquadPlayer | null {
    const families = diff < 0 ? ["FW", "MF"] : diff > 0 ? ["DF", "MF"] : ["MF", "FW", "DF"];
    let cands = xi.filter(
      (p) => !subbedOut.has(p.id) && families.includes(positionFamily(p.position)),
    );
    if (!cands.length) {
      cands = xi.filter((p) => !subbedOut.has(p.id) && positionFamily(p.position) !== "GK");
    }
    if (!cands.length) return null;
    return cands[Math.floor(this.rng.unit() * cands.length) % cands.length];
  }

  pickInFromBench(bench: SquadPlayer[], family: string | null, subbedIn: Set<number>): SquadPlayer | null {
    const pool = bench
      .filter(
        (p) =>
          !subbedIn.has(p.id) &&
          (family == null || positionFamily(p.position) === family) &&
          positionFamily(p.position) !== "GK",
      )
      .slice()
      .sort((a, b) => b.overall - a.overall);
    return pool[0] ?? null;
  }

  drawRed(xi: SquadPlayer[]): [number, SquadPlayer] | null {
    const pool = xi.filter((p) => p.position !== "GK");
    if (!pool.length) return null;
    const avg = xi.reduce((s, p) => s + p.aggression, 0) / xi.length;
    const prob = clamp(0.045 * (avg / 60), 0.005, 0.18);
    if (this.rng.unit() >= prob) return null;
    const total = pool.reduce((s, p) => s + p.aggression * p.aggression, 0);
    let roll = this.rng.unit() * total;
    let chosen = pool[pool.length - 1];
    for (const p of pool) {
      roll -= p.aggression * p.aggression;
      if (roll <= 0) {
        chosen = p;
        break;
      }
    }
    const minute = Math.min(1 + Math.floor(this.rng.unit() * 90), 90);
    return [minute, chosen];
  }

  pickOwnGoal(oppXi: SquadPlayer[]): SquadPlayer | null {
    let pool = oppXi.filter((p) => positionFamily(p.position) === "DF");
    if (!pool.length) pool = oppXi.filter((p) => p.position !== "GK");
    if (!pool.length) return null;
    return pool[Math.min(Math.floor(this.rng.unit() * pool.length), pool.length - 1)];
  }

  scorerWeight(p: SquadPlayer): number {
    switch (positionFamily(p.position)) {
      case "GK":
        return 0.02;
      case "DF":
        return 0.35;
      case "MF":
        return p.position === "CAM" ? 1.8 : p.position === "CM" ? 1.2 : 0.9;
      default:
        return p.position === "ST" ? 2.6 : 2.1;
    }
  }

  pickScorer(xi: SquadPlayer[]): SquadPlayer {
    const total = xi.reduce((s, p) => s + this.scorerWeight(p) * p.overall * p.overall, 0);
    let roll = this.rng.unit() * total;
    for (const p of xi) {
      roll -= this.scorerWeight(p) * p.overall * p.overall;
      if (roll <= 0) return p;
    }
    return xi[0];
  }

  attWeight(p: SquadPlayer): number {
    switch (positionFamily(p.position)) {
      case "GK":
        return 0;
      case "DF":
        return 0.5;
      case "MF":
        return 2.0;
      default:
        return 1.4;
    }
  }

  pickAssist(xi: SquadPlayer[], scorer: SquadPlayer): SquadPlayer {
    const pool = xi.filter((p) => p.id !== scorer.id);
    const total = pool.reduce((s, p) => s + this.attWeight(p), 0);
    let roll = this.rng.unit() * total;
    for (const p of pool) {
      roll -= this.attWeight(p);
      if (roll <= 0) return p;
    }
    return pool[0] ?? scorer;
  }

  makeGoal(
    xi: SquadPlayer[],
    oppXi: SquadPlayer[],
    minute: number,
    extraTime: boolean,
    teamId: number,
    red: [number, SquadPlayer] | null,
    added = false,
    forcedScorer: SquadPlayer | null = null,
  ): Goal {
    const sentOff = red && minute >= red[0] ? red[1].id : null;
    const forced = forcedScorer && forcedScorer.id !== sentOff ? forcedScorer : null;
    if (!forced) {
      if (this.rng.unit() < 0.02) {
        const og = this.pickOwnGoal(oppXi);
        if (og) {
          return {
            minute,
            extra_time: extraTime,
            added_time: added || undefined,
            team_id: teamId,
            scorer_id: og.id,
            scorer: og.name,
            scorer_photo: og.photo_url,
            shirt_number: og.shirt_number ?? undefined,
            assist_id: null,
            assist: null,
            assist_photo: null,
            own_goal: true,
          };
        }
      }
    }
    const eff = xi.filter((p) => p.id !== sentOff);
    const goalScorer = forced ?? this.pickScorer(eff);
    const family = positionFamily(goalScorer.position);
    const assistProb = family === "GK" ? 0 : family === "DF" ? 0.6 : family === "MF" ? 0.7 : 0.72;
    // Reuse the assist decision draw to mark a small share of goals as penalty
    // kicks (no assist, ~2%): same number of RNG draws, so seed streams are
    // unchanged from the previous engine.
    const assistRoll = this.rng.unit();
    const isPen = assistRoll > 0.98;
    const assist = isPen ? null : assistRoll < assistProb ? this.pickAssist(eff, goalScorer) : null;
    return {
      minute,
      extra_time: extraTime,
      added_time: added || undefined,
      team_id: teamId,
      scorer_id: goalScorer.id,
      scorer: goalScorer.name,
      scorer_photo: goalScorer.photo_url,
      shirt_number: goalScorer.shirt_number ?? undefined,
      assist_id: assist ? assist.id : null,
      assist: assist ? assist.name : null,
      assist_photo: assist ? assist.photo_url : null,
      own_goal: false,
      penalty: isPen || undefined,
    };
  }

  takeOrder(xi: SquadPlayer[]): SquadPlayer[] {
    return xi.slice().sort((a, b) => b.overall - a.overall);
  }

  scoreProb(taker: SquadPlayer, gkOverall: number): number {
    return clamp(0.7 + (taker.overall - 70) * 0.004 + (70 - gkOverall) * 0.002, 0.4, 0.96);
  }

  /** Deterministic split of a missed kick into "saved" vs "off target". Purely a
   *  function of already-stored fields, so it needs no extra RNG draws and stays
   *  reproducible across replays. */
  savedDecided(round: number, teamId: number, taker: string): boolean {
    let h = round * 131 + teamId * 17;
    for (let i = 0; i < taker.length; i++) h = (h * 31 + taker.charCodeAt(i)) | 0;
    return (Math.abs(h) % 2) === 0;
  }

  playPenalties(
    home: number,
    homeXi: SquadPlayer[],
    away: number,
    awayXi: SquadPlayer[],
  ): PenResult {
    const homeGk = homeXi.find((p) => p.position === "GK")?.overall ?? 60;
    const awayGk = awayXi.find((p) => p.position === "GK")?.overall ?? 60;
    const homeTakers = this.takeOrder(homeXi);
    const awayTakers = this.takeOrder(awayXi);
    const maxTakers = Math.max(homeTakers.length, awayTakers.length);
    const minTakers = Math.min(homeTakers.length, awayTakers.length);
    if (minTakers === 0) {
      return { home_score: 0, away_score: 0, winner_id: home, sudden_death: false, kicks: [] };
    }
    const kicks: PenKick[] = [];
    let hs = 0;
    let aw = 0;
    let winner = home;
    let suddenDeath = false;

    main: for (let round = 1; round <= 5; round++) {
      const idx = (round - 1) % maxTakers;
      const ht = homeTakers[idx % homeTakers.length];
      const hS = this.rng.unit() < this.scoreProb(ht, awayGk);
      if (hS) hs += 1;
      kicks.push({
        round,
        team_id: home,
        taker: ht.name,
        scored: hS,
        saved: !hS && this.savedDecided(round, home, ht.name),
      });
      // Home shoots first: once the lead is unreachable, the away side does not
      // take the rest of its kicks.
      const remaining = 5 - round;
      if (hs > aw + remaining) {
        winner = home;
        break main;
      }
      const at = awayTakers[idx % awayTakers.length];
      const aS = this.rng.unit() < this.scoreProb(at, homeGk);
      if (aS) aw += 1;
      kicks.push({
        round,
        team_id: away,
        taker: at.name,
        scored: aS,
        saved: !aS && this.savedDecided(round, away, at.name),
      });
      if (aw > hs + remaining) {
        winner = away;
        break main;
      }
    }

    if (hs === aw) {
      suddenDeath = true;
      let round = 6;
      while (true) {
        const idx = (round - 1) % maxTakers;
        const ht = homeTakers[idx % homeTakers.length];
        const at = awayTakers[idx % awayTakers.length];
        const hS = this.rng.unit() < this.scoreProb(ht, awayGk);
        const aS = this.rng.unit() < this.scoreProb(at, homeGk);
        if (hS) hs += 1;
        if (aS) aw += 1;
        kicks.push({
          round,
          team_id: home,
          taker: ht.name,
          scored: hS,
          saved: !hS && this.savedDecided(round, home, ht.name),
        });
        kicks.push({
          round,
          team_id: away,
          taker: at.name,
          scored: aS,
          saved: !aS && this.savedDecided(round, away, at.name),
        });
        if (hS !== aS) {
          winner = hS ? home : away;
          break;
        }
        round += 1;
        if (round > 40) break;
      }
    }

    return { home_score: hs, away_score: aw, winner_id: winner, sudden_death: suddenDeath, kicks };
  }

  resultLabel(hs: number, aw: number, extra: boolean, pen: PenResult | null): string {
    let s = `${hs}–${aw}`;
    if (extra) s = `${s} aet`;
    if (pen) s = `${s} (${pen.home_score}–${pen.away_score} pens)`;
    return s;
  }

  genMatchEvents(
    events: LiveEvent[],
    team: number,
    xi: SquadPlayer[],
    goals: Goal[],
    redCards: [number, SquadPlayer] | null,
    maxSubs: number,
    bannedAtKickoff: Set<number>,
  ): void {
    const squad = this.squad(team);
    const xiIds = new Set(xi.map((p) => p.id));
    const bench = squad.filter((p) => !xiIds.has(p.id) && !bannedAtKickoff.has(p.id));
    const subbedOut = new Set<number>();
    const subbedIn = new Set<number>();
    const gfAt = (minute: number) => goals.filter((g) => g.team_id === team && g.minute <= minute).length;
    const gaAt = (minute: number) => goals.filter((g) => g.team_id !== team && g.minute <= minute).length;
    const push = (
      minute: number,
      kind: string,
      detail: string,
      out: SquadPlayer | null,
      inp: SquadPlayer | null,
    ) => {
      events.push({
        minute,
        extra_time: false,
        kind: kind as LiveEvent["kind"],
        team_id: team,
        detail,
        out_player: out ? out.name : null,
        out_player_photo: out ? out.photo_url : null,
        out_player_number: out ? out.shirt_number : null,
        in_player: inp ? inp.name : null,
        in_player_photo: inp ? inp.photo_url : null,
        in_player_number: inp ? inp.shirt_number : null,
      });
    };

    let subsUsed = 0;

    // Red card for this team (if applicable)
    if (redCards) {
      const [minute] = redCards;
      push(minute, "red", "", redCards[1], null);
      subbedOut.add(redCards[1].id);
      // If red card is GK, handle GK substitution
      if (redCards[1].position === "GK") {
        // Find a GK on the bench
        const gkBench = bench.find(p => p.position === "GK");
        if (gkBench) {
          push(redCards[0], "sub", "GK sent off", redCards[1], gkBench);
        } else {
          // No GK on bench, field player takes GK
          const fieldPlayer = xi.find(p => p.id !== redCards[1].id);
          if (fieldPlayer) {
            push(redCards[0], "sub", "GK sent off, field player takes GK", fieldPlayer, fieldPlayer);
          }
        }
      }
    }

    // Injuries: roughly 1-in-11 per side per match, lasting 1-4 matches.
    // Can happen at any minute during the match.
    if (this.rng.unit() < 0.09) {
      const w = this.rng.unit();
      const bannedFor = w < 0.3 ? 1 : w < 0.6 ? 2 : w < 0.85 ? 3 : 4;
      const outp = this.pickField(xi);
      if (outp) {
        const isGK = outp.position === "GK";
        const minute = Math.min(1 + Math.floor(this.rng.unit() * 90), 90);
        if (subsUsed < maxSubs && bench.length > 0) {
          // Find a suitable replacement (same position if possible, especially for GK)
          let inp: SquadPlayer | null = null;
          if (isGK) {
            inp = this.pickInFromBench(bench, "GK", subbedIn);
          }
          if (!inp) {
            inp = this.pickInFromBench(bench, null, subbedIn);
          }
          if (inp) {
            push(minute, "injury", "", outp, inp);
            subsUsed += 1;
            subbedOut.add(outp.id);
            if (inp) subbedIn.add(inp.id);
          } else {
            // No substitution available - player injured but no sub available
            push(minute, "injury", "", outp, null);
            subbedOut.add(outp.id);
            // If GK injured and no sub, a field player must take GK role
            if (isGK) {
              const fieldPlayer = xi.find(p => p.id !== outp.id && !subbedOut.has(p.id));
              if (fieldPlayer) {
                push(minute, "sub", "GK injured, field player takes GK", fieldPlayer, fieldPlayer);
              }
            }
            subbedOut.add(outp.id);
          }
          this.suspensions.set(outp.id, [bannedFor, "injury"]);
        }
      }
    }

    // Red card for this team (if applicable)
    // This is called from playMatch where red card is already determined
    // We'll handle red card events here for the user's team
    // Red card is passed as parameter (minute and player)

    // Half-time reaction: chase or protect the lead.
    const d46 = gfAt(46) - gaAt(46);
    const strat = d46 < 0 ? "attacking" : d46 > 0 ? "defensive" : this.rng.unit() < 0.5 ? "normal" : null;
    if (strat) push(46, "strategy", strat, null, null);

    // Score-aware tactical substitutions within the era's allowance.
    const slotMins = [46, 62, 70, 78, 84];
    const quota = Math.min(1 + Math.floor(this.rng.unit() * 3), maxSubs) - subsUsed;
    for (const base of slotMins.slice(0, Math.max(quota, 0))) {
      const minute = Math.min(base + Math.floor(this.rng.unit() * 5), 88);
      const d = gfAt(minute) - gaAt(minute);
      const family = d < 0 ? "FW" : d > 0 ? "DF" : "MF";
      const outp = this.pickSubOut(xi, d, subbedOut);
      if (outp) {
        const inp = this.pickInFromBench(bench, family, subbedIn);
        if (inp) {
          push(minute, "sub", "", outp, inp);
          subsUsed += 1;
          subbedOut.add(outp.id);
          subbedIn.add(inp.id);
        }
      }
    }

    // Late formation switch when the scoreboard begs for one.
    const mn = 70 + Math.floor(this.rng.unit() * 5);
    const d = gfAt(mn) - gaAt(mn);
    const formation =
      d < 0
        ? this.rng.unit() < 0.5 ? "4-3-3" : "3-4-3"
        : d > 0
          ? this.rng.unit() < 0.5 ? "5-3-2" : "5-4-1"
          : null;
    if (formation) push(mn, "tactics", formation, null, null);
  }

  // -------------------------------------------------------------------
  // Match engine
  // -------------------------------------------------------------------

  playMatch(home: number, away: number, stageKey: string, stageName: string, knockout: boolean, usePens: boolean = knockout): number | null {
    const key = `${stageKey}|${this.day}|${home}|${away}`;
    this.rng = Rng.from_seed(
      match_seed(this.runSeed, key, this.day, BigInt(home), BigInt(away), knockout),
    );

    const cfg = this.lineups[key] ?? null;
    const focus = this.focus;
    const focusCfg = (team: number) => (focus === team ? cfg : null);
    const cfgStrategy = (team: number) => focusCfg(team)?.strategy ?? "normal";
    const cfgFormation = (team: number) => focusCfg(team)?.formation ?? eraFormation(this.year);

    const homeXi = this.pickXiFor(home, focusCfg(home));
    const awayXi = this.pickXiFor(away, focusCfg(away));

    const homeRed = this.drawRed(homeXi);
    const awayRed = this.drawRed(awayXi);

    const toRow = (p: SquadPlayer): PlayerRow => ({
      id: p.id,
      name: p.name,
      position: p.position,
      overall: p.overall,
      aggression: p.aggression,
    });

    const makeShape = (
      team: number,
      xi: SquadPlayer[],
      strategy: Strategy,
      red: [number, SquadPlayer] | null,
    ): PlayShape => {
      const ctx = this.teamContext(team);
      return shapeOf({
        id: team,
        name: this.teamName(team),
        xi: xi.map(toRow),
        strategy,
        formation: cfgFormation(team),
        redMinute: red ? red[0] : null,
        form: ctx.form / 100,
        morale: ctx.morale / 100,
      });
    };

    const hShape = makeShape(home, homeXi, cfgStrategy(home), homeRed);
    const aShape = makeShape(away, awayXi, cfgStrategy(away), awayRed);

    const goals: Goal[] = [];
    let hs = 0;
    let aw = 0;
    const momentumSeries: number[] = [];

    // Simulate from minute to minute (regulation, stoppage or extra time).
    // Every minute is a sequence of possession duels; AI coaches retune their
    // strategy against the scoreboard every minute (the focus team stays
    // player-controlled).
    const simMinute = (minute: number, extraTime: boolean, added: boolean): MinuteResult => {
      if (focus !== home)
        retune(hShape, aiStrategy(hs - aw, minute, homeRed != null), homeRed ? homeRed[0] : null);
      if (focus !== away)
        retune(aShape, aiStrategy(aw - hs, minute, awayRed != null), awayRed ? awayRed[0] : null);
      const r = simulateMinute(() => this.rng.unit(), hShape, aShape, minute);
      if (r.goal) {
        const team = r.goal.teamId;
        const [xi, opp, red] = team === home ? [homeXi, awayXi, homeRed] : [awayXi, homeXi, awayRed];
        const scorer = xi.find((p) => p.id === r.goal!.scorer.id) ?? null;
        const g = this.makeGoal(xi, opp, minute, extraTime, team, red, added, scorer);
        goals.push(g);
        if (g.team_id === home) hs += 1;
        else aw += 1;
      }
      return r;
    };

    for (let m = 1; m <= 90; m++) {
      momentumSeries.push(momentumOf(simMinute(m, false, false)));
    }

    // Players suspended at kickoff, needed up-front for event generation.
    const bannedAtKickoff = new Set<number>();
    for (const team of [home, away]) {
      for (const p of this.squad(team)) {
        if (this.suspended(p.id)) bannedAtKickoff.add(p.id);
      }
    }

    // Live feed (subs, injuries, reds, strategy, tactics) for this match.
    const events: LiveEvent[] = [];
    {
      const maxSubs = maxSubsFor(this.year);
      this.genMatchEvents(events, home, homeXi, goals, homeRed, maxSubs, bannedAtKickoff);
      this.genMatchEvents(events, away, awayXi, goals, awayRed, maxSubs, bannedAtKickoff);
      events.sort((a, b) => a.minute - b.minute);
    }

    // Additional time is derived from the match's incidents: the more goals,
    // cards and stoppages (subs/injuries), the longer the wait. Half-time runs
    // 1-4', full-time 3-6'.
    const htGoals = goals.filter((g) => g.minute <= 45).length;
    const ftGoals = hs + aw - htGoals;
    const htReds = [homeRed, awayRed].filter(
      (r): r is [number, SquadPlayer] => r !== null && r[0] <= 45,
    ).length;
    const ftReds = (homeRed ? 1 : 0) + (awayRed ? 1 : 0) - htReds;
    const htEvents = events.filter((e) => (e.kind === "sub" || e.kind === "injury") && e.minute <= 45).length;
    const ftEvents = events.filter((e) => (e.kind === "sub" || e.kind === "injury") && e.minute > 45).length;
    const clampSt = (v: number, lo: number, hi: number): number =>
      Math.max(lo, Math.min(hi, Math.round(v)));
    const addedHt = clampSt(1 + htGoals * 0.4 + htReds * 1.25 + htEvents * 0.12, 1, 4);
    const addedFt = clampSt(2 + ftGoals * 0.4 + ftReds * 1.25 + ftEvents * 0.12, 3, 6);
    let addedEt1 = 0;
    let addedEt2 = 0;
    for (let i = 1; i <= addedHt; i++) simMinute(45 + i, false, true);
    for (let i = 1; i <= addedFt; i++) simMinute(90 + i, false, true);

    let winner = hs > aw ? home : aw > hs ? away : null;
    let extraTime = false;
    let penalties: PenResult | null = null;

    if (knockout && winner == null) {
      extraTime = true;
      for (let m = 91; m <= 120; m++) {
        momentumSeries.push(momentumOf(simMinute(m, true, false)));
      }
      // Extra-time added time is driven by the goals scored in extra time.
      const etGoals = goals.filter((g) => g.minute > 90 && !g.added_time).length;
      addedEt1 = clampSt(etGoals * 0.4, 0, 2);
      addedEt2 = clampSt(etGoals * 0.25, 0, 2);
      for (let i = 1; i <= addedEt1; i++) simMinute(105 + i, true, true);
      for (let i = 1; i <= addedEt2; i++) simMinute(120 + i, true, true);
      winner = hs > aw ? home : aw > hs ? away : null;
    }

    if (usePens && winner == null) {
      const p = this.playPenalties(home, homeXi, away, awayXi);
      winner = p.winner_id === home ? home : away;
      penalties = p;
    }

    goals.sort((a, b) => (a.minute - b.minute) || (a.team_id - b.team_id));

    // Sending-offs, in minute order.
    const reds: RedCard[] = [];
    if (homeRed) {
      reds.push({
        minute: homeRed[0],
        extra_time: false,
        team_id: home,
        player_id: homeRed[1].id,
        player: homeRed[1].name,
        player_photo: homeRed[1].photo_url,
        shirt_number: homeRed[1].shirt_number ?? undefined,
      });
    }
    if (awayRed) {
      reds.push({
        minute: awayRed[0],
        extra_time: false,
        team_id: away,
        player_id: awayRed[1].id,
        player: awayRed[1].name,
        player_photo: awayRed[1].photo_url,
        shirt_number: awayRed[1].shirt_number ?? undefined,
      });
    }
    reds.sort((a, b) => a.minute - b.minute);

    // Players already banned for this match (focus team only).
    const unavailable: number[] = [];
    const bans: MatchBan[] = [];
    if (this.focus === home || this.focus === away) {
      for (const p of this.squad(this.focus)) {
        const s = this.suspensions.get(p.id);
        if (s && s[0] > 0) {
          unavailable.push(p.id);
          bans.push({
            player_id: p.id,
            player: p.name,
            player_photo: p.photo_url,
            reason: s[1],
            matches: s[0],
          });
        }
      }
    }

    // Per-match ratings + per-player event stats (conceded from the real score).
    const [hResult, aResult] =
      winner === home ? [1.0, 0.2] : winner === away ? [0.2, 1.0] : [0.6, 0.6];
    this.rateXi(homeXi, home, hResult, goals, aw);
    this.rateXi(awayXi, away, aResult, goals, hs);

    if (!knockout) this.addGroupResult(home, away, hs, aw);
    this.applyDrift(home, away, hs, aw);

    // Serve one match of existing bans, then book this match's reds.
    for (const team of [home, away]) {
      for (const p of this.squad(team)) {
        const s = this.suspensions.get(p.id);
        if (s && s[0] > 0) {
          s[0] -= 1;
        }
      }
    }
    for (const r of reds) {
      this.suspensions.set(r.player_id, [1, "red"]);
    }

    const momentum: Momentum | null =
      this.focus === home || this.focus === away
        ? { home: momentumSeries, away: momentumSeries.map((v) => 1 - v) }
        : null;

    const resultLabel = this.resultLabel(hs, aw, extraTime, penalties);
    const matchId = this.nextId;
    this.nextId += 1;
    const day = this.day;

    const pair = home < away ? `${home}|${away}` : `${away}|${home}`;
    const date = this.kickoffs.get(pair) ?? null;

    const rm: RunMatch = {
      id: matchId,
      day,
      stage_key: stageKey,
      stage_name: stageName,
      home_team_id: home,
      away_team_id: away,
      home_team_name: this.teamName(home),
      away_team_name: this.teamName(away),
      home_score: hs,
      away_score: aw,
      extra_time: extraTime,
      penalties,
      result_label: resultLabel,
      goals,
      reds,
      unavailable,
      date,
      momentum,
      bans,
      events,
      added_time_ht: addedHt,
      added_time_ft: addedFt,
      added_time_et1: extraTime ? addedEt1 : 0,
      added_time_et2: extraTime ? addedEt2 : 0,
    };
    this.order.push(matchId);
    this.matches.push(rm);
    return winner;
  }

  xiStrengthAdj(teamId: number, xi: SquadPlayer[]): number {
    const squad = this.squad(teamId);
    if (!squad.length || !xi.length) return 0;
    const sqAvg = squad.reduce((s, p) => s + p.overall, 0) / squad.length;
    const xiAvg = xi.reduce((s, p) => s + p.overall, 0) / xi.length;
    return clamp((xiAvg - sqAvg) * 0.15, -1.2, 1.2);
  }

  rateXi(xi: SquadPlayer[], teamId: number, result: number, goals: Goal[], conceded: number): void {
    const teamGoals = goals.filter((g) => g.team_id === teamId && !g.own_goal);
    for (const p of xi) {
      let perf = this.perfs.get(p.id);
      if (!perf) {
        perf = {
          name: p.name,
          team_id: teamId,
          position: p.position,
          photo: p.photo_url,
          games: 0,
          rating_sum: 0,
          goals: 0,
          assists: 0,
          clean_sheets: 0,
        };
        this.perfs.set(p.id, perf);
      }
      perf.games += 1;
      let rating = clamp(6.1 + result, 4.0, 10.0);
      if (p.position === "GK" && conceded === 0) {
        perf.clean_sheets += 1;
        rating += 0.8;
      }
      const scored = teamGoals.filter((g) => g.scorer_id === p.id).length;
      const assisted = teamGoals.filter((g) => g.assist_id === p.id).length;
      const own = goals.filter((g) => g.own_goal && g.scorer_id === p.id).length;
      perf.goals += scored;
      perf.assists += assisted;
      rating += scored * 1.2 + assisted * 0.5 - own * 1.0;
      perf.rating_sum += clamp(rating, 4.0, 10.0);
    }
  }

  addGroupResult(home: number, away: number, hs: number, aw: number): void {
    const [hp, ap] = hs > aw ? [3, 0] : hs < aw ? [0, 3] : [1, 1];
    for (const [team, gf, ga, pts] of [
      [home, hs, aw, hp],
      [away, aw, hs, ap],
    ] as Array<[number, number, number, number]>) {
      let row = this.standings.find((r) => r.team_id === team);
      if (!row) {
        row = { team_id: team, points: 0, gf: 0, ga: 0 };
        this.standings.push(row);
      }
      row.gf += gf;
      row.ga += ga;
      row.points += pts;
    }
  }

  applyDrift(home: number, away: number, hs: number, aw: number): void {
    const [hf, hm, af, am] = hs > aw ? [3, 4, -3, -5] : hs < aw ? [-3, -5, 3, 4] : [0, 1, 0, 1];
    for (const [team, f, m] of [
      [home, hf, hm],
      [away, af, am],
    ] as Array<[number, number, number]>) {
      this.formShift.set(team, clamp((this.formShift.get(team) ?? 0) + f, -50, 50));
      this.moraleShift.set(team, clamp((this.moraleShift.get(team) ?? 0) + m, -50, 50));
    }
  }

  // -------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------

  buildGroupMeta(): void {
    const out: GroupInfo[] = [];
    this.currentGroups.forEach((teams, gi) => {
      const runTeams: RunTeam[] = teams.map((t) => ({
        id: t,
        name: this.teamName(t),
        code: this.teamCode(t),
      }));
      out.push({ name: `Group ${String.fromCharCode(65 + gi)}`, teams: runTeams });
    });
    this.groups = out;
  }

  sortedTable(): StandingRow[] {
    const rows = this.standings.slice();
    const names = new Map<number, string>();
    for (const r of rows) names.set(r.team_id, this.teamName(r.team_id));
    rows.sort((x, y) => {
      if (y.points !== x.points) return y.points - x.points;
      if (gd(y) !== gd(x)) return gd(y) - gd(x);
      if (y.gf !== x.gf) return y.gf - x.gf;
      const nx = names.get(x.team_id) ?? "";
      const ny = names.get(y.team_id) ?? "";
      return nx < ny ? -1 : nx > ny ? 1 : 0;
    });
    return rows;
  }

  groupTables(): StandingRow[][] {
    const tables: StandingRow[][] = [];
    for (const group of this.currentGroups) {
      const rows = group
        .flatMap((t) => this.standings.filter((r) => r.team_id === t))
        .map((r) => ({ ...r }));
      tables.push(sortTable(rows));
    }
    return tables;
  }

  // -------------------------------------------------------------------
  // Awards
  // -------------------------------------------------------------------

  playerScore(p: Perf): number {
    const bonus = this.teamBonus.get(p.team_id) ?? 0;
    return p.rating_sum + p.goals * 2.2 + p.assists * 1.1 + p.clean_sheets + bonus;
  }

  medal(playerId: number, p: Perf): PlayerAward | null {
    if (p.games === 0) return null;
    return {
      player_id: playerId,
      name: p.name,
      team_id: p.team_id,
      team_name: this.teamName(p.team_id),
      position: p.position,
      games: p.games,
      goals: p.goals,
      assists: p.assists,
      score: this.playerScore(p),
      photo: p.photo,
    };
  }

  finalizeAwards(): Awards {
    const players = Array.from(this.perfs.entries());
    const byName = (a: [number, Perf], b: [number, Perf]) =>
      a[1].name < b[1].name ? -1 : a[1].name > b[1].name ? 1 : 0;
    players.sort((a, b) => {
      const sa = this.playerScore(a[1]);
      const sb = this.playerScore(b[1]);
      if (sb !== sa) return sb - sa;
      return byName(a, b);
    });
    const golden = players[0] ? this.medal(players[0][0], players[0][1]) : null;
    const silver = players[1] ? this.medal(players[1][0], players[1][1]) : null;
    const bronze = players[2] ? this.medal(players[2][0], players[2][1]) : null;

    const scorers = Array.from(this.perfs.entries()).filter(([, p]) => p.goals > 0);
    scorers.sort((a, b) => {
      if (b[1].goals !== a[1].goals) return b[1].goals - a[1].goals;
      if (b[1].assists !== a[1].assists) return b[1].assists - a[1].assists;
      return byName(a, b);
    });
    const topScorers: TopScorer[] = scorers.slice(0, 20).map(([id, p]) => ({
      player_id: id,
      name: p.name,
      team_id: p.team_id,
      team_name: this.teamName(p.team_id),
      position: p.position,
      goals: p.goals,
      assists: p.assists,
      photo: p.photo,
    }));

    return { golden, silver, bronze, top_scorers: topScorers };
  }

  avgMatchRatings(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [id, p] of this.perfs) {
      if (p.games > 0) {
        out[id] = Math.round((p.rating_sum / p.games) * 10) / 10;
      }
    }
    return out;
  }

  /** Full per-player stats for every player who took the field (games > 0). */
  allPlayerStats(): PlayerStat[] {
    const out: PlayerStat[] = [];
    for (const [id, p] of this.perfs) {
      if (p.games < 1) continue;
      out.push({
        player_id: id,
        name: p.name,
        team_id: p.team_id,
        team_name: this.teamName(p.team_id),
        position: p.position,
        photo: p.photo,
        games: p.games,
        goals: p.goals,
        assists: p.assists,
        rating: Math.round((p.rating_sum / p.games) * 10) / 10,
      });
    }
    out.sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name));
    return out;
  }

  bump(teamId: number, bonus: number): void {
    this.teamBonus.set(teamId, (this.teamBonus.get(teamId) ?? 0) + bonus);
  }

  // -------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------

  run(): void {
    const phases = this.oracle.phases;
    for (let idx = 0; idx < phases.length; idx++) {
      if (this.champion != null) break;
      const phase = phases[idx];
      if (phase.phase_type === "GROUP") this.playGroupPhase(phases, idx, phase);
      else this.playKnockoutPhase(phase.key, phase.name);
    }
  }

  playGroupPhase(phases: OraclePhase[], idx: number, phase: OraclePhase): void {
    this.playedGroups = true;
    this.standings = [];
    this.currentGroups = groupAssignments(
      this.oracle,
      phase,
      this.quals,
      isFirstGroupPhase(phases, idx),
    );
    if (!this.groupMetaBuilt) {
      this.buildGroupMeta();
      this.groupMetaBuilt = true;
    }

    const real = realGroupSchedule(this.oracle);
    const schedule: Array<Array<Array<[number, number]>>> = [];
    for (let gi = 0; gi < this.currentGroups.length; gi++) {
      const teams = this.currentGroups[gi];
      let byRound: Array<Array<[number, number]>>;
      if (real && gi < real.length) {
        byRound = real[gi];
      } else {
        byRound = [];
        for (const [h, a, round] of roundRobin(teams)) {
          const r = Math.max(round, 1);
          while (byRound.length < r) byRound.push([]);
          byRound[r - 1].push([h, a]);
        }
      }
      schedule.push(byRound);
    }
    const maxRounds = schedule.reduce((m, s) => Math.max(m, s.length), 0);
    for (let round = 0; round < maxRounds; round++) {
      this.day += 1;
      for (let gi = 0; gi < schedule.length; gi++) {
        const byRound = schedule[gi];
        if (round >= byRound.length) continue;
        for (const [h, a] of byRound[round]) {
          const stageName =
            phase.group_count === 1
              ? phase.name
              : `${phase.name} ${String.fromCharCode(65 + gi)}`;
          this.playMatch(h, a, phase.key, stageName, false);
        }
      }
    }

    if (phase.group_count === 1) {
      // League decider: the leader is the champion.
      const table = this.sortedTable();
      if (table.length > 0) {
        const top = table[0];
        const name = this.teamName(top.team_id);
        this.bump(top.team_id, 3.0);
        this.champion = name;
      }
      return;
    }

    const entry = nextEntry(phases, idx);
    const tables = this.groupTables();
    const [q, m] = advance(tables, entry);
    this.quals = q;
    this.groupCount = m;
  }

  playKnockoutPhase(key: string, name: string): void {
    const stageTeams = key === "THIRD" ? this.prevLosers.slice() : this.quals.slice();
    if (stageTeams.length === 0) throw new Error("no teams to enter the knockout stage");

    let n = 1;
    while (n * 2 <= stageTeams.length) n *= 2;
    const trimmed = stageTeams.slice(0, n);
    if (trimmed.length < 2) return;

    if (key === "THIRD") {
      // Both participants are semi-final losers → +1 podium credit each.
      const sf = [this.prevLosers[0], this.prevLosers[this.prevLosers.length - 1]];
      for (const team of sf) {
        if (team != null) this.bump(team, 1.0);
      }
    }

    let pairings: Array<[number, number]>;
    if (!this.playedGroups && this.prevWinners.length === 0) {
      pairings = seededPairings(trimmed);
    } else if (this.groupCount > 0 && this.prevWinners.length === 0) {
      pairings =
        trimmed.length === this.groupCount
          ? seededPairings(trimmed)
          : groupPairings(trimmed, this.groupCount);
    } else {
      pairings = nextPairings(trimmed);
    }

    this.day += 1;

    const winners: number[] = [];
    const losers: number[] = [];
    for (const [h, a] of pairings) {
      const w = this.playMatch(h, a, key, name, true);
      if (w === h || w == null) {
        winners.push(h);
        losers.push(a);
      } else {
        winners.push(a);
        losers.push(h);
      }
    }

    if (key === "F") {
      if (winners.length > 0) {
        const cname = this.teamName(winners[0]);
        this.bump(winners[0], 3.0);
        this.champion = cname;
      }
      if (losers.length > 0) this.bump(losers[0], 2.0);
    }

    this.prevWinners = winners;
    this.prevLosers = losers;
    if (key !== "THIRD") this.quals = this.prevWinners.slice();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));

/** Run the full tournament in the browser. Same oracle + seed → identical run. */
export function generateRun(oracle: Oracle, opts: RunOptions): RunPayload {
  const eng = new Engine(oracle, opts);
  eng.run();
  const run: RunPayload = {
    run_id: null,
    tournament_id: oracle.tournament.id,
    tournament_name: oracle.tournament.name,
    year: oracle.tournament.year,
    host: oracle.tournament.host,
    shirt_numbers: oracle.tournament.shirt_numbers,
    focus_team_id: opts.focus_team_id,
    seed: Number(eng.runSeed),
    order: eng.order,
    matches: eng.matches,
    groups: eng.groups,
    awards: eng.finalizeAwards(),
    champion: eng.champion,
    ratings: eng.avgMatchRatings(),
    player_stats: eng.allPlayerStats(),
  };
  return run;
}

/** Mint a random deterministic base seed. */
export function randomSeed(): number {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let x = 0n;
  for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(buf[i]);
  return Number(x | 1n);
}

// ---------------------------------------------------------------------------
// Single-match entry (used by the Lab quick-sim / calibration bench)
// ---------------------------------------------------------------------------

export interface LabPlayer {
  id: number;
  name: string;
  position: string;
  positions: string[];
  photo_url: string | null;
  shirt_number: number | null;
  overall: number;
  aggression: number;
  leadership: number | null;
}

export interface LabTeam {
  id: number;
  name: string;
  code: string | null;
  rating: number;
  pedigree: number;
  home_support: number;
  form: number;
  morale: number;
  players: LabPlayer[];
}

export interface LabMatchOptions {
  /** Play extra time when the score is level after 90 minutes. */
  extraTime?: boolean;
  /** Decide a still-level match on penalties (can be combined with extra time). */
  penalties?: boolean;
}

/** Play a single match between two squads with exactly the same engine the
 *  main app runs (XI picking, cards, live events and momentum for both
 *  sides). Same seed → same result. */
export function playLabMatch(
  tournamentId: number,
  year: number,
  home: LabTeam,
  away: LabTeam,
  seed: bigint,
  opts: LabMatchOptions = {},
): RunMatch {
  const oracle: Oracle = {
    tournament: { id: tournamentId, name: "Lab", year, host: "Lab", shirt_numbers: true },
    phases: [],
    participants: [home, away].map((t) => ({
      id: t.id,
      name: t.name,
      code: t.code,
      rating: t.rating,
      pedigree: t.pedigree,
      home_support: t.home_support,
      form: t.form,
      morale: t.morale,
    })),
    squads: {
      [home.id]: { generated: false, players: home.players },
      [away.id]: { generated: false, players: away.players },
    },
    groups: [],
    fixtures: [],
  };
  const eng = new Engine(oracle, { seed, focus_team_id: home.id });
  eng.playMatch(home.id, away.id, "LAB", "Lab match", !!opts.extraTime, !!opts.penalties);
  return eng.matches[0];
}