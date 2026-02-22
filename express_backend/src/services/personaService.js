'use strict';

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
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
  'You are Claude Sonnet 4.5 running inside an automated backend pipeline for persona generation.',
  '',
  'TASK',
  'Given unstructured career text (resume/job descriptions/performance reviews), output a SINGLE JSON object that conforms EXACTLY to the schema below.',
  '',
  'ABSOLUTE OUTPUT RULES (JSON-ONLY; ZERO EXTRA TEXT)',
  '1) Output MUST be valid JSON (RFC 8259).',
  '2) Output MUST be a single JSON object (not an array, not multiple objects).',
  '3) Output MUST contain ONLY the keys defined in the schema. Do not add any other keys.',
  '4) Output MUST contain NO preamble, NO explanation, NO commentary.',
  '5) Output MUST contain NO markdown and NO code fences (no ```).',
  '6) Do not wrap the JSON in quotes. Do not prefix with "Here is the JSON". Do not suffix with anything.',
  '7) All array items MUST be strings (no objects).',
  '',
  '3/2 RULE (MANDATORY; EXACT COUNTS)',
  '- You MUST extract/produce EXACTLY 3 items in mastery_skills.',
  '- You MUST extract/produce EXACTLY 2 items in growth_areas.',
  '- Do not output 4+ mastery skills or 3+ growth areas under any circumstances.',
  '- If the text suggests more candidates than allowed, choose the MOST representative, highest-signal items grounded in the text.',
  '- If the text suggests fewer candidates than required, infer plausible items consistent with the text (do NOT contradict it).',
  '- Each item MUST be a short, specific skill/area phrase (not a sentence, not a paragraph).',
  '',
  'SCHEMA (STRICT; MUST MATCH EXACTLY)',
  '{',
  '  "full_name": string,',
  '  "professional_title": string,',
  '  "mastery_skills": string[3],',
  '  "growth_areas": string[2],',
  '  "experience_years": integer,',
  '  "raw_ai_summary": string',
  '}',
  '',
  'FIELD GUIDANCE',
  '- full_name: use name if present; else empty string.',
  '- professional_title: concise, realistic title reflecting current/target role.',
  '- mastery_skills: 3 strongest demonstrated capabilities, concrete and role-relevant.',
  '- growth_areas: 2 realistic improvement areas suggested or implied by the text.',
  '- experience_years: integer estimate; if unknown use 0.',
  '- raw_ai_summary: 2-5 sentences summarizing the candidate and citing evidence from the text.',
  '',
  'FINAL CHECK BEFORE YOU OUTPUT',
  '- Confirm mastery_skills.length === 3 and growth_areas.length === 2.',
  '- Confirm output is ONLY a JSON object with EXACTLY these keys: full_name, professional_title, mastery_skills, growth_areas, experience_years, raw_ai_summary.',
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
    throw _jsonError('BEDROCK_CONVERSE_FAILED', 'Failed to converse with Bedrock model.', {
      message: e?.message || String(e)
    });
  }

  const modelText = _extractTextFromBedrockResponseJson(respJson);
  if (!modelText) {
    throw _jsonError('BEDROCK_EMPTY_OUTPUT', 'Bedrock returned empty output.', { bedrockResponse: respJson });
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
    throw _jsonError('MODEL_OUTPUT_NOT_JSON', 'Model output was not valid JSON.', {
      modelTextSnippet: modelText.slice(0, 800)
    });
  }

  // DB/schema mapper alignment:
  // Normalize common alternate field names produced by some prompts/models into our strict schema.
  // This prevents downstream persistence from failing due to unexpected keys/names.
  const rawObj = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
  const normalized = { ...rawObj };

  // Common alias: strengths -> mastery_skills
  if (!Array.isArray(normalized.mastery_skills) && Array.isArray(normalized.strengths)) {
    normalized.mastery_skills = normalized.strengths;
    delete normalized.strengths;
  }

  // Common alias: masteries -> mastery_skills
  if (!Array.isArray(normalized.mastery_skills) && Array.isArray(normalized.masteries)) {
    normalized.mastery_skills = normalized.masteries;
    delete normalized.masteries;
  }

  // Common alias: improvement_areas -> growth_areas
  if (!Array.isArray(normalized.growth_areas) && Array.isArray(normalized.improvement_areas)) {
    normalized.growth_areas = normalized.improvement_areas;
    delete normalized.improvement_areas;
  }

  // Common alias: growthAreas -> growth_areas
  if (!Array.isArray(normalized.growth_areas) && Array.isArray(normalized.growthAreas)) {
    normalized.growth_areas = normalized.growthAreas;
    delete normalized.growthAreas;
  }

  const persona = _assertValidPersonaDraft(normalized);

  return { persona, mode: 'bedrock', warnings: [] };
}

module.exports = {
  PERSONA_SYSTEM_PROMPT,
  personaDraftJsonSchema,
  generatePersonaDraft
};
