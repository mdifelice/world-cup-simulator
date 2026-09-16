#!/usr/bin/env python3
"""Merge EA FC player ratings into the seed as our 18 player attributes.

Reads the {server data dir}/seed/2026.json produced by scrape_wc2026.py and an
EA FC player database CSV (the same per-player numbers SoFifa.com mirrors), and
rewrites each squad member with "attrs" — 18 ints in the exact Rust order the
server expects (pace, stamina, strength, dribbling, passing, shooting,
tackling, vision, positioning, composure, reflexes, handling, kicking, aerial,
decisions, aggression, concentration, leadership).

Players absent from the dataset keep whatever attrs were already set. Run this
against a freshly regenerated seed (scrape_wc2026.py first), and the server's
deterministic nation-rating derivation covers the rest. Matches use
(normalized NAME + country-to-team) with a GK/non-GK sanity check, so a
namesake on the wrong team never leaks in. If that fails and the seed name is
multi-word, a single-token surname row (e.g. FC26 "Oyarzabal" vs seed
"Mikel Oyarzabal") is accepted only when it is the sole such row for that team
and the team has no second unmatched player sharing the surname.

Run order (EA ratings are the primary attribute source):

    python3 server/scripts/scrape_wc2026.py         # squads + photos (no attrs)
    python3 server/scripts/ingest_fc_ratings.py <path-to-ea-players.csv>
      # e.g. Kaggle "EA SPORTS FC 24 FULL PLAYERS DATABASE" (all_fc_24_players.csv)
      #       or the GitHub "EA-Sports-FC-24-Players-Data" mirror, saved anywhere.

Attribute mapping (EA column -> our attr):
    pace        (Acceleration + Sprint Speed) / 2
    stamina     Stamina                     tackling  Standing Tackle
    strength    Strength                    vision    Vision
    dribbling   Dribbling                   positioning Positioning
    passing     (Short Passing*2 + Long Passing + Crossing) / 4
    shooting    (Finishing*2 + Shot Power + Long Shots) / 4
    composure   Composure                   reflexes  GK Reflexes (GK) | Reactions (field)
    handling    GK Handling (GK) | Reactions-based (field)
    kicking     GK Kicking  (GK) | Shot Power       (field)
    aerial      (Heading Accuracy + Jumping) / 2
    decisions   Reactions                   aggression Aggression
    concentration Interceptions             leadership Overall (no captain stat in EA)
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys
import unicodedata

DEFAULT_SEED = "server/data/seed/2026.json"

ATTR_ORDER = [
    "pace", "stamina", "strength", "dribbling", "passing", "shooting", "tackling", "vision",
    "positioning", "composure", "reflexes", "handling", "kicking", "aerial", "decisions",
    "aggression", "concentration", "leadership",
]

# header (lowercased, non-alnum) -> attribute served by that column
COLS = {
    "name": ("name", "playername", "fullname"),
    "country": ("nation", "countryname", "country", "nationality"),
    "position": ("position", "positions", "pos"),
    "overall": ("ovr", "overall", "overallrating", "rating", "overall_rating"),
    "accel": ("acceleration", "accelerations"),
    "sprint": ("sprintspeed", "sprint"),
    "stamina": ("stamina",),
    "strength": ("strength",),
    "dribbling": ("dribbling", "dri"),
    "shortpass": ("shortpassing", "shortpass"),
    "longpass": ("longpassing", "longpass"),
    "crossing": ("crossing",),
    "finishing": ("finishing",),
    "shotpower": ("shotpower", "shotpower90"),
    "longshots": ("longshots", "longshot"),
    "tackle": ("standingtackle", "tackling", "tackle"),
    "vision": ("vision",),
    "positioning": ("positioning",),
    "composure": ("composure",),
    "reactions": ("reactions",),
    "heading": ("headingaccuracy", "heading"),
    "jumping": ("jumping",),
    "interceptions": ("interceptions",),
    "aggression": ("aggression",),
    "gkreflexes": ("gkreflexes", "reflexes"),
    "gkhandling": ("gkhandling", "handling"),
    "gkkicking": ("gkkicking", "kicking"),
}

# dataset country spellings that differ from our seed team names
COUNTRY_ALIASES = {
    "usa": "USA", "unitedstates": "USA", "america": "USA",
    "czechia": "CZE", "czechrepublic": "CZE",
    "turkiye": "TUR", "turkey": "TUR",
    "cotedivoire": "CIV", "ivorycoast": "CIV",
    "iriran": "IRN", "islamicrepublicofiran": "IRN",
    "caboverde": "CPV", "capeverde": "CPV",
    "congodr": "COD", "drcongo": "COD", "congokinshasa": "COD",
    "southkorea": "KOR", "korearepublic": "KOR",
    "bosniaandherzegovina": "BIH",
}

FAMILY = {
    "GK": "GK", "CB": "DF", "LB": "DF", "RB": "DF",
    "CM": "MF", "CDM": "MF", "CAM": "MF",
    "LW": "WG", "RW": "WG", "ST": "ST",
}

# known first-name nicknames, both directions (seed form <-> FC26 form)
NICKNAMES = {
    "andy": "andrew", "nico": "nicolas", "fede": "federico", "deki": "dejan",
    "koke": "jorge", "gabi": "gabriel", "papu": "gonzalo", "cucho": "juan",
    "dibu": "emiliano", "gio": "giovanni", "sergi": "sergio", "taty": "julian",
}


def toks(s: str) -> list[str]:
    return [norm(t) for t in s.split()]


def first_related(a: str, b: str) -> bool:
    if a == b:
        return True
    if NICKNAMES.get(a) == b or NICKNAMES.get(b) == a:
        return True
    m = min(len(a), len(b))
    return m >= 3 and a[0] == b[0] and (a.startswith(b) or b.startswith(a))


def is_subseq(sub: list[str], full: list[str]) -> bool:
    it = iter(full)
    return all(x in it for x in sub)


def variant_match(seed_name: str, data_name: str) -> bool:
    st, dt = toks(seed_name), toks(data_name)
    if len(st) < 2 or len(dt) < 2 or st[-1] != dt[-1]:
        return False
    if is_subseq(dt, st) or is_subseq(st, dt):
        return True
    return first_related(st[0], dt[0]) and st[1:] == dt[1:]


def clamp(x: float, lo: float = 25.0, hi: float = 99.0) -> int:
    return min(int(hi), max(int(lo), int(round(x))))


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = s.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]", "", s.lower())


def pick(headers: list[str]) -> dict:
    low = {norm(h): h for h in headers if h}
    return {field: low[syn] for field, syns in COLS.items() for syn in syns
            if syn in low}


def val(row: dict, header: str | None, default: float = 50.0) -> float:
    if not header:
        return default
    v = (row.get(header) or "").strip()
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        m = re.search(r"-?\d+(?:\.\d+)?", v)
        return float(m.group(0)) if m else default


def is_gk_row(row: dict, cols: dict) -> bool | None:
    """True if the EA row is a keeper, False if a field player, None if unknown."""
    pos = row.get(cols["position"]) if cols.get("position") else None
    if not pos:
        return None
    return "GK" in pos.upper()


def attrs_for_row(row: dict, cols: dict, is_gk: bool) -> list[int]:
    accel = val(row, cols.get("accel"))
    sprint = val(row, cols.get("sprint"))
    pace = (accel + sprint) / 2.0
    shot_pow = val(row, cols.get("shotpower"))
    reactions = val(row, cols.get("reactions"))

    if is_gk:
        reflexes = val(row, cols.get("gkreflexes"))
        handling = val(row, cols.get("gkhandling"))
        kicking = val(row, cols.get("gkkicking"))
    else:
        reflexes = reactions
        handling = reactions * 0.35 + 18.0
        kicking = shot_pow

    values = {
        "pace": clamp(pace),
        "stamina": clamp(val(row, cols.get("stamina"))),
        "strength": clamp(val(row, cols.get("strength"))),
        "dribbling": clamp(val(row, cols.get("dribbling"))),
        "passing": clamp((val(row, cols.get("shortpass")) * 2 + val(row, cols.get("longpass"))
                          + val(row, cols.get("crossing"))) / 4.0),
        "shooting": clamp((val(row, cols.get("finishing")) * 2 + shot_pow
                           + val(row, cols.get("longshots"))) / 4.0),
        "tackling": clamp(val(row, cols.get("tackle"))),
        "vision": clamp(val(row, cols.get("vision"))),
        "positioning": clamp(val(row, cols.get("positioning"))),
        "composure": clamp(val(row, cols.get("composure"))),
        "reflexes": clamp(reflexes),
        "handling": clamp(handling),
        "kicking": clamp(kicking),
        "aerial": clamp((val(row, cols.get("heading")) + val(row, cols.get("jumping"))) / 2.0),
        "decisions": clamp(reactions),
        "aggression": clamp(val(row, cols.get("aggression"))),
        "concentration": clamp(val(row, cols.get("interceptions"))),
        "leadership": clamp(val(row, cols.get("overall"))),
    }
    return [values[k] for k in ATTR_ORDER]


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: ingest_fc_ratings.py <ea-players.csv> [seed.json]", file=sys.stderr)
        return 1
    csv_path = sys.argv[1]
    seed_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_SEED
    if not os.path.exists(csv_path):
        print(f"ERROR: dataset not found at {csv_path}", file=sys.stderr)
        return 1

    with open(seed_path, encoding="utf-8") as f:
        seed = json.load(f)

    with open(csv_path, encoding="utf-8-sig") as f:
        try:
            reader = csv.DictReader(f)
            headers = reader.fieldnames or []
            rows = list(reader)
        except UnicodeDecodeError:
            print("  (utf-8 failed, retrying as latin-1)", file=sys.stderr)
            with open(csv_path, encoding="latin-1") as f2:
                reader = csv.DictReader(f2)
                headers = reader.fieldnames or []
                rows = list(reader)
    cols = pick(headers)
    if "name" not in cols:
        print(f"ERROR: no name column recognised; headers={headers[:12]}", file=sys.stderr)
        return 1

    code_by_country = {norm(t["code"]): t["code"] for t in seed["teams"]}
    code_by_country.update({norm(t["name"]): t["code"] for t in seed["teams"]})
    by_name: dict[str, list[dict]] = {}
    by_surname: dict[str, list[dict]] = {}
    for row in rows:
        nn = norm(row.get(cols["name"]))
        if nn:
            by_name.setdefault(nn, []).append(row)
            st = toks(row.get(cols["name"]))
            if len(st) >= 2:
                by_surname.setdefault(st[-1], []).append(row)

    def country_code(country: str | None) -> str | None:
        if not country:
            return None
        n = norm(country)
        return COUNTRY_ALIASES.get(n) or code_by_country.get(n)

    matched = 0
    unmatched: list[tuple[str, str, str]] = []
    for code, roster in seed["squads"].items():
        for pl in roster:
            seed_gk = FAMILY.get(pl["positions"][0], "MF") == "GK"
            cands = by_name.get(norm(pl["name"]), [])
            hit = None
            for row in cands:
                rc = country_code(row.get(cols["country"]))
                pos_gk = is_gk_row(row, cols)
                gk_ok = pos_gk is None or pos_gk == seed_gk
                if rc == code and gk_ok:
                    hit = row
                    break
            if hit is None and len(cands) == 1:
                row = cands[0]
                pos_gk = is_gk_row(row, cols)
                if (pos_gk is None or pos_gk == seed_gk):
                    hit = row
            if hit is None and len(pl["name"].split()) > 1:
                surname = norm(pl["name"].split()[-1])
                surname_rows = [r for r in by_name.get(surname, [])
                                if country_code(r.get(cols["country"])) == code
                                and (is_gk_row(r, cols) is None
                                     or is_gk_row(r, cols) == seed_gk)]
                if len(surname_rows) == 1 and norm(surname_rows[0].get(cols["name"])) == surname:
                    siblings = [p for p in roster if p is not pl
                                and len(p["name"].split()) > 1
                                and norm(p["name"].split()[-1]) == surname]
                    if not siblings:
                        hit = surname_rows[0]
            if hit is None and len(pl["name"].split()) > 1:
                surname = norm(pl["name"].split()[-1])
                claimants = [p for p in roster if p is not pl and "attrs" not in p
                             and len(p["name"].split()) > 1
                             and norm(p["name"].split()[-1]) == surname]
                variants = [r for r in by_surname.get(surname, [])
                            if country_code(r.get(cols["country"])) == code
                            and (is_gk_row(r, cols) is None
                                 or is_gk_row(r, cols) == seed_gk)
                            and variant_match(pl["name"], r.get(cols["name"]))]
                if len(variants) == 1 and not claimants:
                    hit = variants[0]
            if hit is None:
                unmatched.append((code, pl["name"], pl["positions"][0]))
                continue
            pl["attrs"] = attrs_for_row(hit, cols, seed_gk)
            matched += 1

    with open(seed_path, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=1)

    nplayers = sum(len(v) for v in seed["squads"].values())
    print(
        f"wrote {seed_path}: {matched}/{nplayers} squaded players got EA ratings "
        f"({len(unmatched)} unmatched)",
        file=sys.stderr,
    )
    if unmatched:
        arg = [n for c, n, p in unmatched if c == "ARG"]
        print(f"  ARG unmatched: {arg[:6]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())