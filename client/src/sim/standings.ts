import type { RunMatch, RunPayload } from "../types";

export interface OverallRow {
  id: number;
  name: string;
  /** Sort bucket, lower is better. 0 = still alive, 1..4 = podium, then
   *  eliminated rounds (later round = lower bucket), worst for group exits. */
  bucket: number;
  /** Machine label for the bucket: "alive" | "champ" | "runnerup" |
   *  "third" | "fourth" | <eliminated stage key>. */
  bucketLabel: string;
  /** Display name of the round the team reached ("" for podium/alive). */
  reachedName: string;
  stage_key: string;
  p: number;
  w: number;
  d: number;
  l: number;
  gf: number;
  ga: number;
  gd: number;
  pts: number;
}

const winnerOf = (m: RunMatch): number | null =>
  m.penalties
    ? (m.penalties.winner_id ?? null)
    : m.home_score === m.away_score
      ? null
      : m.home_score > m.away_score
        ? m.home_team_id
        : m.away_team_id;

/** Overall (multi-phase) standings for a run: teams are ranked first by the
 *  round they reached (champion → runners-up → third/fourth → eliminated in
 *  later rounds → group exits), then by the classic group-stage tie-break
 *  (points, goal difference, goals scored) accumulated over every revealed
 *  match. Teams that are still alive float above the eliminated ones. */
export function computeOverallStandings(
  run: RunPayload,
  revealedIds: Set<number>,
): OverallRow[] {
  const byId = new Map(run.matches.map((m) => [m.id, m]));
  const ordered: RunMatch[] = [];
  for (const id of run.order) {
    const m = byId.get(id);
    if (m) ordered.push(m);
  }
  const revealed = new Set(revealedIds);

  const st = new Map<number, OverallRow>();
  const ensure = (id: number, name: string) => {
    let r = st.get(id);
    if (!r) {
      r = {
        id,
        name,
        bucket: 0,
        bucketLabel: "",
        reachedName: "",
        stage_key: "",
        p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0,
      };
      st.set(id, r);
    }
    return r;
  };

  const stageRank = new Map<string, number>();
  const stageName = new Map<string, string>();
  const lastMatch = new Map<number, RunMatch>();
  for (const m of ordered) {
    ensure(m.home_team_id, m.home_team_name);
    ensure(m.away_team_id, m.away_team_name);
    lastMatch.set(m.home_team_id, m);
    lastMatch.set(m.away_team_id, m);
    if (!stageRank.has(m.stage_key)) stageRank.set(m.stage_key, stageRank.size);
    stageName.set(m.stage_key, m.stage_name);
    if (!revealed.has(m.id)) continue;
    const h = st.get(m.home_team_id)!;
    const a = st.get(m.away_team_id)!;
    h.p += 1;
    a.p += 1;
    h.gf += m.home_score;
    h.ga += m.away_score;
    a.gf += m.away_score;
    a.ga += m.home_score;
    if (m.home_score > m.away_score) {
      h.w += 1; a.l += 1; h.pts += 3;
    } else if (m.home_score < m.away_score) {
      a.w += 1; h.l += 1; a.pts += 3;
    } else {
      h.d += 1; a.d += 1; h.pts += 1;
    }
  }
  for (const r of st.values()) r.gd = r.gf - r.ga;

  // A team that still has an unrevealed match is still in the tournament.
  const alive = new Set<number>();
  for (const m of ordered) {
    if (!revealed.has(m.id)) {
      alive.add(m.home_team_id);
      alive.add(m.away_team_id);
    }
  }

  const finalMatch = ordered.find((m) => m.stage_key === "F") ?? null;
  const thirdMatch = ordered.find((m) => m.stage_key === "THIRD") ?? null;
  const champId = finalMatch ? winnerOf(finalMatch) : null;
  const runnerId =
    finalMatch && champId != null
      ? champId === finalMatch.home_team_id
        ? finalMatch.away_team_id
        : finalMatch.home_team_id
      : null;
  const thirdId = thirdMatch ? winnerOf(thirdMatch) : null;
  const fourthId =
    thirdId != null && thirdMatch
      ? thirdId === thirdMatch.home_team_id
        ? thirdMatch.away_team_id
        : thirdMatch.home_team_id
      : null;

  // Knockout stages in chronological order (singling out the F/THIRD specials).
  const koKeys: string[] = [];
  for (const k of stageRank.keys()) {
    if (k !== "F" && k !== "THIRD") koKeys.push(k);
  }
  const n = koKeys.length;
  const bucketForStage = (key: string) => {
    const idx = koKeys.indexOf(key);
    if (idx >= 0) return 5 + (n - 1 - idx);
    return 5 + n; // group/league exits rank last
  };

  for (const [id, r] of st.entries()) {
    if (alive.has(id)) {
      r.bucket = 0;
      r.bucketLabel = "alive";
      continue;
    }
    if (id === champId) {
      r.bucket = 1;
      r.bucketLabel = "champ";
    } else if (id === runnerId) {
      r.bucket = 2;
      r.bucketLabel = "runnerup";
    } else if (thirdId != null && id === thirdId) {
      r.bucket = 3;
      r.bucketLabel = "third";
    } else if (fourthId != null && id === fourthId) {
      r.bucket = 4;
      r.bucketLabel = "fourth";
    } else {
      const lm = lastMatch.get(id);
      const key = lm?.stage_key ?? "GROUP";
      r.bucket = bucketForStage(key);
      r.stage_key = key;
      r.reachedName = stageName.get(key) ?? key;
      r.bucketLabel = key;
    }
  }

  const rows = [...st.values()];
  rows.sort(
    (a, b) =>
      a.bucket - b.bucket ||
      b.pts - a.pts ||
      b.gd - a.gd ||
      b.gf - a.gf ||
      a.name.localeCompare(b.name),
  );
  return rows;
}

/** 1-based final position of a team in the overall standings (null if the run
 *  has no record of the team). */
export function finalPositionOf(
  run: RunPayload,
  revealedIds: Set<number>,
  teamId: number,
): number | null {
  const rows = computeOverallStandings(run, revealedIds);
  const idx = rows.findIndex((r) => r.id === teamId);
  return idx >= 0 ? idx + 1 : null;
}