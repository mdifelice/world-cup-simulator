use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    auth::OptionalUser,
    error::{ApiError, ApiResult},
    fixture,
    models::{
        AddParticipants, CreateMatch, CreatePlayer, CreateTeam, CreateTournament, GroupLetter,
        ImportPayload, Match, Participant, Phase, Player, Team, Tournament, UpdateMatch,
        UpdatePlayer, UpdateTeam, UpdateTournament,
    },
    names,
    Db,
};

pub async fn health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
pub struct PhotoIn {
    pub data: String,
}

/// Upload a player photo as a base64 data URL; the bytes are stored under
/// `data/photos/` and served back through the existing `/photos` static route.
pub async fn upload_photo(
    _user: OptionalUser,
    Json(input): Json<PhotoIn>,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    let url = crate::db::save_photo(&input.data).map_err(ApiError::bad_request)?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "url": url }))))
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
    shirt_numbers: bool,
    logo: Option<String>,
    from_seed: bool,
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
            shirt_numbers: t.shirt_numbers,
            logo: t.logo,
            from_seed: t.from_seed,
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
        shirt_numbers: r.get::<_, i32>(7)? != 0,
        logo: r.get(8)?,
        ready: false,
        from_seed: r.get::<_, i32>(9)? != 0,
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

/// Editions that can be launched as new tournaments. Every other edition is
/// still browsable (history/table/results) but won't be offered as playable.
const PLAYABLE_YEARS: &[i32] = &[2022, 2026];

pub async fn list_tournaments(State(db): State<Db>) -> ApiResult<Json<Vec<Tournament>>> {
    let conn = db.lock().unwrap();
    let years = PLAYABLE_YEARS
        .iter()
        .map(|y| y.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT t.id, t.name, t.year, t.host, t.winner, t.start_date, t.end_date, t.shirt_numbers, t.logo, t.from_seed,
                (SELECT COUNT(*) FROM tournament_teams WHERE tournament_id = t.id) > 0
            AND (SELECT COUNT(*) FROM matches WHERE tournament_id = t.id) > 0
            AND t.year IN ({years}) AS ready
         FROM tournaments t ORDER BY t.year DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_tournament_ready)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

fn map_tournament_ready(r: &rusqlite::Row) -> rusqlite::Result<Tournament> {
    Ok(Tournament {
        id: r.get(0)?,
        name: r.get(1)?,
        year: r.get(2)?,
        host: r.get(3)?,
        winner: r.get(4)?,
        start_date: r.get(5)?,
        end_date: r.get(6)?,
        shirt_numbers: r.get(7)?,
        logo: r.get(8)?,
        ready: r.get(10)?,
        from_seed: r.get::<_, i32>(9)? != 0,
    })
}

pub async fn get_tournament(State(db): State<Db>, Path(id): Path<i64>) -> ApiResult<Json<TournamentDetail>> {
    let conn = db.lock().unwrap();
    let t = conn
        .query_row(
            "SELECT id, name, year, host, winner, start_date, end_date, shirt_numbers, logo, from_seed FROM tournaments WHERE id = ?1",
            [id],
            map_tournament,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("tournament"))?;
    let phases = load_phases(&conn, id)?;
    Ok(Json(TournamentDetail::from(t, phases)))
}

pub async fn create_tournament(
    _user: OptionalUser,
    State(db): State<Db>,
    Json(input): Json<CreateTournament>,
) -> ApiResult<(StatusCode, Json<Tournament>)> {
    let conn = db.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO tournaments (name, year, host, winner, start_date, end_date, shirt_numbers, logo) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![input.name, input.year, input.host, input.winner, input.start_date, input.end_date, input.shirt_numbers, input.logo],
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
        "SELECT id, name, year, host, winner, start_date, end_date, shirt_numbers, logo, from_seed FROM tournaments WHERE id = ?1",
        [id],
        map_tournament,
    )?;
    Ok((StatusCode::CREATED, Json(t)))
}

#[derive(Debug, Deserialize)]
pub struct ForkBody {
    pub year: i32,
}

