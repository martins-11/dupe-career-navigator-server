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

const {
  generateInitialRecommendationsPersonaDrivenBedrockOnly,
  generateInitialRecommendationsFallbackOnly,
} = require('../services/recommendationsInitialService');

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

    const now0 = Date.now();
    const deadline0 =
      Number(req.requestDeadlineMs) || (now0 + Number(process.env.REQUEST_TIMEOUT_MS || 30000));
    const remaining0 = Math.max(0, deadline0 - now0);

    /**
     * CRITICAL HARDENING (avoid 504 due to DB hangs):
     * If DB env vars are set but the DB is unreachable/slow, repo methods can take a long time.
     * Do NOT wait for multiple DB lookups in parallel; instead try sources in priority order with
     * short per-attempt timeouts, and keep Bedrock time budget intact.
     */
    const withTimeout = async (promise, ms) => {
      const timeoutMs = Number.isFinite(ms) ? Math.max(50, ms) : 0;
      if (!timeoutMs) return await promise;

      return await Promise.race([
        promise,
        new Promise((resolve) => {
          setTimeout(() => resolve(null), timeoutMs);
        }),
      ]).catch(() => null);
    };

    const isFallbackOnlyCachedRoles = (roles) => {
      /**
       * A cached entry should be considered "fallback-only" (and therefore non-cacheable)
       * if it was produced by the endpoint-level fallback path (Bedrock failed), or if
       * every role was fallback-filled.
       *
       * Why: we must not allow old fallback-only results to permanently block Bedrock
       * from being used once it becomes available again.
       */
      const arr = Array.isArray(roles) ? roles : [];
      if (arr.length !== 5) return false;

      const anyEndpointFallback = arr.some((r) => r?.match_metadata?.endpointFallbackUsed === true);
      if (anyEndpointFallback) return true;

      const allFallbackFilled = arr.every((r) => r?.match_metadata?.isFallbackFilled === true);
      if (allFallbackFilled) return true;

      return false;
    };

    // FAST PATH: if we already have recommendations persisted for this persona, return immediately.
    // Keep this extremely short so it never contributes to preview/proxy timeouts.
    const cached = await withTimeout(
      holisticPersonaRepo.getLatestRecommendationsRoles({ personaId: personaIdRaw }),
      250
    );
    const cachedRoles = Array.isArray(cached?.roles) ? cached.roles : null;

    // CRITICAL: never serve fallback-only cached results; they are considered stale and should be
    // regenerated via Bedrock when possible.
    if (cachedRoles && cachedRoles.length === 5 && !isFallbackOnlyCachedRoles(cachedRoles)) {
      if (req.timedOut || res.headersSent) return;
      return res.json({
        roles: cachedRoles,
        meta: {
          count: cachedRoles.length,
          personaId: personaIdRaw,
          cacheHit: true,
          endpointFallbackUsed: false,
        },
      });
    }

    // Prefer request-provided persona (fastest) if present.
    let finalPersona = coercePersonaJson(finalPersonaFromRequest);

    // If not provided, attempt repo reads in priority order with a bounded time budget.
    if (!finalPersona) {
      /**
       * IMPORTANT:
       * Preview environments frequently have an upstream timeout ~22s.
       * Keep persona lookup *tight* so we do not burn most of the request on DB/network.
       */
      const personaLookupBudgetMs = Math.min(1500, Math.max(600, Math.floor(remaining0 * 0.12)));
      const perAttemptMs = Math.max(250, Math.floor(personaLookupBudgetMs / 3));

      const finalWrapValue = await withTimeout(personasRepo.getFinal(personaIdRaw), perAttemptMs);
      finalPersona = coercePersonaJson(finalWrapValue?.finalJson || finalWrapValue);

      if (!finalPersona) {
        const latestVersionValue = await withTimeout(
          personasRepo.getLatestPersonaVersion(personaIdRaw),
          perAttemptMs
        );
        finalPersona = coercePersonaJson(latestVersionValue?.personaJson || latestVersionValue);
      }

      if (!finalPersona) {
        const draftWrapValue = await withTimeout(personasRepo.getDraft(personaIdRaw), perAttemptMs);
        finalPersona = coercePersonaJson(draftWrapValue?.draftJson || draftWrapValue);
      }
    }

    // If persona resolution fails, degrade gracefully (do not 422/504).
    let personaFallbackReason = null;
    if (!finalPersona) {
      finalPersona = {};
      personaFallbackReason = 'final_persona_missing_or_slow';
    }

    // Enforce a time budget so this endpoint returns within preview/proxy timeouts.
    const now = Date.now();
    const deadline = Number(req.requestDeadlineMs) || (now + Number(process.env.REQUEST_TIMEOUT_MS || 30000));
    const remainingMs = Math.max(0, deadline - now);

    // Conservative preview-safe cap: default 15s total generation budget (env overridable).
    const previewCapMsRaw = Number(process.env.INITIAL_RECOMMENDATIONS_MAX_MS || 15000);
    const previewCapMs =
      Number.isFinite(previewCapMsRaw) && previewCapMsRaw > 0 ? previewCapMsRaw : 15000;

    const bufferMs = 600; // leave time to respond even under load
    const timeBudgetMs = Math.max(0, Math.min(remainingMs, previewCapMs) - bufferMs);

    // Always allow padding for this endpoint so we always return exactly 5.
    const allowPadding = true;

    let result = null;
    let bedrockErrorMeta = null;

    try {
      // Keep Bedrock attempts to 1 to avoid latency stacking in previews.
      result = await generateInitialRecommendationsPersonaDrivenBedrockOnly({
        finalPersona,
        personaId: personaIdRaw,
        options: {
          timeBudgetMs,
          allowPadding,
          maxAttempts: 1,
          requestedCount: 7,
          minCount: 5,
        },
      });
    } catch (err) {
      // Convert Bedrock timeouts/errors into a fast 200 fallback (avoid 504s in previews).
      bedrockErrorMeta = {
        code: err?.code || err?.name || 'BEDROCK_FAILED',
        message: err?.message || String(err),
      };

      result = await generateInitialRecommendationsFallbackOnly({
        finalPersona,
        personaId: personaIdRaw,
        options: { minCount: 5 },
      });

      // Attach error meta without changing status code.
      result.meta = {
        ...(result.meta || {}),
        bedrockError: bedrockErrorMeta,
      };
    }

    const roles = Array.isArray(result?.roles) ? result.roles : [];
    if (roles.length !== 5) {
      // Last guard: never fail the request—return fallback.
      const fallback = await generateInitialRecommendationsFallbackOnly({
        finalPersona,
        personaId: personaIdRaw,
        options: { minCount: 5 },
      });

      const fallbackRoles = Array.isArray(fallback?.roles) ? fallback.roles : [];
      if (req.timedOut || res.headersSent) return;

      // Do NOT persist fallback-only results: they can poison the cache and prevent
      // Bedrock results from being used once Bedrock becomes available again.

      return res.json({
        roles: fallbackRoles,
        meta: {
          ...(fallback?.meta || {}),
          count: fallbackRoles.length,
          personaFallbackReason,
          cacheHit: false,
          endpointFallbackUsed: true,
          bedrockError: bedrockErrorMeta,
        },
      });
    }

    const hasAnyNonFallbackRole = roles.some((r) => r?.match_metadata?.isFallbackFilled !== true);

    // Best-effort persist for refresh/reload (non-blocking).
    // IMPORTANT: Only persist if we have at least one Bedrock-sourced role; avoid caching fallback-only.
    if (hasAnyNonFallbackRole) {
      try {
        await holisticPersonaRepo.upsertRecommendationsRoles({
          userId: null,
          personaId: personaIdRaw,
          buildId: null,
          inferredTags: [],
          roles,
        });
      } catch (_) {
        // ignore persistence failures
      }
    }

    const meta = {
      ...(result?.meta || {}),
      count: roles.length,
      personaFallbackReason,
      cacheHit: false,
    };

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
