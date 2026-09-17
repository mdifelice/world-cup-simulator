"""Offline, network-free derivations shared by the SoFaScore ingest.

Everything here is pure and unit-testable. The key invariants:

* ``attrs_from_overall`` returns 18 attributes whose *position-weighted*
  composite equals the requested overall (the same metric ``sim.rs`` uses), so
  a keeper and a striker both rated 80 genuinely play like an 80.
* Position emphasis is deliberately gentle (max ~±10) with a weighted-mean
  correction afterwards. This is what fixes the old imbalance where keepers and
  defenders read far below attackers.
* ``overall_from_rating`` maps a SoFaScore season rating (≈6.0–9.0) onto the
  0–100 scale; ``fallback_overall`` uses the team's finish-tier band when a
  player has no rating, biased within the band by how often they started.
"""

from __future__ import annotations

import zlib

# Attribute order — must match models::ATTRIBUTES / sim.rs indexes.
PACE, STAMINA, STRENGTH, DRIBBLING, PASSING, SHOOTING = 0, 1, 2, 3, 4, 5
TACKLING, VISION, POSITIONING, COMPOSURE = 6, 7, 8, 9
REFLEXES, HANDLING, KICKING, AERIAL = 10, 11, 12, 13
DECISIONS, AGGRESSION, CONCENTRATION, LEADERSHIP = 14, 15, 16, 17

ATTRIBUTES = [
    "pace", "stamina", "strength", "dribbling", "passing", "shooting",
    "tackling", "vision", "positioning", "composure", "reflexes", "handling",
    "kicking", "aerial", "decisions", "aggression", "concentration", "leadership",
]

