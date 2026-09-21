use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::Connection;
use serde::Deserialize;

use crate::{fixture, models::Tournament};

/// Every World Cup held from 1930 to 2026: `(year, host, winner)`.
/// 1942 and 1946 were cancelled due to WWII and are skipped.
pub const WORLD_CUPS: &[(i32, &str, Option<&str>)] = &[
    (1930, "Uruguay", Some("Uruguay")),
    (1934, "Italy", Some("Italy")),
    (1938, "France", Some("Italy")),
    (1950, "Brazil", Some("Uruguay")),
    (1954, "Switzerland", Some("West Germany")),
    (1958, "Sweden", Some("Brazil")),
    (1962, "Chile", Some("Brazil")),
    (1966, "England", Some("England")),
    (1970, "Mexico", Some("Brazil")),
    (1974, "West Germany", Some("West Germany")),
    (1978, "Argentina", Some("Argentina")),
    (1982, "Spain", Some("Italy")),
    (1986, "Mexico", Some("Argentina")),
    (1990, "Italy", Some("West Germany")),
    (1994, "United States", Some("Brazil")),
    (1998, "France", Some("France")),
    (2002, "South Korea / Japan", Some("Brazil")),
    (2006, "Germany", Some("Italy")),
    (2010, "South Africa", Some("Spain")),
    (2014, "Brazil", Some("Germany")),
    (2018, "Russia", Some("France")),
    (2022, "Qatar", Some("Argentina")),
    (2026, "United States / Mexico / Canada", Some("Spain")),
];

/// Tournament structure per era — the format is fully data-driven.
/// `G <n>`: group phase with n groups · `K <key> <entry>`: knockout with
/// that many entrants (THIRD = third-place match, F = final).
pub const FORMATS: &[(i32, &[PhaseSpec])] = &[
    // 1930: 4 groups, straight to the semi-finals.
    (
        1930,
        &[
            PhaseSpec::group("Group stage", 4),
            PhaseSpec::knockout("SF", "Semi-finals", 4),
            PhaseSpec::knockout("THIRD", "Third place", 2),
            PhaseSpec::knockout("F", "Final", 2),
        ],
    ),
    // 1934 & 1938: pure knockout from 16 participants.
    (
        1934,
        &[
            PhaseSpec::knockout("R16", "Round of 16", 16),
            PhaseSpec::knockout("QF", "Quarter-finals", 8),
            PhaseSpec::knockout("SF", "Semi-finals", 4),
            PhaseSpec::knockout("THIRD", "Third place", 2),
            PhaseSpec::knockout("F", "Final", 2),
        ],
    ),
    (
        1938,
        &[
            PhaseSpec::knockout("R16", "Round of 16", 16),
            PhaseSpec::knockout("QF", "Quarter-finals", 8),
            PhaseSpec::knockout("SF", "Semi-finals", 4),
            PhaseSpec::knockout("THIRD", "Third place", 2),
            PhaseSpec::knockout("F", "Final", 2),
        ],
    ),
    // 1950: 4 groups, then a final round-robin league between the winners.
    (
        1950,
        &[
            PhaseSpec::group("Group stage", 4),
            PhaseSpec::league("Final round"),
        ],
    ),
];

