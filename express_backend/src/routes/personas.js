import express from 'express';

import {
  PersonaCreateRequest,
  PersonaUpdateRequest,
  PersonaVersionCreateRequest
} from '../models/personas.js';

import personasRepo from '../repositories/personasRepoAdapter.js';
import rolesRepo from '../repositories/rolesRepoAdapter.js';
import userTargetsRepo from '../repositories/userTargetsRepoAdapter.js';
import { PersonaTargetRoleSelectRequest } from '../models/targets.js';

import { getDbEngine, isDbConfigured, isMysqlConfigured } from '../db/connection.js';
import { DEFAULT_ROLES_CATALOG } from '../services/recommendationsService.js';

const router = express.Router();

/**
 * Persona APIs (scaffold).
 *
 * Provides:
 * - create persona
 * - get persona
 * - update persona metadata
 * - create persona version
 * - list persona versions
 * - get latest persona version
 *
 * Until DB env vars are configured, endpoints return 503 with db_unavailable.
 */

function handleRepoError(res, err) {
  // In adapter mode, DB-not-configured should never be fatal (memory fallback).
  // Only treat connection/runtime DB errors as 503.
  const msg = String(err && err.message ? err.message : err);
  if (/database/i.test(msg) || /postgres/i.test(msg) || /connection/i.test(msg) || /mysql/i.test(msg)) {
    return res.status(503).json({ error: 'db_unavailable', message: msg });
  }
  return res.status(500).json({ error: 'internal_server_error', message: msg });
}

router.post('/', async (req, res) => {
  const parsed = PersonaCreateRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
  }

  try {
    const persona = await personasRepo.createPersona(parsed.data);
    return res.status(201).json(persona);
  } catch (err) {
    return handleRepoError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const persona = await personasRepo.getPersonaById(req.params.id);
    if (!persona) return res.status(404).json({ error: 'not_found' });
    return res.json(persona);
  } catch (err) {
    return handleRepoError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /personas/:id/draft/latest
 *
 * Returns the latest saved draft blob for a personaId.
 *
 * Notes:
 * - This reads from personasRepo.getDraft(), which is backed by MySQL when configured
 *   (persona_drafts table) and by memory repo otherwise.
 * - Returns 404 when persona does not exist OR no draft exists yet.
 */
router.get('/:id/draft/latest', async (req, res) => {
  try {
    const personaId = String(req.params.id || '').trim();
    if (!personaId) return res.status(400).json({ error: 'validation_error', message: 'personaId is required.' });

    // Ensure persona exists (consistent with other persona routes).
    const existing = await personasRepo.getPersonaById(personaId);
    if (!existing) return res.status(404).json({ error: 'persona_not_found' });

    const draft = await personasRepo.getDraft(personaId);
    if (!draft || !draft.draftJson) {
      return res.status(404).json({ error: 'draft_not_found', message: 'No saved draft exists for this persona yet.' });
    }

    return res.json(draft);
  } catch (err) {
    return handleRepoError(res, err);
  }
});

router.put('/:id', async (req, res) => {
  const parsed = PersonaUpdateRequest.safeParse(req.body);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.warn('[personas][PUT] validation_error', {
      personaId: req.params.id,
      issues: parsed.error.issues?.map((i) => ({
        path: i.path,
        code: i.code,
        message: i.message
      }))
    });
    return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
  }

  try {
    const existing = await personasRepo.getPersonaById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    // Update metadata (title). Versioned JSON handled separately.
    const updated = await personasRepo.updatePersona(req.params.id, { title: parsed.data.title });

    // If personaJson provided (and not null), create a new version.
    // We explicitly allow personaJson=null in the API as "no JSON update".
    let createdVersion = null;
    if (Object.prototype.hasOwnProperty.call(parsed.data, 'personaJson') && parsed.data.personaJson !== null) {
      createdVersion = await personasRepo.createPersonaVersion(req.params.id, {
        personaJson: parsed.data.personaJson
      });
    }

    return res.json({ persona: updated, createdVersion });
  } catch (err) {
    return handleRepoError(res, err);
  }
});

router.post('/:id/versions', async (req, res) => {
  const parsed = PersonaVersionCreateRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
  }

  try {
    const existing = await personasRepo.getPersonaById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'persona_not_found' });

    const version = await personasRepo.createPersonaVersion(req.params.id, parsed.data);
    return res.status(201).json(version);
  } catch (err) {
    return handleRepoError(res, err);
  }
});

router.get('/:id/versions', async (req, res) => {
  try {
    const existing = await personasRepo.getPersonaById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'persona_not_found' });

    const versions = await personasRepo.listPersonaVersions(req.params.id);
    return res.json({ personaId: req.params.id, versions });
  } catch (err) {
    return handleRepoError(res, err);
  }
});

