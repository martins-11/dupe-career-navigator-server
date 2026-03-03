'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const holisticPersonaRepo = require('../repositories/holisticPersonaRepoAdapter');

const recommendationsService = require('../services/recommendationsService');

const {
  parseWithZod,
  enforceResponse,
  RecommendationsRolesResponseSchema,
  RoleCompareRequestSchema,
  RoleCompareResponseSchema
} = require('../schemas/holisticPersonaSchemas');

const router = express.Router();

/**
 * Recommendations APIs.
 *
 * Phase 1 requirement:
 * - GET /api/recommendations/roles MUST be generated based solely on Final Persona fields:
 *   current_role, industry, validated_skills, seniority_level
 * - Match against roles table (seed it if empty).
 * - Return at least 5 recommended roles with:
 *   role_id, role_title, industry, match_reason, estimated_salary_range
 */

// PUBLIC_INTERFACE
router.get('/roles', async (req, res) => {
  /**
   * Phase 1: Return recommended roles based solely on the latest Final Persona stored in DB.
   *
   * Query params (additive):
   * - personaId: UUID (optional; scaffold may ignore due to current persona_final schema)
   * - userId: UUID (optional; scaffold may ignore due to current persona_final schema)
   * - pivot: boolean (default false) - if true, do NOT filter to persona industry
   *
   * Response (validated):
   * { roles: Array<{ role_id, role_title, industry, match_reason, estimated_salary_range }> }
   */
  try {
    const personaId = req.query?.personaId ? String(req.query.personaId).trim() : null;
    const userId = req.query?.userId ? String(req.query.userId).trim() : null;
    const pivot = String(req.query?.pivot || '').toLowerCase() === 'true';

    const { recommendations } = await recommendationsService.getRoleRecommendationsFromFinalPersona({
      personaId,
      userId,
      pivot
    });

    // Best-effort persist latest computed roles (for refresh/reload). We keep this non-blocking.
    try {
      await holisticPersonaRepo.upsertRecommendationsRoles({
        userId,
        personaId,
        buildId: null,
        inferredTags: [],
        roles: recommendations
      });
    } catch (_) {
      // ignore persistence failures
    }

    const payload = enforceResponse(RecommendationsRolesResponseSchema, { roles: recommendations });
    return res.json(payload);
  } catch (err) {
    return sendError(res, err);
  }
});

// PUBLIC_INTERFACE
router.post('/compare', async (req, res) => {
  /**
   * Compare two roles (Comparison Matrix logic).
   *
   * Body (validated):
   * { leftRoleId: string, rightRoleId: string, context?: object }
   *
   * Response (validated):
   * { leftRoleId, rightRoleId, comparison: { summary, differences: string[] } }
   *
   * NOTE:
   * Phase 1 work item focuses on /roles recommendations only; compare remains as-is.
   */
  try {
    const parsed = parseWithZod(RoleCompareRequestSchema, req.body || {});
    if (!parsed.ok) throw parsed.error;

    // Minimal deterministic comparison (kept from prior version, but without catalog dependency).
    const { leftRoleId, rightRoleId } = parsed.data;

    const comparison = {
      summary: `Compared ${leftRoleId} vs ${rightRoleId}.`,
      differences: [
        'Role comparisons are not yet powered by the roles catalog in Phase 1.',
        'This endpoint will be enhanced in a future phase.'
      ]
    };

    // Best-effort persist
    const buildId =
      parsed.data.context && typeof parsed.data.context === 'object' && parsed.data.context
        ? String(parsed.data.context.buildId || '').trim() || null
        : null;

    try {
      await holisticPersonaRepo.createRecommendationsCompare({
        userId: parsed.data.context?.userId ?? null,
        personaId: parsed.data.context?.personaId ?? null,
        buildId,
        leftRoleId,
        rightRoleId,
        comparison
      });
    } catch (_) {
      // ignore persistence failures
    }

    const payload = enforceResponse(RoleCompareResponseSchema, {
      leftRoleId,
      rightRoleId,
      comparison
    });

    return res.json(payload);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
