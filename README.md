# World Cup Simulator (WCS)

A football World Cup simulation game, playable in the browser. Every World Cup
from 1930 to 2026 ships with its **real** qualifiers, squads, and group
schedules, and the whole tournament plays out in a seeded, deterministic
in-browser engine.

## Features

- **Pick any World Cup (1930 → 2026)** — each edition keeps its real format:
  13-team 1930 group stage, pure-knockout 1934/1938, the 1950 league decider,
  1982–1994 second-round group phases, and the 48-team 2026 bracket.
- **Pick your nation** and browse the real 23-man squad (or a generated squad
  if a seed squad is missing — nothing is ever unplayable).
- **Watch the cup day by day**: group tables, standings and top scorers update
  live as results are revealed. Your matches come with a per-minute momentum
  chart, goals/assists/cards, and extra time + penalty shootouts.
- **Set your line-up** before each of your nation's matches — formation,
  strategy and the XI. The picker lists players by shirt number, and supports
  click-to-arm, double-click-to-place (best-position fit), and drag & drop onto
  or across the pitch. Off-position picks lose rating, shown live.
- **Deterministic seeded engine** — a run carries a random seed; replaying the
  same seed and line-ups reproduces the identical tournament. Change one line-up
  and only that match re-simulates; everything already revealed stays stable.
- **Speed control** — watch in real time or fast-forward through the weeks.
  Play your own matches live; **simulate** the rest instantly, or watch the
  whole cup as a neutral spectator.
- **Ceremonies** — Golden/Silver/Bronze Ball for the best performers plus a
  top-scorers table, and a shareable result card at the end.
- **English & Español** — switch languages from the top bar; your choice is
  remembered. New languages are just another dictionary in `client/src/i18n.tsx`.

## Real World Cup data

`data/seed/{year}.json` holds the real data for every edition: participating
teams with ratings, squads (players, positions, shirt numbers, attrs, and
Wikimedia headshots where available), and the real group fixtures with kickoff
times for the more recent editions. When the server starts it seeds its SQLite
database from these files, so the API serves real squads for every tournament
out of the box. Files were built by the ingestion scripts in `server/scripts/`
(SoFaScore and openfootball scrapers, WC2026 statistics, EA FC ratings) —
re-run them to refresh data.

## Architecture

| Path                      | Description                                                          |
| ------------------------- | ------------------------------------------------------------------- |
| `client/`                 | React + TypeScript (Vite) front end                                  |
| `server/`                 | Rust (axum + SQLite) REST API + static hosting of the built SPA     |
| `data/`                   | Real seed data (`data/seed/*.json`, tracked) + runtime SQLite & raw CSV sources (untracked) |
| `server/scripts/`         | Python ingestion tooling (scrape/refresh seed data)                  |
| `client/playwright/`, `client/tests/` | E2E checks (`npm run test:e2e`) and engine regression tests (`npm test`) |

The simulation itself runs **client-side** in `client/src/sim/`. The Rust
server stores the tournament/team/player data and exposes it through the `/api`
REST surface (above all the `/oracle` endpoint, which supplies the engine with
the full real dataset for an edition). The client generates and runs the
tournament, and archives completed runs in the browser's `localStorage`.

## Quick start

### 0. One-line deploy (Docker)

```sh
docker compose up --build -d      # → http://localhost:8080
```

The multi-stage `Dockerfile` builds the React frontend + Rust backend into one
image serving both the SPA and the API. Data persists in a named volume, and
`data/seed/` is bind-mounted so the container always seeds real data on boot.

### 1. Backend (`server/`)

```sh
cd server
cargo run          # serves API + built frontend on http://localhost:8080
```

On first launch the server seeds `data/wcs.sqlite` with every real World Cup
(1930–2026). See "Data directory" below for how that folder is located.

### 2. Frontend during development (`client/`)

```sh
cd client
npm install
npm run dev        # Vite dev server on http://localhost:5173 (proxies the API)
```

### 3. Tests

```sh
cd client
npm test           # engine regression suite (seed determinism, fixture formats…)
npm run test:e2e   # Playwright flow checks against a running server + built dist
```

## Data directory

The server needs one folder holding its SQLite database, the `seed/` files and
the `photos/` output. It is resolved, in order:

1. the `WCS_DATA_DIR` environment variable (used by Docker, where the volume
   mounts at `/app/data`);
2. a `data/seed` folder found by walking up from the working directory — so
   `cargo run` inside `server/` finds the repo-root `data/`;
3. a bare `data` folder next to the process (legacy layout).

Runtime artifacts (the `.sqlite*` database and raw CSV sources) are gitignored;
only `data/seed/*.json` is committed.

