'use strict';

const express = require('express');
const {
  PersonaCreateRequest,
  PersonaUpdateRequest,
  PersonaVersionCreateRequest
} = require('../models/personas');
const personasRepo = require('../repositories/personasRepoAdapter');

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

module.exports = router;
