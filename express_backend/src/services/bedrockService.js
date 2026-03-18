import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

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

/**
 * Extract the best candidate JSON array for "roles" from a Bedrock/LLM text response.
 *
 * Why this exists:
 * - Claude may return an array of role objects that CONTAINS nested arrays like `key_responsibilities`.
 * - A naive "first balanced [...]" extraction can accidentally select the nested string[] instead
 *   of the top-level object[].
 *
 * Strategy:
 * - Enumerate all balanced JSON array substrings in the cleaned response.
 * - Parse each into a JS value and score it.
 * - Prefer arrays where elements are objects with role-like keys; avoid arrays of strings.
 *
 * @param {string} text
 * @returns {{ array: any[] | null, extractedText: string | null, parseError: Error | null }}
 */
function _extractRolesJsonArrayFromText(text) {
  if (!text) return { array: null, extractedText: null, parseError: null };

  let trimmed = text.trim();

  // Strip markdown code fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    trimmed = fenced[1].trim();
  }

  trimmed = trimmed
    .replace(/<\/?(thinking|analysis|answer|final|output|response)\b[^>]*>/gi, '')
    .trim();

  // If the whole payload is parseable JSON, prefer that.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { array: parsed, extractedText: JSON.stringify(parsed), parseError: null };
    if (parsed && typeof parsed === 'object') {
      for (const k of ['roles', 'recommendations', 'items', 'data', 'results', 'output']) {
        if (Array.isArray(parsed[k])) {
          return { array: parsed[k], extractedText: JSON.stringify(parsed[k]), parseError: null };
        }
      }
    }
  } catch (_) {
    // ignore; fall through
  }

  /**
   * Truncation salvage (CRITICAL HARDENING):
   * If the model output is truncated mid-object, full JSON.parse() fails and substring scanning can
   * accidentally select a nested balanced array (e.g., key_responsibilities: string[]) instead of
   * the top-level roles list (object[]).
   *
   * This attempts to recover the top-level array by:
   * - Finding the first '['
   * - Tracking string/brace/array depth
   * - Capturing the last fully completed object '}' at arrayDepth===1
   * - Synthesizing a valid JSON array by closing with ']'
   */
  const salvageTopLevelArrayIfTruncated = () => {
    /**
     * Prefer reconstructing from a ```json fenced block if present but missing closing fence.
     * This is a common truncation shape in Bedrock/Claude outputs.
     */
    const fenceStart = trimmed.search(/```(?:json)?\s*/i);
    const textForSalvage =
      fenceStart >= 0 ? trimmed.slice(fenceStart).replace(/^```(?:json)?\s*/i, '') : trimmed;

    const start = textForSalvage.indexOf('[');
    if (start < 0) return null;

    let inString = false;
    let escape = false;
    let arrayDepth = 0;
    let objectDepth = 0;

    // Index of last '}' that completed an object while inside the top-level array (arrayDepth===1).
    let lastCompletedObjectEnd = -1;

    for (let i = start; i < textForSalvage.length; i += 1) {
      const ch = textForSalvage[i];

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\\\') {
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

      if (ch === '[') arrayDepth += 1;
      if (ch === ']') arrayDepth -= 1;

      if (ch === '{') objectDepth += 1;
      if (ch === '}') {
        objectDepth -= 1;

        if (objectDepth === 0 && arrayDepth === 1) {
          lastCompletedObjectEnd = i;
        }
      }

      // Not truncated: we found a full closing ']' for the array that started at `start`.
      if (arrayDepth === 0 && i > start) return null;
    }

    // End-of-text: if we're still inside the array and we saw at least one completed object, salvage.
    if (arrayDepth >= 1 && lastCompletedObjectEnd > start) {
      const prefix = textForSalvage.slice(start, lastCompletedObjectEnd + 1).trim();
      const withoutTrailingComma = prefix.replace(/,\s*$/, '');
      const synthesized = `${withoutTrailingComma}\n]`;

      try {
        const parsed = JSON.parse(synthesized);

        // Only accept salvage if it's plausibly the top-level role object array (array-of-objects),
        // never a nested string[] like key_responsibilities.
        const isArrayOfObjects =
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every((x) => x && typeof x === 'object' && !Array.isArray(x));

        if (!isArrayOfObjects) return null;

        // Additional guard: at least one element should have role-like keys.
        const roleLikeKeys = ['title', 'role_title', 'industry', 'salary_lpa_range', 'salary_range', 'required_skills'];
        const looksRoleLike = parsed.some((o) =>
          roleLikeKeys.reduce((n, k) => (Object.prototype.hasOwnProperty.call(o, k) ? n + 1 : n), 0) >= 2
        );

        if (looksRoleLike) return { parsed, text: synthesized };
      } catch (_) {
        return null;
      }
    }

    return null;
  };

  const salvaged = salvageTopLevelArrayIfTruncated();
  if (salvaged && Array.isArray(salvaged.parsed)) {
    return { array: salvaged.parsed, extractedText: salvaged.text, parseError: null };
  }

  // Enumerate all balanced JSON arrays in the text, respecting JSON strings.
  const starts = [];
  for (let i = 0; i < trimmed.length; i += 1) if (trimmed[i] === '[') starts.push(i);
  if (starts.length === 0) return { array: null, extractedText: null, parseError: null };

  const extractBalancedArrayFrom = (start) => {
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

  const roleKeyHints = new Set([
    'title',
    'role_title',
    'roleTitle',
    'industry',
    'salary_lpa_range',
    'salary_range',
    'salaryRange',
    'experience_range',
    'experienceRange',
    'required_skills',
    'skills_required',
    'skillsRequired',
    'key_responsibilities',
    'keyResponsibilities',
    'description'
  ]);

  const scoreArrayCandidate = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return -Infinity;

    // Look at a slightly larger sample; nested arrays are often short (3–8 items).
    const sample = arr.slice(0, 10);
    let objectCount = 0;
    let stringCount = 0;
    let roleLikeObjectCount = 0;

    for (const el of sample) {
      if (typeof el === 'string') {
        stringCount += 1;
        continue;
      }
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        objectCount += 1;
        const keys = Object.keys(el);
        const hitCount = keys.reduce((n, k) => (roleKeyHints.has(k) ? n + 1 : n), 0);

        // Require at least 2 role-ish keys to be considered role-like.
        if (hitCount >= 2) roleLikeObjectCount += 1;
      }
    }

    /**
     * Prefer the top-level array-of-role-objects.
     *
     * Authoritative failure mode:
     * - Substring scanning finds *balanced* nested arrays like key_responsibilities (string[])
     * - If scoring isn't decisive enough, we can still pick the nested array
     *
     * Hardening:
     * - If the sample is mostly strings and contains no objects, treat as a nested list and
     *   massively penalize it.
     * - Strongly reward arrays where most elements look like role objects.
     */
    const sampleSize = sample.length || 1;
    const objectRatio = objectCount / sampleSize;
    const roleLikeRatio = roleLikeObjectCount / sampleSize;
    const stringRatio = stringCount / sampleSize;

    // If it's clearly a string[] (nested responsibilities/skills), avoid selecting it.
    if (objectCount === 0 && stringCount > 0) return -100000;

    let score = 0;

    // Reward role-like objects heavily.
    score += roleLikeObjectCount * 220;

    // Reward objects mildly.
    score += objectCount * 20;

    // Penalize strings heavily (nested arrays often all strings).
    score -= stringCount * 180;

    // Prefer candidates where most elements are objects/role-like.
    score += objectRatio * 120;
    score += roleLikeRatio * 220;

    // Larger arrays are more likely to be the outer role list (commonly 5).
    score += Math.min(arr.length, 50) * 1.2;

    // If the array is mostly strings, penalize further.
    score -= stringRatio * 250;

    return score;
  };

  let best = { score: -Infinity, array: null, extractedText: null, parseError: null, startIndex: null };

  for (const s of starts) {
    const candidateText = extractBalancedArrayFrom(s);
    if (!candidateText) continue;

    try {
      const parsed = JSON.parse(candidateText);
      if (!Array.isArray(parsed)) continue;

      const score = scoreArrayCandidate(parsed);

      // Tie-breaker: prefer the earliest candidate in the text (usually the outermost array).
      // Also treat "nearly equal" scores as ties to avoid jitter when JSON is truncated and only
      // partial candidates are parseable.
      const EPS = 15; // tolerate small scoring differences
      const isBetter = score > best.score + EPS;
      const isNearTie = Math.abs(score - best.score) <= EPS;

      if (isBetter || (isNearTie && (best.startIndex == null || s < best.startIndex))) {
        best = { score, array: parsed, extractedText: candidateText, parseError: null, startIndex: s };
      }
    } catch (e) {
      // keep the first parse error around in case we find nothing better
      if (!best.parseError) best.parseError = e;
    }
  }

  if (!best.array) {
    return { array: null, extractedText: null, parseError: best.parseError || null };
  }

  return { array: best.array, extractedText: best.extractedText, parseError: null };
}