# Position -> weight profile. Verbatim port of sim.rs::position_weights.
POSITION_WEIGHTS: dict[str, list[tuple[int, float]]] = {
    "GK": [(REFLEXES, 0.22), (HANDLING, 0.18), (AERIAL, 0.15), (POSITIONING, 0.20),
           (COMPOSURE, 0.25), (DECISIONS, 0.05), (CONCENTRATION, 0.06), (LEADERSHIP, 0.04)],
    "CB": [(TACKLING, 0.30), (POSITIONING, 0.20), (STRENGTH, 0.20), (PACE, 0.10),
           (COMPOSURE, 0.10), (PASSING, 0.10), (DECISIONS, 0.06), (AGGRESSION, 0.05),
           (CONCENTRATION, 0.07), (LEADERSHIP, 0.04)],
    "LB": [(STAMINA, 0.20), (PACE, 0.20), (TACKLING, 0.20), (POSITIONING, 0.15),
           (PASSING, 0.15), (DRIBBLING, 0.10), (DECISIONS, 0.05), (AGGRESSION, 0.04),
           (CONCENTRATION, 0.06)],
    "RB": [(STAMINA, 0.20), (PACE, 0.20), (TACKLING, 0.20), (POSITIONING, 0.15),
           (PASSING, 0.15), (DRIBBLING, 0.10), (DECISIONS, 0.05), (AGGRESSION, 0.04),
           (CONCENTRATION, 0.06)],
    "LWB": [(PACE, 0.25), (STAMINA, 0.20), (PASSING, 0.15), (DRIBBLING, 0.15),
            (TACKLING, 0.15), (POSITIONING, 0.10), (DECISIONS, 0.05), (AGGRESSION, 0.04),
            (CONCENTRATION, 0.05)],
    "RWB": [(PACE, 0.25), (STAMINA, 0.20), (PASSING, 0.15), (DRIBBLING, 0.15),
            (TACKLING, 0.15), (POSITIONING, 0.10), (DECISIONS, 0.05), (AGGRESSION, 0.04),
            (CONCENTRATION, 0.05)],
    "CDM": [(TACKLING, 0.28), (PASSING, 0.20), (POSITIONING, 0.20), (STAMINA, 0.12),
            (COMPOSURE, 0.12), (VISION, 0.08), (DECISIONS, 0.06), (AGGRESSION, 0.07),
            (CONCENTRATION, 0.06), (LEADERSHIP, 0.05)],
    "CM": [(PASSING, 0.30), (VISION, 0.20), (STAMINA, 0.15), (COMPOSURE, 0.15),
           (DRIBBLING, 0.10), (TACKLING, 0.10), (DECISIONS, 0.07), (CONCENTRATION, 0.05),
           (LEADERSHIP, 0.05)],
    "CAM": [(PASSING, 0.25), (VISION, 0.25), (DRIBBLING, 0.20), (COMPOSURE, 0.15),
            (STAMINA, 0.15), (DECISIONS, 0.07), (CONCENTRATION, 0.05)],
    "LM": [(PACE, 0.20), (DRIBBLING, 0.20), (PASSING, 0.20), (STAMINA, 0.15),
           (VISION, 0.15), (SHOOTING, 0.10), (DECISIONS, 0.05), (CONCENTRATION, 0.05)],
    "RM": [(PACE, 0.20), (DRIBBLING, 0.20), (PASSING, 0.20), (STAMINA, 0.15),
           (VISION, 0.15), (SHOOTING, 0.10), (DECISIONS, 0.05), (CONCENTRATION, 0.05)],
    "LW": [(PACE, 0.25), (DRIBBLING, 0.25), (SHOOTING, 0.20), (PASSING, 0.10),
           (COMPOSURE, 0.10), (VISION, 0.10), (DECISIONS, 0.04), (CONCENTRATION, 0.04)],
    "RW": [(PACE, 0.25), (DRIBBLING, 0.25), (SHOOTING, 0.20), (PASSING, 0.10),
           (COMPOSURE, 0.10), (VISION, 0.10), (DECISIONS, 0.04), (CONCENTRATION, 0.04)],
    "ST": [(SHOOTING, 0.30), (PACE, 0.20), (DRIBBLING, 0.15), (POSITIONING, 0.15),
           (STRENGTH, 0.10), (COMPOSURE, 0.10), (DECISIONS, 0.07), (CONCENTRATION, 0.05),
           (LEADERSHIP, 0.03)],
    "CF": [(SHOOTING, 0.30), (PACE, 0.20), (DRIBBLING, 0.15), (POSITIONING, 0.15),
           (STRENGTH, 0.10), (COMPOSURE, 0.10), (DECISIONS, 0.07), (CONCENTRATION, 0.05),
           (LEADERSHIP, 0.03)],
    "_": [(PASSING, 0.4), (VISION, 0.3), (COMPOSURE, 0.3), (DECISIONS, 0.1),
          (CONCENTRATION, 0.1), (LEADERSHIP, 0.1)],
}

# SofaScore uses single letters G/D/M/F; our sim uses granular codes.
SOFA_POSITION: dict[str, str] = {
    "G": "GK", "D": "CB", "M": "CM", "F": "ST",
}
# Expanded granular positions, ordered best-fit first, for lineup "position" tags.
SOFA_SUB_POSITION: dict[str, str] = {
    "GK": "GK",
    "CB": "CB", "LB": "LB", "RB": "RB", "LCB": "CB", "RCB": "CB",
    "CDM": "CDM", "CM": "CM", "CAM": "CAM", "LM": "LM", "RM": "RM",
    "LCM": "CM", "RCM": "CM", "LDM": "CDM", "RDM": "CDM", "LAM": "CAM", "RAM": "CAM",
    "LW": "LW", "RW": "RW", "ST": "ST", "CF": "CF",
}

FAMILY: dict[str, str] = {
    "GK": "GK", "CB": "DF", "LB": "DF", "RB": "DF", "LWB": "DF", "RWB": "DF",
    "CDM": "MF", "CM": "MF", "CAM": "MF", "LM": "MF", "RM": "MF",
    "LW": "FW", "RW": "FW", "ST": "FW", "CF": "FW", "SS": "FW",
}

