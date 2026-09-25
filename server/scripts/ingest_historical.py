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

# Strength ratings by team code (FIFA ranking–inspired fallback). Every team
# of every edition is defined explicitly in ERA_RATINGS below; this table only
# catches leftovers a seed may carry (e.g. Gepl franchise / alternate spellings)
# and must never out-rate a real edition team, so the values are conservative.
RATINGS = {
    "BRA": 86, "ARG": 85, "FRA": 85, "GER": 84, "ESP": 84, "ITA": 83,
    "ENG": 82, "NED": 82, "URU": 80, "POR": 81, "BEL": 80, "CRO": 79,
    "COL": 78, "CHI": 77, "MEX": 76, "USA": 76, "SWE": 74, "POL": 74,
    "SRB": 75, "SER": 75, "CZE": 76, "SUI": 76, "DEN": 77, "RUS": 75,
    "TCH": 74, "YUG": 74, "URS": 78, "FRG": 84, "GDR": 74, "IRL": 72,
    "NOR": 73, "ROU": 75, "BUL": 74, "AUT": 72, "SCO": 72, "HUN": 72,
    "NIR": 70, "WAL": 71, "GRE": 72, "KSA": 66, "IRN": 68, "KOR": 70,
    "JPN": 72, "AUS": 70, "NGA": 73, "CIV": 73, "GHA": 73, "CMR": 71,
    "ALG": 71, "MAR": 72, "TUN": 68, "EGY": 69, "SEN": 73, "ECU": 72,
    "PAR": 73, "BOL": 66, "PER": 72, "CRC": 70, "JAM": 67, "TRI": 66,
    "HAI": 62, "ZAI": 60, "SLV": 62, "KUW": 60, "IRQ": 60, "NZL": 61,
    "CHN": 64, "UAE": 63, "PRK": 64, "SVN": 70, "SVK": 72, "BIH": 73,
    "ISL": 66, "PAN": 64, "CAN": 68, "MNE": 66, "QAT": 66,
}

