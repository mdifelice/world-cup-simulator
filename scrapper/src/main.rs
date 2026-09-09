//! Side-tool: pull real teams + squads for a World Cup edition from the
//! public Sofascore API and emit JSON ready to `POST /api/worldcups/{id}/import`.
//!
//! Usage:
//!   wcs-scrapper --year 2022
//!   wcs-scrapper --year 2022 --tournament-id 16 --season-id 41891
//!   wcs-scrapper --year 2022 --fetch-fixtures --out output/2022
//!
//! The output file (default `output/wc<year>.json`) matches the backend's
//! `ImportPayload` schema:
//!   { "teams": [ { name, code, flag, rating, group_letter, players: [...] } ] }

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use reqwest::blocking::Client;
use serde_json::Value;

const BASE: &str = "https://www.sofascore.com/api/v1";
pub const DEFAULT_TOURNAMENT_ID: u64 = 16; // FIFA World Cup

#[derive(Parser, Debug)]
#[command(name = "wcs-scrapper", about = "Scrape World Cup teams/squads from Sofascore")]
struct Args {
    /// World Cup year (e.g. 2022, 2018, ...)
    #[arg(long)]
    year: u16,

    /// Sofascore unique tournament id (default: FIFA World Cup = 16)
    #[arg(long, default_value_t = DEFAULT_TOURNAMENT_ID)]
    tournament_id: u64,

    /// Sofascore season id (auto-detected from the year when omitted)
    #[arg(long)]
    season_id: Option<u64>,

    /// Also pull the real fixture (matches) into the output
    #[arg(long)]
    fetch_fixtures: bool,

    /// Output JSON file path
    #[arg(long, default_value = "output")]
    out: PathBuf,

    /// Sofascore API base (useful for proxying)
    #[arg(long, default_value = BASE)]
    base: String,

    /// Seconds to wait between requests (be gentle with the API)
    #[arg(long, default_value_t = 0.2)]
    delay: f64,

    /// Optional session Cookie header (Sofascore 403s anonymous clients;
    /// copy the cookie from a logged-in browser session)
    #[arg(long)]
    cookie: Option<String>,
}

struct Scrapper {
    client: Client,
    base: String,
    cookie: Option<String>,
    delay: f64,
}

impl Scrapper {
    fn get(&self, path: &str) -> Result<Value> {
        let url = format!("{}/{}", self.base, path.trim_start_matches('/'));
        let mut req = self
            .client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")
            .header("Accept", "application/json");
        if let Some(c) = &self.cookie {
            req = req.header("Cookie", c);
        }
        let resp = req
            .send()
            .with_context(|| format!("GET {url} failed"))?;
        let json: Value = resp.error_for_status()?.json()?;
        std::thread::sleep(std::time::Duration::from_secs_f64(self.delay));
        Ok(json)
    }

    fn find_season(&self, tournament_id: u64, year: u16) -> Result<u64> {
        let data = self.get(&format!("/unique-tournament/{tournament_id}/seasons"))?;
        let seasons = data["seasons"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("no seasons in response"))?;
        let wanted = year.to_string();
        for s in seasons {
            let name = s["name"].as_str().unwrap_or("");
            let id = s["id"].as_u64().unwrap_or(0);
            if name == wanted || Some(wanted.as_str()) == s["year"].as_str() {
                return Ok(id);
            }
        }
        anyhow::bail!("no Sofascore season found for {year} (saw: {:?})", seasons.iter().map(|s| s["name"].as_str().unwrap_or("?")).take(10).collect::<Vec<_>>())
    }

    fn standings(&self, tournament_id: u64, season_id: u64, year: u16) -> Result<Vec<TeamRow>> {
        let data = self.get(&format!(
            "/unique-tournament/{tournament_id}/season/{season_id}/standings"
        ))?;
        let mut rows: Vec<TeamRow> = Vec::new();

        let groups = data["standings"][0]["groups"].as_object();
        if let Some(groups) = groups {
            for (letter, group) in groups {
                for row in group["standings"].as_array().unwrap_or(&vec![]) {
                    rows.push(TeamRow::from_value(row, Some(letter.clone()), year)?);
                }
            }
        } else if let Some(tables) = data["standings"][0]["tables"].as_array() {
            for table in tables {
                for row in table["standings"].as_array().unwrap_or(&vec![]) {
                    rows.push(TeamRow::from_value(row, None, year)?);
                }
            }
        } else {
            anyhow::bail!("unexpected standings shape: {}", data);
        }
        Ok(rows)
    }