# Gentle per-position emphasis for the 18 attributes, in ATTRIBUTES order.
# Max magnitude ~±10 so no position reads as broken; corrected afterwards.
TEMPLATES: dict[str, list[int]] = {
    "GK": [-8, -4, 2, -10, -4, -12, -10, -6, 5, 5, 8, 8, 6, 6, 1, -6, 3, 2],
    "CB": [-4, 2, 7, -8, -2, -10, 8, -4, 7, 3, -8, -8, -8, 6, 3, 4, 4, 2],
    "LB": [8, 8, -2, 2, 3, -8, 5, 1, 4, -1, -8, -8, -8, -3, 1, 1, 3, 0],
    "RB": [8, 8, -2, 2, 3, -8, 5, 1, 4, -1, -8, -8, -8, -3, 1, 1, 3, 0],
    "LWB": [9, 8, -2, 4, 4, -6, 3, 1, 2, 0, -8, -8, -8, -3, 1, 0, 2, 0],
    "RWB": [9, 8, -2, 4, 4, -6, 3, 1, 2, 0, -8, -8, -8, -3, 1, 0, 2, 0],
    "CDM": [-3, 5, 3, -2, 5, -8, 8, 3, 6, 4, -8, -8, -6, 1, 1, 4, 4, 2],
    "CM": [0, 6, -1, 4, 8, -2, 1, 7, 0, 5, -8, -8, -6, -3, 3, -2, 3, 2],
    "CAM": [2, 3, -3, 7, 8, 3, -6, 8, 0, 5, -8, -8, -6, -5, 3, -3, 2, 0],
    "LM": [8, 6, -2, 7, 6, 2, -3, 5, -1, 1, -8, -8, -6, -4, 2, 0, 2, 0],
    "RM": [8, 6, -2, 7, 6, 2, -3, 5, -1, 1, -8, -8, -6, -4, 2, 0, 2, 0],
    "LW": [9, 2, -3, 9, 4, 6, -8, 5, 2, 3, -8, -8, -6, -6, 1, -2, 1, 0],
    "RW": [9, 2, -3, 9, 4, 6, -8, 5, 2, 3, -8, -8, -6, -6, 1, -2, 1, 0],
    "ST": [6, 1, 4, 5, -3, 9, -8, 1, 8, 5, -8, -8, -6, 3, 2, 0, 2, 1],
    "CF": [6, 1, 2, 6, 2, 8, -8, 4, 6, 5, -8, -8, -6, 2, 2, -1, 2, 1],
    "_": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
}

# Finish tier -> (overall low, overall high) for players with no season rating.
FINISH_BANDS: dict[str, tuple[float, float]] = {
    "CHAMPION": (78.0, 88.0),
    "FINAL": (74.0, 84.0),
    "SEMI": (72.0, 82.0),
    "QUARTER": (69.0, 79.0),
    "R16": (66.0, 76.0),
    "R32": (63.0, 73.0),
    "GROUP": (60.0, 70.0),
}

# Seed rank (FIFA ranking) adjustment applied on top of the finish tier.
SEED_ADJUST: list[tuple[int, int]] = [(3, 4), (8, 2), (16, 0), (32, -1), (48, -2), (10**9, -4)]


def _clamp(v: float, lo: int = 30, hi: int = 99) -> int:
    return int(max(lo, min(hi, round(v))))


def weights_for(position: str) -> list[tuple[int, float]]:
    return POSITION_WEIGHTS.get(position, POSITION_WEIGHTS["_"])


def composite(position: str, attrs: list[int]) -> float:
    """Position-weighted mean of the 18 attributes (mirrors sim.rs)."""
    num = den = 0.0
    for idx, w in weights_for(position):
        num += attrs[idx] * w
        den += w
    return num / den if den else 60.0


def family_of(position: str) -> str:
    return FAMILY.get(position, "MF")


def overall_from_rating(rating: float) -> int:
    """SoFaScore season rating (≈6.0 average, ≈8.0 star) -> 0–100 overall."""
    return _clamp(50.0 + (rating - 6.0) * 20.0, 45, 97)


def fallback_overall(finish: str, name: str, year: int, starter_frac: float = 0.5) -> int:
    """Rating-less player: finish-tier band, biased by starts, jittered stably."""
    lo, hi = FINISH_BANDS.get(finish, FINISH_BANDS["GROUP"])
    frac = max(0.0, min(1.0, starter_frac))
    base = lo + (hi - lo) * (0.35 + 0.65 * frac)
    jitter = (zlib.crc32(f"{name}|{year}".encode()) % 1001) / 1000.0 * 4.0 - 2.0
    return _clamp(base + jitter, 45, 97)


