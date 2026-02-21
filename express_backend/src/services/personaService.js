'use strict';

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const Ajv = require('ajv');

/**
 * Persona generation service (AWS Bedrock Claude).
 *
 * Responsibilities:
 * - Provide a strict system prompt that forces strict JSON output and enforces the "3/2 Rule"
 * - Call AWS Bedrock using env vars (AWS credentials are loaded by AWS SDK default provider chain)
 * - Validate model output against a strict JSON Schema before returning to callers
 *
 * Environment variables required (configured outside code):
 * - AWS_REGION
 * - BEDROCK_MODEL_ID
 * - (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) OR any standard AWS credential provider supported by AWS SDK
 */

/**
 * System prompt used for persona generation.
 * Enforces:
 * - Strict JSON output (no markdown, no code fences, no extra keys)
 * - "3/2 Rule": exactly 3 mastery skills and exactly 2 growth areas
 */
const PERSONA_SYSTEM_PROMPT = [
  'You are a Senior Backend Engineer and Prompt Engineer building the "Holistic Persona Construction" engine.',
  '',
  'TASK',
  'Given unstructured career text (resume/job descriptions/performance reviews), you MUST output a SINGLE JSON object that conforms EXACTLY to the required schema.',
  '',
  'ABSOLUTE OUTPUT RULES (STRICT JSON)',
  '1) Output MUST be valid JSON. No markdown. No backticks. No prose before or after JSON.',
  '2) Output MUST be a single JSON object, not an array.',
  '3) Output MUST contain ONLY the keys defined in the schema; no additional keys are allowed.',
  '4) All string values MUST be plain strings (no nested objects/arrays unless schema says so).',
  '5) If information is missing, make a best-effort inference from the text. If still unknown, use an empty string for strings, 0 for integers.',
  '6) The arrays MUST contain strings only and MUST be exactly the required sizes.',
  '',
  '3/2 RULE (MANDATORY)',
  '- mastery_skills: MUST contain EXACTLY 3 items (top 3 mastery areas).',
  '- growth_areas: MUST contain EXACTLY 2 items (top 2 growth areas).',
  '- If the text suggests more than the required count, pick the most representative items.',
  '- If the text suggests fewer than required, infer reasonable items from context while staying plausible and consistent with the text.',
  '',
  'SCHEMA (STRICT)',
  '{',
  '  "full_name": string,',
  '  "professional_title": string,',
  '  "mastery_skills": string[3],',
  '  "growth_areas": string[2],',
  '  "experience_years": integer,',
  '  "raw_ai_summary": string',
  '}',
  '',
  'CONTENT GUIDELINES',
  '- full_name: person name if present; otherwise best-effort (or empty string).',
  '- professional_title: concise title that reflects current/target role (e.g., "Senior Software Engineer").',
  '- mastery_skills: concrete strengths (e.g., "Backend APIs (Node.js/Express)", "System design", "AWS").',
  '- growth_areas: realistic improvement areas (e.g., "Public speaking", "Kubernetes").',
  '- experience_years: integer number of years based on dates/tenure; if unknown, estimate from cues or use 0.',
  '- raw_ai_summary: 2-5 sentences summarizing the candidate and tying mastery/growth to evidence in text.',
  '',
  'REMINDER',
  'Return ONLY the JSON object and nothing else.'
].join('\n');

/**
 * Strict JSON schema for generated persona drafts.
 * (additionalProperties=false enforces no extra keys)
 */
const personaDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    full_name: { type: 'string' },
    professional_title: { type: 'string' },
    mastery_skills: {
      type: 'array',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 3
    },
    growth_areas: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2
    },
    experience_years: { type: 'integer' },
    raw_ai_summary: { type: 'string' }
  },
  required: [
    'full_name',
    'professional_title',
    'mastery_skills',
    'growth_areas',
    'experience_years',
    'raw_ai_summary'
  ]
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
 * Parse a Bedrock Claude response into text content.
 * Bedrock response shape varies by model family. For Claude via Messages API,
 * response JSON typically contains `content: [{type:'text', text:'...'}]`.
 */
