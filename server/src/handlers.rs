use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;

use crate::{
    auth::AuthUser,
    error::{ApiError, ApiResult},
    fixture,
    models::{
        AddParticipants, CreateMatch, CreatePlayer, CreateTeam, CreateWorldCup, ImportPayload, Match,
        Participant, Player, SimulateOut, Team, WorldCup,
    },
    sim::{self, SimRequest},
    Db,
};

pub async fn health() -> &'static str {
    "ok"
}

// ---------------------------------------------------------------------------
// World Cups
// ---------------------------------------------------------------------------
pub async fn list_worldcups(State(db): State<Db>) -> ApiResult<Json<Vec<WorldCup>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, year, host, winner, start_date, end_date, group_count FROM worldcups ORDER BY year",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(WorldCup {
            id: r.get(0)?,
            year: r.get(1)?,
            host: r.get(2)?,
            winner: r.get(3)?,
            start_date: r.get(4)?,
            end_date: r.get(5)?,
            group_count: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn get_worldcup(State(db): State<Db>, Path(id): Path<i64>) -> ApiResult<Json<WorldCup>> {
    let conn = db.lock().unwrap();
    let wc = conn
        .query_row(
            "SELECT id, year, host, winner, start_date, end_date, group_count FROM worldcups WHERE id = ?1",
            [id],
            |r| {
                Ok(WorldCup {
                    id: r.get(0)?,
                    year: r.get(1)?,
                    host: r.get(2)?,
                    winner: r.get(3)?,
                    start_date: r.get(4)?,
                    end_date: r.get(5)?,
                    group_count: r.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("world cup"))?;
    Ok(Json(wc))
}

pub async fn create_worldcup(
    _user: AuthUser,
    State(db): State<Db>,
    Json(input): Json<CreateWorldCup>,
) -> ApiResult<(StatusCode, Json<WorldCup>)> {
    let conn = db.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO worldcups (year, host, winner, start_date, end_date, group_count) VALUES (?1,?2,?3,?4,?5,?6)",
        params![input.year, input.host, input.winner, input.start_date, input.end_date, input.group_count],
    );
    match res {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            return Err(ApiError::Conflict("world cup already exists".into()))
        }
        Err(e) => return Err(e.into()),
    }
    let id = conn.last_insert_rowid();
    let wc: WorldCup = conn
        .query_row(
            "SELECT id, year, host, winner, start_date, end_date, group_count FROM worldcups WHERE id = ?1",
            [id],
            |r| {
                Ok(WorldCup {
                    id: r.get(0)?,
                    year: r.get(1)?,
                    host: r.get(2)?,
                    winner: r.get(3)?,
                    start_date: r.get(4)?,
                    end_date: r.get(5)?,
                    group_count: r.get(6)?,
                })
            },
        )?;
    Ok((StatusCode::CREATED, Json(wc)))
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------
pub async fn list_participants(State(db): State<Db>, Path(wc_id): Path<i64>) -> ApiResult<Json<Vec<Participant>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.code, t.flag, t.rating, wc.group_letter
         FROM teams t
         JOIN worldcup_teams wc ON wc.team_id = t.id
         WHERE wc.worldcup_id = ?1 ORDER BY wc.group_letter, t.name",
    )?;
    let rows = stmt.query_map([wc_id], |r| {
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
    Path(wc_id): Path<i64>,
    Json(input): Json<AddParticipants>,
) -> ApiResult<(StatusCode, Json<usize>)> {
    let conn = db.lock().unwrap();
    let mut inserted = 0usize;
    for p in &input.participations {
        conn.execute(
            "INSERT OR IGNORE INTO worldcup_teams (worldcup_id, team_id, group_letter) VALUES (?1, ?2, ?3)",
            params![wc_id, p.team_id, p.group_letter],
        )?;
        inserted += 1;
    }
    Ok((StatusCode::CREATED, Json(inserted)))
}

// ---------------------------------------------------------------------------
// Fixtures / matches
// ---------------------------------------------------------------------------
pub async fn list_matches(State(db): State<Db>, Path(wc_id): Path<i64>) -> ApiResult<Json<Vec<Match>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.worldcup_id, m.stage, m.round_num, m.matchday,
                m.home_team_id, m.away_team_id, m.kickoff,
                m.home_score, m.away_score, m.status,
                ht.name, at.name
         FROM matches m
         JOIN teams ht ON ht.id = m.home_team_id
         JOIN teams at ON at.id = m.away_team_id
         WHERE m.worldcup_id = ?1
         ORDER BY m.stage, m.matchday, m.id",
    )?;
    let rows = stmt.query_map([wc_id], map_match)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn create_matches(
    _user: AuthUser,
    State(db): State<Db>,
    Path(wc_id): Path<i64>,
    Json(input): Json<Vec<CreateMatch>>,
) -> ApiResult<(StatusCode, Json<usize>)> {
    let conn = db.lock().unwrap();
    for m in &input {
        conn.execute(
            "INSERT INTO matches (worldcup_id, stage, round_num, matchday, home_team_id, away_team_id, kickoff, status)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'scheduled')",
            params![wc_id, m.stage, m.round_num, m.matchday, m.home_team_id, m.away_team_id, m.kickoff],
        )?;
    }
    Ok((StatusCode::CREATED, Json(input.len())))
}

pub async fn generate_fixture(
    _user: AuthUser,
    State(db): State<Db>,
    Path(wc_id): Path<i64>,
) -> ApiResult<Json<usize>> {
    let conn = db.lock().unwrap();
    let inserted = fixture::generate(&conn, wc_id)?;
    Ok(Json(inserted))
}

/// One-shot import of teams + players (as produced by the scraper).
pub async fn import_worldcup(
    _user: AuthUser,
    State(db): State<Db>,
    Path(wc_id): Path<i64>,
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
            "INSERT OR IGNORE INTO worldcup_teams (worldcup_id, team_id, group_letter) VALUES (?1, ?2, ?3)",
            params![wc_id, team_id, team.group_letter],
        )?;
        for p in &team.players {
            conn.execute(
                "INSERT OR IGNORE INTO players (team_id, name, position, shirt_number, rating) VALUES (?1,?2,?3,?4,?5)",
                params![team_id, p.name, p.position, p.shirt_number, p.rating],
            )?;
            players += 1;
        }
    }
    Ok((StatusCode::CREATED, Json(players)))
}