# Per-edition strength. ICT STS 1930–1966 are the eye-tests of the era (Hungary
# 1954, Uruguay 1950, the "Wunderteam", Pelé's Brazil); from 1970 on they track
# real tournament form — champions 88–90, losing finalists/semis 86–88, clear
# contenders 84–85, solid sides 80–83, qualifiers 76–79, minnows/Dark horses 74
# and below. A team never carries the modern flat "ARG 93" — every edition is
# its own balance sheet. (Defaults via the RATINGS fallback are intentionally
# tame so a stale 90+ never leaks into a year that under-achieved.)
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
    1970: {"BRA": 91, "ITA": 88, "FRG": 87, "ENG": 86, "URS": 84, "URU": 83,
           "MEX": 82, "PER": 81, "SWE": 79, "ROU": 77, "TCH": 77, "BUL": 77,
           "BEL": 74, "ISR": 68, "MAR": 63, "SLV": 59},
    1974: {"FRG": 90, "NED": 90, "POL": 85, "BRA": 84, "ITA": 84, "ARG": 83,
           "SCO": 80, "URU": 80, "GDR": 79, "SWE": 79, "YUG": 79, "TCH": 78,
           "BUL": 77, "AUS": 64, "HAI": 60, "ZAI": 58},
    1978: {"ARG": 87, "NED": 87, "BRA": 87, "FRG": 85, "ITA": 84, "PER": 82,
           "POL": 81, "AUT": 81, "SCO": 79, "ESP": 79, "FRA": 79, "SWE": 78,
           "TUN": 74, "MEX": 72, "HUN": 71, "IRN": 64},
    1982: {"BRA": 89, "ITA": 88, "FRG": 86, "ARG": 85, "FRA": 84, "POL": 82,
           "URS": 82, "ESP": 82, "BEL": 81, "ENG": 80, "AUT": 79, "ALG": 77,
           "HUN": 78, "TCH": 77, "SCO": 77, "NIR": 76, "YUG": 76, "CMR": 76,
           "HON": 73, "NZL": 72, "CHI": 71, "KUW": 61, "PER": 74, "SLV": 60},
    1986: {"ARG": 88, "FRA": 87, "BRA": 86, "FRG": 85, "URS": 84, "ITA": 84,
           "DEN": 83, "ENG": 82, "MEX": 81, "ESP": 81, "BEL": 80, "POL": 79,
           "MAR": 77, "URU": 77, "POR": 76, "BUL": 76, "PAR": 75, "SCO": 74,
           "HUN": 73, "NIR": 72, "KOR": 70, "ALG": 69, "CAN": 62, "IRQ": 60},
    1990: {"FRG": 90, "ITA": 88, "NED": 87, "ENG": 86, "ARG": 84, "BRA": 84,
           "URS": 82, "YUG": 82, "TCH": 80, "ESP": 80, "CMR": 79, "BEL": 78,
           "COL": 79, "ROU": 77, "IRL": 76, "SWE": 76, "AUT": 76, "SCO": 74,
           "KOR": 73, "CRC": 69, "USA": 73, "EGY": 69, "UAE": 64, "GER": 84},
    1994: {"BRA": 89, "ITA": 89, "NED": 86, "SWE": 86, "ARG": 85, "GER": 85,
           "BUL": 84, "ROU": 82, "ESP": 82, "MEX": 80, "MAR": 80, "NGA": 79,
           "COL": 78, "BEL": 77, "NOR": 77, "IRL": 77, "RUS": 76, "CMR": 74,
           "GRE": 72, "KOR": 72, "SUI": 76, "USA": 74, "BOL": 68, "KSA": 67},
    1998: {"BRA": 90, "FRA": 89, "NED": 88, "ITA": 87, "ARG": 87, "CRO": 85,
           "ENG": 85, "GER": 84, "ESP": 83, "DEN": 82, "YUG": 80, "PAR": 79,
           "BEL": 79, "ROU": 79, "MEX": 78, "NGA": 79, "COL": 77, "NOR": 77,
           "AUT": 76, "CHI": 77, "SCO": 75, "BUL": 73, "CMR": 73, "TUN": 69,
           "USA": 73, "JPN": 72, "KOR": 72, "RSA": 70, "IRN": 70, "JAM": 67,
           "MAR": 74, "KSA": 66},
    2002: {"BRA": 90, "GER": 87, "ITA": 86, "ENG": 85, "ESP": 85, "ARG": 85,
           "FRA": 84, "POR": 84, "CRO": 83, "TUR": 84, "DEN": 82, "SWE": 81,
           "SEN": 80, "KOR": 80, "URU": 80, "MEX": 79, "PAR": 79, "NGA": 79,
           "BEL": 79, "IRL": 77, "JPN": 78, "USA": 78, "CMR": 78, "CRC": 77,
           "ECU": 75, "POL": 74, "RSA": 73, "SVN": 74, "TUN": 69, "CHN": 66,
           "KSA": 65},
    2006: {"BRA": 89, "ITA": 89, "FRA": 87, "ARG": 86, "ENG": 86, "NED": 85,
           "POR": 85, "CZE": 84, "GER": 83, "ESP": 83, "UKR": 81, "SWE": 80,
           "CRO": 80, "SUI": 79, "GHA": 79, "ECU": 77, "PAR": 77, "MEX": 78,
           "CIV": 77, "POL": 76, "SCO": 74, "AUS": 74, "USA": 74, "CRC": 73,
           "JPN": 73, "KOR": 73, "SER": 75, "TUN": 68, "IRN": 66, "KSA": 66,
           "TRI": 66, "ANG": 62, "TOG": 61},
    2010: {"ESP": 90, "BRA": 88, "NED": 88, "ARG": 87, "GER": 87, "ITA": 85,
           "ENG": 85, "URU": 84, "POR": 84, "FRA": 83, "CHI": 80, "MEX": 79,
           "PAR": 78, "USA": 77, "CIV": 77, "GHA": 77, "JPN": 77, "KOR": 76,
           "DEN": 76, "SRB": 76, "SER": 76, "SWE": 75, "SVK": 75, "SVN": 75,
           "RSA": 74, "AUS": 74, "NGA": 74, "GRE": 74, "SUI": 75, "ALG": 72,
           "HON": 71, "PRK": 62, "NZL": 60},
    2014: {"GER": 89, "BRA": 87, "ARG": 87, "NED": 87, "FRA": 86, "BEL": 86,
           "COL": 84, "ESP": 84, "POR": 84, "ITA": 84, "URU": 83, "CHI": 82,
           "ENG": 82, "MEX": 79, "CRO": 78, "RUS": 78, "SUI": 78, "CIV": 77,
           "BIH": 78, "USA": 77, "CRC": 76, "ECU": 76, "GRE": 76, "NGA": 76,
           "GHA": 75, "ALG": 75, "HON": 72, "AUS": 72, "JPN": 75, "KOR": 75,
           "IRN": 71, "CMR": 69},
    2018: {"FRA": 88, "BRA": 88, "BEL": 87, "CRO": 86, "ENG": 85, "ARG": 86,
           "ESP": 85, "POR": 85, "URU": 85, "GER": 84, "COL": 82, "DEN": 81,
           "SWE": 81, "SUI": 80, "SEN": 78, "MEX": 78, "JPN": 78, "RUS": 75,
           "MAR": 76, "NGA": 75, "PER": 76, "POL": 74, "SER": 75, "AUS": 71,
           "IRN": 71, "CRC": 70, "ISL": 69, "EGY": 70, "TUN": 67, "KOR": 73,
           "PAN": 65, "KSA": 62},
    2022: {"ARG": 87, "FRA": 87, "BRA": 86, "ENG": 86, "ESP": 85, "NED": 84,
           "POR": 84, "CRO": 83, "MAR": 83, "URU": 82, "BEL": 82, "GER": 81,
           "DEN": 79, "SEN": 79, "SUI": 78, "JPN": 78, "USA": 77,
           "KOR": 76, "MEX": 75, "POL": 76, "ECU": 75, "GHA": 75, "AUS": 74,
           "CAN": 73, "IRN": 72, "TUN": 70, "CRC": 71, "WAL": 71, "KSA": 71,
           "QAT": 68, "CMR": 72, "SRB": 76, "SER": 76},
}

