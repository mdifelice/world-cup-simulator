# World Cup Simulator (WCS)

A football World Cup simulation game.

## The new match-by-match flow

- **Pick a World Cup** (1930 → 2026, each with its real format)
- **Pick your nation** (any squad that entered that edition)
- **Browse your 26-man squad** — real imported call-ups are used when they
  exist; editions that haven't been scraped get a deterministic fictional
  squad, so every tournament is playable immediately
- **Watch the whole cup**, day by day: group tables and top scorers update
  live as results are revealed
- **Set your line-up before each of your nation's matches** — pick a formation
  (3-4-3 → 5-4-1), a strategy (defensive / normal / attacking) and assign your
  11 starters, with off-position penalties shown live and an auto-pick option
- **Deterministic replays** — every run carries a seed; re-running with the
  same seed and the same line-ups produces the identical tournament, so the
  moment you change a line-up only that match re-simulates and everything you
  already watched stays stable
- **Your team's matches come with a momentum chart** (per-minute dominance,
  goal spikes) and full match detail — goals, assists, extra time and penalty
  shootouts
- **Ceremonies** — Golden/Silver/Bronze Ball based on aggregate performance
  plus a Golden Boot table
- **Signed-in runs are saved** to your history and can be re-lived any time;
  anonymous visitors play the same flow without leaving a trace
- **English & Español** — switch languages from the top bar whenever you like
  (choice is remembered). Stage/rond names and match labels translate with the
  UI; team, player and host names stay authentic. New languages are just a new
  dictionary in `client/src/i18n.tsx`.

## Architecture

| Path               | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `client/`          | React + TypeScript (Vite) front end                                |
| `server/`          | Rust (axum + SQLite) REST API                                      |
| `scrapper/`        | Rust side-tool that scrapes teams/squads from the Sofascore API    |

## Data model

- **Tournaments** are format-driven: every edition stores its *phases*
  (`GROUP`/`KNOCKOUT`), so 1930 (4 groups → semis), 1934–1938 (pure knockout),
  1950 (groups + a league decider), 1954–1978 (4 groups → QF), 1982–1994
  (6 groups → R16 with best thirds), 1998–2026 (8 or 12 groups → R32/R16) all
  work from the same schema.
- **Teams** have an overall rating plus team-level attributes: `pedigree`
  (extra edge in knockouts), `home_support` (home advantage), and the dynamic
  `form`/`morale` that drift with results during a tournament. **Players** have
  18 attributes (10 outfield, 4 keeper, and 4 mental — decisions, aggression,
  concentration, leadership — that apply to every position including GK) and a
  granular position (GK, CB, LB, RB, LWB, RWB, CDM, CM, CAM, LM, RM, LW, RW,
  ST, CF). Overall = position-weighted average of attributes; match strength
  folds in the team attributes plus a squad-leadership proxy, so the favourites
  still win more often but upsets happen and winning a tournament is not a
  coin-flip every edition.
- **Call-ups** (`player_callups`) link a player to a team **and** a tournament,
  so the same player can represent different nations in different editions.
- **Auth** is Google-only (OAuth 2, no stored passwords). Reads are public;
  writes require a `Bearer` JWT from the OAuth flow.

## Quick start

### 0. One-line deploy (Docker)

The repo ships a multi-stage `Dockerfile` that builds the React frontend and
the Rust backend into a single image serving **both** the SPA and the API on
port `8080` (data persists in a named volume).

```sh
docker compose up --build -d      # → http://localhost:8080
```

or, without compose:

```sh
docker build -t wcs . && docker run -p 8080:8080 -e WCS_JWT_SECRET=your-secret wcs
```

Env vars: `WCS_ADDR` (bind address), `WCS_DATA_DIR` (SQLite location),
`WCS_STATIC_DIR` (built frontend), `WCS_JWT_SECRET` (auth signing key),
and for Google sign-in `WCS_GOOGLE_CLIENT_ID`, `WCS_GOOGLE_CLIENT_SECRET`,
`WCS_BASE_URL` (the callback base, default `http://localhost:8080`).

### 1. Backend (`server/`)

```sh
cd server
cargo run           # serves http://localhost:8080
```

Seeds a SQLite database (`server/data/wcs.sqlite`) with every World Cup
(1930–2026) on first launch, plus the full 2022 demo (32 squads + fixture).
Player/team data is added via the API or the scraper (see below).

### 2. Frontend (`client/`)

```sh
cd client
npm install
npm run dev         # serves http://localhost:5173
```

### 3. Scraper (`scrapper/`)

Fetches real squads/teams for an edition from Sofascore's public API and
outputs JSON ready to `POST` to the backend.

