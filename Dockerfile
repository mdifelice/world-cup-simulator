# ---------- stage 1: build the React frontend ----------
FROM node:20-alpine AS frontend
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- stage 2: compile the Rust backend ----------
FROM rust:1-bookworm AS backend
WORKDIR /app
# cache dependency builds
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs \
    && cargo build --release || true
COPY server/ ./
RUN touch src/main.rs && cargo build --release

# ---------- stage 3: minimal runtime (single binary + static files) ----------
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/target/release/wcs-server /usr/local/bin/wcs-server
COPY --from=frontend /app/dist /app/static

ENV WCS_ADDR=0.0.0.0:8080 \
    WCS_DATA_DIR=/app/data \
    WCS_STATIC_DIR=/app/static

EXPOSE 8080

# Stateless runner: every container start discards the previous SQLite database
# and rebuilds it from `data/seed/` (bind-mounted read-only at /app/data/seed),
# so a fresh deploy always boots with the current real seed data.
CMD ["sh", "-c", "rm -f /app/data/wcs.sqlite* && exec wcs-server"]