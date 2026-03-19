import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getZod } from '../utils/zod.js';

/**
 * Direct Trajectory Recommendations Service
 *
 * Generates "direct next-step" role recommendations for the Explore > Direct Trajectory flow
 * using AWS Bedrock (Anthropic Claude).
 *
 * Important:
 * - Output must be STRICT JSON to avoid UI parsing failures.
 * - This service loads the latest finalized persona JSON by personaId (via holisticPersonaRepo in the route layer).
 * - Env is already configured (per user); we only READ env vars here.
 */

const DEFAULT_MODEL_ID = 'anthropic.claude-3-5-sonnet-20240620-v1:0';

function _resolveModelId() {
  return (
    (process.env.BEDROCK_DIRECT_TRAJECTORY_MODEL_ID || '').trim() ||
    (process.env.BEDROCK_RECOMMENDATIONS_MODEL_ID || '').trim() ||
    (process.env.BEDROCK_ROLE_MODEL_ID || '').trim() ||
    (process.env.BEDROCK_MODEL_ID || '').trim() ||
    DEFAULT_MODEL_ID
  );
}

function _getBedrockClient() {
  const region =
    process.env.BEDROCK_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.AMAZON_REGION ||
    process.env.AWS_SDK_REGION;

  if (!region) {
    const err = new Error(
      'Missing AWS region for BedrockRuntimeClient. Set BEDROCK_REGION, AWS_REGION, or AWS_DEFAULT_REGION.'
    );
    err.code = 'missing_aws_region';
    err.details = {
      tried: ['BEDROCK_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AMAZON_REGION', 'AWS_SDK_REGION'],
    };
    throw err;
  }

  const maxAttemptsRaw = Number(process.env.BEDROCK_MAX_ATTEMPTS || 2);
  const maxAttempts =
    Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0 ? Math.max(1, Math.min(5, maxAttemptsRaw)) : 2;

  return new BedrockRuntimeClient({ region, maxAttempts });
}

function _extractClaudeText(bedrockJson) {
  const content = bedrockJson?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    if (texts.length > 0) return texts.join('\n').trim();
  }
  if (typeof bedrockJson?.outputText === 'string') return bedrockJson.outputText.trim();
  return '';
}

function _stripWrappers(text) {
  if (!text) return '';
  let trimmed = String(text).trim();

  // Remove markdown fenced blocks if present
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) trimmed = fenced[1].trim();

  // Remove common Claude "xml-ish" tags
  trimmed = trimmed.replace(/<\/?(thinking|analysis|answer|final|output|response)\b[^>]*>/gi, '').trim();

  return trimmed;
}

function _extractFirstJsonObject(text) {
  if (!text) return null;
  const trimmed = _stripWrappers(text);

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  // Balanced scan for first top-level JSON object, respecting strings
  const starts = [];
  for (let i = 0; i < trimmed.length; i += 1) if (trimmed[i] === '{') starts.push(i);
  if (starts.length === 0) return null;

  const extractFrom = (start) => {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;

      if (depth === 0 && i > start) {
        const candidate = trimmed.slice(start, i + 1).trim();
        if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
        return null;
      }
    }
    return null;
  };

  for (const s of starts) {
    const c = extractFrom(s);
    if (c) return c;
  }
  return null;
}

function _slugifyId(title, idx) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return base ? `direct-${base}` : `direct-${idx + 1}`;
}

function _asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
}

function _clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.round(x)));
}

async function _getSchemas() {
  const { z } = await getZod();

  const DirectRoleRecommendationSchema = z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      rationale: z.string().min(1),
      whyDirectNow: z.array(z.string().min(1)).min(1),
      requiredSkills: z.array(z.string().min(1)).min(1),
      keyResponsibilities: z.array(z.string().min(1)).min(1),
      confidence: z.number().int().min(0).max(100),
    })
    .strict();

  const DirectTrajectoryResponseSchema = z
    .object({
      currentRoleTitle: z.string().min(1),
      recommendedDirectRoles: z.array(DirectRoleRecommendationSchema).length(5),
    })
    .strict();

  return { z, DirectTrajectoryResponseSchema };
}