# ---------------------------------------------------------------------------
# Iconic players: elite attrs + a pinned, iconic primary role so the greats
# play their real position and read the intended star rating instead of a
# name-hash roll (which once handed shelf players 97–99 while Messi drew 86).
# Positions follow the game's granular tokens (GK/CB/LB/RB/CDM/CM/CAM/LM/RM/
# LW/RW/ST/CF); a trailing "!" pins the card exactly (no auto-enrichment),
# "POS:85" familiarities let the engine use them off that role.
#
# Keys are accent-folded names (matching is case/accent-insensitive). A key
# prefixed "CODE|" (e.g. "BRA|ronaldo") only matches that team's player.
# (+value, [positions], family) — attrs are scaled so the player's star rating
# equals `value` for the pinned role, then year overrides tune the classic
# careers (Pelé 58→70, Maradona 82/86→90, Baggio 90/94/98, ...).
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

# Attribute weights per granular position — a faithful replica of
# server/src/attrs.rs (index order: pace stamina strength dribbling passing
# shooting tackling vision positioning composure reflexes handling kicking
# aerial decisions aggression concentration leadership 0..17).
_POS_WEIGHTS = {
    "GK": [(10, .22), (11, .18), (13, .15), (8, .20), (9, .25), (14, .05), (16, .06), (17, .04)],
    "CB": [(6, .30), (8, .20), (2, .20), (0, .10), (9, .10), (4, .10), (14, .06), (15, .05), (16, .07), (17, .04)],
    "LB": [(1, .20), (0, .20), (6, .20), (8, .15), (4, .15), (3, .10), (14, .05), (15, .04), (16, .06)],
    "RB": [(1, .20), (0, .20), (6, .20), (8, .15), (4, .15), (3, .10), (14, .05), (15, .04), (16, .06)],
    "CDM": [(6, .28), (4, .20), (8, .20), (1, .12), (9, .12), (7, .08), (14, .06), (15, .07), (16, .06), (17, .05)],
    "CM": [(4, .30), (7, .20), (1, .15), (9, .15), (3, .10), (6, .10), (14, .07), (16, .05), (17, .05)],
    "CAM": [(4, .25), (7, .25), (3, .20), (9, .15), (1, .15), (14, .07), (16, .05)],
    "LM": [(0, .20), (3, .20), (4, .20), (1, .15), (7, .15), (5, .10), (14, .05), (16, .05)],
    "RM": [(0, .20), (3, .20), (4, .20), (1, .15), (7, .15), (5, .10), (14, .05), (16, .05)],
    "LW": [(0, .25), (3, .25), (5, .20), (4, .10), (9, .10), (7, .10), (14, .04), (16, .04)],
    "RW": [(0, .25), (3, .25), (5, .20), (4, .10), (9, .10), (7, .10), (14, .04), (16, .04)],
    "ST": [(5, .30), (0, .20), (3, .15), (8, .15), (2, .10), (9, .10), (14, .07), (16, .05), (17, .03)],
    "CF": [(5, .30), (0, .20), (3, .15), (8, .15), (2, .10), (9, .10), (14, .07), (16, .05), (17, .03)],
}
_GK_MEAN_IDX = [10, 11, 12, 8, 9, 13, 2, 0, 14, 16, 17]  # star uses a plain mean
# Keepers read a bit below outfielders (mirrors attrs.rs GK_DAMP) so GKs don't
# out-star the world's best attackers; the icon solver compensates, so a pin
# of 88 stays a visible 88.
GK_DAMP = 3.0


def _composite_rating(position: str, attrs: list[int]) -> float:
    if position == "GK":
        return sum(attrs[i] for i in _GK_MEAN_IDX) / len(_GK_MEAN_IDX) - GK_DAMP
    weights = _POS_WEIGHTS.get(position, [(4, .4), (7, .3), (9, .3), (14, .1), (16, .1), (17, .1)])
    num = sum(v * w for v, w in ((attrs[i], w) for i, w in weights))
    den = sum(w for _, w in weights)
    return num / den if den else 60.0


def _star_rating(position: str, attrs: list[int]) -> int:
    avg = (sum(attrs[i] for i in _GK_MEAN_IDX) / len(_GK_MEAN_IDX) - GK_DAMP) \
        if position == "GK" else _composite_rating(position, attrs)
    return max(55, min(98, int(avg + 0.5)))


