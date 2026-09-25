#!/usr/bin/env python3
"""Backfill missing player photos in a seed from English Wikipedia.

The 2022 scraper resolved players to wiki titles that sometimes carried no
lead image (piped squad links collapse to short names like "Alisson", so the
pageimages lookup hit a redirect/blank and cached None).

Resolution is kept off the flaky per-player search path wherever possible:
candidate article titles come from (1) the scrapers' local pageimages cache —
its *keys* enumerate every real article title ever touched, so a name that is
a prefix of a cached title (Alisson -> Alisson Becker) is almost certainly
that article, and (2) the bare name plus its "(footballer)" form. The few
players neither source covers get a single spaced-out intitle search each.
All thumbnails are then fetched in one batched pageimages request (≤50 titles,
no per-title throttling) and written back into the seed.

    python3 server/scripts/backfill_player_photos.py server/data/seed/2022.json
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

UA = "wcs-data-tool/1.0 (https://github.com/mdifelice/world-cup-simulator)"
API = "https://en.wikipedia.org/w/api.php"

# team code -> nation term used to anchor the few needed searches
NATION = {
    "WAL": "Wales", "MEX": "Mexico", "CRC": "Costa Rica", "QAT": "Qatar",
    "GHA": "Ghana",
}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = s.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]", "", s.lower())


def toks(s: str) -> list[str]:
    return [norm(t) for t in s.split()]


def api(params: dict, retries: int = 4) -> dict:
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = repr(e)
            if e.code != 429 or attempt == retries - 1:
                break
            time.sleep(8 * (attempt + 1))
        except Exception as e:  # noqa: BLE001 - keep one failure class
            last = repr(e)
            if attempt == retries - 1:
                break
            time.sleep(3)
    print(f"  !! api failed: {last}", file=sys.stderr)
    return {}


def cache_titles(cache_path: str) -> dict[str, str | None]:
    try:
        with open(cache_path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def search_titles(name: str, hint: str) -> list[str]:
    q = api({
        "action": "query", "list": "search",
        "srsearch": hint, "srlimit": 10, "format": "json",
    })
    return [h["title"] for h in q.get("query", {}).get("search", [])]


def candidates(name: str, code: str,
               cache: dict[str, str | None]) -> list[str]:
    """Article-title candidates for a player, best-likelihood first."""
    nt = toks(name)
    out: list[str] = []
    seen: set[str] = set()
    for k in cache:
        kt = toks(k)
        if len(nt) <= len(kt) and kt[:len(nt)] == nt:
            out.append(k)
    if not out:
        hints = ['intitle:"%s" footballer' % name, 'intitle:"%s"' % name]
        if code in NATION:
            hints.append('intitle:"%s" %s' % (name, NATION[code]))
        for h in hints:
            for t in search_titles(name, h):
                if t not in seen:
                    seen.add(t)
                    out.append(t)
            if out:
                break
            time.sleep(2.0)
    for direct in (name, f"{name} (footballer)"):
        if direct not in out:
            out.append(direct)
    return out


def pick(title: str | None, name: str):
    """Score a resolved thumb URL: prefer the exact article, then any
    footballer-disambiguated title, then shorter titles. title==name wins."""
    if not title:
        return -1
    return 3 if toks(title) == toks(name) else (
        1 if "football" in title.lower() else 0)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: backfill_player_photos.py <seed.json>", file=sys.stderr)
        return 1
    seed_path = sys.argv[1]
    with open(seed_path, encoding="utf-8") as f:
        seed = json.load(f)

    cache = cache_titles(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), ".cache", "pageimages.json"))

    want: dict[int, dict] = {}
    for code, roster in seed["squads"].items():
        for p in roster:
            if p.get("photo"):
                continue
            want[p["name"]] = {"code": code, "cands": candidates(p["name"], code, cache)}

    thumbs: dict[str, str] = {}
    all_cands: list[str] = []
    for w in want.values():
        for t in w["cands"]:
            if t not in all_cands:
                all_cands.append(t)
    for start in range(0, len(all_cands), 45):
        q = api({
            "action": "query", "redirects": "1", "normalized": "1",
            "titles": "|".join(all_cands[start:start + 45]),
            "prop": "pageimages", "piprop": "thumbnail", "pithumbsize": "330",
            "format": "json",
        })
        body = q.get("query", {}) if "error" not in q else {}
        syn: dict[str, str] = {}
        for n in body.get("normalized", []):
            syn.setdefault(n["from"], n["to"])
        for r in body.get("redirects", []):
            syn.setdefault(r["from"], r["to"])
        for page in body.get("pages", {}).values():
            if isinstance(page, dict) and "title" in page and "thumbnail" in page:
                thumbs.setdefault(page["title"], page["thumbnail"]["source"])
                for frm, to in syn.items():
                    if to == page["title"]:
                        thumbs.setdefault(frm, page["thumbnail"]["source"])
        time.sleep(1.5)

    fixed = 0
    for name, w in want.items():
        best, best_score = None, -1
        for t in w["cands"]:
            if t in thumbs:
                sc = pick(t, name)
                if sc > best_score:
                    best, best_score = thumbs[t], sc
        if best:
            p = next(x for x in seed["squads"][w["code"]] if x["name"] == name)
            p["photo"] = best
            fixed += 1

    with open(seed_path, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=1)

    n_need = len(want)
    print(f"wrote {seed_path}: fixed {fixed}/{n_need} missing photos", file=sys.stderr)
    if fixed < n_need:
        for name, w in want.items():
            if not any(t in thumbs for t in w["cands"]):
                print(f"  still missing: {w['code']} {name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())