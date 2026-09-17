"""Small debugging probe for the SoFaScore ingest (uses the shared client).

Usage:
  server/.venv/bin/python server/scripts/sofascore_probe.py seasons
  server/.venv/bin/python server/scripts/sofascore_probe.py stages 41087
  server/.venv/bin/python server/scripts/sofascore_probe.py lineup <eventId>
  server/.venv/bin/python server/scripts/sofascore_probe.py teams 58210
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_sofascore import CACHE_DIR, classify, group_letter  # noqa: E402
from sofascore_api import SofaClient  # noqa: E402


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "seasons"
    client = SofaClient(CACHE_DIR)
    try:
        if mode == "seasons":
            for s in sorted(client.seasons(), key=lambda x: x.get("year", 0)):
                print(s.get("year"), s.get("id"), s.get("name"))
        elif mode == "stages":
            sid = int(sys.argv[2])
            events = client.season_events(sid)
            counts = Counter((classify(e), group_letter(e) or "-") for e in events)
            print(f"{len(events)} events")
            for (stage, grp), n in sorted(counts.items()):
                print(f"  {stage:8s} {grp:2s} {n}")
            unknown = [e for e in events if classify(e) == "GROUP" and not group_letter(e)]
            for e in unknown[:10]:
                print("  unknown:", json.dumps(e.get("tournament"), ensure_ascii=False)[:160])
        elif mode == "lineup":
            lu = client.json(f"/api/v1/event/{int(sys.argv[2])}/lineups")
            for side in ("home", "away"):
                block = lu.get(side) or {}
                print(side, "players", len(block.get("players") or []))
            sample = ((lu.get("home") or {}).get("players") or [{}])[0]
            print(json.dumps(sample, ensure_ascii=False)[:600])
        elif mode == "teams":
            teams = client.json(
                f"/api/v1/unique-tournament/16/season/{int(sys.argv[2])}/teams"
            )["teams"]
            print(len(teams), "teams")
            print(json.dumps(teams[0], ensure_ascii=False)[:700])
    finally:
        client.close()


if __name__ == "__main__":
    main()