function _buildPrompt({ finalizedPersonaJson, savedTargetRoleTitle }) {
  const persona = JSON.stringify(finalizedPersonaJson ?? {}, null, 2);
  const saved = String(savedTargetRoleTitle ?? '').trim();

  return [
    'You are an expert career mobility strategist.',
    '',
    'TASK',
    'Given a FINALIZED professional persona JSON, recommend direct next-step target roles.',
    'Direct roles are roles the person can realistically reach next with minimal-to-moderate upskilling (not a far pivot).',
    '',
    'IMPORTANT UX CONTEXT',
    '- The UI must be recommendation-driven only (the user does NOT type or search roles).',
    '- The UI shows a short list of direct-role recommendations derived from the finalized persona.',
    '- The user will select ONE recommended role and click \'Save target role\'.',
    '- After saving, the UI generates/displays a roadmap (gap analysis, requirements, pathway/mindmap).',
    '',
    'OUTPUT FORMAT (STRICT)',
    'Return ONLY valid JSON. No markdown, no extra commentary.',
    'The JSON must match this TypeScript shape:',
    '{',
    '  "currentRoleTitle": string,',
    '  "recommendedDirectRoles": DirectRoleRecommendation[]',
    '}',
    '',
    'CONSTRAINTS',
    '- Return EXACTLY 5 recommendedDirectRoles.',
    '- Each role must be a realistic direct move from the inferred current role/title in the persona.',
    '- Keep titles industry-standard (avoid overly custom titles).',
    '- Provide a stable id string per role (slug-like is OK).',
    '- Confidence is an integer 0-100.',
    '- Rationale must mention 1) which persona strengths map, 2) what is missing, 3) why this is direct (not a pivot).',
    '- whyDirectNow bullets must be concrete (e.g., \'Already has X; only needs Y\').',
    '- requiredSkills should be a curated list (not exhaustive).',
    '- keyResponsibilities should be typical for the role (not company-specific).',
    '',
    saved
      ? `SAVED TARGET ROLE CONTEXT\nThe user previously saved this target role title: "${saved}".\nIf it is a direct role, ensure it appears in the 5 and explain why. If it is not direct, do NOT include it; instead, choose better direct roles.`
      : '',
    '',
    'FINALIZED PERSONA JSON (AUTHORITATIVE)',
    persona,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * PUBLIC_INTERFACE
 * Generate direct-role recommendations via Bedrock/Claude.
 *
 * @param {object} params
 * @param {any} params.finalizedPersonaJson - finalized persona JSON (authoritative input)
 * @param {string|null|undefined} params.savedTargetRoleTitle - optional previously saved target role title
 * @returns {Promise<{ currentRoleTitle: string, recommendedDirectRoles: Array<object>, meta: object }>}
 */
export async function generateDirectTrajectoryRecommendations(params) {
  const modelId = _resolveModelId();
  const prompt = _buildPrompt({
    finalizedPersonaJson: params?.finalizedPersonaJson ?? {},
    savedTargetRoleTitle: params?.savedTargetRoleTitle ?? null,
  });

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1200,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    ],
  };

  const client = _getBedrockClient();
  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(body)),
  });

  const resp = await client.send(cmd);

  const jsonStr = Buffer.from(resp.body).toString('utf-8');
  let bedrockJson;
  try {
    bedrockJson = JSON.parse(jsonStr);
  } catch (e) {
    const err = new Error(`Bedrock response was not JSON: ${e?.message || String(e)}`);
    err.code = 'bedrock_response_not_json';
    err.details = { jsonStr: jsonStr.slice(0, 5000), modelId };
    throw err;
  }

  const rawText = _extractClaudeText(bedrockJson);
  const objText = _extractFirstJsonObject(rawText);

  if (!objText) {
    const err = new Error('Could not extract JSON object from Bedrock output (direct trajectory).');
    err.code = 'bedrock_no_json_object';
    err.details = { rawText: rawText.slice(0, 5000), modelId };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(objText);
  } catch (e) {
    const err = new Error(`Invalid JSON extracted from Bedrock output (direct trajectory): ${e?.message || String(e)}`);
    err.code = 'bedrock_invalid_extracted_json';
    err.details = { extracted: objText.slice(0, 5000), modelId };
    throw err;
  }

  // Normalize to strict schema even if Claude is slightly off.
  const currentRoleTitle = String(parsed?.currentRoleTitle ?? '').trim() || 'Current role';

  const rawRoles = Array.isArray(parsed?.recommendedDirectRoles) ? parsed.recommendedDirectRoles : [];
  const normalizedRoles = rawRoles.slice(0, 5).map((r, idx) => {
    const title = String(r?.title ?? '').trim() || `Role ${idx + 1}`;
    const id = String(r?.id ?? '').trim() || _slugifyId(title, idx);

    return {
      id,
      title,
      rationale: String(r?.rationale ?? '').trim() || 'Recommended as a direct next step based on your persona strengths.',
      whyDirectNow: _asStringArray(r?.whyDirectNow).slice(0, 6),
      requiredSkills: _asStringArray(r?.requiredSkills).slice(0, 10),
      keyResponsibilities: _asStringArray(r?.keyResponsibilities).slice(0, 6),
      confidence: _clampInt(r?.confidence, 0, 100),
    };
  });

  // Pad defensively if Claude returned fewer than 5 (rare but possible).
  while (normalizedRoles.length < 5) {
    const idx = normalizedRoles.length;
    normalizedRoles.push({
      id: `direct-placeholder-${idx + 1}`,
      title: `Direct Role ${idx + 1}`,
      rationale: 'Generated as a fallback because the model returned fewer than 5 roles.',
      whyDirectNow: ['Strong overlap with existing strengths; minimal upskilling required.'],
      requiredSkills: [],
      keyResponsibilities: [],
      confidence: 40,
    });
  }

  const response = { currentRoleTitle, recommendedDirectRoles: normalizedRoles.slice(0, 5) };

  // Validate with Zod for a stable contract.
  const { DirectTrajectoryResponseSchema } = await _getSchemas();
  const check = DirectTrajectoryResponseSchema.safeParse(response);
  if (!check.success) {
    const err = new Error('Direct trajectory recommendations failed schema validation.');
    err.code = 'direct_trajectory_schema_invalid';
    err.httpStatus = 502;
    err.details = check.error.flatten();
    throw err;
  }

  return {
    ...check.data,
    meta: {
      modelId,
      bedrockUsedFallback: false,
    },
  };
}

export default { generateDirectTrajectoryRecommendations };
