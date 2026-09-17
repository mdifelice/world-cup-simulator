//! Detailed, replayable tournament run engine.
//!
//! Unlike `sim::simulate_tournament` (which writes match rows and only keeps
//! scores), this engine plays every match in memory with full detail — goal
//! minutes, scorers/assists, extra time and penalties, a minute-by-minute
//! momentum series for the user's team, and per-player stats feeding the
//! awards. Nothing is written to the database; the resulting `RunPayload` is
//! returned to the client and optionally saved as JSON for logged-in users.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{
    error::{ApiError, ApiResult},
    fixture,
    models::{
        self, Awards, Goal, GroupInfo, Momentum, PenKick, PenResult, PlayerAward, RedCard,
        RunMatch, RunPayload, RunTeam, TopScorer,
    },
    names::{self, SquadPlayer},
    sim,
};

/// A starting XI a user picked for one of their team's matches, keyed in
/// `RunRequest.lineups` by `"{stage_key}|{day}|{home}|{away}"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineupConfig {
    /// One of the formation keys shared with the client (e.g. "4-4-2").
    pub formation: String,
    #[serde(default = "default_strategy")]
    pub strategy: String,
    /// Slot -> player ids, one per occurrence in the formation's slot order
    /// (two "DF" slots take two ids). Missing slots are auto-filled; an id
    /// already fielded is skipped.
    #[serde(default)]
    pub starting: HashMap<String, Vec<i64>>,
}

fn default_strategy() -> String {
    "normal".to_string()
}

pub struct RunRequest {
    pub focus_team_id: Option<i64>,
    pub focus_boost: i32,
    /// Deterministic base seed. `None` mints one (and the payload echoes it).
    pub seed: Option<u64>,
    /// Per-match lineups for the focus team; see [`LineupConfig`].
    pub lineups: HashMap<String, LineupConfig>,
    /// Whether to persist the run for the signed-in user.
    pub save: bool,
}

// Expected-goals calibration. Equal-strength sides should produce ~2.7 total
// goals (real World Cups average ~2.7, 2022 = 2.69). The strength factor is
// deliberately flattened (diff / 20 instead of / 10): real favourites win by
// control, not by running up basketball scores, so a big mismatch should reach
// ~3.5 total xG, not 4.5+.
const BASE_GOALS: f64 = 0.88;
const HOME_FACTOR: f64 = 1.08;

// ---------------------------------------------------------------------------
// Formations
// ---------------------------------------------------------------------------

/// Canonical slot order per formation (defence line first, then midfield,
/// then attack) — mirrored by the client's lineup screen.
fn formation_slots(formation: &str) -> Option<&'static [&'static str]> {
    match formation {
        "5-3-2" => Some(&["GK", "RWB", "DF", "DF", "DF", "LWB", "DMF", "DMF", "AMF", "FW", "FW"]),
        "5-4-1" => Some(&["GK", "RWB", "DF", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW"]),
        "4-5-1" => Some(&["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "DMF", "LMF", "AMF", "FW"]),
        "4-4-2" => Some(&["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW", "FW"]),
        "4-3-3" => Some(&["GK", "RWB", "DF", "DF", "LWB", "DMF", "DMF", "AMF", "RFW", "FW", "LFW"]),
        "3-5-2" => Some(&["GK", "DF", "DF", "DF", "RMF", "DMF", "DMF", "LMF", "AMF", "FW", "FW"]),
        "3-4-3" => Some(&["GK", "DF", "DF", "DF", "RMF", "DMF", "LMF", "AMF", "RFW", "FW", "LFW"]),
        _ => None,
    }
}

/// Slot list after applying the strategy. In a 3-4-3 the four-man midfield
/// reshapes completely: defensive → 3 DMF + 1 AMF, normal → 1 DMF + 1 RMF +
/// 1 LMF + 1 AMF, attacking → 1 DMF + 3 AMF. Other formations keep the
/// generic swap (defensive: AMF → DMF; attacking: last DMF → AMF).
fn effective_slots(formation: &str, strategy: &str) -> Vec<&'static str> {
    let base = formation_slots(formation).unwrap_or(four_four_two()).to_vec();
    let mut slots = base;
    if formation == "3-4-3" {
        // Slots 4..8 are the midfield line after GK + three DF.
        let mid: &[&'static str] = match strategy {
            "defensive" => &["DMF", "DMF", "DMF", "AMF"],
            "attacking" => &["DMF", "AMF", "AMF", "AMF"],
            _ => &["RMF", "DMF", "LMF", "AMF"],
        };
        slots[4..8].copy_from_slice(mid);
        return slots;
    }
    if strategy == "defensive" {
        if let Some(i) = slots.iter().position(|s| *s == "AMF") {
            slots[i] = "DMF";
        }
    } else if strategy == "attacking" {
        if let Some(i) = slots.iter().rposition(|s| *s == "DMF") {
            slots[i] = "AMF";
        }
    }
    slots
}

const fn four_four_two() -> &'static [&'static str] {
    &["GK", "RWB", "DF", "DF", "LWB", "RMF", "DMF", "LMF", "AMF", "FW", "FW"]
}

/// How much a strategy nudges a team's expected goals (scoring vs conceding).
fn strategy_adj(strategy: &str, scoring: bool) -> f64 {
    match (strategy, scoring) {
        ("attacking", true) => 0.14,
        ("attacking", false) => 0.08,
        ("defensive", true) => -0.08,
        ("defensive", false) => -0.14,
        _ => 0.0,
    }
}

/// Deterministic per-match seed mixing: same base seed + identity yields the
/// same match, so changing a lineup never reshuffles other fixtures.
fn match_seed(run_seed: u64, key: &str, day: i32, home: i64, away: i64, knockout: bool) -> u64 {
    let mut x = run_seed ^ str_key(key);
    for v in [day as u64, home as u64, away as u64, knockout as u64] {
        x ^= v;
        x = splitmix64(x);
    }
    x | 1
}

fn splitmix64(x: u64) -> u64 {
    let z = x.wrapping_add(0x9E3779B97F4A7C15);
    let z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    let z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

/// Stable u64 fingerprint of a string (FNV-1a variant with rotation).
fn str_key(s: &str) -> u64 {
    s.bytes().fold(0x243F6A8885A308D3u64, |acc, b| {
        acc.rotate_left(8).wrapping_add(b as u64).wrapping_mul(0x100000001B3)
    })
}

/// `n` times the home team, then `n` times the away team (unshuffled).
fn team_labels(home: i64, away: i64, home_n: i32, away_n: i32) -> Vec<i64> {
    let mut v = Vec::with_capacity((home_n + away_n) as usize);
    for _ in 0..home_n {
        v.push(home);
    }
    for _ in 0..away_n {
        v.push(away);
    }
    v
}

/// Fisher–Yates shuffle using the shared PRNG.
fn shuffled(rng: &mut sim::Rng, mut v: Vec<i64>) -> Vec<i64> {
    for i in (1..v.len()).rev() {
        let j = (rng.unit() * (i + 1) as f64) as usize;
        v.swap(i, j);
    }
    v
}

/// `n` minutes within `1..=max` that are — as much as an RNG can manage —
/// far apart, so a match never clusters goals into one or two minutes.
/// Two goals in the same (or an adjacent) minute is the exception, not the
/// rule.
fn spaced_minutes(rng: &mut sim::Rng, n: usize, max: i32) -> Vec<i32> {
    const GAP: i32 = 8;
    let mut mins: Vec<i32> = Vec::with_capacity(n);
    let mut guard = 0;
    while mins.len() < n {
        let m = 1 + (rng.unit() * max as f64) as i32;
        if mins.iter().all(|&x| (x - m).abs() >= GAP) {
            mins.push(m);
        }
        guard += 1;
        if guard > 3000 {
            // Unlucky RNG path: sprinkle any missing minutes evenly (kept
            // distinct from the ones already drawn).
            mins.sort_unstable();
            let mut fill = 0usize;
            while mins.len() < n {
                let m = ((fill + 1) * GAP as usize).min(max as usize) as i32;
                if !mins.contains(&m) {
                    mins.push(m);
                } else {
                    let mut m2 = m - 1;
                    while m2 >= 1 && mins.contains(&m2) {
                        m2 -= 1;
                    }
                    if m2 >= 1 {
                        mins.push(m2);
                    } else {
                        mins.push(1);
                    }
                }
                fill += 1;
            }
            break;
        }
    }
    mins.sort_unstable();
    mins
}

/// Runs the whole tournament and returns the replay payload.
pub fn simulate_run(
    conn: &Connection,
    tournament_id: i64,
    req: &RunRequest,
) -> ApiResult<RunPayload> {
    let (name, year, host, shirt_numbers) = conn
        .query_row(
            "SELECT name, year, host, shirt_numbers FROM tournaments WHERE id = ?1",
            [tournament_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i32>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i32>(3)? != 0,
                ))
            },
        )?;

    let phases = sim::load_phases(conn, tournament_id)?;
    if phases.is_empty() {
        return Err(ApiError::bad_request("tournament has no phases defined"));
    }
    let team_ids = sim::participants(conn, tournament_id)?;
    if team_ids.is_empty() {
        return Err(ApiError::bad_request("tournament has no participants"));
    }

    let run_seed = req.seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E3779B97F4A7C15)
            | 1
    });

    let mut eng = Engine {
        conn,
        tournament_id,
        shirt_numbers,
        focus: req.focus_team_id,
        run_seed,
        lineups: req.lineups.clone(),
        rng: sim::Rng::new(),
        matches: Vec::new(),
        order: Vec::new(),
        groups: Vec::new(),
        perfs: HashMap::new(),
        team_names: HashMap::new(),
        team_codes: HashMap::new(),
        squads: HashMap::new(),
        team_bonus: HashMap::new(),
        champion: None,
        next_id: 1,
        day: 0,
        quals: team_ids,
        prev_winners: Vec::new(),
        prev_losers: Vec::new(),
        group_count: 0,
        played_groups: false,
        standings: Vec::new(),
        current_groups: Vec::new(),
        group_meta_built: false,
        form_shift: HashMap::new(),
        morale_shift: HashMap::new(),
        suspensions: HashMap::new(),
    };
    eng.run(&phases)?;

    let champion = eng.champion.clone();
    let awards = eng.finalize_awards()?;
    Ok(RunPayload {
        run_id: None,
        tournament_id,
        tournament_name: name,
        year,
        host,
        shirt_numbers,
        focus_team_id: req.focus_team_id,
        seed: run_seed,
        order: eng.order,
        matches: eng.matches,
        groups: eng.groups,
        awards,
        champion,
    })
}

