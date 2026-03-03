# Backend `.env` audit (required keys)

This file records which required environment variable keys are missing/empty in the current backend `.env`, without exposing any secret values.

## Required keys checked

- PORT
- DB_HOST
- DB_USER
- DB_PASSWORD
- DB_NAME
- CLAUDE_API_KEY
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- AWS_REGION
- JWT_SECRET

## Findings (from current `.env`)

### Present and non-empty
- PORT

### Missing (not defined)
- DB_HOST
- DB_USER
- DB_PASSWORD
- DB_NAME
- CLAUDE_API_KEY
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- AWS_REGION
- JWT_SECRET

### Present but empty
- (none)

## Notes

- This audit intentionally does **not** print any `.env` values.
- Add the missing keys to `.env` (or your deployment env) to enable DB connectivity, JWT signing, and external AI/cloud integrations.