fn formats_for(year: i32) -> Vec<PhaseSpec> {
    match year {
        // 1930–1938 & 1950 have unique structures, spelled out above.
        y if y <= 1938 || y == 1950 => FORMATS
            .iter()
            .find(|(yy, _)| *yy == y)
            .map(|(_, p)| p.to_vec())
            .unwrap_or_default(),
        // 1954–1978: 16 teams → 4 groups → QF → SF → Third → Final.
        y if (1954..=1978).contains(&y) => vec![
            PhaseSpec::group("Group stage", 4),
            PhaseSpec::knockout("QF", "Quarter-finals", 8),
            PhaseSpec::knockout("SF", "Semi-finals", 4),
            PhaseSpec::knockout("THIRD", "Third place", 2),
            PhaseSpec::knockout("F", "Final", 2),
        ],
        // 1982–1994: 24 teams → 6 groups → R16 (2 per group + 4 best thirds).
        y if (1982..=1994).contains(&y) => vec![
            PhaseSpec::group("Group stage", 6),
            PhaseSpec::knockout("R16", "Round of 16", 16),
            PhaseSpec::knockout("QF", "Quarter-finals", 8),
            PhaseSpec::knockout("SF", "Semi-finals", 4),
            PhaseSpec::knockout("THIRD", "Third place", 2),
            PhaseSpec::knockout("F", "Final", 2),
        ],
        // 1998–2022: 32 teams → 8 groups → R16 → ...
        y if (1998..=2022).contains(&y) => vec![
            PhaseSpec::group("Group stage", 8),
            PhaseSpec::knockout("R16", "Round of 16", 16),
            PhaseSpec::knockout("QF", "Quarter-finals", 8),
            PhaseSpec::knockout("SF", "Semi-finals", 4),
            PhaseSpec::knockout("THIRD", "Third place", 2),
            PhaseSpec::knockout("F", "Final", 2),
        ],
        // 2026: 48 teams → 12 groups → R32 (2 per group + 8 best thirds).
        _ => vec![
            PhaseSpec::group("Group stage", 12),
            PhaseSpec::knockout("R32", "Round of 32", 32),
            PhaseSpec::knockout("R16", "Round of 16", 16),
            PhaseSpec::knockout("QF", "Quarter-finals", 8),
            PhaseSpec::knockout("SF", "Semi-finals", 4),
            PhaseSpec::knockout("THIRD", "Third place", 2),
            PhaseSpec::knockout("F", "Final", 2),
        ],
    }
}

#[derive(Clone, Copy)]
pub struct PhaseSpec {
    pub key: &'static str,
    pub name: &'static str,
    pub phase_type: &'static str,
    pub group_count: Option<i32>,
    pub entry_teams: Option<i32>,
    pub seq: i32,
}

impl PhaseSpec {
    const fn new(
        key: &'static str,
        name: &'static str,
        phase_type: &'static str,
        seq: i32,
        group_count: Option<i32>,
        entry_teams: Option<i32>,
    ) -> Self {
        PhaseSpec {
            key,
            name,
            phase_type,
            seq,
            group_count,
            entry_teams,
        }
    }
    const fn group(name: &'static str, groups: i32) -> Self {
        Self::new("GROUP", name, "GROUP", 0, Some(groups), None)
    }
    const fn league(name: &'static str) -> Self {
        Self::new("FINAL", name, "GROUP", 0, Some(1), None)
    }
    const fn knockout(key: &'static str, name: &'static str, entry: i32) -> Self {
        Self::new(key, name, "KNOCKOUT", 0, None, Some(entry))
    }
}

/// Playable demo data: the real 32 participants of Qatar 2022 with their
/// group letters and a base strength rating.
pub const WC2022_GROUPS: &[(i32, &str, &str, i32)] = &[
    (2022, "Qatar", "A", 58),
    (2022, "Ecuador", "A", 72),
    (2022, "Senegal", "A", 76),
    (2022, "Netherlands", "A", 82),
    (2022, "England", "B", 85),
    (2022, "Iran", "B", 72),
    (2022, "United States", "B", 74),
    (2022, "Wales", "B", 73),
    (2022, "Argentina", "C", 86),
    (2022, "Saudi Arabia", "C", 68),
    (2022, "Mexico", "C", 73),
    (2022, "Poland", "C", 74),
    (2022, "France", "D", 87),
    (2022, "Australia", "D", 71),
    (2022, "Denmark", "D", 76),
    (2022, "Tunisia", "D", 73),
    (2022, "Spain", "E", 85),
    (2022, "Costa Rica", "E", 66),
    (2022, "Germany", "E", 80),
    (2022, "Japan", "E", 78),
    (2022, "Belgium", "F", 82),
    (2022, "Canada", "F", 73),
    (2022, "Morocco", "F", 76),
    (2022, "Croatia", "F", 78),
    (2022, "Brazil", "G", 87),
    (2022, "Serbia", "G", 75),
    (2022, "Switzerland", "G", 76),
    (2022, "Cameroon", "G", 71),
    (2022, "Portugal", "H", 84),
    (2022, "Ghana", "H", 71),
    (2022, "Uruguay", "H", 75),
    (2022, "South Korea", "H", 74),
];