def _primary_pos(position_tokens: list[str]) -> str:
    """Position used for the rating math = the pinned primary token."""
    for tok in position_tokens:
        base = tok.split(":")[0].rstrip("!")
        if tok.endswith("!"):
            return base
    return position_tokens[0].split(":")[0].rstrip("!")


# key -> (overall, [pinned positions], family)
PLAYER_RATINGS = {
    # --- 1930 (Montevideo) ---
    "guillermo stabile": (92, ["ST!", "CF:88"], "FW"),
    "jose nasazzi": (90, ["CB!"], "DF"),
    "hector scarone": (92, ["CAM!", "CF:88"], "MF"),
    "pedro cea": (87, ["CAM!", "CM:85"], "MF"),
    "luis monti": (88, ["CM!", "CDM:85"], "MF"),
    "jose leandro andrade": (88, ["CM!", "CDM:88"], "MF"),
    "hector castro": (87, ["ST!", "CF:88"], "FW"),
    # --- 1934 (Italy) ---
    "giuseppe meazza": (94, ["CAM!", "CF:85"], "MF"),
    "angelo schiavio": (90, ["ST!", "CF:88"], "FW"),
    "giovanni ferrari": (87, ["CAM!", "CM:88"], "MF"),
    "giampiero combi": (87, ["GK!"], "GK"),
    "matthias sindelar": (93, ["CAM!", "CF:88"], "MF"),
    "oldrich nejedly": (91, ["ST!", "CF:88"], "FW"),
    "frantisek planicka": (88, ["GK!"], "GK"),
    # --- 1938 (France) ---
    "silvio piola": (93, ["ST!", "CF:88"], "FW"),
    "gyula zsengeller": (88, ["ST!", "CF:85"], "FW"),
    "gyorgy sarosi": (89, ["ST!", "CAM:85"], "FW"),
    "leonidas": (93, ["ST!", "CF:88"], "FW"),
    # --- 1950 (Brazil) ---
    "zizinho": (92, ["CAM!", "CM:88"], "MF"),
    "ademir": (92, ["ST!", "CF:90", "CAM:80"], "FW"),
    "jair da rosa pinto": (87, ["CAM!", "LW:85"], "MF"),
    "juan alberto schiaffino": (92, ["CAM!", "CF:88"], "MF"),
    "alcides ghiggia": (90, ["RW!", "RM:85"], "FW"),
    "obdulio varela": (89, ["CM!", "CDM:85"], "MF"),
    # --- 1954 (Switzerland) ---
    "ferenc puskas": (94, ["CAM!", "CF:88", "CM:85"], "MF"),
    "sandor kocsis": (93, ["ST!", "CF:90"], "FW"),
    "zoltan czibor": (90, ["LW!", "ST:88"], "FW"),
    "nandor hidegkuti": (88, ["CAM!", "CM:88", "ST:82"], "MF"),
    "jozsef bozsik": (87, ["CM!", "CAM:85"], "MF"),
    "fritz walter": (90, ["CAM!", "CM:88"], "MF"),
    "ottmar walter": (87, ["ST!", "CF:85"], "FW"),
    "helmut rahn": (88, ["RW!", "ST:85", "CF:82"], "FW"),
    "max morlock": (86, ["ST!", "CF:85"], "FW"),
    "hans schafer": (87, ["LW!", "CM:85"], "FW"),
    "jose santamaria": (89, ["CB!"], "DF"),
    # --- 1958 (Sweden) ---
    "pele": (94, ["CF!", "ST:90", "RW:85"], "FW"),
    "garrincha": (93, ["RW!", "RM:85", "CF:80"], "FW"),
    "vava": (89, ["ST!", "CF:88", "LW:82"], "FW"),
    "didi": (90, ["CM!", "CAM:88", "CDM:85"], "MF"),
    "zito": (86, ["CM!", "CDM:88"], "MF"),
    "nilton santos": (88, ["LB!", "CB:85"], "DF"),
    "djalma santos": (88, ["RB!"], "DF"),
    "just fontaine": (91, ["ST!", "CF:88"], "FW"),
    "raymond kopa": (90, ["CAM!", "CM:85"], "MF"),
    "lev yashin": (89, ["GK!"], "GK"),
    "igor netto": (85, ["CM!"], "MF"),
    "uwe seeler": (90, ["ST!", "CF:90"], "FW"),
    # --- 1962 (Chile) ---
    "amarildo": (87, ["RW!", "ST:85"], "FW"),
    "josef masopust": (90, ["CAM!", "CM:88"], "MF"),
    "viktor ponedelnik": (87, ["ST!"], "FW"),
    # --- 1966 (England) ---
    "bobby charlton": (90, ["CAM!", "CM:88"], "MF"),
    "bobby moore": (91, ["CB!"], "DF"),
    "gordon banks": (88, ["GK!"], "GK"),
    "geoff hurst": (88, ["CF!", "ST:88"], "FW"),
    "martin peters": (86, ["CM!", "CAM:85"], "MF"),
    "eusebio": (93, ["CF!", "ST:90"], "FW"),
    "helmut haller": (86, ["ST!", "CAM:85"], "FW"),
    "franz beckenbauer": (93, ["CB!", "CDM:85"], "DF"),
    # --- 1970 (Mexico) ---
    "jairzinho": (92, ["RW!", "RM:85", "ST:82"], "FW"),
    "gerson": (90, ["CM!", "CAM:88"], "MF"),
    "tostao": (91, ["CF!", "ST:90"], "FW"),
    "carlos alberto": (91, ["RB!"], "DF"),
    "clodoaldo": (86, ["CM!"], "MF"),
    "gerd muller": (93, ["ST!", "CF:90"], "FW"),
    "wolfgang overath": (88, ["CM!", "CAM:85"], "MF"),
    "sepp maier": (88, ["GK!"], "GK"),
    "giacinto facchetti": (90, ["LB!", "CB:88"], "DF"),
    "gianni rivera": (92, ["CAM!", "CM:85"], "MF"),
    "gigi riva": (91, ["ST!", "LW:85"], "FW"),
    "sandro mazzola": (87, ["CAM!", "ST:85"], "MF"),
    # --- 1974 (West Germany) ---
    "johan cruyff": (96, ["CF!", "ST:90", "LW:82"], "FW"),
    "johan neeskens": (90, ["CM!", "CDM:90"], "MF"),
    "paul breitner": (89, ["LB!", "CDM:85"], "DF"),
    "grzegorz lato": (87, ["RW!", "ST:85"], "FW"),
    "kazimierz deyna": (87, ["CAM!", "CM:85"], "MF"),
    # --- 1978 (Argentina) ---
    "mario kempes": (91, ["ST!", "CF:90"], "FW"),
    "daniel passarella": (90, ["CB!", "CDM:85"], "DF"),
    "osvaldo ardiles": (87, ["CM!", "CAM:85"], "MF"),
    "leopoldo luque": (85, ["ST!", "CF:85"], "FW"),
    "rene houseman": (84, ["RW!", "ST:82"], "FW"),
    "rob rensenbrink": (90, ["LW!", "ST:85", "CF:82"], "FW"),
    "zico": (92, ["CAM!", "CF:85", "CM:85"], "MF"),
    "toninho cerezo": (87, ["CM!", "CDM:88"], "MF"),
    "dirceu": (86, ["CAM!", "CM:85"], "MF"),
    "michel platini": (90, ["CAM!", "CM:88"], "MF"),
    # --- 1982 (Spain) ---
    "diego maradona": (95, ["CAM!", "CM:85", "CF:80"], "MF"),
    "socrates": (92, ["CAM!", "CM:88"], "MF"),
    "falcao": (91, ["CM!", "CDM:90"], "MF"),
    "eder": (88, ["LM!", "ST:85"], "FW"),
    "alain giresse": (88, ["CM!", "CAM:88"], "MF"),
    "jean tigana": (88, ["CM!"], "MF"),
    "maxime bossis": (87, ["CB!"], "DF"),
    "paolo rossi": (90, ["ST!", "CF:88"], "FW"),
    "bruno conti": (87, ["RM!", "RW:85"], "MF"),
    "marco tardelli": (87, ["CM!"], "MF"),
    "karl-heinz rummenigge": (89, ["RW!", "ST:85", "CF:82"], "FW"),
    "zbigniew boniek": (88, ["CAM!", "RW:85"], "MF"),
    # --- 1986 (Mexico) ---
    "jorge burruchaga": (87, ["CAM!", "CM:85"], "MF"),
    "preben elkjr": (87, ["ST!", "CF:88"], "FW"),
    "michael laudrup": (88, ["CAM!", "LW:85"], "MF"),
    "emilio butragueno": (88, ["CF!", "ST:88"], "FW"),
    "igor belanov": (87, ["ST!", "RW:85"], "FW"),
    "careca": (88, ["ST!", "CF:88"], "FW"),
    "gary lineker": (87, ["ST!", "CF:88"], "FW"),
    "lothar matthaus": (89, ["CM!", "CDM:90", "CAM:85"], "MF"),
    # --- 1990 (Italy) ---
    "jurgen klinsmann": (87, ["ST!", "CF:88"], "FW"),
    "rudi voller": (86, ["ST!"], "FW"),
    "andreas brehme": (88, ["LB!"], "DF"),
    "claudio caniggia": (88, ["ST!", "RW:85"], "FW"),
    "sergio goycochea": (84, ["GK!"], "GK"),
    "salvatore schillaci": (88, ["ST!"], "FW"),
    "roberto baggio": (90, ["CAM!", "CF:88", "ST:82"], "MF"),
    "franco baresi": (91, ["CB!"], "DF"),
    "ruud gullit": (90, ["CAM!", "CF:85"], "MF"),
    "marco van basten": (92, ["ST!", "CF:90"], "FW"),
    "frank rijkaard": (88, ["CDM!", "CB:85"], "DF"),
    "paul gascoigne": (87, ["CAM!", "CM:85"], "MF"),
    "dragan stojkovic": (87, ["CAM!", "RM:85"], "MF"),
    "tomas skuhravy": (86, ["ST!"], "FW"),
    "enzo scifo": (86, ["CAM!", "CM:85"], "MF"),
    "roger milla": (84, ["ST!", "CF:85"], "FW"),
    "carlos valderrama": (87, ["CAM!"], "MF"),
    # --- 1994 (USA) ---
    "romario": (93, ["ST!", "CF:90"], "FW"),
    "bebeto": (90, ["ST!", "CF:88"], "FW"),
    "claudio taffarel": (84, ["GK!"], "GK"),
    "paolo maldini": (92, ["LB!", "CB:90"], "DF"),
    "hristo stoichkov": (92, ["LW!", "ST:88", "RW:82"], "FW"),
    "gheorghe hagi": (89, ["CAM!", "LW:80", "CM:85"], "MF"),
    "dennis bergkamp": (89, ["CF!", "CAM:88"], "FW"),
    "faustino asprilla": (85, ["ST!", "RW:85"], "FW"),
    # --- 1998 (France) ---
    "BRA|ronaldo": (94, ["ST!", "CF:90"], "FW"),
    "rivaldo": (91, ["CAM!", "LW:88", "CM:85"], "MF"),
    "zinedine zidane": (94, ["CAM!", "CM:90"], "MF"),
    "gabriel batistuta": (90, ["ST!"], "FW"),
    "michael owen": (86, ["ST!"], "FW"),
    "marcelo salas": (87, ["ST!"], "FW"),
    "raul": (88, ["ST!", "CF:88", "LW:85"], "FW"),
    # --- 2002 (South Korea / Japan) ---
    "ronaldinho": (89, ["CAM!", "LW:85"], "MF"),
    "oliver kahn": (87, ["GK!"], "GK"),
    "michael ballack": (89, ["CM!", "CAM:88"], "MF"),
    "luis figo": (90, ["RW!", "CAM:85"], "MF"),
    "david beckham": (88, ["RM!"], "MF"),
    "francesco totti": (89, ["CAM!", "CF:85"], "MF"),
    "christian vieri": (89, ["ST!"], "FW"),
    "paul scholes": (89, ["CM!", "CAM:88"], "MF"),
    # --- 2006 (Germany) ---
    "thierry henry": (91, ["CF!", "ST:88"], "FW"),
    "fabio cannavaro": (90, ["CB!"], "DF"),
    "gianluigi buffon": (88, ["GK!"], "GK"),
    "andrea pirlo": (88, ["CM!", "CAM:88"], "MF"),
    "pavel nedved": (89, ["CAM!", "LM:88"], "MF"),
    "cristiano ronaldo": (90, ["RW!", "LW:88"], "FW"),
    "lionel messi": (94, ["RW!", "CF:92", "ST:88"], "FW"),
    "frank lampard": (88, ["CM!", "CAM:88"], "MF"),
    "steven gerrard": (89, ["CM!", "CAM:85"], "MF"),
    "sergio ramos": (88, ["CB!"], "DF"),
    "samuel eto'o": (88, ["ST!"], "FW"),
    "didier drogba": (88, ["ST!"], "FW"),
    "miloslav klose": (87, ["ST!"], "FW"),
    "kaka": (88, ["CAM!"], "MF"),
    # --- 2010 (South Africa) ---
    "andres iniesta": (91, ["CM!", "CAM:88"], "MF"),
    "xavi": (91, ["CM!", "CAM:88"], "MF"),
    "iker casillas": (88, ["GK!"], "GK"),
    "david villa": (89, ["ST!", "CF:88"], "FW"),
    "wesley sneijder": (88, ["CAM!", "CM:85"], "MF"),
    "arjen robben": (89, ["RW!", "LW:88"], "FW"),
    "robin van persie": (87, ["ST!", "CF:88"], "FW"),
    "thomas muller": (86, ["CAM!", "ST:85"], "MF"),
    "diego forlan": (86, ["ST!", "CF:88"], "FW"),
    "carles puyol": (88, ["CB!"], "DF"),
    # --- 2014 (Brazil) ---
    "manuel neuer": (88, ["GK!"], "GK"),
    "neymar": (89, ["RW!", "LW:88"], "FW"),
    "james rodriguez": (88, ["CAM!", "RW:85"], "MF"),
    "philipp lahm": (87, ["RB!"], "DF"),
    "luis suarez": (89, ["ST!", "CF:88"], "FW"),
    # --- 2018 (Russia) ---
    "kylian mbappe": (90, ["RW!", "ST:88"], "FW"),
    "antoine griezmann": (89, ["CAM!", "ST:88", "CF:88"], "MF"),
    "luka modric": (90, ["CM!", "CAM:88"], "MF"),
    "eden hazard": (89, ["LM!", "LW:88"], "MF"),
    "harry kane": (88, ["ST!"], "FW"),
    "kevin de bruyne": (90, ["CAM!", "CM:88"], "MF"),
    "thibaut courtois": (85, ["GK!"], "GK"),
    "toni kroos": (88, ["CM!"], "MF"),
    "mohamed salah": (88, ["RW!"], "FW"),
    "edinson cavani": (87, ["ST!"], "FW"),
    "diego godin": (86, ["CB!"], "DF"),
    # --- 2022 (Qatar) ---
    "angel di maria": (87, ["RM!", "RW:88", "LW:85"], "MF"),
    "vinicius junior": (87, ["LW!", "RW:85"], "FW"),
}

