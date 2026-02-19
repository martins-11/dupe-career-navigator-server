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

require('dotenv').config();

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

const app = express();

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
app.use('/uploads', uploadsRouter);
app.use('/extraction', extractionRouter);
app.use('/builds', buildsRouter);
app.use('/ai', aiRouter);
app.use('/orchestration', orchestrationRouter);
app.use('/documents', documentsRouter);
app.use('/personas', personasRouter);

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
