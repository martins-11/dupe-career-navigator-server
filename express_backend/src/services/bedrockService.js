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
 *   IMPORTANT: For provisioned throughput / throughput errors, prefer an INFERENCE PROFILE ID/ARN
 *   for your region instead of the base model id.
 *
 * Notes:
 * - This service is designed to return STRICT JSON only.
 * - We defensively parse and validate returned content because LLMs can still hallucinate wrappers.
 */

/**
 * Default model id (per user_input_ref):
 * - Prefer Claude 3.5 Sonnet base model id.
 * - Can be overridden via BEDROCK_ROLE_MODEL_ID to use a region-specific inference profile ARN/ID
 *   (e.g., a regional Claude 3 Haiku ARN) depending on Bedrock account/region configuration.
 */
const DEFAULT_MODEL_ID = 'anthropic.claude-3-5-sonnet-20240620-v1:0';

/**
 * Resolve a Bedrock model id in priority order.
 * This allows recommendations to use the same configured model id as persona generation
 * (BEDROCK_MODEL_ID) when a dedicated recommendations model id is not provided.
 */
function _resolveModelId({ override = null, envKeys = [] } = {}) {
  if (override && String(override).trim()) return String(override).trim();
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && String(val).trim()) return String(val).trim();
  }
  return DEFAULT_MODEL_ID;
}

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

  /**
   * Robust scan for the first *top-level* balanced JSON array.
   *
   * Key hardening:
   * - Ignore brackets that appear inside JSON strings (e.g., "notes": "foo ] bar").
   * - Handle escaped quotes inside strings.
   *
   * Additional hardening:
   * - Scan from every '[' occurrence, not just the first. Claude may emit other bracket-like
   *   content earlier (or a non-JSON bracket) before the real JSON array.
   */
  const candidates = [];
  for (let idx = 0; idx < trimmed.length; idx += 1) {
    if (trimmed[idx] === '[') candidates.push(idx);
  }
  if (candidates.length === 0) return null;

  const tryFrom = (start) => {
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
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '[') depth += 1;
      if (ch === ']') depth -= 1;

      if (depth === 0 && i >= start) {
        const candidate = trimmed.slice(start, i + 1).trim();
        if (candidate.startsWith('[') && candidate.endsWith(']')) return candidate;
        return null;
      }
    }

    return null;
  };

  for (const start of candidates) {
    const candidate = tryFrom(start);
    if (candidate) return candidate;
  }

  return null;
}

/**
 * Attempt to normalize Bedrock output into a JSON array.
 *
 * Supports common model behaviors:
 * - Raw JSON array
 * - JSON object wrapper containing a "roles" array
 * - JSON array wrapped in ```json fences
 * - Text with leading/trailing commentary (via _extractFirstJsonArray)
 */
function _extractJsonArrayFromText(text) {
  if (!text) return { array: null, extractedText: null, parseError: null };

  let trimmed = text.trim();

  // Strip markdown code fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    trimmed = fenced[1].trim();
  }

  /**
   * Strip common Claude "XML-ish" wrappers (Bedrock/Anthropic sometimes emits these even when asked not to).
   * We keep this conservative: remove only known tags, leaving inner content intact.
   */
  trimmed = trimmed
    .replace(/<\/?(thinking|analysis|answer|final|output|response)\b[^>]*>/gi, '')
    .trim();

  // Try parsing the whole payload as JSON.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return { array: parsed, extractedText: JSON.stringify(parsed), parseError: null };
    }

    // Accept common wrapper keys (models sometimes return { roles: [...] } etc).
    if (parsed && typeof parsed === 'object') {
      const wrapperKeys = ['roles', 'recommendations', 'items', 'data', 'results', 'output'];
      for (const k of wrapperKeys) {
        if (Array.isArray(parsed[k])) {
          return {
            array: parsed[k],
            extractedText: JSON.stringify(parsed[k]),
            parseError: null
          };
        }
      }
    }
  } catch (_) {
    // Ignore and fall back to array extraction.
  }

  const extractedText = _extractFirstJsonArray(trimmed);
  if (!extractedText) return { array: null, extractedText: null, parseError: null };

  try {
    const parsed = JSON.parse(extractedText);
    if (Array.isArray(parsed)) {
      return { array: parsed, extractedText, parseError: null };
    }
  } catch (err) {
    return { array: null, extractedText, parseError: err };
  }

  return { array: null, extractedText, parseError: null };
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

  /**
   * Normalize into a stable API shape used by /api/roles/search.
   *
   * Day 3 required per user_input_ref:
   * - description: 2-sentence summary
   * - key_responsibilities: exactly 3 tasks
   * - experience_range: realistic string (e.g., "3-5 years")
   * - salary_range: localized, realistic market data (based on persona industry if possible)
   * - required_skills: 5-8 skills (mix of technical + soft)
   */
  const out = [];
  const seen = new Set();

  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue;

    const title = _normStr(r.title);
    const industry = _normStr(r.industry);
    const salaryRange = _normStr(r.salary_range);
    const experienceRange = _normStr(r.experience_range);
    const description = _normStr(r.description);
    const keyResponsibilities = _asStringArray(r.key_responsibilities);
    const requiredSkills = _asStringArray(r.required_skills);

    // Minimum validation to keep UI stable; we allow some fields to be empty but try hard to enforce Day 3.
    if (!title || !industry || !salaryRange) continue;
    if (requiredSkills.length < 5 || requiredSkills.length > 10) continue;

    // Enforce "exactly 3" responsibilities if present; if not, allow empty but keep field.
    const responsibilities =
      keyResponsibilities.length >= 3 ? keyResponsibilities.slice(0, 3) : keyResponsibilities;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      role_id: `bedrock-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')}`,
      role_title: title,
      industry,
      // new Day 3 fields (used by Explore RoleCard mapping)
      description,
      key_responsibilities: responsibilities,
      experience_range: experienceRange,
      required_skills: requiredSkills,
      // backward-compatible fields
      skills_required: requiredSkills,
      salary_range: salaryRange,
      match_metadata: { source: 'bedrock' },
      is_targetable: true
    });
  }

  return out;
}

