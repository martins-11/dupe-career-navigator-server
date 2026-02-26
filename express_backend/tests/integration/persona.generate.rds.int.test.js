'use strict';

const mysql = require('mysql2/promise');

function env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

function requireEnv(name) {
  const v = env(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * PUBLIC_INTERFACE
 */
function buildBaseUrl() {
  /** Resolve API base URL for integration tests. */
  return env('BASE_URL') || env('API_BASE_URL') || 'http://localhost:3001';
}

/**
 * PUBLIC_INTERFACE
 */
function buildPersonaGeneratePath() {
  /**
   * Resolve persona generate endpoint path for integration tests.
   *
   * The Express backend mounts aiRouter at `/ai` and defines the route as:
   *   POST /ai/personas/generate
   *
   * Allow override via PERSONA_GENERATE_PATH for portability.
   */
  return env('PERSONA_GENERATE_PATH') || '/ai/personas/generate';
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    // ignore
  }

  return { status: resp.status, ok: resp.ok, json, raw: text };
}

function expectString(v, name) {
  expect(typeof v).toBe('string');
  expect(v.length).toBeGreaterThan(0);
  if (name) expect(v).toEqual(expect.any(String));
}

function expectPersonaShape(persona) {
  expect(persona).toBeTruthy();
  expect(typeof persona).toBe('object');

  // Required schema from personaService.js (strict)
  expectString(persona.full_name, 'full_name');
  expectString(persona.professional_title, 'professional_title');

  expect(Array.isArray(persona.mastery_skills)).toBe(true);
  expect(persona.mastery_skills).toHaveLength(3); // 3/2 rule

  expect(Array.isArray(persona.growth_areas)).toBe(true);
  expect(persona.growth_areas).toHaveLength(2); // 3/2 rule

  expect(Number.isInteger(persona.experience_years)).toBe(true);

  expectString(persona.raw_ai_summary, 'raw_ai_summary');
}

async function mysqlPoolFromEnv() {
  // User-provided env keys: DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD, DB_ENGINE (MySQL)
  // Keep these strict so the test fails loudly if CI env isn't configured.
  const engine = (env('DB_ENGINE') || 'mysql').toLowerCase();
  if (engine !== 'mysql') {
    throw new Error(`Integration test expects DB_ENGINE=mysql, got ${engine}`);
  }

  return mysql.createPool({
    host: requireEnv('DB_HOST'),
    port: Number(requireEnv('DB_PORT')),
    database: requireEnv('DB_NAME'),
    user: requireEnv('DB_USERNAME'),
    password: requireEnv('DB_PASSWORD'),
    waitForConnections: true,
    connectionLimit: 5,
    // RDS often requires TLS; but env-driven here. If your RDS requires TLS and the
    // environment already provides certs, mysql2 will use them automatically when configured.
    // For now, allow non-verified TLS by default only if DB_SSL=true is provided.
    ssl: String(env('DB_SSL') || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined,
  });
}

describe('Integration: POST /persona/generate + RDS verification', () => {
  jest.setTimeout(60_000);

  test('generates persona draft, enforces 3/2 rule, persists persona_drafts, logs alignment_score', async () => {
    const baseUrl = buildBaseUrl();
    const personaGeneratePath = buildPersonaGeneratePath();

    // Jordan Rivera resume text (admin-required test input)
    const sampleResumeText = [
      'Jordan Rivera',
      'Senior Software Engineer',
      '',
      'SUMMARY',
      'Senior Software Engineer with experience building scalable backend systems and customer-facing products.',
      'Strong background in Node.js services, API design, and cloud infrastructure.',
      '',
      'EXPERIENCE',
      'Senior Software Engineer',
      '- Built and maintained Node.js/Express APIs supporting production workloads.',
      '- Worked with MySQL data models and performance optimizations.',
      '- Implemented AWS-based services and CI/CD automation.',
      '',
      'SKILLS',
      'Node.js, JavaScript, Express, MySQL, AWS, System Design, Mentorship',
    ].join('\n');

    // Endpoint used by this backend: POST /ai/personas/generate
    const apiUrl = `${baseUrl}${personaGeneratePath}`;
    const apiResp = await postJson(apiUrl, {
      sourceText: sampleResumeText,
      context: {
        targetRole: 'Senior Backend Engineer',
        seniority: 'Senior',
        industry: 'Software',
      },
    });

    if (!apiResp.ok) {
      // eslint-disable-next-line no-console
      console.error('[integration] persona generate failed:', {
        url: apiUrl,
        status: apiResp.status,
        body: apiResp.raw,
      });
    }

    expect(apiResp.ok).toBe(true);
    expect(apiResp.status).toBe(200);

    const payload = apiResp.json;
    expect(payload).toBeTruthy();
    expect(typeof payload).toBe('object');

    // Contract expectations (as requested):
    // - personaDraftId returned
    // - alignment_score present (log it)
    expectString(payload.personaDraftId, 'personaDraftId');
    expect(typeof payload.alignment_score).toBe('number');

    // Log alignment_score for visibility in CI output
    // eslint-disable-next-line no-console
    console.log('[integration] alignment_score:', payload.alignment_score);

    // Validate generated JSON schema + 3/2 rule
    expectPersonaShape(payload.persona);

    // Now verify persistence in RDS (MySQL) by personaDraftId
    const pool = await mysqlPoolFromEnv();

    try {
      const [rows] = await pool.query(
        'SELECT persona_draft_json, alignment_score FROM persona_drafts WHERE id = ? LIMIT 1',
        [payload.personaDraftId],
      );

      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(1);

      const row = rows[0];
      expect(row).toBeTruthy();

      // Verify alignment_score persisted
      // mysql2 can return numbers as JS numbers; keep tolerant.
      const dbAlignment = row.alignment_score;
      expect(typeof dbAlignment === 'number' || typeof dbAlignment === 'string').toBe(true);

      // Verify persona draft JSON persisted and re-check 3/2 rule against DB record.
      // For MySQL JSON columns, mysql2 returns an object or a string depending on config.
      let dbPersona = row.persona_draft_json;
      if (typeof dbPersona === 'string') {
        dbPersona = JSON.parse(dbPersona);
      }
      expectPersonaShape(dbPersona);

      // Re-check strict 3/2 rule from DB record specifically
      expect(dbPersona.mastery_skills).toHaveLength(3);
      expect(dbPersona.growth_areas).toHaveLength(2);
    } finally {
      await pool.end();
    }
  });

  test('single-doc performance review: extracts employee name (does not fall back to doc label)', async () => {
    const baseUrl = buildBaseUrl();
    const personaGeneratePath = buildPersonaGeneratePath();

    const perfReviewText = [
      'Performance Review',
      'Employee Name: Jane Q. Doe',
      'Reviewer: John Manager',
      '',
      'Summary:',
      'Jane consistently delivered high quality work and improved team velocity.'
    ].join('\n');

    const apiUrl = `${baseUrl}${personaGeneratePath}`;
    const apiResp = await postJson(apiUrl, {
      sourceText: perfReviewText,
      context: { targetRole: 'Software Engineer' }
    });

    expect(apiResp.ok).toBe(true);
    expect(apiResp.status).toBe(200);

    const payload = apiResp.json;
    expect(payload).toBeTruthy();
    expectPersonaShape(payload.persona);

    // Key regression check: should match extracted employee name (not "performance review", etc.)
    expect(payload.persona.full_name).toBe('Jane Q. Doe');
  });

  test('multi-doc combined: resume header name wins over other doc text', async () => {
    const baseUrl = buildBaseUrl();
    const personaGeneratePath = buildPersonaGeneratePath();

    const resumeText = ['Alex Rivera', 'Senior Software Engineer', '', 'EXPERIENCE', '...'].join('\n');

    const perfReviewText = ['Performance Review', 'Employee Name: Not The Resume Name', 'Summary: ...'].join('\n');

    const combined = [resumeText, perfReviewText].join('\n\n-----\n\n');

    const apiUrl = `${baseUrl}${personaGeneratePath}`;
    const apiResp = await postJson(apiUrl, {
      sourceText: combined,
      context: { targetRole: 'Backend Engineer' }
    });

    expect(apiResp.ok).toBe(true);
    expect(apiResp.status).toBe(200);

    const payload = apiResp.json;
    expect(payload).toBeTruthy();
    expectPersonaShape(payload.persona);

    // Resume name must win.
    expect(payload.persona.full_name).toBe('Alex Rivera');
  });
});
