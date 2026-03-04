'use strict';

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

/**
 * Bedrock Role Generation Service
 *
 * Uses Amazon Bedrock Runtime to generate targeted roles for a given user persona/skills.
 *
 * ENV REQUIREMENTS (must be provided via .env by orchestrator):
 * - AWS_REGION: e.g. "us-east-1"
 * - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (as appropriate for environment)
 *
 * Optional ENV:
 * - BEDROCK_ROLE_MODEL_ID: override the Bedrock model id / inference profile id.
 *   IMPORTANT: For provisioned throughput / throughput errors, prefer an INFERENCE PROFILE ID
 *   for your region (example: "us.anthropic.claude-3-haiku-20240307-v1:0") instead of the base model id.
 *
 * Notes:
 * - This service is designed to return STRICT JSON only.
 * - We defensively parse and validate returned content because LLMs can still hallucinate wrappers.
 */

/**
 * Default to the region-scoped inference profile id (per user_input_ref).
 * This can be overridden via BEDROCK_ROLE_MODEL_ID.
 */
const DEFAULT_MODEL_ID = 'us.anthropic.claude-3-haiku-20240307-v1:0';

/**
 * Extract text content from a Bedrock Claude response.
 * Claude "messages" API returns something like:
 * {
 *   content: [{ type: "text", text: "..." }],
 *   ...
 * }
 */
function _extractClaudeText(bedrockJson) {
  const content = bedrockJson?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    if (texts.length > 0) return texts.join('\n').trim();
  }
  if (typeof bedrockJson?.outputText === 'string') return bedrockJson.outputText.trim(); // fallback for other formats
  return '';
}

/**
 * Attempt to extract the first JSON array from a string.
 * This is a safety valve if the model returns leading/trailing text.
 */
function _extractFirstJsonArray(text) {
  if (!text) return null;

  // Fast path: pure JSON array
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;

  // Heuristic scan for first balanced [...] block
  const start = trimmed.indexOf('[');
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (depth === 0) {
      const candidate = trimmed.slice(start, i + 1).trim();
      if (candidate.startsWith('[') && candidate.endsWith(']')) return candidate;
      return null;
    }
  }
  return null;
}

function _normStr(v) {
  return String(v || '').trim();
}

function _asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => _normStr(x)).filter(Boolean);
}

function _validateAndNormalizeGeneratedRoles(parsed) {
  if (!Array.isArray(parsed)) {
    const err = new Error('Bedrock role generator did not return a JSON array.');
    err.code = 'bedrock_invalid_json_shape';
    throw err;
  }

  // Normalize into a stable API shape that matches existing roles/search output expectations.
  // Required per user_input_ref: title, industry, salary_range, required_skills (>=5).
  const out = [];
  const seen = new Set();

  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue;

    const title = _normStr(r.title);
    const industry = _normStr(r.industry);
    const salaryRange = _normStr(r.salary_range);
    const requiredSkills = _asStringArray(r.required_skills);

    if (!title || !industry || !salaryRange) continue;
    if (requiredSkills.length < 5) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      // Keep compatibility with existing /api/roles/search payload shape
      role_id: `bedrock-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')}`,
      role_title: title,
      industry,
      skills_required: requiredSkills,
      salary_range: salaryRange,
      match_metadata: { source: 'bedrock' },
      is_targetable: true
    });
  }

  return out;
}

/**
 * Build a strict-JSON prompt that aligns with the 3/2 scoring engine needs:
 * - role.required_skills must be >= 5 and concrete (so scoring can compare).
 * - output must be ONLY a JSON array (no markdown, no backticks).
 */
function _buildStrictJsonPrompt(userPersona) {
  const skills =
    Array.isArray(userPersona?.skills)
      ? userPersona.skills
      : Array.isArray(userPersona?.validated_skills)
        ? userPersona.validated_skills
        : Array.isArray(userPersona?.validatedSkills)
          ? userPersona.validatedSkills
          : Array.isArray(userPersona?.user_skills)
            ? userPersona.user_skills.map((s) =>
                s && typeof s === 'object' ? s.name || s.skill || s.skill_name : s
              )
            : Array.isArray(userPersona?.userSkills)
              ? userPersona.userSkills.map((s) =>
                  s && typeof s === 'object' ? s.name || s.skill || s.skill_name : s
                )
              : [];

  const skillsList = _asStringArray(skills).slice(0, 30); // cap to keep prompt compact
  const skillsInline = skillsList.length > 0 ? skillsList.join(', ') : 'N/A';

  return [
    'Act as a career expert.',
    `Given these user skills: [${skillsInline}], return a JSON array of 5 real-world job roles.`,
    'Each array element MUST be an object with EXACTLY these keys:',
    '- "title" (string)',
    '- "industry" (string)',
    '- "salary_range" (string, e.g., "$120k-$170k" or "₹18L-₹28L")',
    '- "required_skills" (array of strings; at least 5 skills; concrete and role-relevant)',
    '',
    'STRICT OUTPUT RULES:',
    '1) Output MUST be valid JSON.',
    '2) Output MUST be ONLY the JSON array (no extra text, no markdown, no code fences).',
    '3) Do not include trailing comments.',
    '4) Ensure required_skills has at least 5 items for every role.',
    '',
    'Return exactly 5 roles.'
  ].join('\n');
}

function _getBedrockClient() {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) {
    const err = new Error('Missing AWS_REGION (or AWS_DEFAULT_REGION) for BedrockRuntimeClient.');
    err.code = 'missing_aws_region';
    throw err;
  }
  return new BedrockRuntimeClient({ region });
}

/**
 * Fallback generator: returns exactly 5 hardcoded roles in the Bedrock JSON shape:
 * [{ title, industry, salary_range, required_skills }]
 *
 * This is required as a safety net for Bedrock throughput errors so Day 3 UI can be verified.
 */