#[derive(Debug, Default, Clone)]
struct Perf {
    name: String,
    team_id: i64,
    position: String,
    games: i32,
    rating_sum: f64,
    goals: i32,
    assists: i32,
    clean_sheets: i32,
}

/// One row in an in-memory group table.
#[derive(Debug, Clone)]
struct Row {
    team_id: i64,
    points: i32,
    gf: i32,
    ga: i32,
}

impl Row {
    fn gd(&self) -> i32 {
        self.gf - self.ga
    }
}

struct Engine<'a> {
    conn: &'a Connection,
    tournament_id: i64,
    shirt_numbers: bool,
    focus: Option<i64>,
    run_seed: u64,
    lineups: HashMap<String, LineupConfig>,
    rng: sim::Rng,
    matches: Vec<RunMatch>,
    order: Vec<i64>,
    groups: Vec<GroupInfo>,
    perfs: HashMap<i64, Perf>,
    team_names: HashMap<i64, String>,
    team_codes: HashMap<i64, String>,
    squads: HashMap<i64, Vec<SquadPlayer>>,
    team_bonus: HashMap<i64, f64>,
    champion: Option<String>,
    next_id: i64,
    day: i32,
    quals: Vec<i64>,
    prev_winners: Vec<i64>,
    prev_losers: Vec<i64>,
    group_count: usize,
    played_groups: bool,
    standings: Vec<Row>,
    current_groups: Vec<Vec<i64>>,
    group_meta_built: bool,
    /// Cumulative form/morale drift, mirroring `sim::apply_result` in memory.
    form_shift: HashMap<i64, i32>,
    morale_shift: HashMap<i64, i32>,
    /// Matches remaining for suspended players (red cards). A player with a
    /// positive count is excluded from his team's XI and decremented once his
    /// team plays.
    suspensions: HashMap<i64, i32>,
}

impl<'a> Engine<'a> {
    // ------------------------------------------------------------------
    // Phase orchestration
    // ------------------------------------------------------------------

    fn run(&mut self, phases: &[crate::models::Phase]) -> ApiResult<()> {
        for (idx, phase) in phases.iter().enumerate() {
            if self.champion.is_some() {
                break;
            }
            if phase.phase_type == "GROUP" {
                self.play_group_phase(phases, idx, phase)?;
            } else {
                self.play_knockout_phase(&phase.key, &phase.name)?;
            }
        }
        Ok(())
    }

