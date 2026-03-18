import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import Ajv from 'ajv';

import { extractNameAndCurrentRole } from '../utils/nameRoleExtraction.js';
import { uuidV4 } from '../utils/uuid.js';
import { getDbEngine, isDbConfigured, isMysqlConfigured, dbQuery } from '../db/connection.js';

/**
 * Persona generation service (AWS Bedrock Claude).
 *
 * Responsibilities:
 * - Provide a strict system prompt that forces strict JSON output (no markdown, no commentary)
 * - Call AWS Bedrock using env vars (AWS credentials are loaded by AWS SDK default provider chain)
 * - Validate model output against a strict JSON Schema before returning to callers
 * - Provide a persistence helper for persona drafts (persona_drafts table) that returns personaDraftId
 *
 * Environment variables required (configured outside code):
 * - AWS_REGION
 * - BEDROCK_MODEL_ID
 * - (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) OR any standard AWS credential provider supported by AWS SDK
 */

/**
 * System prompt used for persona draft generation.
 *
 * Product decision:
 * - The frontend no longer shows "Key Experiences", so this prompt/schema does NOT include a work_experience field.
 */
const PERSONA_SYSTEM_PROMPT = [
  'You are Claude Sonnet 4.5 running inside an automated backend pipeline for persona draft generation.',
  '',
  'TASK',
  'Given raw unstructured career text (RESUME + JOB DESCRIPTION + PERFORMANCE REVIEWS when present), extract and summarize into a SINGLE JSON object that conforms EXACTLY to the schema below.',
  '',
  'CRITICAL INPUT INTERPRETATION RULES',
  '1) Treat the labeled sections as different sources:',
  '   - RESUME_TEXT: facts about the candidate (education, work roles/internships, achievements, projects, activities).',
  '   - JOB_DESCRIPTION_TEXT: target role requirements (do NOT claim the candidate has done these unless RESUME_TEXT/REVIEWS provide evidence).',
  '   - PERFORMANCE_REVIEW_TEXT: evidence of impact, outcomes, strengths (if present).',
  '2) Do NOT copy long phrases verbatim. Summarize and synthesize.',
  '3) Do NOT invent employers, job titles, dates, or metrics. If unknown, use empty strings.',
  '',
  'ABSOLUTE OUTPUT RULES (JSON-ONLY; ZERO EXTRA TEXT)',
  '1) Output MUST be valid JSON (RFC 8259).',
  '2) Output MUST be a single JSON object (not an array, not multiple objects).',
  '3) Output MUST contain ONLY the keys defined in the schema. Do not add any other keys.',
  '4) Output MUST contain NO preamble, NO explanation, NO commentary.',
  '5) Output MUST contain NO markdown and NO code fences (no ```).',
  '6) Do not wrap the JSON in quotes. Do not prefix with "Here is the JSON". Do not suffix with anything.',
  '',
  'SCHEMA (STRICT; MUST MATCH EXACTLY)',
  '{',
  '  "professional_summary": string,',
  '  "career_highlights": [',
  '    {',
  '      "text": string,',
  '      "source": string',
  '    }',
  '  ],',
  '  "core_competencies": string[],',
  '  "education": [',
  '    {',
  '      "institution": string,',
  '      "degree": string,',
  '      "field_of_study": string,',
  '      "start_date": string,',
  '      "end_date": string,',
  '      "notes": string',
  '    }',
  '  ],',
  '  "technical_stack": {',
  '    "languages": string[],',
  '    "frameworks": string[],',
  '    "databases": string[],',
  '    "cloud_and_devops": string[],',
  '    "tools": string[]',
  '  }',
  '}',
  '',
  'FIELD GUIDANCE (QUALITY BAR)',
  '- professional_summary (2-5 sentences): must read like a real professional summary; include 1-2 concrete proof points from RESUME_TEXT/REVIEWS only.',
  '- career_highlights (REQUIRED; MUST BE NON-EMPTY): 3-6 concise bullet-style objects summarizing the candidate’s most impressive, evidence-based achievements/impact.',
  '  - Each item MUST have:',
  '    - text: the highlight statement (CONTRIBUTION + IMPACT).',
  '    - source: where it came from, ideally the originating job/role/company from RESUME_TEXT/REVIEWS (e.g., "Software Engineer – Acme", "Course Representative – VIT Chennai", "Project: Movie Ticket Booking System", or "Performance Review").',
  '  - If there is no clear job/role/company, set source to "Unknown" (do NOT invent employers/titles).',
  '  - Highlights MUST be linked to evidence from RESUME_TEXT and/or PERFORMANCE_REVIEW_TEXT (never from JOB_DESCRIPTION_TEXT).',
  '  - DO NOT include certifications, certificate names, training courses, or exam completions as career_highlights.',
  '  - EXCLUDE generic role requirements copied from the job description; only include what the candidate actually did.',
  '  - Prefer impact/outcome phrasing: action → scope → result (metrics only when explicitly present in RESUME_TEXT/REVIEWS).',
  '  - STRICT ANTI-COPY RULE: Do not reuse resume bullet wording. Paraphrase heavily: change phrasing and structure; do not copy 6+ consecutive words from the input.',
  '  - Source discipline: candidate claims MUST come from RESUME_TEXT and/or PERFORMANCE_REVIEW_TEXT only (JOB_DESCRIPTION_TEXT is requirements, not evidence).',
  '  - NEVER return an empty array. If evidence is limited, derive highlights from the strongest available facts without inventing new facts.',
  '- core_competencies: 8-14 items max. These are competencies (e.g., "Predictive modeling", "Full-stack web delivery"), not tool dumps.',
  '- education: include degrees; include notable competitions/activities in notes if present.',
  '- technical_stack: keep concise; only include technologies actually present in RESUME_TEXT/REVIEWS. Avoid copying JD requirement lists.',
  '',
  'ANTI-REPETITION RULES',
  '- Avoid repeating the same sentence structure across highlights.',
  '- Avoid repeating the exact same highlight text across multiple items.',
  '',
  'OUTPUT NOW: JSON ONLY.'
].join('\n');

