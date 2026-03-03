'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const orchestrationService = require('../services/orchestrationService');
const personaService = require('../services/personaService');
const holisticPersonaRepo = require('../repositories/holisticPersonaRepoAdapter');
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
 * Now implemented with "real" business logic aligned with Holistic Persona integration:
 * - Can optionally use an existing orchestration build (buildId) to access persona draft/final artifacts.
 * - Can optionally generate a draft persona from provided sourceText (Bedrock or mock depending on env).
 * - Always validates request and response shapes.
 */

/**
 * Curated base roles. Used as fallback and also as a stable "catalog" to compare against.
 * Keep ids stable for the frontend.
 */
const BASE_ROLE_CATALOG = Object.freeze([
  {
    id: 'software_engineer',
    title: 'Software Engineer',
    description: 'Builds and maintains software products.',
    tags: ['engineering', 'coding']
  },
  {
    id: 'full_stack_engineer',
    title: 'Full-Stack Engineer',
    description: 'Builds user-facing apps and backend services end-to-end.',
    tags: ['engineering', 'web', 'systems']
  },
  {
    id: 'data_analyst',
    title: 'Data Analyst',
    description: 'Analyzes datasets to support business decisions.',
    tags: ['data', 'analytics']
  },
  {
    id: 'data_engineer',
    title: 'Data Engineer',
    description: 'Builds data pipelines, warehouses, and data platforms.',
    tags: ['data', 'pipelines', 'platform']
  },
  {
    id: 'product_manager',
    title: 'Product Manager',
    description: 'Owns product direction, requirements, and delivery.',
    tags: ['product', 'strategy']
  },
  {
    id: 'ux_designer',
    title: 'UX Designer',
    description: 'Designs user experiences and interfaces.',
    tags: ['design', 'research', 'ui']
  },
  {
    id: 'program_manager',
    title: 'Program Manager',
    description: 'Coordinates cross-team delivery and execution across initiatives.',
    tags: ['program', 'delivery', 'coordination']
  }
]);

function _uniqueStrings(items) {
  return Array.from(new Set((items || []).map((s) => String(s).trim()).filter(Boolean)));
}

function _inferRoleTagsFromPersonaDraft(personaDraft) {
  /**
   * Lightweight, deterministic tag inference from persona draft.
   * This is not "AI"; it's explainable and stable.
   */
  const tags = [];

  const competencies = Array.isArray(personaDraft?.core_competencies) ? personaDraft.core_competencies : [];
  const stack = personaDraft?.technical_stack || {};
  const langs = Array.isArray(stack.languages) ? stack.languages : [];
  const frameworks = Array.isArray(stack.frameworks) ? stack.frameworks : [];
  const dbs = Array.isArray(stack.databases) ? stack.databases : [];
  const cloud = Array.isArray(stack.cloud_and_devops) ? stack.cloud_and_devops : [];

  const blob = _uniqueStrings([...competencies, ...langs, ...frameworks, ...dbs, ...cloud])
    .join(' ')
    .toLowerCase();

  if (/\breact\b|\bfrontend\b|\bui\b|\bux\b/.test(blob)) tags.push('web', 'frontend');
  if (/\bnode\b|\bexpress\b|\bbackend\b|\bapi\b/.test(blob)) tags.push('backend', 'systems');
  if (/\bpython\b|\bsql\b|\banalytics\b|\bstatistics\b/.test(blob)) tags.push('data', 'analytics');
  if (/\baws\b|\bkubernetes\b|\bdocker\b|\bdevops\b|\bcloud\b/.test(blob)) tags.push('cloud', 'devops');
  if (/\bproduct\b|\broadmap\b|\bstakeholder\b/.test(blob)) tags.push('product', 'strategy');

  return _uniqueStrings(tags);
}

function _rankCatalogByTags(catalog, desiredTags) {
  const desired = new Set((desiredTags || []).map((t) => String(t).toLowerCase()));
  if (desired.size === 0) return catalog;

  const score = (role) => {
    const roleTags = (role.tags || []).map((t) => String(t).toLowerCase());
    let s = 0;
    for (const t of roleTags) if (desired.has(t)) s += 1;
    return s;
  };

  return [...catalog].sort((a, b) => score(b) - score(a));
}

