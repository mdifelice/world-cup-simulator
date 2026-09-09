use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Tournaments (any format, not just World Cups)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tournament {
    pub id: i64,
    pub name: String,
    pub year: i32,
    pub host: String,
    pub winner: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Whether players wore shirt numbers in this edition. Controls how the
    /// roster is sorted and displayed (before 1954 squads were unnumbered).
    pub shirt_numbers: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateTournament {
    pub name: String,
    pub year: i32,
    pub host: String,
    #[serde(default)]
    pub winner: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default = "default_shirt_numbers")]
    pub shirt_numbers: bool,
}

fn default_shirt_numbers() -> bool {
    true
}

/// A phase of a tournament (e.g. group stage, Round of 16, final).
///
/// `phase_type` is `GROUP` (round-robin; `group_count` groups) or
/// `KNOCKOUT` (`entry_teams` teams enter, no draws allowed).
/// A `GROUP` phase with `group_count == 1` is a league decider
/// (e.g. the 1950 final round).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Phase {
    pub id: i64,
    pub tournament_id: i64,
    pub seq: i32,
    /// Stable machine key (GROUP, R32, R16, QF, SF, THIRD, F, ...)
    pub key: String,
    /// Human label ("Group stage", "Round of 16", ...)
    pub name: String,
    pub phase_type: String,
    pub group_count: Option<i32>,
    pub entry_teams: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePhase {
    /// Order is assigned by the server (position in the list); this field is
    /// accepted for API compatibility but ignored.
    #[serde(default)]
    pub seq: i32,
    pub key: String,
    pub name: String,
    pub phase_type: String,
    #[serde(default)]
    pub group_count: Option<i32>,
    #[serde(default)]
    pub entry_teams: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePhases {
    pub phases: Vec<CreatePhase>,
}

// ---------------------------------------------------------------------------
// Teams & participants
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Team {
    pub id: i64,
    pub name: String,
    pub code: Option<String>,
    pub flag: Option<String>,
    /// Base strength used to generate placeholder squads when no players exist.
    pub rating: i32,
    /// Static "big-game gene": extra edge in knockouts.
    pub pedigree: i32,
    /// Static host/fan edge (only meaningful for the home side).
    pub home_support: i32,
    /// Dynamic form (0–99); drifts with results during a tournament.
    pub form: i32,
    /// Dynamic morale (0–99); reacts to results.
    pub morale: i32,
}

/// Defaults for the team-level attributes when not supplied explicitly.
/// `form`/`morale` are neutral at the start of a tournament; the static ones
/// are derived from the base rating so high-rated nations are also clutch.
pub fn team_defaults(rating: i32) -> TeamStatsFields {
    let pedigree = (25 + (rating - 55) * 2).clamp(20, 95);
    TeamStatsFields {
        pedigree,
        home_support: 50,
        form: 50,
        morale: 55,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TeamStatsFields {
    pub pedigree: i32,
    pub home_support: i32,
    pub form: i32,
    pub morale: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Participant {
    pub id: i64,
    pub name: String,
    pub code: Option<String>,
    pub flag: Option<String>,
    pub rating: i32,
    pub group_letter: Option<String>,
    pub pedigree: i32,
    pub home_support: i32,
    pub form: i32,
    pub morale: i32,
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
    #[serde(default)]
    pub pedigree: Option<i32>,
    #[serde(default)]
    pub home_support: Option<i32>,
    #[serde(default)]
    pub form: Option<i32>,
    #[serde(default)]
    pub morale: Option<i32>,
}

fn default_rating() -> i32 {
    70
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

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/// Granular positions, each mapped to a formation family via `position->family`.
pub const POSITIONS: &[&str] = &[
    "GK", "CB", "LB", "RB", "LWB", "RWB", "CDM", "CM", "CAM", "LM", "RM", "LW",
    "RW", "ST", "CF",
];

/// Formation families that pitch slots are drawn from.
pub const FAMILIES: &[&str] = &["GK", "DF", "MF", "FW"];

pub fn position_family(position: &str) -> &'static str {
    match position {
        "GK" => "GK",
        "CB" | "LB" | "RB" | "LWB" | "RWB" => "DF",
        "CDM" | "CM" | "CAM" | "LM" | "RM" => "MF",
        "LW" | "RW" | "ST" | "CF" => "FW",
        _ => "MF",
    }
}

/// A player's overall rating, computed as the position-weighted average of
/// their attributes (see `sim::composite_rating`).
pub const ATTRIBUTES: &[&str] = &[
    "pace", "stamina", "strength", "dribbling", "passing", "shooting",
    "tackling", "vision", "positioning", "composure", "reflexes", "handling",
    "kicking", "aerial", "decisions", "aggression", "concentration", "leadership",
];

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Player {
    pub id: i64,
    pub name: String,
    pub dob: Option<String>,
    pub nationality: Option<String>,
    /// Position in this call-up (granular, e.g. "CDM").
    pub position: String,
    pub shirt_number: Option<i32>,
    pub pace: Option<i32>,
    pub stamina: Option<i32>,
    pub strength: Option<i32>,
    pub dribbling: Option<i32>,
    pub passing: Option<i32>,
    pub shooting: Option<i32>,
    pub tackling: Option<i32>,
    pub vision: Option<i32>,
    pub positioning: Option<i32>,
    pub composure: Option<i32>,
    pub reflexes: Option<i32>,
    pub handling: Option<i32>,
    pub kicking: Option<i32>,
    pub aerial: Option<i32>,
    pub decisions: Option<i32>,
    pub aggression: Option<i32>,
    pub concentration: Option<i32>,
    pub leadership: Option<i32>,
    /// Position-weighted overall rating (mirrors `sim::composite_rating`).
    pub overall: f64,
}

/// Individual attributes are optional; unset fields default to 60 on insert.
#[derive(Debug, Deserialize)]
pub struct CreatePlayer {
    pub name: String,
    #[serde(default = "default_position")]
    pub position: String,
    #[serde(default)]
    pub shirt_number: Option<i32>,
    /// Back-compat with scraper output: when set, all attributes are derived
    /// from it with a small per-player spread instead of the individual fields.
    #[serde(default)]
    pub rating: Option<i32>,
    #[serde(default = "default_attr")]
    pub pace: i32,
    #[serde(default = "default_attr")]
    pub stamina: i32,
    #[serde(default = "default_attr")]
    pub strength: i32,
    #[serde(default = "default_attr")]
    pub dribbling: i32,
    #[serde(default = "default_attr")]
    pub passing: i32,
    #[serde(default = "default_attr")]
    pub shooting: i32,
    #[serde(default = "default_attr")]
    pub tackling: i32,
    #[serde(default = "default_attr")]
    pub vision: i32,
    #[serde(default = "default_attr")]
    pub positioning: i32,
    #[serde(default = "default_attr")]
    pub composure: i32,
    #[serde(default = "default_attr")]
    pub reflexes: i32,
    #[serde(default = "default_attr")]
    pub handling: i32,
    #[serde(default = "default_attr")]
    pub kicking: i32,
    #[serde(default = "default_attr")]
    pub aerial: i32,
    #[serde(default = "default_attr")]
    pub decisions: i32,
    #[serde(default = "default_attr")]
    pub aggression: i32,
    #[serde(default = "default_attr")]
    pub concentration: i32,
    #[serde(default = "default_attr")]
    pub leadership: i32,
}

fn default_position() -> String {
    "CM".to_string()
}

fn default_attr() -> i32 {
    60
}

/// Batch import payload produced by the scraper (single `rating` per player
/// is mapped onto all attributes on insert).
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
    pub pedigree: Option<i32>,
    #[serde(default)]
    pub home_support: Option<i32>,
    #[serde(default)]
    pub form: Option<i32>,
    #[serde(default)]
    pub morale: Option<i32>,
    #[serde(default)]
    pub players: Vec<CreatePlayer>,
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Match {
    pub id: i64,
    pub tournament_id: i64,
    /// Phase key (GROUP, R32, R16, QF, SF, THIRD, F, ...).
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

// ---------------------------------------------------------------------------
// Auth (OAuth only)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: i64,
    pub provider: String,
    pub display_name: String,
    pub email: Option<String>,
    pub created_at: String,
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

// ---------------------------------------------------------------------------
// Full tournament run (the "play a cup" flow)
// ---------------------------------------------------------------------------

/// Everything needed to render and play back a full cup run. Computed
/// anonymously on demand; only saved (as JSON in `sim_runs`) for logged-in
/// users who ask to keep it.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunPayload {
    pub run_id: Option<i64>,
    pub tournament_id: i64,
    pub tournament_name: String,
    pub year: i32,
    pub host: String,
    pub shirt_numbers: bool,
    pub focus_team_id: Option<i64>,
    /// Match ids in the order they should be revealed.
    pub order: Vec<i64>,
    pub matches: Vec<RunMatch>,
    /// Group assignments used for the group phase (letter + team ids/names).
    pub groups: Vec<GroupInfo>,
    pub awards: Awards,
    pub champion: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GroupInfo {
    pub name: String,
    pub teams: Vec<RunTeam>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunTeam {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunMatch {
    pub id: i64,
    /// 1-based chronological reveal step/day.
    pub day: i32,
    pub stage_key: String,
    pub stage_name: String,
    pub home_team_id: i64,
    pub away_team_id: i64,
    pub home_team_name: String,
    pub away_team_name: String,
    /// Regulation score (draws in knockouts are then settled).
    pub home_score: i32,
    pub away_score: i32,
    /// True when a knockout tie went to extra time.
    pub extra_time: bool,
    pub penalties: Option<PenResult>,
    /// Human-readable outcome, e.g. "2–1", "1–1 aet", "0–0 aet (5–4 pens)".
    pub result_label: String,
    pub goals: Vec<Goal>,
    /// Minute-by-minute momentum (only present for the user's team's matches).
    pub momentum: Option<Momentum>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PenResult {
    pub home_score: i32,
    pub away_score: i32,
    pub winner_id: i64,
    pub sudden_death: bool,
    pub kicks: Vec<PenKick>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PenKick {
    /// 1-based "team round"; rounds 1-5 are the set of five, 6+ sudden death.
    pub round: i32,
    pub team_id: i64,
    pub taker: String,
    pub scored: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Goal {
    pub minute: i32,
    /// 0 = penalty, 1 = extra time.
    pub extra_time: bool,
    pub team_id: i64,
    pub scorer_id: i64,
    pub scorer: String,
    pub assist_id: Option<i64>,
    pub assist: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Momentum {
    /// Per-minute dominance (0..1) for home then away, length = regulation
    /// minutes (90) or regulation + extra time (120).
    pub home: Vec<f64>,
    pub away: Vec<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Awards {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub golden: Option<PlayerAward>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silver: Option<PlayerAward>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bronze: Option<PlayerAward>,
    pub top_scorers: Vec<TopScorer>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlayerAward {
    pub player_id: i64,
    pub name: String,
    pub team_id: i64,
    pub team_name: String,
    pub position: String,
    pub games: i32,
    pub goals: i32,
    pub assists: i32,
    /// Aggregate performance score used to rank the awards.
    pub score: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TopScorer {
    pub player_id: i64,
    pub name: String,
    pub team_id: i64,
    pub team_name: String,
    pub position: String,
    pub goals: i32,
    pub assists: i32,
}