fn schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            provider_subject TEXT NOT NULL,
            display_name TEXT NOT NULL,
            email TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (provider, provider_subject)
        );

        CREATE TABLE IF NOT EXISTS oauth_states (
            state TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tournaments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            year INTEGER NOT NULL UNIQUE,
            host TEXT NOT NULL,
            winner TEXT,
            start_date TEXT,
            end_date TEXT,
            shirt_numbers INTEGER NOT NULL DEFAULT 1,
            logo TEXT
        );

        CREATE TABLE IF NOT EXISTS sim_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sim_runs_user ON sim_runs(user_id);
        CREATE INDEX IF NOT EXISTS idx_sim_runs_tournament ON sim_runs(tournament_id);

        CREATE TABLE IF NOT EXISTS tournament_phases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            key TEXT NOT NULL,
            name TEXT NOT NULL,
            phase_type TEXT NOT NULL,
            group_count INTEGER,
            entry_teams INTEGER,
            UNIQUE (tournament_id, seq),
            UNIQUE (tournament_id, key)
        );

        CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            code TEXT,
            flag TEXT,
            rating INTEGER NOT NULL DEFAULT 70,
            pedigree INTEGER NOT NULL DEFAULT 50,
            home_support INTEGER NOT NULL DEFAULT 50,
            form INTEGER NOT NULL DEFAULT 50,
            morale INTEGER NOT NULL DEFAULT 55
        );

        CREATE TABLE IF NOT EXISTS tournament_teams (
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            PRIMARY KEY (tournament_id, team_id)
        );

        /* Only populated when the tournament has a group phase. */
        CREATE TABLE IF NOT EXISTS tournament_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            group_name TEXT NOT NULL,
            team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            UNIQUE (tournament_id, group_name, team_id)
        );

        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            dob TEXT,
            nationality TEXT,
            pace INTEGER, stamina INTEGER, strength INTEGER,
            dribbling INTEGER, passing INTEGER, shooting INTEGER,
            tackling INTEGER, vision INTEGER, positioning INTEGER,
            composure INTEGER,
            reflexes INTEGER, handling INTEGER, kicking INTEGER, aerial INTEGER,
            decisions INTEGER, aggression INTEGER, concentration INTEGER, leadership INTEGER,
            photo_url TEXT
        );

        /* player <-> team membership is tournament-scoped: a player can
           represent different nations in different editions. */
        CREATE TABLE IF NOT EXISTS player_callups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            position TEXT NOT NULL DEFAULT 'CM',
            positions TEXT,
            shirt_number INTEGER,
            UNIQUE (player_id, tournament_id)
        );

        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            stage TEXT NOT NULL,
            round_num INTEGER NOT NULL DEFAULT 0,
            matchday INTEGER,
            home_team_id INTEGER NOT NULL REFERENCES teams(id),
            away_team_id INTEGER NOT NULL REFERENCES teams(id),
            kickoff TEXT,
            home_score INTEGER,
            away_score INTEGER,
            status TEXT NOT NULL DEFAULT 'scheduled'
        );

        CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_groups_tournament ON tournament_groups(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_callups_tournament ON player_callups(tournament_id);
        CREATE INDEX IF NOT EXISTS idx_callups_team ON player_callups(team_id);
        "#,
    )
}