# Per-year overall tweaks: key -> {edition: overall}
PLAYER_YEAR_OVERRIDES = {
    "lev yashin": {1962: 92, 1966: 91},
    "pele": {1962: 93, 1966: 90, 1970: 96},
    "garrincha": {1962: 94, 1966: 87},
    "uwe seeler": {1966: 90, 1970: 89},
    "bobby charlton": {1970: 89},
    "bobby moore": {1970: 91},
    "franz beckenbauer": {1970: 94, 1974: 95},
    "gerd muller": {1974: 92},
    "johan neeskens": {1978: 88},
    "zico": {1982: 94, 1986: 89},
    "michel platini": {1982: 93, 1986: 92},
    "diego maradona": {1986: 96, 1990: 92, 1994: 84},
    "karl-heinz rummenigge": {1986: 88},
    "alain giresse": {1986: 87},
    "jean tigana": {1986: 87},
    "socrates": {1986: 88},
    "gary lineker": {1990: 86},
    "josef masopust": {1962: 90},
    "lothar matthaus": {1990: 92, 1994: 87},
    "jurgen klinsmann": {1994: 88},
    "franco baresi": {1982: 85, 1994: 90},
    "carlos valderrama": {1994: 86},
    "roberto baggio": {1994: 95, 1998: 90},
    "BRA|ronaldo": {1994: 85, 2002: 94, 2006: 90},
    "rivaldo": {2002: 92},
    "zinedine zidane": {2006: 92},
    "ronaldinho": {2006: 90},
    "francesco totti": {2006: 88},
    "raul": {2006: 87},
    "miloslav klose": {2014: 86},
    "lionel messi": {2006: 91, 2010: 95, 2014: 95, 2018: 94, 2022: 96, 2026: 92},
    "cristiano ronaldo": {2010: 89, 2014: 90, 2018: 88, 2022: 86},
    "neymar": {2018: 89, 2022: 87},
    "luka modric": {2022: 89},
    "kylian mbappe": {2022: 91},
    "harry kane": {2022: 88},
    "angel di maria": {2022: 88},
    "vava": {1962: 89},
    "didi": {1962: 89},
    "zito": {1962: 86},
    "helmut rahn": {1958: 88},
    "fritz walter": {1958: 90},
    "giuseppe meazza": {1938: 94},
    "obdulio varela": {1954: 88},
}