router.get('/:id/versions/latest', async (req, res) => {
  try {
    const existing = await personasRepo.getPersonaById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'persona_not_found' });

    const latest = await personasRepo.getLatestPersonaVersion(req.params.id);
    if (!latest) return res.status(404).json({ error: 'persona_version_not_found' });

    return res.json(latest);
  } catch (err) {
    return handleRepoError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * POST /personas/target-role
 */
router.post('/target-role', async (req, res) => {
  /**
   * Persist the user's selected target future role.
   *
   * Body:
   * { "user_id": "uuid", "role_id": "uuid", "time_horizon": "Near" }
   *
   * Validation:
   * - role_id must exist in roles table.
   *
   * Persistence:
   * - Writes to user_targets table (DB-optional; if DB not configured, returns 503).
   */
  const parsed = PersonaTargetRoleSelectRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
  }

  try {
    /**
     * Role existence validation:
     * - If DB roles catalog is available, validate role_id exists (helps catch client bugs/typos).
     * - Additionally accept ids that exist in the seed catalog (DEFAULT_ROLES_CATALOG) because
     *   the Explore/mindmap flows can operate without a seeded DB.
     *
     * IMPORTANT: role_id is not guaranteed to be a UUID.
     */
    const dbAvailable = getDbEngine() === 'mysql' && isDbConfigured() && isMysqlConfigured();

    const roleId = String(parsed.data.role_id).trim();

    const seed = DEFAULT_ROLES_CATALOG;
    const seedHasRole =
      Array.isArray(seed) &&
      seed.some((r) => {
        const seedId = String(r?.roleId || r?.role_id || r?.id || '').trim();
        const seedTitle = String(r?.roleTitle || r?.role_title || r?.title || '').trim();
        // Seed catalog often doesn't provide roleId; accept title-derived ids too.
        return (seedId && seedId === roleId) || (!seedId && seedTitle && seedTitle === roleId);
      });

    /**
     * If DB is available, validate role existence.
     *
     * IMPORTANT:
     * - The roles catalog table stores UUID role_ids (seeded/generated).
     * - Explore search/recommendations can return Bedrock-generated roles with ids like:
     *     bedrock-<slug> or bedrock-rec-<slug>
     *   These will not exist in the roles table, but they are still legitimate “targetable” roles.
     *
     * Therefore:
     * - Accept if found in DB roles table OR seed catalog OR known Bedrock id prefix.
     * - Still reject obvious typos/unknown ids to preserve guardrails.
     */
    const isBedrockRoleId = /^bedrock(?:-rec)?-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(roleId);

    if (dbAvailable) {
      const roleExists = await rolesRepo.roleExists(roleId);
      if (!roleExists && !seedHasRole && !isBedrockRoleId) {
        return res
          .status(404)
          .json({ error: 'role_not_found', message: 'role_id does not exist in roles catalog.' });
      }
    }
    // If DB is not available, allow saving (memory fallback will persist).

    const saved = await userTargetsRepo.upsertUserTargetRole({
      userId: parsed.data.user_id,
      roleId,
      timeHorizon: parsed.data.time_horizon
    });

    return res.status(201).json({
      status: 'ok',
      target: saved,
      persistence: { type: dbAvailable ? 'mysql' : 'memory' }
    });
  } catch (err) {
    return handleRepoError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /personas/target-role?user_id=<uuid>
 *
 * Returns the latest saved target role selection for the user.
 * This supports the "target role retrieval" requirement and enables the frontend to
 * restore persisted choice and drive the mind map details view.
 */
router.get('/target-role', async (req, res) => {
  const userId = String(req.query?.user_id || '').trim();
  if (!userId) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'user_id query parameter is required.'
    });
  }

  try {
    const latest = await userTargetsRepo.getLatestUserTargetRole({ userId });

    /**
     * Graceful behavior when DB is unavailable/unconfigured:
     * - The frontend uses personaId (or "anonymous") as a best-effort user key today.
     * - DB-backed persistence may not be configured in early scaffolding.
     *
     * So for GET we treat "no DB/no record" as a non-fatal condition and return:
     *   200 { status:"ok", target:null, persistence:{...} }
     *
     * This allows the UI to fall back to localStorage without surfacing backend errors.
     */
    if (!latest) {
      return res.json({
        status: 'ok',
        target: null,
        persistence: { available: false }
      });
    }

    return res.json({
      status: 'ok',
      target: latest,
      persistence: { available: true }
    });
  } catch (err) {
    // If this looks like a DB connectivity/config issue, degrade gracefully (same as no record).
    const msg = String(err && err.message ? err.message : err);
    if (/db_unavailable/i.test(msg) || /database/i.test(msg) || /mysql/i.test(msg) || /connection/i.test(msg)) {
      return res.json({
        status: 'ok',
        target: null,
        persistence: { available: false }
      });
    }
    return handleRepoError(res, err);
  }
});

export default router;
