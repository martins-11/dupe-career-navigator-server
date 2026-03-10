'use strict';

const express = require('express');
const {
  PersonaCreateRequest,
  PersonaUpdateRequest,
  PersonaVersionCreateRequest
} = require('../models/personas');
const personasRepo = require('../repositories/personasRepoAdapter');
const rolesRepo = require('../repositories/rolesRepoAdapter');
const userTargetsRepo = require('../repositories/userTargetsRepoAdapter');
const { PersonaTargetRoleSelectRequest } = require('../models/targets');

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
  if (/database/i.test(msg) || /postgres/i.test(msg) || /connection/i.test(msg)) {
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
    // Ensure roles table is populated at least with seed data (best-effort).
    // If DB isn't configured, rolesRepo.searchRoles/listRoles will be [] which is fine; we then 503 for persistence.
    const roleExists = await rolesRepo.roleExists(parsed.data.role_id);
    if (!roleExists) {
      return res.status(404).json({ error: 'role_not_found', message: 'role_id does not exist in roles table.' });
    }

    const saved = await userTargetsRepo.upsertUserTargetRole({
      userId: parsed.data.user_id,
      roleId: parsed.data.role_id,
      timeHorizon: parsed.data.time_horizon
    });

    if (!saved) {
      return res.status(503).json({ error: 'db_unavailable', message: 'Database not configured for persistence.' });
    }

    return res.status(201).json({
      status: 'ok',
      target: saved
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

module.exports = router;
