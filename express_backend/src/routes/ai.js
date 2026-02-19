'use strict';

const express = require('express');
const { z } = require('zod');
const { uuidV4 } = require('../utils/uuid');

const router = express.Router();

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

function makePlaceholderPersona({ sourceText, context }) {
  // Keep placeholder deterministic and safe: only derive small hints from the input.
  const text = (sourceText || '').trim();
  const length = text.length;

  // Very lightweight keyword sniffing (no PII extraction; no "smart" model behavior).
  const lower = text.toLowerCase();
  const maybeSkills = [];
  if (/\breact\b/.test(lower)) maybeSkills.push('React');
  if (/\bnode\b/.test(lower)) maybeSkills.push('Node.js');
  if (/\bexpress\b/.test(lower)) maybeSkills.push('Express');
  if (/\bpostgres\b|\bpostgresql\b/.test(lower)) maybeSkills.push('PostgreSQL');
  if (/\baws\b/.test(lower)) maybeSkills.push('AWS');
  if (/\bpython\b/.test(lower)) maybeSkills.push('Python');

  const targetRole = context?.targetRole || null;
  const industry = context?.industry || null;
  const seniority = context?.seniority || null;

  return {
    schemaVersion: '0.1.0',
    title: targetRole ? `${targetRole} Persona (Draft)` : 'Professional Persona (Draft)',
    summary:
      'Placeholder persona generated without an LLM. Replace with real AI integration in a future step.',
    profile: {
      headline: targetRole || 'Professional',
      seniority,
      industry,
      location: null
    },
    strengths: [
      'Clear communication',
      'Ownership mindset',
      'Continuous improvement'
    ],
    skills: maybeSkills.length ? maybeSkills : ['Problem solving', 'Collaboration', 'Writing'],
    experienceHighlights: [
      'Built and shipped features end-to-end (placeholder).',
      'Collaborated with cross-functional teams (placeholder).'
    ],
    // Include minimal provenance for UI debugging without leaking anything sensitive.
    provenance: {
      source: 'placeholder',
      sourceTextLength: length
    }
  };
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

  const persona = makePlaceholderPersona({
    sourceText: parsed.data.sourceText || '',
    context: parsed.data.context || null
  });

  return res.status(200).json({
    requestId,
    mode: 'placeholder',
    warnings: [
      'Placeholder implementation: no AI model invoked and no DB reads performed.'
    ],
    persona
  });
});

module.exports = router;
