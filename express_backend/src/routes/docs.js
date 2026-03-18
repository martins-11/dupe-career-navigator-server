import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { getOpenApiSpec } from '../openapi/spec.js';

const router = express.Router();

/**
 * API documentation routes.
 *
 * - GET /docs -> Swagger UI
 * - GET /docs/openapi.json -> raw OpenAPI JSON
 */

router.get('/openapi.json', (req, res) => {
  const spec = getOpenApiSpec();
  res.json(spec);
});

router.use(
  '/',
  swaggerUi.serve,
  swaggerUi.setup(getOpenApiSpec(), {
    explorer: true,
    customSiteTitle: 'Professional Persona Builder API Docs'
  })
);

export default router;
