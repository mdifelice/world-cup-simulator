use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    error::{ApiError, ApiResult},
    fixture::{self, Standing},
    models::{Phase, SimulateOut},
};

pub struct SimRequest {
    /// Focus team (the user's pick). Receives a tactical boost.
    pub focus_team_id: Option<i64>,
    pub focus_boost: i32,
}

// ---------------------------------------------------------------------------
// Simple PRNG (xorshift64), seeded from system time.
// ---------------------------------------------------------------------------
struct Rng(u64);

impl Rng {
    fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E3779B97F4A7C15)
            | 1;
        Rng(seed)
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn poisson(rng: &mut Rng, lambda: f64) -> i32 {
    if lambda <= 0.0 {
        return 0;
    }
    let l = lambda.exp();
    let mut k = 0;
    let mut p = 1.0;
    loop {
        k += 1;
        p *= rng.unit();
        if p <= l {
            break;
        }
        if k > 12 {
            return lambda.round() as i32;
        }
    }
    (k - 1).min(8)
}

// ---------------------------------------------------------------------------
// Attribute model
// ---------------------------------------------------------------------------

/// Attribute indexes — must line up with `models::ATTRIBUTES`.
const PACE: usize = 0;
const STAMINA: usize = 1;
const STRENGTH: usize = 2;
const DRIBBLING: usize = 3;
const PASSING: usize = 4;
const SHOOTING: usize = 5;
const TACKLING: usize = 6;
const VISION: usize = 7;
const POSITIONING: usize = 8;
const COMPOSURE: usize = 9;
const REFLEXES: usize = 10;
const HANDLING: usize = 11;
const AERIAL: usize = 13;
const DECISIONS: usize = 14;
const AGGRESSION: usize = 15;
const CONCENTRATION: usize = 16;
const LEADERSHIP: usize = 17;

const DEFAULT_ATTR: f64 = 60.0;

/// Attribute weights per granular position (manager-sim style). The weighted
/// average of a player's attributes *is* their overall rating.
fn position_weights(position: &str) -> &'static [(usize, f64)] {
    match position {
        "GK" => &[
            (REFLEXES, 0.22),
            (HANDLING, 0.18),
            (AERIAL, 0.15),
            (POSITIONING, 0.20),
            (COMPOSURE, 0.25),
            (DECISIONS, 0.05),
            (CONCENTRATION, 0.06),
            (LEADERSHIP, 0.04),
        ],
        "CB" => &[
            (TACKLING, 0.30),
            (POSITIONING, 0.20),
            (STRENGTH, 0.20),
            (PACE, 0.10),
            (COMPOSURE, 0.10),
            (PASSING, 0.10),
            (DECISIONS, 0.06),
            (AGGRESSION, 0.05),
            (CONCENTRATION, 0.07),
            (LEADERSHIP, 0.04),
        ],
        "LB" | "RB" => &[
            (STAMINA, 0.20),
            (PACE, 0.20),
            (TACKLING, 0.20),
            (POSITIONING, 0.15),
            (PASSING, 0.15),
            (DRIBBLING, 0.10),
            (DECISIONS, 0.05),
            (AGGRESSION, 0.04),
            (CONCENTRATION, 0.06),
        ],
        "LWB" | "RWB" => &[
            (PACE, 0.25),
            (STAMINA, 0.20),
            (PASSING, 0.15),
            (DRIBBLING, 0.15),
            (TACKLING, 0.15),
            (POSITIONING, 0.10),
            (DECISIONS, 0.05),
            (AGGRESSION, 0.04),
            (CONCENTRATION, 0.05),
        ],
        "CDM" => &[
            (TACKLING, 0.28),
            (PASSING, 0.20),
            (POSITIONING, 0.20),
            (STAMINA, 0.12),
            (COMPOSURE, 0.12),
            (VISION, 0.08),
            (DECISIONS, 0.06),
            (AGGRESSION, 0.07),
            (CONCENTRATION, 0.06),
            (LEADERSHIP, 0.05),
        ],
        "CM" => &[
            (PASSING, 0.30),
            (VISION, 0.20),
            (STAMINA, 0.15),
            (COMPOSURE, 0.15),
            (DRIBBLING, 0.10),
            (TACKLING, 0.10),
            (DECISIONS, 0.07),
            (CONCENTRATION, 0.05),
            (LEADERSHIP, 0.05),
        ],
        "CAM" => &[
            (PASSING, 0.25),
            (VISION, 0.25),
            (DRIBBLING, 0.20),
            (COMPOSURE, 0.15),
            (STAMINA, 0.15),
            (DECISIONS, 0.07),
            (CONCENTRATION, 0.05),
        ],
        "LM" | "RM" => &[
            (PACE, 0.20),
            (DRIBBLING, 0.20),
            (PASSING, 0.20),
            (STAMINA, 0.15),
            (VISION, 0.15),
            (SHOOTING, 0.10),
            (DECISIONS, 0.05),
            (CONCENTRATION, 0.05),
        ],
        "LW" | "RW" => &[
            (PACE, 0.25),
            (DRIBBLING, 0.25),
            (SHOOTING, 0.20),
            (PASSING, 0.10),
            (COMPOSURE, 0.10),
            (VISION, 0.10),
            (DECISIONS, 0.04),
            (CONCENTRATION, 0.04),
        ],
        "ST" | "CF" => &[
            (SHOOTING, 0.30),
            (PACE, 0.20),
            (DRIBBLING, 0.15),
            (POSITIONING, 0.15),
            (STRENGTH, 0.10),
            (COMPOSURE, 0.10),
            (DECISIONS, 0.07),
            (CONCENTRATION, 0.05),
            (LEADERSHIP, 0.03),
        ],
        _ => &[
            (PASSING, 0.4),
            (VISION, 0.3),
            (COMPOSURE, 0.3),
            (DECISIONS, 0.1),
            (CONCENTRATION, 0.1),
            (LEADERSHIP, 0.1),
        ],
    }
}

