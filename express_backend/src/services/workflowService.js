'use strict';

const { uuidV4 } = require('../utils/uuid');

/**
 * Workflow service (in-memory).
 *
 * This is a more "real" workflow state handler than the previous pure simulation.
 * It still keeps the existing /builds endpoints stable by exposing build records/status.
 *
 * For now, it does NOT automatically call external AI (Claude pending) and does NOT require DB.
 */

const _workflows = new Map(); // id -> record

function _nowIso() {
  return new Date().toISOString();
}

function _set(wf) {
  _workflows.set(wf.id, wf);
}

function _get(id) {
  return _workflows.get(id) || null;
}

// PUBLIC_INTERFACE
function createWorkflow({ personaId, documentId, mode }) {
  /**
   * Create a workflow record (queued) and return it.
   * This function is used by buildsService to keep API stable.
   */
  const id = uuidV4();
  const now = _nowIso();
  const steps = ['validate_inputs', 'extract_text', 'normalize_text', 'generate_persona_draft', 'finalize'];

  const wf = {
    id,
    personaId: personaId ?? null,
    documentId: documentId ?? null,
    status: 'queued',
    progress: 0,
    message: 'Build queued.',
    steps,
    currentStep: null,
    createdAt: now,
    updatedAt: now
  };

  _set(wf);
  return wf;
}

// PUBLIC_INTERFACE
function startWorkflow(id) {
  /** Start workflow execution in background (best-effort). */
  const wf = _get(id);
  if (!wf) return;

  const schedule = [
    { ms: 50, status: 'running', progress: 10, step: 'validate_inputs', message: 'Validating inputs…' },
    { ms: 300, status: 'running', progress: 35, step: 'extract_text', message: 'Extracting text…' },
    { ms: 700, status: 'running', progress: 60, step: 'normalize_text', message: 'Normalizing text…' },
    { ms: 1200, status: 'running', progress: 85, step: 'generate_persona_draft', message: 'Generating persona draft…' },
    { ms: 1600, status: 'running', progress: 95, step: 'finalize', message: 'Finalizing…' },
    { ms: 1900, status: 'succeeded', progress: 100, step: null, message: 'Build complete.' }
  ];

  for (const item of schedule) {
    setTimeout(() => {
      const current = _get(id);
      if (!current) return;
      if (['cancelled', 'failed', 'succeeded'].includes(current.status)) return;

      _set({
        ...current,
        status: item.status,
        progress: item.progress,
        currentStep: item.step,
        message: item.message,
        updatedAt: _nowIso()
      });
    }, item.ms);
  }
}

// PUBLIC_INTERFACE
function cancelWorkflow(id) {
  /** Cancel a workflow (if not completed). */
  const wf = _get(id);
  if (!wf) return null;
  if (wf.status === 'succeeded' || wf.status === 'failed') return wf;

  const updated = { ...wf, status: 'cancelled', message: 'Build cancelled.', updatedAt: _nowIso() };
  _set(updated);
  return updated;
}

// PUBLIC_INTERFACE
function getWorkflow(id) {
  /** Get workflow record by id. */
  return _get(id);
}

// PUBLIC_INTERFACE
function getWorkflowStatus(id) {
  /** Get polling-friendly status projection. */
  const wf = _get(id);
  if (!wf) return null;
  return {
    id: wf.id,
    status: wf.status,
    progress: wf.progress,
    message: wf.message,
    currentStep: wf.currentStep,
    updatedAt: wf.updatedAt
  };
}

module.exports = {
  createWorkflow,
  startWorkflow,
  cancelWorkflow,
  getWorkflow,
  getWorkflowStatus
};