# Squad-season removals for players who should never have been listed
# (e.g. Natalio Perinetti was announced for 1930 but never played).
EXCLUDE_PLAYERS = {
    (1930, "ARG"): {"natalio perinetti"},
}

_ATTR_CLAMP = lambda v: max(30, min(99, v))


def _scale_attrs(family: str, overall: int, position: str) -> list[int]:
    """Scale a family template so its star rating hits `overall` at `position`.

    `composite_rating`/`star_rating` are linear in the attrs, so scaling
    60 + (base - 60) * s converges on the requested overall exactly.
    """
    base = _STAR_ATTRS[family]
    lo, hi = 0.5, 2.6
    best: list[int] = base
    for _ in range(48):
        s = (lo + hi) / 2
        attrs = [_ATTR_CLAMP(int(60 + (v - 60) * s)) for v in base]
        got = _star_rating(position, attrs)
        if got == overall:
            return attrs
        if abs(got - overall) < abs(_star_rating(position, best) - overall):
            best = attrs
        if got < overall:
            lo = s
        else:
            hi = s
    # Outcome may stall at the 99 cap for extreme targets; return the closest.
    want = star_rating(position, best)  # noqa: F821  (fallback: real replica)
    if want == overall:
        return best
    return best


def _fold_for_match(name: str) -> str:
    """Accent-fold a seed player name; wiki pages mark captains with suffixes
    ("(c)", "(captain)") that must not break the fold lookup."""
    base = _accent_fold(name)
    base = re.sub(r"\s*\(\s*[cC]\s*\)?\s*$", "", base).strip()
    base = re.sub(r"\s*\(captain\)\s*$", "", base).strip()
    base = base.rstrip("*").strip()
    return base


