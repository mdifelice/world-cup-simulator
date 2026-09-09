use std::path::Path;

use rusqlite::Connection;

use crate::{
    fixture,
    models::WorldCup,
};

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

/// Playable demo data: the real 32 participants of Qatar 2022 with their
/// group letters and an overall team rating.
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
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS worldcups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            year INTEGER NOT NULL UNIQUE,
            host TEXT NOT NULL,
            winner TEXT,
            start_date TEXT,
            end_date TEXT,
            group_count INTEGER NOT NULL DEFAULT 8
        );

        CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            code TEXT,
            flag TEXT,
            rating INTEGER NOT NULL DEFAULT 70
        );

        CREATE TABLE IF NOT EXISTS worldcup_teams (
            worldcup_id INTEGER NOT NULL REFERENCES worldcups(id) ON DELETE CASCADE,
            team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            group_letter TEXT,
            PRIMARY KEY (worldcup_id, team_id)
        );

        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            position TEXT NOT NULL,
            shirt_number INTEGER,
            rating INTEGER NOT NULL DEFAULT 70
        );

        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worldcup_id INTEGER NOT NULL REFERENCES worldcups(id) ON DELETE CASCADE,
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

        CREATE INDEX IF NOT EXISTS idx_matches_wc ON matches(worldcup_id);
        CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
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

fn seed(conn: &Connection) -> rusqlite::Result<()> {
    seed_world_cups(conn)?;
    seed_wc2022(&conn)?;
    Ok(())
}

fn seed_world_cups(conn: &Connection) -> rusqlite::Result<()> {
    for (year, host, winner) in WORLD_CUPS {
        conn.execute(
            "INSERT OR IGNORE INTO worldcups (year, host, winner, group_count) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![year, host, winner, if *year >= 1998 { 8 } else { 6 }],
        )?;
    }
    Ok(())
}

fn seed_wc2022(conn: &Connection) -> rusqlite::Result<()> {
    let wc_id = conn.query_row("SELECT id FROM worldcups WHERE year = 2022", [], |r| {
        r.get::<_, i64>(0)
    })?;

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
            "INSERT OR IGNORE INTO worldcup_teams (worldcup_id, team_id, group_letter) VALUES (?1, ?2, ?3)",
            rusqlite::params![wc_id, id, group],
        )?;
    }

    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE worldcup_id = ?1",
        [wc_id],
        |r| r.get(0),
    )?;
    if existing == 0 {
        fixture::generate(conn, wc_id)?;
    }
    Ok(())
}

pub fn team_by_name(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM teams WHERE name = ?1")?;
    let mut rows = stmt.query_map([name], |r| r.get(0))?;
    Ok(rows.next().map(|r| r).transpose()?)
}

pub fn worldcup_by_year(conn: &Connection, year: i32) -> rusqlite::Result<Option<WorldCup>> {
    let mut stmt = conn.prepare(
        "SELECT id, year, host, winner, start_date, end_date, group_count FROM worldcups WHERE year = ?1",
    )?;
    let mut rows = stmt.query_map([year], |r| {
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
    Ok(rows.next().map(|r| r).transpose()?)
}