// PUBLIC_INTERFACE
router.get('/roles', async (req, res) => {
  /**
   * Return a curated list of recommended roles.
   *
   * Optional query parameters (additive; safe defaults):
   * - buildId: UUID of an orchestration build. If provided and a persona draft exists, we infer tags.
   * - sourceText: If provided, we generate a draft persona (Bedrock/mock) and infer tags.
   *
   * Response (validated):
   * { roles: Array<{ id, title, description?, tags? }> }
   */
  try {
    const buildId = req.query?.buildId ? String(req.query.buildId).trim() : null;
    const sourceText = req.query?.sourceText ? String(req.query.sourceText) : null;

    let inferredTags = [];

    // 1) If buildId provided, try to use orchestration artifacts (draft/final) as persona context.
    // If orchestration memory is empty (e.g., server restart), fall back to DB-backed persona draft/final
    // using a personaId stored on the orchestration record if present in DB elsewhere.
    let personaId = null;

    if (buildId) {
      const orch = orchestrationService.getOrchestration(buildId);

      if (orch?.personaDraft) {
        inferredTags = _inferRoleTagsFromPersonaDraft(orch.personaDraft);
        personaId = orch.personaId || null;
      } else if (orch?.personaFinal) {
        inferredTags = _inferRoleTagsFromPersonaDraft(orch.personaFinal);
        personaId = orch.personaId || null;
      } else if (orch?.personaId) {
        personaId = orch.personaId;

        // Load DB-backed draft/final for the personaId.
        const [draft, finalBlob] = await Promise.all([personasRepo.getDraft(personaId), personasRepo.getFinal(personaId)]);
        const persona = (finalBlob && finalBlob.finalJson) || (draft && draft.draftJson) || null;
        if (persona) inferredTags = _inferRoleTagsFromPersonaDraft(persona);
      }
    }

    // 2) If no tags yet and sourceText provided, generate a draft persona and infer tags.
    // Note: personaService will enforce minimum input length and may fall back to mock mode.
    if (inferredTags.length === 0 && sourceText && sourceText.trim()) {
      const gen = await personaService.generatePersonaDraft(sourceText, { context: null });
      if (gen?.persona) inferredTags = _inferRoleTagsFromPersonaDraft(gen.persona);
    }

    const useLatest = String(req.query?.useLatest || '').toLowerCase() === 'true';

    // If client explicitly requests the latest persisted result, try it first.
    if (useLatest) {
      const latest = await holisticPersonaRepo.getLatestRecommendationsRoles({
        userId: req.query?.userId ? String(req.query.userId).trim() : null,
        personaId: req.query?.personaId ? String(req.query.personaId).trim() : null,
        buildId
      });

      if (latest?.roles && Array.isArray(latest.roles)) {
        const payload = enforceResponse(RecommendationsRolesResponseSchema, { roles: latest.roles });
        return res.json(payload);
      }
    }

    const roles = _rankCatalogByTags(BASE_ROLE_CATALOG, inferredTags);

    // Best-effort persist so refresh/reload can reuse.
    try {
      await holisticPersonaRepo.upsertRecommendationsRoles({
        userId: req.query?.userId ? String(req.query.userId).trim() : null,
        personaId: req.query?.personaId ? String(req.query.personaId).trim() : null,
        buildId,
        inferredTags,
        roles
      });
    } catch (_) {
      // Do not fail the endpoint on persistence issues; API remains usable.
    }

    const payload = enforceResponse(RecommendationsRolesResponseSchema, { roles });
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
   * "Real" logic (deterministic, explainable):
   * - Loads both roles from catalog
   * - Computes differences by tags and short description heuristics
   *
   * Response (validated):
   * { leftRoleId, rightRoleId, comparison: { summary, differences: string[] } }
   */
  try {
    const parsed = parseWithZod(RoleCompareRequestSchema, req.body || {});
    if (!parsed.ok) throw parsed.error;

    const { leftRoleId, rightRoleId } = parsed.data;

    const left = BASE_ROLE_CATALOG.find((r) => r.id === leftRoleId) || null;
    const right = BASE_ROLE_CATALOG.find((r) => r.id === rightRoleId) || null;

    if (!left || !right) {
      const e = new Error('Unknown role id(s). Use GET /api/recommendations/roles to discover valid ids.');
      e.code = 'validation_error';
      e.httpStatus = 400;
      e.details = {
        leftRoleId,
        rightRoleId,
        knownRoleIds: BASE_ROLE_CATALOG.map((r) => r.id)
      };
      throw e;
    }

    const leftTags = new Set(left.tags || []);
    const rightTags = new Set(right.tags || []);

    const leftOnly = Array.from(leftTags).filter((t) => !rightTags.has(t));
    const rightOnly = Array.from(rightTags).filter((t) => !leftTags.has(t));

    const differences = [];
    if (leftOnly.length) differences.push(`${left.title} emphasizes: ${leftOnly.join(', ')}`);
    if (rightOnly.length) differences.push(`${right.title} emphasizes: ${rightOnly.join(', ')}`);

    // Simple deterministic summary.
    const summary =
      differences.length > 0
        ? `Compared ${left.title} vs ${right.title} based on role tags and descriptions.`
        : `Compared ${left.title} vs ${right.title}: roles have similar tag profiles; differences are likely organization-specific.`;

    const comparison = {
      summary,
      differences: differences.length
        ? differences
        : ['Day-to-day responsibilities vary by organization.', 'Skill emphasis depends on team/product maturity.']
    };

    // Best-effort persist (buildId optional; callers can pass it via body.context.buildId).
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