/// Adds columns introduced after the first release to databases that were
/// created with the earlier `CREATE TABLE IF NOT EXISTS` schema.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let has = |table: &str, column: &str| -> rusqlite::Result<bool> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let name: String = r.get(1)?;
            if name == column {
                return Ok(true);
            }
        }
        Ok(false)
    };
    for column in ["pedigree", "home_support", "form", "morale"] {
        if !has("teams", column)? {
            conn.execute(
                &format!("ALTER TABLE teams ADD COLUMN {column} INTEGER NOT NULL DEFAULT 50"),
                [],
            )?;
        }
    }
    for column in ["decisions", "aggression", "concentration", "leadership"] {
        if !has("players", column)? {
            conn.execute(
                &format!("ALTER TABLE players ADD COLUMN {column} INTEGER NOT NULL DEFAULT 60"),
                [],
            )?;
        }
    }
    if !has("tournaments", "shirt_numbers")? {
        conn.execute("ALTER TABLE tournaments ADD COLUMN shirt_numbers INTEGER NOT NULL DEFAULT 1", [])?;
    }
    if !has("tournaments", "logo")? {
        conn.execute("ALTER TABLE tournaments ADD COLUMN logo TEXT", [])?;
    }
    if !has("players", "photo_url")? {
        conn.execute("ALTER TABLE players ADD COLUMN photo_url TEXT", [])?;
    }
    if !has("player_callups", "positions")? {
        conn.execute("ALTER TABLE player_callups ADD COLUMN positions TEXT", [])?;
    }
    // Historical editions didn't (regularly) use squad numbers.
    conn.execute(
        "UPDATE tournaments SET shirt_numbers = 0 WHERE year < 1954 AND shirt_numbers = 1",
        [],
    )?;
    Ok(())
}