def attrs_from_overall(overall: int, position: str) -> list[int]:
    """18 attributes whose position-weighted composite == ``overall``."""
    target = float(_clamp(overall, 30, 99))
    tpl = TEMPLATES.get(position, TEMPLATES["_"])
    raw = [_clamp(target + d) for d in tpl]
    # Shift so the profile-weighted mean lands exactly on the target, then a
    # second pass to absorb rounding/clamping drift.
    for _ in range(2):
        shift = target - composite(position, raw)
        raw = [_clamp(raw[i] + shift) for i in range(18)]
    return raw


def team_tier_rating(finish: str, seed_rank: int | None) -> int:
    """Team rating from finish tier plus (optional) seeding rank."""
    lo, hi = FINISH_BANDS.get(finish, FINISH_BANDS["GROUP"])
    base = (lo + hi) / 2.0
    if seed_rank is not None and seed_rank > 0:
        for cutoff, adj in SEED_ADJUST:
            if seed_rank <= cutoff:
                base += adj
                break
    return _clamp(base, 58, 92)


def _regional(alpha2: str) -> str:
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in alpha2.upper())


# Flags SoFaScore can't express as a country pair (defunct or constituent
# nations). Keyed by the alpha2/alpha3 SoFaScore emits.
SPECIAL_FLAGS: dict[str, str] = {
    "ENG": "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F",
    "GB-ENG": "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F",
    "EN": "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F",
    "SCO": "\U0001F3F4\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F",
    "WAL": "\U0001F3F4\U000E0067\U000E0062\U000E0077\U000E006C\U000E0073\U000E007F",
    "NIR": "\U0001F1EC\U0001F1E7",
    "URS": "\U0001F1F7\U0001F1FA",
    "SU": "\U0001F1F7\U0001F1FA",
    "TCH": "\U0001F1E8\U0001F1FF",
    "CS": "\U0001F1E8\U0001F1FF",
    "YUG": "\U0001F1F7\U0001F1F8",
    "YU": "\U0001F1F7\U0001F1F8",
    "FRG": "\U0001F1E9\U0001F1EA",
    "GDR": "\U0001F1E9\U0001F1EA",
    "DDR": "\U0001F1E9\U0001F1EA",
    "SCG": "\U0001F1F7\U0001F1F8",
    "ZAI": "\U0001F1E8\U0001F1E9",
}

# Name -> flag for teams whose SoFaScore country is missing/ambiguous.
NAME_FLAGS: dict[str, str] = {
    "England": SPECIAL_FLAGS["ENG"],
    "Scotland": SPECIAL_FLAGS["SCO"],
    "Wales": SPECIAL_FLAGS["WAL"],
    "Northern Ireland": "\U0001F1EC\U0001F1E7",
    "Soviet Union": SPECIAL_FLAGS["URS"],
    "Czechoslovakia": SPECIAL_FLAGS["TCH"],
    "Yugoslavia": SPECIAL_FLAGS["YUG"],
    "West Germany": SPECIAL_FLAGS["FRG"],
    "East Germany": SPECIAL_FLAGS["GDR"],
    "Serbia and Montenegro": SPECIAL_FLAGS["SCG"],
    "Zaire": SPECIAL_FLAGS["ZAI"],
    "Curaçao": "\U0001F1E8\U0001F1FC",
}


def flag_emoji(alpha2: str | None, alpha3: str | None = None, name: str | None = None) -> str:
    """Best-effort flag emoji, preferring a name override then alpha codes."""
    if name and name in NAME_FLAGS:
        return NAME_FLAGS[name]
    for code in (alpha2, alpha3):
        if not code:
            continue
        if code.upper() in SPECIAL_FLAGS:
            return SPECIAL_FLAGS[code.upper()]
        c = code.upper().replace("-", "")
        if len(c) == 2 and c.isalpha():
            return _regional(c)
    return "\U0001F3F3"  # white flag fallback
