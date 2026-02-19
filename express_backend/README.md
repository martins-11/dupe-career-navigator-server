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

```bash
npm install
npm run dev
```

Server runs on `PORT` (default 3001).

## Database (AWS RDS) env vars (when available)

See `.env.example` for the expected PostgreSQL environment variables.

## Migrations (placeholder)

Once DB credentials are available:

```bash
npm run db:migrate
npm run db:check
```
