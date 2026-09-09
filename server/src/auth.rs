use axum::{
    extract::{FromRequestParts, State},
    http::request::Parts,
    Json,
};
use bcrypt::{hash, verify, DEFAULT_COST};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::{error::{ApiError, ApiResult}, models::{AuthOut, LoginIn, RegisterIn, User}, Db};

const JWT_SECRET_ENV: &str = "WCS_JWT_SECRET";

fn secret() -> String {
    std::env::var(JWT_SECRET_ENV).unwrap_or_else(|_| "dev-secret-change-me".into())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,
    pub username: String,
    pub exp: usize,
}

fn sign(sub: i64, username: &str) -> ApiResult<String> {
    let exp = (chrono_now() + 60 * 60 * 24 * 30) as usize;
    let claims = Claims {
        sub,
        username: username.to_string(),
        exp,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret().as_bytes()),
    )
    .map_err(|e| ApiError::Internal(format!("token sign failed: {e}")))
}

pub fn verify_token(token: &str) -> ApiResult<Claims> {
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

/// Authenticated user info injected by the `AuthUser` extractor.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: i64,
    pub username: String,
}

impl FromRequestParts<Db> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &Db,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError::Unauthorized("missing bearer token".into()))?;
        let claims = verify_token(token)?;
        Ok(AuthUser {
            id: claims.sub,
            username: claims.username,
        })
    }
}

fn get_user_by_id(db: &rusqlite::Connection, id: i64) -> ApiResult<Option<User>> {
    let mut stmt = db
        .prepare("SELECT id, username, created_at FROM users WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], |r| {
        Ok(User {
            id: r.get(0)?,
            username: r.get(1)?,
            created_at: r.get(2)?,
        })
    })?;
    Ok(rows.next().map(|r| r).transpose()?)
}

pub async fn register(State(db): State<Db>, Json(input): Json<RegisterIn>) -> ApiResult<Json<AuthOut>> {
    let username = input.username.trim().to_string();
    if username.len() < 3 {
        return Err(ApiError::bad_request("username must be at least 3 chars"));
    }
    if input.password.len() < 6 {
        return Err(ApiError::bad_request("password must be at least 6 chars"));
    }
    let password_hash = hash(&input.password, DEFAULT_COST)
        .map_err(|e| ApiError::Internal(format!("bcrypt failed: {e}")))?;

    let conn = db.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO users (username, password_hash) VALUES (?1, ?2)",
        rusqlite::params![username, password_hash],
    );
    match res {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            return Err(ApiError::Conflict("username already taken".into()))
        }
        Err(e) => return Err(e.into()),
    }
    let id = conn.last_insert_rowid();
    let user = get_user_by_id(&conn, id)?.unwrap();
    drop(conn);

    let token = sign(user.id, &user.username)?;
    Ok(Json(AuthOut { token, user }))
}

pub async fn login(State(db): State<Db>, Json(input): Json<LoginIn>) -> ApiResult<Json<AuthOut>> {
    let conn = db.lock().unwrap();
    let row = conn
        .query_row(
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ?1",
            [&input.username],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;

    let Some((id, username, password_hash, created_at)) = row else {
        return Err(ApiError::Unauthorized("invalid credentials".into()));
    };
    drop(conn);

    let ok = verify(&input.password, &password_hash).unwrap_or(false);
    if !ok {
        return Err(ApiError::Unauthorized("invalid credentials".into()));
    }

    let token = sign(id, &username)?;
    Ok(Json(AuthOut {
        token,
        user: User {
            id,
            username,
            created_at,
        },
    }))
}

pub async fn me(user: AuthUser, State(db): State<Db>) -> ApiResult<Json<User>> {
    let conn = db.lock().unwrap();
    let user = get_user_by_id(&conn, user.id)?.ok_or_else(|| ApiError::not_found("user"))?;
    Ok(Json(user))
}

// small helper to keep rusqlite's OptionalExtension import available
use rusqlite::OptionalExtension;