function _normStr(v) {
  return String(v || '').trim();
}

function _asStringArray(v) {
  if (!Array.isArray(v)) return [];

  /**
   * LLMs sometimes return a list of objects for skills, e.g.:
   * [{name:"SQL"}, {skill:"Stakeholder Management"}]
   * Normalize those into a string[].
   */
  return v
    .map((x) => {
      if (typeof x === 'string') return _normStr(x);
      if (x && typeof x === 'object' && !Array.isArray(x)) {
        return _normStr(x.name || x.skill || x.skill_name || x.skillName || x.label || x.title || '');
      }
      return '';
    })
    .filter(Boolean);
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
  const up = userPersona && typeof userPersona === 'object' ? userPersona : {};

  /**
   * Explore Search/Autocomplete path passes `finalPersonaObj` + `scoringUserSkills` (with proficiency),
   * not `persona`. Use those as the primary context so Claude has enough signal to stay schema-compliant
   * and return 5 distinct roles.
   */
  const personaObj =
    (up.finalPersonaObj && typeof up.finalPersonaObj === 'object' && !Array.isArray(up.finalPersonaObj)
      ? up.finalPersonaObj
      : null) ||
    (up.persona && typeof up.persona === 'object' && !Array.isArray(up.persona) ? up.persona : null);

  const query = _normStr(up.query);

  /**
   * Request type:
   * - If explicitly provided, honor it.
   * - Else infer from query: empty => suggested; non-empty => searched.
   */
  const inferredRequestType = query ? 'searched' : 'suggested';
  const requestType = _normStr(up.requestType) || inferredRequestType;

  // Prefer proficiency-bearing scoring skills when available.
  const scoringSkills = Array.isArray(up.scoringUserSkills) ? up.scoringUserSkills : [];

  const scoringSkillNames = scoringSkills
    .map((s) => (s && typeof s === 'object' ? s.name || s.skill || s.skill_name || s.skillName : s))
    .map((s) => _normStr(s))
    .filter(Boolean);

  // Secondary sources: validated skills, skills, user_skills etc.
  const skills = scoringSkillNames.length
    ? scoringSkillNames
    : Array.isArray(up.skills)
      ? up.skills
      : Array.isArray(up.validated_skills)
        ? up.validated_skills
        : Array.isArray(up.validatedSkills)
          ? up.validatedSkills
          : Array.isArray(up.user_skills)
            ? up.user_skills.map((s) =>
                s && typeof s === 'object' ? s.name || s.skill || s.skill_name || s.skillName : s
              )
            : Array.isArray(up.userSkills)
              ? up.userSkills.map((s) =>
                  s && typeof s === 'object' ? s.name || s.skill || s.skill_name || s.skillName : s
                )
              : [];

  const skillsList = _asStringArray(skills).slice(0, 30);
  const skillsInline = skillsList.length > 0 ? skillsList.join(', ') : 'N/A';

  // Prefer proficiencies from scoringUserSkills; fallback to personaObj extraction.
  const scoringProfs = scoringSkills
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const name = _normStr(s.name || s.skill || s.skill_name || s.skillName || '');
      const prof = Number(s.proficiency ?? s.proficiency_percent ?? s.proficiencyPercent ?? s.percent ?? s.score);
      if (!name || !Number.isFinite(prof)) return null;
      return { name, proficiency: Math.max(0, Math.min(100, Math.round(prof))) };
    })
    .filter(Boolean);

  const profs = scoringProfs.length > 0 ? scoringProfs : _extractPersonaProficiencies(personaObj);

  const profInline =
    profs.length > 0
      ? profs
          .slice(0, 18)
          .map((s) => `${s.name}:${s.proficiency}%`)
          .join(', ')
      : 'N/A';

  const personaIndustry =
    _normStr(
      personaObj?.industry ||
        personaObj?.profile?.industry ||
        up.industry ||
        up.personaIndustry ||
        ''
    ) || 'N/A';

  const queryLine = query ? `"${query}"` : 'N/A';

  return [
    'You are a Global Recruitment Expert for the Indian job market.',
    'You know realistic job titles, responsibilities, required skills, and compensation bands in ₹ LPA.',
    '',
    'ABSOLUTE OUTPUT RULES (JSON-ONLY; ZERO EXTRA TEXT):',
    '1) Output MUST be valid JSON (RFC 8259).',
    '2) Output MUST be a single JSON array (not an object).',
    '3) Output MUST contain NO markdown, NO code fences, NO commentary, NO headings.',
    '4) Output MUST contain EXACTLY 5 elements.',
    '',
    'REQUEST TYPE:',
    `- requestType: ${requestType} (suggested = no query; searched = query-driven)`,
    `- query: ${queryLine}`,
    '',
    'CONTEXT (Final Persona / Skills):',
    `- Persona industry: ${personaIndustry}`,
    `- User skills (names): [${skillsInline}]`,
    `- User proficiencies (name:percent): [${profInline}]`,
    '',
    'TASK:',
    requestType === 'suggested'
      ? 'Generate EXACTLY 5 realistic job roles that fit this persona and are common in India today.'
      : 'Generate EXACTLY 5 realistic job roles that match BOTH the persona and the search query intent.',
    '',
    'SCHEMA (MUST MATCH EXACTLY):',
    'Return a JSON array of 5 objects. EACH object MUST have ALL of these keys (no missing keys):',
    '- "title": string (non-empty; unique across all 5 roles)',
    '- "industry": string (non-empty)',
    '- "description": string (EXACTLY 2 sentences; role-specific; no bullet lists)',
    '- "key_responsibilities": string[] (EXACTLY 3 items; each item is 8–20 words; no trailing punctuation-only)',
    '- "experience_range": string (realistic; e.g., "2-4 years" or "5-8 years")',
    '- "salary_range": string (MUST include ₹ and "LPA"; realistic; e.g., "₹18–₹30 LPA")',
    '- "required_skills": string[] (6–8 UNIQUE items; concrete skills; mix technical + soft; no duplicates)',
    '',
    'UNIQUENESS RULES (CRITICAL):',
    '- All 5 titles MUST be distinct and not minor variants (avoid {Role} vs "Senior {Role}" as separate roles).',
    '- Avoid near-duplicates/synonyms (e.g., "Backend Engineer" vs "Server-side Engineer").',
    '',
    'VALIDATION CHECKLIST (DO THIS BEFORE YOU OUTPUT):',
    '- Count check: array length is exactly 5.',
    '- Each object has ALL required keys and values are non-empty strings/arrays.',
    '- key_responsibilities length is exactly 3 for every role.',
    '- required_skills length is between 6 and 8 for every role.',
    '- salary_range contains both ₹ and LPA for every role.',
    '- Titles are unique (case-insensitive).',
    '',
    'OUTPUT:',
    'Return ONLY the JSON array.'
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

  // IMPORTANT: target role generation must select the TOP-LEVEL array of role objects.
  // A generic "first array" extractor can accidentally select nested arrays like key_responsibilities (string[]).
  const extracted = _extractRolesJsonArrayFromText(rawText);

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
  /**
   * IMPORTANT:
   * Some callers (notably autocomplete) must be "Bedrock-only" and should NOT return deterministic
   * fallback titles because that creates misleading, static UX.
   *
   * Default remains allowFallback=true to preserve existing behavior in places that prefer
   * "always return 5 roles" (e.g. demos / non-critical flows).
   */
  const allowFallback = options?.allowFallback !== false;

  try {
    const result = await generateTargetedRoles(userPersona, options);

    // If caller disallows fallback, do not pad with deterministic roles.
    if (!allowFallback) {
      return {
        roles: Array.isArray(result.roles) ? result.roles : [],
        bedrockJsonRoles: null,
        usedFallback: false,
        modelId: result.modelId,
        prompt: result.prompt
      };
    }

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
    // Strict mode: do not fallback; surface empty result to caller so route can return [].
    if (!allowFallback) {
      return {
        roles: [],
        bedrockJsonRoles: null,
        usedFallback: false,
        modelId: _resolveModelId({
          override: options.modelId,
          envKeys: ['BEDROCK_ROLE_MODEL_ID', 'BEDROCK_MODEL_ID']
        }),
        prompt: _buildStrictJsonPrompt(userPersona),
        error: { code: err?.code || err?.name || 'BEDROCK_FAILED', message: err?.message || String(err) }
      };
    }

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

    // Salary can arrive as salary_lpa_range (prompt schema / user_input_ref) OR salary_range (common model variant).
    const salaryRaw = _normStr(
      r.salary_lpa_range ||
        r.salary_range ||
        r.salaryRange ||
        r.salary_lpa ||
        r.salaryLpaRange ||
        r.salaryLpa ||
        r.salary
    );

    const experienceRange = _normStr(r.experience_range || r.experienceRange);
    const description = _normStr(r.description);

    const keyResponsibilities = _asStringArray(r.key_responsibilities || r.keyResponsibilities);

    // Skills can arrive as required_skills or skills_required (sometimes as objects, handled by _asStringArray).
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
    if (!salaryRaw) {
      reject('missing_salary', { title, salary_lpa_range: r.salary_lpa_range, salary_range: r.salary_range });
      continue;
    }

    /**
     * Skills rule:
     * - Prompt asks for 5–8, but real outputs can be 5–10.
     * - Do not reject >8; truncate to keep API stable.
     * - Still reject <5 (not enough signal for scoring/UI).
     */
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
  const rawCount = Number(options?.count);
  // Support requesting/storing >5 roles; cap at 20 to keep responses bounded.
  const count = Number.isFinite(rawCount) ? Math.max(1, Math.min(20, Math.floor(rawCount))) : 5;
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
    `Return EXACTLY ${count} realistic India-market job roles that best fit this persona today.`,
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

  const rawCount = Number(options?.count);
  // Support requesting/storing >5 roles; cap at 20 to keep responses bounded.
  const count = Number.isFinite(rawCount) ? Math.max(1, Math.min(20, Math.floor(rawCount))) : 5;

  const prompt = _buildInitialRecommendationsPrompt(finalPersona, {
    context: options?.context || null,
    count
  });

  // Scale token budget when requesting more roles (avoid truncation for >10 roles).
  const maxTokens = Math.max(700, Math.min(3200, 1100 + Math.max(0, count - 5) * 190));

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }]
      }
    ]
  };

  /**
   * When false, we throw instead of returning deterministic fallback roles.
   * IMPORTANT: This function must NEVER return undefined. In allowFallback=true mode we must
   * return a stable fallback payload.
   */
  const allowFallback = options?.allowFallback !== false;

  // Minimal retry for transient Bedrock issues (common after restarts / brief throttling).
  const retries = Number.isFinite(Number(options?.retries))
    ? Math.max(0, Math.min(2, Number(options.retries)))
    : 1;

  const retryDelayMs = Number.isFinite(Number(options?.retryDelayMs))
    ? Math.max(0, Math.min(2000, Number(options.retryDelayMs)))
    : 250;

  // ENV-gated diagnostics (do NOT enable by default in production).
  const debugRaw = String(process.env.BEDROCK_DEBUG_RAW_OUTPUT || '').toLowerCase() === 'true';

  // These will be populated only when available, and only attached to thrown errors when debugRaw=true.
  let debugRawText = null;
  let debugExtractedText = null;
  let debugExtractedArrayPreview = null;

  const invokeOnce = async () => {
    const client = _getBedrockClient();
    const cmd = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(JSON.stringify(body))
    });

    /**
     * Bedrock call timeout hardening (IMPORTANT):
     * - We MUST return before the outer Express request timeout.
     * - Use a route-provided time budget (options.timeBudgetMs) when available so we
     *   don't start/continue a Bedrock call if the HTTP request is about to time out.
     *
     * Environment/config precedence:
     * 1) options.timeBudgetMs (route-calculated remaining time)
     * 2) BEDROCK_TIMEOUT_MS (default 40000)
     *
     * Additionally cap the timeout to BEDROCK_TIMEOUT_CAP_MS (default 45000).
     *
     * NOTE:
     * Previously the cap defaulted to 12000ms which caused premature `bedrock_timeout`
     * for /api/recommendations/initial even when the endpoint is allowed to run longer.
     */
    const bedrockTimeoutMsRaw = Number(process.env.BEDROCK_TIMEOUT_MS || 40000);
    const bedrockTimeoutDefault =
      Number.isFinite(bedrockTimeoutMsRaw) && bedrockTimeoutMsRaw > 0 ? bedrockTimeoutMsRaw : 40000;

    const capRaw = Number(process.env.BEDROCK_TIMEOUT_CAP_MS || 45000);
    const bedrockTimeoutCap =
      Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 45000;

    const budgetRaw = Number(options?.timeBudgetMs);
    const timeBudgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : null;

    // Choose timeout = min(default, cap, budget) (budget only if provided).
    const candidates = [bedrockTimeoutDefault, bedrockTimeoutCap].filter((n) => Number.isFinite(n) && n > 0);
    if (timeBudgetMs != null) candidates.push(timeBudgetMs);

    const bedrockTimeoutMs = Math.max(1, Math.min(...candidates));

    // If the caller tells us we have essentially no time, fail fast rather than invoking Bedrock.
    if (timeBudgetMs != null && timeBudgetMs < 250) {
      const err = new Error(`Bedrock skipped: insufficient time budget (${timeBudgetMs}ms)`);
      err.code = 'bedrock_timeout';
      err.details = { timeBudgetMs, bedrockTimeoutMs };
      throw err;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), bedrockTimeoutMs);

    let resp;
    try {
      resp = await client.send(cmd, { abortSignal: controller.signal });
    } catch (e) {
      // Normalize abort errors into a consistent bedrock_* code so sendError maps to 502/504 appropriately.
      const isAbort =
        e?.name === 'AbortError' ||
        e?.code === 'ABORT_ERR' ||
        String(e?.message || '').toLowerCase().includes('aborted');

      if (isAbort) {
        const err = new Error(`Bedrock request timed out after ${bedrockTimeoutMs}ms`);
        err.code = 'bedrock_timeout';
        err.details = { bedrockTimeoutMs };
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    const jsonStr = Buffer.from(resp.body).toString('utf-8');
    const bedrockJson = JSON.parse(jsonStr);

    const rawText = _extractClaudeText(bedrockJson);

    // IMPORTANT:
    // Initial recommendations must select the TOP-LEVEL array of role objects.
    // A generic "first array" extractor can accidentally select nested arrays like key_responsibilities (string[]).
    const extracted = _extractRolesJsonArrayFromText(rawText);

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

    /**
     * IMPORTANT (bugfix):
     * Initial recommendations must succeed when Bedrock returns fewer than 5 *valid* roles.
     * The endpoint contract for /api/recommendations/initial is "1–5 roles", and strict mode
     * (allowFallback=false) should only throw when Bedrock fails entirely (timeout, invalid JSON, etc),
     * not when it returns 1–4 good items.
     */
    if (roles.length < 1) {
      const err = new Error('Bedrock returned 0 valid initial recommendations.');
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

    // Return up to requested count; do not error if fewer than 5 are valid.
    return { roles: roles.slice(0, count), usedFallback: false, modelId, prompt };
  };

  try {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await invokeOnce();
      } catch (err) {
        if (attempt >= retries) throw err;
        attempt += 1;
        // Small deterministic backoff.
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
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
     * Non-strict mode: return deterministic fallback roles (stable contract).
     * This avoids the prior bug where allowFallback=true caused an implicit undefined return,
     * which downstream treated as "0 roles" and surfaced as intermittent 502s.
     */
    const fallbackRoles = _fallbackBedrockJsonRoles();
    const validatedFallback = _validateAndNormalizeInitialRecommendations(fallbackRoles, { debug: false });

    return {
      roles: (validatedFallback?.roles || []).slice(0, count),
      usedFallback: true,
      modelId,
      prompt,
      error: { code: err?.code || err?.name || 'BEDROCK_FAILED', message: err?.message || String(err) }
    };
  }
}

/**
 * Build prompt to extract the user's name and CURRENT role from resume/perf-review text.
 * We require strict JSON-only output for reliable parsing.
 */
function _buildNameAndCurrentRoleExtractionPrompt({ text, hints = {} }) {
  const snippet = String(text || '').trim().slice(0, 12000); // keep prompt bounded
  const hintName = _normStr(hints?.name || '');
  const hintIndustry = _normStr(hints?.industry || '');

  return [
    'You are an expert career coach.',
    '',
    'TASK:',
    'Given the following user documents text (resume and/or performance review), identify:',
    '1) The person’s FULL NAME (first + last) if present',
    '2) The person’s CURRENT ROLE (job title) as a short title',
    '',
    'OUTPUT FORMAT (STRICT):',
    'Return ONLY valid JSON (no markdown, no commentary):',
    '{',
    '  "fullName": string | null,',
    '  "currentRoleTitle": string | null,',
    '  "confidence": "high"|"medium"|"low",',
    '  "evidence": string',
    '}',
    '',
    'RULES:',
    '- fullName MUST be the person’s name, NOT a document label (e.g., not "Performance Review").',
    '- fullName should be concise (max 80 chars). If missing/unclear, set fullName=null.',
    '- currentRoleTitle MUST be a concise job title (max 80 chars). If unknown, set currentRoleTitle=null.',
    '- evidence should quote or reference a short phrase from the text supporting the extraction.',
    '- Be conservative: if unsure, return nulls and confidence="low".',
    '',
    `HINTS (optional): name=${hintName || 'N/A'}; industry=${hintIndustry || 'N/A'}`,
    '',
    'DOCUMENT TEXT:',
    snippet,
  ].join('\n');
}

/**
 * Backward-compatible prompt builder for current-role-only extraction.
 * Kept to avoid changing behavior for callers that only need the role.
 */
function _buildCurrentRoleExtractionPrompt({ text, hints = {} }) {
  const snippet = String(text || '').trim().slice(0, 12000); // keep prompt bounded
  const hintName = _normStr(hints?.name || '');
  const hintIndustry = _normStr(hints?.industry || '');

  return [
    'You are an expert career coach.',
    '',
    'TASK:',
    'Given the following user documents text, identify the user’s CURRENT ROLE (job title) as a short title.',
    'If the role is not explicitly present, infer the most likely role based on responsibilities/skills, but keep it conservative.',
    '',
    'OUTPUT FORMAT (STRICT):',
    'Return ONLY valid JSON (no markdown, no commentary):',
    '{ "currentRoleTitle": string | null, "confidence": "high"|"medium"|"low", "evidence": string }',
    '',
    'RULES:',
    '- currentRoleTitle MUST be a concise job title (max 80 chars).',
    '- If you cannot determine the role, set currentRoleTitle=null.',
    '- evidence should quote or reference a short phrase from the text.',
    '',
    `HINTS (optional): name=${hintName || 'N/A'}; industry=${hintIndustry || 'N/A'}`,
    '',
    'DOCUMENT TEXT:',
    snippet,
  ].join('\n');
}

/**
 * Extract JSON object from model output (defensive against wrappers/fences).
 */
function _extractFirstJsonObject(text) {
  if (!text) return null;
  let trimmed = String(text).trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) trimmed = fenced[1].trim();

  trimmed = trimmed.replace(/<\/?(thinking|analysis|answer|final|output|response)\b[^>]*>/gi, '').trim();

  // Fast path
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  // Balanced scan, respecting strings
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

// PUBLIC_INTERFACE
async function extractNameAndCurrentRoleFromText({ text, hints = {}, options = {} }) {
  /**
   * Extract a user's full name and current role title from ingested documents text using Bedrock.
   *
   * IMPORTANT:
   * - This is intended to be *authoritative* when called from ingestion (uploads).
   * - It returns null values when unknown; callers decide whether/how to persist fallbacks.
   *
   * @param {{text: string, hints?: {name?: string, industry?: string}, options?: {modelId?: string}}}
   * @returns {Promise<{ fullName: string|null, currentRoleTitle: string|null, confidence: string, evidence: string, rawText: string, prompt: string, modelId: string }>}
   */
  const modelId = _resolveModelId({
    override: options?.modelId,
    envKeys: ['BEDROCK_ROLE_MODEL_ID', 'BEDROCK_MODEL_ID'],
  });

  const prompt = _buildNameAndCurrentRoleExtractionPrompt({ text, hints });

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 360,
    temperature: 0.1,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
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
  const bedrockJson = JSON.parse(jsonStr);
  const rawText = _extractClaudeText(bedrockJson);

  const objText = _extractFirstJsonObject(rawText);
  if (!objText) {
    const err = new Error('Could not extract JSON object from Bedrock output (name+role extraction).');
    err.code = 'bedrock_no_json_object';
    err.details = { rawText: rawText.slice(0, 5000) };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(objText);
  } catch (e) {
    const err = new Error(`Invalid JSON from Bedrock name+role extraction: ${e?.message || String(e)}`);
    err.code = 'bedrock_invalid_extracted_json';
    err.details = { extracted: objText.slice(0, 5000) };
    throw err;
  }

  const fullNameRaw = parsed?.fullName;
  const fullName = typeof fullNameRaw === 'string' && fullNameRaw.trim() ? fullNameRaw.trim().slice(0, 80) : null;

  const titleRaw = parsed?.currentRoleTitle;
  const currentRoleTitle =
    typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw.trim().slice(0, 80) : null;

  const confidence = _normStr(parsed?.confidence || 'low') || 'low';
  const evidence = _normStr(parsed?.evidence || '');

  return { fullName, currentRoleTitle, confidence, evidence, rawText, prompt, modelId };
}

// PUBLIC_INTERFACE
async function extractCurrentRoleFromText({ text, hints = {}, options = {} }) {
  /**
   * Extract a user's current role title from ingested documents text using Bedrock.
   *
   * @param {{text: string, hints?: {name?: string, industry?: string}, options?: {modelId?: string}}}
   * @returns {Promise<{ currentRoleTitle: string|null, confidence: string, evidence: string, rawText: string, prompt: string, modelId: string }>}
   */
  const modelId = _resolveModelId({
    override: options?.modelId,
    envKeys: ['BEDROCK_ROLE_MODEL_ID', 'BEDROCK_MODEL_ID'],
  });

  const prompt = _buildCurrentRoleExtractionPrompt({ text, hints });

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 300,
    temperature: 0.1,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
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
  const bedrockJson = JSON.parse(jsonStr);
  const rawText = _extractClaudeText(bedrockJson);

  const objText = _extractFirstJsonObject(rawText);
  if (!objText) {
    const err = new Error('Could not extract JSON object from Bedrock output (current role extraction).');
    err.code = 'bedrock_no_json_object';
    err.details = { rawText: rawText.slice(0, 5000) };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(objText);
  } catch (e) {
    const err = new Error(`Invalid JSON from Bedrock current role extraction: ${e?.message || String(e)}`);
    err.code = 'bedrock_invalid_extracted_json';
    err.details = { extracted: objText.slice(0, 5000) };
    throw err;
  }

  const titleRaw = parsed?.currentRoleTitle;
  const currentRoleTitle =
    typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw.trim().slice(0, 80) : null;

  const confidence = _normStr(parsed?.confidence || 'low') || 'low';
  const evidence = _normStr(parsed?.evidence || '');

  return { currentRoleTitle, confidence, evidence, rawText, prompt, modelId };
}

export {
  generateTargetedRoles,
  generateTargetedRolesSafe,
  getInitialRecommendations,
  extractNameAndCurrentRoleFromText,
  extractCurrentRoleFromText
};

export default {
  generateTargetedRoles,
  generateTargetedRolesSafe,
  getInitialRecommendations,
  extractNameAndCurrentRoleFromText,
  extractCurrentRoleFromText
};
