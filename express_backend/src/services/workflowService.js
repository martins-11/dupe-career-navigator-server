import { uuidV4 } from '../utils/uuid.js';

/**
 * Workflow service (in-memory).
 *
 * This is a more "real" workflow state handler than the previous pure simulation.
 * It still keeps the existing /builds endpoints stable by exposing build records/status.
 *
 * This change introduces a defined workflow state machine and enforces allowed transitions.
 * Invalid transitions throw an error that maps to a standardized 422 ErrorResponse.
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

/**
 * Clamp progress to an integer in [0, 100] to keep polling stable.
 */
function _clampProgress(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 0) return 0;
  if (i > 100) return 100;
  return i;
}

/**
 * Allowed status values for workflows/builds.
 * Keeping the strings consistent with existing API contract.
 */
const WORKFLOW_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

/**
 * Explicit allowed transitions.
 * - queued -> running | cancelled
 * - running -> succeeded | failed | cancelled
 * - terminal states cannot transition further
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'cancelled']),
  succeeded: new Set([]),
  failed: new Set([]),
  cancelled: new Set([])
});

function _isValidStatus(status) {
  return WORKFLOW_STATUSES.includes(status);
}

function _isAllowedTransition(from, to) {
  if (!_isValidStatus(from) || !_isValidStatus(to)) return false;
  const allowed = ALLOWED_TRANSITIONS[from];
  return Boolean(allowed && allowed.has(to));
}

function _makeInvalidTransitionError({ id, from, to, message }) {
  const err = new Error(message || `Invalid workflow state transition: ${from} -> ${to}`);
  // Map to sendError() 422 behavior in utils/errors.js
  err.code = 'INVALID_WORKFLOW_TRANSITION';
  err.httpStatus = 422;
  err.details = {
    workflowId: id,
    from,
    to,
    allowed: Array.from(ALLOWED_TRANSITIONS[from] || [])
  };
  return err;
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
    mode: mode ?? null,
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
function transitionWorkflow(id, toStatus, patch = {}) {
  /**
   * Transition a workflow to a new status, enforcing the workflow state machine.
   *
   * @param {string} id
   * @param {'queued'|'running'|'succeeded'|'failed'|'cancelled'} toStatus
   * @param {{ progress?: number, message?: string|null, currentStep?: string|null }} [patch]
   * @returns {object} updated workflow record
   * @throws Error with code INVALID_WORKFLOW_TRANSITION and httpStatus=422 if invalid
   */
  const wf = _get(id);
  if (!wf) {
    const err = new Error('Workflow not found.');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    err.details = { workflowId: id };
    throw err;
  }

  const from = wf.status;
  const to = toStatus;

  if (!_isValidStatus(to)) {
    const err = new Error(`Unknown workflow status: ${String(to)}`);
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 422;
    err.details = { workflowId: id, status: to, allowedStatuses: WORKFLOW_STATUSES };
    throw err;
  }

  if (!_isAllowedTransition(from, to)) {
    throw _makeInvalidTransitionError({ id, from, to });
  }

  const updated = {
    ...wf,
    ...patch,
    status: to,
    updatedAt: _nowIso()
  };

  _set(updated);
  return updated;
}

// PUBLIC_INTERFACE
function startWorkflow(id) {
  /** Start workflow execution in background (best-effort). Enforces transitions. */
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

      // If already terminal, do nothing (do not try transitions).
      if (['cancelled', 'failed', 'succeeded'].includes(current.status)) return;

      try {
        // Enforce state machine:
        // - First tick transitions queued -> running
        // - Subsequent ticks remain running -> running? (not a transition) so we patch directly
        //   BUT: to keep a strict model, we only transition when status changes.
        if (current.status !== item.status) {
          transitionWorkflow(id, item.status, {
            progress: item.progress,
            currentStep: item.step,
            message: item.message
          });
        } else {
          // Same-status updates are allowed as "patches" without a transition.
          _set({
            ...current,
            progress: item.progress,
            currentStep: item.step,
            message: item.message,
            updatedAt: _nowIso()
          });
        }
      } catch (_) {
        // Background simulator should never crash the process; ignore invalid transitions here.
      }
    }, item.ms);
  }
}

