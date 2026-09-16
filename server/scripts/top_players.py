#!/usr/bin/env python3
"""Rank the best players of a seeded World Cup database by a market-value-style
weighted average of the 18 attributes.

Attack-biased weights mean the expensive attackers and all-round stars climb to
the top, while defensive labour (tackling/aerial) and GK-specific skills barely
move the needle for outfielders. Keepers are compared against a separate
GK-focused weight profile so they are still judged on the right things.

Usage:
    python3 server/scripts/top_players.py [--db server/data/wcs.sqlite] [--top 50]
"""

from __future__ import annotations

import argparse
import os
import sqlite3

ATTRS = [
    "pace", "stamina", "strength", "dribbling", "passing", "shooting", "tackling", "vision",
    "positioning", "composure", "reflexes", "handling", "kicking", "aerial", "decisions",
    "aggression", "concentration", "leadership",
]

# weights: (pace, stamina, strength, dribbling, passing, shooting, tackling, vision,
#           positioning, composure, reflexes, handling, kicking, aerial, decisions,
#           aggression, concentration, leadership)
OUTFIELD = (6, 2, 2, 7, 6, 6, 2, 4, 5, 4, 1, 1, 1, 2, 3, 1, 2, 3)
GOALKEEPER = (1, 1, 2, 1, 1, 1, 1, 1, 6, 5, 8, 8, 6, 2, 4, 1, 3, 3)

FAMILY = {
    "GK": "GK", "CB": "DF", "LB": "DF", "RB": "DF",
    "CM": "MF", "CDM": "MF", "CAM": "MF", "LM": "MF", "RM": "MF",
    "LW": "FW", "RW": "FW", "ST": "FW", "CF": "FW", "SS": "FW",
}


def star_rating(attrs: tuple, position: str) -> float:
    w = GOALKEEPER if FAMILY.get(position, "MF") == "GK" else OUTFIELD
    return sum(a * b for a, b in zip(attrs, w)) / sum(w)


def load_players(db_path: str):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        f"""
        SELECT p.name, t.name AS team, pc.position AS pos,
               {", ".join("p." + a for a in ATTRS)}
        FROM players p
        JOIN player_callups pc ON pc.player_id = p.id
        JOIN tournament_teams tt ON tt.tournament_id = pc.tournament_id AND tt.team_id = pc.team_id
        JOIN teams t ON t.id = tt.team_id
        """
    ).fetchall()
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None, help="path to wcs.sqlite (default: WCS_DATA_DIR or data/wcs.sqlite)")
    ap.add_argument("--top", type=int, default=50)
    args = ap.parse_args()
    db_path = args.db or os.path.join(
        os.environ.get("WCS_DATA_DIR", "data"), "wcs.sqlite"
    )
    if not os.path.exists(db_path):
        print(f"ERROR: no database at {db_path}", file=sys.stderr)
        return 1
    rows = load_players(db_path)
    ranked = sorted(
        ((star_rating(tuple(r[a] or 0 for a in ATTRS), r["pos"]), dict(r)) for r in rows),
        key=lambda x: (-x[0], x[1]["name"]),
    )
    print(f"{'#':>3} {'score':>5}  {'name':<26}{'team':<14}{'pos':<4}")
    for i, (score, r) in enumerate(ranked[: args.top], 1):
        print(f"{i:>3} {score:5.1f}  {r['name']:<26}{r['team']:<14}{r['pos'] or '':<4}")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())