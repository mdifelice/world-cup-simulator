pub mod attrs;
pub mod auth;
pub mod db;
pub mod error;
pub mod fixture;
pub mod handlers;
pub mod models;
pub mod names;

use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::Request,
    routing::{get, post},
    Router,
};
use tower::service_fn;
use tower::ServiceExt;
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

    // Local player headshots written by scripts/ingest_sofascore.py.
    let photos_dir = format!("{}/photos", db::data_dir());

    let app = Router::new()
        .route("/health", get(handlers::health))
        .nest_service("/photos", ServeDir::new(photos_dir.as_str()))
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
            "/api/tournaments/{id}/oracle",
            get(handlers::tournament_oracle),
        )
        .route("/api/teams", get(handlers::list_teams).post(handlers::create_team))
        .route(
            "/api/teams/{id}/players",
            get(handlers::list_players).post(handlers::create_players),
        )
        .with_state(state)
        .layer(cors);

    // Serve the built frontend (SPA) when present.
    let app = with_frontend(app).layer(axum::middleware::from_fn(cache_control));

    let addr = std::env::var("WCS_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind address");
    tracing::info!("WCS listening on http://{addr}");
    axum::serve(listener, app.into_make_service())
        .await
        .expect("server error");
}

/// Content-addressed assets (hashed file names) are immutable for their URL,
/// so let browsers keep them; everything else (index.html / API) must be
/// revalidated so deploys appear without a hard refresh.
async fn cache_control(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let asset = req
        .uri()
        .path()
        .rsplit_once("/assets/")
        .is_some();
    let mut res = next.run(req).await;
    let value = if asset {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    res.headers_mut().insert("cache-control", value.parse().unwrap());
    res
}

/// Attaches static-file serving for `client/dist` (or `$WCS_STATIC_DIR`),
/// with an SPA fallback: unknown extensionless paths serve `index.html` so the
/// client router can own every route (e.g. the `/lab` lab page). Existing
/// files (assets, photos) are served verbatim.
fn with_frontend<S: Clone + Send + Sync + 'static>(api: Router<S>) -> Router<S> {
    let static_dir =
        std::env::var("WCS_STATIC_DIR").unwrap_or_else(|_| "../client/dist".to_string());
    let index_html = format!("{static_dir}/index.html");
    if !std::path::Path::new(&index_html).is_file() {
        tracing::warn!(
            "no built frontend found at {static_dir}/index.html — serving API only"
        );
        return api.fallback(fallback_msg);
    }
    tracing::info!("serving frontend from {static_dir}");
    let dir = static_dir.clone();
    api.fallback_service(service_fn(move |req: Request<Body>| {
        let dir = dir.clone();
        let index_html = index_html.clone();
        async move {
            let path = req.uri().path().trim_start_matches('/');
            let on_disk = if path.is_empty() {
                false
            } else {
                let candidate = std::path::Path::new(&dir).join(path);
                candidate.starts_with(&dir) && candidate.is_file()
            };
            let target = if on_disk { format!("{dir}/{path}") } else { index_html };
            let mut res = ServeFile::new(target.as_str())
                .oneshot(req)
                .await
                .expect("infallible ServeFile");
            if !on_disk {
                *res.status_mut() = axum::http::StatusCode::OK;
            }
            Ok::<_, std::convert::Infallible>(res)
        }
    }))
}

async fn fallback_msg() -> &'static str {
    "WCS API running. Frontend is not built; run `npm run build` in client/ or serve it separately."
}