// PUBLIC_INTERFACE
function cancelWorkflow(id) {
  /** Cancel a workflow (if not completed). Enforces transitions. */
  const wf = _get(id);
  if (!wf) return null;

  // If terminal, keep as-is (existing behavior kept).
  if (wf.status === 'succeeded' || wf.status === 'failed' || wf.status === 'cancelled') return wf;

  // Enforce transition. queued|running -> cancelled are allowed.
  return transitionWorkflow(id, 'cancelled', { message: 'Build cancelled.' });
}

// PUBLIC_INTERFACE
function failWorkflow(id, message, details = null) {
  /**
   * Mark a workflow as failed (if currently running).
   * Useful for orchestration to reflect real errors.
   */
  const wf = _get(id);
  if (!wf) return null;

  if (wf.status === 'failed' || wf.status === 'succeeded' || wf.status === 'cancelled') return wf;

  const patch = {
    message: message || 'Build failed.'
  };

  // Attach extra info (non-breaking; stored only in-memory)
  if (details && typeof details === 'object') patch.failure = details;

  return transitionWorkflow(id, 'failed', patch);
}

// PUBLIC_INTERFACE
function succeedWorkflow(id, message) {
  /**
   * Mark a workflow as succeeded (if currently running).
   */
  const wf = _get(id);
  if (!wf) return null;

  if (wf.status === 'failed' || wf.status === 'succeeded' || wf.status === 'cancelled') return wf;

  return transitionWorkflow(id, 'succeeded', {
    message: message || 'Build complete.',
    progress: 100,
    currentStep: null
  });
}

/**
 * PUBLIC_INTERFACE
 * Patch a workflow's non-status fields in a safe/monotonic way.
 *
 * Why:
 * - Orchestration needs deterministic progress + step messages (not just the simulator).
 * - We must avoid invalid transitions (e.g., running->running is not a transition).
 * - We must not regress progress (avoid UI flicker).
 *
 * Rules:
 * - If workflow is terminal (succeeded/failed/cancelled), no changes are applied.
 * - progress is clamped to [0,100] and cannot decrease.
 * - message/currentStep may be updated when provided.
 *
 * @param {string} id
 * @param {{ progress?: number, message?: string|null, currentStep?: string|null }} patch
 * @returns {object|null} Updated workflow, or null if workflow not found
 */
function patchWorkflow(id, patch = {}) {
  const wf = _get(id);
  if (!wf) return null;

  // Terminal workflows are immutable.
  if (['cancelled', 'failed', 'succeeded'].includes(wf.status)) return wf;

  const next = { ...wf };

  if (Object.prototype.hasOwnProperty.call(patch, 'progress')) {
    const clamped = _clampProgress(patch.progress);
    if (clamped !== null) next.progress = Math.max(Number(wf.progress || 0), clamped);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
    next.message = patch.message ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'currentStep')) {
    next.currentStep = patch.currentStep ?? null;
  }

  next.updatedAt = _nowIso();
  _set(next);
  return next;
}

// PUBLIC_INTERFACE
function getWorkflow(id) {
  /** Get workflow record by id. */
  return _get(id);
}

/**
 * PUBLIC_INTERFACE
 * Internal-ish accessor for callers that need the full workflow record without mutation.
 * (Kept public to support service-level composition without reaching into module internals.)
 *
 * @param {string} id
 * @returns {object|null}
 */
function getWorkflowUnsafeRead(id) {
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

export {
  createWorkflow,
  transitionWorkflow,
  startWorkflow,
  cancelWorkflow,
  failWorkflow,
  succeedWorkflow,
  patchWorkflow,
  getWorkflow,
  getWorkflowUnsafeRead,
  getWorkflowStatus
};

export default {
  createWorkflow,
  transitionWorkflow,
  startWorkflow,
  cancelWorkflow,
  failWorkflow,
  succeedWorkflow,
  patchWorkflow,
  getWorkflow,
  getWorkflowUnsafeRead,
  getWorkflowStatus
};