/**
 * Strict JSON schema for generated persona drafts.
 * (additionalProperties=false enforces no extra keys)
 */
const personaDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    professional_summary: { type: 'string' },
    career_highlights: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          source: { type: 'string' }
        },
        required: ['text', 'source']
      }
    },
    core_competencies: {
      type: 'array',
      items: { type: 'string' }
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          institution: { type: 'string' },
          degree: { type: 'string' },
          field_of_study: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          notes: { type: 'string' }
        },
        required: ['institution', 'degree', 'field_of_study', 'start_date', 'end_date', 'notes']
      }
    },
    technical_stack: {
      type: 'object',
      additionalProperties: false,
      properties: {
        languages: { type: 'array', items: { type: 'string' } },
        frameworks: { type: 'array', items: { type: 'string' } },
        databases: { type: 'array', items: { type: 'string' } },
        cloud_and_devops: { type: 'array', items: { type: 'string' } },
        tools: { type: 'array', items: { type: 'string' } }
      },
      required: ['languages', 'frameworks', 'databases', 'cloud_and_devops', 'tools']
    }
  },
  required: ['professional_summary', 'career_highlights', 'core_competencies', 'education', 'technical_stack']
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validatePersonaDraft = ajv.compile(personaDraftJsonSchema);

function _env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

function _jsonError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.httpStatus = 422;
  if (details) err.details = details;
  return err;
}

function _extractTextFromBedrockResponseJson(respJson) {
  if (!respJson) return '';

  const converseContent = respJson?.output?.message?.content;
  if (Array.isArray(converseContent)) {
    const texts = converseContent
      .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean);
    if (texts.length) return texts.join('\n').trim();
  }

  if (Array.isArray(respJson.content)) {
    const texts = respJson.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    return texts.join('\n').trim();
  }

  if (typeof respJson.output_text === 'string') return respJson.output_text.trim();
  if (typeof respJson.completion === 'string') return respJson.completion.trim();
  if (typeof respJson.result === 'string') return respJson.result.trim();

  return '';
}