/// Duplicate a tournament (meta, phases, participants, groups, group fixtures
/// and every call-up) into a brand-new editable edition at a caller-chosen
/// year. Teams and players are shared globally, so no rows are re-created.
pub async fn fork_tournament(
    _user: OptionalUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
    Json(body): Json<ForkBody>,
) -> ApiResult<(StatusCode, Json<TournamentDetail>)> {
    let conn = db.lock().unwrap();
    if conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tournaments WHERE year = ?1)",
            [body.year],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false)
    {
        return Err(ApiError::Conflict("a tournament with that year already exists".into()));
    }
    let src: Tournament = conn
        .query_row(
            "SELECT id, name, year, host, winner, start_date, end_date, shirt_numbers, logo, from_seed FROM tournaments WHERE id = ?1",
            [id],
            map_tournament,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("tournament"))?;
    conn.execute(
        "INSERT INTO tournaments (name, year, host, winner, start_date, end_date, shirt_numbers, logo, from_seed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)",
        params![
            src.name,
            body.year,
            src.host,
            src.winner,
            src.start_date,
            src.end_date,
            src.shirt_numbers,
            src.logo
        ],
    )?;
    let new_id = conn.last_insert_rowid();
    let _ = conn.execute(
        "INSERT INTO tournament_phases (tournament_id, seq, key, name, phase_type, group_count, entry_teams)
         SELECT ?1, seq, key, name, phase_type, group_count, entry_teams
         FROM tournament_phases WHERE tournament_id = ?2",
        params![new_id, id],
    )?;
    let _ = conn.execute(
        "INSERT INTO tournament_teams (tournament_id, team_id, rating)
         SELECT ?1, team_id, rating FROM tournament_teams WHERE tournament_id = ?2",
        params![new_id, id],
    )?;
    let _ = conn.execute(
        "INSERT INTO tournament_groups (tournament_id, group_name, team_id)
         SELECT ?1, group_name, team_id FROM tournament_groups WHERE tournament_id = ?2",
        params![new_id, id],
    )?;
    let _ = conn.execute(
        "INSERT INTO matches (tournament_id, stage, round_num, matchday, home_team_id, away_team_id, kickoff, status)
         SELECT ?1, stage, round_num, matchday, home_team_id, away_team_id, kickoff, status
         FROM matches WHERE tournament_id = ?2",
        params![new_id, id],
    )?;
    let _ = conn.execute(
        "INSERT INTO player_callups (player_id, tournament_id, team_id, position, positions, shirt_number)
         SELECT player_id, ?1, team_id, position, positions, shirt_number
         FROM player_callups WHERE tournament_id = ?2",
        params![new_id, id],
    )?;
    let phases = load_phases(&conn, new_id)?;
    Ok((
        StatusCode::CREATED,
        Json(TournamentDetail::from(
            Tournament {
                id: new_id,
                name: src.name,
                year: body.year,
                host: src.host,
                winner: src.winner,
                start_date: src.start_date,
                end_date: src.end_date,
                shirt_numbers: src.shirt_numbers,
                logo: src.logo,
                ready: false,
                from_seed: false,
            },
            phases,
        )),
    ))
}

