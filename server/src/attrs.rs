//! Player attribute model: constants, position weights and the rating
//! functions derived from them. This is pure data/statistics — nothing here
//! produces match results. The client mirrors these functions so lineups and
//! predicted strengths are computed identically on both sides.

// ---------------------------------------------------------------------------
// Attribute model
// ---------------------------------------------------------------------------

/// Attribute indexes — must line up with `models::ATTRIBUTES`.
pub const PACE: usize = 0;
pub const STAMINA: usize = 1;
pub const STRENGTH: usize = 2;
pub const DRIBBLING: usize = 3;
pub const PASSING: usize = 4;
pub const SHOOTING: usize = 5;
pub const TACKLING: usize = 6;
pub const VISION: usize = 7;
pub const POSITIONING: usize = 8;
pub const COMPOSURE: usize = 9;
pub const REFLEXES: usize = 10;
pub const HANDLING: usize = 11;
pub const KICKING: usize = 12;
pub const AERIAL: usize = 13;
pub const DECISIONS: usize = 14;
pub const AGGRESSION: usize = 15;
pub const CONCENTRATION: usize = 16;
pub const LEADERSHIP: usize = 17;

const DEFAULT_ATTR: f64 = 60.0;

/// Attribute weights per granular position (manager-sim style). The weighted
/// average of a player's attributes *is* their overall rating.
fn position_weights(position: &str) -> &'static [(usize, f64)] {
    match position {
        "GK" => &[
            (REFLEXES, 0.22),
            (HANDLING, 0.18),
            (AERIAL, 0.15),
            (POSITIONING, 0.20),
            (COMPOSURE, 0.25),
            (DECISIONS, 0.05),
            (CONCENTRATION, 0.06),
            (LEADERSHIP, 0.04),
        ],
        "CB" => &[
            (TACKLING, 0.30),
            (POSITIONING, 0.20),
            (STRENGTH, 0.20),
            (PACE, 0.10),
            (COMPOSURE, 0.10),
            (PASSING, 0.10),
            (DECISIONS, 0.06),
            (AGGRESSION, 0.05),
            (CONCENTRATION, 0.07),
            (LEADERSHIP, 0.04),
        ],
        "LB" | "RB" => &[
            (STAMINA, 0.20),
            (PACE, 0.20),
            (TACKLING, 0.20),
            (POSITIONING, 0.15),
            (PASSING, 0.15),
            (DRIBBLING, 0.10),
            (DECISIONS, 0.05),
            (AGGRESSION, 0.04),
            (CONCENTRATION, 0.06),
        ],
        "CDM" => &[
            (TACKLING, 0.28),
            (PASSING, 0.20),
            (POSITIONING, 0.20),
            (STAMINA, 0.12),
            (COMPOSURE, 0.12),
            (VISION, 0.08),
            (DECISIONS, 0.06),
            (AGGRESSION, 0.07),
            (CONCENTRATION, 0.06),
            (LEADERSHIP, 0.05),
        ],
        "CM" => &[
            (PASSING, 0.30),
            (VISION, 0.20),
            (STAMINA, 0.15),
            (COMPOSURE, 0.15),
            (DRIBBLING, 0.10),
            (TACKLING, 0.10),
            (DECISIONS, 0.07),
            (CONCENTRATION, 0.05),
            (LEADERSHIP, 0.05),
        ],
        "CAM" => &[
            (PASSING, 0.25),
            (VISION, 0.25),
            (DRIBBLING, 0.20),
            (COMPOSURE, 0.15),
            (STAMINA, 0.15),
            (DECISIONS, 0.07),
            (CONCENTRATION, 0.05),
        ],
        "LM" | "RM" => &[
            (PACE, 0.20),
            (DRIBBLING, 0.20),
            (PASSING, 0.20),
            (STAMINA, 0.15),
            (VISION, 0.15),
            (SHOOTING, 0.10),
            (DECISIONS, 0.05),
            (CONCENTRATION, 0.05),
        ],
        "LW" | "RW" => &[
            (PACE, 0.25),
            (DRIBBLING, 0.25),
            (SHOOTING, 0.20),
            (PASSING, 0.10),
            (COMPOSURE, 0.10),
            (VISION, 0.10),
            (DECISIONS, 0.04),
            (CONCENTRATION, 0.04),
        ],
        "ST" | "CF" => &[
            (SHOOTING, 0.30),
            (PACE, 0.20),
            (DRIBBLING, 0.15),
            (POSITIONING, 0.15),
            (STRENGTH, 0.10),
            (COMPOSURE, 0.10),
            (DECISIONS, 0.07),
            (CONCENTRATION, 0.05),
            (LEADERSHIP, 0.03),
        ],
        _ => &[
            (PASSING, 0.4),
            (VISION, 0.3),
            (COMPOSURE, 0.3),
            (DECISIONS, 0.1),
            (CONCENTRATION, 0.1),
            (LEADERSHIP, 0.1),
        ],
    }
}

/// Keeper-relevant fields used for a keeper's official overall — the plain
/// mean, identical to the `star_rating` GK branch. A keeper's `overall` must
/// mean the same as the icon pins the ingester scales against; the old
/// weighted composite measured ~4.5 higher on the same attrs, so world-class
/// keepers (real 91) read 95.7 and out-starred every outfield great.
fn gk_plain_mean(attrs: &[Option<i32>]) -> f64 {
    gk_plain_mean_raw(attrs) - GK_DAMP
}

fn gk_plain_mean_raw(attrs: &[Option<i32>]) -> f64 {
    let idx = [REFLEXES, HANDLING, KICKING, POSITIONING, COMPOSURE, AERIAL,
        STRENGTH, PACE, DECISIONS, CONCENTRATION, LEADERSHIP];
    let n = idx.len() as f64;
    idx.iter().map(|&i| attrs.get(i).copied().flatten().unwrap_or(60) as f64).sum::<f64>() / n
}

/// Keeper ratings are damped below outfielders: even a world-class keeper
/// (pinned ~91 shot-stopping) should read ~88 — elite, but never the best
/// player in a tournament. Without this, top-50 lists fill with GKs (14.6%
/// of slots vs ~4.5% of a squad's players). Mirrored in the client sim and
/// the ingester's scale solver.
pub const GK_DAMP: f64 = 3.0;

/// Position-weighted composite (0–100). Missing attributes default to 60.
pub fn composite_rating(position: &str, attrs: &[Option<i32>]) -> f64 {
    if position == "GK" {
        return gk_plain_mean(attrs);
    }
    let mut num = 0.0;
    let mut den = 0.0;
    for (idx, w) in position_weights(position) {
        let v = attrs.get(*idx).copied().flatten().unwrap_or(60) as f64;
        num += v * w;
        den += w;
    }
    if den == 0.0 {
        DEFAULT_ATTR
    } else {
        num / den
    }
}

/// Market-style star rating (0–100). Identical in scale to `overall` — for
/// outfielders the position-weighted composite, for keepers a plain mean of
/// their shot-stopping fields. A five-star player genuinely means ~90+ quality;
/// the previous 1.5× stretch sent every 80+ player to 90+, so entire rosters
/// of strong teams showed five stars.
pub fn star_rating(position: &str, attrs: &[Option<i32>]) -> f64 {
    let avg = if position == "GK" {
        gk_plain_mean(attrs)
    } else {
        composite_rating(position, attrs)
    };
    (avg + 0.5).floor().clamp(55.0, 98.0)
}