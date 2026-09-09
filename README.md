# World Cup Simulator (WCS)

A football World Cup simulation game.

- **Pick a World Cup** (1930 → 2026)
- **Pick your national team** (any squad that participated, with the real players of that edition)
- **Choose a formation**, assign your 11 starters
- **Simulate the tournament** following the real fixture. You can watch/intervene on your own matches; every other match is simulated automatically.
- If your team survives, you advance through the real fixture until you lift the trophy.

## Architecture

| Path               | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `client/`          | React + TypeScript (Vite) front end                                |
| `server/`          | Rust (axum + SQLite) REST API                                      |
| `scrapper/`        | Rust side-tool that scrapes teams/squads from the Sofascore API    |

## Quick start

### 1. Backend (`server/`)

```sh
cd server
cargo run           # serves http://localhost:8080
```

Seeds a SQLite database (`server/data/wcs.sqlite`) with every World Cup
(1930–2026) on first launch. Player/team data is added via the API or the
scraper (see below).

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

The written file follows the backend's import schema and can be uploaded with
a single call:

```sh
TOKEN=$(curl -s -X POST localhost:8080/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo123"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

curl -s -X POST localhost:8080/api/worldcups/22/import \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @output/wc2022.json
```

## API overview (server, base `/api`)

| Method | Path                          | Description                          |
| ------ | ----------------------------- | ------------------------------------ |
| POST   | `/auth/register`              | Create a user                        |
| POST   | `/auth/login`                 | Login, returns JWT                   |
| GET    | `/worldcups`                  | List tournaments (1930–2026)         |
| GET    | `/worldcups/:id`              | Tournament detail                    |
| POST   | `/worldcups`                  | Upload a tournament (auth)           |
| POST   | `/worldcups/:id/import`       | Batch-upload teams + squads (auth)   |
| GET    | `/teams`                      | List teams                           |
| POST   | `/teams`                      | Upload a team (auth)                 |
| GET    | `/teams/:id/players`          | Squad of a team                      |
| POST   | `/teams/:id/players`          | Upload players (auth)                |
| GET    | `/worldcups/:id/participants` | Teams that joined a tournament       |
| GET    | `/worldcups/:id/matches`      | Full fixture for a tournament (real) |
| POST   | `/worldcups/:id/matches`      | Upload a fixture (auth)              |
| POST   | `/worldcups/:id/simulate`     | Simulate the whole tournament        |

## Registering a real World Cup fixture & squads

The real fixtures from 1930→2026 are large. Two ways to populate the data:

1. **Scraper** — for modern editions, run `scrapper` to pull squads from
   Sofascore and feed the output to the API.
2. **Seed JSON** — POST a fixture payload (see `scrapper/output` examples and
   the API docs in `server/src`).