pub fn open() -> rusqlite::Result<Connection> {
    let dir = std::env::var("WCS_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    std::fs::create_dir_all(&dir).ok();
    let path = Path::new(&dir).join("wcs.sqlite");
    let conn = Connection::open(&path)?;
    schema(&conn)?;
    migrate(&conn)?;
    seed(&conn)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Real World Cup seeds (see scripts/ingest_sofascore.py). When
// data/seed/{year}.json is present it replaces the demo roster with that
// edition's real qualifiers, squads and group fixtures. Editions without a
// seed file fall back to the demo data (2022) or an empty field.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SeedPlayer {
    name: String,
    positions: Vec<String>,
    shirt: Option<i32>,
    #[serde(default)]
    photo: Option<String>,
    // Optional 18 values in the exact attribute order used by sim.rs and the
    // INSERT below (PACE..LEADERSHIP). When absent, attrs_for() derives them
    // deterministically from the team rating + name; when present they win.
    #[serde(default)]
    attrs: Option<Vec<i32>>,
}

#[derive(Deserialize)]
struct SeedTeam {
    name: String,
    code: String,
    #[serde(default)]
    flag: String,
    rating: i32,
    /// Absent for pure-knockout editions (1934/1938) and the 1950 final round.
    #[serde(default)]
    group: Option<String>,
}

#[derive(Deserialize)]
struct SeedFixture {
    home: String,
    away: String,
    #[serde(default)]
    matchday: i32,
    #[serde(default)]
    kickoff: Option<String>,
}

#[derive(Deserialize)]
struct SeedFile {
    #[serde(default)]
    teams: Vec<SeedTeam>,
    #[serde(default)]
    squads: HashMap<String, Vec<SeedPlayer>>,
    #[serde(default)]
    fixtures: Vec<SeedFixture>,
}

/// Position → family bucket (GK / DF / MF / FW) used for rating deltas and
/// attribute templates.
pub(crate) fn family_of(pos: &str) -> i32 {
    match pos {
        "GK" => 0,
        "DF" | "CB" | "LB" | "RB" => 1,
        "MF" | "CM" | "CDM" | "CAM" | "LM" | "RM" => 2,
        _ => 3,
    }
}

/// Spreads a team rating across the 18 attributes for players without explicit
/// EA ratings, so fallback players read as solid-but-unspectacular (roughly the
/// 60s-70s band) instead of outshining EA-rated stars. The rating is squashed
/// into a modest quality band and then nudged per position family: forwards get
/// pace/shooting/dribbling, defenders tackling/aerial, GKs the shot-stopping
/// group, midfielders passing/vision.
pub(crate) fn attrs_for(rating: i32, name_len: usize, family: i32) -> [i32; 18] {
    let r = rating.clamp(35, 99);
    let q = 40 + (r - 40) * 45 / 100;
    let nl = name_len as i32;
    let clamp = |v: i32| v.clamp(30, 99);
    let j = |v: i32| clamp(v + q + nl % 5 - 2);
    match family {
        // GK: keepers hang on their shot-stopping + composure/aerial
        0 => [
            j(0), j(2), j(5), j(-8), j(-4), j(-8), j(-6), j(-3), j(-2), j(3),
            j(11), j(13), j(11), j(7), j(1), j(0), j(3), j(2),
        ],
        // DF: defence-first, physical
        1 => [
            j(1), j(5), j(8), j(-2), j(0), j(-4), j(10), j(-1), j(3), j(3),
            j(2), j(-8), j(-4), j(9), j(1), j(2), j(3), j(1),
        ],
        // MF: engine room
        2 => [
            j(2), j(5), j(3), j(5), j(8), j(1), j(2), j(7), j(3), j(3),
            j(2), j(-8), j(-2), j(0), j(1), j(0), j(1), j(1),
        ],
        // FW: attackers lean into pace, finishing, dribbling
        _ => [
            j(11), j(2), j(1), j(9), j(3), j(9), j(-3), j(3), j(9), j(3),
            j(2), j(-8), j(-4), j(4), j(1), j(0), j(1), j(2),
        ],
    }
}

fn upsert_team(
    conn: &Connection,
    name: &str,
    code: &str,
    flag: &str,
    rating: i32,
) -> rusqlite::Result<i64> {
    match team_by_name(conn, name)? {
        Some(id) => {
            conn.execute(
                "UPDATE teams SET code = ?2, flag = ?3, rating = ?4 WHERE id = ?1",
                rusqlite::params![id, code, flag, rating],
            )?;
            Ok(id)
        }
        None => insert_team(conn, name, Some(code), Some(flag), rating, None),
    }
}

/// Data directory for seed files (and, if present, local player photos).
pub fn data_dir() -> String {
    std::env::var("WCS_DATA_DIR").unwrap_or_else(|_| "data".to_string())
}

/// Seeds one edition from `seed/{year}.json`, falling back to demo rosters.
fn seed_edition(conn: &Connection, year: i32) -> rusqlite::Result<()> {
    let path = Path::new(&data_dir()).join("seed").join(format!("{year}.json"));
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return seed_demo(conn, year),
    };
    let file: SeedFile = serde_json::from_str(&text)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

    let tournament_id: i64 = conn.query_row(
        "SELECT id FROM tournaments WHERE year = ?1",
        [year],
        |r| r.get(0),
    )?;

    // Teams + group assignments.
    // Re-seeding is idempotent per edition: clear this tournament's previous
    // team/group rows first so teams dropped or regrouped since the last boot
    // (e.g. updated seed files) never linger as stale participants or
    // duplicate group memberships.
    conn.execute(
        "DELETE FROM tournament_groups WHERE tournament_id = ?1",
        rusqlite::params![tournament_id],
    )?;
    conn.execute(
        "DELETE FROM tournament_teams WHERE tournament_id = ?1",
        rusqlite::params![tournament_id],
    )?;
    let mut by_code: HashMap<String, i64> = HashMap::new();
    let mut rating_by_code: HashMap<String, i32> = HashMap::new();
    for t in &file.teams {
        let tid = upsert_team(conn, &t.name, &t.code, &t.flag, t.rating)?;
        by_code.insert(t.code.clone(), tid);
        rating_by_code.insert(t.code.clone(), t.rating);
        conn.execute(
            "INSERT OR IGNORE INTO tournament_teams (tournament_id, team_id) VALUES (?1, ?2)",
            rusqlite::params![tournament_id, tid],
        )?;
        if let Some(group) = t.group.as_deref().filter(|g| !g.is_empty()) {
            conn.execute(
                "INSERT OR IGNORE INTO tournament_groups (tournament_id, group_name, team_id)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![tournament_id, group, tid],
            )?;
        }
    }

    // Real squads.
    // Repeated boot seeds must not accumulate duplicate squad rows, so first
    // drop the call-ups seeded for this edition and the players only they use.
    let prev: Vec<i64> = {
        let mut st = conn.prepare(
            "SELECT player_id FROM player_callups WHERE tournament_id = ?1",
        )?;
        let rows = st.query_map([tournament_id], |r| r.get::<_, i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    conn.execute(
        "DELETE FROM player_callups WHERE tournament_id = ?1",
        rusqlite::params![tournament_id],
    )?;
    for pid in prev {
        conn.execute("DELETE FROM players WHERE id = ?1", [pid])?;
    }
    for (code, players) in &file.squads {
        let Some(&team_id) = by_code.get(code) else { continue };
        let base = rating_by_code.get(code).copied().unwrap_or(70);
        let resolved = era_positions(year, code, players);
        for (i, p) in players.iter().enumerate() {
            let pos = resolved[i].first().cloned().unwrap_or_else(|| "CM".to_string());
            let delta = match family_of(&pos) {
                0 => 3,
                1 => -2,
                2 => 0,
                _ => 1,
            };
            let attrs: [i32; 18] = match &p.attrs {
                Some(v) if v.len() == 18 => {
                    let mut out = [0; 18];
                    out.copy_from_slice(v);
                    out
                }
                _ => attrs_for(base + delta, p.name.len(), family_of(&pos)),
            };
            conn.execute(
                "INSERT INTO players (name, pace, stamina, strength, dribbling, passing, shooting,
                                      tackling, vision, positioning, composure, reflexes, handling,
                                      kicking, aerial, decisions, aggression, concentration, leadership, photo_url)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
                rusqlite::params![
                    p.name, attrs[0], attrs[1], attrs[2], attrs[3], attrs[4], attrs[5],
                    attrs[6], attrs[7], attrs[8], attrs[9], attrs[10], attrs[11], attrs[12],
                    attrs[13], attrs[14], attrs[15], attrs[16], attrs[17], p.photo
                ],
            )?;
            let player_id = conn.last_insert_rowid();
            let positions_str = resolved[i].join(",");
            conn.execute(
                "INSERT OR IGNORE INTO player_callups (player_id, tournament_id, team_id, position, positions, shirt_number)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![player_id, tournament_id, team_id, pos, positions_str, p.shirt],
            )?;
        }
    }

    // Group fixtures: prefer the real schedule (with kickoff) from the seed,
    // else let the round-robin generator fill in any edition with groups.
    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1 AND stage = 'GROUP'",
        [tournament_id],
        |r| r.get(0),
    )?;
    if existing == 0 {
        if file.fixtures.is_empty() {
            fixture::generate(conn, tournament_id)?;
        } else {
            for f in &file.fixtures {
                let Some(&home) = by_code.get(&f.home) else { continue };
                let Some(&away) = by_code.get(&f.away) else { continue };
                conn.execute(
                    "INSERT INTO matches (tournament_id, stage, round_num, matchday, home_team_id,
                                          away_team_id, kickoff, status)
                     VALUES (?1, 'GROUP', 0, ?2, ?3, ?4, ?5, 'scheduled')",
                    rusqlite::params![tournament_id, f.matchday, home, away, f.kickoff],
                )?;
            }
        }
    }
    Ok(())
}

