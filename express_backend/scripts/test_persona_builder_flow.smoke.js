'use strict';

/**
 * CI-style smoke script (HTTP-level) for the persona builder flow.
 *
 * PUBLIC_INTERFACE
 * Usage:
 *   BASE_URL=http://localhost:3001 node scripts/test_persona_builder_flow.smoke.js
 *
 * This script expects a running backend, and validates:
 * - POST /api/uploads/text (3 files w/ explicit categories) returns uploadId + fileSummaries.documentId[]
 * - POST /api/orchestration/run-all with those documentIds succeeds and returns personaId
 * - GET /api/personas/:id/draft/latest and /final/latest return artifacts (memory fallback OK)
 *
 * No DB required. No external AI required.
 */

function env(name, fallback = null) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

function assert(cond, message) {
  if (!cond) {
    const err = new Error(message);
    err.code = 'SMOKE_ASSERTION_FAILED';
    throw err;
  }
}

function uuidLike(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function httpJson(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

async function main() {
  const baseUrl = env('BASE_URL', 'http://localhost:3001');
  const userId = env('SMOKE_USER_ID', '11111111-1111-4111-8111-111111111111');

  // 1) Upload 3 categorized text files
  const fd = new FormData();
  fd.set('userId', userId);
  fd.set('requireCategories', 'true');
  fd.set('categoriesJson', JSON.stringify(['resume', 'job_description', 'performance_review']));

  const resumeText = [
    'Alex Rivera',
    'Senior Backend Engineer',
    '',
    'SKILLS',
    'Node.js, Express, MySQL, AWS'
  ].join('\n');

  const jdText = ['Job Description', 'Position Title: Senior Backend Engineer', 'Responsibilities:', '- Build APIs'].join('\n');
  const perfText = ['Performance Review', 'Employee Name: Alex Rivera', 'Summary: Delivered results.'].join('\n');

  fd.append('files', new Blob([resumeText], { type: 'text/plain' }), 'resume.txt');
  fd.append('files', new Blob([jdText], { type: 'text/plain' }), 'jd.txt');
  fd.append('files', new Blob([perfText], { type: 'text/plain' }), 'review.txt');

  const uploadResp = await fetch(`${baseUrl}/api/uploads/text`, { method: 'POST', body: fd });
  const uploadText = await uploadResp.text();
  const uploadJson = uploadText ? JSON.parse(uploadText) : null;

  assert(uploadResp.ok, `Upload failed: HTTP ${uploadResp.status}: ${uploadText}`);
  assert(uuidLike(uploadJson?.uploadId), 'Expected uploadId UUID');
  assert(Array.isArray(uploadJson?.fileSummaries), 'Expected fileSummaries array');
  assert(uploadJson.fileSummaries.length === 3, 'Expected 3 fileSummaries');

  const documentIds = uploadJson.fileSummaries.map((s) => s.documentId).filter(Boolean);
  assert(documentIds.length === 3, 'Expected 3 documentIds');

  // 2) Orchestration run-all with draft+finalize persistence
  const runAll = await httpJson('POST', `${baseUrl}/api/orchestration/run-all`, {
    mode: 'workflow',
    userId,
    documentIds,
    autoCreatePersona: true,
    extract: { persistToDocuments: true },
    generate: { saveDraft: true, createVersion: true },
    finalize: { saveFinal: true, createVersion: true }
  });

  assert(runAll.status === 201, `run-all expected 201; got ${runAll.status}: ${runAll.text}`);
  const personaId = runAll.json?.results?.generate?.personaId;
  assert(uuidLike(personaId), 'Expected personaId UUID from run-all');

  // 3) Retrieve draft + final
  const draft = await httpJson('GET', `${baseUrl}/api/personas/${personaId}/draft/latest`);
  assert(draft.status === 200, `draft/latest expected 200; got ${draft.status}: ${draft.text}`);
  assert(draft.json?.personaId === personaId, 'draft/latest personaId mismatch');

  const finalBlob = await httpJson('GET', `${baseUrl}/api/personas/${personaId}/final/latest`);
  assert(finalBlob.status === 200, `final/latest expected 200; got ${finalBlob.status}: ${finalBlob.text}`);
  assert(finalBlob.json?.personaId === personaId, 'final/latest personaId mismatch');

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: 'ok', baseUrl, personaId, buildId: runAll.json?.build?.id }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke] failed:', { message: err?.message, code: err?.code, stack: err?.stack });
  process.exit(1);
});
