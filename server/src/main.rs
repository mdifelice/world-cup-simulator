pub mod auth;
pub mod db;
pub mod error;
pub mod fixture;
pub mod handlers;
pub mod models;
pub mod sim;

use std::sync::{Arc, Mutex};

use axum::{
    routing::{get, post},
    Router,
};
use rusqlite::Connection;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};

use crate::auth::{google_authorize, google_callback, me};

pub type Db = Arc<Mutex<Connection>>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "wcs_server=info,tower_http=info".into()),
        )
        .init();

    let conn = db::open().expect("failed to open database");
    let state: Db = Arc::new(Mutex::new(conn));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(handlers::health))
        .route("/api/auth/google", get(google_authorize))
        .route("/api/auth/callback", get(google_callback))
        .route("/api/auth/me", get(me))
        .route("/api/tournaments", get(handlers::list_tournaments).post(handlers::create_tournament))
        .route("/api/tournaments/{id}", get(handlers::get_tournament))
        .route(
            "/api/tournaments/{id}/phases",
            post(handlers::set_tournament_phases),
        )
        .route(
            "/api/tournaments/{id}/participants",
            get(handlers::list_participants).post(handlers::add_participants),
        )
        .route(
            "/api/tournaments/{id}/matches",
            get(handlers::list_matches).post(handlers::create_matches),
        )
        .route(
            "/api/tournaments/{id}/fixture/generate",
            post(handlers::generate_fixture),
        )
        .route(
            "/api/tournaments/{id}/import",
            post(handlers::import_tournament),
        )
        .route(
            "/api/tournaments/{id}/simulate",
            post(handlers::simulate_tournament),
        )
        .route("/api/teams", get(handlers::list_teams).post(handlers::create_team))
        .route(
            "/api/teams/{id}/players",
            get(handlers::list_players).post(handlers::create_players),
        )
        .with_state(state)
        .layer(cors);

    // Serve the built frontend (SPA) when present.
    let app = with_frontend(app);

    let addr = std::env::var("WCS_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind address");
    tracing::info!("WCS listening on http://{addr}");
    axum::serve(listener, app.into_make_service())
        .await
        .expect("server error");
}

/// Attaches static-file serving for `client/dist` (or `$WCS_STATIC_DIR`),
/// with a SPA fallback to `index.html`.
fn with_frontend<S: Clone + Send + Sync + 'static>(api: Router<S>) -> Router<S> {
    let static_dir =
        std::env::var("WCS_STATIC_DIR").unwrap_or_else(|_| "../client/dist".to_string());
    if !std::path::Path::new(&static_dir).join("index.html").is_file() {
        tracing::warn!(
            "no built frontend found at {static_dir}/index.html — serving API only"
        );
        return api.fallback(fallback_msg);
    }
    tracing::info!("serving frontend from {static_dir}");
    api.fallback_service(
        ServeDir::new(&static_dir).not_found_service(ServeFile::new(format!("{static_dir}/index.html"))),
    )
}

async fn fallback_msg() -> &'static str {
    "WCS API running. Frontend is not built; run `npm run build` in client/ or serve it separately."
}