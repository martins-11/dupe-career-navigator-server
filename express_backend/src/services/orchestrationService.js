import { getZodSync } from '../utils/zod.js';
import documentsRepo from '../repositories/documentsRepoAdapter.js';
import personasRepo from '../repositories/personasRepoAdapter.js';
import { normalizeText } from './normalizationService.js';
import buildsService from './buildsService.js';
import workflowService from './workflowService.js';
import aiRunsRepo from '../repositories/aiRunsRepoAdapter.js';
import userTargetsRepo from '../repositories/userTargetsRepoAdapter.js';
import { uuidV4 } from '../utils/uuid.js';
import personaService from './personaService.js';
import { extractBestNameAndRoleFromDocuments, extractNameAndCurrentRole } from '../utils/nameRoleExtraction.js';
import { DOCUMENT_CATEGORIES } from '../models/documentCategories.js';

const { z } = getZodSync();

/**
 * Best-effort display normalization for persona "header" fields.
 * We treat `full_name` as the person's name, and role/title fields separately.
 */
function _cleanStr(s) {
  return String(s ?? '').trim();
}

function _looksLikePersonName(s) {
  const v = _cleanStr(s);
  if (!v) return false;
  if (v.length > 60) return false;
  if (/[0-9]/.test(v)) return false;
  if (/[@]/.test(v)) return false;

  // "First Last" or "First Middle Last" style (2-4 tokens)
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;

  return parts.every((p) => /^[A-Za-z][A-Za-z.'-]*$/.test(p));
}

function _looksLikeRoleOrHeadline(s) {
  const v = _cleanStr(s).toLowerCase();
  if (!v) return false;

  // If it contains typical role keywords, treat as role-ish.
  if (
    /\b(engineer|developer|manager|lead|architect|consultant|analyst|designer|director|specialist|officer|product|research|scientist|intern)\b/.test(
      v
    )
  ) {
    return true;
  }

  // "X — Y" headline patterns are not names.
  if (/[—-]\s+/.test(v) && v.split(/\s+/).length >= 3) return true;

  // Long sentence-like strings are not names.
  if (v.length > 80) return true;

  return false;
}

/**
 * Orchestration service (in-memory).
 *
 * Purpose:
 * - Provide endpoints that "link" the existing building blocks:
 *   build/workflow sessions -> uploads -> extraction/normalization -> AI persona generation
 * - Keep everything safe without DB credentials (repositories default to memory)
 * - Keep AI safe without AI credentials (uses existing placeholder generation behavior)
 *
 * NOTE:
 * - This module stores orchestration-level references in process memory only.
 * - It relies on existing routes/services for the heavy lifting.
 *
 * Persona validation hardening:
 * - Once validation has begun (draft exists OR final exists), document set mutations must be rejected
 *   server-side (read-only documents post-validation).
 * - Relying only on in-memory orchestration state is insufficient across restarts; therefore, we also
 *   consult persisted draft/final blobs via personasRepo when personaId is known.
 */

const _orchestrations = new Map(); // buildId -> orchestration record

function _nowIso() {
  return new Date().toISOString();
}

/**
 * Determine whether a build/persona has entered "validation stage" where documents become read-only.
 *
 * Rules:
 * - If orchestration record indicates personaDraft or personaFinal exists -> locked.
 * - Else, if a personaId is known, consult personasRepo draft/final blobs:
 *   - draft exists -> locked
 *   - final exists -> locked
 *
 * @param {{ buildId: string, personaId: string|null, orchestration: object|null }} input
 * @returns {Promise<{locked: boolean, reason: 'draft'|'final'|null}>}
 */
async function _isDocumentMutationLocked({ buildId, personaId, orchestration }) {
  // Fast path: orchestration already has draft/final in memory.
  if (orchestration?.personaFinal) return { locked: true, reason: 'final' };
  if (orchestration?.personaDraft) return { locked: true, reason: 'draft' };

  // If no personaId, we can't consult persisted state; treat as unlocked.
  if (!personaId) return { locked: false, reason: null };

  // Consult persisted draft/final blobs (memory/db via adapter).
  // If the persona does not exist or these methods aren't supported, adapter will throw or return null.
  try {
    const [draft, finalBlob] = await Promise.all([
      personasRepo.getDraft(personaId),
      personasRepo.getFinal(personaId)
    ]);

    if (finalBlob?.finalJson) return { locked: true, reason: 'final' };
    if (draft?.draftJson) return { locked: true, reason: 'draft' };
  } catch (err) {
    // Be conservative: if the persona exists but persistence is temporarily failing, we should not
    // allow mutations that can invalidate an ongoing validation flow. Reject mutations.
    const e = new Error(
      'Unable to verify persona validation state to safely mutate documents. Please retry later.'
    );
    e.code = 'DOCUMENT_MUTATION_GUARD_UNAVAILABLE';
    e.httpStatus = 422;
    e.details = { buildId, personaId };
    throw e;
  }

  return { locked: false, reason: null };
}

/**
 * Throws a 422 error if document mutations are not allowed for the given build/persona.
 *
 * @param {{ buildId: string, personaId: string|null, orchestration: object|null, action: string }} input
 * @returns {Promise<void>}
 */
async function _assertDocumentsMutable({ buildId, personaId, orchestration, action }) {
  const { locked, reason } = await _isDocumentMutationLocked({ buildId, personaId, orchestration });
  if (!locked) return;

  const err = new Error(
    `Documents are read-only once validation begins (${reason} exists). ` +
      `Start a new build/persona to ${action} documents.`
  );
  err.code = 'DOCUMENTS_READ_ONLY_POST_VALIDATION';
  err.httpStatus = 422;
  err.details = { buildId, personaId, lockedReason: reason, action };
  throw err;
}

/**
 * Attempt to persist build<->documents links.
 *
 * This must remain DB-optional: if DB isn't configured or the repo doesn't support
 * link persistence, we treat it as a no-op and keep working from in-memory orchestration.
 */
async function _bestEffortPersistBuildDocumentsLink(buildId, documentIds) {
  try {
    if (!documentIds || documentIds.length === 0) return;

    // Prefer a bulk operation if available.
    if (typeof buildsService.linkDocumentsToBuild === 'function') {
      // PUBLIC_INTERFACE via buildsService (if implemented)
      // eslint-disable-next-line no-await-in-loop
      await buildsService.linkDocumentsToBuild(buildId, documentIds);
      return;
    }

    // Fallback: if a single-link API exists, call it for each doc.
    if (typeof buildsService.linkDocumentToBuild === 'function') {
      for (const documentId of documentIds) {
        // eslint-disable-next-line no-await-in-loop
        await buildsService.linkDocumentToBuild(buildId, documentId);
      }
    }
  } catch (err) {
    // No-op: keep DB-optional behavior intact.
  }
}

/**
 * Load the latest extracted text rows for the given documents from persistence.
 * Uses documentsRepo adapter, which already routes to mysql/postgres/memory.
 *
 * @returns {Promise<{extractedRows: Array<object>, extractedById: Record<string, object|null>}>}
 */
async function _loadLatestExtractedTextForDocuments(documentIds) {
  const extractedRows = [];
  const extractedById = {};

  for (const documentId of documentIds) {
    // eslint-disable-next-line no-await-in-loop
    const latest = await documentsRepo.getLatestExtractedText(documentId);
    if (latest && latest.textContent) {
      extractedRows.push(latest);
      extractedById[documentId] = latest;
    } else {
      extractedById[documentId] = null;
    }
  }

  return { extractedRows, extractedById };
}

function _getOrNull(buildId) {
  return _orchestrations.get(buildId) || null;
}

function _ensure(buildId) {
  const existing = _getOrNull(buildId);
  if (existing) return existing;

  const created = {
    buildId,
    uploadId: null,
    documentIds: [],
    extractedTextByDocumentId: {}, // documentId -> latest extracted text row-like object
    normalizedText: null,
    personaId: null,
    personaDraft: null,
    personaFinal: null,
    createdAt: _nowIso(),
    updatedAt: _nowIso()
  };

  _orchestrations.set(buildId, created);
  return created;
}

function _touch(record, patch) {
  const next = { ...record, ...patch, updatedAt: _nowIso() };
  _orchestrations.set(record.buildId, next);
  return next;
}

function _concatTexts(rows) {
  /**
   * Combine extracted text rows into a single source blob for downstream persona generation.
   *
   * Bugfix / product requirement:
   * - When multiple documents are combined, resumes tend to be much longer and can dominate the input,
   *   causing job descriptions and performance reviews to be underweighted.
   *
   * Approach (minimal, explainable, non-AI):
   * - Add explicit per-document category headers to make downstream prompt sectioning more reliable.
   * - Cap how much text each document contributes so shorter docs (JD/review) remain influential.
   */
  const MAX_PER_DOCUMENT_CHARS = Number(process.env.ORCH_MAX_CHARS_PER_DOCUMENT || 12000);

  const safeTrim = (s) => String(s || '').trim();

  const cap = (s, max) => {
    if (!max || !Number.isFinite(max) || max <= 0) return s;
    return s.length > max ? s.slice(0, max) : s;
  };

  return (rows || [])
    .map((r) => {
      const text = safeTrim(r?.textContent || '');
      if (!text) return '';

      const category = r?.metadataJson?.category || r?.category || null;
      const header = category ? `[[DOCUMENT_CATEGORY:${category}]]` : '[[DOCUMENT_CATEGORY:unknown]]';

      // Cap AFTER trimming so we don't waste budget on leading whitespace.
      const capped = cap(text, MAX_PER_DOCUMENT_CHARS);

      return [header, capped].join('\n');
    })
    .filter(Boolean)
    .join('\n\n-----\n\n');
}

/**
 * Shared schema for "start workflow and immediately return buildId".
 * We intentionally support two start modes:
 * - upload-first: caller starts a build, then uploads tied to build
 * - upload-and-start: caller uploads (or provides doc ids) and starts a build in one call
 */
const OrchestrationStartRequest = z.object({
  mode: z.enum(['persona_build', 'workflow']).nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  personaId: z.string().uuid().nullable().optional(),
  // If documentIds provided, orchestration will use those existing documents.
  documentIds: z.array(z.string().uuid()).optional(),
  // Optional AI context for later generation
  context: z
    .object({
      targetRole: z.string().min(1).nullable().optional(),
      seniority: z.string().min(1).nullable().optional(),
      industry: z.string().min(1).nullable().optional()
    })
    .nullable()
    .optional(),
  // Whether to auto-create a persona container row when generating draft/final
  autoCreatePersona: z.boolean().optional()
});

const OrchestrationUploadLinkRequest = z.object({
  uploadId: z.string().uuid(),
  documentIds: z.array(z.string().uuid()).min(1)
});

const OrchestrationExtractRequest = z.object({
  // If omitted, uses linked documents from build orchestration.
  //
  // IMPORTANT (persona validation hardening):
  // After a build has produced a personaDraft (i.e., user is in validation/edit flow),
  // we disallow changing the document set for that build via this endpoint.
  // Document selection should happen only during ingestion/upload.
  documentIds: z.array(z.string().uuid()).optional(),
  // Normalize options
  normalize: z
    .object({
      removeExtraWhitespace: z.boolean().optional(),
      normalizeLineBreaks: z.boolean().optional(),
      maxLength: z.number().int().positive().optional()
    })
    .optional(),
  // If true, also persist extracted text rows to documentsRepo (default true).
  persistToDocuments: z.boolean().optional()
});

const OrchestrationGenerateRequest = z.object({
  // Uses already-normalized text if present; otherwise will derive from latest extracted text.
  // Allows overriding the input text (DB-independent).
  sourceTextOverride: z.string().min(1).optional(),
  context: z
    .object({
      targetRole: z.string().min(1).nullable().optional(),
      seniority: z.string().min(1).nullable().optional(),
      industry: z.string().min(1).nullable().optional()
    })
    .nullable()
    .optional(),
  // If provided, draft is saved to this persona (memory by default).
  personaId: z.string().uuid().optional(),
  // If true, save draft to personasRepo.saveDraft (default true if personaId exists/created)
  saveDraft: z.boolean().optional(),
  // If true, create a persona version for the draft (optional; default false)
  createVersion: z.boolean().optional()
});

const OrchestrationFinalizeRequest = z.object({
  // By default finalize uses draft; caller may override final json.
  finalOverride: z.record(z.any()).optional(),
  personaId: z.string().uuid().optional(),
  saveFinal: z.boolean().optional(),
  createVersion: z.boolean().optional()
});

const OrchestrationRunAllRequest = z.object({
  /**
   * Full end-to-end orchestration request.
   *
   * IMPORTANT (additive semantics):
   * - Previously, the caller had to provide `documentIds` or `uploadLink`.
   * - Now, the caller MAY omit those and instead rely on category-based auto-selection:
   *   the service will load the latest uploaded docs for the user in these categories:
   *   resume, job_description, performance_review.
   *
   * Existing contracts remain supported; this is additive.
   */
  mode: z.enum(['persona_build', 'workflow']).nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  personaId: z.string().uuid().nullable().optional(),
  context: z
    .object({
      targetRole: z.string().min(1).nullable().optional(),
      seniority: z.string().min(1).nullable().optional(),
      industry: z.string().min(1).nullable().optional()
    })
    .nullable()
    .optional(),

  // Existing inputs (still supported):
  uploadLink: OrchestrationUploadLinkRequest.optional(),
  documentIds: z.array(z.string().uuid()).min(1).optional(),

  /**
   * Additive:
   * If true, orchestration will auto-select latest docs by category (requires userId).
   * Default: true (so MVP does "no user selection" out of the box).
   */
  useLatestCategoryDocs: z.boolean().optional(),

  // Optional knobs for extract/normalize and draft generation.
  extract: OrchestrationExtractRequest.optional(),
  generate: OrchestrationGenerateRequest.optional(),

  // Optional: include a finalize step.
  finalize: OrchestrationFinalizeRequest.optional(),

  // If true, will create persona automatically when generating draft if personaId not provided.
  autoCreatePersona: z.boolean().optional()
});

function _makePlaceholderPersona({ sourceText, context }) {
  /**
   * Internal placeholder persona generation.
   * This intentionally mirrors the behavior of /ai/personas/generate, but is usable from orchestration.
   *
   * IMPORTANT: strict schema validation requirement.
   */
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

  /**
   * Prefer authoritative extraction captured during uploads:
   * - uploads persists extracted_text.metadataJson.extractedPersonFullName / extractedCurrentRoleTitle
   * - This lets persona drafts reflect the correct name/role even if heuristic extraction differs.
   *
   * Because _makePlaceholderPersona only receives a combined text blob, we cannot directly access
   * per-document metadata here, so we fall back to the heuristic extractor.
   *
   * Note: The Bedrock-backed personaService.generatePersonaDraft() path is used for real drafts;
   * this placeholder is kept for non-LLM mode.
   */
  const extracted = extractBestNameAndRoleFromDocuments([{ category: null, textContent: text }]);

  const roleForDisplay = extracted.role || targetRole || 'Professional';
  const nameForDisplay = extracted.name || 'Professional';

  const draft = {
    schemaVersion: '0.1.0',
    title: `${nameForDisplay} — ${roleForDisplay} Persona (Draft)`,
    summary:
      'Persona draft generated without an LLM (Claude integration pending). This output is schema-validated JSON.',
    profile: {
      headline: `${nameForDisplay} — ${roleForDisplay}`,
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

  return PersonaDraftSchema.parse(draft);
}

// PUBLIC_INTERFACE
function getOrchestration(buildId) {
  /** Get orchestration record for a buildId (or null if none). */
  return _getOrNull(buildId);
}

// PUBLIC_INTERFACE
async function startOrchestration(input) {
  /**
   * Create a build/workflow and initialize an orchestration record.
   *
   * @param {unknown} input - validated by OrchestrationStartRequest
   * @returns {Promise<{build: object, orchestration: object}>}
   */
  const parsed = OrchestrationStartRequest.parse(input || {});

  // buildsService.createBuild is async (it persists build record), so we must await it
  // to ensure we return a populated build object (with id) to callers like /orchestration/run-all.
  const build = await buildsService.createBuild({
    personaId: parsed.personaId ?? null,
    documentId: parsed.documentIds?.[0] ?? null,
    mode: parsed.mode ?? 'workflow'
  });

  const orchestration = _ensure(build.id);

  const next = _touch(orchestration, {
    personaId: parsed.personaId ?? orchestration.personaId,
    documentIds: Array.isArray(parsed.documentIds) ? parsed.documentIds : orchestration.documentIds,
    context: parsed.context ?? null,
    userId: parsed.userId ?? null,
    autoCreatePersona: Boolean(parsed.autoCreatePersona)
  });

  // Best-effort: persist build<->documents links (DB optional; no-op if unsupported).
  await _bestEffortPersistBuildDocumentsLink(build.id, next.documentIds);

  return { build, orchestration: next };
}

// PUBLIC_INTERFACE
async function linkUploadToBuild(buildId, input) {
  /**
   * Link an existing upload batch (uploadId) and documentIds to a build orchestration.
   *
   * Persona Validation hardening:
   * - Once validation begins (draft exists OR final exists), the document set is locked.
   * - We must enforce this server-side even across restarts (so we also consult personasRepo).
   */
  const parsed = OrchestrationUploadLinkRequest.parse(input || {});
  const orch = _ensure(buildId);

  await _assertDocumentsMutable({
    buildId,
    personaId: orch.personaId ?? null,
    orchestration: orch,
    action: 'link'
  });

  // Persist link best-effort; do not block request if DB not configured.
  // Note: fire-and-forget is acceptable here to keep route contract stable and avoid surfacing DB errors.
  void _bestEffortPersistBuildDocumentsLink(buildId, parsed.documentIds);

  return _touch(orch, {
    uploadId: parsed.uploadId,
    documentIds: parsed.documentIds
  });
}

// PUBLIC_INTERFACE
async function extractAndNormalizeForBuild(buildId, input) {
  /**
   * Load latest extracted text for linked documents from persistence (DB via adapter, memory fallback),
   * then compute a normalized combined text blob.
   *
   * Persona Validation hardening:
   * - Once a persona draft has been generated for this build, the set of documents must not change.
   *   Therefore, this endpoint rejects `documentIds` overrides after `personaDraft` exists.
   *
   * Behavior:
   * - Reads stored extracted text via documentsRepo.getLatestExtractedText(documentId)
   * - Does NOT attempt ad-hoc extraction here (no file bytes available). This keeps contracts stable:
   *   extraction is handled by /uploads/* or /documents/:id/extracted-text.
   *
   * This method does not require DB credentials (memory repo default).
   */
  const parsed = OrchestrationExtractRequest.parse(input || {});
  const orch = _ensure(buildId);

  // Disallow changing the document set once validation begins (draft/final exists).
  if (parsed.documentIds?.length) {
    await _assertDocumentsMutable({
      buildId,
      personaId: orch.personaId ?? null,
      orchestration: orch,
      action: 'change'
    });
  }

  const documentIds = parsed.documentIds?.length ? parsed.documentIds : orch.documentIds;
  if (!documentIds || documentIds.length === 0) {
    const err = new Error('No documentIds available for extraction. Link upload/documents to build first.');
    err.code = 'NO_DOCUMENTS';
    throw err;
  }

  // Best-effort: persist build<->documents links for multi-doc builds (no-op if DB not configured).
  await _bestEffortPersistBuildDocumentsLink(buildId, documentIds);

  // Update workflow status (best-effort; keeps /builds polling meaningful).
  const wf = workflowService.getWorkflow(buildId);
  if (wf && wf.status !== 'cancelled') {
    // We cannot mutate internal map directly; just let normal schedule run.
    // Still, orchestration will proceed.
  }

  // Load extracted text for ALL linked documents (resume/jd/review when present).
  const { extractedRows, extractedById } = await _loadLatestExtractedTextForDocuments(documentIds);

  const combined = _concatTexts(extractedRows);
  if (!combined.trim()) {
    const err = new Error(
      'No extracted text available for linked documents. Ensure extracted text was stored via /uploads/* or /documents/:id/extracted-text.'
    );
    err.code = 'NO_EXTRACTED_TEXT';
    throw err;
  }

  const normalized = normalizeText(combined, {
    removeExtraWhitespace: parsed.normalize?.removeExtraWhitespace,
    normalizeLineBreaks: parsed.normalize?.normalizeLineBreaks,
    maxLength: parsed.normalize?.maxLength
  });

  const next = _touch(orch, {
    documentIds,
    extractedTextByDocumentId: extractedById,
    normalizedText: normalized.text
  });

  return {
    buildId,
    documentIds,
    normalizedText: normalized.text,
    stats: normalized.stats,
    orchestration: next
  };
}

// PUBLIC_INTERFACE
async function generatePersonaDraftForBuild(buildId, input) {
  /**
   * Generate a persona draft for a build using Bedrock-backed personaService.generatePersonaDraft().
   *
   * Bugfix requirement:
   * - Ensure the "current role/designation" is actually populated in the returned + persisted draft
   *   (and therefore visible in draft/final persona views).
   *
   * Approach:
   * - Extract (name, role) from the exact same sourceText used for persona generation.
   * - If role is blank, fall back to the latest persisted user current role (user_targets) when userId exists.
   * - Inject role into commonly used fields across evolving schemas:
   *   - v2: current_role + full_name (already emitted by personaService, but keep defensive)
   *   - legacy-ish: professional_title
   *   - display: title/headline if present but empty
   */
  const parsed = OrchestrationGenerateRequest.parse(input || {});
  const orch = _ensure(buildId);

  let personaId = parsed.personaId || orch.personaId || null;

  // Create persona if requested/needed (memory by default).
  if (!personaId && orch.autoCreatePersona) {
    const created = await personasRepo.createPersona({
      userId: orch.userId ?? null,
      title: null,
      personaJson: undefined
    });
    personaId = created.id;
  }

  const sourceText =
    parsed.sourceTextOverride ||
    orch.normalizedText ||
    (() => {
      // derive from latest extracted blobs if normalized text wasn't computed
      const rows = Object.values(orch.extractedTextByDocumentId || {}).filter(Boolean);
      return _concatTexts(rows);
    })();

  if (!sourceText || !String(sourceText).trim()) {
    const err = new Error(
      'No source text available. Run extraction/normalization first or provide sourceTextOverride.'
    );
    err.code = 'NO_SOURCE_TEXT';
    throw err;
  }

  const context = parsed.context ?? orch.context ?? null;

  // Track AI run in persistence adapter (memory by default).
  const aiRun = await aiRunsRepo.createAiRun({
    buildId,
    personaId: personaId ?? null,
    status: 'running',
    provider: 'placeholder',
    model: null,
    request: {
      type: 'persona_draft_generation',
      context,
      sourceTextLength: String(sourceText).length
    }
  });

  try {
    const result = await personaService.generatePersonaDraft(sourceText, { context });

    // personaService may return a structured fallback: { error: 'AI_GENERATION_FAILED', retryable: true }
    if (result && typeof result === 'object' && result.error === 'AI_GENERATION_FAILED') {
      const err = new Error('AI persona generation failed.');
      err.code = 'AI_GENERATION_FAILED';
      err.httpStatus = 502;
      err.details = { retryable: true };
      throw err;
    }

    const { persona: basePersonaDraft, mode, warnings } = result;

    const extracted = extractNameAndCurrentRole(sourceText);

    // Prefer authoritative per-document extraction persisted during uploads (extracted_text.metadataJson).
    // This is the key propagation path that makes the frontend reflect Bedrock-extracted values.
    const extractedRows = Object.values(orch.extractedTextByDocumentId || {}).filter(Boolean);
    const authoritativeName =
      extractedRows
        .map((r) => r?.metadataJson?.extractedPersonFullName)
        .find((v) => typeof v === 'string' && v.trim()) || '';
    const authoritativeRole =
      extractedRows
        .map((r) => r?.metadataJson?.extractedCurrentRoleTitle)
        .find((v) => typeof v === 'string' && v.trim()) || '';

    const extractedName = authoritativeName || extracted?.name || '';
    const extractedRole = authoritativeRole || extracted?.role || '';

    // If heuristic extraction didn't yield a role, fall back to persisted user current role (if available).
    let roleFromUserTargets = '';
    if (!extractedRole && orch.userId) {
      try {
        const latest = await userTargetsRepo.getLatestUserCurrentRole({ userId: String(orch.userId) });
        roleFromUserTargets = latest?.currentRoleTitle ? String(latest.currentRoleTitle).trim() : '';
      } catch (_) {
        roleFromUserTargets = '';
      }
    }

    // Final candidate values (may still be empty).
    const resolvedRole = _cleanStr(extractedRole || roleFromUserTargets || '');
    const resolvedName = _cleanStr(extractedName || '');

    // If base draft already has fields, keep them. Only fill missing values.
    const baseFullName = basePersonaDraft?.full_name;
    const baseTitle = basePersonaDraft?.title;
    const baseHeadline = basePersonaDraft?.profile?.headline;
    const baseCurrentRole = basePersonaDraft?.current_role;
    const baseProfessionalTitle = basePersonaDraft?.professional_title;

    // Do NOT allow title/headline-like strings to populate full_name.
    // If extraction didn't yield a plausible person name, leave full_name empty (UI should fall back).
    const safeNameCandidate = _looksLikePersonName(resolvedName) ? resolvedName : '';

    const personaDraft =
      basePersonaDraft && typeof basePersonaDraft === 'object'
        ? {
            ...basePersonaDraft,

            // Person name: only set when we have a plausible name.
            full_name: _cleanStr(baseFullName) ? baseFullName : safeNameCandidate,

            // Role / designation: prefer explicit existing values, else fill from resolvedRole.
            current_role: _cleanStr(baseCurrentRole) ? baseCurrentRole : resolvedRole,
            professional_title: _cleanStr(baseProfessionalTitle) ? baseProfessionalTitle : resolvedRole,

            // Display title: OK to be a composed string, but must never be used as "name".
            title:
              typeof baseTitle === 'string' && baseTitle.trim()
                ? baseTitle
                : safeNameCandidate && resolvedRole
                  ? `${safeNameCandidate} — ${resolvedRole}`
                  : resolvedRole
                    ? `${resolvedRole} Persona (Draft)`
                    : typeof baseHeadline === 'string' && baseHeadline.trim()
                      ? baseHeadline
                      : baseTitle
          }
        : basePersonaDraft;

    // Persist draft (in-memory or DB; adapter supports saveDraft)
    // Re-generate semantics:
    // - if createVersion is true, archive the PREVIOUS draft (if present) as a version
    // - then save the NEW draft as the active draft
    const shouldSaveDraft = parsed.saveDraft ?? Boolean(personaId);
    let savedDraft = null;
    let createdVersion = null;

    /**
     * Contract hardening:
     * - `createVersion` only makes sense when we have a stable personaId (version history is per persona).
     * - If personaId is not available yet, do NOT fail the request; treat createVersion as a no-op.
     *   This prevents 422s in ingestion flows that rely on autoCreatePersona.
     */
    const canCreateVersion = Boolean(personaId);

    if (personaId && shouldSaveDraft) {
      if (parsed.createVersion && canCreateVersion) {
        const existingDraft = await personasRepo.getDraft(personaId);
        const existingDraftJson = existingDraft?.draftJson ?? null;
        if (existingDraftJson) {
          createdVersion = await personasRepo.createPersonaVersion(personaId, {
            personaJson: existingDraftJson
          });
        }
      }

      savedDraft = await personasRepo.saveDraft(personaId, personaDraft);
    }

    await aiRunsRepo.updateAiRun(aiRun.id, {
      status: 'succeeded',
      provider: mode === 'bedrock' ? 'aws_bedrock' : 'mock',
      response: { persona: personaDraft }
    });

    const next = _touch(orch, {
      personaId: personaId ?? orch.personaId,
      personaDraft,
      lastAiRunId: aiRun.id,

      artifacts: {
        ...(orch.artifacts || {}),
        extractedName: resolvedName,
        extractedRole: resolvedRole
      }
    });

    return {
      requestId: uuidV4(),
      aiRunId: aiRun.id,
      mode,
      warnings,
      buildId,
      personaId: personaId ?? null,
      persona: personaDraft,
      savedDraft,
      createdVersion,
      orchestration: next,

      extractedName: resolvedName,
      extractedRole: resolvedRole
    };
  } catch (err) {
    await aiRunsRepo.updateAiRun(aiRun.id, {
      status: 'failed',
      error: { code: err?.code || 'AI_RUN_FAILED', message: err?.message || String(err) }
    });
    throw err;
  }
}

// PUBLIC_INTERFACE
async function finalizePersonaForBuild(buildId, input) {
  /**
   * Finalize persona for a build:
   * - uses draft by default, or finalOverride if provided
   * - saves via personasRepo.saveFinal if personaId available
   * - optionally creates a persona version
   */
  const parsed = OrchestrationFinalizeRequest.parse(input || {});
  const orch = _ensure(buildId);

  const personaId = parsed.personaId || orch.personaId || null;

  const finalJson = parsed.finalOverride || orch.personaDraft;
  if (!finalJson) {
    const err = new Error('No draft available to finalize. Generate a draft first or provide finalOverride.');
    err.code = 'NO_DRAFT';
    throw err;
  }

  const shouldSaveFinal = parsed.saveFinal ?? Boolean(personaId);
  let savedFinal = null;
  let createdVersion = null;

  if (personaId && shouldSaveFinal) {
    // Persist explicit final artifact for persona-driven scoring/recommendations.
    savedFinal = await personasRepo.saveFinal(personaId, finalJson);

    // Optional: also create a version snapshot (history/audit).
    if (parsed.createVersion) {
      createdVersion = await personasRepo.createPersonaVersion(personaId, { personaJson: finalJson });
    }
  }

  const next = _touch(orch, {
    personaId: personaId ?? orch.personaId,
    personaFinal: finalJson
  });

  return {
    buildId,
    personaId: personaId ?? null,
    final: finalJson,
    savedFinal,
    createdVersion,
    orchestration: next
  };
}

function _updateWorkflowProgress(buildId, patch) {
  /**
   * Best-effort workflow progress updater (hardening).
   *
   * /builds/{id}/status reads from workflowService, so orchestration should update it deterministically:
   * - progress/message/currentStep patched monotonically
   * - terminal states set via succeedWorkflow/failWorkflow (state machine enforced)
   *
   * @param {string} buildId
   * @param {{ status?: 'running'|'succeeded'|'failed'|'cancelled', progress?: number, message?: string|null, currentStep?: string|null, failure?: object }} patch
   */
  const wf = workflowService.getWorkflowUnsafeRead
    ? workflowService.getWorkflowUnsafeRead(buildId)
    : workflowService.getWorkflow(buildId);

  if (!wf) return null;

  // If caller is trying to set a terminal status, use the explicit APIs.
  if (patch && patch.status === 'failed') {
    return workflowService.failWorkflow(buildId, patch.message || 'Build failed.', patch.failure || null);
  }
  if (patch && patch.status === 'succeeded') {
    return workflowService.succeedWorkflow(buildId, patch.message || 'Build complete.');
  }

  // For non-terminal status updates, patch safe fields.
  if (workflowService.patchWorkflow) {
    return workflowService.patchWorkflow(buildId, {
      progress: patch.progress,
      message: patch.message,
      currentStep: patch.currentStep
    });
  }

  return wf;
}

// PUBLIC_INTERFACE
async function runAllOrchestration(input) {
  /**
   * Run the full orchestration workflow end-to-end:
   * - start build/workflow
   * - link upload/documents OR auto-select latest category docs (additive)
   * - extract+normalize
   * - generate draft
   * - optional finalize
   *
   * Returns immediately with buildId so clients can poll /builds/{id}/status.
   * Also returns the latest orchestration snapshot for convenience.
   *
   * This function executes synchronously (within request) but updates an in-memory
   * orchestration "progress" trace that the client can read at /orchestration/builds/{id}.
   */
  const parsed = OrchestrationRunAllRequest.parse(input || {});

  // 1) Start build + orchestration record.
  const { build, orchestration: initialOrch } = await startOrchestration({
    mode: parsed.mode ?? 'workflow',
    userId: parsed.userId ?? null,
    personaId: parsed.personaId ?? null,
    context: parsed.context ?? null,

    /**
     * Contract hardening (fix 422 during ingestion persona generation):
     * - Orchestration run-all is used by the MVP ingestion flow, where the frontend often does not have
     *   an existing personaId yet.
     * - In that case, the backend must be able to create a persona container automatically so that
     *   downstream steps like saveDraft/createVersion can behave deterministically.
     *
     * OpenAPI/PRD intent: "out of the box" run-all should work with minimal client inputs.
     * Therefore, default autoCreatePersona to true for run-all unless explicitly disabled.
     */
    autoCreatePersona: parsed.autoCreatePersona ?? true,

    documentIds: parsed.documentIds
  });

  let orch = _touch(initialOrch, {
    runAll: {
      status: 'running',
      progress: 5,
      step: 'start',
      message: 'Orchestration started.',
      startedAt: _nowIso(),
      finishedAt: null,
      error: null
    }
  });

  // 2) Link upload/document IDs OR auto-select
  try {
    // Ensure workflow shows "running" immediately (queued -> running transition is enforced by simulator,
    // but we patch message/progress deterministically).
    _updateWorkflowProgress(build.id, {
      status: 'running',
      progress: 10,
      currentStep: 'validate_inputs',
      message: 'Orchestration running…'
    });

    const assertNotCancelled = () => {
      const wf = workflowService.getWorkflowStatus(build.id);
      if (wf?.status === 'cancelled') {
        const e = new Error('Build was cancelled.');
        e.code = 'BUILD_CANCELLED';
        e.httpStatus = 422;
        throw e;
      }
    };

    orch = _touch(orch, {
      runAll: { ...orch.runAll, progress: 15, step: 'link', message: 'Linking documents…' }
    });
    _updateWorkflowProgress(build.id, {
      progress: 15,
      currentStep: 'validate_inputs',
      message: 'Linking documents…'
    });
    assertNotCancelled();

    const useLatestCategoryDocs = parsed.useLatestCategoryDocs ?? true;

    if (parsed.uploadLink) {
      orch = await linkUploadToBuild(build.id, parsed.uploadLink);
    } else if (parsed.documentIds?.length) {
      orch = _touch(orch, { documentIds: parsed.documentIds });
      await _bestEffortPersistBuildDocumentsLink(build.id, parsed.documentIds);
    } else if (useLatestCategoryDocs) {
      const effectiveUserId = parsed.userId ?? null;

      orch = _touch(orch, {
        runAll: { ...orch.runAll, progress: 20, step: 'auto_select', message: 'Selecting latest uploaded docs…' }
      });
      _updateWorkflowProgress(build.id, {
        progress: 20,
        currentStep: 'validate_inputs',
        message: 'Selecting latest uploaded docs…'
      });
      assertNotCancelled();

      const latestResume = await documentsRepo.getLatestDocumentForUserByCategory(
        effectiveUserId,
        DOCUMENT_CATEGORIES.RESUME
      );
      const latestJd = await documentsRepo.getLatestDocumentForUserByCategory(
        effectiveUserId,
        DOCUMENT_CATEGORIES.JOB_DESCRIPTION
      );
      const latestPerf = await documentsRepo.getLatestDocumentForUserByCategory(
        effectiveUserId,
        DOCUMENT_CATEGORIES.PERFORMANCE_REVIEW
      );

      const missing = [];
      if (!latestResume) missing.push(DOCUMENT_CATEGORIES.RESUME);
      if (!latestJd) missing.push(DOCUMENT_CATEGORIES.JOB_DESCRIPTION);
      if (!latestPerf) missing.push(DOCUMENT_CATEGORIES.PERFORMANCE_REVIEW);

      const selectedDocs = [latestResume, latestJd, latestPerf].filter(Boolean);
      if (selectedDocs.length === 0) {
        const err = new Error(
          'No uploaded documents found for resume/job_description/performance_review. Upload at least one document or provide documentIds/uploadLink.'
        );
        err.code = 'NO_CATEGORY_DOCS_AVAILABLE';
        err.httpStatus = 422;
        err.details = { missingCategories: missing };
        throw err;
      }

      const documentIds = selectedDocs.map((d) => d.id);

      const categoryDocumentIds = {};
      if (latestResume) categoryDocumentIds[DOCUMENT_CATEGORIES.RESUME] = latestResume.id;
      if (latestJd) categoryDocumentIds[DOCUMENT_CATEGORIES.JOB_DESCRIPTION] = latestJd.id;
      if (latestPerf) categoryDocumentIds[DOCUMENT_CATEGORIES.PERFORMANCE_REVIEW] = latestPerf.id;

      orch = _touch(orch, {
        documentIds,
        categoryDocumentIds,
        missingCategories: missing
      });

      await _bestEffortPersistBuildDocumentsLink(build.id, documentIds);
    } else {
      const err = new Error('Either uploadLink or documentIds must be provided (or enable useLatestCategoryDocs).');
      err.code = 'MISSING_INPUTS';
      err.httpStatus = 422;
      throw err;
    }

    // 3) Extract + normalize
    orch = _touch(orch, {
      runAll: { ...orch.runAll, progress: 40, step: 'extract_normalize', message: 'Extracting and normalizing…' }
    });
    _updateWorkflowProgress(build.id, {
      progress: 40,
      currentStep: 'extract_text',
      message: 'Extracting and normalizing…'
    });
    assertNotCancelled();

    const extractResp = await extractAndNormalizeForBuild(build.id, parsed.extract || {});
    orch = extractResp.orchestration;

    // 4) Generate draft
    orch = _touch(orch, {
      runAll: { ...orch.runAll, progress: 75, step: 'generate_draft', message: 'Generating draft persona…' }
    });
    _updateWorkflowProgress(build.id, {
      progress: 75,
      currentStep: 'generate_persona_draft',
      message: 'Generating draft persona…'
    });
    assertNotCancelled();

    const genResp = await generatePersonaDraftForBuild(build.id, parsed.generate || {});
    orch = genResp.orchestration;

    // 5) Optional finalize
    let finalizeResp = null;
    if (parsed.finalize) {
      orch = _touch(orch, {
        runAll: { ...orch.runAll, progress: 90, step: 'finalize', message: 'Finalizing persona…' }
      });
      _updateWorkflowProgress(build.id, {
        progress: 90,
        currentStep: 'finalize',
        message: 'Finalizing persona…'
      });
      assertNotCancelled();

      finalizeResp = await finalizePersonaForBuild(build.id, parsed.finalize || {});
      orch = finalizeResp.orchestration;
    }

    orch = _touch(orch, {
      runAll: {
        ...orch.runAll,
        status: 'succeeded',
        progress: 100,
        step: null,
        message: 'Orchestration complete.',
        finishedAt: _nowIso(),
        error: null
      }
    });

    _updateWorkflowProgress(build.id, { status: 'succeeded', progress: 100, message: 'Build complete.' });

    return {
      build,
      buildId: build.id,
      orchestration: orch,
      results: {
        extract: {
          documentIds: extractResp.documentIds,
          stats: extractResp.stats
        },
        generate: {
          personaId: genResp.personaId
        },
        finalize: finalizeResp ? { personaId: finalizeResp.personaId } : null
      }
    };
  } catch (err) {
    orch = _touch(orch, {
      runAll: {
        ...(orch.runAll || {}),
        status: 'failed',
        step: orch.runAll?.step || null,
        message: err?.message || 'Orchestration failed.',
        finishedAt: _nowIso(),
        error: { code: err?.code || 'ORCHESTRATION_FAILED', message: err?.message || String(err) }
      }
    });

    _updateWorkflowProgress(build.id, {
      status: 'failed',
      message: err?.message || 'Build failed.',
      failure: err?.details || { code: err?.code || 'ORCHESTRATION_FAILED' }
    });
    throw err;
  }
}

export {
  OrchestrationStartRequest,
  OrchestrationUploadLinkRequest,
  OrchestrationExtractRequest,
  OrchestrationGenerateRequest,
  OrchestrationFinalizeRequest,
  OrchestrationRunAllRequest,
  getOrchestration,
  startOrchestration,
  linkUploadToBuild,
  extractAndNormalizeForBuild,
  generatePersonaDraftForBuild,
  finalizePersonaForBuild,
  runAllOrchestration
};

export default {
  OrchestrationStartRequest,
  OrchestrationUploadLinkRequest,
  OrchestrationExtractRequest,
  OrchestrationGenerateRequest,
  OrchestrationFinalizeRequest,
  OrchestrationRunAllRequest,
  getOrchestration,
  startOrchestration,
  linkUploadToBuild,
  extractAndNormalizeForBuild,
  generatePersonaDraftForBuild,
  finalizePersonaForBuild,
  runAllOrchestration
};
