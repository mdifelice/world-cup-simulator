"""Build per-edition World Cup seed files from SoFaScore.

Produces ``server/data/seed/{year}.json`` (teams, squads, group fixtures) plus
downscaled player headshots in ``server/data/photos/{playerId}.jpg``. See
``csv_to_seed``/``build_seed`` for the pure assembly logic and
``scripts/sofascore_api.py`` for the Cloudflare-friendly fetcher.

Examples:
    # fetch + build every edition (slow, resumable)
    server/.venv/bin/python server/scripts/ingest_sofascore.py

    # only 2026 and 2022, no photos
    server/.venv/bin/python server/scripts/ingest_sofascore.py --years 2026,2022 --no-photos

    # rebuild seed files from an existing cache without any network
    server/.venv/bin/python server/scripts/ingest_sofascore.py --offline
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wcs_derive as dv  # noqa: E402
from sofascore_api import OfflineClient, SofaClient  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
DATA_DIR = REPO / "server" / "data"
SEED_DIR = DATA_DIR / "seed"
PHOTO_DIR = DATA_DIR / "photos"
CACHE_DIR = Path(__file__).resolve().parent / ".cache" / "sofascore"
PHOTO_SIZE = 96

WORLD_CUPS = [
    1930, 1934, 1938, 1950, 1954, 1958, 1962, 1966, 1970, 1974, 1978, 1982,
    1986, 1990, 1994, 1998, 2002, 2006, 2010, 2014, 2018, 2022, 2026,
]
# Editions whose structure SoFaScore covers; knockouts for 2026 aren't drawn yet.
DEFAULT_YEARS = WORLD_CUPS

GROUP_RE = re.compile(r"group\s+([A-L])\b", re.I)


# ---------------------------------------------------------------------------
# Event classification
# ---------------------------------------------------------------------------
def group_letter(event: dict) -> str | None:
    tn = ((event.get("tournament") or {}).get("name") or "")
    m = GROUP_RE.search(tn)
    if m:
        return m.group(1).upper()
    slug = ((event.get("tournament") or {}).get("slug") or "")
    m = re.search(r"-gr-([a-l])$", slug)
    return m.group(1).upper() if m else None


def classify(event: dict) -> str:
    """Map a SoFaScore event onto a stage key (GROUP/R32/R16/QUARTER/...)."""
    ri = event.get("roundInfo") or {}
    parts = [
        str(ri.get("name") or ""),
        str(ri.get("slug") or ""),
        str((event.get("tournament") or {}).get("name") or ""),
        str((event.get("tournament") or {}).get("slug") or ""),
    ]
    label = " ".join(parts).lower()
    if "group" in label:
        return "GROUP"
    if "round of 32" in label or "round-of-32" in label:
        return "R32"
    if "round of 16" in label or "round-of-16" in label:
        return "R16"
    if "quarter" in label:
        return "QUARTER"
    if "semi" in label:
        return "SEMI"
    if "third" in label or "3rd place" in label:
        return "THIRD"
    if "final" in label:
        return "FINAL"
    return "GROUP"


# Furthest stage each team reached, ranked best -> worst.
STAGE_RANK = ["CHAMPION", "FINAL", "SEMI", "QUARTER", "R16", "R32", "GROUP"]


def finish_tiers(events: list[dict]) -> dict[int, str]:
    """team SoFaScore id -> furthest-tier label (winner/runner-up resolved)."""
    furthest: dict[int, str] = {}

    def team_ids(e: dict) -> tuple[int | None, int | None]:
        h = (e.get("homeTeam") or {}).get("id")
        a = (e.get("awayTeam") or {}).get("id")
        return h, a

    def bump(tid: int, stage: str) -> None:
        if tid is None:
            return
        if STAGE_RANK.index(stage) < STAGE_RANK.index(furthest.get(tid, "GROUP")):
            furthest[tid] = stage

    for e in events:
        stage = classify(e)
        if stage == "GROUP":
            continue
        h, a = team_ids(e)
        wc = e.get("winnerCode")
        w = h if wc == 1 else a if wc == 2 else None
        if stage == "THIRD":
            # Both third-place sides already reached the semis.
            bump(h, "SEMI")
            bump(a, "SEMI")
        elif stage == "FINAL":
            for t in (h, a):
                bump(t, "FINAL")
            if w is not None:
                furthest[w] = "CHAMPION"
        else:
            advance = {"R32": "R16", "R16": "QUARTER", "QUARTER": "SEMI"}[stage]
            for t in (h, a):
                bump(t, stage)
            if w is not None:
                bump(w, advance)

    return furthest


# ---------------------------------------------------------------------------
# Squad assembly
# ---------------------------------------------------------------------------
def normalise_position(raw: str | None) -> str:
    if not raw:
        return "CM"
    up = raw.upper().strip()
    return dv.SOFA_SUB_POSITION.get(up, dv.SOFA_POSITION.get(up[:1], "CM"))


def build_squads(
    lineups: dict[int, dict],
    ratings: dict[int, float],
    finish_by_team: dict[int, str],
    year: int,
) -> dict[int, list[dict]]:
    """event_id -> lineups payload  =>  {team_id: [seed players]}."""
    squads: dict[int, dict[int, dict]] = {}
    starts: dict[int, int] = {}
    team_starts: dict[int, int] = {}

    for payload in lineups.values():
        for side in ("home", "away"):
            block = payload.get(side) or {}
            team_id = block.get("id") or (block.get("team") or {}).get("id")
            if team_id is None:
                continue
            lst = block.get("players") or []
            for entry in lst:
                p = entry.get("player") or {}
                pid = p.get("id")
                if pid is None:
                    continue
                squad = squads.setdefault(team_id, {})
                pos = normalise_position(p.get("position") or entry.get("position"))
                cur = squad.get(pid)
                if cur is None:
                    squad[pid] = {
                        "id": pid,
                        "name": p.get("name") or p.get("shortName") or "Unknown",
                        "position": pos,
                        "shirt": entry.get("shirtNumber") or p.get("jerseyNumber"),
                        "starts": 0,
                        "caps": 0,
                    }
                    cur = squad[pid]
                cur["caps"] += 1
                if not entry.get("substitute", False):
                    cur["starts"] += 1
                    starts[pid] = starts.get(pid, 0) + 1
                    team_starts[team_id] = team_starts.get(team_id, 0) + 1

    out: dict[int, list[dict]] = {}
    for team_id, players in squads.items():
        finish = finish_by_team.get(team_id, "GROUP")
        max_starts = max((p["starts"] for p in players.values()), default=1) or 1
        rows = []
        for p in players.values():
            frac = p["starts"] / max_starts
            if p["id"] in ratings:
                overall = dv.overall_from_rating(ratings[p["id"]])
            else:
                overall = dv.fallback_overall(finish, p["name"], year, frac)
            attrs = dv.attrs_from_overall(overall, p["position"])
            rows.append(
                {
                    "name": p["name"],
                    "positions": [p["position"]],
                    "shirt": p["shirt"],
                    "sofa_id": p["id"],
                    "attrs": attrs,
                }
            )
        rows.sort(key=lambda r: r["name"])
        out[team_id] = rows
    return out


# ---------------------------------------------------------------------------
# Photo thumbnails
# ---------------------------------------------------------------------------
def save_photo(client: SofaClient, pid: int) -> bool:
    dest = PHOTO_DIR / f"{pid}.jpg"
    if dest.exists():
        return True
    raw = client.bytes(f"/api/v1/player/{pid}/image")
    if not raw:
        return False
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((PHOTO_SIZE, PHOTO_SIZE))
        img.save(dest, "JPEG", quality=82, optimize=True)
        return True
    except Exception as exc:  # noqa: BLE001 - skip unreadable images
        print(f"    [photo] {pid}: {exc}")
        return False


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def fetch_ratings(client: SofaClient, sid: int) -> dict[int, float]:
    try:
        payload = client.json(
            f"/api/v1/unique-tournament/16/season/{sid}/top-players/overall"
        )
    except RuntimeError:
        return {}
    out: dict[int, float] = {}
    for row in (payload.get("topPlayers") or {}).get("rating", []):
        p = row.get("player") or {}
        r = ((row.get("statistics") or {}).get("rating"))
        if p.get("id") is not None and r is not None:
            out[p["id"]] = float(r)
    return out


def build_seed(client, year: int, sid: int, photos: bool) -> dict:
    print(f"[{year}] season {sid}")
    teams_payload = client.json(f"/api/v1/unique-tournament/16/season/{sid}/teams")["teams"]
    teams_by_id = {t["id"]: t for t in teams_payload}

    standings = client.json(
        f"/api/v1/unique-tournament/16/season/{sid}/standings/total"
    )["standings"]
    group_of: dict[int, str] = {}
    for grp in standings:
        name = grp.get("name") or ""
        m = GROUP_RE.search(name)
        if not m:
            continue
        letter = m.group(1).upper()
        for row in grp.get("rows") or []:
            tid = (row.get("team") or {}).get("id")
            if tid is not None:
                group_of[tid] = letter

    events = client.season_events(sid)
    print(f"[{year}] {len(events)} events, {len(teams_by_id)} teams")

    ratings = fetch_ratings(client, sid)
    finish_by_team = finish_tiers(events)
    print(f"[{year}] {len(ratings)} rated players")

    lineups: dict[int, dict] = {}
    for e in events:
        try:
            lineups[e["id"]] = client.json(f"/api/v1/event/{e['id']}/lineups")
        except RuntimeError as exc:
            print(f"    [lineup] event {e['id']} skipped: {exc}")

    squads_by_team = build_squads(lineups, ratings, finish_by_team, year)

    teams = []
    squads: dict[str, list[dict]] = {}
    for tid, t in teams_by_id.items():
        if tid not in group_of and tid not in finish_by_team:
            continue
        country = t.get("country") or {}
        code = t.get("nameCode") or (country.get("alpha3") or "")
        name = t.get("name") or "Unknown"
        finish = finish_by_team.get(tid, "GROUP")
        rating = dv.team_tier_rating(finish, t.get("ranking"))
        group = group_of.get(tid, "")
        if not code:
            continue
        teams.append(
            {
                "name": name,
                "code": code,
                "flag": dv.flag_emoji(country.get("alpha2"), country.get("alpha3"), name),
                "rating": rating,
                "group": group,
            }
        )
        rows = squads_by_team.get(tid)
        if rows:
            squads[code] = rows

    fixtures = []
    for e in events:
        letter = group_letter(e)
        if not letter:
            continue
        h = (e.get("homeTeam") or {}).get("nameCode")
        a = (e.get("awayTeam") or {}).get("nameCode")
        if not h or not a:
            continue
        ts = e.get("startTimestamp")
        kickoff = None
        if ts:
            kickoff = dt.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M")
        fixtures.append(
            {
                "group": letter,
                "match": len(fixtures) + 1,
                "home": h,
                "away": a,
                "matchday": (e.get("roundInfo") or {}).get("round") or 1,
                "kickoff": kickoff,
            }
        )

    all_ids = sorted({p["sofa_id"] for rows in squads.values() for p in rows})
    if photos:
        PHOTO_DIR.mkdir(parents=True, exist_ok=True)
        print(f"[{year}] fetching {len(all_ids)} player photos…")
        done = sum(1 for pid in all_ids if save_photo(client, pid))
        print(f"[{year}] photos saved {done}/{len(all_ids)}")
    for rows in squads.values():
        for p in rows:
            if (PHOTO_DIR / f"{p['sofa_id']}.jpg").exists():
                p["photo"] = f"/photos/{p['sofa_id']}.jpg"
            p.pop("sofa_id", None)

    return {"year": year, "teams": teams, "squads": squads, "fixtures": fixtures}


def season_map(client: SofaClient) -> dict[int, int]:
    out = {}
    for s in client.seasons():
        y = s.get("year")
        if y:
            out[int(y)] = int(s["id"])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="", help="comma-separated years (default: all)")
    ap.add_argument("--no-photos", action="store_true")
    ap.add_argument("--offline", action="store_true", help="build from cache only")
    ap.add_argument("--refresh", action="store_true", help="ignore cached responses")
    args = ap.parse_args()

    years = (
        [int(y) for y in args.years.split(",") if y.strip()]
        if args.years
        else DEFAULT_YEARS
    )
    SEED_DIR.mkdir(parents=True, exist_ok=True)

    client = OfflineClient(CACHE_DIR) if args.offline else SofaClient(CACHE_DIR, refresh=args.refresh)
    try:
        smap = season_map(client)
        missing = [y for y in years if y not in smap]
        if missing:
            print(f"warning: no SoFaScore season for {missing}")
        for year in years:
            if year not in smap:
                continue
            try:
                seed = build_seed(client, year, smap[year], photos=not args.no_photos)
            except RuntimeError as exc:
                print(f"[{year}] FAILED: {exc}")
                continue
            dest = SEED_DIR / f"{year}.json"
            dest.write_text(json.dumps(seed, ensure_ascii=False))
            print(f"[{year}] wrote {dest} ({len(seed['teams'])} teams, "
                  f"{sum(len(v) for v in seed['squads'].values())} players)")
    finally:
        client.close()


if __name__ == "__main__":
    main()
