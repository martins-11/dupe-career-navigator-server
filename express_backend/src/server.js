/**
 * Express backend entrypoint (ESM).
 *
 * Provides:
 * - Health endpoints
 * - Document storage/extracted-text persistence stubs (PostgreSQL-ready)
 *
 * Note: DB credentials are intentionally env-based and optional for now.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { buildCorsOptions } from './config/cors.js';
import { requestTimeout } from './middleware/requestTimeout.js';

import healthRouter from './routes/health.js';
import documentsRouter from './routes/documents.js';
import personasRouter from './routes/personas.js';
import uploadsRouter from './routes/uploads.js';
import extractionRouter from './routes/extraction.js';
import buildsRouter from './routes/builds.js';
import aiRouter from './routes/ai.js';
import orchestrationRouter from './routes/orchestration.js';
import docsRouter from './routes/docs.js';

import recommendationsRouter from './routes/recommendations.js';
import pathsRouter from './routes/paths.js';
import planRouter from './routes/plan.js';
import profileRouter from './routes/profile.js';
import rolesRouter from './routes/roles.js';
import multiverseExplorerRouter from './routes/multiverseExplorer.js';

import { ensureMysqlSchemaCompatible } from './db/schemaSelfHeal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load env vars from express_backend/.env, regardless of process CWD.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();

/**
 * Mindmap router is optional-but-required for the Career Navigator UI.
 * If it fails to import (e.g., import-time error), Express would otherwise skip mounting,
 * causing requests like POST /api/mindmap/graph to fall through to the JSON /api 404 handler.
 *
 * We mount it defensively and emit a clear startup-time log when it cannot be mounted.
 */
let mindmapRouter = null;
try {
  // Dynamic import keeps startup robust even if this router has optional deps.
  const mod = await import(pathToFileURL(path.resolve(__dirname, './routes/mindmap.js')).href);
  mindmapRouter = mod.default ?? mod;
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[routes] Failed to load mindmap router; /api/mindmap/* will 404:', err);
  mindmapRouter = null;
}

// Best-effort runtime-safe schema fixups for known drift issues.
// This must NOT prevent server startup (DB is optional in this project).
void ensureMysqlSchemaCompatible();

app.set('trust proxy', String(process.env.TRUST_PROXY).toLowerCase() === 'true');

app.use(helmet());
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
app.use(requestTimeout());

// Static assets (fallback): allows fetching /assets/purp.png from the backend as well.
// Note: This backend does not serve a UI; the Next.js frontend is the UI container.
app.use('/assets', express.static(path.resolve(__dirname, '../public/assets')));

app.get('/', (req, res) => {
  res.json({
    name: 'professional-persona-builder-express-backend',
    status: 'ok'
  });
});

app.get('/ui', (req, res) => {
  res
    .status(200)
    .type('text/plain')
    .send('This backend service provides an API only (no UI). Use the Next.js frontend for the user interface.');
});

app.use('/health', healthRouter);

// Compatibility mount:
// Some clients/tooling call health under /api/* (same-origin convention).
app.use('/api/health', healthRouter);

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

// Compatibility mount:
// Frontend uses /api/uploads/* (same-origin) while the canonical backend routes live at /uploads/*.
app.use('/api/uploads', uploadsRouter);

app.use('/extraction', extractionRouter);
// Compatibility mount: /api/extraction/*
app.use('/api/extraction', extractionRouter);

app.use('/builds', buildsRouter);
// Compatibility mount: /api/builds/*
app.use('/api/builds', buildsRouter);

app.use('/ai', aiRouter);
// Compatibility mount: /api/ai/*
app.use('/api/ai', aiRouter);

app.use('/orchestration', orchestrationRouter);
// Compatibility mount: /api/orchestration/* (required for POST /api/orchestration/run-all)
app.use('/api/orchestration', orchestrationRouter);

app.use('/documents', documentsRouter);

// Compatibility mount:
// Frontend calls /api/documents (same-origin) while the canonical backend routes live at /documents/*.
app.use('/api/documents', documentsRouter);

app.use('/personas', personasRouter);

// Compatibility mount:
// Frontend (and OpenAPI contract) call /api/personas/*, but historically personas router lived at /personas/*.
app.use('/api/personas', personasRouter);

app.use('/api/recommendations', recommendationsRouter);

/**
 * Safety-net mount: ensure GET /api/recommendations/initial is reachable exactly here.
 *
 * After ESM conversion, the recommendations router is a default export router object and
 * we attach `getInitialRecommendationsHandler` as a property on it.
 */
if (
  recommendationsRouter &&
  typeof recommendationsRouter.getInitialRecommendationsHandler === 'function'
) {
  app.get('/api/recommendations/initial', recommendationsRouter.getInitialRecommendationsHandler());
}

app.use('/api/paths', pathsRouter);
app.use('/api/plan', planRouter);
app.use('/api/profile', profileRouter);
app.use('/api/roles', rolesRouter);

// Multiverse Explorer (graph + details + bookmarking persistence)
app.use('/api/multiverse', multiverseExplorerRouter);

if (mindmapRouter) {
  app.use('/api/mindmap', mindmapRouter);
} else {
  // eslint-disable-next-line no-console
  console.warn('[routes] mindmap router not mounted; endpoints like POST /api/mindmap/graph will 404');
}

// Debug helper: list registered routes at runtime to verify mounting.
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
        let mount = '';
        const re = layer.regexp;

        if (re && typeof re.source === 'string') {
          /**
           * NOTE (Node 18 ESM parser safety):
           * Avoid regex literals here because some Express regexp `.source` strings can contain
           * escape sequences that make a regex literal ambiguous to the JS parser in certain
           * environments, causing a startup-time SyntaxError.
           *
           * Using `new RegExp(string)` keeps the pattern identical while avoiding parser edge cases.
           */
          const m = re.source.match(
            new RegExp('\\\\^\\\\\\\\\\\\/(.*?)\\\\\\\\\\\\/\\\\?\\\\(\\\\?=\\\\\\\\\\\\/\\\\|\\\\$\\\\)')
          );

          if (m && m[1]) mount = `/${m[1].replace(/\\\\\\\\\\\\//g, '/')}`;
          else {
            const m2 = re.source.match(
              new RegExp('\\\\^\\\\\\\\\\\\/(.*?)\\\\(\\\\?:\\\\\\\\\\\\/\\\\|\\\\$\\\\)')
            );
            if (m2 && m2[1]) mount = `/${m2[1].replace(/\\\\\\\\\\\\//g, '/')}`;
          }
        }

        collectFromStack(`${prefix}${mount}`, layer.handle.stack);
      }
    }
  }

  collectFromStack('', app._router?.stack);

  routes.sort(
    (a, b) => a.path.localeCompare(b.path) || a.methods.join(',').localeCompare(b.methods.join(','))
  );

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

/**
 * PUBLIC_INTERFACE
 * Export the Express app for integration tests and for environments that embed the server.
 */
export default app;

// Only start listening when executed as the entrypoint (not when imported by Jest/supertest).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Express backend listening on http://${host}:${port}`);
  });
}
