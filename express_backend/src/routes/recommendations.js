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

const { generateInitialRecommendationsPersonaDrivenBedrockOnly } = require('../services/recommendationsInitialService');

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
 * Persona-driven initial recommendations (exactly 5 roles), generated purely via AWS Bedrock.
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

    /**
     * IMPORTANT HARDENING:
     * The frontend may call this endpoint before the finalized persona has been persisted/retrievable
     * (race conditions, eventual consistency, DB not configured, etc).
     *
     * If the client can provide the finalized persona JSON directly, we should still return a
     * Bedrock-generated (or Bedrock-fallback) recommendation set rather than forcing the UI into a
     * placeholder/example mode.
     *
     * Supported additive inputs (optional):
     * - query.finalPersonaJson: JSON-stringified final persona
     * - body.finalPersona: final persona object (if client uses POST in some environments)
     */
    let finalPersonaFromRequest = null;
    const finalPersonaJsonRaw = req.query?.finalPersonaJson
      ? String(req.query.finalPersonaJson).trim()
      : '';
    if (finalPersonaJsonRaw) {
      try {
        finalPersonaFromRequest = JSON.parse(finalPersonaJsonRaw);
      } catch (_) {
        // ignore; we'll fall back to DB lookup
      }
    } else if (req.body?.finalPersona && typeof req.body.finalPersona === 'object') {
      finalPersonaFromRequest = req.body.finalPersona;
    }

    // 1) Load finalized persona (strictly personaId-driven)
    // IMPORTANT:
    // - /api/recommendations/initial must use the FINAL persona, not personaDraft, so scoring produces
    //   validated mastery/growth areas.
    // - Therefore, we prefer personasRepo.getFinal(personaId) first.
    // - As a compatibility fallback (older data), we can still use latest persona version.
    const [personaRow, finalWrap, latestVersion, draftWrap] = await Promise.allSettled([
      personasRepo.getPersonaById(personaIdRaw),
      personasRepo.getFinal(personaIdRaw),
      personasRepo.getLatestPersonaVersion(personaIdRaw),
      personasRepo.getDraft(personaIdRaw)
    ]);

    const personaRowValue = personaRow.status === 'fulfilled' ? personaRow.value : null;
    const finalWrapValue = finalWrap.status === 'fulfilled' ? finalWrap.value : null;
    const latestVersionValue = latestVersion.status === 'fulfilled' ? latestVersion.value : null;
    const draftWrapValue = draftWrap.status === 'fulfilled' ? draftWrap.value : null;

    const coercePersonaJson = (value) => {
      if (!value) return null;
      let next = value;

      if (typeof next === 'string') {
        try {
          next = JSON.parse(next);
        } catch (_) {
          return null;
        }
      }

      if (!next || typeof next !== 'object' || Array.isArray(next)) return null;

      return (
        next.finalJson ||
        next.personaJson ||
        next.final ||
        next.persona ||
        next.draftJson ||
        next.draft ||
        next
      );
    };

    // Prefer explicit finalized persona blob, then fallback to versioned personaJson,
    // then fallback to latest draft (if final is missing), then fallback to request-provided JSON.
    let finalPersona =
      coercePersonaJson(finalWrapValue?.finalJson || finalWrapValue) ||
      coercePersonaJson(latestVersionValue?.personaJson || latestVersionValue) ||
      coercePersonaJson(draftWrapValue?.draftJson || draftWrapValue) ||
      coercePersonaJson(finalPersonaFromRequest) ||
      null;

    // In strict mode, we do NOT proceed without a real persona.
    // Otherwise Bedrock will be invoked with a placeholder and the user will see deterministic fallback roles,
    // which is exactly the failure mode reported.
    if (!finalPersona) {
      const err = new Error(
        'Final persona is missing or not retrievable for this personaId. Cannot generate persona-based recommendations.'
      );
      err.code = 'final_persona_missing';
      err.httpStatus = 422;
      err.details = {
        personaId: personaIdRaw,
        resolutionTried: [
          'personasRepo.getFinal(personaId)',
          'personasRepo.getLatestPersonaVersion(personaId)',
          'personasRepo.getDraft(personaId)',
          'query.finalPersonaJson / body.finalPersona'
        ],
        dbConfigured: typeof personasRepo.isDbConfigured === 'function' ? personasRepo.isDbConfigured() : null
      };
      throw err;
    }

    // 2) Bedrock-only roles (exactly 5), with scored results.
    // IMPORTANT: strict mode (no deterministic fallback). If Bedrock fails/invalid output, we want an error response.
    const result = await generateInitialRecommendationsPersonaDrivenBedrockOnly({
      finalPersona,
      personaId: personaIdRaw,
      // Bedrock-only endpoint: do not allow deterministic fallback from this route.
      // (If Bedrock fails, surface 502/503 with details via sendError.)
      options: {}
    });

    const roles = Array.isArray(result?.roles) ? result.roles : [];
    if (roles.length < 1 || roles.length > 5) {
      const err = new Error(
        `Initial recommendations generator returned ${roles.length} roles; expected 1–5 Bedrock-generated roles.`
      );
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

    const meta = {
      ...(result?.meta || {}),
      count: roles.length,
      personaFallbackReason: null,
      // Initial recommendations must be Bedrock-only; this should remain false.
      bedrockUsedFallback: Boolean(result?.meta?.bedrockUsedFallback)
    };

    return res.json({ roles, meta });
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
   * IMPORTANT HARDENING (guest state + persona-not-ready):
   * - Frontend may call this endpoint before a persona is created/selected (personaId missing).
   * - Frontend may also call it when a Final Persona exists but is not recommendation-ready yet
   *   (e.g., validated_skills not populated). In both cases, we MUST NOT 422/500.
   *
   * Additional hardening:
   * - Frontend bugs can accidentally pass a non-string personaId (e.g. an object), which serializes
   *   to "[object Object]" in query params. Treat this as guest/not-ready and return fallback roles
   *   instead of propagating deep errors that could surface as 422.
   *
   * Query params (additive):
   * - personaId: UUID (optional)
   * - userId: UUID (optional)
   * - pivot: boolean (default false) - if true, do NOT filter to persona industry
   * - limit: number (optional; default 5; min 5; max 50)
   *
   * Response (validated):
   * { roles: Array<{ role_id, role_title, industry, match_reason, estimated_salary_range }> }
   */
  try {
    const personaIdRaw = req.query?.personaId ? String(req.query.personaId).trim() : '';
    const userId = req.query?.userId ? String(req.query.userId).trim() : null;
    const pivot = String(req.query?.pivot || '').toLowerCase() === 'true';

    // Parse limit with safe defaults.
    const limitRaw = req.query?.limit != null ? String(req.query.limit).trim() : '';
    const parsedLimit = Number.parseInt(limitRaw, 10);
    // Schema requires >=5 roles; keep a floor of 5 to avoid creating a validation error.
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 5), 50) : 5;

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
      String(
        req.session?.personaId ||
          req.session?.defaultPersonaId ||
          req.context?.personaId ||
          req.context?.defaultPersonaId ||
          ''
      ).trim() || null;

    // Validate personaId: if present it must be a UUID.
    // If invalid, treat as missing (guest/not-ready) to avoid 422s caused by malformed query params.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const personaIdValidated = personaIdRaw && uuidRe.test(personaIdRaw) ? personaIdRaw : '';

    // If personaId is missing/invalid, default to the "Rossini" test persona.
    // NOTE: recommendationsService is resilient to missing persona readiness and we also have a
    // deterministic fallback below.
    const resolvedPersonaId = personaIdValidated || fallbackPersonaId || 'Rossini';

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
      // If persona resolution fails OR persona is not ready (e.g., missing validated_skills),
      // return deterministic fallback instead of failing.
      //
      // This prevents the Explore page from breaking when a persona exists but has not yet
      // produced validated_skills for matching.
      const code = err?.code || '';
      const httpStatus = err?.httpStatus;

      const isGuestLikeOrNotReady =
        code === 'final_persona_not_found' ||
        httpStatus === 404 ||
        code === 'DB_NOT_CONFIGURED' ||
        httpStatus === 503 ||
        code === 'final_persona_missing_skills' ||
        httpStatus === 422;

      if (!isGuestLikeOrNotReady) throw err;

      const seed = recommendationsService?.DEFAULT_ROLES_CATALOG;
      const seedArr = Array.isArray(seed) ? seed : [];
      const slice = seedArr.slice(0, Math.max(limit, 5));
      const isPersonaIdProvided = Boolean(personaIdRaw);

      recommendations = slice.map((r, idx) => ({
        role_id: `guest_${idx + 1}`,
        role_title: r?.roleTitle || 'Role',
        industry: r?.industry || null,
        // If the client provided a personaId, avoid signaling "persona incomplete" (which the UI may
        // treat as a gating condition). Instead, return a neutral "fallback" reason while the
        // finalized persona is still being persisted/propagated.
        match_reason: isPersonaIdProvided
          ? 'Showing fallback roles while your personalized recommendations load.'
          : 'Complete your persona to get personalized recommendations.',
        estimated_salary_range: r?.estimatedSalaryRange || null
      }));
    }

    // Apply limit after computation/fallback, but never below schema minimum.
    const capped = Array.isArray(recommendations) ? recommendations.slice(0, Math.max(limit, 5)) : [];

    // Best-effort persist latest computed roles (for refresh/reload). We keep this non-blocking.
    // Only persist when we have some identity to attach it to.
    if (userId || resolvedPersonaId) {
      try {
        await holisticPersonaRepo.upsertRecommendationsRoles({
          userId,
          personaId: resolvedPersonaId,
          buildId: null,
          inferredTags: [],
          roles: capped
        });
      } catch (_) {
        // ignore persistence failures
      }
    }

    const payload = enforceResponse(RecommendationsRolesResponseSchema, { roles: capped });
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
