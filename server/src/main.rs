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
use tower_http::cors::{Any, CorsLayer};

use crate::auth::{login, me, register};

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
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/users/me", get(me))
        .route("/api/worldcups", get(handlers::list_worldcups).post(handlers::create_worldcup))
        .route("/api/worldcups/{id}", get(handlers::get_worldcup))
        .route(
            "/api/worldcups/{id}/participants",
            get(handlers::list_participants).post(handlers::add_participants),
        )
        .route(
            "/api/worldcups/{id}/matches",
            get(handlers::list_matches).post(handlers::create_matches),
        )
        .route(
            "/api/worldcups/{id}/fixture/generate",
            post(handlers::generate_fixture),
        )
        .route(
            "/api/worldcups/{id}/import",
            post(handlers::import_worldcup),
        )
        .route("/api/worldcups/{id}/simulate", post(handlers::simulate_worldcup))
        .route("/api/teams", get(handlers::list_teams).post(handlers::create_team))
        .route(
            "/api/teams/{id}/players",
            get(handlers::list_players).post(handlers::create_players),
        )
        .with_state(state)
        .layer(cors);

    let addr = std::env::var("WCS_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind address");
    tracing::info!("WCS backend listening on http://{addr}");
    axum::serve(listener, app).await.expect("server error");
}