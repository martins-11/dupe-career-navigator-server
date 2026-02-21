# Migration run log (RDS / MySQL)

This file is generated to record that the project's existing MySQL migrations were executed successfully against the configured RDS database.

## Command executed

```bash
node src/db/migrate.js
```

## Output

```
[db:migrate] Migration applied: 001_init (mysql)
[db:migrate] Migration applied: 002_documents_extracted_text (mysql)
[db:migrate] Migration applied: 003_personas_and_versions (mysql)
[db:migrate] Migration applied: 004_persona_drafts (mysql)
```

## Expected schema notes

Migration `004_persona_drafts.mysql.sql.js` creates:

- `persona_draft_json` as `JSON NOT NULL`
- `alignment_score` as `DOUBLE NOT NULL DEFAULT 0`
- `created_at` as `DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`
- primary key `id` as `CHAR(36)`

## Integration test

Re-running `tests/integration/persona.generate.rds.int.test.js` reached the API successfully and printed:

- `[integration] alignment_score: 0.8`

However the test process failed due to missing environment variables for the *test runner process*:

- `Missing required env var: DB_HOST`

That indicates the schema issue is resolved, but the test execution environment must supply the DB env vars (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`, `DB_ENGINE=mysql`) when running Jest.
