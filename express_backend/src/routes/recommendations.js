import express from 'express';
import { sendError } from '../utils/errors.js';
import { buildBedrockErrorMeta } from '../utils/bedrockErrorMeta.js';
import holisticPersonaRepo from '../repositories/holisticPersonaRepoAdapter.js';

import recommendationsService from '../services/recommendationsService.js';
import exploreRecommendationsPoolService from '../services/exploreRecommendationsPoolService.js';
import { generateDirectTrajectoryRecommendations } from '../services/directTrajectoryRecommendationsService.js';

import {
  parseWithZod,
  enforceResponse,
  RecommendationsRolesResponseSchema,
  RoleCompareRequestSchema,
  RoleCompareResponseSchema
} from '../schemas/holisticPersonaSchemas.js';



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
function _coercePersonaJson(value) {
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
}

function _readFinalPersonaFromRequest(req) {
  /**
   * Additive input (optional): allow callers to pass final persona JSON directly to avoid
   * DB timing/race issues.
   */
  let finalPersonaFromRequest = null;
  const finalPersonaJsonRaw = req.query?.finalPersonaJson ? String(req.query.finalPersonaJson).trim() : '';
  if (finalPersonaJsonRaw) {
    try {
      finalPersonaFromRequest = JSON.parse(finalPersonaJsonRaw);
    } catch (_) {
      // ignore
    }
  } else if (req.body?.finalPersona && typeof req.body.finalPersona === 'object') {
    finalPersonaFromRequest = req.body.finalPersona;
  }

  return finalPersonaFromRequest;
}

function _computeTimeBudgetMs(req) {
  // Enforce a time budget so this endpoint returns within preview/proxy timeouts.
  const now = Date.now();
  const deadline = Number(req.requestDeadlineMs) || (now + Number(process.env.REQUEST_TIMEOUT_MS || 30000));
  const remainingMs = Math.max(0, deadline - now);

  const requestTimeoutMs = Number(req.requestTimeoutMs) || Number(process.env.REQUEST_TIMEOUT_MS || 30000);

  const configuredCapMsRaw = Number(process.env.INITIAL_RECOMMENDATIONS_MAX_MS);
  const configuredCapMs =
    Number.isFinite(configuredCapMsRaw) && configuredCapMsRaw > 0 ? configuredCapMsRaw : null;

  const minCapMsRaw = Number(process.env.INITIAL_RECOMMENDATIONS_MIN_MS || 25000);
  const minCapMs = Number.isFinite(minCapMsRaw) && minCapMsRaw > 0 ? minCapMsRaw : 25000;

  const defaultCapMs = Math.min(requestTimeoutMs, Math.max(minCapMs, requestTimeoutMs));

  const effectiveCapMs = Math.min(
    requestTimeoutMs,
    Math.max(configuredCapMs != null ? configuredCapMs : defaultCapMs, minCapMs)
  );

  const bufferMs = 600; // leave time to respond even under load
  const timeBudgetMs = Math.max(0, Math.min(remainingMs, effectiveCapMs) - bufferMs);

  return timeBudgetMs;
}

function _computeStoreCount(req) {
  // Desired persisted pool size for Explore (mindmap/cards/search/filtering all reuse it).
  // Allow override via query param for debugging.
  const storeCountQueryRaw = req.query?.storeCount != null ? String(req.query.storeCount).trim() : '';
  const storeCountQueryParsed = Number.parseInt(storeCountQueryRaw, 10);

  if (Number.isFinite(storeCountQueryParsed) && storeCountQueryParsed > 5) {
    return Math.min(20, storeCountQueryParsed);
  }

  const storeCountEnvRaw = process.env.INITIAL_RECOMMENDATIONS_STORE_COUNT;
  const storeCountParsed = Number.parseInt(String(storeCountEnvRaw ?? '').trim(), 10);
  const storeCount =
    Number.isFinite(storeCountParsed) && storeCountParsed > 5 ? Math.min(20, storeCountParsed) : 12;

  return storeCount;
}

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

    const finalPersonaFromRequest = _readFinalPersonaFromRequest(req);
    const timeBudgetMs = _computeTimeBudgetMs(req);
    const storeCount = _computeStoreCount(req);

    // Prefer request-provided persona if present (fastest), otherwise the pool service loads it.
    const finalPersonaOverride = _coercePersonaJson(finalPersonaFromRequest) || null;

    const pool = await exploreRecommendationsPoolService.getOrCreateExploreRecommendationsPool({
      personaId: personaIdRaw,
      finalPersonaOverride,
      options: {
        storeCount,
        timeBudgetMs,
      },
    });

    const roles = Array.isArray(pool?.roles) ? pool.roles : [];
    const meta = pool?.meta && typeof pool.meta === 'object' ? pool.meta : {};

    if (req.timedOut || res.headersSent) return;
    return res.json({ roles, meta });
  } catch (err) {
    if (req.timedOut || res.headersSent) return;
    return sendError(res, err);
  }
}