function _extractTextFromBedrockResponseJson(respJson) {
  if (!respJson) return '';

  // Common Claude Messages API format:
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

function _safeJsonParse(jsonText) {
  try {
    return { ok: true, value: JSON.parse(jsonText) };
  } catch (e) {
    return { ok: false, error: e };
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
 * Build a Bedrock "InvokeModel" payload for Anthropic Claude messages.
 * Note: This is model-specific; most current Claude on Bedrock supports:
 * {
 *   anthropic_version: "bedrock-2023-05-31",
 *   max_tokens: ...,
 *   system: "...",
 *   messages: [{role:"user", content:[{type:"text", text:"..."}]}]
 * }
 */
function _buildClaudeInvokeBody({ systemPrompt, extractedText, context }) {
  const userContent = [
    'INPUT TEXT (unstructured):',
    extractedText,
    '',
    'OPTIONAL CONTEXT (may be empty JSON):',
    JSON.stringify(context || {}, null, 2)
  ].join('\n');

  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1200,
    temperature: 0.2,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: userContent }]
      }
    ]
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
   * @param {string} extractedText - Combined extracted/normalized text from documents.
   * @param {{ context?: object, preferMock?: boolean }} [options]
   * @returns {Promise<{persona: object, mode: 'bedrock'|'mock', warnings: string[]}>}
   */
  const text = String(extractedText || '').trim();
  if (!text) {
    throw _jsonError('NO_SOURCE_TEXT', 'extractedText is required to generate a persona draft.');
  }

  const preferMock = Boolean(options.preferMock);
  const modelId = _env('BEDROCK_MODEL_ID');

  // If explicitly requested OR model isn't configured, fall back to mock.
  if (preferMock || !modelId) {
    const mock = {
      full_name: '',
      professional_title: 'Professional',
      mastery_skills: ['Problem solving', 'Communication', 'Ownership'],
      growth_areas: ['Public speaking', 'Delegation'],
      experience_years: 0,
      raw_ai_summary:
        'Mock persona draft (Bedrock not configured or mock requested). This output is strict JSON and schema-validated.'
    };

    return { persona: _assertValidPersonaDraft(mock), mode: 'mock', warnings: ['Mock mode used.'] };
  }

  const client = _getBedrockClient();

  const body = _buildClaudeInvokeBody({
    systemPrompt: PERSONA_SYSTEM_PROMPT,
    extractedText: text,
    context: options.context || null
  });

  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(body), 'utf8')
  });

  let resp;
  try {
    resp = await client.send(cmd);
  } catch (e) {
    throw _jsonError('BEDROCK_INVOKE_FAILED', 'Failed to invoke Bedrock model.', {
      message: e?.message || String(e)
    });
  }

  let respJson;
  try {
    const raw = Buffer.from(resp.body).toString('utf8');
    respJson = JSON.parse(raw);
  } catch (e) {
    throw _jsonError('BEDROCK_RESPONSE_PARSE_FAILED', 'Failed to parse Bedrock response JSON.', {
      message: e?.message || String(e)
    });
  }

  const modelText = _extractTextFromBedrockResponseJson(respJson);
  if (!modelText) {
    throw _jsonError('BEDROCK_EMPTY_OUTPUT', 'Bedrock returned empty output.', { bedrockResponse: respJson });
  }

  const parsed = _safeJsonParse(modelText);
  if (!parsed.ok) {
    throw _jsonError('MODEL_OUTPUT_NOT_JSON', 'Model output was not valid JSON.', {
      modelTextSnippet: modelText.slice(0, 500)
    });
  }

  const persona = _assertValidPersonaDraft(parsed.value);

  return { persona, mode: 'bedrock', warnings: [] };
}

module.exports = {
  PERSONA_SYSTEM_PROMPT,
  personaDraftJsonSchema,
  generatePersonaDraft
};