    fn play_group_phase(
        &mut self,
        phases: &[crate::models::Phase],
        idx: usize,
        phase: &crate::models::Phase,
    ) -> ApiResult<()> {
        self.played_groups = true;
        self.standings.clear();
        self.current_groups = sim::group_assignments(
            self.conn,
            self.tournament_id,
            phase,
            &self.quals,
            sim::is_first_group_phase(phases, idx),
            false,
        )?;
        if !self.group_meta_built {
            self.build_group_meta()?;
            self.group_meta_built = true;
        }

        // One "day" per round across all groups (a real matchday). Real
        // imported fixtures are honoured when present, otherwise the
        // round-robin schedule is generated.
        let real = fixture::real_group_schedule(self.conn, self.tournament_id)?;
        let mut schedule: Vec<Vec<Vec<(i64, i64)>>> = Vec::new();
        for (gi, teams) in self.current_groups.iter().enumerate() {
            let by_round: Vec<Vec<(i64, i64)>> = match &real {
                Some(s) if gi < s.len() => s[gi].clone(),
                _ => {
                    let mut by_round: Vec<Vec<(i64, i64)>> = Vec::new();
                    for (h, a, round) in fixture::round_robin(teams) {
                        let r = round.max(1) as usize;
                        while by_round.len() < r {
                            by_round.push(Vec::new());
                        }
                        by_round[r - 1].push((h, a));
                    }
                    by_round
                }
            };
            schedule.push(by_round);
        }
        let max_rounds = schedule.iter().map(|s| s.len()).max().unwrap_or(0);
        for round in 0..max_rounds {
            self.day += 1;
            for (gi, by_round) in schedule.iter().enumerate() {
                if round >= by_round.len() {
                    continue;
                }
                for &(h, a) in &by_round[round] {
                    let stage_name = if phase.group_count == Some(1) {
                        phase.name.clone()
                    } else {
                        let letter = (b'A' + gi as u8) as char;
                        format!("{} {}", phase.name, letter)
                    };
                    self.play_match(h, a, &phase.key, &stage_name, false)?;
                }
            }
        }

        if phase.group_count == Some(1) {
            // League decider: the leader is the champion.
            let table = self.sorted_table();
            if let Some(top) = table.first() {
                let name = self.team_name(top.team_id)?;
                self.bump(top.team_id, 3.0);
                self.champion = Some(name);
            }
            return Ok(());
        }

        let entry = sim::next_entry(phases, idx) as usize;
        let tables = self.group_tables()?;
        let (q, m) = sim::advance(&tables, entry);
        self.quals = q;
        self.group_count = m;
        Ok(())
    }

