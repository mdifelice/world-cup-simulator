#!/usr/bin/env python3
"""Export a seeded World Cup database back into portable ``data/seed`` files.

The server rebuilds its SQLite database from ``data/seed/{year}.json`` on every
start, so those JSON files are the real source of truth — the ``wcs.sqlite``
binary itself is a disposable build artifact. This script takes the *current*
database and writes one seed file per edition in exactly the schema
``server/src/db.rs`` consumes, so the live DB state can be captured in git as
diffable text and restored on any machine with ``cp data/db-snapshot/*.json
data/seed/``.

Fidelity: every player is written with their resolved attributes and their
*resolved* position card, with the primary position pinned by a trailing "!"
(the "pinned card" token understood by ``era_positions``). Pinning stops the
seeder from re-deriving positions for flat "CM" squads, so re-seeding the
snapshot reproduces the same squads rather than re-rolling an era formation.
Team ratings, group assignments and the real group fixtures (with kickoff
times) are preserved per edition.

Usage:
    python3 server/scripts/export_db_seed.py [--db data/wcs.sqlite]
                                             [--out data/db-snapshot]
                                             [--year 2014] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3

# Column order must match the INSERT in server/src/db.rs::seed_edition.
ATTRS = [
    "pace", "stamina", "strength", "dribbling", "passing", "shooting", "tackling",
    "vision", "positioning", "composure", "reflexes", "handling", "kicking",
    "aerial", "decisions", "aggression", "concentration", "leadership",
]


def export_year(cur: sqlite3.Cursor, year: int) -> dict:
    """Build one SeedFile-shaped dict for a single tournament year."""
    row = cur.execute(
        "SELECT id FROM tournaments WHERE year = ?", (year,)
    ).fetchone()
    if row is None:
        raise SystemExit(f"no tournament for year {year}")
    tid = row[0]

    # --- teams + their edition rating + group -------------------------------
    teams = cur.execute(
        """
        SELECT t.id, t.name, t.code, t.flag,
               COALESCE(tt.rating, t.rating) AS rating,
               g.group_name
        FROM tournament_teams tt
        JOIN teams t ON t.id = tt.team_id
        LEFT JOIN tournament_groups g
               ON g.tournament_id = tt.tournament_id AND g.team_id = t.id
        WHERE tt.tournament_id = ?
        ORDER BY t.name
        """,
        (tid,),
    ).fetchall()

    seed_teams = []
    code_by_team_id = {}
    for _tid_, name, code, flag, rating, group in teams:
        seed_teams.append(
            {
                "name": name,
                "code": code or "",
                "flag": flag or "",
                "rating": rating,
                **({"group": group} if group else {}),
            }
        )
        code_by_team_id[_tid_] = code

    # --- squads: one call-up list per team code -----------------------------
    squads = {}
    for team_id, name, code, _flag, _rating, _group in teams:
        if not code:
            continue  # fixtures/squads are keyed by code; skip uncoded teams
        players = cur.execute(
            f"""
            SELECT p.name, pc.positions, pc.shirt_number, p.photo_url,
                   {', '.join('p.' + a for a in ATTRS)}
            FROM player_callups pc
            JOIN players p ON p.id = pc.player_id
            WHERE pc.tournament_id = ? AND pc.team_id = ?
            ORDER BY pc.id
            """,
            (tid, team_id),
        ).fetchall()
        entries = []
        for (pname, positions, shirt, photo, *attrs) in players:
            card = [s for s in (positions or "").split(",") if s]
            if card:
                # Pin the primary so era_positions keeps the card verbatim.
                card[0] = card[0] + "!"
            else:
                card = ["CM!"]
            entries.append(
                {
                    "name": pname,
                    "positions": card,
                    **({"shirt": shirt} if shirt is not None else {}),
                    **({"photo": photo} if photo else {}),
                    "attrs": list(attrs),
                }
            )
        if entries:
            squads[code] = entries

    # --- real group fixtures (kickoff preserved) ----------------------------
    fixtures = []
    for home_id, away_id, matchday, kickoff in cur.execute(
        """
        SELECT home_team_id, away_team_id, matchday, kickoff
        FROM matches
        WHERE tournament_id = ? AND stage = 'GROUP'
        ORDER BY COALESCE(matchday, 0), id
        """,
        (tid,),
    ):
        home_code = code_by_team_id.get(home_id)
        away_code = code_by_team_id.get(away_id)
        if not home_code or not away_code:
            continue  # can't express a pairing without both team codes
        fixtures.append(
            {
                "home": home_code,
                "away": away_code,
                **({"matchday": matchday} if matchday is not None else {}),
                **({"kickoff": kickoff} if kickoff else {}),
            }
        )

    return {"teams": seed_teams, "squads": squads, "fixtures": fixtures}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default="data/wcs.sqlite", help="SQLite database to export")
    ap.add_argument("--out", default="data/db-snapshot", help="output directory for seed JSONs")
    ap.add_argument("--year", type=int, action="append", help="only this year (repeatable)")
    ap.add_argument("--dry-run", action="store_true", help="print a summary, write nothing")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        raise SystemExit(f"database not found: {args.db}")

    conn = sqlite3.connect(args.db)
    cur = conn.cursor()
    years = args.year or [r[0] for r in cur.execute(
        "SELECT year FROM tournaments WHERE from_seed = 1 ORDER BY year"
    )]
    if not years:
        raise SystemExit("no seeded tournaments found — is this a seeded DB?")

    os.makedirs(args.out, exist_ok=True) if not args.dry_run else None
    for year in years:
        seed = export_year(cur, year)
        players = sum(len(v) for v in seed["squads"].values())
        summary = (
            f"{year}: {len(seed['teams'])} teams, {len(seed['squads'])} squads, "
            f"{players} players, {len(seed['fixtures'])} group fixtures"
        )
        if args.dry_run:
            print(summary)
            continue
        path = os.path.join(args.out, f"{year}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(seed, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"{summary} -> {path}")


if __name__ == "__main__":
    main()
