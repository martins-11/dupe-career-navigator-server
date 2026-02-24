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

  // Best-effort extraction for candidate name + current role/title.
  // Kept local (no separate file) per product feedback.
  const normalizeWhitespace = (s) =>
    String(s || '')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();

  const stripDecorations = (line) =>
    normalizeWhitespace(String(line || '').replace(/^[•*\-–—|]+/, '').replace(/[|•]+/g, ' '));

  const isEmailOrPhoneLine = (line) => {
    const l = String(line || '');
    return /@/.test(l) || /\b(?:\+?\d[\d\s\-().]{7,}\d)\b/.test(l);
  };

  const isLikelySectionHeader = (line) =>
    /^(summary|profile|experience|work experience|employment|education|skills|projects|certifications|contact|objective)$/i.test(
      String(line || '').trim()
    );

  const looksLikePersonName = (line) => {
    const l = stripDecorations(line);
    if (!l || l.length > 60) return false;
    if (isEmailOrPhoneLine(l)) return false;
    if (/[0-9]/.test(l)) return false;
    if (/[,:]/.test(l)) return false;
    if (isLikelySectionHeader(l)) return false;

    const tokens = l.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 5) return false;

    const allowedHonorifics = new Set(['mr', 'mrs', 'ms', 'dr', 'prof']);
    const cleanedTokens = tokens
      .map((t) => t.replace(/\.$/, ''))
      .filter((t) => t && !allowedHonorifics.has(t.toLowerCase()));

    if (cleanedTokens.length < 2 || cleanedTokens.length > 4) return false;

    return cleanedTokens.every((t) => /^[A-Za-z][A-Za-z.'-]*$/.test(t));
  };

  const looksLikeJobTitle = (line) => {
    const l = stripDecorations(line);
    if (!l || l.length > 100) return false;
    if (isEmailOrPhoneLine(l)) return false;
    if (isLikelySectionHeader(l)) return false;
    if (/[:@]/.test(l)) return false;

    return /\b(engineer|developer|manager|lead|architect|consultant|analyst|designer|director|specialist|officer|product|research|scientist)\b/i.test(
      l
    );
  };

  const lines = text
    .split(/\r?\n/)
    .map(stripDecorations)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 120);

  const candidateName = (() => {
    // Prefer explicit "Name: X"
    for (const line of lines.slice(0, 25)) {
      const m = line.match(/^\s*(?:name)\s*[:\-]\s*(.+)\s*$/i);
      if (m && m[1]) {
        const candidate = stripDecorations(m[1]);
        if (looksLikePersonName(candidate)) return candidate;
      }
    }

    // Otherwise, first plausible name in top ~12 lines
    for (const line of lines.slice(0, 12)) {
      if (looksLikePersonName(line)) return stripDecorations(line);
    }
    return '';
  })();

  const currentRole = (() => {
    // Prefer explicit "Title:" / "Current Role:" etc
    for (const line of lines.slice(0, 40)) {
      const m = line.match(/^\s*(?:title|current\s+role|role|position)\s*[:\-]\s*(.+)\s*$/i);
      if (m && m[1] && looksLikeJobTitle(m[1])) return stripDecorations(m[1]);
    }

    // Otherwise look near the name line
    const idx = candidateName ? lines.findIndex((l) => stripDecorations(l) === candidateName) : -1;
    const start = idx >= 0 ? Math.max(0, idx - 1) : 0;
    const end = idx >= 0 ? Math.min(lines.length, idx + 8) : Math.min(lines.length, 10);

    for (let i = start; i < end; i += 1) {
      const l = stripDecorations(lines[i]);
      if (looksLikeJobTitle(l)) return l;
    }

    return (context && context.targetRole ? String(context.targetRole) : '') || '';
  })();

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
