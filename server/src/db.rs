use std::path::Path;

use rusqlite::Connection;

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
    (2026, "United States / Mexico / Canada", None),
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
            end_date TEXT
        );

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
            rating INTEGER NOT NULL DEFAULT 70
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
            reflexes INTEGER, handling INTEGER, kicking INTEGER, aerial INTEGER
        );

        /* player <-> team membership is tournament-scoped: a player can
           represent different nations in different editions. */
        CREATE TABLE IF NOT EXISTS player_callups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
            tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            position TEXT NOT NULL DEFAULT 'CM',
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

pub fn open() -> rusqlite::Result<Connection> {
    let dir = std::env::var("WCS_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    std::fs::create_dir_all(&dir).ok();
    let path = Path::new(&dir).join("wcs.sqlite");
    let conn = Connection::open(&path)?;
    schema(&conn)?;
    seed(&conn)?;
    Ok(conn)
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
    seed_2022_demo(conn)?;
    seed_2026_demo(conn)?;
    Ok(())
}

fn seed_tournaments(conn: &Connection) -> rusqlite::Result<()> {
    for (year, host, winner) in WORLD_CUPS {
        conn.execute(
            "INSERT OR IGNORE INTO tournaments (name, year, host, winner) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["FIFA World Cup", year, host, winner],
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
            None => {
                conn.execute(
                    "INSERT INTO teams (name, code, flag, rating) VALUES (?1, NULL, NULL, ?2)",
                    rusqlite::params![name, rating],
                )?;
                conn.last_insert_rowid()
            }
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

pub fn tournament_by_year(conn: &Connection, year: i32) -> rusqlite::Result<Option<Tournament>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, year, host, winner, start_date, end_date FROM tournaments WHERE year = ?1",
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
        })
    })?;
    Ok(rows.next().map(|r| r).transpose()?)
}