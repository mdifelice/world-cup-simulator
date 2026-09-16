#!/usr/bin/env python3
"""Simulate a World Cup over and over (default 100) against the live server and
tally the top-4 finishing positions, so you can compare actual likelhoods —
e.g. how often Ecuador ends up subchampion.

The server exposes the canonical sim; each POST runs the whole tournament with
a deterministic seed. Finals are read from the run payload directly (match with
stage_key "F" and the "THIRD" bronze game).

Usage:
    python3 server/scripts/sim_100.py [--runs 100] [--tournament 23] [--team Ecuador]
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from collections import Counter

STAGE_FINAL = "F"
STAGE_THIRD = "THIRD"


def fetch(base: str, tournament_id: int, seed: int) -> dict:
    body = json.dumps(
        {
            "focus_team_id": None,
            "focus_boost": 0,
            "seed": seed,
            "lineups": {},
            "save": False,
        }
    ).encode()
    req = urllib.request.Request(
        f"{base}/api/tournaments/{tournament_id}/run",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def match_winner(m: dict) -> int | None:
    if m.get("penalties"):
        return m["penalties"]["winner_id"]
    h, a = m["home_score"], m["away_score"]
    if h > a:
        return m["home_team_id"]
    if a > h:
        return m["away_team_id"]
    return None


def top_four(run: dict) -> dict[int, str]:
    """Return {placement: team_name} for champion..fourth."""
    by_id = {t["id"]: t["name"] for g in run["groups"] for t in g["teams"]}
    final = next(m for m in run["matches"] if m["stage_key"] == STAGE_FINAL)
    third = next(m for m in run["matches"] if m["stage_key"] == STAGE_THIRD)

    champ = match_winner(final)
    loser_of = lambda m: (
        m["away_team_id"]
        if match_winner(m) == m["home_team_id"]
        else m["home_team_id"]
    )
    if champ is None:
        champ = loser_of(final)
    sub = loser_of(final)
    third_w = match_winner(third)
    if third_w is None:
        third_w = loser_of(third)
    fourth = loser_of(third)

    return {
        1: by_id.get(champ, run.get("champion") or str(champ)),
        2: by_id.get(sub, str(sub)),
        3: by_id.get(third_w, str(third_w)),
        4: by_id.get(fourth, str(fourth)),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=100)
    ap.add_argument("--tournament", type=int, default=23)
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--team", default="Ecuador", help="team to report on (by name)")
    args = ap.parse_args()

    positions: dict[int, Counter] = {1: Counter(), 2: Counter(), 3: Counter(), 4: Counter()}
    top4: Counter = Counter()

    for i in range(1, args.runs + 1):
        run = fetch(args.base, args.tournament, i)
        top = top_four(run)
        for pos, name in top.items():
            positions[pos][name] += 1
            top4[name] += 1
        if i % 10 == 0:
            print(f"  ...{i}/{args.runs}")

    labels = {1: "Champion", 2: "Subchampion", 3: "Third", 4: "Fourth"}
    print(f"\nTop-4 finishing frequencies over {args.runs} runs (seed 1..{args.runs}):")
    for pos in (1, 2, 3, 4):
        print(f"\n  {labels[pos]} ({args.runs} runs):")
        for name, c in positions[pos].most_common(8):
            print(f"    {name:28s} {c:3d}  ({c / args.runs * 100:4.1f}%)")

    print(f"\nAny top-4 appearance ({args.runs} runs):")
    for name, c in top4.most_common(8):
        print(f"    {name:28s} {c:3d}  ({c / args.runs * 100:4.1f}%)")

    team = args.team
    print(f"\nReport for {team}:")
    for pos in (1, 2, 3, 4):
        c = positions[pos][team]
        print(f"  {labels[pos]}: {c:3d}  ({c / args.runs * 100:4.1f}%)")
    c = top4[team]
    print(f"  Any top-4: {c:3d}  ({c / args.runs * 100:4.1f}%)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())