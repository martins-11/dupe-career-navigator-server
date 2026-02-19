'use strict';

const { z } = require('zod');
const documentsRepo = require('../repositories/documentsRepoAdapter');
const personasRepo = require('../repositories/personasRepoAdapter');
const { extractTextFromUploadedFile } = require('./extractionService');
const { normalizeText } = require('./normalizationService');
const buildsService = require('./buildsService');
const workflowService = require('./workflowService');
const { uuidV4 } = require('../utils/uuid');

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
 */

const _orchestrations = new Map(); // buildId -> orchestration record

function _nowIso() {
  return new Date().toISOString();
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
  return rows
    .map((r) => String(r?.textContent || '').trim())
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
   * This endpoint is meant to be the "one call" entrypoint once the client has documentIds.
   * (Upload -> documentId creation remains handled by /uploads/* and /documents/*, which are stable contracts.)
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

  // One of these must be provided:
  uploadLink: OrchestrationUploadLinkRequest.optional(),
  documentIds: z.array(z.string().uuid()).min(1).optional(),

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

  return PersonaDraftSchema.parse(draft);
}

// PUBLIC_INTERFACE
function getOrchestration(buildId) {
  /** Get orchestration record for a buildId (or null if none). */
  return _getOrNull(buildId);
}

// PUBLIC_INTERFACE
function startOrchestration(input) {
  /**
   * Create a build/workflow and initialize an orchestration record.
   *
   * @param {unknown} input - validated by OrchestrationStartRequest
   * @returns {{build: object, orchestration: object}}
   */
  const parsed = OrchestrationStartRequest.parse(input || {});
  const build = buildsService.createBuild({
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

  return { build, orchestration: next };
}

// PUBLIC_INTERFACE
function linkUploadToBuild(buildId, input) {
  /**
   * Link an existing upload batch (uploadId) and documentIds to a build orchestration.
   */
  const parsed = OrchestrationUploadLinkRequest.parse(input || {});
  const orch = _ensure(buildId);

  return _touch(orch, {
    uploadId: parsed.uploadId,
    documentIds: parsed.documentIds
  });
}

// PUBLIC_INTERFACE
async function extractAndNormalizeForBuild(buildId, input) {
  /**
   * Extract latest text for linked documents and compute a normalized combined text blob.
   *
   * Behavior:
   * - uses documentsRepo.getLatestExtractedText() if present (e.g., created by /uploads/*)
   * - if missing extracted text, attempts best-effort extraction by reading document metadata only
   *   (BUT we do not have file bytes here, so that path is limited; it will just skip).
   *
   * This method does not require DB credentials (memory repo default).
   */
  const parsed = OrchestrationExtractRequest.parse(input || {});
  const orch = _ensure(buildId);

  const documentIds = parsed.documentIds?.length ? parsed.documentIds : orch.documentIds;
  if (!documentIds || documentIds.length === 0) {
    const err = new Error('No documentIds available for extraction. Link upload/documents to build first.');
    err.code = 'NO_DOCUMENTS';
    throw err;
  }

  // Update workflow status (best-effort; keeps /builds polling meaningful).
  const wf = workflowService.getWorkflow(buildId);
  if (wf && wf.status !== 'cancelled') {
    // We cannot mutate internal map directly; just let normal schedule run.
    // Still, orchestration will proceed.
  }

  const extractedRows = [];
  const extractedById = { ...orch.extractedTextByDocumentId };

  for (const documentId of documentIds) {
    // eslint-disable-next-line no-await-in-loop
    const latest = await documentsRepo.getLatestExtractedText(documentId);
    if (latest && latest.textContent) {
      extractedRows.push(latest);
      extractedById[documentId] = latest;
      continue;
    }

    // If no extracted text exists, we cannot extract without bytes. Keep a trace.
    extractedById[documentId] = extractedById[documentId] || null;
  }

  const combined = _concatTexts(extractedRows);
  if (!combined.trim()) {
    const err = new Error(
      'No extracted text available for linked documents. Ensure you uploaded files via /uploads/* or posted extracted text to /documents/:id/extracted-text.'
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
   * Generate a persona draft for a build using placeholder AI (no external credentials).
   *
   * Also optionally:
   * - creates a persona (memory) if none exists and autoCreatePersona is enabled
   * - saves a draft blob via personasRepo.saveDraft
   * - optionally creates a persona version
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
  const personaDraft = _makePlaceholderPersona({ sourceText, context });

  // Persist draft (in-memory; adapter supports saveDraft)
  const shouldSaveDraft = parsed.saveDraft ?? Boolean(personaId);
  let savedDraft = null;
  let createdVersion = null;

  if (personaId && shouldSaveDraft) {
    savedDraft = await personasRepo.saveDraft(personaId, personaDraft);

    if (parsed.createVersion) {
      createdVersion = await personasRepo.createPersonaVersion(personaId, { personaJson: personaDraft });
    }
  }

  const next = _touch(orch, {
    personaId: personaId ?? orch.personaId,
    personaDraft
  });

  return {
    requestId: uuidV4(),
    mode: 'placeholder',
    warnings: ['Placeholder implementation: no AI model invoked.'],
    buildId,
    personaId: personaId ?? null,
    persona: personaDraft,
    savedDraft,
    createdVersion,
    orchestration: next
  };
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
    savedFinal = await personasRepo.saveFinal(personaId, finalJson);

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
   * Best-effort workflow progress updater.
   *
   * The system already exposes /builds/{id}/status which reads from workflowService.
   * Existing workflowService.startWorkflow simulates progress; for the "run all" endpoint
   * we additionally update status to reflect real orchestration completion.
   *
   * Note: workflowService does not currently expose a public "setStatus" method; we
   * carefully fall back to no-op if workflow is missing. For now, we rely on the
   * orchestration record + build polling as a combined picture, and keep updates minimal.
   */
  const wf = workflowService.getWorkflow(buildId);
  if (!wf) return null;

  // Mutate-by-replace: workflowService stores objects; we can replace by re-creating through internal map
  // only if service provides a setter. It doesn't, so we approximate by updating orchestration only.
  // To still improve polling, we set "message/progress/currentStep" in orchestration and let the simulated
  // build progress keep moving. This preserves existing contracts and avoids introducing a new workflow API.
  return { ...wf, ...patch };
}

// PUBLIC_INTERFACE
async function runAllOrchestration(input) {
  /**
   * Run the full orchestration workflow end-to-end:
   * - start build/workflow
   * - link upload/documents
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
  const { build, orchestration: initialOrch } = startOrchestration({
    mode: parsed.mode ?? 'workflow',
    userId: parsed.userId ?? null,
    personaId: parsed.personaId ?? null,
    context: parsed.context ?? null,
    autoCreatePersona: parsed.autoCreatePersona ?? false,
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

  // 2) Link upload/document IDs
  try {
    orch = _touch(orch, {
      runAll: { ...orch.runAll, progress: 15, step: 'link', message: 'Linking documents…' }
    });

    if (parsed.uploadLink) {
      orch = linkUploadToBuild(build.id, parsed.uploadLink);
    } else if (parsed.documentIds?.length) {
      orch = _touch(orch, { documentIds: parsed.documentIds });
    } else {
      const err = new Error('Either uploadLink or documentIds must be provided.');
      err.code = 'MISSING_INPUTS';
      throw err;
    }

    // 3) Extract + normalize
    orch = _touch(orch, {
      runAll: { ...orch.runAll, progress: 40, step: 'extract_normalize', message: 'Extracting and normalizing…' }
    });

    const extractResp = await extractAndNormalizeForBuild(build.id, parsed.extract || {});
    orch = extractResp.orchestration;

    // 4) Generate draft
    orch = _touch(orch, {
      runAll: { ...orch.runAll, progress: 75, step: 'generate_draft', message: 'Generating draft persona…' }
    });

    const genResp = await generatePersonaDraftForBuild(build.id, parsed.generate || {});
    orch = genResp.orchestration;

    // 5) Optional finalize
    let finalizeResp = null;
    if (parsed.finalize) {
      orch = _touch(orch, {
        runAll: { ...orch.runAll, progress: 90, step: 'finalize', message: 'Finalizing persona…' }
      });

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

    // Best-effort: touch workflow (does not change store; see comment).
    _updateWorkflowProgress(build.id, { status: 'succeeded', progress: 100, message: 'Build complete.' });

    return {
      build,
      orchestration: orch,
      results: {
        extract: {
          documentIds: extractResp.documentIds,
          stats: extractResp.stats
        },
        generate: {
          personaId: genResp.personaId
        },
        finalize: finalizeResp
          ? { personaId: finalizeResp.personaId }
          : null
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

    _updateWorkflowProgress(build.id, { status: 'failed', message: 'Build failed.' });
    throw err;
  }
}

module.exports = {
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
