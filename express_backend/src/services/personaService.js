'use strict';

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const Ajv = require('ajv');

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
 * Pivot note:
 * - Ignore any prior "3/2 rule" / "alignment scores" requirements.
 * - Output must be JSON only, strictly matching the persona_draft_json schema below.
 */
const PERSONA_SYSTEM_PROMPT = [
  'You are Claude Sonnet 4.5 running inside an automated backend pipeline for persona draft generation.',
  '',
  'TASK',
  'Given raw unstructured career text (resume/job descriptions/performance reviews), extract and summarize into a SINGLE JSON object that conforms EXACTLY to the schema below.',
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
  '  "core_competencies": string[],',
  '  "work_experience": [',
  '    {',
  '      "company": string,',
  '      "title": string,',
  '      "start_date": string,',
  '      "end_date": string,',
  '      "location": string,',
  '      "highlights": string[]',
  '    }',
  '  ],',
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
  'FIELD GUIDANCE',
  '- professional_summary: 2-5 sentences, professionally written, grounded in evidence from the input text.',
  '- core_competencies: concise skill/competency phrases (strings).',
  '- work_experience: most relevant roles; use empty strings when dates/locations are unknown; highlights should be bullet-style strings.',
  '- education: include degrees/certifications if present; otherwise empty array.',
  '- technical_stack: categorize technologies; if unknown, return empty arrays.',
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
    core_competencies: {
      type: 'array',
      items: { type: 'string' }
    },
    work_experience: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: { type: 'string' },
          title: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          location: { type: 'string' },
          highlights: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['company', 'title', 'start_date', 'end_date', 'location', 'highlights']
      }
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
  required: ['professional_summary', 'core_competencies', 'work_experience', 'education', 'technical_stack']
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

/**
 * Parse a Bedrock Converse response into text content.
 *
 * Typical Converse output shape:
 * {
 *   output: {
 *     message: {
 *       role: "assistant",
 *       content: [{ text: "..." }, ...]
 *     }
 *   }
 * }
 */
function _extractTextFromBedrockResponseJson(respJson) {
  if (!respJson) return '';

  // Converse API
  const converseContent = respJson?.output?.message?.content;
  if (Array.isArray(converseContent)) {
    const texts = converseContent
      .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean);
    if (texts.length) return texts.join('\n').trim();
  }

  // Older Claude Messages API format (defensive)
  if (Array.isArray(respJson.content)) {
    const texts = respJson.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    return texts.join('\n').trim();
  }

  // Fallbacks (older patterns)
  if (typeof respJson.output_text === 'string') return respJson.output_text.trim();
  if (typeof respJson.completion === 'string') return respJson.completion.trim();
  if (typeof respJson.result === 'string') return respJson.result.trim();

  return '';
}

