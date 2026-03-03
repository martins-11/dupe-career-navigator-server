# Backend `.env` audit (required keys)

This file records which required environment variable keys are missing/empty in the current backend `.env`, without exposing any secret values.

## Required keys checked

### Service / URLs
- BACKEND_URL
- FRONTEND_URL
- WS_URL
- SITE_URL

### CORS / proxy
- ALLOWED_ORIGINS
- ALLOWED_HEADERS
- ALLOWED_METHODS
- CORS_MAX_AGE
- COOKIE_DOMAIN
- TRUST_PROXY

### Runtime / server
- NODE_ENV
- REQUEST_TIMEOUT_MS
- RATE_LIMIT_WINDOW_S
- RATE_LIMIT_MAX
- HOST
- PORT

### Auth
- JWT_SECRET

### Database (MySQL via DB_* used by this deployment)
- DB_ENGINE
- DB_HOST
- DB_PORT
- DB_NAME
- DB_USERNAME
- DB_PASSWORD

### AWS / Bedrock
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- AWS_REGION
- BEDROCK_MODEL_ID

## Findings (from current `.env`)

### Present and non-empty
- BACKEND_URL
- FRONTEND_URL
- WS_URL
- SITE_URL
- ALLOWED_ORIGINS
- ALLOWED_HEADERS
- ALLOWED_METHODS
- CORS_MAX_AGE
- COOKIE_DOMAIN
- TRUST_PROXY
- HOST
- NODE_ENV
- REQUEST_TIMEOUT_MS
- RATE_LIMIT_WINDOW_S
- RATE_LIMIT_MAX
- PORT
- JWT_SECRET
- DB_ENGINE
- DB_HOST
- DB_PORT
- DB_NAME
- DB_USERNAME
- DB_PASSWORD
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- AWS_REGION
- BEDROCK_MODEL_ID

### Missing (not defined)
- (none)

### Present but empty
- (none)

## Notes

- This audit intentionally does **not** print any `.env` values.
- DB connectivity is driven by `src/db/connection.js` and supports both `DB_*` and `MYSQL_*` variable sets. Current `.env` uses `DB_*`.
