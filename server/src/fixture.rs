use rusqlite::Connection;

/// Ordered participants per group for a tournament.
pub type Groups = Vec<(String, Vec<i64>)>;

/// Loads group assignments (only relevant when the tournament has a group phase).
pub fn load_groups(conn: &Connection, tournament_id: i64) -> rusqlite::Result<Groups> {
    let mut stmt = conn.prepare(
        "SELECT g.group_name, t.id
         FROM tournament_groups g
         JOIN teams t ON t.id = g.team_id
         WHERE g.tournament_id = ?1
         ORDER BY g.group_name, t.name",
    )?;
    let rows = stmt.query_map([tournament_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    let mut groups: Vec<(String, Vec<i64>)> = Vec::new();
    for row in rows {
        let (name, tid) = row?;
        match groups.iter_mut().find(|(n, _)| *n == name) {
            Some((_, list)) => list.push(tid),
            None => groups.push((name, vec![tid])),
        }
    }
    Ok(groups)
}

/// Round-robin schedule: every pair plays once, split into `n-1` matchdays.
/// Uses the standard circle method; returns (home, away, round).
pub fn round_robin(teams: &[i64]) -> Vec<(i64, i64, usize)> {
    let n = teams.len();
    let mut out = Vec::new();
    if n < 2 {
        return out;
    }
    let mut list: Vec<usize> = (1..n).collect();
    let rounds = if n % 2 == 0 { n - 1 } else { n };
    let mut idx = 0usize;
    while idx < rounds {
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        pairs.push((0, list[0]));
        let mut k = 1;
        while k + 1 < list.len() {
            pairs.push((list[k], list[k + 1]));
            k += 2;
        }
        for (i, j) in pairs {
            // alternate home/away across rounds for balance
            let (h, a) = if idx % 2 == 0 { (i, j) } else { (j, i) };
            out.push((teams[h], teams[a], idx + 1));
        }
        list.rotate_right(1);
        idx += 1;
    }
    out
}

/// Generates the first group-phase fixture for a tournament (round-robin).
/// Later phases (knockouts, league decider) are drawn on the fly in `sim`.
pub fn generate(conn: &Connection, tournament_id: i64) -> rusqlite::Result<usize> {
    let groups = load_groups(conn, tournament_id)?;
    let mut inserted = 0usize;
    for (_name, teams) in &groups {
        for (home, away, round) in round_robin(teams) {
            let existing: i64 = conn.query_row(
                "SELECT COUNT(*) FROM matches
                 WHERE tournament_id = ?1 AND stage = 'GROUP' AND home_team_id = ?2 AND away_team_id = ?3",
                rusqlite::params![tournament_id, home, away],
                |r| r.get(0),
            )?;
            if existing > 0 {
                continue;
            }
            conn.execute(
                "INSERT INTO matches (tournament_id, stage, round_num, matchday, home_team_id, away_team_id, status)
                 VALUES (?1, 'GROUP', 0, ?2, ?3, ?4, 'scheduled')",
                rusqlite::params![tournament_id, round as i32, home, away],
            )?;
            inserted += 1;
        }
    }
    Ok(inserted)
}

/// Group standings: team_id, points, goals_for, goals_against.
#[derive(Debug, Clone)]
pub struct Standing {
    pub team_id: i64,
    pub points: i32,
    pub gf: i32,
    pub ga: i32,
}

impl Standing {
    pub fn gd(&self) -> i32 {
        self.gf - self.ga
    }
}

/// Table for an arbitrary set of teams, computed from played matches of a stage.
pub fn table_for(
    conn: &Connection,
    tournament_id: i64,
    stage: &str,
    teams: &[i64],
) -> rusqlite::Result<Vec<Standing>> {
    let mut acc: std::collections::HashMap<i64, Standing> = teams
        .iter()
        .map(|t| {
            (
                *t,
                Standing {
                    team_id: *t,
                    points: 0,
                    gf: 0,
                    ga: 0,
                },
            )
        })
        .collect();

    let mut stmt = conn.prepare(
        "SELECT home_team_id, away_team_id, home_score, away_score
         FROM matches
         WHERE tournament_id = ?1 AND stage = ?2 AND status = 'played'",
    )?;
    for row in stmt.query_map(rusqlite::params![tournament_id, stage], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i32>(2)?,
            r.get::<_, i32>(3)?,
        ))
    })? {
        let (h, a, hs, as_) = row?;
        let mut update = |team: i64, gf: i32, ga: i32, pts: i32| {
            if let Some(e) = acc.get_mut(&team) {
                e.gf += gf;
                e.ga += ga;
                e.points += pts;
            }
        };
        update(h, hs, as_, if hs > as_ { 3 } else if hs == as_ { 1 } else { 0 });
        update(a, as_, hs, if as_ > hs { 3 } else if as_ == hs { 1 } else { 0 });
    }

    let mut list: Vec<Standing> = acc.into_values().collect();
    list.sort_by(|x, y| {
        y.points
            .cmp(&x.points)
            .then(y.gd().cmp(&x.gd()))
            .then(y.gf.cmp(&x.gf))
    });
    Ok(list)
}