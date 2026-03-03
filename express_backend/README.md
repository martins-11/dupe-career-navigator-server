# express_backend

Express backend scaffold for the Professional Persona Builder.

## What’s included (this step)

- Express server with CORS, Helmet, request timeout
- PostgreSQL (`pg`) connectivity via env vars (AWS RDS friendly)
- Placeholder migration SQL aligned to the documented schema:
  - `documents`
  - `document_extracted_text`
  - `personas` (placeholder)
  - `persona_versions` (placeholder)
- Safe stubs:
  - create/get document metadata
  - persist and retrieve latest extracted text for persona generation

## Run

From **this directory** (`career-navigator-server/express_backend`):

```bash
npm ci
npm run dev
```

Server runs on `PORT` (default 3001).

## Smoke test (curl): orchestration run-all + polling

This repo includes a curl-based end-to-end smoke test that:

- creates a document
- posts extracted text for it
- calls `POST /orchestration/run-all`
- polls `GET /builds/:id/status` until the build completes
- fetches `GET /orchestration/builds/:id` for orchestration artifacts

It is designed to run **without DB or AI credentials** (in-memory repos + placeholder persona generator).

### Usage

In one terminal, run the API:

```bash
npm run dev
```

In another terminal:

```bash
bash scripts/smoke-orchestration-run-all.sh
```

Optional environment variables:

```bash
BASE_URL=http://localhost:3001 MAX_WAIT_SECONDS=60 POLL_INTERVAL_SECONDS=1 bash scripts/smoke-orchestration-run-all.sh
```

## Database (AWS RDS) env vars (when available)

See `.env.example` for the expected PostgreSQL environment variables.

## Database scripts (migrate / check / verify)

From **this directory** (`career-navigator-server/express_backend`):

```bash
npm ci
npm run db:migrate
npm run db:check
npm run db:verify
```

Notes:
- These scripts load environment variables from `express_backend/.env`.
- If you see `Cannot find module 'dotenv'`, it means dependencies were not installed in this folder—run `npm ci` here.
- If you see `getaddrinfo ENOTFOUND ...` or connection errors, `dotenv` is working and the failure is due to DB hostname/network/credentials (not a missing dependency).
