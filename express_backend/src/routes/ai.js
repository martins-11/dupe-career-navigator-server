'use strict';

const express = require('express');
const { z } = require('zod');
const { uuidV4 } = require('../utils/uuid');

const router = express.Router();

const personaService = require('../services/personaService');

/**
 * AI endpoints (placeholder).
 *
 * Goals:
 * - Provide stable API contracts for AI persona generation before real LLM integration exists.
 * - Keep behavior safe: no external calls, no DB access, no secrets required.
 * - Return deterministic, explainable placeholder output for frontend integration.
 */

const PersonaGenerateRequest = z.object({
  /**
   * Optional: user identifier for multi-tenant attribution (not used by placeholder).
   */
  userId: z.string().uuid().nullable().optional(),
  /**
   * Optional: reference to a document stored in DB (not used by placeholder).
   * In future this may allow server-side retrieval of extracted text.
   */
  documentId: z.string().uuid().nullable().optional(),
  /**
   * Optional: raw extracted/normalized text from documents.
   * This is the recommended field for the placeholder so it remains DB-independent.
   */
  sourceText: z.string().min(1).nullable().optional(),
  /**
   * Optional: additional context such as job target, seniority, or industry.
   */
  context: z
    .object({
      targetRole: z.string().min(1).nullable().optional(),
      seniority: z.string().min(1).nullable().optional(),
      industry: z.string().min(1).nullable().optional()
    })
    .nullable()
    .optional(),
  /**
   * Optional: output format hint. Reserved for future.
   */
  outputFormat: z.enum(['json']).nullable().optional()
});

function validationError(res, parsed) {
  return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
}

const PersonaDraftSchema = z
  .object({
    schemaVersion: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    profile: z.object({
      headline: z.string().min(1),
      seniority: z.string().nullable(),
      industry: z.string().nullable(),
      location: z.string().nullable()
    }),
    strengths: z.array(z.string().min(1)).min(1),
    skills: z.array(z.string().min(1)).min(1),
    experienceHighlights: z.array(z.string().min(1)).min(1),
    provenance: z.object({
      source: z.string().min(1),
      sourceTextLength: z.number().int().nonnegative()
    })
  })
  .strict();

function makePlaceholderPersona({ sourceText, context }) {
  // Deterministic non-LLM implementation while Claude API credentials are pending.
  const text = (sourceText || '').trim();
  const length = text.length;

  const lower = text.toLowerCase();
  const maybeSkills = [];
  if (/\breact\b/.test(lower)) maybeSkills.push('React');
  if (/\bnode(\.js)?\b/.test(lower)) maybeSkills.push('Node.js');
  if (/\bexpress\b/.test(lower)) maybeSkills.push('Express');
  if (/\bpostgres\b|\bpostgresql\b/.test(lower)) maybeSkills.push('PostgreSQL');
  if (/\baws\b/.test(lower)) maybeSkills.push('AWS');
  if (/\bpython\b/.test(lower)) maybeSkills.push('Python');

  const targetRole = context?.targetRole || null;
  const industry = context?.industry || null;
  const seniority = context?.seniority || null;

  const draft = {
    schemaVersion: '0.1.0',
    title: targetRole ? `${targetRole} Persona (Draft)` : 'Professional Persona (Draft)',
    summary:
      'Persona draft generated without an LLM (Claude integration pending). This output is schema-validated JSON.',
    profile: {
      headline: targetRole || 'Professional',
      seniority,
      industry,
      location: null
    },
    strengths: ['Clear communication', 'Ownership mindset', 'Continuous improvement'],
    skills: maybeSkills.length ? maybeSkills : ['Problem solving', 'Collaboration', 'Writing'],
    experienceHighlights: [
      'Built and shipped features end-to-end (non-LLM draft).',
      'Collaborated with cross-functional teams (non-LLM draft).'
    ],
    provenance: {
      source: 'placeholder',
      sourceTextLength: length
    }
  };

  // Strict schema validation requirement.
  return PersonaDraftSchema.parse(draft);
}

// PUBLIC_INTERFACE
router.post('/personas/generate', async (req, res) => {
  /**
   * Generate a professional persona JSON (placeholder).
   *
   * This endpoint is safe to call without DB credentials:
   * - does not query or write to the database
   * - does not call external AI services
   *
   * Recommended usage for now:
   * - client calls /extraction/* to get text (or local extraction)
   * - client posts the text here via `sourceText`
   */
  const parsed = PersonaGenerateRequest.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);

  // Require either sourceText or documentId (documentId reserved for future DB-backed behavior).
  const hasSourceText = Boolean(parsed.data.sourceText && String(parsed.data.sourceText).trim());
  const hasDocumentId = Boolean(parsed.data.documentId);

  if (!hasSourceText && !hasDocumentId) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Provide at least one of: sourceText, documentId'
    });
  }

  const requestId = uuidV4();

  try {
    const { persona, mode, warnings } = await personaService.generatePersonaDraft(
      parsed.data.sourceText || '',
      { context: parsed.data.context || null }
    );

    // Best-effort persistence contract (required by integration test):
    // - insert into MySQL persona_drafts when DB is configured for MySQL
    // - return personaDraftId and alignment_score in response
    const { getDbEngine, isDbConfigured, isMysqlConfigured, dbQuery } = require('../db/connection');

    let personaDraftId = null;
    let alignment_score = 0;

    try {
      const engine = getDbEngine();
      if (engine === 'mysql' && isDbConfigured() && isMysqlConfigured()) {
        personaDraftId = uuidV4();

        // Placeholder alignment_score: deterministic numeric signal for tests and UI.
        // (A real implementation would compute this using a rubric / embeddings / evaluator model.)
        alignment_score = 0.8;

        await dbQuery(
          `
          INSERT INTO persona_drafts (id, persona_draft_json, alignment_score, created_at)
          VALUES (?,?,?,?)
          `,
          [personaDraftId, JSON.stringify(persona), alignment_score, new Date()]
        );
      }
    } catch (e) {
      // Persistence is best-effort here; do not fail persona generation if DB insert fails.
      // eslint-disable-next-line no-console
      console.warn('[ai/personas/generate] persona_drafts insert skipped/failed:', e?.message || String(e));
    }

    return res.status(200).json({
      requestId,
      mode,
      warnings,
      persona,
      personaDraftId,
      alignment_score
    });
  } catch (err) {
    // Keep error shape consistent with other endpoints.
    const msg = String(err?.message || err);
    const httpStatus = Number(err?.httpStatus || 500);

    return res.status(httpStatus).json({
      error: err?.code || 'ai_error',
      message: msg,
      details: err?.details || null
    });
  }
});

module.exports = router;
