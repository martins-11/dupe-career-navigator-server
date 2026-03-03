'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const orchestrationService = require('../services/orchestrationService');

const {
  parseWithZod,
  enforceResponse,
  ProfileScoringRequestSchema,
  ProfileScoringResponseSchema
} = require('../schemas/holisticPersonaSchemas');

const router = express.Router();

function _clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(min, Math.min(max, x));
}

function _computeSubscoresFromPersona(persona) {
  /**
   * Deterministic scoring heuristics:
   * - completeness: how filled-out the persona draft looks
   * - technicalDepth: technical_stack density
   * - signal: number of highlights/competencies
   *
   * These are intentionally simple and auditable.
   */
  const highlights = Array.isArray(persona?.career_highlights) ? persona.career_highlights : [];
  const competencies = Array.isArray(persona?.core_competencies) ? persona.core_competencies : [];
  const stack = persona?.technical_stack || {};

  const stackCount =
    (Array.isArray(stack.languages) ? stack.languages.length : 0) +
    (Array.isArray(stack.frameworks) ? stack.frameworks.length : 0) +
    (Array.isArray(stack.databases) ? stack.databases.length : 0) +
    (Array.isArray(stack.cloud_and_devops) ? stack.cloud_and_devops.length : 0) +
    (Array.isArray(stack.tools) ? stack.tools.length : 0);

  // Completeness: summary presence + education list existence + stack presence.
  let completeness = 0;
  if (persona?.professional_summary && String(persona.professional_summary).trim().length >= 40) completeness += 40;
  if (Array.isArray(persona?.education) && persona.education.length > 0) completeness += 20;
  if (stackCount > 0) completeness += 40;

  // Technical depth: capped at 100.
  const technicalDepth = Math.min(100, Math.round(stackCount * 8)); // 12 items ≈ 96

  // Signal: highlights/competencies are strong signals.
  const signal = Math.min(100, Math.round(highlights.length * 18 + competencies.length * 4)); // 3 highlights + 10 comps ≈ 94

  return {
    completeness: _clamp(completeness, 0, 100) ?? 0,
    technicalDepth: _clamp(technicalDepth, 0, 100) ?? 0,
    signal: _clamp(signal, 0, 100) ?? 0
  };
}

function _overallFromSubscores(sub) {
  const c = _clamp(sub?.completeness, 0, 100) ?? 0;
  const t = _clamp(sub?.technicalDepth, 0, 100) ?? 0;
  const s = _clamp(sub?.signal, 0, 100) ?? 0;
  return Math.round((c * 0.4 + t * 0.35 + s * 0.25) * 10) / 10; // one decimal
}

function _apply32Rule({ overall, override }) {
  /**
   * "3/2 rule manual override":
   * Product requirement: allow a manual override envelope.
   *
   * Interpreted as:
   * - enabled=false => no override applied
   * - enabled=true + overallOverride present => use it
   * - enabled=true + no overallOverride => keep computed overall but flag override enabled
   */
  if (!override || override.enabled !== true) {
    return { overall, applied: false, reason: null };
  }

  if (override.overallOverride != null) {
    const clamped = _clamp(override.overallOverride, 0, 100);
    if (clamped == null) {
      const err = new Error('override.overallOverride must be a number between 0 and 100.');
      err.code = 'validation_error';
      err.httpStatus = 400;
      throw err;
    }
    return { overall: clamped, applied: true, reason: 'manual_overall_override' };
  }

  return { overall, applied: true, reason: 'override_enabled_no_override_value' };
}

// PUBLIC_INTERFACE
router.put('/scoring', async (req, res) => {
  /**
   * Update profile scoring inputs/results.
   *
   * Body (validated):
   * {
   *   userId?: uuid|null,
   *   personaId?: uuid|null,
   *   buildId?: uuid|null,
   *   scoring?: object|null,
   *   override?: { rule: '3/2', enabled: boolean, overallOverride?: number|null, note?: string|null }|null
   * }
   *
   * Real logic:
   * - If buildId is provided and orchestration has persona draft/final, compute deterministic subscores.
   * - Merge any incoming scoring fields (client inputs) with computed values (server authoritative).
   * - Apply 3/2 override if enabled.
   */
  try {
    const parsed = parseWithZod(ProfileScoringRequestSchema, req.body || {});
    if (!parsed.ok) throw parsed.error;

    const { scoring: incomingScoring, buildId, override } = parsed.data;

    let computed = null;
    if (buildId) {
      const orch = orchestrationService.getOrchestration(buildId);
      const persona = orch?.personaFinal || orch?.personaDraft || null;
      if (persona) computed = _computeSubscoresFromPersona(persona);
    }

    const next = {
      ...(incomingScoring && typeof incomingScoring === 'object' ? incomingScoring : {}),
      subscores: {
        ...((incomingScoring && incomingScoring.subscores && typeof incomingScoring.subscores === 'object'
          ? incomingScoring.subscores
          : {}) || {}),
        ...(computed || {})
      }
    };

    const computedOverall = _overallFromSubscores(next.subscores);
    const applied = _apply32Rule({ overall: computedOverall, override });

    next.overall = applied.overall;
    next.override = override || null;
    next.overrideApplied = applied.applied;
    next.overrideReason = applied.reason;

    // Ensure deterministic default if nothing could be computed and no incoming overall was provided.
    if (next.overall == null) next.overall = 0;

    const payload = enforceResponse(ProfileScoringResponseSchema, {
      status: 'ok',
      scoring: next
    });

    return res.json(payload);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
