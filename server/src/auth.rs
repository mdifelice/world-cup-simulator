use axum::{
    extract::{FromRequestParts, State},
    http::request::Parts,
    response::Redirect,
    Json,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::{ApiError, ApiResult},
    models::User,
    Db,
};

const JWT_SECRET_ENV: &str = "WCS_JWT_SECRET";
const GCLIENT_ENV: &str = "WCS_GOOGLE_CLIENT_ID";
const GSECRET_ENV: &str = "WCS_GOOGLE_CLIENT_SECRET";
const BASE_URL_ENV: &str = "WCS_BASE_URL";

fn secret() -> String {
    std::env::var(JWT_SECRET_ENV).unwrap_or_else(|_| "dev-secret-change-me".into())
}

fn base_url() -> String {
    std::env::var(BASE_URL_ENV).unwrap_or_else(|_| "http://localhost:8080".into())
}

fn google_client() -> ApiResult<(String, String)> {
    let id = std::env::var(GCLIENT_ENV)
        .map_err(|_| ApiError::bad_request("Google OAuth is not configured (WCS_GOOGLE_CLIENT_ID)"))?;
    let secret = std::env::var(GSECRET_ENV)
        .map_err(|_| ApiError::bad_request("Google OAuth is not configured (WCS_GOOGLE_CLIENT_SECRET)"))?;
    if id.trim().is_empty() || secret.trim().is_empty() {
        return Err(ApiError::bad_request(
            "Google OAuth is not configured (set WCS_GOOGLE_CLIENT_ID and WCS_GOOGLE_CLIENT_SECRET)",
        ));
    }
    Ok((id, secret))
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,
    pub name: String,
    pub exp: usize,
}

fn sign(sub: i64, name: &str) -> ApiResult<String> {
    let exp = (chrono_now() + 60 * 60 * 24 * 30) as usize;
    let claims = Claims {
        sub,
        name: name.to_string(),
        exp,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret().as_bytes()),
    )
    .map_err(|e| ApiError::Internal(format!("token sign failed: {e}")))
}

fn verify_token(token: &str) -> ApiResult<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret().as_bytes()),
        &Validation::default(),
    )
    .map(|d| d.claims)
    .map_err(|_| ApiError::Unauthorized("invalid or expired token".into()))
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Authenticated user injected by the `AuthUser` extractor.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: i64,
    pub name: String,
}

impl FromRequestParts<Db> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &Db) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError::Unauthorized("missing bearer token".into()))?;
        let claims = verify_token(token)?;
        Ok(AuthUser {
            id: claims.sub,
            name: claims.name,
        })
    }
}

fn get_user_by_id(db: &rusqlite::Connection, id: i64) -> ApiResult<Option<User>> {
    let mut stmt = db.prepare(
        "SELECT id, provider, display_name, email, created_at FROM users WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map([id], |r| {
        Ok(User {
            id: r.get(0)?,
            provider: r.get(1)?,
            display_name: r.get(2)?,
            email: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    Ok(rows.next().map(|r| r).transpose()?)
}

// ---------------------------------------------------------------------------
// Google OAuth (authorization code flow, no passwords stored anywhere)
// ---------------------------------------------------------------------------

/// GET /api/auth/google — bounce the user over to Google.
pub async fn google_authorize(State(db): State<Db>) -> ApiResult<Redirect> {
    let (client_id, _) = google_client()?;
    let state = random_state();
    {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO oauth_states (state, created_at) VALUES (?1, datetime('now'))",
            rusqlite::params![state],
        )?;
    }
    let redirect_uri = format!("{}/api/auth/callback", base_url());
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&access_type=online",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode("openid email profile"),
        urlencoding::encode(&state),
    );
    Ok(Redirect::temporary(&url))
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    sub: String,
    email: Option<String>,
    name: Option<String>,
}

/// GET /api/auth/callback — Google redirects here after the user consents.
pub async fn google_callback(
    State(db): State<Db>,
    axum::extract::Query(q): axum::extract::Query<CallbackQuery>,
) -> ApiResult<Redirect> {
    let (client_id, client_secret) = google_client()?;
    let conn = db.lock().unwrap();

    // validate state
    let valid: Option<bool> = conn
        .query_row(
            "SELECT created_at >= datetime('now', '-10 minutes') FROM oauth_states WHERE state = ?1",
            [&q.state],
            |r| r.get(0),
        )
        .ok();
    conn.execute(
        "DELETE FROM oauth_states WHERE state = ?1",
        rusqlite::params![&q.state],
    )?;
    if !valid.unwrap_or(false) {
        return Err(ApiError::Unauthorized("invalid oauth state".into()));
    }

    // exchange the code for an access token
    let redirect_uri = format!("{}/api/auth/callback", base_url());
    let token_resp = ureq::post("https://oauth2.googleapis.com/token")
        .send_form(&[
            ("code", &q.code),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("redirect_uri", &redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .map_err(auth_err)?;
    let tokens: TokenResponse = token_resp.into_json().map_err(|e| {
        ApiError::Unauthorized(format!("oauth token exchange failed: {e}"))
    })?;

    // fetch the profile with the access token
    let user_resp = ureq::get("https://openidconnect.googleapis.com/v1/userinfo")
        .set("Authorization", &format!("Bearer {}", tokens.access_token))
        .call()
        .map_err(auth_err)?;
    let info: UserInfo = user_resp
        .into_json()
        .map_err(|e| ApiError::Unauthorized(format!("oauth userinfo failed: {e}")))?;

    let display_name = info
        .name
        .clone()
        .or_else(|| info.email.clone())
        .unwrap_or_else(|| "Google user".to_string());

    // upsert (provider, provider_subject)
    conn.execute(
        "INSERT INTO users (provider, provider_subject, display_name, email)
         VALUES ('google', ?1, ?2, ?3)
         ON CONFLICT(provider, provider_subject) DO UPDATE SET
            display_name = excluded.display_name,
            email = excluded.email",
        rusqlite::params![info.sub, display_name, info.email],
    )?;
    let user_id: i64 = conn.query_row(
        "SELECT id FROM users WHERE provider = 'google' AND provider_subject = ?1",
        [&info.sub],
        |r| r.get(0),
    )?;
    drop(conn);

    let token = sign(user_id, &display_name)?;
    let app_url = base_url();
    Ok(Redirect::temporary(&format!(
        "{app_url}/#token={}",
        urlencoding::encode(&token)
    )))
}

pub async fn me(user: AuthUser, State(db): State<Db>) -> ApiResult<Json<User>> {
    let conn = db.lock().unwrap();
    let user = get_user_by_id(&conn, user.id)?.ok_or_else(|| ApiError::not_found("user"))?;
    Ok(Json(user))
}

/// Returns a 32-hex-char random state token.
fn random_state() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let v: Value = serde_json::json!({ "n": now });
    format!("{:x}", v["n"].as_u64().unwrap_or(0) as u128)
        .repeat(4)
        .chars()
        .take(32)
        .collect()
}

fn auth_err(e: ureq::Error) -> ApiError {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            ApiError::Unauthorized(format!("oauth upstream error {code}: {body}"))
        }
        e => ApiError::Internal(format!("oauth transport error: {e}")),
    }
}