function _extractPersonaProficiencies(finalizedPersona) {
  // Supports common shapes for "FinalizedPersona skills + proficiencies".
  const p = finalizedPersona && typeof finalizedPersona === 'object' ? finalizedPersona : {};
  const candidates = [p.skills_with_proficiency, p.skillsWithProficiency, p.user_skills, p.userSkills, p.skills, p.proficiencies];

  const out = [];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    for (const row of c) {
      if (!row || typeof row !== 'object') continue;
      const name = _normStr(row.name || row.skill || row.skill_name || row.label);
      const prof =
        row.proficiency ??
        row.proficiencyPercent ??
        row.proficiency_percent ??
        row.percent ??
        row.score;
      const n = Number(prof);
      if (!name || !Number.isFinite(n)) continue;
      out.push({ name, proficiency: Math.max(0, Math.min(100, Math.round(n))) });
    }
    if (out.length) break;
  }

  return out;
}

/**
 * Build a strict-JSON prompt per Day 3 acceptance criteria.
 * - "Global Recruitment Expert" system behavior
 * - inject FinalizedPersona (skills + proficiencies) for better targeting
 * - request new schema fields for the Explore UI
 */
function _buildStrictJsonPrompt(userPersona) {
  const personaObj =
    userPersona?.persona && typeof userPersona.persona === 'object' ? userPersona.persona : null;
  const requestType = _normStr(userPersona?.requestType) || 'searched';
  const query = _normStr(userPersona?.query);

  const skills = Array.isArray(userPersona?.skills)
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

  const skillsList = _asStringArray(skills).slice(0, 30);
  const skillsInline = skillsList.length > 0 ? skillsList.join(', ') : 'N/A';

  const profs = _extractPersonaProficiencies(personaObj);
  const profInline =
    profs.length > 0
      ? profs
          .slice(0, 18)
          .map((s) => `${s.name}:${s.proficiency}%`)
          .join(', ')
      : 'N/A';

  const personaIndustry =
    _normStr(personaObj?.industry || personaObj?.profile?.industry || userPersona?.industry || '') ||
    'N/A';

  return [
    'You are a Global Recruitment Expert with deep knowledge of current market roles, skills, and compensation.',
    '',
    'REQUEST TYPE (important for variety):',
    `- requestType: ${requestType} (suggested = no query; searched = query-driven)`,
    `- query (may be empty): ${query || 'N/A'}`,
    '',
    'CONTEXT (FinalizedPersona):',
    `- Persona industry: ${personaIndustry}`,
    `- User skills (names): [${skillsInline}]`,
    `- User proficiencies (name:percent): [${profInline}]`,
    '',
    'TASK:',
    requestType === 'suggested'
      ? 'Generate EXACTLY 5 realistic job roles that fit this persona and are common in the current market. Do NOT assume any specific query intent.'
      : 'Generate EXACTLY 5 realistic job roles that match BOTH the persona and the search query intent.',
    '',
    'OUTPUT FORMAT:',
    'Return ONLY a valid JSON array (no markdown, no backticks, no commentary).',
    'Do NOT wrap the array in an object (no {"roles": ...}).',
    'Each element MUST be an object with EXACTLY these keys:',
    '- "title": string',
    '- "industry": string',
    '- "description": string (exactly 2 sentences)',
    '- "key_responsibilities": array of strings (EXACTLY 3 items; high-impact tasks)',
    '- "experience_range": string (e.g., "3-5 years")',
    '- "salary_range": string (REALISTIC for India; use ₹ and LPA, e.g., "₹18–₹30 LPA")',
    '- "required_skills": array of strings (5-8 items; mix technical + soft skills; concrete)',
    '',
    'QUALITY RULES:',
    '- Avoid generic filler. Use role-accurate responsibilities and skills.',
    '- Ensure required_skills contain skills that can be compared against the user skill list.',
    '- Keep outputs consistent and market-realistic.',
    '- Ensure the set of roles differs between suggested and searched mode when query is non-empty.'
  ].join('\n');
}