function _stripMarkdownCodeFences(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/^```(?:\s*json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced && typeof fenced[1] === 'string') {
    return fenced[1].trim();
  }
  return t;
}

function _extractFirstJsonSubstring(text) {
  const t = String(text || '');
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');

  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);

  if (start === -1) return null;

  const lastObj = t.lastIndexOf('}');
  const lastArr = t.lastIndexOf(']');

  let end = -1;
  if (lastObj === -1) end = lastArr;
  else if (lastArr === -1) end = lastObj;
  else end = Math.max(lastObj, lastArr);

  if (end === -1 || end <= start) return null;

  return t.slice(start, end + 1).trim();
}

function _safeJsonParse(jsonText) {
  const cleaned = _stripMarkdownCodeFences(jsonText);

  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (e1) {
    const extracted = _extractFirstJsonSubstring(cleaned);
    if (extracted) {
      try {
        return { ok: true, value: JSON.parse(extracted) };
      } catch (e2) {
        return { ok: false, error: e2 };
      }
    }

    return { ok: false, error: e1 };
  }
}

function _normalizeCareerHighlights(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const ch = obj.career_highlights;
  if (!Array.isArray(ch)) return obj;

  const normalized = ch
    .map((item) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (!text) return null;
        return { text, source: 'Unknown' };
      }

      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        const source = typeof item.source === 'string' ? item.source.trim() : 'Unknown';
        if (!text) return null;
        return { text, source: source || 'Unknown' };
      }

      return null;
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    normalized.push({ text: 'Demonstrated impact through documented contributions.', source: 'Unknown' });
  }

  return { ...obj, career_highlights: normalized };
}

function _assertValidPersonaDraft(obj) {
  const normalized = _normalizeCareerHighlights(obj);

  const ok = validatePersonaDraft(normalized);
  if (ok) return normalized;

  throw _jsonError('PERSONA_SCHEMA_VALIDATION_FAILED', 'Model output did not match required persona schema.', {
    ajvErrors: validatePersonaDraft.errors
  });
}

function _buildClaudeConverseInput({ systemPrompt, extractedText, context }) {
  const text = String(extractedText || '').trim();

  const parts = text
    .split(/\n\s*-----\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  let resumeText = '';
  let jobDescriptionText = '';
  let performanceReviewText = '';
  const otherTexts = [];

  for (const p of parts) {
    const lower = p.toLowerCase();

    if (!resumeText && /\b(educational qualification|education|projects|certifications|skills)\b/.test(lower)) {
      resumeText = p;
      continue;
    }
    if (!jobDescriptionText && /\bjob description\b/.test(lower)) {
      jobDescriptionText = p;
      continue;
    }
    if (!performanceReviewText && /\bperformance review\b/.test(lower)) {
      performanceReviewText = p;
      continue;
    }

    otherTexts.push(p);
  }

  if (!resumeText && !jobDescriptionText && !performanceReviewText) {
    resumeText = text;
  }

  const generationId = new Date().toISOString();

  const userContent = [
    'GENERATION_ID (variation hint; DO NOT include this value in the JSON):',
    generationId,
    '',
    'RESUME_TEXT (candidate facts; source of truth):',
    resumeText || '',
    '',
    'JOB_DESCRIPTION_TEXT (target role requirements; do NOT claim as candidate experience unless supported by RESUME_TEXT/REVIEWS):',
    jobDescriptionText || '',
    '',
    'PERFORMANCE_REVIEW_TEXT (evidence of impact/outcomes; may be empty):',
    performanceReviewText || '',
    ...(otherTexts.length ? ['', 'OTHER_INPUT_TEXT (unclassified; treat cautiously):', otherTexts.join('\n\n-----\n\n')] : []),
    '',
    'OPTIONAL CONTEXT (may be empty JSON):',
    JSON.stringify(context || {}, null, 2)
  ].join('\n');

  return {
    system: [{ text: systemPrompt }],
    messages: [
      {
        role: 'user',
        content: [{ text: userContent }]
      }
    ],
    inferenceConfig: {
      maxTokens: 1400,
      temperature: 0.45
    }
  };
}

function _getBedrockClient() {
  const region = _env('AWS_REGION');
  if (!region) {
    throw _jsonError('AWS_REGION_MISSING', 'AWS_REGION env var is required to call AWS Bedrock.', {
      requiredEnv: ['AWS_REGION', 'BEDROCK_MODEL_ID']
    });
  }

  return new BedrockRuntimeClient({ region });
}

/**
 * PUBLIC_INTERFACE
 */
export async function generatePersonaDraft(extractedText, options = {}) {
  /**
   * Generate a persona draft using AWS Bedrock Claude and validate strict JSON schema.
   *
   * @param {string} extractedText
   * @param {{ context?: object, preferMock?: boolean }} [options]
   * @returns {Promise<{persona: object, mode: 'bedrock'|'mock', warnings: string[]} | {error: string, retryable: boolean}>}
   */
  const text = String(extractedText || '').trim();
  if (!text) {
    throw _jsonError('NO_SOURCE_TEXT', 'extractedText is required to generate a persona draft.');
  }

  if (text.length < 100) {
    throw _jsonError(
      'INVALID_INPUT_LENGTH',
      'Input text is too short to generate a meaningful persona. Provide at least 100 characters.',
      { minLength: 100, actualLength: text.length }
    );
  }

  const preferMock = Boolean(options.preferMock);
  const modelId = _env('BEDROCK_MODEL_ID');

  if (preferMock || !modelId) {
    const extracted = extractNameAndCurrentRole(text);

    const mock = {
      professional_summary:
        'Mock persona draft (Bedrock not configured or mock requested). This output is strict JSON and schema-validated.',
      career_highlights: [{ text: 'Mock highlight (Bedrock not configured).', source: 'Unknown' }],
      core_competencies: ['Problem solving', 'Communication', 'Ownership'],
      education: [],
      technical_stack: {
        languages: [],
        frameworks: [],
        databases: [],
        cloud_and_devops: [],
        tools: []
      }
    };

    const validated = _assertValidPersonaDraft(mock);
    const enriched = {
      ...validated,
      full_name: extracted.name || '',
      current_role: extracted.role || ''
    };

    return { persona: enriched, mode: 'mock', warnings: ['Mock mode used.'] };
  }

  const client = _getBedrockClient();

  const converseInput = _buildClaudeConverseInput({
    systemPrompt: PERSONA_SYSTEM_PROMPT,
    extractedText: text,
    context: options.context || null
  });

  const cmd = new ConverseCommand({
    modelId,
    ...converseInput
  });

  let respJson;
  try {
    respJson = await client.send(cmd);

    // eslint-disable-next-line no-console
    console.log('[personaService] Raw Bedrock response:', JSON.stringify(respJson, null, 2));
  } catch {
    return { error: 'AI_GENERATION_FAILED', retryable: true };
  }

  const modelText = _extractTextFromBedrockResponseJson(respJson);
  if (!modelText) {
    return { error: 'AI_GENERATION_FAILED', retryable: true };
  }

  let parsed = _safeJsonParse(modelText);
  if (!parsed.ok) {
    const match = String(modelText).match(/\{[\s\S]*\}/);
    if (match && match[0]) {
      parsed = _safeJsonParse(match[0]);
    }
  }

  if (!parsed.ok) {
    return { error: 'AI_GENERATION_FAILED', retryable: true };
  }

  try {
    const rawObj = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
    const persona = _assertValidPersonaDraft(rawObj);

    const extracted = extractNameAndCurrentRole(text);

    const enriched = {
      ...persona,
      full_name: extracted.name || '',
      current_role: extracted.role || ''
    };

    return { persona: enriched, mode: 'bedrock', warnings: [] };
  } catch {
    return { error: 'AI_GENERATION_FAILED', retryable: true };
  }
}

/**
 * PUBLIC_INTERFACE
 */
export async function createPersonaDraft({ personaDraftJson, alignmentScore = 0 }) {
  /**
   * Persist a persona draft JSON into the persona_drafts table (best-effort, DB-optional).
   *
   * @param {{personaDraftJson: object, alignmentScore?: number}} input
   * @returns {Promise<{personaDraftId: string|null, savedPersonaDraftJson: object|null, persisted: boolean}>}
   */
  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) {
    return { personaDraftId: null, savedPersonaDraftJson: null, persisted: false };
  }

  const personaDraftId = uuidV4();

  const obj = personaDraftJson && typeof personaDraftJson === 'object' ? personaDraftJson : null;
  if (!obj || Array.isArray(obj)) {
    throw _jsonError('INVALID_PERSONA_DRAFT_JSON', 'personaDraftJson must be a JSON object.');
  }

  let savedPersonaDraftJson = obj;
  if (
    Object.prototype.hasOwnProperty.call(obj, 'professional_summary') ||
    Object.prototype.hasOwnProperty.call(obj, 'core_competencies') ||
    Object.prototype.hasOwnProperty.call(obj, 'technical_stack') ||
    Object.prototype.hasOwnProperty.call(obj, 'career_highlights')
  ) {
    savedPersonaDraftJson = _assertValidPersonaDraft(obj);
  }

  await dbQuery(
    `
    INSERT INTO persona_drafts (id, persona_draft_json, alignment_score, created_at)
    VALUES (?,?,?,?)
    `,
    [personaDraftId, JSON.stringify(savedPersonaDraftJson), Number(alignmentScore) || 0, new Date()]
  );

  return { personaDraftId, savedPersonaDraftJson, persisted: true };
}

/**
 * PUBLIC_INTERFACE
 */
export async function finalizePersona(draftId) {
  /**
   * Finalize a previously saved persona draft by copying it from persona_drafts to persona_final.
   *
   * @param {string} draftId - persona_drafts.id
   * @returns {Promise<{finalPersonaId: string}>}
   */
  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) {
    const err = _jsonError('DB_NOT_CONFIGURED', 'Database is not configured for finalizePersona (requires MySQL).');
    err.httpStatus = 503;
    throw err;
  }

  const id = String(draftId || '').trim();
  if (!id) {
    throw _jsonError('INVALID_DRAFT_ID', 'draftId is required.');
  }

  const draftRes = await dbQuery(
    `
    SELECT persona_draft_json, alignment_score
    FROM persona_drafts
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  const row = draftRes.rows[0];
  if (!row) {
    const err = _jsonError('DRAFT_NOT_FOUND', 'persona draft not found.');
    err.httpStatus = 404;
    throw err;
  }

  let personaDraftJson = row.persona_draft_json;
  if (typeof personaDraftJson === 'string') {
    personaDraftJson = JSON.parse(personaDraftJson);
  }

  const validated = _assertValidPersonaDraft(personaDraftJson);

  const finalPersonaId = uuidV4();
  await dbQuery(
    `
    INSERT INTO persona_final (id, persona_final_json, alignment_score, created_at)
    VALUES (?,?,?,?)
    `,
    [finalPersonaId, JSON.stringify(validated), Number(row.alignment_score) || 0, new Date()]
  );

  return { finalPersonaId };
}

const personaService = {
  PERSONA_SYSTEM_PROMPT,
  personaDraftJsonSchema,
  generatePersonaDraft,
  createPersonaDraft,
  finalizePersona
};

export default personaService;