/// Position-weighted composite (0–100). Missing attributes default to 60.
pub fn composite_rating(position: &str, attrs: &[Option<i32>]) -> f64 {
    let mut num = 0.0;
    let mut den = 0.0;
    for (idx, w) in position_weights(position) {
        let v = attrs.get(*idx).copied().flatten().unwrap_or(60) as f64;
        num += v * w;
        den += w;
    }
    if den == 0.0 {
        DEFAULT_ATTR
    } else {
        num / den
    }
}

/// Average squad rating for a team within a tournament, computed from the
/// position-weighted attributes of its players. `None` if the team has no
/// registered players (caller falls back to `teams.rating`).
fn squad_rating(
    conn: &Connection,
    tournament_id: i64,
    team_id: i64,
) -> ApiResult<Option<f64>> {
    let mut stmt = conn.prepare(
        "SELECT c.position,
                p.pace, p.stamina, p.strength, p.dribbling, p.passing,
                p.shooting, p.tackling, p.vision, p.positioning, p.composure,
                p.reflexes, p.handling, p.kicking, p.aerial,
                p.decisions, p.aggression, p.concentration, p.leadership
         FROM player_callups c
         JOIN players p ON p.id = c.player_id
         WHERE c.tournament_id = ?1 AND c.team_id = ?2",
    )?;
    let rows = stmt
        .query_map(params![tournament_id, team_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                [
                    r.get::<_, Option<i32>>(1)?,
                    r.get::<_, Option<i32>>(2)?,
                    r.get::<_, Option<i32>>(3)?,
                    r.get::<_, Option<i32>>(4)?,
                    r.get::<_, Option<i32>>(5)?,
                    r.get::<_, Option<i32>>(6)?,
                    r.get::<_, Option<i32>>(7)?,
                    r.get::<_, Option<i32>>(8)?,
                    r.get::<_, Option<i32>>(9)?,
                    r.get::<_, Option<i32>>(10)?,
                    r.get::<_, Option<i32>>(11)?,
                    r.get::<_, Option<i32>>(12)?,
                    r.get::<_, Option<i32>>(13)?,
                    r.get::<_, Option<i32>>(14)?,
                    r.get::<_, Option<i32>>(15)?,
                    r.get::<_, Option<i32>>(16)?,
                    r.get::<_, Option<i32>>(17)?,
                    r.get::<_, Option<i32>>(18)?,
                ],
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if rows.is_empty() {
        return Ok(None);
    }
    let sum: f64 = rows
        .iter()
        .map(|(pos, attrs)| composite_rating(pos, attrs.as_slice()))
        .sum();
    Ok(Some(sum / rows.len() as f64))
}

fn team_rating(conn: &Connection, tournament_id: i64, team_id: i64) -> ApiResult<f64> {
    let base: Option<i32> = conn
        .query_row("SELECT rating FROM teams WHERE id = ?1", [team_id], |r| r.get(0))
        .optional()?;
    Ok(squad_rating(conn, tournament_id, team_id)?.unwrap_or(base.unwrap_or(70) as f64))
}

#[derive(Clone, Copy)]
struct TeamContext {
    pedigree: i32,
    home_support: i32,
    form: i32,
    morale: i32,
}

impl Default for TeamContext {
    fn default() -> Self {
        TeamContext {
            pedigree: 50,
            home_support: 50,
            form: 50,
            morale: 55,
        }
    }
}

fn team_context(conn: &Connection, team_id: i64) -> ApiResult<TeamContext> {
    let row: Option<(i32, i32, i32, i32)> = conn
        .query_row(
            "SELECT pedigree, home_support, form, morale FROM teams WHERE id = ?1",
            [team_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    Ok(row
        .map(|(pedigree, home_support, form, morale)| TeamContext {
            pedigree,
            home_support,
            form,
            morale,
        })
        .unwrap_or_default())
}

/// Average leadership of the squad (a captain-style proxy, since the actual XI
/// lives client-side). Defaults to 60 when no players are registered.
fn avg_leadership(conn: &Connection, tournament_id: i64, team_id: i64) -> ApiResult<f64> {
    let v: Option<f64> = conn
        .query_row(
            "SELECT COALESCE(AVG(COALESCE(p.leadership, 60)), 60) FROM player_callups c
             JOIN players p ON p.id = c.player_id
             WHERE c.tournament_id = ?1 AND c.team_id = ?2",
            params![tournament_id, team_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.unwrap_or(60.0))
}

/// Base match strength for a team: position-weighted squad attributes (or the
/// `teams.rating` column when no squad exists) folded with the team-level
/// attributes. Pedigree matters more in knockouts; home support is applied on
/// top for the home side in `simulate_one`.
fn base_strength(
    conn: &Connection,
    tournament_id: i64,
    team_id: i64,
    knockout: bool,
) -> ApiResult<f64> {
    let base = team_rating(conn, tournament_id, team_id)?;
    let ctx = team_context(conn, team_id)?;
    let lead = avg_leadership(conn, tournament_id, team_id)?;
    let form = (ctx.form as f64 - 50.0) * 0.06;
    let morale = (ctx.morale as f64 - 55.0) * 0.04;
    let pedigree = (ctx.pedigree as f64 - 50.0) * if knockout { 0.06 } else { 0.03 };
    let leadership = (lead - 60.0) * 0.05;
    Ok((base + form + morale + pedigree + leadership).clamp(40.0, 99.0))
}

// ---------------------------------------------------------------------------
// Match engine
// ---------------------------------------------------------------------------

const BASE_GOALS: f64 = 1.32;
const HOME_FACTOR: f64 = 1.10;

fn simulate_one(
    rng: &mut Rng,
    conn: &Connection,
    tournament_id: i64,
    home_id: i64,
    away_id: i64,
    home_boost: i32,
    away_boost: i32,
    knockout: bool,
) -> ApiResult<(i32, i32)> {
    let home_support = team_context(conn, home_id)?.home_support;
    let home = (base_strength(conn, tournament_id, home_id, knockout)?
        + f64::from(home_boost)
        + (home_support as f64 - 50.0) * 0.04)
        .min(99.0);
    let away = (base_strength(conn, tournament_id, away_id, knockout)?
        + f64::from(away_boost))
        .min(99.0);

    let home_xg = (BASE_GOALS * ((home - away) / 10.0).exp() * HOME_FACTOR).clamp(0.1, 4.5);
    let away_xg = (BASE_GOALS * ((away - home) / 10.0).exp()).clamp(0.1, 4.5);

    Ok((poisson(rng, home_xg), poisson(rng, away_xg)))
}

fn record(conn: &Connection, match_id: i64, hs: i32, as_: i32) -> ApiResult<()> {
    conn.execute(
        "UPDATE matches SET home_score = ?1, away_score = ?2, status = 'played' WHERE id = ?3",
        params![hs, as_, match_id],
    )?;
    Ok(())
}

/// Updates the dynamic team attributes (form, morale) after a played match.
fn apply_result(conn: &Connection, home: i64, away: i64, hs: i32, as_: i32) -> ApiResult<()> {
    let (hf, hm, af, am) = if hs > as_ {
        (3, 4, -3, -5)
    } else if hs < as_ {
        (-3, -5, 3, 4)
    } else {
        (0, 1, 0, 1)
    };
    conn.execute(
        "UPDATE teams SET form = MIN(99, MAX(0, form + ?1)), morale = MIN(99, MAX(0, morale + ?2)) WHERE id = ?3",
        params![hf, hm, home],
    )?;
    conn.execute(
        "UPDATE teams SET form = MIN(99, MAX(0, form + ?1)), morale = MIN(99, MAX(0, morale + ?2)) WHERE id = ?3",
        params![af, am, away],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

fn load_phases(conn: &Connection, tournament_id: i64) -> ApiResult<Vec<Phase>> {
    let mut stmt = conn.prepare(
        "SELECT id, tournament_id, seq, key, name, phase_type, group_count, entry_teams
         FROM tournament_phases WHERE tournament_id = ?1 ORDER BY seq",
    )?;
    let rows = stmt.query_map([tournament_id], |r| {
        Ok(Phase {
            id: r.get(0)?,
            tournament_id: r.get(1)?,
            seq: r.get(2)?,
            key: r.get(3)?,
            name: r.get(4)?,
            phase_type: r.get(5)?,
            group_count: r.get(6)?,
            entry_teams: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn participants(conn: &Connection, tournament_id: i64) -> ApiResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT t.id FROM tournament_teams tt
         JOIN teams t ON t.id = tt.team_id
         WHERE tt.tournament_id = ?1
         ORDER BY t.rating DESC",
    )?;
    let rows = stmt.query_map([tournament_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Plays every group match of a phase. Returns the sorted table(s) (group order).
fn play_group_phase(
    rng: &mut Rng,
    conn: &Connection,
    tournament_id: i64,
    phase: &Phase,
    qualifiers: &[i64],
    is_first_group: bool,
    focus: Option<i64>,
    boost: i32,
) -> ApiResult<(Vec<Vec<Standing>>, usize)> {
let groups: Vec<Vec<i64>> = if is_first_group {
    let loaded = fixture::load_groups(conn, tournament_id)?
        .into_iter()
        .map(|(_, t)| t)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>();
    if !loaded.is_empty() {
        loaded
    } else {
        // No manual groups assigned yet (tournament created via phases +
        // participants but never went through fixture generation): split the
        // seeded qualifiers evenly and persist them for the UI.
        let count = phase.group_count.unwrap_or(1).max(1) as usize;
        let per = qualifiers.len().div_ceil(count);
        let assigned: Vec<Vec<i64>> = qualifiers
            .chunks(per.max(1))
            .map(|c| c.to_vec())
            .collect();
        for (gi, teams) in assigned.iter().enumerate() {
            let letter = format!("{}", (b'A' + gi as u8) as char);
            for t in teams {
                conn.execute(
                    "INSERT OR IGNORE INTO tournament_groups (tournament_id, group_name, team_id) VALUES (?1, ?2, ?3)",
                    params![tournament_id, letter, t],
                )?;
            }
        }
        assigned
    }
} else if phase.group_count == Some(1) {
        vec![qualifiers.to_vec()]
    } else {
        // hypothetical second group stage: split the qualifiers evenly
        let count = phase.group_count.unwrap_or(1) as usize;
        let per = qualifiers.len().div_ceil(count);
        qualifiers
            .chunks(per)
            .map(|c| c.to_vec())
            .filter(|c| !c.is_empty())
            .collect()
    };
    if groups.is_empty() {
        return Err(ApiError::bad_request("group phase has no assigned groups"));
    }

    let mut tables = Vec::new();
    let mut simulated = 0usize;
    for teams in &groups {
        for (home, away, round) in fixture::round_robin(teams) {
            let hb = if Some(home) == focus { boost } else { 0 };
            let ab = if Some(away) == focus { boost } else { 0 };
            let (hs, as_) = simulate_one(rng, conn, tournament_id, home, away, hb, ab, false)?;
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM matches
                     WHERE tournament_id = ?1 AND stage = ?2 AND home_team_id = ?3 AND away_team_id = ?4 AND status = 'scheduled'",
                    params![tournament_id, phase.key, home, away],
                    |r| r.get(0),
                )
                .optional()?;
            match existing {
                Some(mid) => record(conn, mid, hs, as_)?,
                None => {
                    conn.execute(
                        "INSERT INTO matches (tournament_id, stage, round_num, matchday, home_team_id, away_team_id, home_score, away_score, status)
                         VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, 'played')",
                        params![tournament_id, phase.key, round as i32, home, away, hs, as_],
                    )?;
                }
            }
            apply_result(conn, home, away, hs, as_)?;
            simulated += 1;
        }
        tables.push(fixture::table_for(conn, tournament_id, &phase.key, teams)?);
    }
    Ok((tables, simulated))
}

/// Picks the teams advancing from a group phase: top `k` of each group, then
/// best remaining (for e.g. the four best third-placed teams).
fn advance(
    tables: &[Vec<Standing>],
    entry: usize,
) -> (Vec<i64>, usize) {
    let m = tables.len();
    if m == 0 {
        return (Vec::new(), 0);
    }
    let k = entry / m;
    let mut q = Vec::new();
    for rank in 0..k {
        for t in tables {
            if let Some(s) = t.get(rank) {
                q.push(s.team_id);
            }
        }
    }
    let fill = entry.saturating_sub(q.len());
    if fill > 0 {
        let mut rest: Vec<Standing> = tables
            .iter()
            .flat_map(|t| t.iter().skip(k).cloned())
            .collect();
        rest.sort_by(|x, y| {
            y.points
                .cmp(&x.points)
                .then(y.gd().cmp(&x.gd()))
                .then(y.gf.cmp(&x.gf))
        });
        for s in rest.into_iter().take(fill) {
            q.push(s.team_id);
        }
    }
    (q, m)
}

/// Pairings after a group phase: each group winner plays a runner-up from
/// another group; stragglers (best thirds) pair among themselves.
fn group_pairings(q: &[i64], m: usize) -> ApiResult<Vec<(i64, i64)>> {
    let n = q.len();
    if n % 2 != 0 {
        return Err(ApiError::bad_request("odd number of qualifiers for knockout"));
    }
    let winners = &q[..m.min(n)];
    let runners = &q[m.min(n)..(2 * m).min(n)];
    let rest = &q[2 * m.min(n)..];
    let mut out = Vec::new();
    for i in 0..winners.len() {
        if let Some(r) = runner_for(i, winners.len(), runners) {
            out.push((winners[i], r));
        } else {
            out.push((winners[i], winners[(i + 1) % winners.len()]));
        }
    }
    for c in rest.chunks(2) {
        if c.len() == 2 {
            out.push((c[0], c[1]));
        }
    }
    Ok(out)
}

/// Runner-up for group winner `i`, shifted so no winner faces its own group.
fn runner_for(i: usize, winners: usize, runners: &[i64]) -> Option<i64> {
    if runners.is_empty() {
        return None;
    }
    Some(runners[(i + 1) % winners.min(runners.len())])
}

/// Seeded bracket for a pure-knockout tournament: best vs worst, etc.
fn seeded_pairings(q: &[i64]) -> ApiResult<Vec<(i64, i64)>> {
    let n = q.len();
    if n % 2 != 0 {
        return Err(ApiError::bad_request("odd number of participants for knockout"));
    }
    Ok((0..n / 2)
        .map(|i| (q[i], q[n - 1 - i]))
        .collect())
}

fn next_pairings(winners: &[i64]) -> ApiResult<Vec<(i64, i64)>> {
    if winners.len() % 2 != 0 {
        return Err(ApiError::bad_request("odd number of winners for knockout round"));
    }
    Ok(winners.chunks(2).map(|c| (c[0], c[1])).collect())
}

/// Plays a knockout round. Existing scheduled matches are updated in-place,
/// otherwise new rows are created. Returns (winners, losers, count).
#[allow(clippy::too_many_arguments)]
fn knockout_stage(
    rng: &mut Rng,
    conn: &Connection,
    tournament_id: i64,
    stage: &str,
    pairings: &[(i64, i64)],
    focus: Option<i64>,
    boost: i32,
) -> ApiResult<(Vec<i64>, Vec<i64>, usize)> {
    let mut winners = Vec::new();
    let mut losers = Vec::new();
    for &(h, a) in pairings {
        let hb = if Some(h) == focus { boost } else { 0 };
        let ab = if Some(a) == focus { boost } else { 0 };
        let (hs, as_) = simulate_one(rng, conn, tournament_id, h, a, hb, ab, true)?;

        let (winner, loser) = if hs == as_ {
            if rng.unit() < 0.515 {
                (h, a)
            } else {
                (a, h)
            }
        } else if hs > as_ {
            (h, a)
        } else {
            (a, h)
        };
        winners.push(winner);
        losers.push(loser);

        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM matches
                 WHERE tournament_id = ?1 AND stage = ?2 AND home_team_id = ?3 AND away_team_id = ?4 AND status = 'scheduled'",
                params![tournament_id, stage, h, a],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(mid) => record(conn, mid, hs, as_)?,
            None => {
                conn.execute(
                    "INSERT INTO matches (tournament_id, stage, round_num, home_team_id, away_team_id, home_score, away_score, status)
                     VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, 'played')",
                    params![tournament_id, stage, h, a, hs, as_],
                )?;
            }
        }
        apply_result(conn, h, a, hs, as_)?;
    }
    Ok((winners, losers, pairings.len()))
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

pub fn simulate_tournament(
    conn: &Connection,
    tournament_id: i64,
    req: &SimRequest,
) -> ApiResult<SimulateOut> {
    let mut rng = Rng::new();
    let phases = load_phases(conn, tournament_id)?;
    if phases.is_empty() {
        return Err(ApiError::bad_request("tournament has no phases defined"));
    }

    conn.execute("BEGIN", [])?;
    let result = simulate_tournament_inner(conn, &mut rng, tournament_id, req, &phases);
    match result {
        Ok(out) => {
            conn.execute("COMMIT", [])?;
            Ok(out)
        }
        Err(e) => {
            conn.execute("ROLLBACK", [])?;
            Err(e)
        }
    }
}

fn simulate_tournament_inner(
    conn: &Connection,
    rng: &mut Rng,
    tournament_id: i64,
    req: &SimRequest,
    phases: &[Phase],
) -> ApiResult<SimulateOut> {

    // Re-simulation: reset everything, drop previously-drawn knockout rows.
    let played: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1 AND status = 'played'",
        [tournament_id],
        |r| r.get(0),
    )?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1",
        [tournament_id],
        |r| r.get(0),
    )?;
    if total > 0 && played == total {
        let group_keys: Vec<String> = phases
            .iter()
            .filter(|p| p.phase_type == "GROUP")
            .map(|p| p.key.clone())
            .collect();
        conn.execute(
            "UPDATE matches SET status = 'scheduled', home_score = NULL, away_score = NULL
             WHERE tournament_id = ?1 AND status = 'played'",
            [tournament_id],
        )?;
        conn.execute(
            "UPDATE teams SET form = 50, morale = 55
             WHERE id IN (SELECT team_id FROM tournament_teams WHERE tournament_id = ?1)",
            [tournament_id],
        )?;
        if !group_keys.is_empty() {
            let placeholders: Vec<String> = (0..group_keys.len())
                .map(|i| format!("?{}", i + 2))
                .collect();
            let sql = format!(
                "DELETE FROM matches WHERE tournament_id = ?1 AND stage NOT IN ({})",
                placeholders.join(",")
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut bind: Vec<&dyn rusqlite::ToSql> = vec![&tournament_id];
            for k in &group_keys {
                bind.push(k);
            }
            stmt.execute(rusqlite::params_from_iter(bind))?;
        } else {
            conn.execute("DELETE FROM matches WHERE tournament_id = ?1", [tournament_id])?;
        }
    }

    let team_ids = participants(conn, tournament_id)?;
    if team_ids.is_empty() {
        return Err(ApiError::bad_request("tournament has no participants"));
    }

    let mut simulated = 0usize;
    let mut qualifiers: Vec<i64> = team_ids.clone();
    let mut prev_winners: Vec<i64> = Vec::new();
    let mut prev_losers: Vec<i64> = Vec::new();
    let mut champion: Option<String> = None;
    let mut played_groups = false;
    let mut group_count = 0usize;

    for (idx, p) in phases.iter().enumerate() {
        if p.phase_type == "GROUP" {
            played_groups = true;
            let (tables, n) = play_group_phase(
                rng,
                conn,
                tournament_id,
                p,
                &qualifiers,
                is_first_group_phase(&phases, idx),
                req.focus_team_id,
                req.focus_boost,
            )?;
            simulated += n;

            if p.group_count == Some(1) {
                // League decider: the leader is the champion.
                let top = tables.first().and_then(|t| t.first().cloned());
                if let Some(s) = top {
                    champion = Some(team_name(conn, s.team_id)?);
                }
                break;
            }

            let entry = next_entry(&phases, idx) as usize;
            let (q, m) = advance(&tables, entry);
            qualifiers = q;
            group_count = m;
            continue;
        }

        // ---- KNOCKOUT phase ----
        let stage_teams: Vec<i64> = if p.key == "THIRD" {
            prev_losers.clone()
        } else {
            qualifiers.clone()
        };
        if stage_teams.is_empty() {
            return Err(ApiError::bad_request("no teams to enter the knockout stage"));
        }

        // Knockout rounds must have an even number of teams; if the previous
        // stage produced more (e.g. a sparsely-populated 2026 format), drop the
        // weakest until the field is the largest power of two that fits.
        let mut n = 1usize;
        while n * 2 <= stage_teams.len() {
            n *= 2;
        }
        let stage_teams = stage_teams[..n].to_vec();
        if stage_teams.len() < 2 {
            // Too few survivors left to field this round (degenerate field) —
            // skip it without disturbing the qualifier pool.
            continue;
        }

        let pairings: Vec<(i64, i64)> = if !played_groups && prev_winners.is_empty() {
            seeded_pairings(&stage_teams)?
        } else if group_count > 0 && prev_winners.is_empty() {
            group_pairings(&stage_teams, group_count)?
        } else {
            next_pairings(&stage_teams)?
        };

        let (winners, losers, n) = knockout_stage(
            rng,
            conn,
            tournament_id,
            &p.key,
            &pairings,
            req.focus_team_id,
            req.focus_boost,
        )?;
        simulated += n;

        if p.key == "F" {
            if let Some(w) = winners.first() {
                champion = Some(team_name(conn, *w)?);
            }
        }

        prev_winners = winners.clone();
        prev_losers = losers;
        if p.key != "THIRD" {
            qualifiers = prev_winners.clone();
        }
    }

    if let Some(c) = &champion {
        conn.execute(
            "UPDATE tournaments SET winner = ?1 WHERE id = ?2",
            params![c, tournament_id],
        )?;
    }

    Ok(SimulateOut {
        simulated,
        champion,
    })
}

fn is_first_group_phase(phases: &[Phase], idx: usize) -> bool {
    phases[..idx].iter().all(|p| p.phase_type != "GROUP")
}

fn next_entry(phases: &[Phase], idx: usize) -> i32 {
    phases
        .get(idx + 1)
        .and_then(|p| {
            if p.entry_teams.is_some() {
                p.entry_teams
            } else {
                p.group_count.map(|g| g * 4)
            }
        })
        .unwrap_or(8)
}

fn team_name(conn: &Connection, team_id: i64) -> rusqlite::Result<String> {
    conn.query_row("SELECT name FROM teams WHERE id = ?1", [team_id], |r| {
        r.get(0)
    })
}