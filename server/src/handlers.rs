use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    error::{ApiError, ApiResult},
    fixture,
    models::{
        AddParticipants, CreateMatch, CreatePlayer, CreateTeam, CreateTournament, ImportPayload,
        Match, Participant, Phase, Player, SimulateOut, Team, Tournament,
    },
    sim::{self, SimRequest},
    Db,
};

pub async fn health() -> &'static str {
    "ok"
}

// ---------------------------------------------------------------------------
// Tournaments
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct TournamentDetail {
    id: i64,
    name: String,
    year: i32,
    host: String,
    winner: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    phases: Vec<Phase>,
}

impl TournamentDetail {
    fn from(t: Tournament, phases: Vec<Phase>) -> Self {
        TournamentDetail {
            id: t.id,
            name: t.name,
            year: t.year,
            host: t.host,
            winner: t.winner,
            start_date: t.start_date,
            end_date: t.end_date,
            phases,
        }
    }
}

fn map_tournament(r: &rusqlite::Row) -> rusqlite::Result<Tournament> {
    Ok(Tournament {
        id: r.get(0)?,
        name: r.get(1)?,
        year: r.get(2)?,
        host: r.get(3)?,
        winner: r.get(4)?,
        start_date: r.get(5)?,
        end_date: r.get(6)?,
    })
}

fn load_phases(conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<Vec<Phase>> {
    let mut stmt = conn.prepare(
        "SELECT id, tournament_id, seq, key, name, phase_type, group_count, entry_teams
         FROM tournament_phases WHERE tournament_id = ?1 ORDER BY seq",
    )?;
    let rows = stmt.query_map([id], |r| {
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
    rows.collect()
}

pub async fn list_tournaments(State(db): State<Db>) -> ApiResult<Json<Vec<Tournament>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, year, host, winner, start_date, end_date FROM tournaments ORDER BY year",
    )?;
    let rows = stmt.query_map([], map_tournament)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn get_tournament(State(db): State<Db>, Path(id): Path<i64>) -> ApiResult<Json<TournamentDetail>> {
    let conn = db.lock().unwrap();
    let t = conn
        .query_row(
            "SELECT id, name, year, host, winner, start_date, end_date FROM tournaments WHERE id = ?1",
            [id],
            map_tournament,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("tournament"))?;
    let phases = load_phases(&conn, id)?;
    Ok(Json(TournamentDetail::from(t, phases)))
}

pub async fn create_tournament(
    _user: AuthUser,
    State(db): State<Db>,
    Json(input): Json<CreateTournament>,
) -> ApiResult<(StatusCode, Json<Tournament>)> {
    let conn = db.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO tournaments (name, year, host, winner, start_date, end_date) VALUES (?1,?2,?3,?4,?5,?6)",
        params![input.name, input.year, input.host, input.winner, input.start_date, input.end_date],
    );
    match res {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            return Err(ApiError::Conflict("tournament already exists".into()))
        }
        Err(e) => return Err(e.into()),
    }
    let id = conn.last_insert_rowid();
    let t: Tournament = conn.query_row(
        "SELECT id, name, year, host, winner, start_date, end_date FROM tournaments WHERE id = ?1",
        [id],
        map_tournament,
    )?;
    Ok((StatusCode::CREATED, Json(t)))
}

pub async fn set_tournament_phases(
    _user: AuthUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
    Json(input): Json<crate::models::CreatePhases>,
) -> ApiResult<(StatusCode, Json<usize>)> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM tournament_phases WHERE tournament_id = ?1", [id])?;
    for (i, p) in input.phases.iter().enumerate() {
        conn.execute(
            "INSERT INTO tournament_phases (tournament_id, seq, key, name, phase_type, group_count, entry_teams)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![id, i as i32, p.key, p.name, p.phase_type, p.group_count, p.entry_teams],
        )?;
    }
    conn.execute("DELETE FROM matches WHERE tournament_id = ?1", [id])?;
    Ok((StatusCode::CREATED, Json(input.phases.len())))
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