pub async fn set_tournament_phases(
    _user: OptionalUser,
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

pub async fn update_tournament(
    _user: OptionalUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
    Json(input): Json<UpdateTournament>,
) -> ApiResult<Json<Tournament>> {
    let conn = db.lock().unwrap();
    if !conn
        .query_row("SELECT EXISTS(SELECT 1 FROM tournaments WHERE id = ?1)", [id], |r| r.get(0))
        .optional()?
        .unwrap_or(false)
    {
        return Err(ApiError::not_found("tournament"));
    }
    let (name, year, host, winner, start_date, end_date, shirt_numbers, logo): (
        String,
        i32,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
        Option<String>,
    ) = conn.query_row(
        "SELECT name, year, host, winner, start_date, end_date, shirt_numbers, logo FROM tournaments WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    )?;
    conn.execute(
        "UPDATE tournaments SET name = ?1, year = ?2, host = ?3, winner = ?4, start_date = ?5, end_date = ?6, shirt_numbers = ?7, logo = ?8 WHERE id = ?9",
        params![
            input.name.unwrap_or(name),
            input.year.unwrap_or(year),
            input.host.unwrap_or(host),
            input.winner.or(winner),
            input.start_date.or(start_date),
            input.end_date.or(end_date),
            input.shirt_numbers.unwrap_or(shirt_numbers),
            input.logo.or(logo),
            id,
        ],
    )?;
    let t: Tournament = conn.query_row(
        "SELECT id, name, year, host, winner, start_date, end_date, shirt_numbers, logo FROM tournaments WHERE id = ?1",
        [id],
        map_tournament,
    )?;
    Ok(Json(t))
}

pub async fn delete_tournament(
    _user: OptionalUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    let conn = db.lock().unwrap();
    let n = conn.execute("DELETE FROM tournaments WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(ApiError::not_found("tournament"));
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

pub async fn list_participants(State(db): State<Db>, Path(id): Path<i64>) -> ApiResult<Json<Vec<Participant>>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.code, t.flag, COALESCE(tt.rating, t.rating), g.group_name,
                t.pedigree, t.home_support, t.form, t.morale
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
            pedigree: r.get(6)?,
            home_support: r.get(7)?,
            form: r.get(8)?,
            morale: r.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn add_participants(
    _user: OptionalUser,
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

/// Edit a participant's group placement (replace its single group row).
pub async fn update_participant(
    _user: OptionalUser,
    State(db): State<Db>,
    Path((id, team_id)): Path<(i64, i64)>,
    Json(input): Json<GroupLetter>,
) -> ApiResult<(StatusCode, Json<Participant>)> {
    let conn = db.lock().unwrap();
    if !conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tournament_teams WHERE tournament_id = ?1 AND team_id = ?2)",
            params![id, team_id],
            |r| r.get(0),
        )?
    {
        return Err(ApiError::not_found("participant"));
    }
    conn.execute(
        "DELETE FROM tournament_groups WHERE tournament_id = ?1 AND team_id = ?2",
        params![id, team_id],
    )?;
    if let Some(g) = &input.group_letter {
        conn.execute(
            "INSERT OR IGNORE INTO tournament_groups (tournament_id, group_name, team_id) VALUES (?1, ?2, ?3)",
            params![id, g, team_id],
        )?;
    }
    let p: Participant = conn.query_row(
        "SELECT t.id, t.name, t.code, t.flag, COALESCE(tt.rating, t.rating), g.group_name,
                t.pedigree, t.home_support, t.form, t.morale
         FROM tournament_teams tt
         JOIN teams t ON t.id = tt.team_id
         LEFT JOIN tournament_groups g ON g.tournament_id = tt.tournament_id AND g.team_id = t.id
         WHERE tt.tournament_id = ?1 AND t.id = ?2",
        params![id, team_id],
        |r| {
            Ok(Participant {
                id: r.get(0)?,
                name: r.get(1)?,
                code: r.get(2)?,
                flag: r.get(3)?,
                rating: r.get(4)?,
                group_letter: r.get(5)?,
                pedigree: r.get(6)?,
                home_support: r.get(7)?,
                form: r.get(8)?,
                morale: r.get(9)?,
            })
        },
    )?;
    Ok((StatusCode::OK, Json(p)))
}

/// Remove a team from a tournament: membership, group placement, call-ups and
/// any fixtures the team appears in are all dropped.
pub async fn delete_participant(
    _user: OptionalUser,
    State(db): State<Db>,
    Path((id, team_id)): Path<(i64, i64)>,
) -> ApiResult<StatusCode> {
    let conn = db.lock().unwrap();
    let n = conn.execute(
        "DELETE FROM tournament_teams WHERE tournament_id = ?1 AND team_id = ?2",
        params![id, team_id],
    )?;
    if n == 0 {
        return Err(ApiError::not_found("participant"));
    }
    conn.execute(
        "DELETE FROM tournament_groups WHERE tournament_id = ?1 AND team_id = ?2",
        params![id, team_id],
    )?;
    conn.execute(
        "DELETE FROM player_callups WHERE tournament_id = ?1 AND team_id = ?2",
        params![id, team_id],
    )?;
    conn.execute(
        "DELETE FROM matches WHERE tournament_id = ?1 AND (home_team_id = ?2 OR away_team_id = ?2)",
        params![id, team_id],
    )?;
    Ok(StatusCode::NO_CONTENT)
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
    _user: OptionalUser,
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

pub async fn update_match(
    _user: OptionalUser,
    State(db): State<Db>,
    Path((id, match_id)): Path<(i64, i64)>,
    Json(input): Json<UpdateMatch>,
) -> ApiResult<(StatusCode, Json<Match>)> {
    let conn = db.lock().unwrap();
    let n = conn.execute(
        "UPDATE matches SET stage = ?1, round_num = ?2, matchday = ?3, home_team_id = ?4, away_team_id = ?5, kickoff = ?6, status = 'scheduled'
         WHERE id = ?7 AND tournament_id = ?8",
        params![
            input.stage,
            input.round_num,
            input.matchday,
            input.home_team_id,
            input.away_team_id,
            input.kickoff,
            match_id,
            id
        ],
    )?;
    if n == 0 {
        return Err(ApiError::not_found("match"));
    }
    let m: Match = conn.query_row(
        "SELECT m.id, m.tournament_id, m.stage, m.round_num, m.matchday,
                m.home_team_id, m.away_team_id, m.kickoff,
                m.home_score, m.away_score, m.status,
                ht.name, at.name
         FROM matches m
         JOIN teams ht ON ht.id = m.home_team_id
         JOIN teams at ON at.id = m.away_team_id
         WHERE m.id = ?1",
        [match_id],
        map_match,
    )?;
    Ok((StatusCode::OK, Json(m)))
}

pub async fn delete_match(
    _user: OptionalUser,
    State(db): State<Db>,
    Path((id, match_id)): Path<(i64, i64)>,
) -> ApiResult<StatusCode> {
    let conn = db.lock().unwrap();
    let n = conn.execute(
        "DELETE FROM matches WHERE id = ?1 AND tournament_id = ?2",
        params![match_id, id],
    )?;
    if n == 0 {
        return Err(ApiError::not_found("match"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn generate_fixture(
    _user: OptionalUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
) -> ApiResult<Json<usize>> {
    let conn = db.lock().unwrap();
    let inserted = fixture::generate(&conn, id)?;
    Ok(Json(inserted))
}

/// One-shot import of teams + players (as produced by the scraper).
pub async fn import_tournament(
    _user: OptionalUser,
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
                let fields = crate::models::TeamStatsFields {
                    pedigree: team.pedigree.unwrap_or_else(|| crate::models::team_defaults(team.rating).pedigree),
                    home_support: team.home_support.unwrap_or_else(|| crate::models::team_defaults(team.rating).home_support),
                    form: team.form.unwrap_or_else(|| crate::models::team_defaults(team.rating).form),
                    morale: team.morale.unwrap_or_else(|| crate::models::team_defaults(team.rating).morale),
                };
                crate::db::insert_team(&conn, &team.name, team.code.as_deref(), team.flag.as_deref(), team.rating, Some(fields))?
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
    let mut stmt = conn.prepare("SELECT id, name, code, flag, rating, pedigree, home_support, form, morale FROM teams ORDER BY name")?;
    let rows = stmt.query_map([], map_team)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(Json(out))
}

pub async fn create_team(
    _user: OptionalUser,
    State(db): State<Db>,
    Json(input): Json<CreateTeam>,
) -> ApiResult<(StatusCode, Json<Team>)> {
    let conn = db.lock().unwrap();
    let fields = crate::models::TeamStatsFields {
        pedigree: input
            .pedigree
            .unwrap_or_else(|| crate::models::team_defaults(input.rating).pedigree),
        home_support: input
            .home_support
            .unwrap_or_else(|| crate::models::team_defaults(input.rating).home_support),
        form: input
            .form
            .unwrap_or_else(|| crate::models::team_defaults(input.rating).form),
        morale: input
            .morale
            .unwrap_or_else(|| crate::models::team_defaults(input.rating).morale),
    };
    let res = crate::db::insert_team(
        &conn,
        &input.name,
        input.code.as_deref(),
        input.flag.as_deref(),
        input.rating,
        Some(fields),
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
        "SELECT id, name, code, flag, rating, pedigree, home_support, form, morale FROM teams WHERE id = ?1",
        [id],
        map_team,
    )?;
    Ok((StatusCode::CREATED, Json(team)))
}

pub async fn update_team(
    _user: OptionalUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
    Json(input): Json<UpdateTeam>,
) -> ApiResult<Json<Team>> {
    let conn = db.lock().unwrap();
    if !conn
        .query_row("SELECT EXISTS(SELECT 1 FROM teams WHERE id = ?1)", [id], |r| r.get(0))
        .optional()?
        .unwrap_or(false)
    {
        return Err(ApiError::not_found("team"));
    }
    let (name, code, flag, rating, pedigree, home_support, form, morale): (
        String,
        Option<String>,
        Option<String>,
        i32,
        i32,
        i32,
        i32,
        i32,
    ) = conn.query_row(
        "SELECT name, code, flag, rating, pedigree, home_support, form, morale FROM teams WHERE id = ?1",
        [id],
        |r| {
            Ok((
                r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                r.get(5)?, r.get(6)?, r.get(7)?,
            ))
        },
    )?;
    conn.execute(
        "UPDATE teams SET name = ?1, code = ?2, flag = ?3, rating = ?4, pedigree = ?5, home_support = ?6, form = ?7, morale = ?8 WHERE id = ?9",
        params![
            input.name.unwrap_or(name),
            input.code.or(code),
            input.flag.or(flag),
            input.rating.unwrap_or(rating),
            input.pedigree.unwrap_or(pedigree),
            input.home_support.unwrap_or(home_support),
            input.form.unwrap_or(form),
            input.morale.unwrap_or(morale),
            id,
        ],
    )?;
    let team: Team = conn.query_row(
        "SELECT id, name, code, flag, rating, pedigree, home_support, form, morale FROM teams WHERE id = ?1",
        [id],
        map_team,
    )?;
    Ok(Json(team))
}

pub async fn delete_team(
    _user: OptionalUser,
    State(db): State<Db>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    let conn = db.lock().unwrap();
    let in_matches: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE home_team_id = ?1 OR away_team_id = ?1",
        [id],
        |r| r.get(0),
    )?;
    if in_matches > 0 {
        return Err(ApiError::Conflict(
            "team is referenced by fixtures and cannot be deleted".into(),
        ));
    }
    let n = conn.execute("DELETE FROM teams WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(ApiError::not_found("team"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct PlayersQuery {
    #[serde(default)]
    pub tournament_id: Option<i64>,
}

/// SQL fragment mapping a position to its display order (GK first, then
/// defence, midfield, attack — matching the way rosters are laid out).
const POS_ORDER_SQL: &str = "CASE c.position
                 WHEN 'GK' THEN 0 WHEN 'CB' THEN 1 WHEN 'LB' THEN 2 WHEN 'RB' THEN 3
                 WHEN 'CDM' THEN 4 WHEN 'CM' THEN 5
                 WHEN 'CAM' THEN 6 WHEN 'LM' THEN 7 WHEN 'RM' THEN 8 WHEN 'LW' THEN 9
                 WHEN 'RW' THEN 10 WHEN 'ST' THEN 11 WHEN 'CF' THEN 12 ELSE 13 END";

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
            let numbered: bool = conn
                .query_row(
                    "SELECT shirt_numbers FROM tournaments WHERE id = ?1",
                    [tid],
                    |r| r.get::<_, i32>(0),
                )
                .unwrap_or(1)
                != 0;
            let order = if numbered {
                format!(
                    "{POS_ORDER_SQL}, c.shirt_number IS NULL, c.shirt_number, p.name"
                )
            } else {
                format!("{POS_ORDER_SQL}, p.name")
            };
            let sql = format!(
                "SELECT p.id, p.name, p.dob, p.nationality, c.position, c.shirt_number,
                        p.pace, p.stamina, p.strength, p.dribbling, p.passing,
                        p.shooting, p.tackling, p.vision, p.positioning, p.composure,
                        p.reflexes, p.handling, p.kicking, p.aerial,
                        p.decisions, p.aggression, p.concentration, p.leadership,
                        c.positions, p.photo_url
                 FROM player_callups c
                 JOIN players p ON p.id = c.player_id
                 WHERE c.tournament_id = ?1 AND c.team_id = ?2
                 ORDER BY {order}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![tid, team_id], map_player)?;
            let mut players = rows.collect::<Result<Vec<_>, _>>()?;
            if players.is_empty() {
                // No imported call-ups for this edition: fall back to the
                // deterministic generated squad (same one the run engine uses).
                players = names::squad_for_team(&conn, tid, team_id, numbered)?
                    .into_iter()
                    .map(generated_player)
                    .collect();
            }
            players
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT p.id, p.name, p.dob, p.nationality,
                        (SELECT c.position FROM player_callups c WHERE c.player_id = p.id ORDER BY c.id DESC LIMIT 1),
                        (SELECT c.shirt_number FROM player_callups c WHERE c.player_id = p.id ORDER BY c.id DESC LIMIT 1),
                        p.pace, p.stamina, p.strength, p.dribbling, p.passing,
                        p.shooting, p.tackling, p.vision, p.positioning, p.composure,
                        p.reflexes, p.handling, p.kicking, p.aerial,
                        p.decisions, p.aggression, p.concentration, p.leadership,
                        (SELECT c.positions FROM player_callups c WHERE c.player_id = p.id ORDER BY c.id DESC LIMIT 1),
                        p.photo_url
                 FROM players p
                 JOIN player_callups c ON c.player_id = p.id
                 WHERE c.team_id = ?1
                 ORDER BY p.name",
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
    _user: OptionalUser,
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

/// Update a player's record plus their call-up for `?tournament_id` (their
/// position(s) and shirt number live on the call-up).
pub async fn update_player(
    _user: OptionalUser,
    State(db): State<Db>,
    Path((team_id, player_id)): Path<(i64, i64)>,
    Query(q): Query<PlayersQuery>,
    Json(input): Json<UpdatePlayer>,
) -> ApiResult<Json<Player>> {
    let tournament_id = q.tournament_id.ok_or_else(|| {
        ApiError::bad_request("tournament_id is required to scope the call-up")
    })?;
    let conn = db.lock().unwrap();
    if !conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM players WHERE id = ?1)",
            [player_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false)
    {
        return Err(ApiError::not_found("player"));
    }
    conn.execute(
        "UPDATE players SET name = ?1, pace = ?2, stamina = ?3, strength = ?4, dribbling = ?5,
                passing = ?6, shooting = ?7, tackling = ?8, vision = ?9, positioning = ?10,
                composure = ?11, reflexes = ?12, handling = ?13, kicking = ?14, aerial = ?15,
                decisions = ?16, aggression = ?17, concentration = ?18, leadership = ?19,
                photo_url = ?20, dob = ?21, nationality = ?22
         WHERE id = ?23",
        params![
            input.name,
            input.pace.clamp(1, 99),
            input.stamina.clamp(1, 99),
            input.strength.clamp(1, 99),
            input.dribbling.clamp(1, 99),
            input.passing.clamp(1, 99),
            input.shooting.clamp(1, 99),
            input.tackling.clamp(1, 99),
            input.vision.clamp(1, 99),
            input.positioning.clamp(1, 99),
            input.composure.clamp(1, 99),
            input.reflexes.clamp(1, 99),
            input.handling.clamp(1, 99),
            input.kicking.clamp(1, 99),
            input.aerial.clamp(1, 99),
            input.decisions.clamp(1, 99),
            input.aggression.clamp(1, 99),
            input.concentration.clamp(1, 99),
            input.leadership.clamp(1, 99),
            input.photo_url,
            input.dob,
            input.nationality,
            player_id,
        ],
    )?;
    let dedup = build_positions(&input.position, &input.positions);
    let primary = plain_pos(dedup.first().map(|s| s.as_str()).unwrap_or(&input.position)).to_string();
    conn.execute(
        "INSERT INTO player_callups (player_id, tournament_id, team_id, position, positions, shirt_number)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(player_id, tournament_id) DO UPDATE SET
            team_id = excluded.team_id,
            position = excluded.position,
            positions = excluded.positions,
            shirt_number = excluded.shirt_number",
        params![
            player_id,
            tournament_id,
            team_id,
            primary,
            dedup.join(","),
            input.shirt_number,
        ],
    )?;
    let p: Player = conn.query_row(
        "SELECT p.id, p.name, p.dob, p.nationality, c.position, c.shirt_number,
                p.pace, p.stamina, p.strength, p.dribbling, p.passing,
                p.shooting, p.tackling, p.vision, p.positioning, p.composure,
                p.reflexes, p.handling, p.kicking, p.aerial,
                p.decisions, p.aggression, p.concentration, p.leadership,
                c.positions, p.photo_url
         FROM players p
         JOIN player_callups c ON c.player_id = p.id
         WHERE c.tournament_id = ?1 AND c.team_id = ?2 AND p.id = ?3",
        params![tournament_id, team_id, player_id],
        map_player,
    )?;
    Ok(Json(p))
}

/// Remove a player from a team within a tournament; once their last call-up is
/// gone the player record itself is deleted.
pub async fn delete_player(
    _user: OptionalUser,
    State(db): State<Db>,
    Path((team_id, player_id)): Path<(i64, i64)>,
    Query(q): Query<PlayersQuery>,
) -> ApiResult<StatusCode> {
    let tournament_id = q.tournament_id.ok_or_else(|| {
        ApiError::bad_request("tournament_id is required to scope the call-up")
    })?;
    let conn = db.lock().unwrap();
    let removed = conn.execute(
        "DELETE FROM player_callups WHERE player_id = ?1 AND tournament_id = ?2 AND team_id = ?3",
        params![player_id, tournament_id, team_id],
    )?;
    if removed == 0 {
        return Err(ApiError::not_found("player"));
    }
    let remaining: i64 =
        conn.query_row("SELECT COUNT(*) FROM player_callups WHERE player_id = ?1", [player_id], |r| r.get(0))?;
    if remaining == 0 {
        conn.execute("DELETE FROM players WHERE id = ?1", [player_id])?;
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Run oracle (data only — no simulation)
// ---------------------------------------------------------------------------

/// Everything the client's run engine needs to replay a tournament locally:
/// tournament meta, phases, participants with team context, every squad (with
/// a `generated` flag when the server manufactured a fictional roster), the
/// seeded group fixtures/kickoffs and manual group placement. Pure data: no
/// match is ever simulated here.
#[derive(Debug, Serialize)]
pub struct Oracle {
    tournament: OracleTournament,
    phases: Vec<Phase>,
    participants: Vec<OracleTeam>,
    /// team_id -> squad (final roster the run engine picks XIs from).
    squads: HashMap<i64, OracleSquad>,
    /// Manual group placement (fixture UI), preserving group + name order.
    groups: Vec<OracleGroup>,
    /// Scheduled group-stage fixtures (rounds, kickoffs).
    fixtures: Vec<OracleFixture>,
}

#[derive(Debug, Serialize)]
pub struct OracleTournament {
    id: i64,
    name: String,
    year: i32,
    host: String,
    shirt_numbers: bool,
}

#[derive(Debug, Serialize)]
pub struct OracleTeam {
    id: i64,
    name: String,
    code: Option<String>,
    rating: i32,
    pedigree: i32,
    home_support: i32,
    form: i32,
    morale: i32,
}

#[derive(Debug, Serialize)]
pub struct OraclePlayer {
    id: i64,
    name: String,
    position: String,
    positions: Vec<String>,
    photo_url: Option<String>,
    shirt_number: Option<i32>,
    overall: f64,
    aggression: i32,
    /// Present for real squads; `None` for generated rosters.
    leadership: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct OracleSquad {
    generated: bool,
    players: Vec<OraclePlayer>,
}

#[derive(Debug, Serialize)]
pub struct OracleGroup {
    name: String,
    team_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
pub struct OracleFixture {
    home_team_id: i64,
    away_team_id: i64,
    matchday: Option<i32>,
    kickoff: Option<String>,
}

/// GET /api/tournaments/{id}/oracle
pub async fn tournament_oracle(State(db): State<Db>, Path(id): Path<i64>) -> ApiResult<Json<Oracle>> {
    let conn = db.lock().unwrap();
    let (name, year, host, shirt_numbers) = conn
        .query_row(
            "SELECT name, year, host, shirt_numbers FROM tournaments WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i32>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i32>(3)? != 0,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("tournament not found"))?;
    let phases = load_phases(&conn, id)?;

    let mut pstmt = conn.prepare(
        "SELECT t.id, t.name, t.code, COALESCE(tt.rating, t.rating), t.pedigree, t.home_support, t.form, t.morale
         FROM tournament_teams tt
         JOIN teams t ON t.id = tt.team_id
         WHERE tt.tournament_id = ?1
         ORDER BY COALESCE(tt.rating, t.rating) DESC",
    )?;
    let participants = pstmt
        .query_map([id], |r| {
            Ok(OracleTeam {
                id: r.get(0)?,
                name: r.get(1)?,
                code: r.get(2)?,
                rating: r.get(3)?,
                pedigree: r.get(4)?,
                home_support: r.get(5)?,
                form: r.get(6)?,
                morale: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut squads = HashMap::new();
    for t in &participants {
        let base = names::squad_for_team(&conn, id, t.id, shirt_numbers)?;
        let generated = base.is_empty() || base.iter().any(|p| p.id < 0);
        let leadership = if generated {
            HashMap::new()
        } else {
            let mut lstmt = conn.prepare(
                "SELECT c.player_id, COALESCE(p.leadership, 60)
                 FROM player_callups c
                 JOIN players p ON p.id = c.player_id
                 WHERE c.tournament_id = ?1 AND c.team_id = ?2",
            )?;
            let rows =
                lstmt.query_map(params![id, t.id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i32>(1)?)))?;
            let mut m = HashMap::new();
            for row in rows {
                let (pid, lead) = row?;
                m.insert(pid, lead);
            }
            m
        };
        let players = base
            .into_iter()
            .map(|p| OraclePlayer {
                id: p.id,
                name: p.name,
                position: p.position,
                positions: p.positions,
                photo_url: p.photo_url,
                shirt_number: p.shirt_number,
                overall: p.overall,
                aggression: p.aggression,
                leadership: leadership.get(&p.id).copied(),
            })
            .collect();
        squads.insert(t.id, OracleSquad { generated, players });
    }

    let mut gstmt = conn.prepare(
        "SELECT g.group_name, t.id
         FROM tournament_groups g
         JOIN teams t ON t.id = g.team_id
         WHERE g.tournament_id = ?1
         ORDER BY g.group_name, t.name",
    )?;
    let mut groups: Vec<OracleGroup> = Vec::new();
    for row in gstmt
        .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
    {
        let (name, tid) = row?;
        match groups.iter_mut().find(|g| g.name == name) {
            Some(g) => g.team_ids.push(tid),
            None => groups.push(OracleGroup {
                name,
                team_ids: vec![tid],
            }),
        }
    }

    let mut fstmt = conn.prepare(
        "SELECT home_team_id, away_team_id, matchday, kickoff FROM matches
         WHERE tournament_id = ?1 AND stage = 'GROUP' AND status = 'scheduled'
         ORDER BY matchday, id",
    )?;
    let fixtures = fstmt
        .query_map([id], |r| {
            Ok(OracleFixture {
                home_team_id: r.get(0)?,
                away_team_id: r.get(1)?,
                matchday: r.get(2)?,
                kickoff: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Json(Oracle {
        tournament: OracleTournament {
            id,
            name,
            year,
            host,
            shirt_numbers,
        },
        phases,
        participants,
        squads,
        groups,
        fixtures,
    }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn expand_attrs(p: &CreatePlayer) -> [i32; 18] {
    if let Some(rating) = p.rating {
        // scraper back-compat: spread a scalar rating using the same
        // position-aware, band-squashed template as the seed fallback
        crate::db::attrs_for(rating, p.name.len(), crate::db::family_of(&p.position))
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
            p.decisions.clamp(1, 99),
            p.aggression.clamp(1, 99),
            p.concentration.clamp(1, 99),
            p.leadership.clamp(1, 99),
        ]
    }
}

/// Normalize one "POS" or "POS:fam" token (fam 1..=100); fam 100 collapses to
/// the bare position code.
fn normalize_pos_token(s: &str) -> Option<String> {
    let t = s.trim();
    if let Some(idx) = t.find(':') {
        let (p, f) = t.split_at(idx);
        let p = p.trim().to_uppercase();
        if p.is_empty() {
            return None;
        }
        if let Ok(fam) = f[1..].trim().parse::<i32>() {
            if (1..=100).contains(&fam) {
                return if fam == 100 { Some(p) } else { Some(format!("{p}:{fam}")) };
            }
        }
        return Some(p);
    }
    let p = t.to_uppercase();
    (!p.is_empty()).then_some(p)
}

/// The bare position code of a token ("CB:80" → "CB").
fn plain_pos(token: &str) -> &str {
    token.split(':').next().unwrap_or(token)
}

/// Ordered, deduped positions list with the declared primary first. Encoded
/// familiarity ("CB:80") survives; legacy plain tokens default to fam 100, so
/// no player loses their existing rating by the switch.
fn build_positions(position: &str, positions: &[String]) -> Vec<String> {
    let mut out: Vec<String> = positions
        .iter()
        .filter_map(|s| normalize_pos_token(s))
        .collect();
    let primary_plain = plain_pos(&normalize_pos_token(position).unwrap_or_default()).to_string();
    if let Some(idx) = out.iter().position(|t| plain_pos(t) == primary_plain) {
        if idx != 0 {
            let tok = out.remove(idx);
            out.insert(0, tok);
        }
    } else if !primary_plain.is_empty() {
        out.insert(0, primary_plain);
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|t| seen.insert(plain_pos(t).to_string()));
    out
}

fn insert_player(
    conn: &rusqlite::Connection,
    tournament_id: i64,
    team_id: i64,
    p: &CreatePlayer,
) -> rusqlite::Result<()> {
    let attrs = expand_attrs(p);
    conn.execute(
        "INSERT INTO players (name, pace, stamina, strength, dribbling, passing, shooting, tackling, vision, positioning, composure, reflexes, handling, kicking, aerial, decisions, aggression, concentration, leadership, photo_url)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        rusqlite::params![
            p.name,
            attrs[0],
            attrs[1],
            attrs[2],
            attrs[3],
            attrs[4],
            attrs[5],
            attrs[6],
            attrs[7],
            attrs[8],
            attrs[9],
            attrs[10],
            attrs[11],
            attrs[12],
            attrs[13],
            attrs[14],
            attrs[15],
            attrs[16],
            attrs[17],
            p.photo_url,
        ],
    )?;
    let player_id = conn.last_insert_rowid();
    let dedup = build_positions(&p.position, &p.positions);
    let primary = plain_pos(dedup.first().map(|s| s.as_str()).unwrap_or(&p.position)).to_string();
    let positions_str = dedup.join(",");
    conn.execute(
        "INSERT OR IGNORE INTO player_callups (player_id, tournament_id, team_id, position, positions, shirt_number)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![player_id, tournament_id, team_id, primary, positions_str, p.shirt_number],
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
        pedigree: r.get(5)?,
        home_support: r.get(6)?,
        form: r.get(7)?,
        morale: r.get(8)?,
    })
}

#[allow(clippy::type_complexity)]
fn map_player(r: &rusqlite::Row) -> rusqlite::Result<Player> {
    let attrs = [
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
        r.get::<_, Option<i32>>(19)?,
        r.get::<_, Option<i32>>(20)?,
        r.get::<_, Option<i32>>(21)?,
        r.get::<_, Option<i32>>(22)?,
        r.get::<_, Option<i32>>(23)?,
    ];
    let position: String = r.get(4)?;
    let overall = crate::attrs::composite_rating(&position, &attrs);
    let rating = crate::attrs::star_rating(&position, &attrs);
    let positions: Vec<String> = r
        .get::<_, Option<String>>(24)?
        .map(|s| crate::names::parse_positions(&s))
        .unwrap_or_else(|| vec![position.clone()]);
    Ok(Player {
        id: r.get(0)?,
        name: r.get(1)?,
        dob: r.get(2)?,
        nationality: r.get(3)?,
        position,
        positions,
        photo_url: r.get(25)?,
        shirt_number: r.get(5)?,
        pace: attrs[0],
        stamina: attrs[1],
        strength: attrs[2],
        dribbling: attrs[3],
        passing: attrs[4],
        shooting: attrs[5],
        tackling: attrs[6],
        vision: attrs[7],
        positioning: attrs[8],
        composure: attrs[9],
        reflexes: attrs[10],
        handling: attrs[11],
        kicking: attrs[12],
        aerial: attrs[13],
        decisions: attrs[14],
        aggression: attrs[15],
        concentration: attrs[16],
        leadership: attrs[17],
        overall,
        rating,
    })
}

/// Maps a generated `SquadPlayer` to the public `Player` shape (attributes are
/// derived values in memory, so the granular ones stay unset for generated
/// squads — only `overall` is meaningful).
fn generated_player(s: crate::names::SquadPlayer) -> Player {
    Player {
        id: s.id,
        name: s.name,
        dob: None,
        nationality: None,
        position: s.position,
        positions: s.positions,
        photo_url: s.photo_url,
        shirt_number: s.shirt_number,
        pace: None,
        stamina: None,
        strength: None,
        dribbling: None,
        passing: None,
        shooting: None,
        tackling: None,
        vision: None,
        positioning: None,
        composure: None,
        reflexes: None,
        handling: None,
        kicking: None,
        aerial: None,
        decisions: None,
        aggression: None,
        concentration: None,
        leadership: None,
        overall: s.overall,
        rating: s.overall,
    }
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

// ---------------------------------------------------------------------------
// Run: computed client-side. The server only serves data + the oracle seed.
// ---------------------------------------------------------------------------