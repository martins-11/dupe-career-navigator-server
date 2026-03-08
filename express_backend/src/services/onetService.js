'use strict';

const https = require('https');

/**
 * O*NET Web Services base URL.
 * Docs: https://services.onetcenter.org/
 */
const ONET_BASE_URL = 'https://services.onetcenter.org/ws';

/**
 * Environment variables (supported):
 * - ONET_USERNAME: O*NET Web Services username / account id (preferred)
 * - ONET_PASSWORD: O*NET Web Services API key (preferred)
 *
 * Deployment aliases (supported because some environments only expose REACT_APP_* vars):
 * - REACT_APP_ONET_API_KEY: O*NET API key (maps to ONET_PASSWORD)
 * - ONET_API_KEY: O*NET API key (maps to ONET_PASSWORD)
 * - REACT_APP_ONET_USERNAME / ONET_API_KEY_USERNAME: optional username override
 *
 * Notes on Basic Auth for O*NET:
 * - O*NET Web Services uses HTTP Basic Auth.
 * - Many examples use a real account id as the username and the API key as the password.
 * - Some deployments only provide an API key; in that case we fall back to username="apikey"
 *   (a common convention for API-key-only Basic Auth setups) while keeping compatibility
 *   with the explicit ONET_USERNAME/ONET_PASSWORD pair when available.
 */
function _getOnetCredentials() {
  const password = String(
    process.env.ONET_PASSWORD ||
      process.env.ONET_API_KEY ||
      process.env.REACT_APP_ONET_API_KEY ||
      '',
  ).trim();

  // Prefer explicit username if present; otherwise fall back to "apikey" when only an API key is supplied.
  const username = String(
    process.env.ONET_USERNAME ||
      process.env.ONET_API_KEY_USERNAME ||
      process.env.REACT_APP_ONET_USERNAME ||
      (password ? 'apikey' : '') ||
      '',
  ).trim();

  if (!username || !password) {
    const err = new Error(
      'O*NET credentials are not configured. Set ONET_PASSWORD (or ONET_API_KEY / REACT_APP_ONET_API_KEY) and optionally ONET_USERNAME.',
    );
    err.code = 'ONET_NOT_CONFIGURED';
    err.httpStatus = 503;
    throw err;
  }

  return { username, password };
}

/**
 * Very small in-memory TTL cache to reduce O*NET calls (rate limits / latency).
 * Note: this is per-process and resets on restart (acceptable for current backend architecture).
 */
