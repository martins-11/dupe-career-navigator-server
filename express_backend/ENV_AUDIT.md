# Backend env audit (Express)

Current `.env` in `career-navigator-server/express_backend` contains:

- ✅ PORT
- ✅ NODE_ENV
- ✅ HOST
- ✅ TRUST_PROXY
- ✅ CORS/URL keys: BACKEND_URL, FRONTEND_URL, WS_URL, SITE_URL, ALLOWED_*

Missing (recommended/required for full production feature set):

- DB_*:
  - DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL
- Auth:
  - JWT_SECRET
- AI:
  - CLAUDE_API_KEY (if/when Claude is called directly)
- AWS:
  - AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (optional) AWS_SESSION_TOKEN
  - (optional, if used) AWS_BEDROCK_MODEL_ID

Notes:
- The backend can still run in scaffold/memory mode without DB/AWS/Claude credentials.
- Add the missing keys to `.env` when enabling those features; see `.env.example`.