/// Deterministic string hash (FNV-1a 64) — stable across runs, so rebuilding
/// the DB reproduces exactly the same squads.
fn hash_str(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Historical openfootball pages carry no real positional data for most
/// editions: every player in a squad lands on "CM", so there is no signal to
/// recover. With that, each player gets a role that fits his era's formation
/// shape (WM 2-3-5, Brazil's 4-2-4, etc.), picked deterministically from a
/// hash of his name — GKs, defenders, midfielders and forwards are spread
/// across the squad instead of being blank "CM" boxes. Squads that do carry
/// real positions (2018+, the 2022/2026 demo rosters) are left untouched.
fn era_positions(year: i32, code: &str, players: &[SeedPlayer]) -> Vec<Vec<String>> {
    let distinct: HashSet<&str> = players
        .iter()
        .filter_map(|p| p.positions.first().map(|s| s.as_str()))
        .collect();
    if distinct.len() > 1 {
        return players.iter().map(|p| p.positions.clone()).collect();
    }

    let n = players.len();
    if n == 0 {
        return Vec::new();
    }
    let n_gk = if n >= 14 { 2 } else { 1 };
    let (w_df, w_mf, w_fw) = if year <= 1954 {
        (2, 3, 5)
    } else if year <= 1966 {
        (4, 2, 4)
    } else if year <= 1974 {
        (4, 3, 3)
    } else if year <= 1998 {
        (4, 4, 2)
    } else {
        (4, 3, 3)
    };
    let wsum = w_df + w_mf + w_fw;
    let out = n - n_gk;
    let df = out * w_df / wsum;
    let mf = out * w_mf / wsum;
    let fw = out - df - mf;

    let mut fam: Vec<&str> = Vec::with_capacity(n);
    for _ in 0..n_gk {
        fam.push("GK");
    }
    for _ in 0..df {
        fam.push("DF");
    }
    for _ in 0..mf {
        fam.push("MF");
    }
    for _ in 0..fw {
        fam.push("FW");
    }

    // Shuffle the family bag by name hash so GKs and role spread don't simply
    // follow the roster's JSON order.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&i| hash_str(&format!("{code}|{}", players[i].name)));

    const DF_ROLES: [&str; 4] = ["CB", "CB", "RB", "LB"];
    const MF_ROLES: [&str; 4] = ["CM", "CM", "CDM", "CAM"];
    const FW_ROLES: [&str; 5] = ["ST", "ST", "CF", "LW", "RW"];

    let mut out_v: Vec<Vec<String>> = vec![Vec::new(); n];
    for k in 0..n {
        let i = order[k];
        let h = hash_str(&format!("{code}|{}", players[i].name)) as usize;
        let role = match fam[k] {
            "GK" => "GK".to_string(),
            "DF" => DF_ROLES[h % DF_ROLES.len()].to_string(),
            "MF" => MF_ROLES[h % MF_ROLES.len()].to_string(),
            _ => FW_ROLES[h % FW_ROLES.len()].to_string(),
        };
        out_v[i] = vec![role];
    }
    out_v
}

/// Demo fallback for the two editions that shipped before the real seeds.
fn seed_demo(conn: &Connection, year: i32) -> rusqlite::Result<()> {
    match year {
        2022 => seed_2022_demo(conn),
        2026 => seed_2026_demo(conn),
        _ => Ok(()),
    }
}

/// Reuses the 2022 demo rosters to populate a 12-group 2026 tournament (the
/// seeded 2026 format expects 48 teams but we only have 32: 8 groups of three
/// plus 4 groups of two still yields top-2 + best-rest knockout qualifiers).
fn seed_2026_demo(conn: &Connection) -> rusqlite::Result<()> {
    let tournament_id: i64 = conn.query_row(
        "SELECT id FROM tournaments WHERE year = 2026",
        [],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT t.id FROM tournament_teams tt
         JOIN teams t ON t.id = tt.team_id
         WHERE tt.tournament_id = (SELECT id FROM tournaments WHERE year = 2022)
         ORDER BY t.rating DESC",
    )?;
    let ids: Vec<i64> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut buckets: Vec<Vec<i64>> = Vec::new();
    let mut cursor = 0usize;
    for g in 0..12 {
        let size = if g < 8 { 3 } else { 2 };
        buckets.push(ids[cursor..(cursor + size).min(ids.len())].to_vec());
        cursor += size;
    }
    buckets.retain(|b| !b.is_empty());

    for (gi, teams) in buckets.iter().enumerate() {
        let letter = format!("{}", (b'A' + gi as u8) as char);
        for team_id in teams {
            conn.execute(
                "INSERT OR IGNORE INTO tournament_teams (tournament_id, team_id) VALUES (?1, ?2)",
                rusqlite::params![tournament_id, team_id],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO tournament_groups (tournament_id, group_name, team_id) VALUES (?1, ?2, ?3)",
                rusqlite::params![tournament_id, letter, team_id],
            )?;
        }
    }

    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1 AND stage = 'GROUP'",
        [tournament_id],
        |r| r.get(0),
    )?;
    if existing == 0 && !buckets.is_empty() {
        fixture::generate(conn, tournament_id)?;
    }
    Ok(())
}

