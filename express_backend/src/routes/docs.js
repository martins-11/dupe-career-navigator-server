'use strict';

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const { getOpenApiSpec } = require('../openapi/spec');

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

module.exports = router;
