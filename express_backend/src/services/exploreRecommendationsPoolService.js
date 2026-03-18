import holisticPersonaRepo from '../repositories/holisticPersonaRepoAdapter.js';
import personasRepo from '../repositories/personasRepoAdapter.js';

import {
  generateInitialRecommendationsPersonaDrivenBedrockOnly,
  generateInitialRecommendationsFallbackOnly,
} from './recommendationsInitialService.js';

/**
 * In-flight dedupe (per persona) to guarantee only one Bedrock call happens at a time.
 * Key: personaId (string) -> Promise<{ roles, meta }>
 */
const _inFlightByPersonaId = new Map();

/**
 * Cooldown to avoid hammering Bedrock when it is failing.
 * Key: personaId -> { untilMs: number, roles: any[], meta: object }
 */
const _cooldownByPersonaId = new Map();

function _nowMs() {
  return Date.now();
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _withTimeout(promise, ms) {
  const timeoutMs = Number.isFinite(ms) ? Math.max(50, ms) : 0;
  if (!timeoutMs) return promise;

  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).catch(() => null);
}

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

function _looksLikeLegacySimpleRecommendedRole(r) {
  /**
   * /api/recommendations/roles returns objects shaped like:
   * { role_id, role_title, industry, match_reason, estimated_salary_range }
   *
   * Those entries must NOT be used as the cached pool for Explore /initial.
   */
  if (!r || typeof r !== 'object') return false;
  return typeof r.match_reason === 'string' && r.match_reason.length > 0;
}

function _looksLikeInitialRecommendationRoleCard(r) {
  /**
   * Bedrock initial recommendations role cards typically have:
   * - match_metadata (with bedrockModelId / endpointFallbackUsed / isFallbackFilled)
   * - required_skills array
   */
  if (!r || typeof r !== 'object') return false;
  if (_looksLikeLegacySimpleRecommendedRole(r)) return false;

  const hasMatchMeta =
    r.match_metadata && typeof r.match_metadata === 'object' && !Array.isArray(r.match_metadata);
  const hasSkills = Array.isArray(r.required_skills) || Array.isArray(r.skills_required);
  return Boolean(hasMatchMeta || hasSkills);
}

function _isFallbackOnlyCachedRoles(roles) {
  /**
   * Consider cached entry non-cacheable if:
   * - it was generated via endpoint-level fallback, or
   * - every role was fallback-filled, or
   * - it isn't even the right "initial pool" shape.
   */
  const arr = Array.isArray(roles) ? roles : [];
  if (arr.length < 5) return false;

  if (!arr.some(_looksLikeInitialRecommendationRoleCard)) return true;

  const anyEndpointFallback = arr.some((r) => r?.match_metadata?.endpointFallbackUsed === true);
  if (anyEndpointFallback) return true;

  const allFallbackFilled = arr.every((r) => r?.match_metadata?.isFallbackFilled === true);
  if (allFallbackFilled) return true;

  return false;
}

function _deriveStoreCount() {
  // IMPORTANT: parseInt to avoid "5.5" quirks.
  const storeCountEnvRaw = process.env.INITIAL_RECOMMENDATIONS_STORE_COUNT;
  const storeCountParsed = Number.parseInt(String(storeCountEnvRaw ?? '').trim(), 10);

  const storeCount =
    Number.isFinite(storeCountParsed) && storeCountParsed > 5 ? Math.min(20, storeCountParsed) : 12;

  return storeCount;
}