fn seed(conn: &Connection) -> rusqlite::Result<()> {
    seed_tournaments(conn)?;
    for (year, _, _) in WORLD_CUPS {
        seed_edition(conn, *year)?;
    }
    Ok(())
}

fn seed_tournaments(conn: &Connection) -> rusqlite::Result<()> {
    for (year, host, winner) in WORLD_CUPS {
        let shirt_numbers = if *year < 1954 { 0 } else { 1 };
        conn.execute(
            "INSERT OR IGNORE INTO tournaments (name, year, host, winner, shirt_numbers) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["FIFA World Cup", year, host, winner, shirt_numbers],
        )?;
        let tournaments: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tournament_phases WHERE tournament_id = (SELECT id FROM tournaments WHERE year = ?1)",
            [year],
            |r| r.get(0),
        )?;
        if tournaments == 0 {
            for (i, spec) in formats_for(*year).iter().enumerate() {
                conn.execute(
                    "INSERT INTO tournament_phases (tournament_id, seq, key, name, phase_type, group_count, entry_teams)
                     VALUES ((SELECT id FROM tournaments WHERE year = ?1), ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        year,
                        i as i32,
                        spec.key,
                        spec.name,
                        spec.phase_type,
                        spec.group_count,
                        spec.entry_teams,
                    ],
                )?;
            }
        }
    }
    Ok(())
}

