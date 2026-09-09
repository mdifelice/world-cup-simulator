use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    error::{ApiError, ApiResult},
    fixture::{self, R16_PAIRINGS},
    models::SimulateOut,
};

pub struct SimRequest {
    /// Focus team (the user's pick). Receives a formation-based rating boost.
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
// Team strength & match engine
// ---------------------------------------------------------------------------
fn team_rating(conn: &Connection, team_id: i64) -> ApiResult<f64> {
    let team_rating: Option<i32> = conn
        .query_row("SELECT rating FROM teams WHERE id = ?1", [team_id], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(team_rating) = team_rating else {
        return Err(ApiError::not_found("team"));
    };
    // If a real squad is loaded, prefer the average player rating.
    let avg: Option<Option<f64>> = conn
        .query_row(
            "SELECT AVG(rating) FROM players WHERE team_id = ?1 AND rating IS NOT NULL",
            [team_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(avg.flatten().unwrap_or(team_rating as f64))
}

const BASE_GOALS: f64 = 1.32;
const HOME_FACTOR: f64 = 1.10;

fn simulate_one(rng: &mut Rng, conn: &Connection, home_id: i64, away_id: i64, home_boost: i32, away_boost: i32) -> ApiResult<(i32, i32)> {
    let home = (team_rating(conn, home_id)? + f64::from(home_boost)).min(99.0);
    let away = (team_rating(conn, away_id)? + f64::from(away_boost)).min(99.0);

    // Expected goals model: logit-ish difference scaled, with home advantage.
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

fn sim_scheduled_matches(
    rng: &mut Rng,
    conn: &Connection,
    wc_id: i64,
    focus_team_id: Option<i64>,
    boost: i32,
) -> ApiResult<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, home_team_id, away_team_id FROM matches
         WHERE worldcup_id = ?1 AND status = 'scheduled' ORDER BY id",
    )?;
    let rows: Vec<(i64, i64, i64)> = stmt
        .query_map([wc_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;

    for (id, h, a) in &rows {
        let hb = if Some(*h) == focus_team_id { boost } else { 0 };
        let ab = if Some(*a) == focus_team_id { boost } else { 0 };
        let (hs, as_) = simulate_one(rng, conn, *h, *a, hb, ab)?;
        record(conn, *id, hs, as_)?;
    }
    Ok(rows.len())
}

/// Plays (or completes) a knockout stage. If a scheduled match already exists
/// for a pairing it is updated in-place, otherwise it is inserted.
fn knockout_stage(
    rng: &mut Rng,
    conn: &Connection,
    wc_id: i64,
    stage: &str,
    pairings: &[(i64, i64)],
    focus_team_id: Option<i64>,
    boost: i32,
) -> ApiResult<(Vec<i64>, Vec<i64>)> {
    let mut winners = Vec::new();
    let mut losers = Vec::new();

    for &(h, a) in pairings {
        let hb = if Some(h) == focus_team_id { boost } else { 0 };
        let ab = if Some(a) == focus_team_id { boost } else { 0 };
        let (hs, as_) = simulate_one(rng, conn, h, a, hb, ab)?;

        // A drawn knockout tie is decided on penalties (score line preserved).
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
                 WHERE worldcup_id = ?1 AND stage = ?2 AND home_team_id = ?3 AND away_team_id = ?4 AND status = 'scheduled'",
                params![wc_id, stage, h, a],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(mid) => record(conn, mid, hs, as_)?,
            None => {
                conn.execute(
                    "INSERT INTO matches (worldcup_id, stage, round_num, home_team_id, away_team_id, home_score, away_score, status)
                     VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, 'played')",
                    params![wc_id, stage, h, a, hs, as_],
                )?;
            }
        }
    }
    Ok((winners, losers))
}

pub fn simulate_worldcup(conn: &Connection, wc_id: i64, req: &SimRequest) -> ApiResult<SimulateOut> {
    let mut rng = Rng::new();

    // Re-simulation: every match already played → reset the tournament.
    let played: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE worldcup_id = ?1 AND status = 'played'",
        [wc_id],
        |r| r.get(0),
    )?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE worldcup_id = ?1",
        [wc_id],
        |r| r.get(0),
    )?;
    if total > 0 && played == total {
        conn.execute(
            "DELETE FROM matches WHERE worldcup_id = ?1 AND stage != 'GROUP'",
            [wc_id],
        )?;
        conn.execute(
            "UPDATE matches SET status = 'scheduled', home_score = NULL, away_score = NULL WHERE worldcup_id = ?1",
            [wc_id],
        )?;
    }

    let mut simulated = 0usize;

    // 1. Group stage.
    simulated += sim_scheduled_matches(&mut rng, conn, wc_id, req.focus_team_id, req.focus_boost)?;

    // 2. Standings → Round of 16 (real bracket: 1A-2B, 1C-2D, ...).
    let standings = fixture::standings(conn, wc_id)?;
    if standings.is_empty() {
        return Err(ApiError::bad_request("no groups/standings available"));
    }
    let r16: Vec<(i64, i64)> = R16_PAIRINGS
        .iter()
        .map(|(w, r)| {
            let winners = &standings[*w];
            let runners = &standings[*r];
            if winners.len() < 2 || runners.len() < 2 {
                return Err(ApiError::bad_request("not enough teams per group"));
            }
            Ok((winners[0].team_id, runners[1].team_id))
        })
        .collect::<ApiResult<_>>()?;

    let (r16w, _) = knockout_stage(&mut rng, conn, wc_id, "R16", &r16, req.focus_team_id, req.focus_boost)?;
    simulated += r16.len();

    // 3. Quarter-finals.
    let qf_pairs = next_pairings(&r16w);
    simulated += qf_pairs.len();
    let (qfw, _) = knockout_stage(&mut rng, conn, wc_id, "QF", &qf_pairs, req.focus_team_id, req.focus_boost)?;

    // 4. Semi-finals (containers computed from QF winners).
    let (sfw, sfl) = knockout_stage(&mut rng, conn, wc_id, "SF", &next_pairings(&qfw), req.focus_team_id, req.focus_boost)?;
    simulated += 2;

    // 5. Third-place match (the two SF losers).
    simulated += knockout_stage(&mut rng, conn, wc_id, "ThirdPlace", &[(sfl[0], sfl[1])], req.focus_team_id, req.focus_boost)?.0.len();

    // 6. The Final.
    let (fw, _) = knockout_stage(&mut rng, conn, wc_id, "Final", &[(sfw[0], sfw[1])], req.focus_team_id, req.focus_boost)?;
    simulated += 1;

    let champion_name: String = conn.query_row(
        "SELECT t.name FROM teams t WHERE t.id = ?1",
        [fw[0]],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE worldcups SET winner = ?1 WHERE id = ?2",
        params![champion_name, wc_id],
    )?;

    Ok(SimulateOut { simulated, champion: Some(champion_name) })
}

fn next_pairings(winners: &[i64]) -> Vec<(i64, i64)> {
    winners.chunks(2).map(|c| (c[0], c[1])).collect()
}