async function _resolveFinalPersonaOrFallback({ personaId, finalPersonaOverride, personaLookupTimeoutMs }) {
  /**
   * Attempts to load the final persona quickly, but never lets DB slowness block Explore.
   * Falls back to {} if unavailable.
   */
  const finalFromOverride = _coercePersonaJson(finalPersonaOverride);
  if (finalFromOverride) return { finalPersona: finalFromOverride, personaFallbackReason: null };

  const perAttemptMs = Number.isFinite(personaLookupTimeoutMs) ? Math.max(150, personaLookupTimeoutMs) : 450;

  // Try final -> latest version -> draft, each with timeout.
  const finalWrap = await _withTimeout(personasRepo.getFinal(personaId), perAttemptMs);
  const finalPersona = _coercePersonaJson(finalWrap?.finalJson || finalWrap);
  if (finalPersona) return { finalPersona, personaFallbackReason: null };

  const latest = await _withTimeout(personasRepo.getLatestPersonaVersion(personaId), perAttemptMs);
  const fromLatest = _coercePersonaJson(latest?.personaJson || latest);
  if (fromLatest) return { finalPersona: fromLatest, personaFallbackReason: 'used_latest_version' };

  const draftWrap = await _withTimeout(personasRepo.getDraft(personaId), perAttemptMs);
  const fromDraft = _coercePersonaJson(draftWrap?.draftJson || draftWrap);
  if (fromDraft) return { finalPersona: fromDraft, personaFallbackReason: 'used_draft' };

  return { finalPersona: {}, personaFallbackReason: 'final_persona_missing_or_slow' };
}

function _cleanupCooldownIfExpired(personaId) {
  const hit = _cooldownByPersonaId.get(personaId);
  if (!hit) return null;
  if (_nowMs() >= hit.untilMs) {
    _cooldownByPersonaId.delete(personaId);
    return null;
  }
  return hit;
}

function _cooldownMs() {
  const raw = Number(process.env.EXPLORE_RECOMMENDATIONS_BEDROCK_COOLDOWN_MS || 60000);
  return Number.isFinite(raw) && raw > 0 ? Math.min(10 * 60 * 1000, raw) : 60000;
}

/**
 * PUBLIC_INTERFACE
 * Get (or create) the Explore recommendations pool for a persona.
 *
 * Contract:
 * - Only ONE Bedrock call is allowed concurrently per personaId (in-flight dedupe).
 * - Results are persisted (MySQL or memory repo) when Bedrock yields at least one non-fallback role.
 * - Other endpoints (mindmap/cards/search/filtering) should reuse this pool and filter locally.
 *
 * @param {object} params
 * @param {string} params.personaId
 * @param {any} [params.finalPersonaOverride] - Optional final persona JSON/envelope to bypass DB reads.
 * @param {object} [params.options]
 * @param {number} [params.options.storeCount] - Desired pool size to persist (default from env; min 6; max 20).
 * @param {number} [params.options.timeBudgetMs] - Time budget forwarded to Bedrock service (best effort).
 * @param {number} [params.options.cacheReadTimeoutMs] - Timeout for cache read (ms).
 * @param {number} [params.options.personaLookupTimeoutMs] - Timeout per persona lookup attempt (ms).
 * @returns {Promise<{roles: any[], meta: object}>}
 */
