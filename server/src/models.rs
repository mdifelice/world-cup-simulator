use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorldCup {
    pub id: i64,
    pub year: i32,
    pub host: String,
    pub winner: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub group_count: i32,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorldCup {
    pub year: i32,
    pub host: String,
    pub winner: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default = "default_groups")]
    pub group_count: i32,
}

fn default_groups() -> i32 {
    8
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Team {
    pub id: i64,
    pub name: String,
    pub code: Option<String>,
    pub flag: Option<String>,
    pub rating: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Participant {
    pub id: i64,
    pub name: String,
    pub code: Option<String>,
    pub flag: Option<String>,
    pub rating: i32,
    pub group_letter: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTeam {
    pub name: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub flag: Option<String>,
    #[serde(default = "default_rating")]
    pub rating: i32,
}

fn default_rating() -> i32 {
    70
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Player {
    pub id: i64,
    pub team_id: i64,
    pub name: String,
    pub position: String,
    pub shirt_number: Option<i32>,
    pub rating: i32,
}

#[derive(Debug, Deserialize)]
pub struct CreatePlayer {
    pub name: String,
    /// One of: GK, DF, MF, FW
    pub position: String,
    #[serde(default)]
    pub shirt_number: Option<i32>,
    #[serde(default = "default_rating")]
    pub rating: i32,
}

/// Batch import payload produced by the Sofascore scraper.
#[derive(Debug, Deserialize)]
pub struct ImportPayload {
    pub teams: Vec<ImportTeam>,
}

#[derive(Debug, Deserialize)]
pub struct ImportTeam {
    pub name: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub flag: Option<String>,
    #[serde(default = "default_rating")]
    pub rating: i32,
    #[serde(default)]
    pub group_letter: Option<String>,
    #[serde(default)]
    pub players: Vec<CreatePlayer>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Match {
    pub id: i64,
    pub worldcup_id: i64,
    /// GROUP, R16, QF, SF, F (or user-defined like "ThirdPlace")
    pub stage: String,
    pub round_num: i32,
    pub matchday: Option<i32>,
    pub home_team_id: i64,
    pub away_team_id: i64,
    pub kickoff: Option<String>,
    pub home_team_name: String,
    pub away_team_name: String,
    pub home_score: Option<i32>,
    pub away_score: Option<i32>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMatch {
    pub stage: String,
    #[serde(default)]
    pub round_num: i32,
    #[serde(default)]
    pub matchday: Option<i32>,
    pub home_team_id: i64,
    pub away_team_id: i64,
    #[serde(default)]
    pub kickoff: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddParticipants {
    /// [{ "team_id": 1, "group_letter": "A" }, ...]
    pub participations: Vec<ParticipationIn>,
}

#[derive(Debug, Deserialize)]
pub struct ParticipationIn {
    pub team_id: i64,
    #[serde(default)]
    pub group_letter: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterIn {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginIn {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthOut {
    pub token: String,
    pub user: User,
}

#[derive(Debug, Serialize)]
pub struct SimulateOut {
    pub simulated: usize,
    pub champion: Option<String>,
}