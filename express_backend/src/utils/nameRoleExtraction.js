'use strict';

/**
 * Best-effort extraction of a person's name and current role/title from unstructured text.
 *
 * This module is intentionally conservative:
 * - It tries hard to find a plausible PERSON NAME near the top of the document (common in resumes).
 * - It only returns a ROLE when there is strong evidence (to avoid hallucinating).
 *
 * Enhancement (per bug report):
 * - Job descriptions / performance reviews often do not follow resume header patterns.
 * - For performance reviews, we additionally look for explicit review labels (Employee/Review for).
 * - For job descriptions and unknown document types, we fall back to extracting a plausible
 *   COMPANY/ORGANIZATION name and return that as `name` with low confidence.
 *
 * Output contract:
 * - name: string ('' when not found; may be a company name fallback)
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
      .replace(/^[\u2022*\-\u2013\u2014|]+/g, '')
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
    const cleaned = tokens
      .map((t) => t.replace(/\.$/, ''))
      .filter((t) => t && !honorifics.has(t.toLowerCase()));
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

  const extractPerformanceReviewName = () => {
    /**
     * Performance review docs often contain an explicit label for the employee/reviewee.
     * We keep this strict to avoid capturing full sentences.
     */
    const top = lines.slice(0, 120).map(stripDecorations).filter(Boolean);

    const clean = (s) =>
      String(s || '')
        .replace(/["“”]/g, '')
        .replace(/[|•]+/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();

    const patterns = [
      /^(?:employee|associate|reviewee|name)\s*[:\-]\s*(.+)$/i,
      /^(?:review\s+for)\s*[:\-]?\s*(.+)$/i,
    ];

    for (const line of top) {
      for (const rx of patterns) {
        const m = line.match(rx);
        if (!m || !m[1]) continue;
        const candidate = clean(m[1]);
        if (!candidate) continue;

        const parts = candidate.split(/\s+/).filter(Boolean);
        if (parts.length < 2 || parts.length > 4) continue;
        if (!parts.every((p) => /^[A-Za-z][A-Za-z.'-]*$/.test(p))) continue;

        return candidate;
      }
    }

    return '';
  };

  const extractCompanyNameFallback = () => {
    /**
     * Job descriptions often don't mention a candidate name at all.
     * Provide a best-effort company name so UIs have a stable display label.
     */
    const top = lines.slice(0, 80).map(stripDecorations).filter(Boolean);

    const clean = (s) =>
      String(s || '')
        .replace(/["“”]/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim();

    const labeledPatterns = [
      /^(?:company|employer|organization|organisation|client)\s*[:\-]\s*(.+)$/i,
      /^(?:about)\s+(.+)$/i,
    ];

    for (const line of top) {
      for (const rx of labeledPatterns) {
        const m = line.match(rx);
        if (!m || !m[1]) continue;

        const candidate = clean(m[1]);
        if (!candidate) continue;
        if (candidate.length > 80) continue;
        if (/@/.test(candidate)) continue;
        if (/[0-9]{3,}/.test(candidate)) continue;

        return candidate;
      }
    }

    // Phrase-based fallback: "... at Acme Corp"
    const firstChunk = normalized.slice(0, 2000);
    const m2 = firstChunk.match(/\b(?:at|with)\s+([A-Z][A-Za-z0-9&.\- ]{2,60})(?:\b|[.,\n])/);
    if (m2 && m2[1]) {
      const candidate = clean(m2[1]);
      if (candidate && candidate.length <= 80) return candidate;
    }

    return '';
  };

  const resumeLikeName = (() => {
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

  const reviewLikeName = resumeLikeName ? '' : extractPerformanceReviewName();
  const companyFallback = !resumeLikeName && !reviewLikeName ? extractCompanyNameFallback() : '';

  const name = resumeLikeName || reviewLikeName || companyFallback || '';

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
    if (resumeLikeName || reviewLikeName) {
      const knownName = resumeLikeName || reviewLikeName;
      const idx = lines.findIndex((l) => stripDecorations(l) === knownName);
      if (idx >= 0) {
        for (const neighbor of lines.slice(idx + 1, idx + 6)) {
          const candidate = stripDecorations(neighbor);
          if (looksLikeJobTitle(candidate)) return candidate;
        }
      }
    }

    return '';
  })();

  const nameConfidence = resumeLikeName || reviewLikeName ? 'medium' : companyFallback ? 'low' : 'none';

  return {
    name,
    role,
    confidence: {
      name: nameConfidence,
      role: role ? 'medium' : 'none',
    },
  };
}

module.exports = {
  extractNameAndCurrentRole,
};