export async function getOrCreateExploreRecommendationsPool({
  personaId,
  finalPersonaOverride = null,
  options = {},
} = {}) {
  const pid = String(personaId || '').trim();
  if (!pid) {
    const err = new Error('personaId is required');
    err.code = 'missing_persona_id';
    err.httpStatus = 400;
    throw err;
  }

  const opt = options && typeof options === 'object' ? options : {};
  const storeCountRaw = Number.parseInt(String(opt.storeCount ?? ''), 10);
  const desiredStoreCount = Number.isFinite(storeCountRaw)
    ? Math.min(20, Math.max(6, storeCountRaw))
    : _deriveStoreCount();

  // 0) If Bedrock was failing recently, serve cooldown fallback without re-invoking.
  const cooldownHit = _cleanupCooldownIfExpired(pid);
  if (cooldownHit) {
    return {
      roles: Array.isArray(cooldownHit.roles) ? cooldownHit.roles : [],
      meta: {
        ...(cooldownHit.meta || {}),
        personaId: pid,
        cooldownHit: true,
      },
    };
  }

  // 1) Try persisted pool first.
  const cacheReadTimeoutMs = Number.isFinite(Number(opt.cacheReadTimeoutMs))
    ? Math.max(50, Number(opt.cacheReadTimeoutMs))
    : 250;

  const cached = await _withTimeout(holisticPersonaRepo.getLatestRecommendationsRoles({ personaId: pid }), cacheReadTimeoutMs);
  const cachedRoles = Array.isArray(cached?.roles) ? cached.roles : null;

  const cacheLooksLikeInitialPool =
    Array.isArray(cachedRoles) &&
    cachedRoles.length >= 5 &&
    cachedRoles.some((r) => r && typeof r === 'object' && r.match_metadata && typeof r.match_metadata === 'object');

  const cacheSatisfiesDesiredCount = Array.isArray(cachedRoles) && cachedRoles.length >= desiredStoreCount;

  if (cacheLooksLikeInitialPool && cacheSatisfiesDesiredCount && !_isFallbackOnlyCachedRoles(cachedRoles)) {
    return {
      roles: cachedRoles,
      meta: {
        personaId: pid,
        cacheHit: true,
        endpointFallbackUsed: false,
        requestedCount: desiredStoreCount,
        receivedCount: cachedRoles.length,
        uniqueAcceptedCount: cachedRoles.length,
        count: cachedRoles.length,
      },
    };
  }

  // 2) In-flight dedupe: if someone else is generating, reuse their promise.
  const existing = _inFlightByPersonaId.get(pid);
  if (existing) {
    const joined = await existing;
    return {
      roles: joined.roles,
      meta: { ...(joined.meta || {}), personaId: pid, inFlightJoin: true },
    };
  }

  // 3) Generate + persist with a single Bedrock call.
  const p = (async () => {
    const personaLookupTimeoutMs = Number.isFinite(Number(opt.personaLookupTimeoutMs))
      ? Math.max(150, Number(opt.personaLookupTimeoutMs))
      : 450;

    const { finalPersona, personaFallbackReason } = await _resolveFinalPersonaOrFallback({
      personaId: pid,
      finalPersonaOverride,
      personaLookupTimeoutMs,
    });

    const timeBudgetMs = Number(opt.timeBudgetMs);
    const hasTimeBudget = Number.isFinite(timeBudgetMs) && timeBudgetMs > 0;

    try {
      const result = await generateInitialRecommendationsPersonaDrivenBedrockOnly({
        finalPersona,
        personaId: pid,
        options: {
          timeBudgetMs: hasTimeBudget ? timeBudgetMs : undefined,
          allowPadding: true,
          maxAttempts: 1,
          requestedCount: desiredStoreCount,
          returnCount: desiredStoreCount,
          minCount: 5,
        },
      });

      const roles = Array.isArray(result?.roles) ? result.roles : [];

      const hasAnyNonFallbackRole = roles.some((r) => r?.match_metadata?.isFallbackFilled !== true);

      // Persist best-effort if we have any Bedrock-sourced role.
      if (hasAnyNonFallbackRole && roles.length >= 5) {
        try {
          await holisticPersonaRepo.upsertRecommendationsRoles({
            userId: null,
            personaId: pid,
            buildId: null,
            inferredTags: [],
            roles,
          });
        } catch (_) {
          // ignore persistence failures
        }
      }

      return {
        roles,
        meta: {
          ...(result?.meta || {}),
          personaId: pid,
          personaFallbackReason,
          cacheHit: false,
          endpointFallbackUsed: false,
          requestedCount: desiredStoreCount,
          count: roles.length,
        },
      };
    } catch (err) {
      // Bedrock failed: return deterministic fallback BUT DO NOT persist (avoid cache poisoning).
      const fallback = await generateInitialRecommendationsFallbackOnly({
        finalPersona,
        personaId: pid,
        options: { minCount: 5 },
      });

      const roles = Array.isArray(fallback?.roles) ? fallback.roles : [];

      const cooldownUntilMs = _nowMs() + _cooldownMs();
      const cooldownMeta = {
        ...(fallback?.meta || {}),
        personaId: pid,
        personaFallbackReason,
        cacheHit: false,
        endpointFallbackUsed: true,
        bedrockError: {
          code: err?.code || err?.name || 'BEDROCK_FAILED',
          message: err?.message || String(err),
        },
        cooldownSetMs: cooldownUntilMs - _nowMs(),
      };

      _cooldownByPersonaId.set(pid, {
        untilMs: cooldownUntilMs,
        roles,
        meta: cooldownMeta,
      });

      return { roles, meta: cooldownMeta };
    }
  })();

  _inFlightByPersonaId.set(pid, p);

  try {
    return await p;
  } finally {
    _inFlightByPersonaId.delete(pid);
  }
}

export default {
  getOrCreateExploreRecommendationsPool,
};