function _fallbackBedrockJsonRoles() {
  return [
    {
      title: 'Full-Stack Software Engineer',
      industry: 'Technology',
      salary_range: '$120k-$170k',
      required_skills: ['JavaScript', 'React', 'Node.js', 'REST APIs', 'SQL', 'Git']
    },
    {
      title: 'Backend Engineer (Node.js)',
      industry: 'Technology',
      salary_range: '$130k-$185k',
      required_skills: ['Node.js', 'Express', 'SQL', 'API Design', 'Performance Tuning', 'Observability']
    },
    {
      title: 'Data Analyst',
      industry: 'Technology',
      salary_range: '$80k-$120k',
      required_skills: ['SQL', 'Excel', 'Data Visualization', 'Statistics', 'Dashboards', 'Stakeholder Management']
    },
    {
      title: 'Product Manager (Technical)',
      industry: 'Technology',
      salary_range: '$130k-$210k',
      required_skills: ['Roadmapping', 'Prioritization', 'User Research', 'Analytics', 'Communication', 'Stakeholder Management']
    },
    {
      title: 'DevOps Engineer',
      industry: 'Technology',
      salary_range: '$130k-$205k',
      required_skills: ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring', 'Infrastructure as Code']
    }
  ];
}

/**
 * PUBLIC_INTERFACE
 * Generate targeted roles from a user persona using Amazon Bedrock (Claude 3 Haiku).
 *
 * @param {object} userPersona - Persona object containing at least skills/validated_skills/user_skills.
 * @param {object} [options]
 * @param {string} [options.modelId] - Override Bedrock model id (or inference profile id).
 * @param {number} [options.count] - Number of roles to request (default 5). (Prompt currently fixed to 5.)
 * @returns {Promise<{ roles: Array, rawText: string, prompt: string, modelId: string }>}
 */
async function generateTargetedRoles(userPersona, options = {}) {
  const modelId = options.modelId || process.env.BEDROCK_ROLE_MODEL_ID || DEFAULT_MODEL_ID;

  const prompt = _buildStrictJsonPrompt(userPersona);

  // Claude 3 on Bedrock "messages" API style body.
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 900,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }]
      }
    ]
  };

  const client = _getBedrockClient();

  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(body))
  });

  const resp = await client.send(cmd);

  const jsonStr = Buffer.from(resp.body).toString('utf-8');
  let bedrockJson;
  try {
    bedrockJson = JSON.parse(jsonStr);
  } catch (e) {
    const err = new Error(`Bedrock response was not JSON: ${e?.message || String(e)}`);
    err.code = 'bedrock_response_not_json';
    err.details = { jsonStr: jsonStr.slice(0, 5000) };
    throw err;
  }

  const rawText = _extractClaudeText(bedrockJson);
  const extracted = _extractFirstJsonArray(rawText);

  if (!extracted) {
    const err = new Error('Could not extract a JSON array from Bedrock model output.');
    err.code = 'bedrock_no_json_array';
    err.details = { rawText: rawText.slice(0, 5000) };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(extracted);
  } catch (e) {
    const err = new Error(`Extracted content was not valid JSON: ${e?.message || String(e)}`);
    err.code = 'bedrock_invalid_extracted_json';
    err.details = { extracted: extracted.slice(0, 5000) };
    throw err;
  }

  const roles = _validateAndNormalizeGeneratedRoles(parsed);

  // We asked for exactly 5; if the model returned fewer valid entries, surface a clear error.
  if (roles.length < 5) {
    const err = new Error(`Bedrock returned ${roles.length} valid roles; expected 5.`);
    err.code = 'bedrock_insufficient_roles';
    err.details = {
      validCount: roles.length,
      rawText: rawText.slice(0, 5000),
      parsedPreview: Array.isArray(parsed) ? parsed.slice(0, 5) : parsed
    };
    throw err;
  }

  return { roles: roles.slice(0, 5), rawText, prompt, modelId };
}

/**
 * PUBLIC_INTERFACE
 * Safe wrapper around Bedrock role generation.
 *
 * If Bedrock invocation fails (e.g., throughput / throttling), this returns:
 * - bedrockJsonRoles: the raw fallback roles in the *Bedrock JSON shape*
 * - roles: the normalized API roles shape used by /api/roles/search
 * - usedFallback: true
 *
 * This is intentionally used by the route layer so the UI never breaks.
 *
 * @param {object} userPersona
 * @param {object} [options]
 * @returns {Promise<{roles:Array, bedrockJsonRoles:Array, usedFallback:boolean, modelId:string, prompt:string, error?:object}>}
 */
async function generateTargetedRolesSafe(userPersona, options = {}) {
  try {
    const result = await generateTargetedRoles(userPersona, options);
    return {
      roles: result.roles,
      bedrockJsonRoles: null,
      usedFallback: false,
      modelId: result.modelId,
      prompt: result.prompt
    };
  } catch (err) {
    const fallbackBedrockJsonRoles = _fallbackBedrockJsonRoles();
    const normalized = _validateAndNormalizeGeneratedRoles(fallbackBedrockJsonRoles);

    return {
      roles: normalized.slice(0, 5),
      bedrockJsonRoles: fallbackBedrockJsonRoles,
      usedFallback: true,
      modelId: options.modelId || process.env.BEDROCK_ROLE_MODEL_ID || DEFAULT_MODEL_ID,
      prompt: _buildStrictJsonPrompt(userPersona),
      error: { code: err?.code || 'BEDROCK_FAILED', message: err?.message || String(err) }
    };
  }
}

module.exports = {
  generateTargetedRoles,
  generateTargetedRolesSafe
};
