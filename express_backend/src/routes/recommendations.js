'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const holisticPersonaRepo = require('../repositories/holisticPersonaRepoAdapter');

const recommendationsService = require('../services/recommendationsService');
const bedrockService = require('../services/bedrockService');
const personasRepo = require('../repositories/personasRepoAdapter');

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

/**
 * PUBLIC_INTERFACE
 * GET /api/recommendations/initial
 *
 * Post-persona initial recommendations (exactly 5 India-market roles).
 *
 * Triggered by the frontend when "Finalized Persona" is reached, to populate a RecommendationGrid.
 *
 * Query params (optional):
 * - personaId: string (used to load the finalized persona; best-effort)
 *
 * Response:
 * { roles: Array<{ role_id, role_title, industry, salary_lpa_range, experience_range, description, key_responsibilities, required_skills }> }
 */
/**
 * Shared handler for initial recommendations.
 * NOTE: We intentionally support TWO paths below to avoid 404s caused by router
 * mount-prefix mistakes (double-prefixing /recommendations).
 */
async function handleInitialRecommendations(req, res) {
  try {
    const personaIdRaw = req.query?.personaId ? String(req.query.personaId).trim() : '';

    // Load finalized persona as the source of truth.
    // We support a few non-breaking fallback ids used in earlier scaffolding.
    const candidatePersonaIds = [personaIdRaw, 'active', 'latest', 'Rossini'].filter(Boolean);

    let finalWrap = null;
    for (const pid of candidatePersonaIds) {
      try {
        // personasRepo.getFinal returns wrapper { personaId, finalJson } in current adapter.
        // If it returns raw JSON, bedrockService handles that too.
        // eslint-disable-next-line no-await-in-loop
        finalWrap = await personasRepo.getFinal(pid);
        if (finalWrap) break;
      } catch (_) {
        // try next
      }
    }

    const finalPersona = finalWrap?.finalJson || finalWrap || null;

    const result = await bedrockService.getInitialRecommendations(finalPersona, {});
    const roles = Array.isArray(result?.roles) ? result.roles : [];

    // Best-effort persist for refresh/reload.
    try {
      await holisticPersonaRepo.upsertRecommendationsRoles({
        userId: null,
        personaId: personaIdRaw || finalWrap?.personaId || null,
        buildId: null,
        inferredTags: [],
        roles
      });
    } catch (_) {
      // ignore persistence failures
    }

    return res.json({ roles });
  } catch (err) {
    return sendError(res, err);
  }
}

/**
 * PUBLIC_INTERFACE
 * GET /api/recommendations/initial
 */
router.get('/initial', handleInitialRecommendations);

/**
 * PUBLIC_INTERFACE
 * GET /api/recommendations/initial (defensive alias)
 *
 * If someone accidentally mounts this router at `/api` instead of `/api/recommendations`,
 * this keeps the endpoint reachable at `/api/recommendations/initial`.
 */
router.get('/recommendations/initial', handleInitialRecommendations);

// PUBLIC_INTERFACE
router.get('/roles', async (req, res) => {
  /**
   * Phase 1: Return recommended roles based solely on the latest Final Persona stored in DB.
   *
   * IMPORTANT HARDENING (guest state):
   * - Frontend may call this endpoint before a persona is created/selected (personaId missing).
   * - In that case, we MUST NOT 400/500; instead return a safe deterministic recommendation list.
   * - If a session/default persona exists on the request (middleware-added), prefer that over the generic fallback.
   *
   * Query params (additive):
   * - personaId: UUID (optional)
   * - userId: UUID (optional)
   * - pivot: boolean (default false) - if true, do NOT filter to persona industry
   *
   * Response (validated):
   * { roles: Array<{ role_id, role_title, industry, match_reason, estimated_salary_range }> }
   */
  try {
    const personaIdRaw = req.query?.personaId ? String(req.query.personaId).trim() : '';
    const userId = req.query?.userId ? String(req.query.userId).trim() : null;
    const pivot = String(req.query?.pivot || '').toLowerCase() === 'true';

    /**
     * Guest-state fallback strategy:
     * 1) Prefer explicitly provided personaId.
     * 2) Else, try to find a "default persona id" attached to the request by upstream middleware.
     *    We support multiple non-breaking shapes (session may not be configured in all envs):
     *    - req.session?.personaId
     *    - req.session?.defaultPersonaId
     *    - req.context?.personaId
     *    - req.context?.defaultPersonaId
     * 3) Else, return deterministic "trending roles" based on DEFAULT_ROLES_CATALOG.
     */
    const fallbackPersonaId =
      String(req.session?.personaId || req.session?.defaultPersonaId || req.context?.personaId || req.context?.defaultPersonaId || '').trim() ||
      null;

    // Per user_input_ref: if personaId is missing, default to the "Rossini" test persona.
    // We keep the previous guest-safe behavior as a secondary fallback if Rossini is not available.
    const resolvedPersonaId = personaIdRaw || fallbackPersonaId || 'Rossini';

    let recommendations = [];

    try {
      // Primary behavior: use Final Persona when available.
      const result = await recommendationsService.getRoleRecommendationsFromFinalPersona({
        personaId: resolvedPersonaId,
        userId,
        pivot
      });
      recommendations = Array.isArray(result?.recommendations) ? result.recommendations : [];
    } catch (err) {
      // If persona resolution fails (e.g., missing final persona), return deterministic fallback instead of failing.
      // We only swallow persona-not-found / DB-not-ready style conditions; other errors still surface.
      const code = err?.code || '';
      const httpStatus = err?.httpStatus;

      const isGuestLike =
        code === 'final_persona_not_found' ||
        httpStatus === 404 ||
        code === 'DB_NOT_CONFIGURED' ||
        httpStatus === 503;

      if (!isGuestLike) throw err;

      const seed = recommendationsService?.DEFAULT_ROLES_CATALOG;
      const seedArr = Array.isArray(seed) ? seed : [];
      recommendations = seedArr.slice(0, 5).map((r, idx) => ({
        role_id: `guest_${idx + 1}`,
        role_title: r?.roleTitle || 'Role',
        industry: r?.industry || null,
        match_reason: 'Sign in or create a persona to get personalized recommendations.',
        estimated_salary_range: r?.estimatedSalaryRange || null
      }));
    }

    // Best-effort persist latest computed roles (for refresh/reload). We keep this non-blocking.
    // Only persist when we have some identity to attach it to.
    if (userId || resolvedPersonaId) {
      try {
        await holisticPersonaRepo.upsertRecommendationsRoles({
          userId,
          personaId: resolvedPersonaId,
          buildId: null,
          inferredTags: [],
          roles: recommendations
        });
      } catch (_) {
        // ignore persistence failures
      }
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
