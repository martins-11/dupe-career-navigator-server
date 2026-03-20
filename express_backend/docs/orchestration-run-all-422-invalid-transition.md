# Orchestration `/orchestration/run-all` 422 masking bug (INVALID_WORKFLOW_TRANSITION)

## Symptom
`POST /orchestration/run-all` (and therefore `POST /api/orchestration/run-all` via Next.js proxy) could return:

- HTTP 422
- `{ error: "INVALID_WORKFLOW_TRANSITION", message: "Invalid workflow state transition: queued -> failed" }`

This response is **not** the real orchestration problem; it is emitted by `workflowService`'s strict state machine.

## Root cause
`runAllOrchestration()` wraps execution in a try/catch. On error it updates workflow status via `_updateWorkflowProgress(... status:'failed' ...)`.

However, the workflow simulator transitions `queued -> running` asynchronously. If orchestration fails quickly (e.g., missing docs, missing extracted text), then the workflow is still `queued` and `workflowService.failWorkflow()` throws because it only allows `running -> failed`.

That thrown error would mask the original underlying orchestration error.

## Fix
`_updateWorkflowProgress()` was hardened to:

1. When setting terminal statuses (`failed`/`succeeded`), best-effort transition `queued -> running` first.
2. Treat terminal workflow updates as **best-effort** (swallow workflow transition errors) to avoid masking the true orchestration error response.
