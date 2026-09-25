#!/usr/bin/env python3
"""Hybrid World Cup data ingest: openfootball (fixtures/lineups) + Wikipedia (photos).

For each edition 1930-2018:
  1. Download openfootball worldcup-full.json → teams, matches, lineups, goals, bookings
  2. Scrape Wikipedia for squad pages → player photos from Wikimedia Commons
  3. Merge → server/data/seed/{year}.json consumed by Rust server

Run:
    python3 server/scripts/ingest_historical.py

Outputs:
    server/data/seed/1930.json, ..., server/data/seed/2018.json
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
import urllib.parse
from pathlib import Path
from typing import Any

UA = {"User-Agent": "wcs-historical-ingest/0.1 (dev; local tool)"}
OF_BASE = "https://raw.githubusercontent.com/openfootball/worldcup.json/master"
WIKI_API = "https://en.wikipedia.org/w/api.php"
_POLITE = 1.2

# FIFA-style 3-letter codes for all historical teams
TEAM_CODES = {
    # 1930
    "France": "FRA", "Mexico": "MEX", "Argentina": "ARG", "Chile": "CHI",
    "Yugoslavia": "YUG", "Brazil": "BRA", "Bolivia": "BOL", "Peru": "PER",
    "Paraguay": "PAR", "Romania": "ROU", "Uruguay": "URU", "Belgium": "BEL",
    "USA": "USA", "Romania": "ROU", "Peru": "PER", "Paraguay": "PAR",
    # 1934
    "Italy": "ITA", "Czechoslovakia": "TCH", "Germany": "GER", "Austria": "AUT",
    "Spain": "ESP", "Hungary": "HUN", "Switzerland": "SUI", "Sweden": "SWE",
    "Netherlands": "NED", "Romania": "ROU", "Egypt": "EGY", "Belgium": "BEL",
    "France": "FRA", "USA": "USA", "Brazil": "BRA", "Argentina": "ARG",
    # 1938
    "Poland": "POL", "Norway": "NOR", "Cuba": "CUB", "Dutch East Indies": "IDN",
    # 1950
    "England": "ENG", "Scotland": "SCO", "Turkey": "TUR", "India": "IND",
    # 1954
    "Korea Republic": "KOR", "Turkey": "TUR", "South Korea": "KOR",
    # 1958
    "Wales": "WAL", "Northern Ireland": "NIR", "Soviet Union": "URS",
    # 1962
    "Colombia": "COL", "Bulgaria": "BUL",
    # 1966
    "North Korea": "PRK", "Portugal": "POR",
    # 1970
    "El Salvador": "SLV", "Morocco": "MAR", "Israel": "ISR",
    # 1974
    "Zaire": "ZAI", "Haiti": "HAI", "Australia": "AUS", "East Germany": "GDR",
    "Germany DR": "GDR", "DR Congo": "ZAI",
    # 1978
    "Iran": "IRN", "Tunisia": "TUN", "Peru": "PER",
    # 1982
    "Algeria": "ALG", "Honduras": "HON", "Kuwait": "KUW", "New Zealand": "NZL",
    # 1986
    "Canada": "CAN", "Denmark": "DEN", "Iraq": "IRQ", "Soviet Union": "URS",
    # 1990
    "Costa Rica": "CRC", "Republic of Ireland": "IRL", "UAE": "UAE", "Czechoslovakia": "TCH",
    "Soviet Union": "URS", "West Germany": "FRG", "Yugoslavia": "YUG",
    # 1994
    "Greece": "GRE", "Nigeria": "NGA", "Saudi Arabia": "KSA", "Ireland": "IRL",
    "USSR": "URS", "United States": "USA", "Cameroon": "CMR", "Russia": "RUS",
    "United Arab Emirates": "UAE",
    # 1998
    "Croatia": "CRO", "Jamaica": "JAM", "Japan": "JPN", "South Africa": "RSA",
    "FR Yugoslavia": "YUG",
    # 2002
    "China PR": "CHN", "China": "CHN", "Ecuador": "ECU", "Senegal": "SEN", "Slovenia": "SVN",
    # 2006
    "Angola": "ANG", "Côte d'Ivoire": "CIV", "Ghana": "GHA", "Trinidad and Tobago": "TRI",
    "Togo": "TOG", "Ukraine": "UKR",
    # 2010
    "Slovakia": "SVK",
    # 2014
    "Bosnia and Herzegovina": "BIH",
    # 2018
    "Iceland": "ISL", "Panama": "PAN",
    # other spellings found on the "YYYY FIFA World Cup squads" pages
    "IR Iran": "IRN", "Ivory Coast": "CIV", "Czech Republic": "CZE",
    "South Korea": "KOR", "South Africa": "RSA", "North Korea": "PRK",
    "Crna Gora": "MNE", "Trinidad & Tobago": "TRI", "Saudi Arabia": "KSA",
}

# These override the name as it appears in openfootball
NAME_OVERRIDES = {
    "Korea Republic": "South Korea",
    "Dutch East Indies": "Indonesia",
    "Soviet Union": "USSR",
    "Czechoslovakia": "Czechoslovakia",
    "Zaire": "DR Congo",
    "Côte d'Ivoire": "Ivory Coast",
    "Trinidad and Tobago": "Trinidad & Tobago",
    "West Germany": "West Germany",
    "Yugoslavia": "Yugoslavia",
    "USA": "United States",
    "Bosnia-Herzegovina": "Bosnia and Herzegovina",
}

# Country code mapping for flags
# Host country per edition
HOSTS = {
    1930: "Uruguay",
    1934: "Italy",
    1938: "France",
    1950: "Brazil",
    1954: "Switzerland",
    1958: "Sweden",
    1962: "Chile",
    1966: "England",
    1970: "Mexico",
    1974: "West Germany",
    1978: "Argentina",
    1982: "Spain",
    1986: "Mexico",
    1990: "Italy",
    1994: "United States",
    1998: "France",
    2002: "South Korea / Japan",
    2006: "Germany",
    2010: "South Africa",
    2014: "Brazil",
    2018: "Russia",
    2022: "Qatar",
    2026: "United States / Mexico / Canada",
}

# Flag emoji per team code
FLAG_CODES = {
    "FRA": "🇫🇷", "MEX": "🇲🇽", "ARG": "🇦🇷", "CHI": "🇨🇱", "YUG": "🇷🇸",
    "BRA": "🇧🇷", "BOL": "🇧🇴", "PER": "🇵🇪", "PAR": "🇵🇾", "ROU": "🇷🇴",
    "URU": "🇺🇾", "BEL": "🇧🇪", "USA": "🇺🇸", "ITA": "🇮🇹", "TCH": "🇨🇿",
    "GER": "🇩🇪", "FRG": "🇩🇪", "AUT": "🇦🇹", "ESP": "🇪🇸", "HUN": "🇭🇺", "SUI": "🇨🇭",
    "SWE": "🇸🇪", "NED": "🇳🇱", "EGY": "🇪🇬", "POL": "🇵🇱", "NOR": "🇳🇴",
    "CUB": "🇨🇺", "IDN": "🇮🇩", "ENG": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "SCO": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
    "TUR": "🇹🇷", "IND": "🇮🇳", "KOR": "🇰🇷", "WAL": "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
    "NIR": "🇬🇧", "URS": "🇷🇺", "FRG": "🇩🇪", "COL": "🇨🇴", "BUL": "🇧🇬",
    "PRK": "🇰🇵", "POR": "🇵🇹", "SLV": "🇸🇻", "MAR": "🇲🇦", "ISR": "🇮🇱",
    "ZAI": "🇨🇩", "HAI": "🇭🇹", "AUS": "🇦🇺", "IRN": "🇮🇷", "TUN": "🇹🇳",
    "ALG": "🇩🇿", "HON": "🇭🇳", "KUW": "🇰🇼", "NZL": "🇳🇿", "CIV": "🇨🇮",
    "GHA": "🇬🇭", "TRI": "🇹🇹", "TOG": "🇹🇬", "UKR": "🇺🇦", "CRC": "🇨🇷",
    "IRL": "🇮🇪", "UAE": "🇦🇪", "GRE": "🇬🇷", "NGA": "🇳🇬", "KSA": "🇸🇦",
    "CRO": "🇭🇷", "JAM": "🇯🇲", "JPN": "🇯🇵", "RSA": "🇿🇦", "CHN": "🇨🇳",
    "ECU": "🇪🇨", "SEN": "🇸🇳", "SVN": "🇸🇮", "ANG": "🇦🇴", "SVK": "🇸🇰",
    "BIH": "🇧🇦", "ISL": "🇮🇸", "PAN": "🇵🇦", "DR Congo": "🇨🇩",
    "Russia": "🇷🇺", "Czech Republic": "🇨🇿", "DR Congo": "🇨🇩",
    "South Korea": "🇰🇷", "Ivory Coast": "🇨🇮", "Trinidad & Tobago": "🇹🇹",
    "CAN": "🇨🇦", "DEN": "🇩🇰", "IRQ": "🇮🇶", "CMR": "🇨🇲", "RUS": "🇷🇺", "UAE": "🇦🇪",
    "GDR": "🇩🇪",
}

# Strength ratings by team code (FIFA ranking–inspired)
RATINGS = {
    "ARG": 93, "BRA": 92, "FRA": 91, "GER": 90, "ESP": 89, "ITA": 88,
    "URU": 87, "ENG": 86, "NED": 85, "POR": 84, "BEL": 83, "CRO": 82,
    "COL": 81, "CHI": 80, "MEX": 79, "USA": 78, "URU": 77, "SRB": 76,
    "SUI": 75, "CRO": 74, "DEN": 73, "MEX": 72, "SWE": 71, "POL": 70,
    "KSA": 69, "IRN": 68, "KOR": 67, "JPN": 66, "AUS": 65, "NGA": 64,
    "CIV": 63, "GHA": 62, "CMR": 61, "ALG": 60, "MAR": 59, "TUN": 58,
    "EGY": 57, "SEN": 56, "CIV": 55, "ECU": 54, "PAR": 53, "VEN": 52,
    "BOL": 51, "PER": 50, "VEN": 49, "PAN": 48, "CRC": 47, "JAM": 46,
    "TRI": 45, "HAI": 44, "ZAI": 43, "HKG": 42, "SLV": 41, "KUW": 40,
    "IRQ": 39, "NZL": 38, "CHN": 37, "UAE": 36, "KOR": 35, "PRK": 34,
    "SVN": 33, "SVK": 32, "BIH": 31, "ISL": 30, "PAN": 29,
    # 1986–1994 editions
    "FRG": 90, "URS": 84, "YUG": 80, "TCH": 70, "ROU": 70, "BUL": 72,
    "RUS": 80, "HUN": 64, "SCO": 66, "NIR": 60, "AUT": 66, "NOR": 68,
    "GRE": 58, "IRL": 70, "CMR": 68, "DEN": 73,
    # 1970–1982 editions (host-era strength)
    "GDR": 78, "FRG": 90,
}

# Per-edition strength (1930–1966). FIFA rankings never meant much then, so
# these are the eye-tests of the era: Hungary 1954 (the Mighty Magyars) and
# Uruguay 1950 lead their tournaments, 1930s Austria keeps its "Wunderteam"
# class, and the modern table's ARG/FRA/NED fantasy numbers never leak back.
ERA_RATINGS: dict[int, dict[str, int]] = {
    1930: {"URU": 90, "ARG": 88, "YUG": 82, "USA": 80, "BRA": 78, "CHI": 76,
           "BEL": 74, "FRA": 72, "ROU": 70, "PER": 68, "PAR": 62, "MEX": 62, "BOL": 58},
    1934: {"ITA": 88, "AUT": 86, "TCH": 86, "GER": 84, "HUN": 84, "ESP": 82,
           "SWE": 80, "FRA": 78, "ARG": 78, "BRA": 76, "SUI": 76, "NED": 76,
           "BEL": 74, "ROU": 68, "USA": 62, "EGY": 60},
    1938: {"ITA": 88, "HUN": 86, "BRA": 84, "TCH": 82, "GER": 82, "FRA": 80,
           "SWE": 78, "NED": 76, "SUI": 74, "BEL": 72, "POL": 70, "ROU": 68,
           "NOR": 66, "CUB": 58, "IDN": 54},
    1950: {"BRA": 88, "URU": 85, "ESP": 84, "ENG": 82, "SWE": 80, "YUG": 80,
           "ITA": 78, "CHI": 74, "SUI": 74, "USA": 70, "PAR": 68, "MEX": 64, "BOL": 56},
    1954: {"HUN": 90, "FRG": 86, "BRA": 84, "URU": 82, "AUT": 81, "YUG": 80,
           "ITA": 78, "ENG": 77, "SUI": 76, "FRA": 76, "TCH": 75, "BEL": 74,
           "TUR": 72, "SCO": 72, "MEX": 64, "KOR": 48},
    1958: {"BRA": 90, "FRG": 85, "SWE": 84, "FRA": 84, "URS": 82, "ENG": 79,
           "YUG": 79, "HUN": 78, "WAL": 76, "NIR": 76, "SCO": 76, "TCH": 76,
           "ARG": 76, "AUT": 74, "PAR": 66, "MEX": 64},
    1962: {"BRA": 90, "URS": 84, "TCH": 84, "CHI": 83, "YUG": 81, "FRG": 81,
           "ESP": 80, "ENG": 80, "HUN": 80, "ITA": 79, "ARG": 78, "URU": 76,
           "COL": 74, "BUL": 72, "SUI": 70, "MEX": 68},
    1966: {"ENG": 88, "FRG": 88, "POR": 87, "BRA": 84, "URS": 82, "ITA": 82,
           "ARG": 81, "ESP": 80, "HUN": 78, "YUG": 76, "URU": 76, "FRA": 74,
           "CHI": 72, "PRK": 72, "BUL": 70, "SUI": 68, "MEX": 66},
}

# ---------------------------------------------------------------------------
# Iconic players: elite attrs + a pinned, iconic primary role so the greats
# play their real position and read 5 stars instead of a name-hash roll.
# Positions follow the game's granular tokens (GK/CB/LB/RB/CDM/CM/CAM/LM/RM/
# LW/RW/ST/CF); a trailing "!" pins the card exactly (no auto-enrichment),
# FAM  familiarities like "CM:85" let the engine use them off that role.
# ---------------------------------------------------------------------------
_STAR_ATTRS = {
    # MF playmakers: pace, stamina, strength, dribbling, passing, shooting,
    # tackling, vision, positioning, composure, reflexes, handling, kicking,
    # aerial, decisions, aggression, concentration, leadership
    "MF": [90, 90, 82, 94, 96, 90, 80, 97, 93, 94, 78, 74, 86, 74, 92, 80, 90, 94],
    # FW finishers/free-roamers
    "FW": [95, 89, 86, 93, 82, 98, 45, 89, 96, 94, 70, 62, 82, 88, 90, 82, 90, 90],
    # DF commanders
    "DF": [86, 87, 90, 82, 89, 62, 96, 86, 93, 94, 78, 72, 82, 93, 92, 86, 92, 96],
    # GK shot-stoppers / sweepers
    "GK": [56, 62, 84, 58, 68, 58, 54, 80, 92, 88, 95, 95, 92, 88, 90, 72, 92, 90],
}

STAR_OVERRIDES = {
    # "stored seed name": (pinned positions, family)
    "Pelé": (["CF!", "ST:90"], "FW"),
    "Jairzinho": (["RW!", "RM:85", "ST:80"], "FW"),
    "Gerd Müller": (["ST!", "CF:90"], "FW"),
    "Franz Beckenbauer": (["CB!", "CDM:85"], "DF"),
    "Bobby Moore": (["CB!"], "DF"),
    "Teófilo Cubillas": (["CAM!", "ST:85", "CM:80"], "MF"),
    "Johan Cruyff": (["CF!", "ST:90", "LW:80"], "FW"),
    "Rob Rensenbrink": (["LW!", "ST:85"], "FW"),
    "Mario Kempes": (["ST!", "CF:88"], "FW"),
    "Zico": (["CAM!", "CF:85", "CM:85"], "MF"),
    "Michel Platini": (["CAM!", "CM:88"], "MF"),
    "Paolo Rossi": (["ST!", "CF:88"], "FW"),
    "Karl-Heinz Rummenigge": (["RW!", "ST:85", "CF:82"], "FW"),
    "Diego Maradona": (["CAM!", "CM:85", "CF:80"], "MF"),
    "Lothar Matthäus": (["CM!", "CDM:90", "CAM:85"], "MF"),
    "Gary Lineker": (["ST!", "CF:88"], "FW"),
    "Roberto Baggio": (["CAM!", "CF:88", "ST:82"], "MF"),
    "Salvatore Schillaci": (["ST!"], "FW"),
    "Gheorghe Hagi": (["CAM!", "LW:80", "CM:85"], "MF"),
    "Romário": (["ST!", "CF:90"], "FW"),
    "Hristo Stoichkov": (["LW!", "ST:88", "RW:82"], "FW"),
    # Pre-1970 icons. "Pele" is one of the seed's own diacritic-free spellings;
    # the "Bobby Moore"/"Beckenbauer" keys above already cover their 1966 cards.
    # Both accented and folded spellings are kept — Wikipedia pages flip between
    # the two between re-fetches.
    "Pele": (["CF!", "ST:90", "RW:82"], "FW"),
    "Garrincha": (["RW!", "RM:85", "CF:80"], "FW"),
    "Vava": (["ST!", "CF:88", "LW:80"], "FW"),
    "Vavá": (["ST!", "CF:88", "LW:80"], "FW"),
    "Just Fontaine": (["ST!", "CF:88"], "FW"),
    "Lev Yashin": (["GK!"], "GK"),
    "Didi": (["CM!", "CAM:88", "CDM:85"], "MF"),
    "Zito": (["CM!", "CDM:88"], "MF"),
    "Amarildo": (["RW!", "ST:85"], "FW"),
    "Uwe Seeler": (["ST!", "CF:90"], "FW"),
    "Josef Masopust": (["CAM!", "CM:88"], "MF"),
    "Bobby Charlton": (["CAM!", "CM:88"], "MF"),
    "Ferenc Puskas": (["CAM!", "CF:88", "CM:85"], "MF"),
    "Ferenc Puskás": (["CAM!", "CF:88", "CM:85"], "MF"),
    "Sandor Kocsis": (["ST!", "CF:90"], "FW"),
    "Sándor Kocsis": (["ST!", "CF:90"], "FW"),
    "Nandor Hidegkuti": (["CAM!", "CM:88", "ST:82"], "MF"),
    "Nándor Hidegkuti": (["CAM!", "CM:88", "ST:82"], "MF"),
    "Zoltan Czibor": (["LW!", "ST:85"], "FW"),
    "Zoltán Czibor": (["LW!", "ST:85"], "FW"),
    "Fritz Walter": (["CAM!", "CM:88"], "MF"),
    "Helmut Rahn": (["RW!", "ST:85", "CF:82"], "FW"),
    "Eusebio": (["CF!", "ST:90"], "FW"),
    "Eusébio": (["CF!", "ST:90"], "FW"),
    "Leonidas": (["ST!", "CF:90"], "FW"),
    "Giuseppe Meazza": (["CAM!", "CF:82"], "MF"),
    "Silvio Piola": (["ST!"], "FW"),
    "Matthias Sindelar": (["CAM!", "CF:85"], "MF"),
    "Ademir": (["ST!", "CF:90", "CAM:80"], "FW"),
    "Zizinho": (["CAM!", "CM:88"], "MF"),
    "Juan Schiaffino": (["CAM!", "CF:85"], "MF"),
    "Juan Alberto Schiaffino": (["CAM!", "CF:85"], "MF"),
    # 1930: the first tournament's standout names.
    "Guillermo Stábile": (["ST!", "CF:88"], "FW"),
    "José Nasazzi": (["CB!"], "DF"),
    "Héctor Scarone": (["CAM!", "CF:88"], "MF"),
    "Pedro Cea": (["CAM!", "CM:85"], "MF"),
    "Luis Monti": (["CM!", "CDM:85"], "MF"),
    "José Leandro Andrade": (["CM!", "CDM:88"], "MF"),
}

_ATTR_CLAMP = lambda v: max(30, min(99, v))


def star_override(name: str) -> tuple[list[str], list[int]] | None:
    """(pinned positions, explicit elite attrs) for an iconic player, or None."""
    entry = STAR_OVERRIDES.get(name)
    if entry is None:
        return None
    positions, family = entry
    base = _STAR_ATTRS[family]
    h = stable_id(name)
    attrs = [
        _ATTR_CLAMP(v + ((h >> (i * 2)) % 5) - 2)
        for i, v in enumerate(base)
    ]
    return positions, attrs

REPO = Path(__file__).resolve().parents[2]
DATA_DIR = REPO / "server" / "data"
SEED_DIR = DATA_DIR / "seed"
PHOTO_DIR = DATA_DIR / "photos"
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
PHOTO_SIZE = 96

YEARS = list(range(1930, 2019))
YEARS.remove(1942)
YEARS.remove(1946)


def stable_id(key: str) -> int:
    return int(hashlib.sha1(key.encode()).hexdigest()[:8], 16)


def fetch(url: str) -> str:
    for attempt in range(10):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(min(120.0, 5.0 * (2 ** attempt)))
                continue
            if e.code == 404:
                return ""
            raise
        except Exception:
            time.sleep(min(120.0, 5.0 * (2 ** attempt)))
    raise RuntimeError(f"Failed to fetch {url}")


def cache_path(name: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / name


def _load_cached_json(cpath: Path) -> dict | None:
    """Load JSON from cache, handling potential double-encoded legacy cache."""
    if not cpath.exists():
        return None
    text = cpath.read_text()
    parsed = json.loads(text)
    # Handle legacy double-encoded cache
    if isinstance(parsed, str):
        return json.loads(parsed)
    return parsed


def get_openfootball_full(year: int) -> dict | None:
    """Download worldcup-full.json from openfootball (for lineups)."""
    url = f"{OF_BASE}/{year}/worldcup-full.json"
    cpath = cache_path(f"of_{year}_full.json")
    cached = _load_cached_json(cpath)
    if cached is not None:
        return cached
    time.sleep(_POLITE)
    data = fetch(url)
    if not data:
        return None
    parsed = json.loads(data)
    cpath.write_text(json.dumps(parsed))
    return parsed


def get_openfootball(year: int) -> dict | None:
    """Download worldcup.json from openfootball (for matches/groups)."""
    url = f"{OF_BASE}/{year}/worldcup.json"
    cpath = cache_path(f"of_{year}.json")
    cached = _load_cached_json(cpath)
    if cached is not None:
        return cached
    time.sleep(_POLITE)
    data = fetch(url)
    if not data:
        return None
    parsed = json.loads(data)
    cpath.write_text(json.dumps(parsed))
    return parsed


def get_standings(year: int) -> dict | None:
    url = f"{OF_BASE}/{year}/worldcup.standings.json"
    cpath = cache_path(f"of_{year}_standings.json")
    if cpath.exists():
        return json.loads(cpath.read_text())
    time.sleep(_POLITE)
    data = fetch(url)
    if not data:
        return None
    cpath.write_text(data)
    return json.loads(data)


def get_teams(year: int) -> dict | None:
    url = f"{OF_BASE}/{year}/worldcup.teams.json"
    cpath = cache_path(f"of_{year}_teams.json")
    if cpath.exists():
        return json.loads(cpath.read_text())
    time.sleep(_POLITE)
    data = fetch(url)
    if not data:
        return None
    cpath.write_text(data)
    return json.loads(data)


# ---------------------------------------------------------------------------
# Wikipedia photo fetching (same as 2022/2026 scrapers)
# ---------------------------------------------------------------------------

_PHOTO_CACHE = CACHE_DIR / "pageimages.json"


def load_photo_cache() -> dict:
    if _PHOTO_CACHE.exists():
        try:
            return json.loads(_PHOTO_CACHE.read_text())
        except (OSError, ValueError):
            pass
    return {}


def save_photo_cache(cache: dict) -> None:
    tmp = str(_PHOTO_CACHE) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, _PHOTO_CACHE)


def fetch_photos(cache: dict, titles: list) -> None:
    missing = [t for t in titles if t not in cache]
    for i in range(0, len(missing), 25):
        batch = missing[i:i + 25]
        time.sleep(_POLITE)
        qs = urllib.parse.urlencode({
            "action": "query", "titles": "|".join(batch),
            "prop": "pageimages", "piprop": "thumbnail", "pithumbsize": "320",
            "format": "json", "formatversion": "2"
        })
        data = json.loads(fetch(f"{WIKI_API}?{qs}"))
        for page in data.get("query", {}).get("pages", []):
            if page.get("missing"):
                continue
            title = page.get("title")
            url = page.get("thumbnail", {}).get("source")
            cache.setdefault(title, url)
        save_photo_cache(cache)
    for t in missing:
        cache.setdefault(t, None)


# Position mapper: family-level Wikipedia `pos` → granular like 2022/2026.
POS_MAP = {
    "GK": "GK", "DF": "CB", "CB": "CB", "LB": "LB", "RB": "RB",
    "LWB": "LB", "RWB": "RB", "WB": "RB",
    "MF": "CM", "CM": "CM", "DM": "CDM", "CDM": "CDM", "AM": "CAM", "CAM": "CAM",
    "LM": "LW", "RM": "RW", "LW": "LW", "RW": "RW",
    "FW": "ST", "ST": "ST", "CF": "ST",
}


def map_pos(raw: str) -> str:
    """Map a Wikipedia pos token to a granular position (falls back to CM)."""
    token = raw.strip().upper()
    return POS_MAP.get(token, "CM")


def strip_links(raw: str) -> str:
    def repl(m):
        return m.group(1).split("|")[-1]
    out = re.sub(r"\[\[([^\]]+)\]\]", repl, raw)
    out = out.replace("{{", " ").replace("}}", " ")
    out = re.sub(r"<[^>]+>", "", out)
    return re.sub(r"\s+", " ", out).strip()


def parse_squads_wikipedia(year: int) -> dict[str, list[dict]]:
    """Scrape 'YYYY FIFA World Cup squads' page for player rosters.

    The wikitext is cached under .cache/{year}_FIFA_World_Cup_squads.wiki so a
    failed later stage never forces a re-fetch.
    """
    page = f"{year} FIFA World Cup squads"
    cpath = cache_path(f"{year}_squads.wiki")
    if cpath.exists():
        wt = cpath.read_text(encoding="utf-8")
    else:
        print(f"  fetching {page} ...", file=sys.stderr)
        time.sleep(_POLITE)
        qs = urllib.parse.urlencode({
            "action": "parse", "page": page, "prop": "wikitext",
            "format": "json", "formatversion": "2",
        })
        data = json.loads(fetch(f"{WIKI_API}?{qs}"))
        wt = data["parse"]["wikitext"]
        cpath.write_text(wt, encoding="utf-8")

    squads = {}
    # Find group sections
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
                r"\{\{(?:nat fs g?player|National football squad player)\|([^}]*?)\}\}",
                section[st:en], re.S,
            ):
                fields = dict(
                    (k.strip(), v.strip())
                    for k, v in re.findall(
                        r"(\w+)\s*=\s*(.*?)(?=\|\w+\s*=|$)", pm.group(1), re.S,
                    )
                )
                raw_name = fields.get("name", "")
                link = re.search(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]", raw_name)
                wiki = link.group(1).split("#")[0].replace("_", " ").strip() if link else ""
                name = strip_links(raw_name)
                name = re.sub(r"\s*\(\(?[cC]\)?\)?\s*$", "", name)  # captain mark
                name = name.rstrip("*").rstrip()  # footnote markers
                if not name:
                    continue
                if not wiki:
                    wiki = name
                pos_raw = fields.get("pos", "").upper()
                positions = [map_pos(p) for p in re.split(r"[/,]", pos_raw) if p.strip()]
                no = fields.get("no", "").replace("&nbsp;", "").strip()
                loads.append({
                    "name": name,
                    "positions": positions if positions else ["CM"],
                    "shirt": int(no) if no.isdigit() else None,
                    "wiki": wiki,
                })
            squads[team_name] = loads
    return squads


# ---------------------------------------------------------------------------
# Main ingest
# ---------------------------------------------------------------------------

def normalize_name(name: str) -> str:
    return NAME_OVERRIDES.get(name, name)

def _accent_fold(name: str) -> str:
    return unicodedata.normalize("NFKD", name) \
        .encode("ascii", "ignore").decode("ascii").lower().strip()

def _is_subseq(a: str, b: str) -> bool:
    it = iter(b)
    return all(c in it for c in a)

def _same_player_short_name(a: str, b: str) -> bool:
    """True when a and b are the same player's name under a short-form/nickname
    variant (same surname, and one fold is a strict in-order subsequence of the
    other, e.g. 'leo franco' vs 'leonardo franco')."""
    if a == b:
        return False
    if a.split()[-1] != b.split()[-1]:
        return False
    if len(a) < len(b) and _is_subseq(a, b):
        return True
    if len(b) < len(a) and _is_subseq(b, a):
        return True
    return False

def _dedupe_by_fold(merged: dict[int, dict]) -> dict[int, dict]:
    """Drop duplicate-fold players, keeping the entry with a shirt number /
    wiki backfill over a bare openfootball fallback stub."""
    by_fold: dict[str, int] = {}
    for pid, pl in merged.items():
        fold = _accent_fold(pl["name"])
        if fold not in by_fold:
            by_fold[fold] = pid
            continue
        cur = merged[by_fold[fold]]
        keep = cur
        if (not cur.get("shirt") and pl.get("shirt")) or \
           (cur.get("shirt") == pl.get("shirt") and not cur.get("wiki") and pl.get("wiki")):
            keep = pl
        if keep is not pl:
            by_fold[fold] = pid
    return {pid: merged[pid] for pid in by_fold.values()}


def get_code(name: str) -> str:
    name = normalize_name(name)
    if name in TEAM_CODES:
        return TEAM_CODES[name]
    # Fallback: first 3 letters upper
    return name[:3].upper()


def get_flag(code: str) -> str:
    return FLAG_CODES.get(code, "🏳️")


def get_rating(name: str, year: int | None = None) -> int:
    code = get_code(name)
    if year is not None:
        era = ERA_RATINGS.get(year)
        if era and code in era:
            return era[code]
    return RATINGS.get(code, 60)


def parse_minute(text: str) -> tuple[int, bool]:
    """Parse minute string like '90+1' or '45' -> (minute, extra_time)."""
    if not text:
        return (0, False)
    extra = False
    m = re.search(r"(\d+)(?:\+(\d+))?", text)
    if not m:
        return (0, False)
    minute = int(m.group(1))
    if m.group(2):
        minute += int(m.group(2))
    if minute > 90:
        extra = True
    return (minute, extra)


def parse_booking(item: dict) -> dict | None:
    """Convert openfootball booking to RedCard."""
    if item.get("type") not in ("Y", "R"):
        return None
    return {
        "minute": parse_minute(item.get("minute", "0"))[0],
        "extra_time": parse_minute(item.get("minute", "0"))[1],
        "player": item.get("name", ""),
    }


def build_seed(year: int) -> dict | None:
    print(f"[{year}] fetching openfootball data ...", file=sys.stderr)
    of_data = get_openfootball(year)
    if not of_data:
        print(f"[{year}] NO openfootball data", file=sys.stderr)
        return None

    # Also fetch full data for lineups
    of_full = get_openfootball_full(year)

    # Get standings for group assignments
    standings = get_standings(year)
    of_teams = get_teams(year)

    # Build team list from matches (more complete than teams.json for older years)
    team_names = set()
    for m in of_data.get("matches", []):
        team_names.add(m.get("team1"))
        team_names.add(m.get("team2"))

    # Also check teams.json if available
    if of_teams:
        for t in of_teams.get("teams", []):
            team_names.add(t.get("name"))

    # Also check standings
    if standings:
        for grp in standings.get("standings", []):
            for row in grp.get("rows", []):
                tn = (row.get("team") or {}).get("name")
                if tn:
                    team_names.add(tn)

    # Apply name normalization
    normalized_names = {normalize_name(n) for n in team_names if n}

    # Build team records
    teams = []
    seen_codes = set()
    for name in sorted(normalized_names):
        code = get_code(name)
        if code in seen_codes:
            continue
        seen_codes.add(code)
        teams.append({
            "name": name,
            "code": code,
            "flag": get_flag(code),
            "rating": get_rating(name, year),
            "group": "",  # filled below
        })

    # Assign groups from standings or match data. A team belongs to the group
    # of its earliest group-phase match (base worldcup.json carries `group`),
    # which also cleanly ignores the 1974/78/82 second-round stage.
    group_matches = []
    for m in of_data.get("matches", []):
        grp = m.get("group", "")
        if not grp and "Group" in m.get("round", "") and "Play" not in m.get("round", ""):
            grp = m.get("round", "")
        letter_m = re.search(r"Group\s+([A-Z]|\d+)", grp, re.I)
        if not letter_m:
            continue
        g = letter_m.group(1).upper()
        if g.isdigit():
            g = chr(ord('A') + int(g) - 1)
        group_matches.append((m.get("date", "") or "0000", m.get("team1", ""), m.get("team2", ""), g))

    group_of = {}
    if standings:
        for grp in standings.get("groups", []):
            letter = re.search(r"Group\s+([A-Z])", grp.get("name", ""), re.I)
            if not letter:
                continue
            letter = letter.group(1).upper()
            for row in grp.get("standings", []):
                tn = (row.get("team") or {}).get("name")
                if tn:
                    group_of.setdefault(normalize_name(tn), letter)

    group_matches.sort(key=lambda x: x[0])
    for _dt, t1, t2, g in group_matches:
        group_of.setdefault(normalize_name(t1), g)
        group_of.setdefault(normalize_name(t2), g)

    for t in teams:
        t["group"] = group_of.get(normalize_name(t["name"]), "")

    # Parse matches → real first-stage group fixtures.
    fixtures = []
    group_teams: dict[str, set] = {}
    for m in of_data.get("matches", []):
        round_name = m.get("round", "")
        grp = m.get("group", "")
        if not grp and "Group" in round_name and "Play" not in round_name:
            grp = round_name
        if not grp or "Group" not in grp:
            continue  # only group stage fixtures for now
        letter_m = re.search(r"Group\s+([A-Z]|\d+)", grp, re.I)
        if not letter_m:
            continue
        letter = letter_m.group(1).upper()
        if letter.isdigit():
            letter = chr(ord('A') + int(letter) - 1)
        team1 = normalize_name(m.get("team1", ""))
        team2 = normalize_name(m.get("team2", ""))
        # Skip the second-round group stage (1974/78/82): a team's earliest
        # group is the first-stage letter, so a later stage would not match.
        if group_of.get(team1) != letter or group_of.get(team2) != letter:
            continue
        code1 = get_code(team1)
        code2 = get_code(team2)
        date_str = m.get("date", "")
        time_str = m.get("time", "")
        kickoff = None
        if date_str:
            t_match = re.search(r"(\d{1,2}):(\d{2})", time_str)
            if t_match:
                h = int(t_match.group(1))
                kickoff = f"{date_str}T{h:02d}:{t_match.group(2)}"
            else:
                kickoff = date_str
        fixtures.append({
            "group": letter,
            "match": len(fixtures) + 1,
            "home": code1,
            "away": code2,
            "matchday": 1,  # will be computed below
            "kickoff": kickoff,
        })
        group_teams.setdefault(letter, set()).add(code1)
        group_teams.setdefault(letter, set()).add(code2)

    # Real matchdays: within each group, order by kickoff and chunk into
    # (teams // 2) games per round → 3 rounds of 2 for a 4-team group,
    # 1 game per round for a 3-team group, etc.
    by_group: dict[str, list] = {}
    for f in fixtures:
        by_group.setdefault(f["group"], []).append(f)
    for g, fs in by_group.items():
        per_round = max(1, len(group_teams.get(g, set())) // 2)
        fs.sort(key=lambda f: f["kickoff"] or "")
        for i, f in enumerate(fs):
            f["matchday"] = i // per_round + 1
    fixtures.sort(key=lambda f: (f["group"], f["kickoff"] or "", f["match"]))

    # Parse squads from openfootball-full lineups
    squads_by_team: dict[str, dict[int, dict]] = {}
    if of_full:
        for m in of_full.get("matches", []):
            lineup = m.get("lineup")
            if not lineup:
                continue
            for side_idx, side in enumerate(lineup):
                team_name = normalize_name(m.get("team1" if side_idx == 0 else "team2", ""))
                code = get_code(team_name)
                squad = squads_by_team.setdefault(code, {})
                for starter in side.get("starter", []):
                    name = starter.get("name", "").title()
                    pid = stable_id(name + code)
                    if pid not in squad:
                        squad[pid] = {
                            "name": name,
                            "positions": ["CM"],
                            "shirt": None,
                            "starts": 0,
                            "caps": 0,
                        }
                    squad[pid]["caps"] += 1
                    squad[pid]["starts"] += 1
                for bench in side.get("bench", []):
                    name = bench.get("name", "").title()
                    pid = stable_id(name + code)
                    if pid not in squad:
                        squad[pid] = {
                            "name": name,
                            "positions": ["CM"],
                            "shirt": None,
                            "starts": 0,
                            "caps": 0,
                        }
                    squad[pid]["caps"] += 1
                for sub in side.get("subs", []):
                    name = sub.get("on", "").title()
                    pid = stable_id(name + code)
                    if pid not in squad:
                        squad[pid] = {
                            "name": name,
                            "positions": ["CM"],
                            "shirt": None,
                            "starts": 0,
                            "caps": 0,
                        }
                    squad[pid]["caps"] += 1

    # Merge with Wikipedia squads for positions/shirt numbers/photos
    wiki_squads = parse_squads_wikipedia(year)

    # Photo cache
    photo_cache = load_photo_cache()

    # Match wiki section headers to edition teams by code so display-name
    # differences ("United States" vs "USA", "IR Iran" vs "Iran", ...) never
    # drop a whole roster.
    teams_by_fold = {_accent_fold(t["name"]): t["code"] for t in teams}
    wiki_by_code: dict[str, list[dict]] = {}
    for wtname, roster in wiki_squads.items():
        code = teams_by_fold.get(_accent_fold(wtname)) or get_code(wtname)
        if code:
            wiki_by_code.setdefault(code, []).extend(roster)
        else:
            print(f"  (no code for wiki team '{wtname}', {len(roster)} players dropped)",
                  file=sys.stderr)

    # Build final squads
    squads = {}
    for t in teams:
        code = t["code"]
        of_squad = squads_by_team.get(code, {})
        wiki_roster = wiki_by_code.get(code, [])

        # Merge: prefer Wikipedia for position/shirt, OF for existence
        merged: dict[int, dict] = {}
        for pid, pl in of_squad.items():
            merged[pid] = {
                "name": pl["name"],
                "positions": pl["positions"],
                "shirt": None,
                "sofa_id": pid,
                "_caps": pl.get("caps", 0),
                "_wiki": False,
                "_order": 1 << 30,
            }

        # Match wiki players to OF players ignoring accents/case so near-dup
        # spellings ("Cristian Pavon" / "Cristian Pavón") collide. When the full
        # name isn't an exact fold match, fall back to a same-surname strict
        # subsequence test: openfootball lists many subs by surname/nickname
        # ("Juan Riquelme" vs "Juan Román Riquelme", "Leo Franco" vs
        # "Leonardo Franco").
        of_by_fold = {_accent_fold(pl["name"]): pid for pid, pl in merged.items()}
        matched_pids: set[int] = set()
        for order, wp in enumerate(wiki_roster):
            wfold = _accent_fold(wp["name"])
            match_pid = of_by_fold.get(wfold)
            if match_pid is None:
                for opid, pl in merged.items():
                    if opid in matched_pids:
                        continue
                    ofold = _accent_fold(pl["name"])
                    if _same_player_short_name(ofold, wfold):
                        match_pid = opid
                        break
            if match_pid is not None:
                matched_pids.add(match_pid)
                merged[match_pid]["positions"] = wp["positions"]
                merged[match_pid]["shirt"] = wp["shirt"]
                merged[match_pid]["wiki"] = wp["wiki"]
                merged[match_pid]["name"] = wp["name"]
                merged[match_pid]["_wiki"] = True
                merged[match_pid]["_order"] = order
            else:
                # New player only in Wikipedia
                npid = stable_id(wp["name"] + code)
                merged[npid] = {
                    "name": wp["name"],
                    "positions": wp["positions"],
                    "shirt": wp["shirt"],
                    "wiki": wp["wiki"],
                    "_caps": 0,
                    "_wiki": True,
                    "_order": order,
                }

        # Drop duplicate-fold leftovers (prefer the entry carrying a shirt/A wiki).
        merged = _dedupe_by_fold(merged)

        # Normalize every squad to the edition's uniform official size: keep the
        # Wikipedia squad (the real pre-tournament squad) and pad any short team
        # with the openfootball players who actually appeared, most-used first.
        # Wikipedia pages list the official pre-tournament squad (22 for
        # 1982–1994, 23 from 1998 on); pad any short team with the openfootball
        # players who actually appeared, most-used first.
        target = 22 if year <= 1994 else 23
        official = sorted(
            (pl for pl in merged.values() if pl.get("_wiki")),
            key=lambda r: r["_order"],
        )[:target]
        extras = sorted(
            (pl for pl in merged.values() if not pl.get("_wiki")),
            key=lambda r: r["_caps"],
            reverse=True,
        )
        normalized = official + extras[: max(0, target - len(official))]

        # Resolve photos
        all_titles = sorted({pl.get("wiki") for pl in normalized if pl.get("wiki")})
        fetch_photos(photo_cache, all_titles)
        save_photo_cache(photo_cache)

        final_roster = []
        for pl in normalized:
            pl_copy = {k: v for k, v in pl.items()
                       if k not in ("wiki", "sofa_id", "_caps", "_wiki", "_order")}
            pl_copy["photo"] = photo_cache.get(pl.get("wiki"))
            star = star_override(pl["name"])
            if star is not None:
                pl_copy["positions"], pl_copy["attrs"] = star
            final_roster.append(pl_copy)

        final_roster.sort(key=lambda r: r["name"])
        squads[code] = final_roster

    return {
        "year": year,
        "name": f"{year} FIFA World Cup",
        "host": HOSTS.get(year, of_data.get("name", "").replace("World Cup ", "")),
        "teams": teams,
        "squads": squads,
        "fixtures": fixtures,
    }


def main() -> int:
    SEED_DIR.mkdir(parents=True, exist_ok=True)
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)

    for year in YEARS:
        dest = SEED_DIR / f"{year}.json"
        if dest.exists():
            print(f"[{year}] seed exists, skipping", file=sys.stderr)
            continue
        try:
            seed = build_seed(year)
            if not seed:
                print(f"[{year}] FAILED", file=sys.stderr)
                continue
            dest.write_text(json.dumps(seed, ensure_ascii=False, indent=1))
            nplayers = sum(len(v) for v in seed["squads"].values())
            nphotos = sum(1 for v in seed["squads"].values() for pl in v if pl.get("photo"))
            print(f"[{year}] wrote {dest}: {len(seed['teams'])} teams, {nplayers} players ({nphotos} photos), {len(seed['fixtures'])} fixtures", file=sys.stderr)
        except Exception as exc:
            print(f"[{year}] ERROR: {exc}", file=sys.stderr)
            import traceback
            traceback.print_exc()
    return 0


if __name__ == "__main__":
    sys.exit(main())