fn seed_2022_demo(conn: &Connection) -> rusqlite::Result<()> {
    let tournament_id: i64 = conn.query_row(
        "SELECT id FROM tournaments WHERE year = 2022",
        [],
        |r| r.get(0),
    )?;

    for &(_year, name, group, rating) in WC2022_GROUPS {
        let id = match team_by_name(conn, name)? {
            Some(id) => id,
            None => insert_team(conn, name, None, None, rating, None)?,
        };
        conn.execute(
            "INSERT OR IGNORE INTO tournament_teams (tournament_id, team_id) VALUES (?1, ?2)",
            rusqlite::params![tournament_id, id],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO tournament_groups (tournament_id, group_name, team_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![tournament_id, group, id],
        )?;
    }

    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1 AND stage = 'GROUP'",
        [tournament_id],
        |r| r.get(0),
    )?;
    if existing == 0 {
        fixture::generate(conn, tournament_id)?;
    }
    Ok(())
}

pub fn team_by_name(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM teams WHERE name = ?1")?;
    let mut rows = stmt.query_map([name], |r| r.get(0))?;
    Ok(rows.next().map(|r| r).transpose()?)
}

/// Inserts a team, deriving the team-level attributes from `rating` unless
/// `fields` overrides them.
pub fn insert_team(
    conn: &Connection,
    name: &str,
    code: Option<&str>,
    flag: Option<&str>,
    rating: i32,
    fields: Option<crate::models::TeamStatsFields>,
) -> rusqlite::Result<i64> {
    let f = fields.unwrap_or_else(|| crate::models::team_defaults(rating));
    conn.execute(
        "INSERT INTO teams (name, code, flag, rating, pedigree, home_support, form, morale)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            name,
            code,
            flag,
            rating,
            f.pedigree,
            f.home_support,
            f.form,
            f.morale
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn tournament_by_year(conn: &Connection, year: i32) -> rusqlite::Result<Option<Tournament>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, year, host, winner, start_date, end_date, shirt_numbers, logo FROM tournaments WHERE year = ?1",
    )?;
    let mut rows = stmt.query_map([year], |r| {
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
        })
    })?;
    Ok(rows.next().map(|r| r).transpose()?)
}