def star_override(name: str, code: str = "", year: int | None = None) -> tuple[list[str], list[int]] | None:
    """(pinned positions, explicit attrs) for an iconic player, or None.

    Attrs are scaled to the configured overall for the pinned primary role
    (year overrides tune individual tournaments), so a Maradona 1986 reads 96
    while the same 22-name roster's bench players keep their name-hash rolls.
    """
    fold = _fold_for_match(name)
    entry = PLAYER_RATINGS.get(fold)
    if entry is None and code:
        entry = PLAYER_RATINGS.get(f"{code}|{fold}")
    if entry is None:
        return None
    overall, positions, family = entry
    if year is not None:
        by_year = PLAYER_YEAR_OVERRIDES.get(fold) or \
            (PLAYER_YEAR_OVERRIDES.get(f"{code}|{fold}") if code else None)
        if by_year and year in by_year:
            overall = by_year[year]
    attrs = _scale_attrs(family, overall, _primary_pos(positions))
    return list(positions), attrs


# Historical role fixes for the wiki-era pre-2018 seeds, which lost per-player
# field positions (everyone degrades to a flat ["CM"]) and so got hash-rolled
# families — e.g. defender Rosetta as RW, forward Ferraris as GK. Pinning the
# real role keeps era_positions() from re-rolling them into a wrong family.
POSITION_FIXES: dict[tuple[int, str, str], list[str]] = {
    (1934, "ITA", "virginio rosetta"): ["CB!"],
    (1934, "ITA", "felice borel"): ["ST!"],
    (1938, "ITA", "piero pasinati"): ["RW!"],
    (1938, "ITA", "pietro ferraris"): ["ST!"],
    (1938, "ITA", "pietro rava"): ["LB!"],
}