#[derive(Debug, Deserialize)]
pub struct SimulateIn {
    #[serde(default)]
    pub focus_team_id: Option<i64>,
    #[serde(default)]
    pub focus_boost: i32,
}

pub async fn simulate_worldcup(
    State(db): State<Db>,
    Path(wc_id): Path<i64>,
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
    let out = sim::simulate_worldcup(&conn, wc_id, &req)?;
    Ok(Json(out))
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

pub async fn list_players(State(db): State<Db>, Path(team_id): Path<i64>) -> ApiResult<Json<Vec<Player>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, team_id, name, position, shirt_number, rating FROM players WHERE team_id = ?1 ORDER BY rating DESC",
    )?;
    let rows = stmt.query_map([team_id], map_player)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn create_players(
    _user: AuthUser,
    State(db): State<Db>,
    Path(team_id): Path<i64>,
    Json(input): Json<Vec<CreatePlayer>>,
) -> ApiResult<(StatusCode, Json<usize>)> {
    let conn = db.lock().unwrap();
    for p in &input {
        conn.execute(
            "INSERT INTO players (team_id, name, position, shirt_number, rating) VALUES (?1,?2,?3,?4,?5)",
            params![team_id, p.name, p.position, p.shirt_number, p.rating],
        )?;
    }
    Ok((StatusCode::CREATED, Json(input.len())))
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------
fn map_team(r: &rusqlite::Row) -> rusqlite::Result<Team> {
    Ok(Team {
        id: r.get(0)?,
        name: r.get(1)?,
        code: r.get(2)?,
        flag: r.get(3)?,
        rating: r.get(4)?,
    })
}

fn map_player(r: &rusqlite::Row) -> rusqlite::Result<Player> {
    Ok(Player {
        id: r.get(0)?,
        team_id: r.get(1)?,
        name: r.get(2)?,
        position: r.get(3)?,
        shirt_number: r.get(4)?,
        rating: r.get(5)?,
    })
}

fn map_match(r: &rusqlite::Row) -> rusqlite::Result<Match> {
    Ok(Match {
        id: r.get(0)?,
        worldcup_id: r.get(1)?,
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