    fn play_knockout_phase(&mut self, key: &str, name: &str) -> ApiResult<()> {
        let stage_teams: Vec<i64> = if key == "THIRD" {
            self.prev_losers.clone()
        } else {
            self.quals.clone()
        };
        if stage_teams.is_empty() {
            return Err(ApiError::bad_request("no teams to enter the knockout stage"));
        }

        let mut n = 1usize;
        while n * 2 <= stage_teams.len() {
            n *= 2;
        }
        let stage_teams = stage_teams[..n].to_vec();
        if stage_teams.len() < 2 {
            return Ok(());
        }

        if key == "THIRD" {
            // Both participants are semi-final losers → +1 podium credit each.
            let sf = [self.prev_losers.first().copied(), self.prev_losers.last().copied()];
            for team in sf.into_iter().flatten() {
                self.bump(team, 1.0);
            }
        }

        let pairings: Vec<(i64, i64)> = if !self.played_groups && self.prev_winners.is_empty() {
            sim::seeded_pairings(&stage_teams)?
        } else if self.group_count > 0 && self.prev_winners.is_empty() {
            sim::group_pairings(&stage_teams, self.group_count)?
        } else {
            sim::next_pairings(&stage_teams)?
        };

        // Each knockout round is its own matchday so per-match day lookups
        // stay unique (a team plays at most one match per day).
        self.day += 1;

        let mut winners = Vec::new();
        let mut losers = Vec::new();
        for (h, a) in pairings {
            let winner = self.play_match(h, a, key, name, true)?;
            let (w, l) = match winner {
                Some(w) if w == h => (h, a),
                Some(_) => (a, h),
                None => (h, a),
            };
            winners.push(w);
            losers.push(l);
        }

        if key == "F" {
            if let Some(w) = winners.first() {
                let cname = self.team_name(*w)?;
                self.bump(*w, 3.0);
                self.champion = Some(cname);
            }
            if let Some(r) = losers.first() {
                self.bump(*r, 2.0);
            }
        }

        self.prev_winners = winners;
        self.prev_losers = losers;
        if key != "THIRD" {
            self.quals = self.prev_winners.clone();
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Lookups
    // ------------------------------------------------------------------

    fn team_name(&mut self, team_id: i64) -> ApiResult<String> {
        if let Some(n) = self.team_names.get(&team_id) {
            return Ok(n.clone());
        }
        let n: String = self
            .conn
            .query_row("SELECT name FROM teams WHERE id = ?1", [team_id], |r| r.get(0))?;
        self.team_names.insert(team_id, n.clone());
        Ok(n)
    }

    fn team_code(&mut self, team_id: i64) -> ApiResult<Option<String>> {
        if let Some(c) = self.team_codes.get(&team_id) {
            return Ok(Some(c.clone()));
        }
        let c: Option<String> = self
            .conn
            .query_row("SELECT code FROM teams WHERE id = ?1", [team_id], |r| r.get(0))?;
        if let Some(ref c2) = c {
            self.team_codes.insert(team_id, c2.clone());
        }
        Ok(c)
    }

    fn squad(&mut self, team_id: i64) -> ApiResult<Vec<SquadPlayer>> {
        if let Some(s) = self.squads.get(&team_id) {
            return Ok(s.clone());
        }
        let s = names::squad_for_team(self.conn, self.tournament_id, team_id, self.shirt_numbers)?;
        self.squads.insert(team_id, s.clone());
        Ok(s)
    }

    /// Best XI (4-4-2) by overall within each position family — the default
    /// used for the opponent and for focus matches with no config yet.
    fn pick_xi(&mut self, team_id: i64) -> ApiResult<Vec<SquadPlayer>> {
        let squad = self.squad(team_id)?;
        let mut chosen = Vec::new();
        for (family, count) in [("GK", 1), ("DF", 4), ("MF", 4), ("FW", 2)] {
            let mut pool: Vec<SquadPlayer> = squad
                .iter()
                .filter(|p| {
                    crate::models::position_family(&p.position) == family
                        && !self.suspended(p.id)
                })
                .cloned()
                .collect();
            pool.sort_by(|a, b| {
                b.overall
                    .partial_cmp(&a.overall)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            for p in pool.into_iter().take(count) {
                chosen.push(p);
            }
        }
        if chosen.is_empty() {
            chosen = squad.into_iter().filter(|p| !self.suspended(p.id)).take(11).collect();
        }
        Ok(chosen)
    }

    /// XI for a side: the user's lineup when `cfg` is present (focus team
    /// only), otherwise the default 4-4-2. Off-position players get their
    /// slot penalty applied to their effective overall.
    fn pick_xi_for(
        &mut self,
        team_id: i64,
        cfg: Option<&LineupConfig>,
    ) -> ApiResult<Vec<SquadPlayer>> {
        match cfg {
            Some(c) => self.xi_from_config(team_id, c),
            None => self.pick_xi(team_id),
        }
    }

    fn xi_from_config(&mut self, team_id: i64, cfg: &LineupConfig) -> ApiResult<Vec<SquadPlayer>> {
        let squad = self.squad(team_id)?;
        let slots = effective_slots(&cfg.formation, &cfg.strategy);
        let mut used: HashSet<i64> = HashSet::new();
        let mut xi = Vec::with_capacity(11);
        // Repeated slots ("DF", "DF") each consume the next id for that slot.
        let mut occurrence: HashMap<&'static str, usize> = HashMap::new();
        for slot in &slots {
            let occ = occurrence.entry(slot).or_insert(0);
            let assigned = cfg
                .starting
                .get(*slot)
                .and_then(|ids| ids.get(*occ))
                .copied()
                .filter(|pid| {
                    !used.contains(pid)
                        && !self.suspended(*pid)
                        && squad.iter().any(|p| p.id == *pid)
                });
            *occ += 1;
            let pick = match assigned {
                Some(pid) => squad.iter().find(|p| p.id == pid).cloned(),
                None => self.best_for_slot(&squad, slot, &used),
            };
            if let Some(mut p) = pick {
                let penalty = models::best_slot_penalty(&p.positions, slot);
                p.overall = (p.overall - penalty as f64 * 2.0).clamp(30.0, 99.0);
                used.insert(p.id);
                xi.push(p);
            }
        }
        Ok(xi)
    }

    /// Best unused player for a slot, ranked by effective overall at that slot
    /// (so natural fits naturally float to the top).
    fn best_for_slot(
        &self,
        squad: &[SquadPlayer],
        slot: &str,
        used: &HashSet<i64>,
    ) -> Option<SquadPlayer> {
        let mut pool: Vec<SquadPlayer> = squad
            .iter()
            .filter(|p| !used.contains(&p.id) && !self.suspended(p.id))
            .cloned()
            .collect();
        pool.sort_by(|a, b| {
            let ea = a.overall - models::best_slot_penalty(&a.positions, slot) as f64 * 2.0;
            let eb = b.overall - models::best_slot_penalty(&b.positions, slot) as f64 * 2.0;
            eb.partial_cmp(&ea).unwrap_or(std::cmp::Ordering::Equal)
        });
        pool.into_iter().next()
    }

    /// Fractional xG edge from fielding a stronger/weaker XI than the squad
    /// average (only meaningful for the focus team's picks, applied uniformly
    /// so the auto XI baseline stays neutral).
    fn xi_strength_adj(&mut self, team_id: i64, xi: &[SquadPlayer]) -> ApiResult<f64> {
        let squad = self.squad(team_id)?;
        if squad.is_empty() || xi.is_empty() {
            return Ok(0.0);
        }
        let sq_avg: f64 = squad.iter().map(|p| p.overall).sum::<f64>() / squad.len() as f64;
        let xi_avg: f64 = xi.iter().map(|p| p.overall).sum::<f64>() / xi.len() as f64;
        Ok(((xi_avg - sq_avg) * 0.15).clamp(-1.2, 1.2))
    }

    fn perf(&mut self, p: &SquadPlayer, team_id: i64) -> &mut Perf {
        self.perfs.entry(p.id).or_insert_with(|| Perf {
            name: p.name.clone(),
            team_id,
            position: p.position.clone(),
            ..Perf::default()
        })
    }

    fn bump(&mut self, team_id: i64, bonus: f64) {
        *self.team_bonus.entry(team_id).or_insert(0.0) += bonus;
    }

    /// True when a player is currently serving a suspension.
    fn suspended(&self, player_id: i64) -> bool {
        self.suspensions.get(&player_id).copied().unwrap_or(0) > 0
    }

    fn strength(&self, team_id: i64, knockout: bool) -> ApiResult<f64> {
        let base = sim::base_strength(self.conn, self.tournament_id, team_id, knockout)?;
        let f = (*self.form_shift.get(&team_id).unwrap_or(&0)) as f64 * 0.06;
        let m = (*self.morale_shift.get(&team_id).unwrap_or(&0)) as f64 * 0.04;
        Ok((base + f + m).clamp(40.0, 99.0))
    }

    fn apply_drift(&mut self, home: i64, away: i64, hs: i32, as_: i32) {
        let (hf, hm, af, am) = if hs > as_ {
            (3, 4, -3, -5)
        } else if hs < as_ {
            (-3, -5, 3, 4)
        } else {
            (0, 1, 0, 1)
        };
        for (team, f, m) in [(home, hf, hm), (away, af, am)] {
            let fe = self.form_shift.entry(team).or_insert(0);
            *fe = (*fe + f).clamp(-50, 50);
            let me = self.morale_shift.entry(team).or_insert(0);
            *me = (*me + m).clamp(-50, 50);
        }
    }

    // ------------------------------------------------------------------
    // Groups
    // ------------------------------------------------------------------

    fn build_group_meta(&mut self) -> ApiResult<()> {
        let groups = self.current_groups.clone();
        let mut out = Vec::new();
        for (gi, teams) in groups.iter().enumerate() {
            let letter = (b'A' + gi as u8) as char;
            let mut run_teams = Vec::new();
            for &t in teams {
                run_teams.push(RunTeam {
                    id: t,
                    name: self.team_name(t)?,
                    code: self.team_code(t)?,
                });
            }
            out.push(GroupInfo {
                name: format!("Group {}", letter),
                teams: run_teams,
            });
        }
        self.groups = out;
        Ok(())
    }

    fn add_group_result(&mut self, home: i64, away: i64, hs: i32, as_: i32) {
        let (hp, ap) = if hs > as_ {
            (3, 0)
        } else if hs < as_ {
            (0, 3)
        } else {
            (1, 1)
        };
        for (team, gf, ga, pts) in [(home, hs, as_, hp), (away, as_, hs, ap)] {
            if !self.standings.iter().any(|r| r.team_id == team) {
                self.standings.push(Row {
                    team_id: team,
                    points: 0,
                    gf: 0,
                    ga: 0,
                });
            }
            if let Some(r) = self.standings.iter_mut().find(|r| r.team_id == team) {
                r.gf += gf;
                r.ga += ga;
                r.points += pts;
            }
        }
    }

    fn sorted_table(&mut self) -> Vec<Row> {
        let mut rows = self.standings.clone();
        let mut names: HashMap<i64, String> = HashMap::new();
        for r in &rows {
            if let Ok(n) = self.team_name(r.team_id) {
                names.insert(r.team_id, n);
            }
        }
        rows.sort_by(|x, y| {
            y.points
                .cmp(&x.points)
                .then(y.gd().cmp(&x.gd()))
                .then(y.gf.cmp(&x.gf))
                .then_with(|| {
                    let nx = names.get(&x.team_id).cloned().unwrap_or_default();
                    let ny = names.get(&y.team_id).cloned().unwrap_or_default();
                    nx.cmp(&ny)
                })
        });
        rows
    }

    fn group_tables(&self) -> ApiResult<Vec<Vec<fixture::Standing>>> {
        let mut tables = Vec::new();
        for group in &self.current_groups {
            let mut rows: Vec<fixture::Standing> = group
                .iter()
                .filter_map(|t| {
                    self.standings.iter().find(|r| r.team_id == *t).map(|r| fixture::Standing {
                        team_id: r.team_id,
                        points: r.points,
                        gf: r.gf,
                        ga: r.ga,
                    })
                })
                .collect();
            rows.sort_by(|x, y| {
                y.points
                    .cmp(&x.points)
                    .then(y.gd().cmp(&x.gd()))
                    .then(y.gf.cmp(&x.gf))
            });
            tables.push(rows);
        }
        Ok(tables)
    }

    // ------------------------------------------------------------------
    // Awards
    // ------------------------------------------------------------------

    fn finalize_awards(&mut self) -> ApiResult<Awards> {
        let mut players: Vec<Perf> = self.perfs.values().cloned().collect();
        players.sort_by(|a, b| {
            let sa = self.player_score(a);
            let sb = self.player_score(b);
            sb.partial_cmp(&sa)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });

        let golden = players.first().and_then(|p| self.medal(p));
        let silver = players.get(1).and_then(|p| self.medal(p));
        let bronze = players.get(2).and_then(|p| self.medal(p));

        let mut scorers: Vec<Perf> = self.perfs.values().filter(|p| p.goals > 0).cloned().collect();
        scorers.sort_by(|a, b| {
            b.goals
                .cmp(&a.goals)
                .then(b.assists.cmp(&a.assists))
                .then_with(|| a.name.cmp(&b.name))
        });
        let mut top_scorers = Vec::new();
        for p in scorers.into_iter().take(20) {
            top_scorers.push(TopScorer {
                player_id: 0,
                name: p.name.clone(),
                team_id: p.team_id,
                team_name: self.team_name(p.team_id).unwrap_or_default(),
                position: p.position.clone(),
                goals: p.goals,
                assists: p.assists,
            });
        }

        Ok(Awards {
            golden,
            silver,
            bronze,
            top_scorers,
        })
    }

    fn medal(&mut self, p: &Perf) -> Option<PlayerAward> {
        if p.games == 0 {
            return None;
        }
        Some(PlayerAward {
            player_id: 0,
            name: p.name.clone(),
            team_id: p.team_id,
            team_name: self.team_name(p.team_id).unwrap_or_default(),
            position: p.position.clone(),
            games: p.games,
            goals: p.goals,
            assists: p.assists,
            score: self.player_score(p),
        })
    }

    fn player_score(&self, p: &Perf) -> f64 {
        let bonus = self.team_bonus.get(&p.team_id).copied().unwrap_or(0.0);
        p.rating_sum + p.goals as f64 * 2.2 + p.assists as f64 * 1.1 + p.clean_sheets as f64 + bonus
    }

    // ------------------------------------------------------------------
    // Match engine
    // ------------------------------------------------------------------

    /// Plays one match in full detail. Returns the winner (always resolved in
    /// knockouts via extra time/penalties; `None` for group draws).
    #[allow(clippy::type_complexity)]
    fn play_match(
        &mut self,
        home: i64,
        away: i64,
        stage_key: &str,
        stage_name: &str,
        knockout: bool,
    ) -> ApiResult<Option<i64>> {
        // Deterministic per-match RNG: same seed + identity → identical match.
        // The day is assigned before group-phase matches (see
        // `play_group_phase`); knockout rounds reuse the last day but differ
        // by stage_key, so identities never collide.
        let key = format!("{stage_key}|{}|{}|{}", self.day, home, away);
        self.rng = sim::Rng::from_seed(match_seed(
            self.run_seed,
            &key,
            self.day,
            home,
            away,
            knockout,
        ));

        let cfg = self.lineups.get(&key).cloned();
        let focus = self.focus;
        let focus_cfg = |team: i64| {
            if focus == Some(team) {
                cfg.as_ref()
            } else {
                None
            }
        };
        let cfg_strategy = |team: i64| -> String {
            focus_cfg(team)
                .map(|c| c.strategy.clone())
                .unwrap_or_else(|| "normal".to_string())
        };
        let home_xi = self.pick_xi_for(home, focus_cfg(home))?;
        let away_xi = self.pick_xi_for(away, focus_cfg(away))?;

        let home_strat = cfg_strategy(home);
        let away_strat = cfg_strategy(away);
        let (h_xg0, a_xg0) = self.xg(home, away, knockout)?;
        let h_xg = (h_xg0 + self.xi_strength_adj(home, &home_xi)?
            + strategy_adj(&home_strat, true)
            + strategy_adj(&away_strat, false))
        .clamp(0.1, 4.5);
        let a_xg = (a_xg0 + self.xi_strength_adj(away, &away_xi)?
            + strategy_adj(&away_strat, true)
            + strategy_adj(&home_strat, false))
        .clamp(0.1, 4.5);

        // Red cards are drawn before the goals so the sending-off can swing the
        // rest of the match: the ten men create less and concede more, scaled by
        // how much time is left to play.
        let home_red = self.draw_red(&home_xi);
        let away_red = self.draw_red(&away_xi);
        let swing = |red: &Option<(i32, SquadPlayer)>, own: bool| -> f64 {
            match red {
                Some((minute, _)) => {
                    let frac = ((90 - *minute).max(0) as f64) / 90.0;
                    let factor = if own { 0.55 } else { 1.35 };
                    1.0 + (factor - 1.0) * frac
                }
                None => 1.0,
            }
        };
        let h_xg = (h_xg * swing(&home_red, true) * swing(&away_red, false)).clamp(0.05, 5.0);
        let a_xg = (a_xg * swing(&away_red, true) * swing(&home_red, false)).clamp(0.05, 5.0);

        let (hs0, aw0) = (
            sim::poisson(&mut self.rng, h_xg),
            sim::poisson(&mut self.rng, a_xg),
        );

        // Goals are spread out so two goals never land on (or very near) the
        // same minute — a burst of goals in one match minute is unrealistic.
        let mut goals = Vec::new();
        let total_reg = (hs0 + aw0) as usize;
        let reg_minutes = spaced_minutes(&mut self.rng, total_reg, 90);
        for (minute, team) in reg_minutes
            .into_iter()
            .zip(shuffled(&mut self.rng, team_labels(home, away, hs0, aw0)))
        {
            let (xi, opp, red) = if team == home {
                (&home_xi, &away_xi, &home_red)
            } else {
                (&away_xi, &home_xi, &away_red)
            };
            goals.push(self.make_goal(xi, opp, minute, false, team, red.as_ref()));
        }

        let mut extra_time = false;
        let mut penalties: Option<PenResult> = None;
        let mut hs = hs0;
        let mut aw = aw0;
        let mut winner = if hs > aw {
            Some(home)
        } else if aw > hs {
            Some(away)
        } else {
            None
        };

        if knockout && winner.is_none() {
            // Extra time: lower xG (tired legs).
            let hex = (h_xg * 0.45).clamp(0.05, 2.5);
            let aex = (a_xg * 0.45).clamp(0.05, 2.5);
            let (eh, ea) = (sim::poisson(&mut self.rng, hex), sim::poisson(&mut self.rng, aex));
            extra_time = true;
            let et_minutes = spaced_minutes(&mut self.rng, (eh + ea) as usize, 30);
            for (minute, team) in et_minutes
                .into_iter()
                .zip(shuffled(&mut self.rng, team_labels(home, away, eh, ea)))
            {
                let (xi, opp, red) = if team == home {
                    (&home_xi, &away_xi, &home_red)
                } else {
                    (&away_xi, &home_xi, &away_red)
                };
                goals.push(self.make_goal(xi, opp, 90 + minute, true, team, red.as_ref()));
            }
            goals.sort_by_key(|g| (g.minute, g.team_id));
            hs += eh;
            aw += ea;
            winner = if hs > aw {
                Some(home)
            } else if aw > hs {
                Some(away)
            } else {
                None
            };
        }

        if knockout && winner.is_none() {
            let p = self.play_penalties(home, &home_xi, away, &away_xi);
            winner = if p.winner_id == home { Some(home) } else { Some(away) };
            penalties = Some(p.clone());
            for k in &p.kicks {
                if k.scored {
                    if let Some(taker) = home_xi.iter().find(|pl| pl.name == k.taker) {
                        self.perf(taker, home).goals += 1;
                    } else if let Some(taker) = away_xi.iter().find(|pl| pl.name == k.taker) {
                        self.perf(taker, away).goals += 1;
                    }
                }
            }
        }

        // Sending-offs, in minute order.
        let mut reds = Vec::new();
        if let Some((minute, p)) = &home_red {
            reds.push(RedCard {
                minute: *minute,
                extra_time: false,
                team_id: home,
                player_id: p.id,
                player: p.name.clone(),
                player_photo: p.photo_url.clone(),
            });
        }
        if let Some((minute, p)) = &away_red {
            reds.push(RedCard {
                minute: *minute,
                extra_time: false,
                team_id: away,
                player_id: p.id,
                player: p.name.clone(),
                player_photo: p.photo_url.clone(),
            });
        }
        reds.sort_by_key(|r| r.minute);

        // Players already banned for this match (the focus team's, so the
        // lineup editor can lock them). Captured before the bans tick down.
        let mut unavailable: Vec<i64> = Vec::new();
        if let Some(ft) = self.focus.filter(|t| *t == home || *t == away) {
            for p in self.squad(ft)? {
                if self.suspended(p.id) {
                    unavailable.push(p.id);
                }
            }
        }

        // Per-match ratings + per-player event stats.
        let (h_result, a_result) = match winner {
            Some(w) if w == home => (1.0, 0.2),
            Some(_) => (0.2, 1.0),
            None => (0.6, 0.6),
        };
        self.rate_xi(&home_xi, home, h_result, &goals, aw0);
        self.rate_xi(&away_xi, away, a_result, &goals, hs0);

        if !knockout {
            self.add_group_result(home, away, hs, aw);
        }
        self.apply_drift(home, away, hs, aw);

        // Serve one match of the existing bans, then book this match's reds for
        // the next one.
        for team in [home, away] {
            for p in self.squad(team)? {
                if let Some(n) = self.suspensions.get_mut(&p.id) {
                    if *n > 0 {
                        *n -= 1;
                    }
                }
            }
        }
        for r in &reds {
            self.suspensions.insert(r.player_id, 1);
        }

        let total_minutes = if extra_time { 120 } else { 90 };
        let momentum = if self.focus == Some(home) || self.focus == Some(away) {
            Some(self.build_momentum(home, h_xg, a_xg, &goals, total_minutes))
        } else {
            None
        };

        let result_label = self.result_label(hs, aw, extra_time, penalties.as_ref());
        let match_id = self.next_id;
        self.next_id += 1;
        let day = self.day;

        let rm = RunMatch {
            id: match_id,
            day,
            stage_key: stage_key.to_string(),
            stage_name: stage_name.to_string(),
            home_team_id: home,
            away_team_id: away,
            home_team_name: self.team_name(home)?,
            away_team_name: self.team_name(away)?,
            home_score: hs,
            away_score: aw,
            extra_time,
            penalties,
            result_label,
            goals,
            reds,
            unavailable,
            momentum,
        };
        self.order.push(match_id);
        self.matches.push(rm);
        Ok(winner)
    }

    fn xg(&self, home: i64, away: i64, knockout: bool) -> ApiResult<(f64, f64)> {
        let h = self.strength(home, knockout)?;
        let a = self.strength(away, knockout)?;
        let home_support = sim::team_context(self.conn, home)?.home_support;
        let h = (h + (home_support as f64 - 50.0) * 0.04).min(99.0);
        let hx = (BASE_GOALS * ((h - a) / 20.0).exp() * HOME_FACTOR).clamp(0.1, 4.5);
        let ax = (BASE_GOALS * ((a - h) / 20.0).exp()).clamp(0.1, 4.5);
        Ok((hx, ax))
    }

    /// Applies ratings to the XI and records goal/assist/clean-sheet events.
    fn rate_xi(
        &mut self,
        xi: &[SquadPlayer],
        team_id: i64,
        result: f64,
        goals: &[Goal],
        conceded: i32,
    ) {
        // Own goals are credited to the scoring team but never to a player, so
        // they are excluded from both the scorer and assister tallies.
        let team_goals: Vec<&Goal> = goals
            .iter()
            .filter(|g| g.team_id == team_id && !g.own_goal)
            .collect();
        for p in xi {
            let perf = self.perf(p, team_id);
            perf.games += 1;
            let mut rating = (6.1 + result).clamp(4.0, 10.0);
            if p.position == "GK" && conceded == 0 {
                perf.clean_sheets += 1;
                rating += 0.8;
            }
            let scored = team_goals.iter().filter(|g| g.scorer_id == p.id).count();
            let assisted = team_goals.iter().filter(|g| g.assist_id == Some(p.id)).count();
            let own = goals
                .iter()
                .filter(|g| g.own_goal && g.scorer_id == p.id)
                .count();
            perf.goals += scored as i32;
            perf.assists += assisted as i32;
            rating += scored as f64 * 1.2 + assisted as f64 * 0.5 - own as f64 * 1.0;
            perf.rating_sum += rating.clamp(4.0, 10.0);
        }
    }

    /// Draws a red card for one team: `Some((minute, player))` when it happens.
    /// Likelihood scales with the XI's average aggression (~1 red per 10
    /// matches at average aggression), and the player is picked weighted by
    /// aggression among the outfielders.
    fn draw_red(&mut self, xi: &[SquadPlayer]) -> Option<(i32, SquadPlayer)> {
        let pool: Vec<SquadPlayer> = xi
            .iter()
            .filter(|p| p.position != "GK")
            .cloned()
            .collect();
        if pool.is_empty() {
            return None;
        }
        let avg = xi.iter().map(|p| p.aggression as f64).sum::<f64>() / xi.len() as f64;
        let prob = (0.045 * (avg / 60.0)).clamp(0.005, 0.18);
        if self.rng.unit() >= prob {
            return None;
        }
        let total: f64 = pool
            .iter()
            .map(|p| (p.aggression as f64).powi(2))
            .sum();
        let mut roll = self.rng.unit() * total;
        let mut chosen = pool[pool.len() - 1].clone();
        for p in &pool {
            roll -= (p.aggression as f64).powi(2);
            if roll <= 0.0 {
                chosen = p.clone();
                break;
            }
        }
        let minute = 1 + (self.rng.unit() * 90.0) as i32;
        Some((minute.min(90), chosen))
    }

    /// A defender (preferably) from the defending side to blame for an own goal.
    fn pick_own_goal(&mut self, opp_xi: &[SquadPlayer]) -> Option<SquadPlayer> {
        let mut pool: Vec<&SquadPlayer> = opp_xi
            .iter()
            .filter(|p| models::position_family(&p.position) == "DF")
            .collect();
        if pool.is_empty() {
            pool = opp_xi.iter().filter(|p| p.position != "GK").collect();
        }
        if pool.is_empty() {
            return None;
        }
        let idx = ((self.rng.unit() * pool.len() as f64) as usize).min(pool.len() - 1);
        Some(pool[idx].clone())
    }

    /// Weighted pick of scorer + optional assister from an XI. A small share of
    /// goals are own goals, credited to `team_id` but finished by a defender of
    /// `opp_xi`. A player sent off before `minute` can no longer score.
    fn make_goal(
        &mut self,
        xi: &[SquadPlayer],
        opp_xi: &[SquadPlayer],
        minute: i32,
        extra_time: bool,
        team_id: i64,
        red: Option<&(i32, SquadPlayer)>,
    ) -> Goal {
        // ~2% of goals are put into the wrong net.
        if self.rng.unit() < 0.02 {
            if let Some(og) = self.pick_own_goal(opp_xi) {
                return Goal {
                    minute,
                    extra_time,
                    team_id,
                    scorer_id: og.id,
                    scorer: og.name.clone(),
                    scorer_photo: og.photo_url.clone(),
                    assist_id: None,
                    assist: None,
                    assist_photo: None,
                    own_goal: true,
                };
            }
        }
        let sent_off = red.filter(|(rm, _)| minute >= *rm).map(|(_, p)| p.id);
        let eff: Vec<SquadPlayer> = xi
            .iter()
            .filter(|p| Some(p.id) != sent_off)
            .cloned()
            .collect();
        let scorer = self.pick_scorer(&eff);
        // Not every goal has an assist (headers, deflections, solo runs, and
        // almost never a striker's own poached finishes). Defensive scorers in
        // particular rack up more unassisted goals.
        let family = models::position_family(&scorer.position);
        let assist_prob = match family.as_ref() {
            "GK" => 0.0,
            "DF" => 0.6,
            "MF" => 0.7,
            _ => 0.72,
        };
        let assist = if self.rng.unit() < assist_prob {
            Some(self.pick_assist(&eff, &scorer))
        } else {
            None
        };
        Goal {
            minute,
            extra_time,
            team_id,
            scorer_id: scorer.id,
            scorer: scorer.name.clone(),
            scorer_photo: scorer.photo_url.clone(),
            assist_id: assist.as_ref().map(|p| p.id),
            assist: assist.as_ref().map(|p| p.name.clone()),
            assist_photo: assist.as_ref().and_then(|p| p.photo_url.clone()),
            own_goal: false,
        }
    }

    fn scorer_weight(&self, p: &SquadPlayer) -> f64 {
        match crate::models::position_family(&p.position) {
            "GK" => 0.02,
            "DF" => 0.35,
            "MF" => {
                if p.position == "CAM" {
                    1.8
                } else if p.position == "CM" {
                    1.2
                } else {
                    0.9
                }
            }
            _ => {
                if p.position == "ST" {
                    2.6
                } else {
                    2.1
                }
            }
        }
    }

    fn pick_scorer(&mut self, xi: &[SquadPlayer]) -> SquadPlayer {
        let total: f64 = xi.iter().map(|p| self.scorer_weight(p) * p.overall.powi(2)).sum();
        let mut roll = self.rng.unit() * total;
        for p in xi {
            roll -= self.scorer_weight(p) * p.overall.powi(2);
            if roll <= 0.0 {
                return p.clone();
            }
        }
        xi[0].clone()
    }

    fn pick_assist(&mut self, xi: &[SquadPlayer], scorer: &SquadPlayer) -> SquadPlayer {
        let pool: Vec<&SquadPlayer> = xi.iter().filter(|p| p.id != scorer.id).collect();
        let total: f64 = pool.iter().map(|p| self.att_weight(p)).sum();
        let mut roll = self.rng.unit() * total;
        for p in &pool {
            roll -= self.att_weight(p);
            if roll <= 0.0 {
                return (*p).clone();
            }
        }
        (*pool[0]).clone()
    }

    fn att_weight(&self, p: &SquadPlayer) -> f64 {
        match crate::models::position_family(&p.position) {
            "GK" => 0.0,
            "DF" => 0.5,
            "MF" => 2.0,
            _ => 1.4,
        }
    }

    fn taker_order<'b>(&self, xi: &'b [SquadPlayer]) -> Vec<&'b SquadPlayer> {
        let mut o: Vec<&'b SquadPlayer> = xi.iter().collect();
        o.sort_by(|a, b| {
            b.overall
                .partial_cmp(&a.overall)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        o
    }

    fn score_prob(&self, taker: &SquadPlayer, gk_overall: f64) -> f64 {
        (0.70 + (taker.overall - 70.0) * 0.004 + (70.0 - gk_overall) * 0.002).clamp(0.4, 0.96)
    }

    fn play_penalties(
        &mut self,
        home: i64,
        home_xi: &[SquadPlayer],
        away: i64,
        away_xi: &[SquadPlayer],
    ) -> PenResult {
        let home_gk_ov = home_xi.iter().find(|p| p.position == "GK").map(|p| p.overall).unwrap_or(60.0);
        let away_gk_ov = away_xi.iter().find(|p| p.position == "GK").map(|p| p.overall).unwrap_or(60.0);
        let home_takers = self.taker_order(home_xi);
        let away_takers = self.taker_order(away_xi);

        let mut kicks = Vec::new();
        let mut hs = 0i32;
        let mut aw = 0i32;
        let mut winner = home;
        let mut sudden_death = false;

        'rounds: for round in 1..=5 {
            let idx = (round - 1) % home_takers.len();
            let ht = home_takers[idx];
            let at = away_takers[idx];
            let h_s = self.rng.unit() < self.score_prob(ht, away_gk_ov);
            let a_s = self.rng.unit() < self.score_prob(at, home_gk_ov);
            if h_s {
                hs += 1;
            }
            if a_s {
                aw += 1;
            }
            kicks.push(PenKick { round: round as i32, team_id: home, taker: ht.name.clone(), scored: h_s });
            kicks.push(PenKick { round: round as i32, team_id: away, taker: at.name.clone(), scored: a_s });

            let remaining = (5 - round) as i32;
            if hs > aw + remaining {
                winner = home;
                break 'rounds;
            }
            if aw > hs + remaining {
                winner = away;
                break 'rounds;
            }
        }

        if hs == aw {
            sudden_death = true;
            let mut round = 6usize;
            loop {
                let idx = (round - 1) % home_takers.len();
                let ht = home_takers[idx];
                let at = away_takers[idx];
                let h_s = self.rng.unit() < self.score_prob(ht, away_gk_ov);
                let a_s = self.rng.unit() < self.score_prob(at, home_gk_ov);
                if h_s {
                    hs += 1;
                }
                if a_s {
                    aw += 1;
                }
                kicks.push(PenKick { round: round as i32, team_id: home, taker: ht.name.clone(), scored: h_s });
                kicks.push(PenKick { round: round as i32, team_id: away, taker: at.name.clone(), scored: a_s });
                if h_s != a_s {
                    winner = if h_s { home } else { away };
                    break;
                }
                round += 1;
                if round > 40 {
                    break;
                }
            }
        }

        PenResult {
            home_score: hs,
            away_score: aw,
            winner_id: winner,
            sudden_death,
            kicks,
        }
    }

    fn result_label(&self, hs: i32, aw: i32, extra: bool, pen: Option<&PenResult>) -> String {
        let mut s = format!("{}–{}", hs, aw);
        if extra {
            s = format!("{} aet", s);
        }
        if let Some(p) = pen {
            s = format!("{} ({}–{} pens)", s, p.home_score, p.away_score);
        }
        s
    }

    /// Per-minute dominance series (0..1) for the home team; away mirrors it.
    ///
    /// Dynamics:
    ///  * a goal resets the flow — the game restarts from neutral;
    ///  * the side chasing a lead then presses, so momentum swings toward the
    ///    trailing team — scaled by how strong that team's attack is relative
    ///    to the leader's, so a weak side can't bottle up a much stronger one;
    ///  * the random walk is deliberately spiky: ordinary jitters plus
    ///    occasional sudden swings, so momentum can change in a blink.
    fn build_momentum(
        &mut self,
        home: i64,
        h_xg: f64,
        a_xg: f64,
        goals: &[Goal],
        total_minutes: usize,
    ) -> Momentum {
        let base = (0.5 + (h_xg - a_xg).clamp(-2.0, 2.0) * 0.06).clamp(0.15, 0.85);
        // Keep some of the strength edge in the settling point once the game
        // settles back to even, but 0.5 is where a goal drops it.
        let neutral = 0.5 + (h_xg - a_xg).clamp(-2.0, 2.0) * 0.03;

        let mut gs = goals.to_vec();
        gs.sort_by_key(|g| g.minute);

        let mut home_series = Vec::with_capacity(total_minutes);
        let mut cur = base;
        let mut score_h = 0i32;
        let mut score_a = 0i32;
        let mut gi = 0usize;
        for m in 1..=total_minutes {
            let mut goal_now = false;
            while gi < gs.len() && gs[gi].minute as usize <= m {
                if gs[gi].team_id == home {
                    score_h += 1;
                } else {
                    score_a += 1;
                }
                goal_now = true;
                gi += 1;
            }
            if goal_now {
                // Restart from neutral right after a goal goes in.
                cur = neutral;
            }

            // Sway toward the trailing side while the score is not level.
            let lead = score_h - score_a;
            let target = if lead == 0 {
                neutral
            } else {
                let trail_xg = if lead > 0 { a_xg } else { h_xg };
                let lead_xg = if lead > 0 { h_xg } else { a_xg };
                let rel = (trail_xg / lead_xg.max(0.05)).clamp(0.35, 2.0);
                let amp = (0.06 + 0.10 * lead.unsigned_abs() as f64 * rel).min(0.42);
                if lead > 0 {
                    (neutral - amp).max(0.05)
                } else {
                    (neutral + amp).min(0.95)
                }
            };

            cur += (target - cur) * 0.05;
            // Normal jitter plus the occasional sharp swing in direction.
            cur += (self.rng.unit() - 0.5) * 0.18;
            if self.rng.unit() < 0.07 {
                cur += (self.rng.unit() - 0.5) * 0.48;
            }
            cur = cur.clamp(0.05, 0.95);
            home_series.push(cur);
        }

        let away_series = home_series.iter().map(|v| 1.0 - v).collect();
        Momentum {
            home: home_series,
            away: away_series,
        }
    }
}
