import holisticPersonaRepo from '../repositories/holisticPersonaRepoAdapter.js';
import exploreRecommendationsPoolService from './exploreRecommendationsPoolService.js';

function _normStr(v) {
  return String(v || '').trim();
}

function _safeSlice(arr, n) {
  return (Array.isArray(arr) ? arr : []).slice(0, n);
}

/**
 * Token-based matching across multiple fields, requiring ALL tokens to be present.
 * This is intentionally deterministic and does NOT call Bedrock.
 */
function _matchesQuery(role, qLower) {
  if (!qLower) return true;

  const title = _normStr(role?.title || role?.role_title || role?.roleTitle).toLowerCase();
  const industry = _normStr(role?.industry).toLowerCase();
  const desc = _normStr(role?.description).toLowerCase();

  const skillsRaw = role?.required_skills || role?.skills_required || role?.skills || [];
  const skills = (Array.isArray(skillsRaw) ? skillsRaw : [])
    .map((s) => (typeof s === 'string' ? s : s?.name || s?.skill || s?.label))
    .map((s) => _normStr(s).toLowerCase())
    .filter(Boolean);

  const haystack = `${title} ${industry} ${desc} ${skills.join(' ')}`;
  const tokens = qLower.split(/\s+/g).map((t) => t.trim()).filter(Boolean);

  return tokens.every((t) => haystack.includes(t));
}

function _looksLikeLegacySimpleRecommendedRole(r) {
  // /api/recommendations/roles shape (must NOT be treated as Explore pool)
  return Boolean(r && typeof r === 'object' && typeof r.match_reason === 'string' && r.match_reason.length > 0);
}

function _looksLikeInitialRecommendationsPool(roles) {
  /**
   * Bedrock initial recommendations pool is expected to include match_metadata and/or role-card fields.
   * If the cached entry is the legacy "simple recommended roles" shape, do not use it here.
   */
  const arr = Array.isArray(roles) ? roles : [];
  if (arr.length < 5) return false;
  if (arr.some(_looksLikeLegacySimpleRecommendedRole)) return false;
  return arr.some((r) => r?.match_metadata && typeof r.match_metadata === 'object');
}

/**
 * PUBLIC_INTERFACE
 * Persona-driven Explore search over the persisted recommendations pool.
 *
 * This MUST NOT call Bedrock directly.
 * If the pool does not exist yet, it triggers EXACTLY ONE Bedrock fetch via
 * exploreRecommendationsPoolService (in-flight deduped and persisted).
 *
 * @param {object} params
 * @param {string} [params.q]
 * @param {number} [params.limit]
 * @param {string|null} [params.personaId]
 * @returns {Promise<any[]>}
 */
export async function exploreSearchRolesPersonaDriven({ q, limit = 30, personaId = null } = {}) {
  const searchQuery = _normStr(q);
  const qLower = searchQuery.toLowerCase();

  const limitNum = Number(limit);
  const effectiveLimit =
    Number.isFinite(limitNum) && limitNum > 0 ? Math.max(1, Math.min(limitNum, 100)) : 30;

  const pid = personaId ? String(personaId).trim() : '';
  if (!pid) return [];

  // 1) Prefer cached recommendations pool if present (fast path, no Bedrock).
  try {
    const cached = await holisticPersonaRepo.getLatestRecommendationsRoles({ personaId: pid });
    const cachedRoles = Array.isArray(cached?.roles) ? cached.roles : [];

    if (_looksLikeInitialRecommendationsPool(cachedRoles)) {
      const filtered = cachedRoles.filter((r) => _matchesQuery(r, qLower));
      return _safeSlice(filtered, effectiveLimit);
    }
  } catch (err) {
    // Fall through; service will regenerate if needed (in-flight deduped).
    // eslint-disable-next-line no-console
    console.error('[ExploreService] Failed to read cached recommendations roles:', err?.message || String(err));
  }

  // 2) If no cached pool, trigger the single shared fetch/persist, then filter locally.
  const pool = await exploreRecommendationsPoolService.getOrCreateExploreRecommendationsPool({
    personaId: pid,
    finalPersonaOverride: null,
    options: {
      // Keep consistent with /api/recommendations/initial default.
      storeCount: 12,
    },
  });

  const roles = Array.isArray(pool?.roles) ? pool.roles : [];
  const filtered = roles.filter((r) => _matchesQuery(r, qLower));

  return _safeSlice(filtered, effectiveLimit);
}

export default { exploreSearchRolesPersonaDriven };
