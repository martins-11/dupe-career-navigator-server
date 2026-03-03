'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const orchestrationService = require('../services/orchestrationService');
const holisticPersonaRepo = require('../repositories/holisticPersonaRepoAdapter');
const personasRepo = require('../repositories/personasRepoAdapter');

const {
  parseWithZod,
  enforceResponse,
  PlanMilestonesRequestSchema,
  PlanMilestonesResponseSchema
} = require('../schemas/holisticPersonaSchemas');

const router = express.Router();

function _safeString(v, fallback) {
  const s = v == null ? '' : String(v).trim();
  return s ? s : fallback;
}

function _inferFocusFromPersona(persona) {
  const competencies = Array.isArray(persona?.core_competencies) ? persona.core_competencies : [];
  const stack = persona?.technical_stack || {};
  const blob = [...competencies, ...(stack.languages || []), ...(stack.frameworks || []), ...(stack.cloud_and_devops || [])]
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/\bdata\b|\banalytics\b|\bsql\b|\bpython\b/.test(blob)) return 'data';
  if (/\breact\b|\bfrontend\b|\bui\b/.test(blob)) return 'frontend';
  if (/\bbackend\b|\bnode\b|\bexpress\b|\bapi\b|\bsystems\b/.test(blob)) return 'backend';
  if (/\bcloud\b|\baws\b|\bdevops\b|\bkubernetes\b|\bdocker\b/.test(blob)) return 'cloud';
  return 'general';
}

function _makeMilestones({ goal, timeframeWeeks, focus }) {
  /**
   * Deterministic milestone planner (strategic path planning):
   * - Uses timeframe to adjust granularity.
   * - Uses focus to tailor milestones.
   */
  const weeks = timeframeWeeks;
  const phaseCount = weeks <= 8 ? 3 : weeks <= 16 ? 4 : 5;

  const base = [
    { key: 'baseline', title: 'Assess current strengths & gaps', desc: 'Inventory skills, projects, and feedback; define target outcomes.' },
    { key: 'build', title: 'Build targeted proof (projects/impact)', desc: 'Ship 1–2 scoped deliverables aligned to the goal.' },
    { key: 'signal', title: 'Strengthen professional signal', desc: 'Update resume/LinkedIn, write concise stories, gather references.' },
    { key: 'market', title: 'Practice & apply strategically', desc: 'Interview practice, application pipeline, and iteration from feedback.' },
    { key: 'advance', title: 'Lock in next-step growth loop', desc: 'Create a 90-day plan for the new role and define success metrics.' }
  ];

  const focusOverrides = {
    data: [
      { key: 'baseline', title: 'Assess analytics + SQL depth', desc: 'Identify key gaps in SQL, modeling, and stakeholder communication.' },
      { key: 'build', title: 'Build analytics portfolio', desc: 'Create dashboards/analysis writeups; focus on decision impact.' }
    ],
    frontend: [
      { key: 'baseline', title: 'Assess product UI delivery skills', desc: 'Audit UI fundamentals, accessibility, and component architecture.' },
      { key: 'build', title: 'Ship polished UI case studies', desc: 'Deliver a small app with strong UX, performance, and testing.' }
    ],
    backend: [
      { key: 'baseline', title: 'Assess backend/system design', desc: 'Review APIs, data modeling, and reliability fundamentals.' },
      { key: 'build', title: 'Ship a backend service', desc: 'Build a small service with auth, persistence, observability, and tests.' }
    ],
    cloud: [
      { key: 'baseline', title: 'Assess cloud + ops readiness', desc: 'Review deployment, infra basics, monitoring, and incident response.' },
      { key: 'build', title: 'Ship an infra-backed project', desc: 'Deploy something production-like with CI/CD, logs, and alerts.' }
    ]
  };

  const use = base.slice(0, phaseCount);

  // Apply focus overrides for the first two phases where it matters most.
  const overrides = focusOverrides[focus] || [];
  for (const o of overrides) {
    const idx = use.findIndex((m) => m.key === o.key);
    if (idx >= 0) use[idx] = { ...use[idx], ...o };
  }

  return use.map((m, i) => ({
    id: `m${i + 1}`,
    title: m.title,
    description: m.desc,
    order: i + 1
  }));
}

// PUBLIC_INTERFACE
router.post('/milestones', async (req, res) => {
  /**
   * Strategic path planning: derive milestones for a goal/timeframe.
   *
   * Body (validated):
   * { goal?: string, timeframeWeeks?: number, context?: object }
   *
   * Optional context fields supported (additive):
   * - buildId: UUID; if present and orchestration has persona draft/final, planner tailors milestones.
   */
  try {
    const parsed = parseWithZod(PlanMilestonesRequestSchema, req.body || {});
    if (!parsed.ok) throw parsed.error;

    const goal = _safeString(parsed.data.goal, 'Career growth plan');
    const timeframeWeeks = Number(parsed.data.timeframeWeeks || 12);

    const contextObj =
      parsed.data.context && typeof parsed.data.context === 'object' && parsed.data.context ? parsed.data.context : null;

    const buildId = contextObj ? String(contextObj.buildId || '').trim() || null : null;
    const personaId = contextObj ? String(contextObj.personaId || '').trim() || null : null;
    const userId = contextObj ? String(contextObj.userId || '').trim() || null : null;
    const useLatest = contextObj ? Boolean(contextObj.useLatest) : false;

    if (useLatest) {
      const latest = await holisticPersonaRepo.getLatestPlanMilestones({ userId, personaId, buildId });
      if (latest?.milestones && Array.isArray(latest.milestones)) {
        const payload = enforceResponse(PlanMilestonesResponseSchema, {
          goal: latest.goal || goal,
          timeframeWeeks: latest.timeframeWeeks || timeframeWeeks,
          milestones: latest.milestones
        });
        return res.status(200).json(payload);
      }
    }

    let focus = 'general';
    let effectivePersonaId = personaId;

    if (buildId) {
      const orch = orchestrationService.getOrchestration(buildId);
      const persona = orch?.personaDraft || orch?.personaFinal || null;
      if (persona) {
        focus = _inferFocusFromPersona(persona);
        effectivePersonaId = effectivePersonaId || orch?.personaId || null;
      } else if (orch?.personaId) {
        effectivePersonaId = effectivePersonaId || orch.personaId;
        const [draft, finalBlob] = await Promise.all([
          personasRepo.getDraft(effectivePersonaId),
          personasRepo.getFinal(effectivePersonaId)
        ]);
        const dbPersona = (finalBlob && finalBlob.finalJson) || (draft && draft.draftJson) || null;
        if (dbPersona) focus = _inferFocusFromPersona(dbPersona);
      }
    }

    const milestones = _makeMilestones({ goal, timeframeWeeks, focus });

    // Best-effort persist
    try {
      await holisticPersonaRepo.upsertPlanMilestones({
        userId,
        personaId: effectivePersonaId,
        buildId,
        goal,
        timeframeWeeks,
        focus,
        milestones
      });
    } catch (_) {
      // ignore persistence failure
    }

    const payload = enforceResponse(PlanMilestonesResponseSchema, {
      goal,
      timeframeWeeks,
      milestones
    });

    return res.status(200).json(payload);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
