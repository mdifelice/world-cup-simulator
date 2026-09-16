#!/usr/bin/env python3
"""Merge the Kaggle "FIFA World Cup 2026 Player Performance" dataset into the seed.

Reads the {server data dir}/seed/2026.json produced by scrape_wc2026.py and a
player-performance CSV from kaggle.com/datasets/rauffauzanrambe/fifa-world-cup-2026-player
-performance-dataset, and rewrites the seed with per-player "attrs" (18 ints in the exact
order the Rust server expects: pace, stamina, strength, dribbling, passing, shooting,
tackling, vision, positioning, composure, reflexes, handling, kicking, aerial, decisions,
aggression, concentration, leadership).

Players without performance data, or with zero minutes, are left untouched so the server
falls back to its deterministic nation-rating derivation — no squad member disappears.

Run order:

    python3 server/scripts/scrape_wc2026.py            # regenerates squads + photos
    python3 server/scripts/ingest_fc_ratings.py ...    # <-- PREFERRED primary attrs (EA FC)
    <place CSV at server/data/wc2026/player_stats.csv>
    python3 server/scripts/ingest_wc2026_stats.py      # optional: tournament line if you
                                                       # would rather overlay match stats

The CSV is matched by player NAME (diacritics/whitespace-insensitive) plus TEAM when the
dataset provides a team column. Column names tolerate the common SofaScore/FotMob spellings.

Attribute mapping (deterministic, tunable below):
  base = 40 + (avg_rating - 6.0) * 20   (clamped 30..99) — the player's performance rating.
  Each of the 18 attributes = base + position-family bonus + per-90-minute stat deltas.
  Athletic traits we cannot measure from match logs (pace, strength) are a function of the
  rating + position so squads differentiate without inventing `199 | 199` outliers.
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys
import unicodedata

DEFAULT_CSV = "data/wc2026/player_stats.csv"
DEFAULT_SEED = "data/seed/2026.json"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

# Canonical Rust attribute order (server/src/db.rs INSERT + server/src/sim.rs PACE..LEADERSHIP).
ATTR_ORDER = [
    "pace", "stamina", "strength", "dribbling", "passing", "shooting", "tackling", "vision",
    "positioning", "composure", "reflexes", "handling", "kicking", "aerial", "decisions",
    "aggression", "concentration", "leadership",
]

# Synonymous column names, best-first; the first header hit wins.
COLUMNS = {
    "name": ("player_name", "name", "player", "player_id"),
    "team": ("team_name", "team", "squad", "nationality"),
    "team_id": ("team_id", "teamid", "tid"),
    "minutes": ("minutes_played", "minutes", "min", "mins", "played_minutes"),
    "goals": ("goals", "total_goals", "gs", "goals_scored"),
    "assists": ("assists", "ast", "total_assists", "assists_total"),
    "shots": ("shots", "shots_total", "sn", "total_shots"),
    "ontarget": ("shots_on_target", "on_target", "sot", "shots_on_target_total"),
    "saves": ("saves", "total_saves", "sv"),
    "conceded": ("goals_conceded", "gc", "conceded", "conceded_goals"),
    "cleansheets": ("clean_sheets", "cs", "cleansheets", "clean_sheet"),
    "rating": ("average_rating", "rating", "player_rating", "avg_rating", "overall_rating"),
    "yellow": ("yellow_cards", "yc", "yellows"),
    "red": ("red_cards", "rc", "reds"),
}

# seed position → trait family used by the mapping table below
FAMILY = {
    "GK": "GK",
    "CB": "DF", "LB": "DF", "RB": "DF",
    "CM": "MF", "CDM": "MF", "CAM": "MF",
    "LW": "WG", "RW": "WG",
    "ST": "ST",
}


def clamp(x: float, lo: float = 30.0, hi: float = 99.0) -> int:
    return min(int(hi), max(int(lo), int(round(x))))


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = s.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]", "", s.lower())


def pick(headers: list[str]) -> dict:
    """Map canonical field → actual header (best synonym match), skipping empties."""
    low = {h.strip().lower(): h for h in headers if h and h.strip()}
    chosen = {}
    for field, syns in COLUMNS.items():
        for syn in syns:
            if syn in low:
                chosen[field] = low[syn]
                break
    return chosen


def parse_stat(value: str | None, default: float = 0.0) -> float:
    if value is None:
        return default
    v = value.strip()
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        m = re.search(r"-?\d+(?:\.\d+)?", v)
        return float(m.group(0)) if m else default


def attrs_for_stats(row: dict, family: str, team_rating: int) -> list[int]:
    """Base rating + position bonus + per-90 stat deltas → the 18 attrs in ATTR_ORDER.

    ``team_rating`` anchors the no-rating fallback so matched squads keep the
    national strength stratification the old derivation produced (a 93-rated
    team's no-rating members stay strong, a 60-rated team's stay weak).
    """
    minutes = parse_stat(row.get("minutes"))
    games = max(1.0, minutes / 90.0)
    g = parse_stat(row.get("goals"))
    a = parse_stat(row.get("assists"))
    s = parse_stat(row.get("shots"))
    so = parse_stat(row.get("ontarget"))
    sv = parse_stat(row.get("saves"))
    gc = parse_stat(row.get("conceded"))
    csr = parse_stat(row.get("cleansheets")) / games if games else 0.0
    yc = parse_stat(row.get("yellow"))
    rc = parse_stat(row.get("red"))
    rating = parse_stat(row.get("rating"), default=None)

    g90, a90, s90, so90, sv90, gc90 = (g / games, a / games, s / games, so / games, sv / games, gc / games)

    anchor = team_rating * 0.85
    if rating is not None:
        # 0-10 Scale/Sofascore mark -> 0-100 base (6.0 => 40, 8.0 => 80).
        base = 40.0 + (rating - 6.0) * 20.0
    elif family == "GK":
        # No rating: reward being picked, watching shots, clean sheets, few conceded.
        base = anchor + 8.0 + games * 0.6 + csr * 4.0 + sv90 * 0.3 + 3.0 / max(0.1, gc90)
    else:
        # No rating: national anchor + minutes (starters were trusted) + output.
        base = anchor + 8.0 + games * 0.4 + g90 * 2.5 + a90 * 1.5 + s90 * 0.15
    base = clamp(base)

    if family == "GK":
        gk = True
    else:
        gk = False

    def shot() -> int:
        if gk:
            return clamp(30 + base * 0.35)
        return clamp(base + g90 * 2.0 + s90 * 0.3 + {"ST": 3, "WG": 2, "CAM": 1}.get(family, 0))

    def tack() -> int:
        if gk:
            return clamp(34 + base * 0.3)
        return clamp(base + {"DF": 3, "MF": 2, "WG": -1, "ST": -2}.get(family, 0))

    def reflexes() -> int:
        if gk:
            return clamp(base + sv90 * 1.2 - max(0.0, gc90 - 0.5) * 0.5)
        return clamp(30 + base * 0.45)

    def handling() -> int:
        if gk:
            return clamp(base + csr * 6.0 + 1.0)
        return clamp(30 + base * 0.45)

    def kicking() -> int:
        if gk:
            return clamp(base + 2.0)
        return clamp(15 + base * 0.5)

    def aerial() -> int:
        bonus = {"GK": 4, "DF": 4, "ST": 2, "WG": -2}.get(family, 0)
        if gk:
            return clamp(base + bonus + csr * 2.0)
        return clamp(base + bonus)

    values = {
        "pace": clamp(base + {"WG": 2, "ST": 0, "GK": -6, "DF": -1}.get(family, 0)),
        "stamina": clamp(base + (2.0 if minutes >= 270 else 0.0) + (2.0 if minutes >= 540 else 0.0)),
        "strength": clamp(base + {"DF": 3, "ST": 2, "GK": 1, "WG": -2}.get(family, 0)),
        "dribbling": clamp(base + {"WG": 3, "ST": 2, "CAM": 2, "DF": -2}.get(family, 0)) if not gk else clamp(25 + base * 0.4),
        "passing": clamp(base + a90 * 1.4 + {"CAM": 3, "CM": 2, "CDM": 1, "WG": 1}.get(family, 0)),
        "shooting": shot(),
        "tackling": tack(),
        "vision": clamp(base + a90 * 1.2 + {"CAM": 3, "CM": 2, "CDM": 1, "WG": 1}.get(family, 0)),
        "positioning": clamp(base + g90 * 1.0 + {"ST": 2, "WG": 1, "DF": 1, "GK": -2}.get(family, 0)),
        "composure": clamp(base + (1.0 if minutes >= 360 else 0.0) + (1.0 if rating is not None and rating >= 7.5 else 0.0)),
        "reflexes": reflexes(),
        "handling": handling(),
        "kicking": kicking(),
        "aerial": aerial(),
        "decisions": clamp(base + (1.0 if minutes >= 450 else 0.0) + (1.0 if rating is not None and rating >= 7.5 else 0.0) - rc * 5.0),
        "aggression": clamp(base - 2.0 + yc * 0.6),
        "concentration": clamp(base + (2.0 if family in ("GK", "DF") else 0.0) + csr * 3.0 + (1.0 if rating is not None and rating >= 7.0 else 0.0)),
        "leadership": clamp(base + 1.0 - rc * 2.0),
    }
    return [values[k] for k in ATTR_ORDER]


def build_index(seed: dict) -> tuple[dict, dict]:
    """name(normalized) → [(code, idx)], and code → team name; code_by_name reverse."""
    index: dict[str, list[tuple[str, int]]] = {}
    for code, roster in seed["squads"].items():
        for i, pl in enumerate(roster):
            index.setdefault(norm(pl["name"]), []).append((code, i))
    name_by_code = {t["code"]: t["name"] for t in seed["teams"]}
    code_by_name = {norm(n): c for c, n in name_by_code.items()}
    return index, code_by_name


def load_teams(seed: dict, teams_path: str) -> dict:
    """Return {team_id -> FIFA code} from a companion teams.csv ('fifa_code' col).

    The real post-tournament dataset (mominullptr/FIFA-World-Cup-2026-Dataset)
    only carries numeric team_ids, and joins to 48 real national teams through
    this file. Falls back to ``{}`` when the file is absent.
    """
    code_by_name = {norm(t["name"]): t["code"] for t in seed["teams"]}
    out: dict[str, str] = {}
    if not os.path.exists(teams_path):
        return out
    with open(teams_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            tid = (row.get("team_id") or "").strip()
            code = (row.get("fifa_code") or "").strip()
            if not code:
                code = code_by_name.get(norm(row.get("team_name")))
            if tid and code:
                out[tid] = code.upper()
    return out


def main() -> int:
    csv_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV
    seed_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_SEED

    if not os.path.exists(csv_path):
        print(
            f"ERROR: dataset not found at {csv_path}\n"
            f"  Download it from kaggle.com/datasets/rauffauzanrambe/fifa-world-cup-2026-"
            f"player-performance-dataset and save the CSV there.",
            file=sys.stderr,
        )
        return 1

    with open(seed_path, encoding="utf-8") as f:
        seed = json.load(f)

    with open(csv_path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        if not headers:
            print(f"ERROR: {csv_path} has no header row", file=sys.stderr)
            return 1
        rows = [r for r in reader]

    cols = pick(headers)
    missing = [f for f in ("name",) if f not in cols]
    if missing:
        print(f"ERROR: column(s) not recognised: {missing}; headers={headers}", file=sys.stderr)
        return 1

    index, code_by_name = build_index(seed)
    team_ids = load_teams(seed, os.path.join(os.path.dirname(csv_path), "teams.csv"))
    rating_by_code = {t["code"]: t["rating"] for t in seed["teams"]}

    matched = 0
    no_data = 0
    unmatched = []
    for r in rows:
        rname = norm(r.get(cols["name"]))
        if not rname:
            continue
        candidates = index.get(rname, [])
        # Prefer the same team when the dataset carries one we can resolve.
        target_code = None
        if cols.get("team_id"):
            target_code = team_ids.get((r.get(cols["team_id"]) or "").strip())
        if target_code is None and cols.get("team"):
            target_code = code_by_name.get(norm(r.get(cols["team"])))
        if target_code is not None:
            # Known team: only match within it — guessing across teams risks
            # attributing one real player's line to a different namesake.
            sel = next((c for c in candidates if c[0] == target_code), None)
        else:
            sel = candidates[0] if candidates else None
        if sel is None:
            # Surname fallback within the same team (e.g. "Diego" vs "Diego Garcia").
            surname = norm(re.split(r"\s+", r.get(cols["name"], "").strip())[-1]) if r.get(cols["name"]) else ""
            if surname and target_code is not None:
                sel = next(
                    ((code, i) for code, i in index.get(surname, []) if code == target_code),
                    None,
                )
        if sel is None:
            unmatched.append(r.get(cols["name"], "?"))
            continue

        code, i = sel
        pl = seed["squads"][code][i]
        minutes = parse_stat(r.get(cols.get("minutes")))
        if minutes <= 0 and not r.get(cols.get("goals")):
            no_data += 1
            continue
        family = FAMILY.get(pl["positions"][0], "MF")
        canonical = {f: r.get(cols.get(f)) for f in COLUMNS}
        team_rating = rating_by_code.get(code, 70)
        pl["attrs"] = attrs_for_stats(canonical, family, team_rating)
        matched += 1

    with open(seed_path, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=1)

    nplayers = sum(len(v) for v in seed["squads"].values())
    print(
        f"wrote {seed_path}: {matched}/{nplayers} squaded players got performance attrs "
        f"({no_data} had no minutes, {len(unmatched)} unmatched)",
        file=sys.stderr,
    )
    if unmatched:
        print(f"  unmatched: {', '.join(sorted(set(unmatched))[:12])}{'...' if len(unmatched) > 12 else ''}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())