/**
 * PUBLIC_INTERFACE
 * GET /api/recommendations/pool
 *
 * Explore recommendations pool endpoint.
 *
 * Purpose:
 * - Provide a single Bedrock-backed pool fetch that is persisted and reused across Explore views.
 * - Avoid falling back to /api/recommendations/roles (guest_*), which is a different contract.
 *
 * Query params:
 * - personaId: string (REQUIRED)
 * - storeCount: number (optional; min 6; max 20; default from env)
 * - finalPersonaJson: stringified JSON (optional; additive fast-path to avoid DB lookups)
 *
 * Response:
 * { roles: any[], meta: object }
 */
async function handleRecommendationsPool(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const personaIdRaw = req.query?.personaId ? String(req.query.personaId).trim() : '';
    if (!personaIdRaw) {
      const err = new Error('personaId query parameter is required.');
      err.code = 'missing_persona_id';
      err.httpStatus = 400;
      throw err;
    }

    const finalPersonaFromRequest = _readFinalPersonaFromRequest(req);
    const timeBudgetMs = _computeTimeBudgetMs(req);
    const storeCount = _computeStoreCount(req);

    const finalPersonaOverride = _coercePersonaJson(finalPersonaFromRequest) || null;

    const pool = await exploreRecommendationsPoolService.getOrCreateExploreRecommendationsPool({
      personaId: personaIdRaw,
      finalPersonaOverride,
      options: {
        storeCount,
        timeBudgetMs,
      },
    });

    const roles = Array.isArray(pool?.roles) ? pool.roles : [];
    const meta = pool?.meta && typeof pool.meta === 'object' ? pool.meta : {};

    if (req.timedOut || res.headersSent) return;
    return res.json({ roles, meta });
  } catch (err) {
    if (req.timedOut || res.headersSent) return;
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

/**
 * PUBLIC_INTERFACE
 * GET /api/recommendations/pool
 */
router.get('/pool', handleRecommendationsPool);

/**
 * PUBLIC_INTERFACE
 * GET /api/recommendations/pool (defensive alias)
 */
router.get('/recommendations/pool', handleRecommendationsPool);

/**
 * PUBLIC_INTERFACE
 * POST /api/recommendations/direct-trajectory
 *
 * Generates Direct Trajectory recommendations via Bedrock/Claude.
 *
 * Body:
 * {
 *   "personaId": string, (REQUIRED)
 *   "savedTargetRoleTitle"?: string | null (optional)
 * }
 *
 * Response:
 * {
 *   "currentRoleTitle": string,
 *   "recommendedDirectRoles": [
 *      { id, title, rationale, whyDirectNow, requiredSkills, keyResponsibilities, confidence }
 *   ],
 *   "meta": { modelId, bedrockUsedFallback }
 * }
 */
router.post('/direct-trajectory', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');

    const personaIdRaw = req.body?.personaId ? String(req.body.personaId).trim() : '';
    if (!personaIdRaw) {
      const err = new Error('personaId is required.');
      err.code = 'missing_persona_id';
      err.httpStatus = 400;
      throw err;
    }

    const savedTargetRoleTitle =
      req.body?.savedTargetRoleTitle != null ? String(req.body.savedTargetRoleTitle).trim() : null;

    /**
     * Additive fast-path (bugfix):
     * Allow callers (frontend proxy) to pass finalized persona JSON directly.
     * This avoids 500s when DB is not configured/reachable in preview environments.
     *
     * Accepted shapes:
     * - req.body.finalizedPersonaJson (object)
     * - req.body.finalPersonaJson (object)
     * - req.body.finalPersona (object)
     */
    const requestProvidedPersona =
      (req.body?.finalizedPersonaJson && typeof req.body.finalizedPersonaJson === 'object'
        ? req.body.finalizedPersonaJson
        : null) ||
      (req.body?.finalPersonaJson && typeof req.body.finalPersonaJson === 'object' ? req.body.finalPersonaJson : null) ||
      (req.body?.finalPersona && typeof req.body.finalPersona === 'object' ? req.body.finalPersona : null);

    let finalizedPersonaJson = requestProvidedPersona;

    if (!finalizedPersonaJson) {
      // Canonical behavior: load finalized persona from persistence.
      const final = await holisticPersonaRepo.getLatestPersonaFinalArtifact(personaIdRaw);

      finalizedPersonaJson =
        final && typeof final === 'object'
          ? final.finalJson && typeof final.finalJson === 'object'
            ? final.finalJson
            : final
          : null;
    }

    if (!finalizedPersonaJson) {
      const err = new Error(
        'Final persona not found for personaId. Provide finalizedPersonaJson in the request body or ensure DB is configured.'
      );
      err.code = 'final_persona_not_found';
      err.httpStatus = 404;
      throw err;
    }

    try {
      const result = await generateDirectTrajectoryRecommendations({
        finalizedPersonaJson,
        savedTargetRoleTitle,
      });

      return res.json(result);
    } catch (err) {
      /**
       * Safe-fail fallback:
       * If Bedrock is not configured (common in preview) or errors, return deterministic recommendations
       * so the UI does not hard-fail with a 500.
       */
      const message = String(err?.message || '');
      const code = String(err?.code || '');

      const bedrockMisconfig =
        code === 'missing_aws_region' ||
        code === 'CredentialsProviderError' ||
        code === 'UnrecognizedClientException' ||
        code === 'AccessDeniedException' ||
        code === 'bedrock_response_not_json' ||
        code === 'bedrock_no_json_object' ||
        code === 'bedrock_invalid_extracted_json' ||
        message.toLowerCase().includes('missing aws region');

      if (!bedrockMisconfig) throw err;

      return res.json({
        currentRoleTitle: String(finalizedPersonaJson?.profile?.headline || finalizedPersonaJson?.current_role || 'Current role'),
        recommendedDirectRoles: [
          {
            id: 'direct-fallback-1',
            title: 'Senior Associate / Specialist (Adjacent Domain)',
            rationale: 'Fallback recommendation (AI unavailable). Chosen as a realistic next step adjacent to current strengths.',
            whyDirectNow: ['Strong overlap with existing experience; minimal role change required.'],
            requiredSkills: ['Communication', 'Problem solving', 'Stakeholder management'],
            keyResponsibilities: ['Own a scoped workstream', 'Collaborate cross-functionally', 'Report outcomes and metrics'],
            confidence: 45,
          },
          {
            id: 'direct-fallback-2',
            title: 'Team Lead (Current Discipline)',
            rationale: 'Fallback recommendation (AI unavailable). A direct next step for growth within the same discipline.',
            whyDirectNow: ['Builds on existing strengths; adds light leadership responsibilities.'],
            requiredSkills: ['Mentoring', 'Planning', 'Execution'],
            keyResponsibilities: ['Guide day-to-day execution', 'Support teammates', 'Improve processes'],
            confidence: 42,
          },
          {
            id: 'direct-fallback-3',
            title: 'Project Coordinator / Program Associate',
            rationale: 'Fallback recommendation (AI unavailable). Often a direct move leveraging organization and delivery skills.',
            whyDirectNow: ['Transfers well from many roles; limited upskilling needed.'],
            requiredSkills: ['Project coordination', 'Documentation', 'Time management'],
            keyResponsibilities: ['Track milestones', 'Coordinate stakeholders', 'Maintain plans and status reports'],
            confidence: 40,
          },
          {
            id: 'direct-fallback-4',
            title: 'Operations Analyst',
            rationale: 'Fallback recommendation (AI unavailable). Direct step focusing on analysis and process improvement.',
            whyDirectNow: ['Uses structured thinking; incremental skill lift.'],
            requiredSkills: ['Analysis', 'Excel/Sheets', 'Process improvement'],
            keyResponsibilities: ['Analyze workflows', 'Recommend improvements', 'Monitor KPIs'],
            confidence: 38,
          },
          {
            id: 'direct-fallback-5',
            title: 'Customer/Client Success Specialist',
            rationale: 'Fallback recommendation (AI unavailable). Direct path where domain knowledge + communication are key.',
            whyDirectNow: ['Leverages existing knowledge and communication; minimal tooling upskilling.'],
            requiredSkills: ['Customer communication', 'Issue triage', 'Product/domain knowledge'],
            keyResponsibilities: ['Support customer goals', 'Resolve issues', 'Identify upsell/renewal risks'],
            confidence: 36,
          },
        ],
        meta: {
          modelId: null,
          bedrockUsedFallback: true,
          note: 'Returned deterministic fallback because Bedrock is unavailable/misconfigured in this environment.',
        },
      });
    }
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * POST /api/recommendations/direct-trajectory (defensive alias)
 */
router.post('/recommendations/direct-trajectory', async (req, res) => {
  // If mounted at /api instead of /api/recommendations, preserve reachability.
  // Delegate to the canonical handler path by calling next router match.
  // Easiest safe behavior: just run the same logic by forwarding to the same handler.
  try {
    req.url = '/direct-trajectory';
    return router.handle(req, res);
  } catch (err) {
    return sendError(res, err);
  }
});

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

    /**
     * IMPORTANT (bugfix):
     * Do NOT persist /api/recommendations/roles output into the shared `recommendations_roles` store.
     *
     * Why:
     * - That persistence is used as the Explore "source of truth" pool and by /api/recommendations/initial caching.
     * - /api/recommendations/roles returns a *different* role shape (RecommendedRoleSchema) and is often
     *   deterministic/fallback-like.
     * - Persisting it can overwrite Bedrock initial recommendations, causing the UI to always show fallback roles.
     *
     * If we need persistence for this endpoint in the future, introduce a separate table/column or a dedicated repo key.
     */

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

/**
 * Compatibility: server.js expects to be able to access this helper from the imported router.
 * In ESM, we attach it as a property on the router object.
 */
router.getInitialRecommendationsHandler = getInitialRecommendationsHandler;

export default router;
