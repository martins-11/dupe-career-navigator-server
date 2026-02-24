'use strict';

/**
 * Best-effort extraction of a person's name and current role/title from unstructured text.
 *
 * This module is intentionally conservative:
 * - It tries hard to find a plausible NAME near the top of the document (common in resumes).
 * - It only returns a ROLE when there is strong evidence (to avoid hallucinating).
 *
 * Output contract:
 * - name: string ('' when not found)
 * - role: string ('' when not found)  <-- IMPORTANT: role is optional/blank when missing
 */

// PUBLIC_INTERFACE
function extractNameAndCurrentRole(text) {
  /**
   * Extract a candidate name and (optionally) current role/title from unstructured text.
   *
   * @param {string} text - Combined extracted/normalized document text.
   * @returns {{ name: string, role: string, confidence: { name: 'high'|'medium'|'low'|'none', role: 'high'|'medium'|'low'|'none' } }}
   */
  const raw = String(text || '');
  const normalized = raw
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  const lines = normalized
    .split('\n')
    .map((l) => String(l || '').trim())
    .filter(Boolean)
    .slice(0, 140);

  const stripDecorations = (line) =>
    String(line || '')
      .replace(/^[\u2022*\-–—|]+/g, '')
      .replace(/[|\u2022]+/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();

  const isEmailOrPhoneLine = (line) => {
    const l = String(line || '');
    return /@/.test(l) || /\b(?:\+?\d[\d\s\-().]{7,}\d)\b/.test(l);
  };

  const isLikelySectionHeader = (line) =>
    /^(summary|profile|experience|work experience|employment|education|skills|projects|certifications|contact|objective)$/i.test(
      String(line || '').trim()
    );

  const looksLikePersonName = (line) => {
    const l = stripDecorations(line);
    if (!l || l.length > 60) return false;
    if (isEmailOrPhoneLine(l)) return false;
    if (/[0-9]/.test(l)) return false;
    if (/[,:]/.test(l)) return false;
    if (isLikelySectionHeader(l)) return false;

    // 2–5 tokens, but after removing honorifics prefer 2–4.
    const tokens = l.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 5) return false;

    const honorifics = new Set(['mr', 'mrs', 'ms', 'dr', 'prof']);
    const cleaned = tokens.map((t) => t.replace(/\.$/, '')).filter((t) => t && !honorifics.has(t.toLowerCase()));
    if (cleaned.length < 2 || cleaned.length > 4) return false;

    return cleaned.every((t) => /^[A-Za-z][A-Za-z.'-]*$/.test(t));
  };

  const looksLikeJobTitle = (line) => {
    const l = stripDecorations(line);
    if (!l || l.length > 100) return false;
    if (isEmailOrPhoneLine(l)) return false;
    if (isLikelySectionHeader(l)) return false;
    if (/[:@]/.test(l)) return false;
    if (/[0-9]/.test(l)) return false;

    // Common role/title keywords; keep broad but not too permissive.
    return /\b(engineer|developer|manager|lead|architect|consultant|analyst|designer|director|specialist|officer|product|research|scientist|intern)\b/i.test(
      l
    );
  };

  const name = (() => {
    // 1) Explicit "Name: X"
    for (const line of lines.slice(0, 30)) {
      const m = stripDecorations(line).match(/^(?:name)\s*[:\-]\s*(.+)$/i);
      if (m && m[1]) {
        const candidate = stripDecorations(m[1]);
        if (looksLikePersonName(candidate)) return candidate;
      }
    }

    // 2) First plausible name in first ~12 lines (resume header area)
    for (const line of lines.slice(0, 12)) {
      const candidate = stripDecorations(line);
      if (looksLikePersonName(candidate)) return candidate;
    }

    return '';
  })();

  const role = (() => {
    // IMPORTANT: role is optional. Only set when confident.
    // 1) Explicit "Title/Role: X"
    for (const line of lines.slice(0, 50)) {
      const m = stripDecorations(line).match(/^(?:title|current\s+role|role|position)\s*[:\-]\s*(.+)$/i);
      if (m && m[1]) {
        const candidate = stripDecorations(m[1]);
        if (looksLikeJobTitle(candidate)) return candidate;
      }
    }

    // 2) Nearby line after the name header (common resume format)
    if (name) {
      const idx = lines.findIndex((l) => stripDecorations(l) === name);
      if (idx >= 0) {
        for (const neighbor of lines.slice(idx + 1, idx + 6)) {
          const candidate = stripDecorations(neighbor);
          if (looksLikeJobTitle(candidate)) return candidate;
        }
      }
    }

    return '';
  })();

  return {
    name,
    role,
    confidence: {
      name: name ? 'medium' : 'none',
      role: role ? 'medium' : 'none'
    }
  };
}

module.exports = {
  extractNameAndCurrentRole
};
