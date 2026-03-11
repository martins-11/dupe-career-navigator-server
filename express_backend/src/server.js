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

const app = express();

// Mindmap router is optional-but-required for the Career Navigator UI.
// If it fails to import (e.g., require-time error), Express would otherwise silently skip mounting,
// causing requests like POST /api/mindmap/graph to fall through to the JSON /api 404 handler.
// We mount it defensively and emit a clear startup-time log when it cannot be mounted.
let mindmapRouter = null;
try {
  mindmapRouter = require('./routes/mindmap');
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[routes] Failed to load mindmap router; /api/mindmap/* will 404:', err);
  mindmapRouter = null;
}

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

if (mindmapRouter) {
  app.use('/api/mindmap', mindmapRouter);
} else {
  // eslint-disable-next-line no-console
  console.warn('[routes] mindmap router not mounted; endpoints like POST /api/mindmap/graph will 404');
}

// Debug helper: list registered routes at runtime to verify mounting.
// This is safe to leave in place; it contains no secrets and helps diagnose mis-mounted routers.
app.get('/api/_debug/routes', (req, res) => {
  const routes = [];

  function collectFromStack(prefix, stack) {
    for (const layer of stack || []) {
      if (!layer) continue;

      // Direct route on app/router
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
        routes.push({
          path: `${prefix}${layer.route.path}`,
          methods: methods.map((m) => m.toUpperCase())
        });
        continue;
      }

      // Nested router
      if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
        // Best-effort extraction of mount path from regexp (Express internals).
        // If we can't parse it, we still traverse with the same prefix.
        let mount = '';
        const re = layer.regexp;
        if (re && typeof re.source === 'string') {
          // Handles common forms like ^\\/api\\/mindmap\\/?(?=\\/|$)
          const m = re.source.match(/\\^\\\\\\\/(.*?)\\\\\\\/\\?\\(\\?=\\\\\\\/\\|\\$\\)/);
          if (m && m[1]) mount = `/${m[1].replace(/\\\\\\\//g, '/')}`;
          else {
            const m2 = re.source.match(/\\^\\\\\\\/(.*?)\\(\\?:\\\\\\\/\\|\\$\\)/);
            if (m2 && m2[1]) mount = `/${m2[1].replace(/\\\\\\\//g, '/')}`;
          }
        }
        collectFromStack(`${prefix}${mount}`, layer.handle.stack);
      }
    }
  }

  collectFromStack('', app._router?.stack);

  // Sort for readability
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.methods.join(',').localeCompare(b.methods.join(',')));

  res.json({ count: routes.length, routes });
});

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