    fn squads(&self, tournament_id: u64, season_id: u64, sofascore_team_id: u64) -> Result<Vec<PlayerRow>> {
        let data = self.get(&format!(
            "/team/{sofascore_team_id}/unique-tournament/{tournament_id}/season/{season_id}/squads"
        ))?;
        let mut players = Vec::new();
        let fallback_r = data["ratingAverage"].as_f64();
        for p in data["players"].as_array().unwrap_or(&vec![]) {
            let name = p["player"]["name"]
                .as_str()
                .or_else(|| p["player"]["shortName"].as_str())
                .unwrap_or("Unknown")
                .to_string();
            let position = normalize_position(
                p["position"].as_str().unwrap_or("M").to_uppercase(),
            );
            let shirt = p["shirtNumber"].as_i64().map(|v| v as i32);
            let rating = player_rating(p, position.as_str(), fallback_r);
            players.push(PlayerRow {
                name,
                position,
                shirt_number: shirt,
                rating,
            });
        }
        Ok(players)
    }

    fn fixtures(&self, tournament_id: u64, season_id: u64, team_ids: &HashMap<u64, u64>) -> Result<Vec<FixtureRow>> {
        // `events/last` returns the season's matches (in reverse chronological
        // order for done seasons); large day window covers the whole cup.
        let data = self.get(&format!(
            "/unique-tournament/{tournament_id}/season/{season_id}/events/last/200",
        ))?;
        let empty: Vec<Value> = Vec::new();
        let events = data["events"].as_array().unwrap_or(&empty);
        let mut out = Vec::new();
        for e in events {
            let home = e["homeTeam"]["id"].as_u64();
            let away = e["awayTeam"]["id"].as_u64();
            let (Some(home), Some(away)) = (home, away) else { continue };
            if !team_ids.contains_key(&home) || !team_ids.contains_key(&away) {
                continue;
            }
            out.push(FixtureRow {
                home_team_id: *team_ids.get(&home).unwrap(),
                away_team_id: *team_ids.get(&away).unwrap(),
                round: e["roundInfo"]["round"].as_i64().unwrap_or(0),
                stage: infer_stage(&e["roundInfo"]["name"].as_str().unwrap_or("")),
                kickoff: e["startTimestamp"].as_i64().map(|ts| iso(ts)),
                home_score: e["homeScore"]["current"].as_i64().map(|v| v as i32),
                away_score: e["awayScore"]["current"].as_i64().map(|v| v as i32),
            });
        }
        Ok(out)
    }
}

#[derive(Debug)]
struct TeamRow {
    sofascore_id: u64,
    name: String,
    code: Option<String>,
    country_code: Option<String>,
    group: Option<String>,
    points: Option<f64>,
}

impl TeamRow {
    fn from_value(row: &Value, group: Option<String>, _year: u16) -> Result<Self> {
        let team = &row["team"];
        Ok(TeamRow {
            sofascore_id: team["id"].as_u64().ok_or_else(|| anyhow::anyhow!("team id missing"))?,
            name: team["name"].as_str().unwrap_or("?").to_string(),
            code: team["shortName"].as_str().map(|s| s.to_string()),
            country_code: team["country"]["alpha2"].as_str().map(|s| s.to_string()),
            group,
            points: row["points"].as_f64(),
        })
    }
}

#[derive(Debug)]
struct PlayerRow {
    name: String,
    position: String,
    shirt_number: Option<i32>,
    rating: i32,
}

#[derive(Debug)]
struct FixtureRow {
    home_team_id: u64,
    away_team_id: u64,
    round: i64,
    stage: String,
    kickoff: Option<String>,
    home_score: Option<i32>,
    away_score: Option<i32>,
}

fn normalize_position(pos: String) -> String {
    match pos.as_str() {
        "G" | "GK" | "GOALKEEPER" => "GK".to_string(),
        "D" | "DF" | "DEFENDER" => "DF".to_string(),
        "M" | "MF" | "MIDFIELDER" => "MF".to_string(),
        "F" | "FW" | "ATTACKER" | "ST" => "FW".to_string(),
        other => {
            // sofascore sometimes returns "D" via `position.name`; keep last resort
            if other.chars().any(|c| c == 'M') {
                "MF".to_string()
            } else {
                "DF".to_string()
            }
        }
    }
}

fn player_rating(_p: &Value, position: &str, fallback: Option<f64>) -> i32 {
    let base = fallback.unwrap_or(70.0);
    // position-form quality proxy: rating near squad average
    let delta = match position {
        "GK" => 1.0,
        "DF" => -2.0,
        "MF" => 0.0,
        "FW" => 2.0,
        _ => 0.0,
    };
    (base + delta).round().clamp(40.0, 96.0) as i32
}

