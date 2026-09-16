#!/usr/bin/env python3
"""Scrape the 2026 FIFA World Cup real data from English Wikipedia into a JSON seed.

Produces {server data dir}/seed/2026.json consumed by the Rust server at boot:

    teams    — the 48 qualifiers (name, FIFA-style code, flag, strength rating, group)
    squads   — per-team real 26-man rosters (name, positions, shirt number, photo)
    fixtures — the real group-stage schedule (home, away, matchday, kickoff, venue)

Sources (all en.wikipedia.org):
  - "2026 FIFA World Cup Group A" .. "L"  → team codes + real fixtures
  - "2026 FIFA World Cup squads"          → per-team squad lists
  - MediaWiki prop=pageimages            → each player's lead image (Wikimedia
    Commons headshot) stored as "photo" (free-licensed, hotlinkable)

Ratings are a strength estimate per nation (FIFA ranking–inspired) and live in
RATINGS below so the pipeline stays deterministic — tune them freely.

Run this BEFORE ingest_wc2026_stats.py (which adds per-player performance attrs),
since it rewrites squads from scratch.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse

UA = {"User-Agent": "wcs-seed-scraper/0.1 (dev; local tool)"}
API = "https://en.wikipedia.org/w/api.php"
GROUPS = "ABCDEFGHIJKL"
_POLITE = 1.2  # seconds between API calls (Wikipedia rate-limits fast scrapers)

# strength rating per team code (FIFA ranking–inspired)
RATINGS = {
    "ARG": 93, "FRA": 92, "ESP": 91, "ENG": 90, "BRA": 89, "POR": 88,
    "GER": 87, "NED": 86, "BEL": 84, "CRO": 83, "COL": 82, "URU": 82,
    "MAR": 81, "USA": 80, "MEX": 80, "TUR": 80, "CZE": 77, "JPN": 79,
    "SUI": 79, "SEN": 79, "AUT": 78, "SWE": 78, "CAN": 77, "ECU": 77,
    "IRN": 77, "KOR": 76, "AUS": 74, "SCO": 74, "TUN": 74, "ALG": 74,
    "CIV": 74, "EGY": 74, "NOR": 74, "PAR": 73, "RSA": 73, "BIH": 72,
    "GHA": 71, "QAT": 70, "COD": 70, "UZB": 69, "CPV": 67, "KSA": 67,
    "PAN": 66, "NZL": 64, "JOR": 63, "HAI": 62, "IRQ": 61, "CUW": 60,
}

# flag emoji per team code (Scottish/English flags are subdivision tags)
FLAGS = {
    "ARG": "🇦🇷", "FRA": "🇫🇷", "ESP": "🇪🇸", "ENG": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "BRA": "🇧🇷",
    "POR": "🇵🇹", "GER": "🇩🇪", "NED": "🇳🇱", "BEL": "🇧🇪", "CRO": "🇭🇷",
    "COL": "🇨🇴", "URU": "🇺🇾", "MAR": "🇲🇦", "USA": "🇺🇸", "MEX": "🇲🇽",
    "TUR": "🇹🇷", "CZE": "🇨🇿", "JPN": "🇯🇵", "SUI": "🇨🇭", "SEN": "🇸🇳",
    "AUT": "🇦🇹", "SWE": "🇸🇪", "CAN": "🇨🇦", "ECU": "🇪🇨", "IRN": "🇮🇷",
    "KOR": "🇰🇷", "AUS": "🇦🇺", "SCO": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "TUN": "🇹🇳", "ALG": "🇩🇿",
    "CIV": "🇨🇮", "EGY": "🇪🇬", "NOR": "🇳🇴", "PAR": "🇵🇾", "RSA": "🇿🇦",
    "BIH": "🇧🇦", "GHA": "🇬🇭", "QAT": "🇶🇦", "COD": "🇨🇩", "UZB": "🇺🇿",
    "CPV": "🇨🇻", "KSA": "🇸🇦", "PAN": "🇵🇦", "NZL": "🇳🇿", "JOR": "🇯🇴",
    "HAI": "🇭🇹", "IRQ": "🇮🇶", "CUW": "🇨🇼",
}

# position-value normalisation to the app's supported slots
POS_MAP = {
    "GK": "GK", "DF": "CB", "CB": "CB", "LB": "LB", "RB": "RB",
    "LWB": "LB", "RWB": "RB", "WB": "RB",
    "MF": "CM", "CM": "CM", "DM": "CDM", "CDM": "CDM", "AM": "CAM",
    "CAM": "CAM", "LM": "LW", "RM": "RW", "LW": "LW", "RW": "RW",
    "FW": "ST", "ST": "ST", "CF": "ST",
}


def fetch(url: str) -> str:
    for attempt in range(10):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(min(120.0, 5.0 * (2 ** attempt)))  # exponential backoff
                continue
            raise
    raise urllib.error.HTTPError(url, 429, "rate limited", None, None)


def api_wikitext(page: str) -> str:
    cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
    os.makedirs(cache_dir, exist_ok=True)
    fname = page.replace(" ", "_").replace("/", "_") + ".wiki"
    fpath = os.path.join(cache_dir, fname)
    if os.path.exists(fpath):
        with open(fpath, encoding="utf-8") as f:
            return f.read()
    time.sleep(_POLITE)
    qs = urllib.parse.urlencode(
        {"action": "parse", "page": page, "prop": "wikitext",
         "format": "json", "formatversion": "2"}
    )
    data = json.loads(fetch(f"{API}?{qs}"))
    wt = data["parse"]["wikitext"]
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(wt)
    return wt


_PHOTO_CACHE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".cache", "pageimages.json"
)


def load_photo_cache() -> dict:
    if os.path.exists(_PHOTO_CACHE):
        try:
            with open(_PHOTO_CACHE, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    return {}


def save_photo_cache(cache: dict) -> None:
    tmp = _PHOTO_CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, _PHOTO_CACHE)


def fetch_photos(cache: dict, titles: list) -> None:
    """Backfill cache with each title's lead image URL (320px thumb) or None.

    Uses prop=pageimages — the article's own representative image, typically a
    Wikimedia Commons headshot. Free licences, stable upload.wikimedia.org URL.
    """
    missing = [t for t in titles if t not in cache]
    for i in range(0, len(missing), 25):
        batch = missing[i:i + 25]
        time.sleep(_POLITE)
        qs = urllib.parse.urlencode(
            {"action": "query", "titles": "|".join(batch),
             "prop": "pageimages", "piprop": "thumbnail", "pithumbsize": "320",
             "format": "json", "formatversion": "2"}
        )
        data = json.loads(fetch(f"{API}?{qs}"))
        for page in data.get("query", {}).get("pages", []):
            if page.get("missing"):
                continue
            title = page.get("title")
            url = page.get("thumbnail", {}).get("source")
            cache.setdefault(title, url)
        save_photo_cache(cache)
    for t in missing:
        cache.setdefault(t, None)


def strip_links(raw: str) -> str:
    def repl(m):
        return m.group(1).split("|")[-1]
    out = re.sub(r"\[\[([^\]]+)\]\]", repl, raw)
    out = out.replace("{{", " ").replace("}}", " ")
    out = re.sub(r"<[^>]+>", "", out)
    return re.sub(r"\s+", " ", out).strip()


def parse_time(text: str) -> str | None:
    m = re.search(r"(\d{1,2}):(\d{2})(?:&nbsp;| )?([ap]\.m\.|am|pm)?", text)
    if not m:
        return None
    h = int(m.group(1)) % 12
    if m.group(3) and m.group(3).startswith("p"):
        h += 12
    return f"{h:02d}:{m.group(2)}"


def box_field(block: str, name: str) -> str:
    fm = re.search(rf"\n\|?{name}\s*=\s*(.*?)(?=\n\|[a-z0-9]+\s*=|\Z)", block, re.S)
    return fm.group(1).strip() if fm else ""


def parse_group_page(wt: str):
    """Returns (fixtures, {team name → FIFA code}) for one group page."""
    fixtures = []
    name_by_code = {}
    pending_names = None

    # Walk headings and match boxes together, in document order: each box is
    # preceded by its "=== Team A vs Team B ===" heading, pairing names → codes.
    box_re = re.compile(
        r"<section begin=['\"]?([A-Z])(\d+)['\"]?\s*/>\s*\{\{#invoke:football box\|main(.*?)\n\}\}",
        re.S,
    )
    head_re = re.compile(r"^===+\s*(.*?)\s*===+\s*$", re.M)

    def heading_names(bh):
        inner = re.sub(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]",
                       lambda mm: mm.group(1).split("|")[-1], bh.group(1))
        inner = inner.replace("{{", " ").replace("}}", " ")
        parts = re.split(r"\s+vs\.?\s+", inner, maxsplit=1)
        if len(parts) != 2:
            return None
        return [re.sub(r"\s+", " ", p).strip() for p in parts]
    pos = 0
    while True:
        bh = None
        bb = box_re.search(wt, pos)
        if bb is not None:
            bh = head_re.search(wt, pos, bb.start())
        if bh is None and bb is None:
            break
        if bh is not None and (bb is None or bh.start() < bb.start()):
            names = heading_names(bh)
            if names:
                pending_names = names
            pos = bh.end()
            continue
        m = bb
        letter, num = m.group(1), int(m.group(2))
        block = m.group(3)
        team1 = re.search(r"fb-rt\|([A-Z]{3})\}", box_field(block, "team1"))
        team2 = re.search(r"\|([A-Z]{3})\}\}", box_field(block, "team2"))
        if team1 and team2:
            code1, code2 = team1.group(1), team2.group(1)
            if len(pending_names or []) == 2:
                name_by_code.setdefault(code1, pending_names[0])
                name_by_code.setdefault(code2, pending_names[1])

            date = re.search(r"Start date\|(\d{4})\|(\d{1,2})\|(\d{1,2})",
                             box_field(block, "date"))
            kickoff = None
            if date:
                t = parse_time(box_field(block, "time"))
                kickoff = f"{date.group(1)}-{int(date.group(2)):02d}-{int(date.group(3)):02d}"
                if t:
                    kickoff += f"T{t}"
            fixtures.append({
                "group": letter,
                "match": num,
                "home": code1,
                "away": code2,
                "matchday": (num - 1) // 2 + 1,
                "kickoff": kickoff,
                "venue": strip_links(box_field(block, "stadium")),
            })
        pos = m.end()
        pending_names = None
    return fixtures, name_by_code


def parse_squads(wt: str):
    """Returns {team name → roster} from the ==Group …== sections."""
    squads = {}
    for gm in re.finditer(r"^==([^=\n]+)==\s*$", wt, re.M):
        title = gm.group(1).strip()
        if not title.startswith("Group "):
            continue
        start = gm.end()
        nxt = re.search(r"^==([^=\n]+)==\s*$", wt[start:], re.M)
        end = start + (nxt.start() if nxt else len(wt[start:]))
        section = wt[start:end]
        for tm in re.finditer(r"^===([^=\n]+)===\s*$", section, re.M):
            team_name = tm.group(1).strip()
            st = tm.end()
            nxt2 = re.search(r"^===([^=\n]+)===\s*$", section[st:], re.M)
            en = st + (nxt2.start() if nxt2 else len(section[st:]))
            loads = []
            for pm in re.finditer(
                r"\{\{nat fs g player\|([^}]*?)\}\}", section[st:en], re.S,
            ):
                fields = dict(
                    (k.strip(), v.strip())
                    for k, v in re.findall(
                        r"(\w+)\s*=\s*(.*?)(?=\|\w+\s*=|$)", pm.group(1), re.S,
                    )
                )
                raw_name = fields.get("name", "")
                # The article title is the [[link target]] when the name is
                # linked (disambiguation links like [[Name (footballer)|Name]]
                # still resolve); otherwise fall back to the stripped name.
                link = re.search(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]", raw_name)
                wiki = link.group(1).split("#")[0].replace("_", " ").strip() if link else ""
                name = strip_links(raw_name)
                if not name:
                    continue
                if not wiki:
                    wiki = name
                pos = fields.get("pos", "").upper()
                for token in re.split(r"/|,", pos):
                    token = token.strip()
                    if token in POS_MAP:
                        pos = POS_MAP[token]
                        break
                else:
                    pos = "CM"
                no = fields.get("no", "").replace("&nbsp;", "").strip()
                loads.append({
                    "name": name,
                    "positions": [pos],
                    "shirt": int(no) if no.isdigit() else None,
                    "wiki": wiki,
                })
            squads[team_name] = loads
    return squads


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "data/seed/2026.json"

    # 1) Group fixtures + team names/codes.
    fixtures = []
    group_codes = {g: set() for g in GROUPS}
    name_by_code = {}
    for letter in GROUPS:
        page = f"2026 FIFA World Cup Group {letter}"
        print(f"fetching {page} ...", file=sys.stderr)
        wt = api_wikitext(page)
        gfx, nbc = parse_group_page(wt)
        fixtures.extend(gfx)
        for f in gfx:
            group_codes[f["group"]].add(f["home"])
            group_codes[f["group"]].add(f["away"])
        name_by_code.update(nbc)
        if len(gfx) != 6:
            print(f"  WARN {page}: {len(gfx)} matches (expected 6)", file=sys.stderr)

    # 2) Squads (authoritative team-per-group mapping).
    print("fetching 2026 FIFA World Cup squads ...", file=sys.stderr)
    squads_by_name = parse_squads(api_wikitext("2026 FIFA World Cup squads"))

    # 3) Assemble canonical team records keyed by code.
    teams = []
    seen = set()
    for letter in GROUPS:
        for code in sorted(group_codes[letter]):
            if code in seen:
                continue
            seen.add(code)
            name = name_by_code.get(code) or code
            teams.append({
                "name": name,
                "code": code,
                "flag": FLAGS.get(code, "🏳️"),
                "rating": RATINGS.get(code, 70),
                "group": letter,
            })

    squads = {}
    for t in teams:
        squads[t["code"]] = squads_by_name.get(t["name"], [])
        if not squads[t["code"]]:
            print(f"  WARN no roster for {t['name']} ({t['code']})", file=sys.stderr)

    # 4) Player headshots (Wikimedia Commons via prop=pageimages, 320px thumbs).
    photo_cache = load_photo_cache()
    all_titles = sorted({
        pl["wiki"] for roster in squads.values() for pl in roster if pl.get("wiki")
    })
    print(f"resolving {len(all_titles)} player photos ...", file=sys.stderr)
    fetch_photos(photo_cache, all_titles)
    save_photo_cache(photo_cache)
    for code in squads:
        for pl in squads[code]:
            pl["photo"] = photo_cache.get(pl.get("wiki"))
            pl.pop("wiki", None)

    seed = {
        "year": 2026,
        "name": "2026 FIFA World Cup",
        "host": "United States, Canada & Mexico",
        "teams": teams,
        "squads": squads,
        "fixtures": fixtures,
    }

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=1)
    nplayers = sum(len(v) for v in squads.values())
    nphotos = sum(1 for v in squads.values() for pl in v if pl.get("photo"))
    print(
        f"wrote {out_path}: {len(teams)} teams, {nplayers} players "
        f"({nphotos} with photos), {len(fixtures)} fixtures",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())