function _stripMarkdownCodeFences(text) {
  /**
   * Remove markdown code fences commonly returned by LLMs:
   *  - ```json\n{...}\n```
   *  - ```\n{...}\n```
   *
   * If the content is fenced, we return the inner content; otherwise return the
   * original text trimmed.
   */
  const t = String(text || '').trim();

  // Match a full fenced block, optionally with a language tag.
  const fenced = t.match(/^```(?:\s*json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced && typeof fenced[1] === 'string') {
    return fenced[1].trim();
  }

  return t;
}

function _extractFirstJsonSubstring(text) {
  /**
   * Best-effort extraction for cases where the model adds leading/trailing prose.
   * We keep this conservative: find the first '{' or '[' and parse until the last
   * '}' or ']'. This is only used as a fallback when direct parsing fails.
   */
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
    // Fallback: sometimes models prepend/append commentary even when instructed not to.
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

function _assertValidPersonaDraft(obj) {
  const ok = validatePersonaDraft(obj);
  if (ok) return obj;

  throw _jsonError('PERSONA_SCHEMA_VALIDATION_FAILED', 'Model output did not match required persona schema.', {
    ajvErrors: validatePersonaDraft.errors
  });
}

/**
 * Build a Bedrock "Converse" payload.
 *
 * Admin requirement:
 * - Use the Bedrock Runtime Converse API format (not InvokeModel).
 *
 * Docs reference (conceptual):
 * - input: { modelId, system: [{text}], messages: [{role, content:[{text}]}], inferenceConfig }
 */
function _buildClaudeConverseInput({ systemPrompt, extractedText, context }) {
  const userContent = [
    'INPUT TEXT (unstructured):',
    extractedText,
    '',
    'OPTIONAL CONTEXT (may be empty JSON):',
    JSON.stringify(context || {}, null, 2)
  ].join('\n');

  return {
    // Converse system prompt is an array of content blocks.
    system: [{ text: systemPrompt }],
    messages: [
      {
        role: 'user',
        content: [{ text: userContent }]
      }
    ],
    inferenceConfig: {
      maxTokens: 1200,
      temperature: 0.2
    }
  };
}

function _getBedrockClient() {
  const region = _env('AWS_REGION');
  if (!region) {
    throw _jsonError(
      'AWS_REGION_MISSING',
      'AWS_REGION env var is required to call AWS Bedrock.',
      { requiredEnv: ['AWS_REGION', 'BEDROCK_MODEL_ID'] }
    );
  }

  // Credentials are resolved via the default provider chain:
  // env vars, shared config, instance profile, etc.
  return new BedrockRuntimeClient({ region });
}

/**
 * PUBLIC_INTERFACE
 */
async function generatePersonaDraft(extractedText, options = {}) {
  /**
   * Generate a persona draft using AWS Bedrock Claude and validate strict JSON schema.
   *
   * Hardening requirements:
   * - Edge-case validation: if input text is under 100 characters, reject with INVALID_INPUT_LENGTH.
   * - AI failure hardening: if Bedrock call fails OR output is malformed JSON, return structured fallback:
   *     { error: "AI_GENERATION_FAILED", retryable: true }
   *
   * @param {string} extractedText - Combined extracted/normalized text from documents.
   * @param {{ context?: object, preferMock?: boolean }} [options]
   * @returns {Promise<{persona: object, mode: 'bedrock'|'mock', warnings: string[]} | {error: string, retryable: boolean}>}
   */
  const text = String(extractedText || '').trim();
  if (!text) {
    throw _jsonError('NO_SOURCE_TEXT', 'extractedText is required to generate a persona draft.');
  }

  // Edge-case validation: block obvious nonsense / too-short input.
  if (text.length < 100) {
    throw _jsonError(
      'INVALID_INPUT_LENGTH',
      'Input text is too short to generate a meaningful persona. Provide at least 100 characters.',
      { minLength: 100, actualLength: text.length }
    );
  }

  const preferMock = Boolean(options.preferMock);
  const modelId = _env('BEDROCK_MODEL_ID');

  // If explicitly requested OR model isn't configured, fall back to mock.
  // Note: input-length validation still applies (above) to prevent persisting nonsense even in mock mode.
  if (preferMock || !modelId) {
    const mock = {
      professional_summary:
        'Mock persona draft (Bedrock not configured or mock requested). This output is strict JSON and schema-validated.',
      core_competencies: ['Problem solving', 'Communication', 'Ownership'],
      work_experience: [
        {
          company: '',
          title: 'Professional',
          start_date: '',
          end_date: '',
          location: '',
          highlights: ['Mock experience highlight.']
        }
      ],
      education: [],
      technical_stack: {
        languages: [],
        frameworks: [],
        databases: [],
        cloud_and_devops: [],
        tools: []
      }
    };

    return { persona: _assertValidPersonaDraft(mock), mode: 'mock', warnings: ['Mock mode used.'] };
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

    // Debug requirement: log raw response to confirm whether Sonnet is wrapping JSON in extra text.
    // eslint-disable-next-line no-console
    console.log('[personaService] Raw Bedrock response:', JSON.stringify(respJson, null, 2));
  } catch (e) {
    // Requirement: structured fallback (do not throw), retryable.
    return { error: 'AI_GENERATION_FAILED', retryable: true };
  }

  const modelText = _extractTextFromBedrockResponseJson(respJson);
  if (!modelText) {
    return { error: 'AI_GENERATION_FAILED', retryable: true };
  }

  // Parser fix requirement:
  // If the model returns prose + JSON, extract the first JSON object block using regex.
  // (We still attempt strict parsing first; regex is a targeted fallback.)
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
    return { persona, mode: 'bedrock', warnings: [] };
  } catch (_) {
    // Schema validation failure counts as malformed output -> fallback.
    return { error: 'AI_GENERATION_FAILED', retryable: true };
  }
}

/**
 * PUBLIC_INTERFACE
 */
async function createPersonaDraft({ personaDraftJson, alignmentScore = 0 }) {
  /**
   * Persist a persona draft JSON into the persona_drafts table (best-effort, DB-optional).
   *
   * When DB is configured (DB_ENGINE=mysql and MySQL env is present), inserts into:
   *   persona_drafts(id, persona_draft_json, alignment_score, created_at)
   *
   * @param {{personaDraftJson: object, alignmentScore?: number}} input
   * @returns {Promise<{personaDraftId: string|null, savedPersonaDraftJson: object|null, persisted: boolean}>}
   */
  const { uuidV4 } = require('../utils/uuid');
  const { getDbEngine, isDbConfigured, isMysqlConfigured, dbQuery } = require('../db/connection');

  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) {
    // DB not configured; do not throw (keeps service usable in dev/CI without DB).
    return { personaDraftId: null, savedPersonaDraftJson: null, persisted: false };
  }

  const personaDraftId = uuidV4();

  /**
   * Compatibility note:
   * - Historically, downstream integration tests expect a "legacy" persona draft JSON shape
   *   (full_name/professional_title/mastery_skills/etc).
   * - The newer Bedrock-backed draft schema is validated by _assertValidPersonaDraft().
   *
   * For persistence, we accept either:
   * - v2 schema (validated), OR
   * - any JSON object (legacy), as long as it's a plain object.
   *
   * This keeps DB writes working across evolving contracts while the app migrates.
   */
  const obj = personaDraftJson && typeof personaDraftJson === 'object' ? personaDraftJson : null;
  if (!obj || Array.isArray(obj)) {
    throw _jsonError('INVALID_PERSONA_DRAFT_JSON', 'personaDraftJson must be a JSON object.');
  }

  // If it looks like v2 schema, validate strictly; otherwise persist as-is.
  let savedPersonaDraftJson = obj;
  if (
    Object.prototype.hasOwnProperty.call(obj, 'professional_summary') ||
    Object.prototype.hasOwnProperty.call(obj, 'core_competencies') ||
    Object.prototype.hasOwnProperty.call(obj, 'technical_stack')
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
async function finalizePersona(draftId) {
  /**
   * Finalize a previously saved persona draft by copying it from persona_drafts to persona_final.
   *
   * Behavior:
   * - Fetch persona_draft_json from persona_drafts by id
   * - Insert into persona_final with a new id
   * - Return { finalPersonaId }
   *
   * DB-optional:
   * - If DB isn't configured, returns a deterministic error.
   *
   * @param {string} draftId - persona_drafts.id
   * @returns {Promise<{finalPersonaId: string}>}
   */
  const { uuidV4 } = require('../utils/uuid');
  const { getDbEngine, isDbConfigured, isMysqlConfigured, dbQuery } = require('../db/connection');

  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) {
    const err = _jsonError(
      'DB_NOT_CONFIGURED',
      'Database is not configured for finalizePersona (requires MySQL).'
    );
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

  // MySQL JSON can be returned as string or object depending on driver config.
  let personaDraftJson = row.persona_draft_json;
  if (typeof personaDraftJson === 'string') {
    personaDraftJson = JSON.parse(personaDraftJson);
  }

  // Validate schema before persisting final to avoid copying garbage.
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

module.exports = {
  PERSONA_SYSTEM_PROMPT,
  personaDraftJsonSchema,
  generatePersonaDraft,
  createPersonaDraft,
  finalizePersona
};