pub async fn list_participants(State(db): State<Db>, Path(id): Path<i64>) -> ApiResult<Json<Vec<Participant>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.code, t.flag, t.rating, g.group_name
         FROM tournament_teams tt
         JOIN teams t ON t.id = tt.team_id
         LEFT JOIN tournament_groups g ON g.tournament_id = tt.tournament_id AND g.team_id = t.id
         WHERE tt.tournament_id = ?1
         ORDER BY g.group_name, t.name",
    )?;
    let rows = stmt.query_map([id], |r| {
        Ok(Participant {
            id: r.get(0)?,
            name: r.get(1)?,
            code: r.get(2)?,
            flag: r.get(3)?,
            rating: r.get(4)?,
            group_letter: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn add_participants(
    _user: AuthUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
    Json(input): Json<AddParticipants>,
) -> ApiResult<(StatusCode, Json<usize>)> {
    let conn = db.lock().unwrap();
    let mut inserted = 0usize;
    for p in &input.participations {
        conn.execute(
            "INSERT OR IGNORE INTO tournament_teams (tournament_id, team_id) VALUES (?1, ?2)",
            params![id, p.team_id],
        )?;
        if let Some(g) = &p.group_letter {
            conn.execute(
                "INSERT OR IGNORE INTO tournament_groups (tournament_id, group_name, team_id) VALUES (?1, ?2, ?3)",
                params![id, g, p.team_id],
            )?;
        }
        inserted += 1;
    }
    Ok((StatusCode::CREATED, Json(inserted)))
}

// ---------------------------------------------------------------------------
// Fixtures / matches
// ---------------------------------------------------------------------------

pub async fn list_matches(State(db): State<Db>, Path(id): Path<i64>) -> ApiResult<Json<Vec<Match>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.tournament_id, m.stage, m.round_num, m.matchday,
                m.home_team_id, m.away_team_id, m.kickoff,
                m.home_score, m.away_score, m.status,
                ht.name, at.name
         FROM matches m
         JOIN teams ht ON ht.id = m.home_team_id
         JOIN teams at ON at.id = m.away_team_id
         WHERE m.tournament_id = ?1
         ORDER BY m.stage, m.matchday, m.id",
    )?;
    let rows = stmt.query_map([id], map_match)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn create_matches(
    _user: AuthUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
    Json(input): Json<Vec<CreateMatch>>,
) -> ApiResult<(StatusCode, Json<usize>)> {
    let conn = db.lock().unwrap();
    for m in &input {
        conn.execute(
            "INSERT INTO matches (tournament_id, stage, round_num, matchday, home_team_id, away_team_id, kickoff, status)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'scheduled')",
            params![id, m.stage, m.round_num, m.matchday, m.home_team_id, m.away_team_id, m.kickoff],
        )?;
    }
    Ok((StatusCode::CREATED, Json(input.len())))
}

pub async fn generate_fixture(
    _user: AuthUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
) -> ApiResult<Json<usize>> {
    let conn = db.lock().unwrap();
    let inserted = fixture::generate(&conn, id)?;
    Ok(Json(inserted))
}

/// One-shot import of teams + players (as produced by the scraper).
pub async fn import_tournament(
    _user: AuthUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
    Json(payload): Json<ImportPayload>,
) -> ApiResult<(StatusCode, Json<usize>)> {
    let conn = db.lock().unwrap();
    let mut players = 0usize;
    for team in &payload.teams {
        let team_id = match crate::db::team_by_name(&conn, &team.name)? {
            Some(id) => id,
            None => {
                conn.execute(
                    "INSERT INTO teams (name, code, flag, rating) VALUES (?1, ?2, ?3, ?4)",
                    params![team.name, team.code, team.flag, team.rating],
                )?;
                conn.last_insert_rowid()
            }
        };
        conn.execute(
            "INSERT OR IGNORE INTO tournament_teams (tournament_id, team_id) VALUES (?1, ?2)",
            params![id, team_id],
        )?;
        if let Some(g) = &team.group_letter {
            conn.execute(
                "INSERT OR IGNORE INTO tournament_groups (tournament_id, group_name, team_id) VALUES (?1, ?2, ?3)",
                params![id, g, team_id],
            )?;
        }
        for p in &team.players {
            insert_player(&conn, id, team_id, p)?;
            players += 1;
        }
    }
    Ok((StatusCode::CREATED, Json(players)))
}

// ---------------------------------------------------------------------------
// Teams & players
// ---------------------------------------------------------------------------

pub async fn list_teams(State(db): State<Db>) -> ApiResult<Json<Vec<Team>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, name, code, flag, rating FROM teams ORDER BY name")?;
    let rows = stmt.query_map([], map_team)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn create_team(
    _user: AuthUser,
    State(db): State<Db>,
    Json(input): Json<CreateTeam>,
) -> ApiResult<(StatusCode, Json<Team>)> {
    let conn = db.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO teams (name, code, flag, rating) VALUES (?1,?2,?3,?4)",
        params![input.name, input.code, input.flag, input.rating],
    );
    match res {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            return Err(ApiError::Conflict("team already exists".into()))
        }
        Err(e) => return Err(e.into()),
    }
    let id = conn.last_insert_rowid();
    let team: Team = conn.query_row(
        "SELECT id, name, code, flag, rating FROM teams WHERE id = ?1",
        [id],
        map_team,
    )?;
    Ok((StatusCode::CREATED, Json(team)))
}

#[derive(Debug, Deserialize)]
pub struct PlayersQuery {
    #[serde(default)]
    pub tournament_id: Option<i64>,
}

/// Squad for a team. Optionally scoped to one tournament (`?tournament_id=`)
/// so position/shirt number come from that edition's call-up.
pub async fn list_players(
    State(db): State<Db>,
    Path(team_id): Path<i64>,
    Query(q): Query<PlayersQuery>,
) -> ApiResult<Json<Vec<Player>>> {
    let conn = db.lock().unwrap();
    let rows = match q.tournament_id {
        Some(tid) => {
            let mut stmt = conn.prepare(
                "SELECT p.id, p.name, p.dob, p.nationality, c.position, c.shirt_number,
                        p.pace, p.stamina, p.strength, p.dribbling, p.passing,
                        p.shooting, p.tackling, p.vision, p.positioning, p.composure,
                        p.reflexes, p.handling, p.kicking, p.aerial
                 FROM player_callups c
                 JOIN players p ON p.id = c.player_id
                 WHERE c.tournament_id = ?1 AND c.team_id = ?2
                 ORDER BY c.shirt_number IS NULL, c.shirt_number, p.name",
            )?;
            let rows = stmt.query_map(params![tid, team_id], map_player)?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT p.id, p.name, p.dob, p.nationality,
                        (SELECT c.position FROM player_callups c WHERE c.player_id = p.id ORDER BY c.id DESC LIMIT 1),
                        (SELECT c.shirt_number FROM player_callups c WHERE c.player_id = p.id ORDER BY c.id DESC LIMIT 1),
                        p.pace, p.stamina, p.strength, p.dribbling, p.passing,
                        p.shooting, p.tackling, p.vision, p.positioning, p.composure,
                        p.reflexes, p.handling, p.kicking, p.aerial
                 FROM players p
                 JOIN player_callups c ON c.player_id = p.id
                 WHERE c.team_id = ?1",
            )?;
            let rows = stmt.query_map([team_id], map_player)?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
    };
    Ok(Json(rows))
}

/// Register players for a team within a tournament.
#[derive(Debug, Deserialize)]
pub struct CreatePlayersIn {
    pub tournament_id: i64,
    pub players: Vec<CreatePlayer>,
}

pub async fn create_players(
    _user: AuthUser,
    State(db): State<Db>,
    Path(team_id): Path<i64>,
    Json(input): Json<CreatePlayersIn>,
) -> ApiResult<(StatusCode, Json<usize>)> {
    let conn = db.lock().unwrap();
    let mut count = 0usize;
    for p in &input.players {
        insert_player(&conn, input.tournament_id, team_id, p)?;
        count += 1;
    }
    Ok((StatusCode::CREATED, Json(count)))
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SimulateIn {
    #[serde(default)]
    pub focus_team_id: Option<i64>,
    #[serde(default)]
    pub focus_boost: i32,
}

pub async fn simulate_tournament(
    State(db): State<Db>,
    Path(id): Path<i64>,
    body: Option<Json<SimulateIn>>,
) -> ApiResult<Json<SimulateOut>> {
    let req = body
        .map(|Json(b)| SimRequest {
            focus_team_id: b.focus_team_id,
            focus_boost: b.focus_boost.clamp(0, 6),
        })
        .unwrap_or(SimRequest {
            focus_team_id: None,
            focus_boost: 0,
        });
    let conn = db.lock().unwrap();
    let out = sim::simulate_tournament(&conn, id, &req)?;
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn expand_attrs(p: &CreatePlayer) -> [i32; 14] {
    if let Some(rating) = p.rating {
        // scraper back-compat: spread a scalar rating across the attributes
        let r = rating.clamp(35, 99);
        [
            (r + p.name.len() as i32 % 9 - 4).clamp(30, 99),
            (r + p.name.len() as i32 % 7 - 3).clamp(30, 99),
            (r + 2).clamp(30, 99),
            (r + p.name.len() as i32 % 11 - 5).clamp(30, 99),
            r,
            if p.position == "GK" { 40 } else { (r + 1).clamp(30, 99) },
            if p.position == "GK" { 40 } else { (r - 1).clamp(30, 99) },
            (r + 1).clamp(30, 99),
            (r - 2).clamp(30, 99),
            (r + 2).clamp(30, 99),
            (r + 2).clamp(30, 99),
            (r + 1).clamp(30, 99),
            (r + 1).clamp(30, 99),
            r,
        ]
    } else {
        [
            p.pace.clamp(1, 99),
            p.stamina.clamp(1, 99),
            p.strength.clamp(1, 99),
            p.dribbling.clamp(1, 99),
            p.passing.clamp(1, 99),
            p.shooting.clamp(1, 99),
            p.tackling.clamp(1, 99),
            p.vision.clamp(1, 99),
            p.positioning.clamp(1, 99),
            p.composure.clamp(1, 99),
            p.reflexes.clamp(1, 99),
            p.handling.clamp(1, 99),
            p.kicking.clamp(1, 99),
            p.aerial.clamp(1, 99),
        ]
    }
}

fn insert_player(
    conn: &rusqlite::Connection,
    tournament_id: i64,
    team_id: i64,
    p: &CreatePlayer,
) -> rusqlite::Result<()> {
    let attrs = expand_attrs(p);
    conn.execute(
        "INSERT INTO players (name, pace, stamina, strength, dribbling, passing, shooting, tackling, vision, positioning, composure, reflexes, handling, kicking, aerial)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        rusqlite::params![p.name, attrs[0], attrs[1], attrs[2], attrs[3], attrs[4], attrs[5], attrs[6], attrs[7], attrs[8], attrs[9], attrs[10], attrs[11], attrs[12], attrs[13]],
    )?;
    let player_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT OR IGNORE INTO player_callups (player_id, tournament_id, team_id, position, shirt_number)
         VALUES (?1,?2,?3,?4,?5)",
        params![player_id, tournament_id, team_id, p.position, p.shirt_number],
    )?;
    Ok(())
}

fn map_team(r: &rusqlite::Row) -> rusqlite::Result<Team> {
    Ok(Team {
        id: r.get(0)?,
        name: r.get(1)?,
        code: r.get(2)?,
        flag: r.get(3)?,
        rating: r.get(4)?,
    })
}

#[allow(clippy::type_complexity)]
fn map_player(r: &rusqlite::Row) -> rusqlite::Result<Player> {
    Ok(Player {
        id: r.get(0)?,
        name: r.get(1)?,
        dob: r.get(2)?,
        nationality: r.get(3)?,
        position: r.get(4)?,
        shirt_number: r.get(5)?,
        pace: r.get(6)?,
        stamina: r.get(7)?,
        strength: r.get(8)?,
        dribbling: r.get(9)?,
        passing: r.get(10)?,
        shooting: r.get(11)?,
        tackling: r.get(12)?,
        vision: r.get(13)?,
        positioning: r.get(14)?,
        composure: r.get(15)?,
        reflexes: r.get(16)?,
        handling: r.get(17)?,
        kicking: r.get(18)?,
        aerial: r.get(19)?,
    })
}

fn map_match(r: &rusqlite::Row) -> rusqlite::Result<Match> {
    Ok(Match {
        id: r.get(0)?,
        tournament_id: r.get(1)?,
        stage: r.get(2)?,
        round_num: r.get(3)?,
        matchday: r.get(4)?,
        home_team_id: r.get(5)?,
        away_team_id: r.get(6)?,
        kickoff: r.get(7)?,
        home_score: r.get(8)?,
        away_score: r.get(9)?,
        status: r.get(10)?,
        home_team_name: r.get(11)?,
        away_team_name: r.get(12)?,
    })
}