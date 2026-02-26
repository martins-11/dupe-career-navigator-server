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

/**
 * Map the v2 persona draft format (personaService.js) into the legacy integration-test
 * contract (full_name/professional_title/etc).
 *
 * This is intentionally minimal and deterministic:
 * - It does NOT attempt sophisticated NLP parsing.
 * - It enforces the required keys and the 3/2 rule shape expected by the test.
 *
 * @param {object} v2Persona
 * @param {string} sourceText
 * @param {object|null} context
 * @returns {object} legacy persona JSON
 */
function mapV2PersonaToLegacyPersona(v2Persona, sourceText, context) {
  const text = String(sourceText || '').trim();

  const { extractBestNameAndRoleFromDocuments } = require('../utils/nameRoleExtraction');

  // IMPORTANT:
  // - If a resume is present in the provided sourceText, resume header should win.
  // - If this is a single doc PR/JD, try PR label extraction before falling back.
  const extracted = extractBestNameAndRoleFromDocuments([{ category: null, textContent: text }]);

  const candidateName = extracted.name || '';
  const currentRole =
    extracted.role ||
    ((context && context.targetRole ? String(context.targetRole) : '') || '');

  const professionalSummary =
    (v2Persona && typeof v2Persona.professional_summary === 'string' && v2Persona.professional_summary.trim()) ||
    'Persona draft generated (placeholder).';

  // Pull skills from either core_competencies or technical_stack buckets, but always enforce 3/2 rule lengths.
  const rawSkills = [];
  if (Array.isArray(v2Persona?.core_competencies)) rawSkills.push(...v2Persona.core_competencies);
  if (Array.isArray(v2Persona?.technical_stack?.languages)) rawSkills.push(...v2Persona.technical_stack.languages);
  if (Array.isArray(v2Persona?.technical_stack?.frameworks)) rawSkills.push(...v2Persona.technical_stack.frameworks);
  if (Array.isArray(v2Persona?.technical_stack?.databases)) rawSkills.push(...v2Persona.technical_stack.databases);
  if (Array.isArray(v2Persona?.technical_stack?.tools)) rawSkills.push(...v2Persona.technical_stack.tools);

  const dedupedSkills = Array.from(
    new Set(rawSkills.map((s) => String(s || '').trim()).filter(Boolean))
  );

  const mastery_skills = (dedupedSkills.length ? dedupedSkills : ['Problem solving', 'Communication', 'Ownership']).slice(
    0,
    3
  );
  while (mastery_skills.length < 3) mastery_skills.push('Generalist skill');

  const growth_areas = ['Leadership', 'Domain depth'].slice(0, 2);

  // Best-effort: estimate years if we see "X years" in the text; otherwise default to 5.
  const yearsMatch = text.match(/(\d+)\s*\+?\s*years?/i);
  const experience_years = yearsMatch ? Number.parseInt(yearsMatch[1], 10) : 5;

  return {
    full_name: candidateName,
    professional_title: currentRole,
    mastery_skills,
    growth_areas,
    experience_years: Number.isInteger(experience_years) ? experience_years : 5,
    raw_ai_summary: professionalSummary
  };
}

// PUBLIC_INTERFACE
router.post('/personas/generate', async (req, res) => {
  /**
   * Generate a professional persona JSON.
   *
   * Compatibility note:
   * - The codebase contains a newer "persona v2" draft schema (personaService.js).
   * - Existing integration tests (and some clients) expect a legacy flat schema:
   *   { full_name, professional_title, mastery_skills[3], growth_areas[2], experience_years, raw_ai_summary }.
   *
   * This endpoint now returns BOTH:
   * - persona: legacy schema (for integration compatibility)
   * - persona_v2: the underlying generated v2 persona (for forward compatibility)
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
    const result = await personaService.generatePersonaDraft(parsed.data.sourceText || '', {
      context: parsed.data.context || null
    });

    // AI failure hardening: personaService may return a structured fallback.
    if (result && typeof result === 'object' && result.error === 'AI_GENERATION_FAILED') {
      return res.status(502).json({
        requestId,
        ...result
      });
    }

    const { persona: personaV2, mode, warnings } = result;

    // Map into legacy integration-test contract.
    const legacyPersona = mapV2PersonaToLegacyPersona(
      personaV2,
      parsed.data.sourceText || '',
      parsed.data.context || null
    );

    // Best-effort persistence contract:
    // - Persist the LEGACY persona JSON so the integration test's DB assertion matches.
    let personaDraftId = null;

    try {
      const persisted = await personaService.createPersonaDraft({
        personaDraftJson: legacyPersona,
        alignmentScore: 0
      });

      personaDraftId = persisted.personaDraftId;
    } catch (e) {
      // Persistence is best-effort; do not fail persona generation if DB insert fails.
      // eslint-disable-next-line no-console
      console.warn('[ai/personas/generate] persona_drafts insert skipped/failed:', e);
    }

    return res.status(200).json({
      requestId,
      mode,
      warnings,
      persona: legacyPersona,
      persona_v2: personaV2,
      personaDraftId,
      alignment_score: 0
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