def position_fix(year: int, code: str, name: str) -> list[str] | None:
    return POSITION_FIXES.get((year, code, _fold_for_match(name)))


def clean_display_name(name: str) -> str:
    """Strip the snippet-era "(Captain)"/"(c)" roster tag so tables show the
    plain name (the fold matcher already ignored it via _fold_for_match)."""
    return re.sub(r"\s*\((?:c|captain)\)\s*$", "", name, flags=re.I).strip()


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
        drop_folds = EXCLUDE_PLAYERS.get((year, code), set())
        for pl in normalized:
            if _fold_for_match(pl["name"]) in drop_folds:
                continue
            pl_copy = {k: v for k, v in pl.items()
                       if k not in ("wiki", "sofa_id", "_caps", "_wiki", "_order")}
            pl_copy["name"] = clean_display_name(pl_copy["name"])
            pl_copy["photo"] = photo_cache.get(pl.get("wiki"))
            star = star_override(pl_copy["name"], code, year)
            if star is not None:
                pl_copy["positions"], pl_copy["attrs"] = star
            else:
                fixed = position_fix(year, code, pl_copy["name"])
                if fixed is not None:
                    pl_copy["positions"] = fixed
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


def apply_ratings_to_seed(seed: dict) -> dict:
    """Rewrite an existing seed (no network): per-edition team ratings, iconic
    player positions+attrs, and squad-season exclusions. Used by --patch so the
    rosters fetched from Wikipedia/openfootball are preserved verbatim while
    the ratings layer is refreshed."""
    year = seed["year"]
    for team in seed.get("teams", []):
        code = team["code"]
        team["rating"] = get_rating(team["name"], year) \
            if code not in ("",) else team.get("rating", 60)
    squads = {}
    for code, roster in seed.get("squads", {}).items():
        squad = seed.get("squads", {}).get(code, [])
        drop_folds = EXCLUDE_PLAYERS.get((year, code), set())
        out = []
        for pl in squad:
            name = clean_display_name(pl["name"])
            pl = dict(pl)
            pl["name"] = name
            if _fold_for_match(name) in drop_folds:
                continue
            star = star_override(name, code, year)
            if star is not None:
                pl["positions"], pl["attrs"] = star
            else:
                fixed = position_fix(year, code, name)
                if fixed is not None:
                    pl["positions"] = fixed
            out.append(pl)
        squads[code] = out
    seed["squads"] = squads
    return seed


def main() -> int:
    args = [a for a in sys.argv[1:]]
    patch_mode = "--patch" in args

    SEED_DIR.mkdir(parents=True, exist_ok=True)
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)

    YEARS = list(range(1930, 2027))
    for y in (1942, 1946):
        YEARS.remove(y)

    for year in YEARS:
        dest = SEED_DIR / f"{year}.json"
        if patch_mode:
            if not dest.exists():
                print(f"[{year}] seed missing, skipping", file=sys.stderr)
                continue
            seed = json.loads(dest.read_text(encoding="utf-8"))
            try:
                seed = apply_ratings_to_seed(seed)
                dest.write_text(json.dumps(seed, ensure_ascii=False, indent=1))
                nplayers = sum(len(v) for v in seed["squads"].values())
                print(f"[{year}] patched {dest}: {len(seed['teams'])} teams, {nplayers} players",
                      file=sys.stderr)
            except Exception as exc:
                print(f"[{year}] ERROR: {exc}", file=sys.stderr)
                import traceback
                traceback.print_exc()
            continue
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