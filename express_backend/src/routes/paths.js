import express from 'express';
import { sendError } from '../utils/errors.js';
import orchestrationService from '../services/orchestrationService.js';
import holisticPersonaRepo from '../repositories/holisticPersonaRepoAdapter.js';
import personasRepo from '../repositories/personasRepoAdapter.js';

import { enforceResponse, PathsMultiverseResponseSchema } from '../schemas/holisticPersonaSchemas.js';

const router = express.Router();

/**
 * Career paths APIs.
 *
 * Holistic Persona integration:
 * - If buildId is provided and an orchestration persona draft exists, we generate path options
 *   that are consistent with inferred strengths/stack (deterministic heuristics).
 * - Otherwise return stable fallback paths.
 */

function _lowerBlobFromPersona(persona) {
  const competencies = Array.isArray(persona?.core_competencies) ? persona.core_competencies : [];
  const stack = persona?.technical_stack || {};
  const langs = Array.isArray(stack.languages) ? stack.languages : [];
  const frameworks = Array.isArray(stack.frameworks) ? stack.frameworks : [];
  const dbs = Array.isArray(stack.databases) ? stack.databases : [];
  const cloud = Array.isArray(stack.cloud_and_devops) ? stack.cloud_and_devops : [];

  return [...competencies, ...langs, ...frameworks, ...dbs, ...cloud]
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function _buildPathsFromPersonaDraft(personaDraft) {
  const blob = _lowerBlobFromPersona(personaDraft);

  const paths = [];

  // Non-linear path generation: offer different "routes" that aren't just seniority ladder.
  if (/\bdata\b|\banalytics\b|\bsql\b|\bstatistics\b|\bpython\b/.test(blob)) {
    paths.push({
      id: 'data_generalist',
      title: 'Analyst → Senior Analyst → Analytics Manager',
      steps: ['Analyst', 'Senior Analyst', 'Analytics Manager'],
      metadata: { theme: 'data' }
    });
    paths.push({
      id: 'data_platform',
      title: 'Analyst → Analytics Engineer → Data Engineer',
      steps: ['Analyst', 'Analytics Engineer', 'Data Engineer'],
      metadata: { theme: 'data' }
    });
  }

  if (/\breact\b|\bfrontend\b|\bui\b/.test(blob)) {
    paths.push({
      id: 'frontend_leadership',
      title: 'Frontend Engineer → Senior Frontend Engineer → Staff Engineer',
      steps: ['Frontend Engineer', 'Senior Frontend Engineer', 'Staff Engineer'],
      metadata: { theme: 'frontend' }
    });
    paths.push({
      id: 'design_adjacent',
      title: 'Frontend Engineer → UX Engineer → Product-focused Engineer',
      steps: ['Frontend Engineer', 'UX Engineer', 'Product-focused Engineer'],
      metadata: { theme: 'frontend' }
    });
  }

  if (/\bnode\b|\bexpress\b|\bbackend\b|\bapi\b|\bsystems\b/.test(blob)) {
    paths.push({
      id: 'backend_leadership',
      title: 'Backend Engineer → Senior Backend Engineer → Tech Lead',
      steps: ['Backend Engineer', 'Senior Backend Engineer', 'Tech Lead'],
      metadata: { theme: 'backend' }
    });
    paths.push({
      id: 'platform',
      title: 'Backend Engineer → Platform Engineer → Principal Engineer (Platform)',
      steps: ['Backend Engineer', 'Platform Engineer', 'Principal Engineer (Platform)'],
      metadata: { theme: 'platform' }
    });
  }

  if (/\baws\b|\bdevops\b|\bkubernetes\b|\bdocker\b|\bcloud\b/.test(blob)) {
    paths.push({
      id: 'cloud_ops',
      title: 'Engineer → Cloud Engineer → Site Reliability Engineer',
      steps: ['Engineer', 'Cloud Engineer', 'Site Reliability Engineer'],
      metadata: { theme: 'cloud' }
    });
  }

  // Always include at least one "management" and one "IC" branch as a multiverse baseline.
  paths.push({
    id: 'ic_growth',
    title: 'Engineer → Senior Engineer → Staff Engineer',
    steps: ['Engineer', 'Senior Engineer', 'Staff Engineer'],
    metadata: { theme: 'ic' }
  });
  paths.push({
    id: 'people_leadership',
    title: 'Engineer → Tech Lead → Engineering Manager',
    steps: ['Engineer', 'Tech Lead', 'Engineering Manager'],
    metadata: { theme: 'management' }
  });

  // Deduplicate by id.
  const byId = new Map();
  for (const p of paths) byId.set(p.id, p);
  return Array.from(byId.values());
}

// PUBLIC_INTERFACE
router.get('/multiverse', async (req, res) => {
  /**
   * Return a "multiverse" of potential career paths (non-linear path generation).
   *
   * Optional query parameters:
   * - buildId: UUID of an orchestration build (uses personaDraft/personaFinal from orchestration record if available)
   *
   * Response: { paths: Array<{ id, title, steps: string[], metadata? }> }
   */
  try {
    const buildId = req.query?.buildId ? String(req.query.buildId).trim() : null;
    const useLatest = String(req.query?.useLatest || '').toLowerCase() === 'true';

    if (useLatest) {
      const latest = await holisticPersonaRepo.getLatestPathsMultiverse({
        userId: req.query?.userId ? String(req.query.userId).trim() : null,
        personaId: req.query?.personaId ? String(req.query.personaId).trim() : null,
        buildId
      });

      if (latest?.paths && Array.isArray(latest.paths)) {
        const payload = enforceResponse(PathsMultiverseResponseSchema, { paths: latest.paths });
        return res.json(payload);
      }
    }

    let paths;
    let personaId = req.query?.personaId ? String(req.query.personaId).trim() : null;

    if (buildId) {
      const orch = orchestrationService.getOrchestration(buildId);
      const persona = orch?.personaDraft || orch?.personaFinal || null;
      if (persona) {
        paths = _buildPathsFromPersonaDraft(persona);
        personaId = personaId || orch?.personaId || null;
      } else if (orch?.personaId) {
        personaId = personaId || orch.personaId;
        const [draft, finalBlob] = await Promise.all([personasRepo.getDraft(personaId), personasRepo.getFinal(personaId)]);
        const dbPersona = (finalBlob && finalBlob.finalJson) || (draft && draft.draftJson) || null;
        if (dbPersona) paths = _buildPathsFromPersonaDraft(dbPersona);
      }
    }

    if (!paths) {
      // Stable fallback.
      paths = [
        {
          id: 'path_1',
          title: 'Engineer → Senior Engineer → Tech Lead',
          steps: ['Engineer', 'Senior Engineer', 'Tech Lead'],
          metadata: { theme: 'ic' }
        },
        {
          id: 'path_2',
          title: 'Analyst → Senior Analyst → Analytics Manager',
          steps: ['Analyst', 'Senior Analyst', 'Analytics Manager'],
          metadata: { theme: 'data' }
        },
        {
          id: 'path_3',
          title: 'Engineer → Tech Lead → Engineering Manager',
          steps: ['Engineer', 'Tech Lead', 'Engineering Manager'],
          metadata: { theme: 'management' }
        }
      ];
    }

    // Best-effort persist
    try {
      await holisticPersonaRepo.upsertPathsMultiverse({
        userId: req.query?.userId ? String(req.query.userId).trim() : null,
        personaId,
        buildId,
        paths
      });
    } catch (_) {
      // ignore persistence failure
    }

    const payload = enforceResponse(PathsMultiverseResponseSchema, { paths });
    return res.json(payload);
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
