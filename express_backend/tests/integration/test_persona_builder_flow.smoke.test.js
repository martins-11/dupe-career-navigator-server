'use strict';

const request = require('supertest');

/**
 * MVP Smoke: core persona builder flow in DB-off (memory fallback) mode.
 *
 * Validates end-to-end:
 * 1) upload (3 docs with explicit categories)
 *    -> creates document rows + extracted_text rows (best-effort)
 * 2) orchestration/run-all with autoCreatePersona + generate(saveDraft) + finalize(saveFinal)
 *    -> creates personaId, saves draft + final in memory repo
 * 3) GET /api/personas/:id/draft/latest and /final/latest return persisted artifacts
 *
 * Notes:
 * - This test is intentionally DB-independent and should pass without any DB env vars.
 * - We force DB_ENGINE=mysql and clear MYSQL_* vars to ensure memory repo selection.
 */
describe('MVP Smoke: persona builder flow (DB-off / memory fallback)', () => {
  jest.setTimeout(60_000);

  function uuidLike(v) {
    return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  }

  beforeEach(() => {
    // Ensure DB is treated as "not configured" so adapters fall back to memory.
    process.env.DB_ENGINE = 'mysql';
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_PORT;
    delete process.env.MYSQL_DATABASE;
    delete process.env.MYSQL_USER;
    delete process.env.MYSQL_PASSWORD;

    // Avoid any accidental real Bedrock calls in this smoke test.
    delete process.env.BEDROCK_MODEL_ID;
    delete process.env.BEDROCK_ROLE_MODEL_ID;
  });

  test('upload → run-all(draft+save) → finalize(save) → retrieve draft/final', async () => {
    // Import app AFTER env setup. Use dynamic import so we can load ESM server code from this CJS test.
    const { default: app } = await import('../../src/server.js');

    const userId = '11111111-1111-4111-8111-111111111111';

    const resumeText = [
      'Alex Rivera',
      'Senior Backend Engineer',
      '',
      'SUMMARY',
      'Backend engineer with Node.js/Express experience.',
      '',
      'SKILLS',
      'Node.js, Express, MySQL, AWS'
    ].join('\n');

    const jdText = [
      'Job Description',
      'Position Title: Senior Backend Engineer',
      '',
      'Responsibilities:',
      '- Build APIs',
      '- Own reliability'
    ].join('\n');

    const perfText = [
      'Performance Review',
      'Employee Name: Alex Rivera',
      'Summary:',
      'Delivered high quality work and improved system performance.'
    ].join('\n');

    // 1) Upload 3 files with explicit categories to avoid classifier ambiguity in tests.
    const uploadResp = await request(app)
      .post('/api/uploads/text')
      .field('userId', userId)
      .field('requireCategories', 'true')
      .field('categoriesJson', JSON.stringify(['resume', 'job_description', 'performance_review']))
      .attach('files', Buffer.from(resumeText, 'utf8'), { filename: 'resume.txt', contentType: 'text/plain' })
      .attach('files', Buffer.from(jdText, 'utf8'), { filename: 'jd.txt', contentType: 'text/plain' })
      .attach('files', Buffer.from(perfText, 'utf8'), { filename: 'review.txt', contentType: 'text/plain' });

    expect(uploadResp.status).toBe(200);
    expect(uploadResp.body).toBeTruthy();
    expect(uuidLike(uploadResp.body.uploadId)).toBe(true);
    expect(Array.isArray(uploadResp.body.receivedFiles)).toBe(true);
    expect(uploadResp.body.receivedFiles).toHaveLength(3);

    // Additive response: fileSummaries should include documentIds in this backend.
    expect(Array.isArray(uploadResp.body.fileSummaries)).toBe(true);
    expect(uploadResp.body.fileSummaries).toHaveLength(3);

    const docIds = uploadResp.body.fileSummaries.map((s) => s.documentId).filter(Boolean);
    expect(docIds).toHaveLength(3);
    for (const id of docIds) expect(uuidLike(id)).toBe(true);

    // 2) Run orchestration end-to-end, ensuring persona container is created and artifacts are saved.
    const runAllResp = await request(app)
      .post('/api/orchestration/run-all')
      .send({
        mode: 'workflow',
        userId,
        documentIds: docIds,
        autoCreatePersona: true,
        extract: {
          persistToDocuments: true,
          normalize: { removeExtraWhitespace: true, normalizeLineBreaks: true }
        },
        generate: {
          saveDraft: true,
          createVersion: true
        },
        finalize: {
          saveFinal: true,
          createVersion: true
        }
      })
      .set('content-type', 'application/json');

    expect(runAllResp.status).toBe(201);
    expect(runAllResp.body).toBeTruthy();

    const build = runAllResp.body.build;
    expect(build).toBeTruthy();
    expect(uuidLike(build.id)).toBe(true);

    const orchestration = runAllResp.body.orchestration;
    expect(orchestration).toBeTruthy();
    expect(orchestration.buildId).toBe(build.id);

    const personaId = runAllResp.body?.results?.generate?.personaId;
    expect(uuidLike(personaId)).toBe(true);

    // Ensure draft/final made it into orchestration record.
    expect(orchestration.personaId).toBe(personaId);
    expect(orchestration.personaDraft).toBeTruthy();
    expect(orchestration.personaFinal).toBeTruthy();

    // Basic draft expectations (schema varies, but should be an object with some headline/title-ish field).
    expect(typeof orchestration.personaDraft).toBe('object');
    expect(typeof orchestration.personaFinal).toBe('object');

    // 3) Retrieve saved draft and final via personas routes (memory fallback expected to work)
    const draftResp = await request(app).get(`/api/personas/${personaId}/draft/latest`);
    expect(draftResp.status).toBe(200);
    expect(draftResp.body).toBeTruthy();
    expect(draftResp.body.personaId).toBe(personaId);
    expect(draftResp.body.draftJson).toBeTruthy();
    expect(typeof draftResp.body.draftJson).toBe('object');

    const finalResp = await request(app).get(`/api/personas/${personaId}/final/latest`);
    expect(finalResp.status).toBe(200);
    expect(finalResp.body).toBeTruthy();
    expect(finalResp.body.personaId).toBe(personaId);
    expect(finalResp.body.finalJson).toBeTruthy();
    expect(typeof finalResp.body.finalJson).toBe('object');
  });
});
