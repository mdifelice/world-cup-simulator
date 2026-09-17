"""Synthetic (network-free) tests for the SoFaScore ingest assembly.

Run: server/.venv/bin/python server/scripts/test_ingest_sofascore.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wcs_derive as dv  # noqa: E402
from ingest_sofascore import build_seed, classify, finish_tiers, group_letter  # noqa: E402
from sofascore_api import SofaClient  # noqa: E402

SID = 99999


def team(tid, name, code, alpha2, ranking):
    return {
        "id": tid,
        "name": name,
        "nameCode": code,
        "ranking": ranking,
        "country": {"alpha2": alpha2, "alpha3": code, "name": name},
    }


def event(eid, stage_label, home, away, sid=SID, wc=None, ts=1600000000, rnd=1, group=None):
    tour = "FIFA World Cup, Group A" if group else f"FIFA World Cup, {stage_label}"
    slug = "world-championship-gr-a" if group else f"world-championship-{stage_label.lower()}"
    return {
        "id": eid,
        "homeTeam": home,
        "awayTeam": away,
        "homeScore": {"current": 2 if wc == 1 else 1},
        "awayScore": {"current": 2 if wc == 2 else 1},
        "winnerCode": wc,
        "startTimestamp": ts,
        "roundInfo": {"round": rnd, "name": stage_label},
        "tournament": {"name": tour, "slug": slug},
    }


HOME = team(1, "Brazil", "BRA", "BR", 1)
AWAY = team(2, "Haiti", "HAI", "HT", 80)
SIDE = team(3, "Spain", "ESP", "ES", 3)
OTHER = team(4, "Qatar", "QAT", "QA", 40)


def lineup_block(tid, players):
    return {"id": tid, "players": players}


def player(pid, name, position, shirt, substitute=False):
    return {
        "player": {"id": pid, "name": name, "position": position, "jerseyNumber": shirt},
        "shirtNumber": shirt,
        "substitute": substitute,
    }


class FakeClient:
    def json(self, path: str):
        if path.endswith("/teams"):
            return {"teams": [HOME, AWAY, SIDE, OTHER]}
        if path.endswith("/standings/total"):
            return {
                "standings": [
                    {"name": "Group A", "rows": [{"team": {"id": 1}}, {"team": {"id": 2}}]},
                    {"name": "Group B", "rows": [{"team": {"id": 3}}, {"team": {"id": 4}}]},
                ]
            }
        if path.endswith("/top-players/overall"):
            return {
                "topPlayers": {
                    "rating": [
                        {"statistics": {"rating": 8.2}, "player": {"id": 101, "name": "Star"}},
                        {"statistics": {"rating": 6.4}, "player": {"id": 102, "name": "Squad"}},
                    ]
                }
            }
        if "/events/round/" in path:
            r = int(path.rsplit("/", 1)[1])
            if r == 1:
                return {"events": [event(10, "1", HOME, AWAY, wc=1, group="A")]}
            if r == 2:
                return {"events": [event(11, "Round of 16", HOME, SIDE, wc=2)]}
            if r == 3:
                return {"events": [event(12, "Final", SIDE, AWAY, wc=1)]}
            return {"events": []}
        if path.endswith("/lineups"):
            eid = int(path.split("/event/")[1].split("/")[0])
            if eid == 10:
                return {
                    "home": lineup_block(
                        1,
                        [
                            player(101, "Star", "F", 9),
                            player(103, "Bench Guy", "D", 3, substitute=True),
                        ],
                    ),
                    "away": lineup_block(2, [player(104, "Keeper", "G", 1)]),
                }
            if eid == 11:
                return {
                    "home": lineup_block(1, [player(101, "Star", "F", 9)]),
                    "away": lineup_block(3, [player(105, "Passer", "M", 8)]),
                }
            return {
                "home": lineup_block(3, [player(105, "Passer", "M", 8)]),
                "away": lineup_block(2, [player(104, "Keeper", "G", 1)]),
            }
        raise AssertionError(f"unexpected path {path}")

    season_events = SofaClient.season_events

    def bytes(self, path):  # pragma: no cover - photos disabled in tests
        return None


def test_classify_and_group():
    assert classify(event(1, "Round of 16", HOME, AWAY)) == "R16"
    assert classify(event(1, "Final", HOME, AWAY)) == "FINAL"
    assert classify(event(1, "Quarter-finals", HOME, AWAY)) == "QUARTER"
    assert classify(event(1, "Semi-finals", HOME, AWAY)) == "SEMI"
    assert classify(event(1, "Group", HOME, AWAY, group="A")) == "GROUP"
    assert group_letter(event(1, "Group", HOME, AWAY, group="A")) == "A"
    assert group_letter(event(1, "Round of 16", HOME, AWAY)) is None


def test_finish_tiers():
    events = [
        event(10, "1", HOME, AWAY, wc=1, group="A"),
        event(11, "Round of 16", HOME, SIDE, wc=2),
        event(12, "Final", SIDE, AWAY, wc=1),
    ]
    tiers = finish_tiers(events)
    assert tiers[3] == "CHAMPION"     # Spain won the final
    assert tiers[2] == "FINAL"        # Haiti lost the final
    assert tiers[1] == "R16"          # Brazil lost the R16
    assert 4 not in tiers


def test_build_seed_shape_and_attrs():
    client = FakeClient()
    seed = build_seed(client, 1990, SID, photos=False)
    by_code = {t["code"]: t for t in seed["teams"]}
    assert set(by_code) == {"BRA", "HAI", "ESP", "QAT"}
    assert by_code["BRA"]["group"] == "A"
    assert by_code["ESP"]["rating"] > by_code["QAT"]["rating"]
    assert all(58 <= t["rating"] <= 92 for t in seed["teams"])

    bra = seed["squads"]["BRA"]
    star = next(p for p in bra if p["name"] == "Star")
    bench = next(p for p in bra if p["name"] == "Bench Guy")
    # Star has a SoFaScore rating (8.2); Bench Guy falls back to a finish band.
    assert dv.composite("ST", star["attrs"]) > dv.composite("CB", bench["attrs"])
    for p in bra:
        assert len(p["attrs"]) == 18
        assert all(30 <= a <= 99 for a in p["attrs"])
        assert "sofa_id" not in p

    fixtures = seed["fixtures"]
    assert fixtures and fixtures[0]["group"] == "A"
    assert fixtures[0]["home"] == "BRA" and fixtures[0]["away"] == "HAI"
    assert fixtures[0]["kickoff"].startswith("2020-09-13")


def main() -> None:
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as exc:
                fails += 1
                print(f"FAIL {name}: {exc}")
    print("FAILED" if fails else "ALL PASS")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