```sh
cd scrapper
cargo run -- --year 2022              # auto-detects the Sofascore season
cargo run -- --year 2022 --fetch-fixtures --out output
cargo run -- --help
```

> **Note on Sofascore access.** The public API rejects anonymous requests in
> most regions (`403 Forbidden`). Pass a cookie from a logged-in browser
> session to bypass it: `cargo run -- --year 2022 --cookie "sessionid=…"`.
> The API base is configurable via `--base https://api.sofascore.com/api/v1`.

The written file uses the import schema (teams/players with `rating`, which the
backend spreads into the 18 attributes). Upload with a single call — sign in
with Google first, then use the token from the URL (`#token=…`) or the browser:

```sh
curl -s -X POST localhost:8080/api/tournaments/22/import \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @output/wc2022.json
```

## API overview (server, base `/api`)

| Method | Path                                      | Description                                   |
| ------ | ----------------------------------------- | --------------------------------------------- |
| GET    | `/auth/google`                            | Start Google OAuth flow (redirects to Google) |
| GET    | `/auth/callback`                          | OAuth callback → redirects to `/#token=…`     |
| GET    | `/auth/me`                                | Current user (Bearer)                         |
| GET    | `/tournaments`                            | List tournaments (1930–2026)                  |
| POST   | `/tournaments`                            | Create a tournament (auth)                    |
| GET    | `/tournaments/:id`                        | Tournament + its phases                       |
| POST   | `/tournaments/:id/phases`                 | Replace formats/phases (auth)                 |
| GET    | `/tournaments/:id/participants`           | Teams that entered a tournament               |
| POST   | `/tournaments/:id/participants`           | Add participants + optional groups (auth)     |
| GET    | `/tournaments/:id/matches`                | Full fixture for a tournament                 |
| POST   | `/tournaments/:id/matches`                | Upload a fixture (auth)                       |
| POST   | `/tournaments/:id/fixture/generate`       | Generate the group fixture from a group draw  |
| POST   | `/tournaments/:id/import`                 | Batch-upload teams + squads (auth)            |
| POST   | `/tournaments/:id/simulate`               | Simulate the whole tournament                 |
| GET    | `/teams`                                  | List teams                                    |
| POST   | `/teams`                                  | Upload a team (auth)                          |
| GET    | `/teams/:id/players?tournament_id=`       | Squad of a team for a tournament              |
| POST   | `/teams/:id/players`                      | Upload players with call-ups (auth)           |
| POST   | `/tournaments/:id/run`                    | Full-run payload — optional `seed`/`lineups` for deterministic, line-up-controlled replays; `save` persists only when signed in |
| GET    | `/runs`                                   | Your saved runs (auth)                        |
| GET    | `/runs/:id`                               | Reopen a saved run payload (auth)             |

The `/run` endpoint simulates the *entire* tournament in memory and never writes
to the `matches` table. It returns a `RunPayload`:

- `order` — match ids in reveal order (one day per group round, then knockout),
  so the front end can unveil results progressively
- `matches` — full details per match (scores, `extra_time`, `penalties`,
  goals with scorers/assists, and `momentum` only for the focus team's games)
- `groups` — group membership used to render live group tables
- `awards` — Golden/Silver/Bronze Ball + top scorers, computed from in-memory
  player ratings across the whole run
- `champion` — the winner
- `seed` — the run's random seed (echoed back; send it on the next POST to keep
  the tournament deterministic)
- `focus_team_id` — the nation you are playing, whose matches get momentum and
  line-up control

The request body also accepts `lineups` (optional): a map keyed by
`"<stage_key>|<day>|<home_team_id>|<away_team_id>"` → `{ formation, strategy,
starting: { slot: player_id } }`, applied to the *focus team's* XI for that
match. Any slot left unset is auto-filled. Off-position picks lose rating
(`overall - penalty × 2`) and drive the "effective rating" shown in the UI and
used by the sim. Formations/strategies adjust the shape (DMF↔AMF) and the
attacking/defensive xG coefficients. Sending `save: true` persists the run
(only meaningful with a Bearer token); the default is a pure in-memory run.

When the caller sends a valid Bearer token the payload is archived in
`sim_runs` and `run_id` is filled in; anonymous calls simply get a `null`
`run_id`.

## Registering a real World Cup fixture & squads

The real fixtures from 1930→2026 are large. Two ways to populate the data:

1. **Scraper** — for modern editions, run `scrapper` to pull squads from
   Sofascore and feed the output to the API.
2. **Seed JSON** — POST a fixture payload (see `scrapper/output` examples and
   the API docs in `server/src`).