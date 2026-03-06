'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const holisticPersonaRepo = require('../repositories/holisticPersonaRepoAdapter');

const recommendationsService = require('../services/recommendationsService');
const personasRepo = require('../repositories/personasRepoAdapter');

const {
  parseWithZod,
  enforceResponse,
  RecommendationsRolesResponseSchema,
  RoleCompareRequestSchema,
  RoleCompareResponseSchema
} = require('../schemas/holisticPersonaSchemas');

const { generateInitialRecommendationsPersonaDrivenOnetGrounded } = require('../services/recommendationsInitialService');

const router = express.Router();

// PUBLIC_INTERFACE
function getInitialRecommendationsHandler() {
  /**
   * Return the shared handler function for initial recommendations.
   *
   * This is exported so server.js can mount the endpoint directly as a safety net
   * in case router mounting/prefixes drift across environments.
   */
  return handleInitialRecommendations;
}

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
 * Persona-driven + O*NET-grounded initial recommendations (exactly 5 roles).
 *
 * Triggered by the frontend when "Finalized Persona" is reached, to populate a RecommendationGrid.
 *
 * Query params:
 * - personaId: string (REQUIRED; used to load the finalized persona)
 *
 * Response:
 * {
 *   roles: Array<{
 *     role_id, role_title, industry, salary_lpa_range, experience_range,
 *     description, key_responsibilities, required_skills,
 *     compatibilityScore, threeTwoReport, match_metadata
 *   }>,
 *   meta?: object
 * }
 */
/**
 * Shared handler for initial recommendations.
 * NOTE: We intentionally support TWO paths below to avoid 404s caused by router
 * mount-prefix mistakes (double-prefixing /recommendations).
 */
async function handleInitialRecommendations(req, res) {
  try {
    // Prevent caching of persona-driven scoring results (persona can change quickly during debugging/iteration).
    res.set('Cache-Control', 'no-store');

    const personaIdRaw = req.query?.personaId ? String(req.query.personaId).trim() : '';
    if (!personaIdRaw) {
      const err = new Error('personaId query parameter is required.');
      err.code = 'missing_persona_id';
      err.httpStatus = 400;
      throw err;
    }

    // 1) Load finalized persona (strictly personaId-driven)
    // IMPORTANT:
    // - /api/recommendations/initial must use the FINAL persona, not personaDraft, so scoring produces
    //   validated mastery/growth areas.
    // - Therefore, we prefer personasRepo.getFinal(personaId) first.
    // - As a compatibility fallback (older data), we can still use latest persona version.
    const [personaRow, finalWrap, latestVersion] = await Promise.allSettled([
      personasRepo.getPersonaById(personaIdRaw),
      personasRepo.getFinal(personaIdRaw),
      personasRepo.getLatestPersonaVersion(personaIdRaw)
    ]);

    const finalWrapValue = finalWrap.status === 'fulfilled' ? finalWrap.value : null;
    const latestVersionValue = latestVersion.status === 'fulfilled' ? latestVersion.value : null;

    // Prefer explicit finalized persona blob, then fallback to versioned personaJson (if present).
    let finalPersona =
      (finalWrapValue && finalWrapValue.finalJson) ||
      (latestVersionValue && latestVersionValue.personaJson) ||
      null;

    // MySQL repo may return persona_json/final_json as a string; parse if needed.
    if (typeof finalPersona === 'string') {
      try {
        finalPersona = JSON.parse(finalPersona);
      } catch (_) {
        // leave as string
      }
    }

    // Ensure we got a real object.
    if (!finalPersona || typeof finalPersona !== 'object' || Array.isArray(finalPersona)) {
      const err = new Error(`Finalized Persona not found for personaId=${personaIdRaw}`);
      err.code = 'final_persona_not_found';
      err.httpStatus = 404;
      throw err;
    }

    // 2) O*NET-grounded + Bedrock-generated roles (exactly 5), with scored results
    // NOTE: This must be persona-driven; no static fallback unless O*NET and/or Bedrock fail.
    const result = await generateInitialRecommendationsPersonaDrivenOnetGrounded({
      finalPersona,
      personaId: personaIdRaw
    });

    const roles = Array.isArray(result?.roles) ? result.roles : [];
    if (roles.length !== 5) {
      const err = new Error(`Initial recommendations generator returned ${roles.length} roles; expected exactly 5.`);
      err.code = 'initial_recommendations_invalid_count';
      err.httpStatus = 502;
      throw err;
    }

    // Best-effort persist for refresh/reload (non-blocking).
    try {
      await holisticPersonaRepo.upsertRecommendationsRoles({
        userId: null,
        personaId: personaIdRaw,
        buildId: null,
        inferredTags: [],
        roles
      });
    } catch (_) {
      // ignore persistence failures
    }

    return res.json({ roles, meta: result?.meta || undefined });
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
module.exports.getInitialRecommendationsHandler = getInitialRecommendationsHandler;