const _cache = new Map();
/** @type {number} */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function _cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function _buildAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${token}`;
}

function _toQueryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    usp.set(k, s);
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

/**
 * O*NET responses are XML. We avoid adding new dependencies by using a pragmatic XML extraction
 * for the small pieces we need (titles/codes and element text).
 *
 * This is NOT a general XML parser; it's intentionally narrow for:
 * - <occupation code="15-1252.00" title="Software Developers" ... />
 * - <category id="..."><title>...</title></category> (if needed later)
 * - <element_id> / <scale_id> style simple tags (not currently used)
 */
function _extractOccupationListFromXml(xml) {
  const text = String(xml || '');
  const out = [];
  const re = /<occupation\b([^>]*)\/>/gi;
  let m;
  while ((m = re.exec(text)) != null) {
    const attrs = m[1] || '';
    const codeMatch = attrs.match(/\bcode="([^"]+)"/i);
    const titleMatch = attrs.match(/\btitle="([^"]+)"/i);
    const descriptionMatch = attrs.match(/\bdescription="([^"]+)"/i);
    const code = codeMatch ? codeMatch[1] : '';
    const title = titleMatch ? titleMatch[1] : '';
    const description = descriptionMatch ? descriptionMatch[1] : null;
    if (!code || !title) continue;
    out.push({ code, title, description });
  }
  return out;
}

function _extractSuggestionListFromXml(xml) {
  const text = String(xml || '');
  const out = [];

  // Suggestions can appear as <suggestion>Foo</suggestion> or within <suggestions><suggestion ... /></suggestions>.
  // Implement both simple text form and attribute form.
  const reText = /<suggestion\b[^>]*>([^<]+)<\/suggestion>/gi;
  let m;
  while ((m = reText.exec(text)) != null) {
    const s = String(m[1] || '').trim();
    if (s) out.push(s);
  }

  const reAttr = /<suggestion\b([^>]*)\/>/gi;
  while ((m = reAttr.exec(text)) != null) {
    const attrs = m[1] || '';
    const titleMatch = attrs.match(/\btitle="([^"]+)"/i);
    const s = titleMatch ? String(titleMatch[1]).trim() : '';
    if (s) out.push(s);
  }

  // De-dupe preserving order
  const seen = new Set();
  const uniq = [];
  for (const s of out) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  return uniq;
}

function _extractTaskListFromOccupationDetailsXml(xml) {
  const text = String(xml || '');
  const out = [];
  // Example: <task id="1" ...>Do something...</task>
  const re = /<task\b[^>]*>([\s\S]*?)<\/task>/gi;
  let m;
  while ((m = re.exec(text)) != null) {
    const t = String(m[1] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t) out.push(t);
  }
  return out;
}

function _extractDescriptionFromOccupationDetailsXml(xml) {
  const text = String(xml || '');
  // Try common structures:
  // 1) <description>...</description>
  // 2) <what_they_do>...</what_they_do>
  const tagExtract = (tag) => {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = re.exec(text);
    if (!m) return null;
    const cleaned = String(m[1] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || null;
  };

  return tagExtract('what_they_do') || tagExtract('description');
}

function _extractSkillNamesFromOccupationDetailsXml(xml) {
  const text = String(xml || '');
  const out = [];

  // Common: <skill ...><name>Critical Thinking</name></skill> or <element name="...">
  const nameTags = /<name\b[^>]*>([^<]+)<\/name>/gi;
  let m;
  while ((m = nameTags.exec(text)) != null) {
    const s = String(m[1] || '').trim();
    if (s) out.push(s);
  }

  // Attribute fallback: element name="..."
  const elemAttr = /<element\b([^>]*)\/?>/gi;
  while ((m = elemAttr.exec(text)) != null) {
    const attrs = m[1] || '';
    const nm = attrs.match(/\bname="([^"]+)"/i);
    const s = nm ? String(nm[1]).trim() : '';
    if (s) out.push(s);
  }

  // De-dupe and filter super-short noise
  const seen = new Set();
  const uniq = [];
  for (const s of out) {
    const k = s.toLowerCase();
    if (k.length < 2) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  return uniq;
}

/**
 * Make a GET request to O*NET Web Services.
 * Uses https module directly (no new dependencies).
 */
async function _onetGet(path, queryParams = {}, { cacheKey = null, ttlMs = DEFAULT_TTL_MS } = {}) {
  const qs = _toQueryString(queryParams);
  const url = `${ONET_BASE_URL}${path}${qs}`;

  const key = cacheKey || url;
  const cached = _cacheGet(key);
  if (cached != null) return cached;

  const { username, password } = _getOnetCredentials();
  const authHeader = _buildAuthHeader(username, password);

  const body = await new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/xml',
          'User-Agent': 'career-navigator-server/onet-integration',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            const err = new Error(`O*NET request failed (${res.statusCode}): ${url}`);
            err.code = 'ONET_REQUEST_FAILED';
            err.httpStatus = 502;
            err.details = { statusCode: res.statusCode, url, responsePreview: String(data).slice(0, 500) };
            reject(err);
          }
        });
      },
    );

    req.on('error', (e) => {
      const err = new Error(`O*NET request error: ${e?.message || e}`);
      err.code = 'ONET_REQUEST_ERROR';
      err.httpStatus = 502;
      reject(err);
    });

    req.end();
  });

  _cacheSet(key, body, ttlMs);
  return body;
}

function _normalizeLabel(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function _dedupeStringsCaseInsensitive(items) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const s = _normalizeLabel(it);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// PUBLIC_INTERFACE
async function searchOccupations({ keyword, start = 1, end = 50 } = {}) {
  /**
   * Search O*NET occupations by keyword.
   *
   * Uses endpoint: GET /ws/online/search?keyword=...&start=...&end=...
   *
   * Returns: Array<{ code, title, description? }>
   */
  const kw = _normalizeLabel(keyword);
  if (!kw) return [];

  const xml = await _onetGet('/online/search', { keyword: kw, start, end }, { ttlMs: 5 * 60 * 1000 });
  return _extractOccupationListFromXml(xml);
}

// PUBLIC_INTERFACE
async function getOccupationDetails({ code } = {}) {
  /**
   * Get occupation details.
   *
   * Uses endpoint: GET /ws/online/occupations/{code}
   *
   * Returns: { code, title?, description?, tasks: string[], skills: string[] }
   */
  const c = _normalizeLabel(code);
  if (!c) {
    const err = new Error('Occupation code is required.');
    err.code = 'ONET_CODE_REQUIRED';
    err.httpStatus = 400;
    throw err;
  }

  const xml = await _onetGet(`/online/occupations/${encodeURIComponent(c)}`, {}, { ttlMs: 60 * 60 * 1000 });
  const tasks = _extractTaskListFromOccupationDetailsXml(xml).slice(0, 12);
  const description = _extractDescriptionFromOccupationDetailsXml(xml);
  const skills = _extractSkillNamesFromOccupationDetailsXml(xml).slice(0, 40);

  return { code: c, description, tasks, skills };
}

// PUBLIC_INTERFACE
async function autocompleteOccupations({ query, limit = 8 } = {}) {
  /**
   * Autocomplete for occupation titles. O*NET supports /online/search?keyword=... which returns occupations.
   * We'll reuse it with a small window.
   *
   * Returns string[] titles.
   */
  const q = _normalizeLabel(query);
  if (q.length < 2) return [];

  const hits = await searchOccupations({ keyword: q, start: 1, end: Math.max(10, Math.min(40, limit * 5)) });
  const titles = hits.map((h) => h.title).filter(Boolean);
  return _dedupeStringsCaseInsensitive(titles).slice(0, limit);
}

// PUBLIC_INTERFACE
async function getExploreFilterOptions({ seedKeyword = 'developer', max = 60 } = {}) {
  /**
   * Derive Explore filter options from O*NET.
   *
   * O*NET does not provide "industry" the same way our previous seed catalog did.
   * For this phase we:
   * - Provide "industries" as a small stable set derived from O*NET "Career Cluster" is possible,
   *   but requires additional endpoints. To stay safe without expanding scope, we return [] for industries.
   * - Provide "skills" by sampling skills from top N occupations for a seed keyword.
   *
   * This supports the Explore UI multi-select skills filter immediately.
   */
  const kw = _normalizeLabel(seedKeyword) || 'developer';
  const list = await searchOccupations({ keyword: kw, start: 1, end: Math.max(10, Math.min(100, max)) });

  // Fetch details in parallel but keep it bounded.
  const top = list.slice(0, Math.min(list.length, max));
  const details = await Promise.allSettled(top.map((o) => getOccupationDetails({ code: o.code })));

  const allSkills = [];
  for (const d of details) {
    if (d.status !== 'fulfilled') continue;
    const skills = Array.isArray(d.value?.skills) ? d.value.skills : [];
    allSkills.push(...skills);
  }

  const skills = _dedupeStringsCaseInsensitive(allSkills).sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }),
  );

  return {
    industries: [],
    skills,
  };
}

module.exports = {
  searchOccupations,
  getOccupationDetails,
  autocompleteOccupations,
  getExploreFilterOptions,
};