function _getBedrockClient() {
  /**
   * Bedrock client configuration.
   *
   * Credentials:
   * - Resolved by AWS SDK v3 default provider chain (env vars, shared config, SSO, instance/role, etc.)
   *
   * Region:
   * - In some preview environments, AWS credentials are present but AWS_REGION is not injected into
   *   the Node process. Support multiple standard env var names and an explicit BEDROCK_REGION override.
   */
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
      tried: ['BEDROCK_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AMAZON_REGION', 'AWS_SDK_REGION']
    };
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
      description:
        'Builds customer-facing web products across frontend and backend systems. Owns features end-to-end with an emphasis on reliability and iteration speed.',
      key_responsibilities: [
        'Deliver full-stack features from design to production',
        'Design and integrate APIs and data models',
        'Improve performance, testing, and developer tooling'
      ],
      experience_range: '3-5 years',
      salary_range: '₹99.6–₹141.1 LPA',
      required_skills: ['JavaScript', 'React', 'Node.js', 'REST APIs', 'SQL', 'Git', 'Communication']
    },
    {
      title: 'Backend Engineer (Node.js)',
      industry: 'Technology',
      description:
        'Designs and operates scalable backend services and APIs used by multiple product surfaces. Focuses on performance, reliability, and observability in production.',
      key_responsibilities: [
        'Build and maintain high-throughput APIs',
        'Optimize database queries and service performance',
        'Implement monitoring, logging, and on-call readiness'
      ],
      experience_range: '3-6 years',
      salary_range: '₹107.9–₹153.6 LPA',
      required_skills: [
        'Node.js',
        'Express',
        'SQL',
        'API Design',
        'Performance Tuning',
        'Observability',
        'Collaboration'
      ]
    },
    {
      title: 'Data Analyst',
      industry: 'Technology',
      description:
        'Turns raw business data into actionable insights for product and operations teams. Partners with stakeholders to define metrics, dashboards, and decision frameworks.',
      key_responsibilities: [
        'Define metrics and build dashboards for stakeholders',
        'Analyze trends and root causes using SQL',
        'Communicate insights and recommendations clearly'
      ],
      experience_range: '2-4 years',
      salary_range: '₹66.4–₹99.6 LPA',
      required_skills: [
        'SQL',
        'Excel',
        'Data Visualization',
        'Statistics',
        'Dashboards',
        'Stakeholder Management'
      ]
    },
    {
      title: 'Product Manager (Technical)',
      industry: 'Technology',
      description:
        'Leads product strategy and execution for technical initiatives that require close engineering partnership. Translates customer needs into prioritized roadmaps and measurable outcomes.',
      key_responsibilities: [
        'Own roadmap and prioritize tradeoffs',
        'Write clear requirements and align stakeholders',
        'Measure impact via experimentation and analytics'
      ],
      experience_range: '4-7 years',
      salary_range: '₹107.9–₹174.3 LPA',
      required_skills: [
        'Roadmapping',
        'Prioritization',
        'User Research',
        'Analytics',
        'Communication',
        'Stakeholder Management'
      ]
    },
    {
      title: 'DevOps Engineer',
      industry: 'Technology',
      description:
        'Builds and maintains the infrastructure and deployment pipelines that keep services running reliably. Improves security posture, release velocity, and incident response tooling.',
      key_responsibilities: [
        'Build CI/CD pipelines and deployment automation',
        'Manage cloud infrastructure and incident response',
        'Implement monitoring, security, and reliability best practices'
      ],
      experience_range: '3-6 years',
      salary_range: '₹107.9–₹170.2 LPA',
      required_skills: [
        'AWS',
        'Docker',
        'Kubernetes',
        'CI/CD',
        'Monitoring',
        'Infrastructure as Code',
        'Incident Management'
      ]
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
  const modelId = _resolveModelId({
    override: options.modelId,
    envKeys: ['BEDROCK_ROLE_MODEL_ID', 'BEDROCK_MODEL_ID']
  });

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
  const extracted = _extractJsonArrayFromText(rawText);

  if (!extracted.array) {
    const err = new Error('Could not extract a JSON array from Bedrock model output.');
    err.code = 'bedrock_no_json_array';
    err.details = {
      rawText: rawText.slice(0, 5000),
      extractedText: extracted.extractedText ? extracted.extractedText.slice(0, 5000) : null
    };
    throw err;
  }

  if (extracted.parseError) {
    const err = new Error(
      `Extracted content was not valid JSON: ${extracted.parseError?.message || String(extracted.parseError)}`
    );
    err.code = 'bedrock_invalid_extracted_json';
    err.details = { extracted: extracted.extractedText ? extracted.extractedText.slice(0, 5000) : null };
    throw err;
  }

  const roles = _validateAndNormalizeGeneratedRoles(extracted.array);

  // We asked for exactly 5; if the model returned fewer valid entries, surface a clear error.
  if (roles.length < 5) {
    const err = new Error(`Bedrock returned ${roles.length} valid roles; expected 5.`);
    err.code = 'bedrock_insufficient_roles';
    err.details = {
      validCount: roles.length,
      rawText: rawText.slice(0, 5000),
      extractedArrayPreview: Array.isArray(extracted.array) ? extracted.array.slice(0, 5) : null
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

    // Extra hardening: even if Bedrock succeeded, ensure we always return 5 roles.
    // If not, degrade gracefully to the logic-based fallback instead of letting callers 500.
    if (!Array.isArray(result.roles) || result.roles.length < 5) {
      const fallbackBedrockJsonRoles = _fallbackBedrockJsonRoles();
      const normalized = _validateAndNormalizeGeneratedRoles(fallbackBedrockJsonRoles);

      return {
        roles: normalized.slice(0, 5),
        bedrockJsonRoles: fallbackBedrockJsonRoles,
        usedFallback: true,
        modelId: result.modelId,
        prompt: result.prompt,
        error: {
          code: 'BEDROCK_INSUFFICIENT_ROLES',
          message: `Bedrock returned ${Array.isArray(result.roles) ? result.roles.length : 0} roles; falling back to deterministic roles.`
        }
      };
    }

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

    const errorCode = err?.code || err?.name || 'BEDROCK_FAILED';

    return {
      roles: normalized.slice(0, 5),
      bedrockJsonRoles: fallbackBedrockJsonRoles,
      usedFallback: true,
      modelId: _resolveModelId({
        override: options.modelId,
        envKeys: ['BEDROCK_ROLE_MODEL_ID', 'BEDROCK_MODEL_ID']
      }),
      prompt: _buildStrictJsonPrompt(userPersona),
      error: { code: errorCode, message: err?.message || String(err) }
    };
  }
}

/**
 * Convert a salary range string into a UI-friendly "₹xx–₹yy LPA" string when possible.
 * If it is already an INR/LPA string, return as-is.
 */
function _normalizeToIndiaLpaRange(salaryRange) {
  const s = _normStr(salaryRange);
  if (!s) return '';

  // If already INR/LPA-ish, keep it.
  if (/(₹|inr|lpa|lakhs)/i.test(s)) return s;

  // Common "$130k-$210k" style: approximate conversion to LPA.
  // NOTE: This is best-effort; prompt asks Bedrock to output INR LPA directly.
  const tokens = s.toLowerCase().match(/(\d+(\.\d+)?)(\s*[kmb])?/g) || [];
  const vals = tokens
    .map((t) => {
      const m = String(t)
        .trim()
        .match(/^(\d+(\.\d+)?)(\s*[kmb])?$/);
      if (!m) return null;
      const num = Number(m[1]);
      if (!Number.isFinite(num)) return null;
      const suffix = (m[3] || '').trim();
      const mult = suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : suffix === 'b' ? 1000000000 : 1;
      return num * mult;
    })
    .filter((v) => Number.isFinite(v));

  if (vals.length === 0) return s;

  // USD -> INR -> LPA (very rough).
  const usdToInrRaw = Number(process.env.USD_TO_INR || 83);
  const usdToInr = Number.isFinite(usdToInrRaw) && usdToInrRaw > 0 ? usdToInrRaw : 83;

  const toLpa = (usd) => Math.max(1, Math.round(((usd * usdToInr) / 100000) * 10) / 10); // 1 decimal
  const min = toLpa(Math.min(...vals));
  const max = toLpa(Math.max(...vals));
  return `₹${min}–₹${max} LPA`;
}

function _validateAndNormalizeInitialRecommendations(parsed, { debug = false } = {}) {
  if (!Array.isArray(parsed)) {
    const err = new Error('Bedrock initial recommendations did not return a JSON array.');
    err.code = 'bedrock_invalid_json_shape';
    throw err;
  }

  /**
   * IMPORTANT:
   * The initial recommendations pipeline historically had two possible upstream shapes:
   * 1) "Bedrock prompt schema" (preferred):
   *    { title, industry, salary_lpa_range, experience_range, description, key_responsibilities, required_skills }
   * 2) "API role card schema" (observed in the attached authoritative failing response):
   *    { role_id, role_title, industry, salary_lpa_range, experience_range, description, key_responsibilities, required_skills }
   *
   * This validator must accept BOTH. Otherwise Bedrock may succeed but we incorrectly drop
   * everything to 0 valid roles and trigger `bedrock_insufficient_roles`.
   */

  const out = [];
  const seen = new Set();

  // Optional validation stats for debugging why items are being rejected.
  const stats = {
    inputCount: Array.isArray(parsed) ? parsed.length : 0,
    acceptedCount: 0,
    duplicateTitleCount: 0,
    rejectedCount: 0,
    // reason -> count
    rejectedReasons: {},
    // include first few rejects to make debugging fast (env-gated)
    rejectedSamples: []
  };

  const reject = (reason, sample) => {
    stats.rejectedCount += 1;
    stats.rejectedReasons[reason] = (stats.rejectedReasons[reason] || 0) + 1;
    if (debug && stats.rejectedSamples.length < 5 && sample) {
      stats.rejectedSamples.push({ reason, sample });
    }
  };

  for (const r of parsed) {
    if (!r || typeof r !== 'object') {
      reject('not_object', r);
      continue;
    }

    const title = _normStr(r.title || r.role_title || r.roleTitle || r.role_title || r.name);
    const industry = _normStr(r.industry);

    // Salary can arrive as salary_lpa_range (preferred) or salary_range.
    const salaryRaw = _normStr(r.salary_lpa_range || r.salaryRange || r.salary_range);

    const experienceRange = _normStr(r.experience_range || r.experienceRange);
    const description = _normStr(r.description);

    const keyResponsibilities = _asStringArray(r.key_responsibilities || r.keyResponsibilities);

    // Skills can arrive as required_skills or skills_required.
    const requiredSkills = _asStringArray(
      r.required_skills || r.skills_required || r.skillsRequired || r.requiredSkills
    );

    if (!title) {
      reject('missing_title', {
        role_id: r.role_id,
        role_title: r.role_title,
        title: r.title
      });
      continue;
    }
    if (!industry) {
      reject('missing_industry', { title, industry: r.industry });
      continue;
    }

    // Enforce 5–8 skills (truncate if longer; skip if too short).
    if (requiredSkills.length < 5) {
      reject('insufficient_required_skills', { title, requiredSkillsCount: requiredSkills.length });
      continue;
    }
    const skills = requiredSkills.slice(0, 8);

    // Enforce the "exactly 3 responsibilities" rule (truncate if longer).
    const responsibilities =
      keyResponsibilities.length >= 3 ? keyResponsibilities.slice(0, 3) : keyResponsibilities;

    const key = title.toLowerCase();
    if (seen.has(key)) {
      stats.duplicateTitleCount += 1;
      reject('duplicate_title', { title });
      continue;
    }
    seen.add(key);

    const roleIdProvided = _normStr(r.role_id || r.roleId);
    const roleId =
      roleIdProvided ||
      `bedrock-rec-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')}`;

    out.push({
      role_id: roleId,
      role_title: title,
      industry,
      salary_lpa_range: _normalizeToIndiaLpaRange(salaryRaw),
      experience_range: experienceRange,
      description,
      key_responsibilities: responsibilities,
      required_skills: skills,
      match_metadata: { source: 'bedrock_initial_recommendations' }
    });
  }

  stats.acceptedCount = out.length;
  return { roles: out, stats };
}

function _buildInitialRecommendationsPrompt(finalPersona, options = {}) {
  const personaObj =
    finalPersona && typeof finalPersona === 'object'
      ? finalPersona.finalJson && typeof finalPersona.finalJson === 'object'
        ? finalPersona.finalJson
        : finalPersona
      : {};

  const profs = _extractPersonaProficiencies(personaObj);
  const profInline =
    profs.length > 0
      ? profs
          .slice(0, 24)
          .map((s) => `${s.name}:${s.proficiency}%`)
          .join(', ')
      : 'N/A';

  // Important: validated skills are often string[], but could also be objects.
  const validatedSkillsRaw =
    personaObj?.validated_skills || personaObj?.validatedSkills || personaObj?.skills || [];
  const validatedSkills = _asStringArray(
    Array.isArray(validatedSkillsRaw)
      ? validatedSkillsRaw.map((s) => (typeof s === 'string' ? s : s?.name || s?.skill || s?.skill_name || s?.label))
      : []
  ).slice(0, 30);

  const validatedInline = validatedSkills.length ? validatedSkills.join(', ') : 'N/A';

  const personaIndustry =
    _normStr(personaObj?.industry || personaObj?.profile?.industry || personaObj?.domain || '') ||
    'N/A';
  const personaHeadline =
    _normStr(
      personaObj?.profile?.headline ||
        personaObj?.current_role ||
        personaObj?.currentRole ||
        personaObj?.title ||
        personaObj?.professional_title ||
        ''
    ) || 'N/A';
  const personaSeniority =
    _normStr(
      personaObj?.seniority_level ||
        personaObj?.seniorityLevel ||
        personaObj?.seniority ||
        personaObj?.profile?.seniority ||
        ''
    ) || 'N/A';

  const onetGrounding = options?.context?.onetGrounding || null;

  // We pass both skill grounding and (best-effort) task grounding into the model prompt.
  const onetSnippet =
    onetGrounding && typeof onetGrounding === 'object'
      ? [
          'GROUNDING CONTEXT (O*NET) (use as factual grounding):',
          `- keywordUsed: ${_normStr(onetGrounding.keywordUsed) || 'N/A'}`,
          `- occupations: ${
            Array.isArray(onetGrounding.occupations)
              ? onetGrounding.occupations
                  .map((o) => `${o.title || 'Unknown'} (${o.code || 'N/A'})`)
                  .slice(0, 6)
                  .join('; ')
              : 'N/A'
          }`,
          `- groundingSkills: [${
            Array.isArray(onetGrounding.groundingSkills)
              ? onetGrounding.groundingSkills.slice(0, 30).join(', ')
              : 'N/A'
          }]`,
          `- occupationTasksSample: ${
            Array.isArray(onetGrounding.occupations)
              ? onetGrounding.occupations
                  .flatMap((o) => (Array.isArray(o.tasks) ? o.tasks : []))
                  .slice(0, 8)
                  .join(' | ')
              : 'N/A'
          }`,
          '',
          'GROUNDING RULES (IMPORTANT):',
          '- Prefer role responsibilities and required skills that are supported by O*NET groundingSkills and tasks.',
          '- Do not invent rare/niche titles that are not aligned to the occupation families above.',
          '- Keep titles market-realistic and common in India.'
        ].join('\n')
      : '';

  return [
    'You are a Market Intelligence Expert for the Indian job market.',
    'You deeply understand in-demand roles in India, realistic compensation bands in ₹ LPA, and technical responsibilities.',
    '',
    'ABSOLUTE OUTPUT RULES (JSON-ONLY; ZERO EXTRA TEXT)',
    '1) Output MUST be valid JSON (RFC 8259).',
    '2) Output MUST be a single JSON array (not an object).',
    '3) Output MUST contain NO preamble, NO explanation, NO commentary.',
    '4) Output MUST contain NO markdown and NO code fences (no ```).',
    '5) Output MUST NOT include XML/HTML-like tags such as <thinking>...</thinking>.',
    '6) Do not wrap the JSON in quotes. Do not prefix with "Here is the JSON". Do not suffix with anything.',
    '',
    'CONTEXT (FinalizedPersona):',
    `- Current role/headline: ${personaHeadline}`,
    `- Seniority: ${personaSeniority}`,
    `- Industry: ${personaIndustry}`,
    `- Validated skills: [${validatedInline}]`,
    `- Skill proficiencies (name:percent): [${profInline}]`,
    '',
    onetSnippet,
    'TASK:',
    'Return EXACTLY 5 realistic India-market job roles that best fit this persona today.',
    '',
    'OUTPUT FORMAT:',
    'Return ONLY a valid JSON array (no markdown, no backticks, no commentary).',
    'Each element MUST be an object with EXACTLY these keys:',
    '- "title": string',
    '- "industry": string',
    '- "salary_lpa_range": string (REALISTIC for India; use ₹ and LPA, e.g., "₹18–₹30 LPA")',
    '- "experience_range": string (e.g., "3–5 years")',
    '- "description": string (2–3 sentences, specific and technical)',
    '- "key_responsibilities": array of strings (EXACTLY 3 items; specific and technical)',
    '- "required_skills": array of strings (5–8 items; concrete skills that can be compared to persona skills)',
    '',
    'QUALITY RULES:',
    '- Compensation MUST be realistic for India in ₹ LPA.',
    '- Responsibilities must be specific (systems, tools, outcomes), not generic filler.',
    '- Avoid duplicates and avoid overly niche titles.',
    '- Ensure required_skills overlap with the persona validated skills when reasonable.'
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * PUBLIC_INTERFACE
 * Generate initial post-persona recommendations (exactly 5 India-market roles).
 *
 * This is used immediately after the "Finalized Persona" step to render the RecommendationGrid.
 *
 * @param {object} finalPersona - Final persona JSON (or wrapper object that contains finalJson).
 * @param {object} [options]
 * @param {string} [options.modelId] - Override Bedrock model id / inference profile id.
 * @returns {Promise<{ roles: Array, usedFallback: boolean, modelId: string, prompt: string, error?: object }>}
 */
async function getInitialRecommendations(finalPersona, options = {}) {
  // Allow a dedicated model override for initial recommendations (often configured as an inference profile ARN/ID).
  const modelId = _resolveModelId({
    override: options.modelId,
    envKeys: ['BEDROCK_RECOMMENDATIONS_MODEL_ID', 'BEDROCK_ROLE_MODEL_ID', 'BEDROCK_MODEL_ID']
  });

  const prompt = _buildInitialRecommendationsPrompt(finalPersona, { context: options?.context || null });

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1100,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }]
      }
    ]
  };

  // When false, we throw instead of returning deterministic fallback roles.
  const allowFallback = options?.allowFallback !== false;

  // ENV-gated diagnostics (do NOT enable by default in production).
  const debugRaw = String(process.env.BEDROCK_DEBUG_RAW_OUTPUT || '').toLowerCase() === 'true';

  // These will be populated only when available, and only attached to thrown errors when debugRaw=true.
  let debugRawText = null;
  let debugExtractedText = null;
  let debugExtractedArrayPreview = null;

  try {
    const client = _getBedrockClient();
    const cmd = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(JSON.stringify(body))
    });

    const resp = await client.send(cmd);
    const jsonStr = Buffer.from(resp.body).toString('utf-8');
    const bedrockJson = JSON.parse(jsonStr);

    const rawText = _extractClaudeText(bedrockJson);
    const extracted = _extractJsonArrayFromText(rawText);

    if (debugRaw) {
      debugRawText = typeof rawText === 'string' ? rawText.slice(0, 5000) : null;
      debugExtractedText = extracted?.extractedText ? extracted.extractedText.slice(0, 5000) : null;
      debugExtractedArrayPreview = Array.isArray(extracted?.array) ? extracted.array.slice(0, 5) : null;
    }

    if (!extracted.array) {
      const err = new Error('Could not extract a JSON array from Bedrock output (initial recommendations).');
      err.code = 'bedrock_no_json_array';
      err.details = {
        rawText: rawText.slice(0, 5000),
        extractedText: extracted.extractedText ? extracted.extractedText.slice(0, 5000) : null
      };

      if (debugRaw) {
        // eslint-disable-next-line no-console
        console.warn('[bedrock][initialRecommendations] JSON array extraction failed', {
          modelId,
          bedrockJsonKeys:
            bedrockJson && typeof bedrockJson === 'object' ? Object.keys(bedrockJson).slice(0, 50) : null,
          rawTextLength: typeof rawText === 'string' ? rawText.length : null,
          rawTextPreview: typeof rawText === 'string' ? rawText.slice(0, 2000) : null
        });
      }

      throw err;
    }

    if (extracted.parseError) {
      const err = new Error(
        `Extracted content was not valid JSON: ${extracted.parseError?.message || String(extracted.parseError)}`
      );
      err.code = 'bedrock_invalid_extracted_json';
      err.details = { extracted: extracted.extractedText ? extracted.extractedText.slice(0, 5000) : null };
      throw err;
    }

    const validated = _validateAndNormalizeInitialRecommendations(extracted.array, { debug: debugRaw });
    const roles = Array.isArray(validated?.roles) ? validated.roles : [];
    const validationStats = validated?.stats && typeof validated.stats === 'object' ? validated.stats : null;

    if (roles.length < 5) {
      const err = new Error(`Bedrock returned ${roles.length} valid initial recommendations; expected 5.`);
      err.code = 'bedrock_insufficient_roles';
      if (debugRaw) {
        err.details = {
          ...(err.details && typeof err.details === 'object' ? err.details : {}),
          modelId,
          rawText: debugRawText,
          extractedText: debugExtractedText,
          extractedArrayPreview: debugExtractedArrayPreview,
          validationStats,
          validatedCount: roles.length,
          extractedCount: Array.isArray(extracted.array) ? extracted.array.length : null
        };
      }
      throw err;
    }

    return { roles: roles.slice(0, 5), usedFallback: false, modelId, prompt };
  } catch (err) {
    // Attach env-gated diagnostics for upstream meta/error surfacing.
    if (debugRaw && err && typeof err === 'object') {
      err.details = {
        ...(err.details && typeof err.details === 'object' ? err.details : {}),
        modelId,
        rawText: debugRawText,
        extractedText: debugExtractedText,
        extractedArrayPreview: debugExtractedArrayPreview
      };
    }

    // Strict mode: DO NOT fallback; surface the real failure.
    if (!allowFallback) {
      throw err;
    }

    /**
     * Bedrock call failed OR output was invalid. We still return 5 roles for UI stability,
     * but we must clearly mark this as a BedrockService fallback (NOT an endpoint hardcoded fallback),
     * so route/service layers can decide whether the endpoint itself "usedFallback".
     */
    const safe = await generateTargetedRolesSafe(
      { persona: finalPersona, skills: [], user_skills: [] },
      { modelId }
    );

    const roles = (Array.isArray(safe?.roles) ? safe.roles : []).slice(0, 5).map((r) => ({
      role_id: r.role_id,
      role_title: r.role_title,
      industry: r.industry,
      salary_lpa_range: _normalizeToIndiaLpaRange(r.salary_range),
      experience_range: r.experience_range || '',
      description: r.description || '',
      key_responsibilities: Array.isArray(r.key_responsibilities) ? r.key_responsibilities.slice(0, 3) : [],
      required_skills: Array.isArray(r.required_skills)
        ? r.required_skills.slice(0, 8)
        : Array.isArray(r.skills_required)
          ? r.skills_required.slice(0, 8)
          : [],
      match_metadata: {
        source: 'bedrock_initial_recommendations',
        bedrockUsedFallback: true
      }
    }));

    // Ensure exactly 5 (pad deterministically).
    const padded = [...roles];
    while (padded.length < 5) {
      padded.push({
        role_id: `bedrock-initial-fallback-${padded.length + 1}`,
        role_title: 'Software Engineer',
        industry: 'Technology',
        salary_lpa_range: '₹12–₹22 LPA',
        experience_range: '2–4 years',
        description:
          'Builds and maintains product features across backend services and APIs. Works closely with product and QA to ship reliable releases.',
        key_responsibilities: [
          'Build and maintain APIs and backend services',
          'Write tests and improve reliability in production',
          'Collaborate with cross-functional teams to deliver features'
        ],
        required_skills: ['JavaScript', 'Node.js', 'REST APIs', 'SQL', 'Git'],
        match_metadata: {
          source: 'bedrock_initial_recommendations',
          bedrockUsedFallback: true,
          padded: true
        }
      });
    }

    const errorCode = err?.code || err?.name || 'BEDROCK_FAILED';

    return {
      roles: padded.slice(0, 5),
      usedFallback: true,
      modelId,
      prompt,
      error: {
        code: errorCode,
        message: err?.message || String(err),

        /**
         * Best-effort diagnostics to help identify common runtime/config failures:
         * - missing region
         * - invalid model id / inference profile
         * - access denied
         * - throttling / throughput exceeded
         *
         * We intentionally avoid including credentials or full request bodies.
         */
        name: err?.name || null,
        httpStatusCode: err?.$metadata?.httpStatusCode ?? null,
        requestId: err?.$metadata?.requestId ?? null,
        extendedRequestId: err?.$metadata?.extendedRequestId ?? null,
        cfId: err?.$metadata?.cfId ?? null,
        attempts: err?.$metadata?.attempts ?? null,
        totalRetryDelay: err?.$metadata?.totalRetryDelay ?? null,

        // Sometimes AWS errors include machine-readable hints:
        fault: err?.$fault ?? null,
        service: err?.$service ?? null,

        // Env-gated deep diagnostics from thrown errors (e.g., rawText/validationStats).
        details: err?.details && typeof err.details === 'object' ? err.details : null
      }
    };
  }
}

module.exports = {
  generateTargetedRoles,
  generateTargetedRolesSafe,
  getInitialRecommendations
};
