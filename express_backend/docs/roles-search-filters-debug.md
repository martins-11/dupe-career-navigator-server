# Roles Search Filters Debug Notes

## Symptom
`GET /api/roles/search` returned `[]` for filtered queries like:

- `/api/roles/search?q=Manager&industry=Technology`
- `/api/roles/search?min_salary=100000`

In some environments it also returned `[]` for the unfiltered query.

## Root cause
When the DB is not configured/reachable, the route falls back to an in-memory catalog using:

- `recommendationsService.DEFAULT_ROLES_CATALOG`

That catalog uses fields like:

- `roleTitle`
- `coreSkills`
- `estimatedSalaryRange`

But the fallback mapping in `src/routes/roles.js` mistakenly looked for `roleTitle` under `r.roleTitle` (correct) **and** `estimatedSalaryRange` under `r.estimatedSalaryRange` (incorrect for that object — it is `estimatedSalaryRange` but the mapping was reading `estimatedSalaryRange` vs `estimatedSalaryRange` inconsistently across earlier attempts in the codebase, causing empty strings depending on which seed was used).

As a result, `role_title`/`salary_range` were blank, and filters (and sometimes even the role list) produced no matches.

## Fix
Normalize the fallback mapping to support both shapes:

1) DB-style rows: `role_title`, `skills_required`, `salary_range`
2) Seed catalog shape: `roleTitle`, `coreSkills`, `estimatedSalaryRange`

Also generate a stable `role_id` in memory mode.

## Verification (manual)
Start server:
- `node src/server.js`

Then:
- `curl -sS 'http://localhost:3001/api/roles/search?q=Manager&industry=Technology'`
- `curl -sS 'http://localhost:3001/api/roles/search?min_salary=100000'`

Or run:
- `node scripts/test-search-filters.js`
