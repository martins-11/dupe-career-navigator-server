'use strict';

/**
 * Express backend entrypoint.
 *
 * Provides:
 * - Health endpoints
 * - Document storage/extracted-text persistence stubs (PostgreSQL-ready)
 *
 * Note: PostgreSQL credentials are intentionally env-based and optional for now.
 */

const path = require('path');

// Always load env vars from express_backend/.env, regardless of process CWD.
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { buildCorsOptions } = require('./config/cors');
const { requestTimeout } = require('./middleware/requestTimeout');

const healthRouter = require('./routes/health');
const documentsRouter = require('./routes/documents');
const personasRouter = require('./routes/personas');
const uploadsRouter = require('./routes/uploads');
const extractionRouter = require('./routes/extraction');
const buildsRouter = require('./routes/builds');
const aiRouter = require('./routes/ai');
const orchestrationRouter = require('./routes/orchestration');
const docsRouter = require('./routes/docs');

const recommendationsRouter = require('./routes/recommendations');
const pathsRouter = require('./routes/paths');
const planRouter = require('./routes/plan');
const profileRouter = require('./routes/profile');
const rolesRouter = require('./routes/roles');
const mindmapRouter = require('./routes/mindmap');

const app = express();

// Best-effort runtime-safe schema fixups for known drift issues.
// This must NOT prevent server startup (DB is optional in this project).
const { ensureMysqlSchemaCompatible } = require('./db/schemaSelfHeal');
void ensureMysqlSchemaCompatible();

app.set('trust proxy', String(process.env.TRUST_PROXY).toLowerCase() === 'true');

app.use(helmet());
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
app.use(requestTimeout());

app.get('/', (req, res) => {
  res.json({
    name: 'professional-persona-builder-express-backend',
    status: 'ok'
  });
});

app.use('/health', healthRouter);

/**
 * Route mounts (verification note):
 * The following 5 base routers are required and must remain mounted (non-404 reachability):
 * - /uploads        (e.g., POST /uploads/documents)
 * - /extraction     (e.g., POST /extraction/normalize)
 * - /builds         (e.g., POST /builds)
 * - /ai             (e.g., POST /ai/personas/generate)
 * - /orchestration  (e.g., POST /orchestration/start)
 */
app.use('/uploads', uploadsRouter);
app.use('/extraction', extractionRouter);
app.use('/builds', buildsRouter);
app.use('/ai', aiRouter);
app.use('/orchestration', orchestrationRouter);

app.use('/documents', documentsRouter);
app.use('/personas', personasRouter);

// Compatibility mount:
// Frontend (and OpenAPI contract) call /api/personas/*, but historically personas router lived at /personas/*.
// Mounting both keeps existing clients working and makes /api/personas/target-role reachable.
app.use('/api/personas', personasRouter);

app.use('/api/recommendations', recommendationsRouter);

// Safety-net mount: ensure GET /api/recommendations/initial is reachable exactly here,
// even if router mounting changes in some environments.
if (typeof recommendationsRouter.getInitialRecommendationsHandler === 'function') {
  app.get(
    '/api/recommendations/initial',
    recommendationsRouter.getInitialRecommendationsHandler()
  );
}
app.use('/api/paths', pathsRouter);
app.use('/api/plan', planRouter);
app.use('/api/profile', profileRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/mindmap', mindmapRouter);

/**
 * Ensure the API surface never returns HTML 404 pages.
 * This prevents frontend JSON parsing crashes when a route is missing/mis-mounted.
 *
 * IMPORTANT:
 * Keep this AFTER all intended /api/* route mounts (including /api/mindmap),
 * otherwise valid routes can incorrectly fall through to this handler.
 */
app.use('/api', (req, res) => {
  return res.status(404).json({
    error: 'not_found',
    message: `No route for ${req.method} ${req.originalUrl}`
  });
});

app.use('/docs', docsRouter);

// Generic error handler (keeps responses safe)
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'internal_server_error'
  });
});

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Express backend listening on http://${host}:${port}`);
});
