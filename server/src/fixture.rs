use std::collections::HashMap;

use rusqlite::Connection;

/// Ordered participants per group for a tournament.
pub struct Groups(pub HashMap<String, Vec<i64>>);

/// Generates the group-stage fixture (groups → round-robin matchdays) for a
/// tournament. Knockout rounds are generated on-the-fly during simulation,
/// resolving from real group standings and the real bracket layout:
/// 1A-2B | 1C-2D | 1B-2A | 1D-2C | 1E-2F | 1G-2H | 1F-2E | 1H-2G.
pub fn generate(conn: &Connection, wc_id: i64) -> rusqlite::Result<usize> {
    let groups = load_groups(conn, wc_id)?;
    let mut inserted = 0usize;

    for group in groups.values() {
        // Round-robin with the real tournament schedule pattern:
        //   MD1: 1v2, 3v4 | MD2: 1v3, 4v2 | MD3: 4v1, 2v3
        let indices: &[(usize, usize)] = &[(1, 2), (3, 4), (1, 3), (4, 2), (4, 1), (2, 3)];
        for (k, (i, j)) in indices.iter().enumerate() {
            conn.execute(
                "INSERT INTO matches (worldcup_id, stage, round_num, matchday, home_team_id, away_team_id, status)
                 VALUES (?1, ?2, 0, ?3, ?4, ?5, 'scheduled')",
                rusqlite::params![
                    wc_id,
                    "GROUP",
                    (k as i32) / 2 + 1,
                    group[*i - 1],
                    group[*j - 1],
                ],
            )?;
            inserted += 1;
        }
    }

    Ok(inserted)
}

pub fn load_groups(conn: &Connection, wc_id: i64) -> rusqlite::Result<HashMap<String, Vec<i64>>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, wc.group_letter
         FROM worldcup_teams wc
         JOIN teams t ON t.id = wc.team_id
         WHERE wc.worldcup_id = ?1
         ORDER BY wc.group_letter, t.name",
    )?;
    let rows = stmt.query_map([wc_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut groups: HashMap<String, Vec<i64>> = HashMap::new();
    for row in rows {
        let (tid, group) = row?;
        groups.entry(group).or_default().push(tid);
    }
    Ok(groups)
}

/// Group standings: team_id, points, goals_for, goals_against.
pub struct Standing {
    pub team_id: i64,
    pub points: i32,
    pub gf: i32,
    pub ga: i32,
}

pub fn standings(conn: &Connection, wc_id: i64) -> rusqlite::Result<HashMap<String, Vec<Standing>>> {
    let groups = load_groups(conn, wc_id)?;
    let mut out: HashMap<String, Vec<Standing>> = HashMap::new();

    for (letter, teams) in &groups {
        let mut acc: HashMap<i64, Standing> = teams
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
             WHERE worldcup_id = ?1 AND stage = 'GROUP' AND status = 'played'",
        )?;
        for row in stmt.query_map([wc_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, i32>(3)?,
            ))
        })? {
            let (h, a, hs, as_) = row?;
            if groups[letter].contains(&h) && groups[letter].contains(&a) {
                let entry = acc.get_mut(&h).unwrap();
                entry.gf += hs;
                entry.ga += as_;
                entry.points += if hs > as_ {
                    3
                } else if hs == as_ {
                    1
                } else {
                    0
                };
                let entry = acc.get_mut(&a).unwrap();
                entry.gf += as_;
                entry.ga += hs;
                entry.points += if as_ > hs {
                    3
                } else if as_ == hs {
                    1
                } else {
                    0
                };
            }
        }

        let mut list: Vec<Standing> = acc.into_values().collect();
        // sort: points desc, goal diff desc, goals for desc
        list.sort_by(|x, y| {
            let xd = x.gf - x.ga;
            let yd = y.gf - y.ga;
            y.points
                .cmp(&x.points)
                .then(yd.cmp(&xd))
                .then(y.gf.cmp(&x.gf))
        });
        out.insert(letter.clone(), list);
    }
    Ok(out)
}

/// Standard bracket pairings for the Round of 16, by group label.
/// Index 0..8 → (winner_group, runner_group).
pub const R16_PAIRINGS: &[(&str, &str)] = &[
    ("A", "B"),
    ("C", "D"),
    ("B", "A"),
    ("D", "C"),
    ("E", "F"),
    ("G", "H"),
    ("F", "E"),
    ("H", "G"),
];