"""Tests for wcs_derive. Run: server/.venv/bin/python server/scripts/test_wcs_derive.py"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wcs_derive as d  # noqa: E402

POSITIONS = [p for p in d.POSITION_WEIGHTS if p != "_"]


def test_composite_hits_target_for_every_position():
    worst = 0.0
    for pos in POSITIONS:
        for overall in range(45, 98):
            attrs = d.attrs_from_overall(overall, pos)
            assert len(attrs) == 18
            assert all(30 <= a <= 99 for a in attrs), (pos, overall, attrs)
            worst = max(worst, abs(d.composite(pos, attrs) - overall))
    assert worst <= 1.5, f"max composite drift {worst}"


def test_positions_balanced_at_equal_overall():
    for overall in (60, 70, 80, 90):
        vals = {pos: d.composite(pos, d.attrs_from_overall(overall, pos)) for pos in POSITIONS}
        spread = max(vals.values()) - min(vals.values())
        assert spread <= 1.5, (overall, vals)


def test_gk_not_worse_than_striker():
    for overall in (55, 65, 75, 85):
        gk = d.composite("GK", d.attrs_from_overall(overall, "GK"))
        st = d.composite("ST", d.attrs_from_overall(overall, "ST"))
        assert abs(gk - st) <= 1.5, (overall, gk, st)


def test_rating_mapping_monotonic_and_bounded():
    prev = -1
    for r in [x / 10 for x in range(55, 96)]:
        v = d.overall_from_rating(r)
        assert v >= prev
        assert 45 <= v <= 97
        prev = v
    assert d.overall_from_rating(6.0) == 50
    assert d.overall_from_rating(8.0) == 90


def test_fallback_within_band():
    for finish, (lo, hi) in d.FINISH_BANDS.items():
        for frac in (0.0, 0.5, 1.0):
            v = d.fallback_overall(finish, "Some Player", 1986, frac)
            assert lo - 3 <= v <= hi + 3, (finish, frac, v)


def test_fallback_starter_bias():
    bench = sum(d.fallback_overall("SEMI", f"P{i}", 2010, 0.0) for i in range(40))
    starters = sum(d.fallback_overall("SEMI", f"P{i}", 2010, 1.0) for i in range(40))
    assert starters > bench


def test_team_tier_rating_bounds_and_seed_effect():
    for finish in d.FINISH_BANDS:
        for rank in (None, 1, 5, 10, 25, 60):
            v = d.team_tier_rating(finish, rank)
            assert 58 <= v <= 92
    assert d.team_tier_rating("GROUP", 1) > d.team_tier_rating("GROUP", 60)
    assert d.team_tier_rating("CHAMPION", 60) > d.team_tier_rating("GROUP", 60)


def test_flags():
    assert d.flag_emoji("MX", "MEX", "Mexico") == "\U0001F1F2\U0001F1FD"
    assert d.flag_emoji(None, None, "England").startswith("\U0001F3F4")
    assert d.flag_emoji(None, "ENG") == d.SPECIAL_FLAGS["ENG"]
    assert d.flag_emoji(None, None, "Atlantis") == "\U0001F3F3"


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
