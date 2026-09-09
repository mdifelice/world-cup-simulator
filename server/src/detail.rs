//! Detailed, replayable tournament run engine.
//!
//! Unlike `sim::simulate_tournament` (which writes match rows and only keeps
//! scores), this engine plays every match in memory with full detail — goal
//! minutes, scorers/assists, extra time and penalties, a minute-by-minute
//! momentum series for the user's team, and per-player stats feeding the
//! awards. Nothing is written to the database; the resulting `RunPayload` is
//! returned to the client and optionally saved as JSON for logged-in users.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::{
    error::{ApiError, ApiResult},
    fixture,
    models::{
        Awards, Goal, GroupInfo, Momentum, PenKick, PenResult, PlayerAward, RunMatch,
        RunPayload, RunTeam, TopScorer,
    },
    names::{self, SquadPlayer},
    sim,
};

pub struct RunRequest {
    pub focus_team_id: Option<i64>,
    pub focus_boost: i32,
}

const BASE_GOALS: f64 = 1.32;
const HOME_FACTOR: f64 = 1.10;

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

    let mut eng = Engine {
        conn,
        tournament_id,
        shirt_numbers,
        focus: req.focus_team_id,
        rng: sim::Rng::new(),
        matches: Vec::new(),
        order: Vec::new(),
        groups: Vec::new(),
        perfs: HashMap::new(),
        team_names: HashMap::new(),
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
    rng: sim::Rng,
    matches: Vec<RunMatch>,
    order: Vec<i64>,
    groups: Vec<GroupInfo>,
    perfs: HashMap<i64, Perf>,
    team_names: HashMap<i64, String>,
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

        // One "day" per round across all groups (a real matchday).
        let mut schedule: Vec<Vec<Vec<(i64, i64)>>> = Vec::new();
        for teams in &self.current_groups {
            let mut by_round: Vec<Vec<(i64, i64)>> = Vec::new();
            for (h, a, round) in fixture::round_robin(teams) {
                let r = round.max(1) as usize;
                while by_round.len() < r {
                    by_round.push(Vec::new());
                }
                by_round[r - 1].push((h, a));
            }
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

    fn squad(&mut self, team_id: i64) -> ApiResult<Vec<SquadPlayer>> {
        if let Some(s) = self.squads.get(&team_id) {
            return Ok(s.clone());
        }
        let s = names::squad_for_team(self.conn, self.tournament_id, team_id, self.shirt_numbers)?;
        self.squads.insert(team_id, s.clone());
        Ok(s)
    }

    /// Best XI (4-4-2) by overall within each position family.
    fn pick_xi(&mut self, team_id: i64) -> ApiResult<Vec<SquadPlayer>> {
        let squad = self.squad(team_id)?;
        let mut chosen = Vec::new();
        for (family, count) in [("GK", 1), ("DF", 4), ("MF", 4), ("FW", 2)] {
            let mut pool: Vec<SquadPlayer> = squad
                .iter()
                .filter(|p| crate::models::position_family(&p.position) == family)
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
            chosen = squad.into_iter().take(11).collect();
        }
        Ok(chosen)
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
        let (h_xg, a_xg) = self.xg(home, away, knockout)?;
        let home_xi = self.pick_xi(home)?;
        let away_xi = self.pick_xi(away)?;

        let (hs0, aw0) = (
            sim::poisson(&mut self.rng, h_xg),
            sim::poisson(&mut self.rng, a_xg),
        );

        let mut goals = Vec::new();
        for _ in 0..hs0 {
            let minute = 1 + (self.rng.unit() * 90.0) as i32;
            goals.push(self.make_goal(&home_xi, minute, false, home));
        }
        for _ in 0..aw0 {
            let minute = 1 + (self.rng.unit() * 90.0) as i32;
            goals.push(self.make_goal(&away_xi, minute, false, away));
        }
        goals.sort_by_key(|g| (g.minute, g.team_id));

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
            for _ in 0..eh {
                let minute = 91 + (self.rng.unit() * 30.0) as i32;
                goals.push(self.make_goal(&home_xi, minute, true, home));
            }
            for _ in 0..ea {
                let minute = 91 + (self.rng.unit() * 30.0) as i32;
                goals.push(self.make_goal(&away_xi, minute, true, away));
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
        let hx = (BASE_GOALS * ((h - a) / 10.0).exp() * HOME_FACTOR).clamp(0.1, 4.5);
        let ax = (BASE_GOALS * ((a - h) / 10.0).exp()).clamp(0.1, 4.5);
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
        let team_goals: Vec<&Goal> = goals.iter().filter(|g| g.team_id == team_id).collect();
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
            perf.goals += scored as i32;
            perf.assists += assisted as i32;
            rating += scored as f64 * 1.2 + assisted as f64 * 0.5;
            perf.rating_sum += rating.clamp(4.0, 10.0);
        }
    }

    /// Weighted pick of scorer + optional assister from an XI.
    fn make_goal(
        &mut self,
        xi: &[SquadPlayer],
        minute: i32,
        extra_time: bool,
        team_id: i64,
    ) -> Goal {
        let scorer = self.pick_scorer(xi);
        let assist = if self.rng.unit() < 0.72 {
            Some(self.pick_assist(xi, &scorer))
        } else {
            None
        };
        Goal {
            minute,
            extra_time,
            team_id,
            scorer_id: scorer.id,
            scorer: scorer.name.clone(),
            assist_id: assist.as_ref().map(|p| p.id),
            assist: assist.map(|p| p.name),
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
    fn build_momentum(
        &mut self,
        home: i64,
        h_xg: f64,
        a_xg: f64,
        goals: &[Goal],
        total_minutes: usize,
    ) -> Momentum {
        let base = (0.5 + (h_xg - a_xg).clamp(-2.0, 2.0) * 0.06).clamp(0.15, 0.85);
        let mut cur = base;
        let mut home_series = Vec::with_capacity(total_minutes);
        for m in 1..=total_minutes {
            let b = if m > 90 { 0.5 + (h_xg - a_xg) * 0.03 } else { base };
            cur = (cur + (b - cur) * 0.06 + (self.rng.unit() - 0.5) * 0.14).clamp(0.02, 0.98);
            for g in goals {
                let minute = g.minute as usize;
                if g.team_id == home && m >= minute && m - minute < 7 {
                    cur = (cur + 0.045).min(0.98);
                }
                if g.team_id != home && m >= minute && m - minute < 7 {
                    cur = (cur - 0.045).max(0.02);
                }
            }
            home_series.push(cur);
        }
        let away_series = home_series.iter().map(|v| 1.0 - v).collect();
        Momentum {
            home: home_series,
            away: away_series,
        }
    }
}