fn flag_from_code(code: &str) -> String {
    // "AR" -> "🇦🇷"
    code.chars()
        .filter_map(|c| {
            c.to_ascii_uppercase()
                .is_ascii_alphabetic()
                .then(|| char::from_u32(0x1F1E6 + (c.to_ascii_uppercase() as u32) - 65).unwrap())
        })
        .collect()
}

fn infer_stage(round_name: &str) -> String {
    let r = round_name.to_lowercase();
    if r.contains("final") && !r.contains("semi") {
        "Final".to_string()
    } else if r.contains("semi") {
        "SF".to_string()
    } else if r.contains("quarter") {
        "QF".to_string()
    } else if r.contains("round of 16") || r.contains("16th final") {
        "R16".to_string()
    } else if r.contains("third") {
        "ThirdPlace".to_string()
    } else if r.contains("group") {
        "GROUP".to_string()
    } else {
        "GROUP".to_string()
    }
}

fn iso(ts: i64) -> String {
    chrono_like(ts)
}

fn chrono_like(ts: i64) -> String {
    let secs = ts as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // days since epoch -> civil date (Howard Hinnant algorithm)
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let h = rem / 3600;
    let mi = (rem % 3600) / 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:00Z")
}

fn main() -> Result<()> {
    let args = Args::parse();

    let client = Client::builder()
        .user_agent("Mozilla/5.0 (WCS-scrapper; research)")
        .build()?;
    let sx = Scrapper {
        client,
        base: args.base.clone(),
        cookie: args.cookie.clone(),
        delay: args.delay,
    };

    let season_id = match args.season_id {
        Some(id) => id,
        None => sx.find_season(args.tournament_id, args.year)?,
    };
    println!(
        "Scraping WC {} · unique-tournament={} season={}",
        args.year, args.tournament_id, season_id
    );

    let standings = sx.standings(args.tournament_id, season_id, args.year)?;
    println!("Found {} teams in standings.", standings.len());

    // sofascore team id -> local sequential team id
    let mut team_ids: HashMap<u64, u64> = HashMap::new();
    let mut local_id: u64 = 1;

    let base_rating = 62.0_f64; // mid-pack baseline; refined below

    let mut teams: Vec<Value> = Vec::new();
    for row in &standings {
        let sq = sx.squads(args.tournament_id, season_id, row.sofascore_id)?;
        let squad_avg = if sq.is_empty() {
            base_rating + row.points.unwrap_or(3.0) * 3.0
        } else {
            sq.iter().map(|p| p.rating).sum::<i32>() as f64 / sq.len() as f64
        };
        let rating = (squad_avg).round().clamp(40.0, 96.0) as i32;

        let players: Vec<Value> = sq
            .iter()
            .map(|p| {
                serde_json::json!({
                    "name": p.name,
                    "position": p.position,
                    "shirt_number": p.shirt_number,
                    "rating": p.rating,
                })
            })
            .collect();

        let code = row.code.clone().unwrap_or_default();
        teams.push(serde_json::json!({
            "name": row.name,
            "code": if code.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(code.clone()) },
            "flag": row.country_code.clone()
                .map(|c| flag_from_code(&c))
                .filter(|f| f.len() >= 2)
                .unwrap_or_default(),
            "rating": rating,
            "group_letter": row.group,
            "players": players,
        }));
        team_ids.insert(row.sofascore_id, local_id);
        local_id += 1;
        println!("  {}", row.name);
    }

    let mut payload = serde_json::json!({ "teams": teams });

    if args.fetch_fixtures {
        let fixtures = sx.fixtures(args.tournament_id, season_id, &team_ids)?;
        payload["fixtures"] = serde_json::json!(
            fixtures.iter().map(|f| serde_json::json!({
                "home_team_id": f.home_team_id,
                "away_team_id": f.away_team_id,
                "kickoff": f.kickoff,
                "home_score": f.home_score,
                "away_score": f.away_score,
                "stage": f.stage,
                "round_num": f.round,
            })).collect::<Vec<_>>()
        );
        println!("Pulled {} fixture rows.", fixtures.len());
    }

    std::fs::create_dir_all(&args.out)?;
    let path = args.out.join(format!("wc{}.json", args.year));
    let text = serde_json::to_string_pretty(&payload)?;
    std::fs::write(&path, text)?;
    println!("Wrote {}", path.display());
    Ok(())
}