## API overview (server, base `/api`)

Reads are public. Writes (creating/editing tournaments, teams, players —
mainly for the data pipeline and the editor) require a Google OAuth `Bearer`
token from `/api/auth/google`.

| Method | Path                                        | Description                                   |
| ------ | ------------------------------------------- | --------------------------------------------- |
| GET    | `/health`                                   | Liveness probe                                |
| GET    | `/auth/google` · `/auth/callback` · `/auth/me`  | Google OAuth flow + current user          |
| GET    | `/tournaments`                              | All editions (1930–2026)                      |
| POST   | `/tournaments`                              | Create a tournament (auth)                    |
| GET/PUT/DELETE | `/tournaments/{id}`                  | Tournament + its phases                       |
| POST   | `/tournaments/{id}/phases`                  | Replace format/phases (auth)                  |
| POST   | `/tournaments/{id}/fork`                    | Fork for editing (auth)                       |
| GET/POST | `/tournaments/{id}/participants`          | Teams that entered (auth for writes)          |
| PUT/DELETE | `/tournaments/{id}/participants/{team_id}` | Edit a participant                       |
| GET/POST | `/tournaments/{id}/matches`              | Fixture for a tournament (auth for writes)    |
| PUT/DELETE | `/tournaments/{id}/matches/{match_id}`  | Edit a match (auth)                       |
| POST   | `/tournaments/{id}/fixture/generate`        | Generate group fixtures from the draw (auth)  |
| POST   | `/tournaments/{id}/import`                  | Batch-upload teams + squads (auth)            |
| GET    | `/tournaments/{id}/oracle`                  | **Full real dataset** for the client engine   |
| GET/POST | `/teams`                                   | List/create teams (auth)                      |
| PUT/DELETE | `/teams/{id}`                             | Edit a team (auth)                            |
| GET/POST | `/teams/{id}/players`                     | Squad of a team for a tournament              |
| PUT/DELETE | `/teams/{id}/players/{player_id}`        | Edit a player (auth)                          |
| POST   | `/photos`                                   | Upload a player headshot (auth)               |

`GET /tournaments/{id}/oracle` returns everything the in-browser engine needs
to play an edition: the tournament + phases, participants, every squad with
positions/attrs/headshots, group membership, and the real fixture list with
kickoffs. The client engine never mutates the server; a simulated cup is
reproducible from its seed alone.

## Data model

- **Tournaments** are format-driven: each edition stores its *phases*
  (`GROUP`/`KNOCKOUT`), so 1930 (groups → semis), 1934–38 (pure knockout),
  1950 (groups + a league decider), 1954–78 (groups → QF), 1982–94 (groups →
  second round → …), and 1998–2026 (8/12/… groups → R32/R16) all fit one
  schema.
- **Teams** carry an overall rating plus team attributes: `pedigree` (extra edge
  in knockouts), `home_support` (home advantage), and dynamic `form`/`morale`
  that drift with results. **Players** have 18 attributes (10 outfield, 4
  keeper, 4 mental) and granular positions (GK, CB, LB, RB, LWB, RWB, CDM, CM,
  CAM, LM, RM, LW, RW, ST, CF). Overall = position-weighted average;
  match strength folds team attributes and leadership in, so favourites win
  more often but upsets happen.
- **Call-ups** (`player_callups`) link a player to a team *and* a tournament,
  so one player can represent different nations in different editions.
- **Auth** is Google-only (OAuth 2, no stored passwords); reads are public,
  writes need a `Bearer` JWT.

## Data tooling & editing

- `server/scripts/ingest_sofascore.py` / `ingest_historical.py` — build
  `data/seed/{year}.json` from SoFaScore and openfootball data.
- `server/scripts/scrape_wc2026.py` + `ingest_wc2026_stats.py` — squads and
  statistics for the 48-team 2026 edition (uses `data/wc2026/*.csv`).
- `server/scripts/ingest_fc_ratings.py` — apply EA FC attribute ratings on top
  of a seed (reads an EA players CSV, e.g. `data/EAFC26-Men.csv`).
- `server/scripts/backfill_player_photos.py` — fill missing Wikipedia headshots
  in a seed file.
- **Lab** (`/lab`) — the client's match-level sandbox: pick two teams, tweak
  formations/strategies/overrides and replay the same seed to compare outcomes.
- **Editor** (`/editor`) — browser CRUD over tournaments, phases, teams and
  squads through the REST API (sign in with Google first).
- `client/scripts/fetch-oracles.mjs` (`npm run fixtures`) — snapshot the real
  oracles into `client/tests/fixtures/` for the engine regression suite.