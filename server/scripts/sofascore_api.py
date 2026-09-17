"""SoFaScore client used by the offline ingest.

Cloudflare blocks plain HTTP clients (curl/httpx get 403), so all requests are
issued from inside a warmed Chromium page via ``page.evaluate(fetch(...))``.
Responses are cached on disk by URL so an interrupted or throttled run can
resume without re-hitting the API.

Usage:
    client = SofaClient(cache_dir)
    client.get("/api/v1/unique-tournament/16/seasons")
    client.fetch_bytes("/api/v1/player/12994/image")
    client.close()
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, Page, Playwright, sync_playwright

BASE = "https://www.sofascore.com"
API = "https://api.sofascore.com"


def cache_key(cache_dir: Path, url: str) -> Path:
    h = hashlib.sha1(url.encode()).hexdigest()[:16]
    slug = url.split("/api/", 1)[-1].replace("/", "_")[:80]
    return Path(cache_dir) / f"{slug}-{h}.json"


class SofaClient:
    def __init__(
        self,
        cache_dir: Path,
        headless: bool = True,
        min_interval: float = 0.4,
        refresh: bool = False,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.min_interval = min_interval
        self.refresh = refresh
        self._last = 0.0
        self._blocked = 0
        self._pw: Playwright = sync_playwright().start()
        self._browser: Browser = self._pw.chromium.launch(headless=headless)
        self._page: Page = self._browser.new_page()
        self._warm()

    # -- lifecycle ---------------------------------------------------------
    def close(self) -> None:
        self._browser.close()
        self._pw.stop()

    def __enter__(self) -> "SofaClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- internals ---------------------------------------------------------
    def _warm(self) -> None:
        self._page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
        self._page.wait_for_timeout(2500)

    def _throttle(self) -> None:
        wait = self.min_interval - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def json(self, path: str) -> Any:
        """GET a JSON path (cached, retried). Raises RuntimeError if blocked."""
        url = path if path.startswith("http") else API + path
        cache = cache_key(self.cache_dir, url)
        if cache.exists() and not self.refresh:
            return json.loads(cache.read_text())

        last: Any = None
        for attempt in range(6):
            self._throttle()
            res = self._page.evaluate(
                """async (u) => {
                    try {
                        const r = await fetch(u, {headers: {'accept': 'application/json'}});
                        let body = null;
                        try { body = await r.json(); } catch (e) { body = null; }
                        return {status: r.status, body};
                    } catch (e) { return {status: 0, body: null}; }
                }""",
                url,
            )
            if res["status"] == 200 and res["body"] is not None:
                cache.write_text(json.dumps(res["body"]))
                self._blocked = 0
                return res["body"]
            last = res["status"]
            self._blocked += 1
            if self._blocked >= 3:
                print(f"    [sofa] blocked ({last}); re-warming Chromium…")
                self._warm()
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"GET {path} -> {last}")

    def bytes(self, path: str) -> bytes | None:
        """GET binary content (images) from inside the page. None on failure."""
        url = path if path.startswith("http") else API + path
        for attempt in range(4):
            self._throttle()
            res = self._page.evaluate(
                """async (u) => {
                    try {
                        const r = await fetch(u);
                        if (!r.ok) return {status: r.status, b64: null};
                        const buf = await r.arrayBuffer();
                        let s = '';
                        const bytes = new Uint8Array(buf);
                        const chunk = 0x8000;
                        for (let i = 0; i < bytes.length; i += chunk) {
                            s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                        }
                        return {status: 200, b64: btoa(s)};
                    } catch (e) { return {status: 0, b64: null}; }
                }""",
                url,
            )
            if res["b64"]:
                return base64.b64decode(res["b64"])
            self._blocked += 1
            if self._blocked >= 3:
                self._warm()
            time.sleep(1.2 * (attempt + 1))
        return None

    # -- convenience -------------------------------------------------------
    def seasons(self) -> list[dict]:
        return self.json("/api/v1/unique-tournament/16/seasons")["seasons"]

    def season_events(self, sid: int, max_round: int = 40) -> list[dict]:
        """All events for a season, deduped, across every published round."""
        seen: dict[int, dict] = {}
        for r in range(1, max_round + 1):
            try:
                events = self.json(
                    f"/api/v1/unique-tournament/16/season/{sid}/events/round/{r}"
                ).get("events", [])
            except RuntimeError:
                continue
            for e in events:
                seen[e["id"]] = e
        return list(seen.values())


class OfflineClient:
    """Read-only client that serves only cached responses (no browser needed)."""

    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = Path(cache_dir)

    def close(self) -> None:  # parity with SofaClient
        pass

    def __enter__(self) -> "OfflineClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def json(self, path: str) -> Any:
        url = path if path.startswith("http") else API + path
        cache = cache_key(self.cache_dir, url)
        if not cache.exists():
            raise RuntimeError(f"offline: no cache for {path}")
        return json.loads(cache.read_text())

    def bytes(self, path: str) -> bytes | None:
        return None

    seasons = SofaClient.seasons
    season_events = SofaClient.season_events
