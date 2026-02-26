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

/**
 * Pick the best subject text to use for name extraction, with resume precedence.
 *
 * This addresses two product requirements:
 * 1) If a resume is present, its header is usually the most reliable source of the person's name.
 * 2) For single-doc uploads that are NOT resumes (performance reviews / job descriptions), we should
 *    extract the name from that single document rather than letting combined heuristics drift or
 *    fall back to generic document labels.
 *
 * @param {Array<{category?: string|null, text?: string|null, textContent?: string|null}>} docs
 * @returns {string} text to run name extraction against
 */
function _selectBestTextForNameExtraction(docs) {
  const arr = Array.isArray(docs) ? docs : [];

  const getText = (d) => String(d?.textContent ?? d?.text ?? '').trim();

  // 1) Resume always wins if present and has text
  const resumeDoc = arr.find((d) => String(d?.category || '').toLowerCase() === 'resume' && getText(d));
  if (resumeDoc) return getText(resumeDoc);

  // 2) If exactly one document has text, use it (single-doc uploads)
  const withText = arr.filter((d) => getText(d));
  if (withText.length === 1) return getText(withText[0]);

  // 3) Otherwise fall back to concatenation (preserves previous behavior)
  return withText.map(getText).filter(Boolean).join('\n\n-----\n\n');
}

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
     *
     * Enhancement:
     * - Support more common label variants: "Employee Name", "Reviewed Employee", "Team Member", etc.
     * - Support "Last, First" format and normalize to "First Last".
     */
    const top = lines.slice(0, 120).map(stripDecorations).filter(Boolean);

    const clean = (s) =>
      String(s || '')
        .replace(/["“”]/g, '')
        .replace(/[|\u2022]+/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();

    const normalizeCommaName = (candidate) => {
      const c = clean(candidate);
      const m = c.match(
        /^([A-Za-z][A-Za-z.'-]{1,30}),\s*([A-Za-z][A-Za-z.'-]{1,30})(?:\s+([A-Za-z][A-Za-z.'-]{1,30}))?$/
      );
      if (!m) return c;
      // "Last, First [Middle]" -> "First [Middle] Last"
      return [m[2], m[3], m[1]].filter(Boolean).join(' ').trim();
    };

    const isValidPersonName = (candidate) => {
      const parts = String(candidate || '')
        .split(/\s+/)
        .map((p) => p.trim())
        .filter(Boolean);

      if (parts.length < 2 || parts.length > 4) return false;
      if (!parts.every((p) => /^[A-Za-z][A-Za-z.'-]*$/.test(p))) return false;

      // Guard against generic document-type labels being captured as a "name".
      const joinedLower = parts.join(' ').toLowerCase();
      if (joinedLower === 'job description' || joinedLower === 'performance review' || joinedLower === 'resume') {
        return false;
      }

      return true;
    };

    const patterns = [
      // Common "key: value" labels
      /^(?:employee|employee\s+name|associate|associate\s+name|reviewee|reviewed\s+employee|team\s+member|employee\s+being\s+reviewed|name)\s*[:\-]\s*(.+)$/i,
      // Reviewer/author labels (we still treat the value as the employee name only if it looks like a person name)
      /^(?:subject|employee\s*\/\s*reviewee|review\s+subject)\s*[:\-]\s*(.+)$/i,
      // "Review for Jane Doe"
      /^(?:review\s+for)\s*[:\-]?\s*(.+)$/i,
      // Sometimes: "Employee - Jane Doe"
      /^(?:employee|employee\s+name)\s*[-–—]\s*(.+)$/i,
      // Email-style subjects: "Subject: Performance Review - Jane Doe"
      /^(?:subject)\s*[:\-]\s*(?:performance\s+review\s*[-–—:]?\s*)?(.+)$/i,
      // Thread subjects: "Re: Performance Review for Jane Doe"
      /^(?:re)\s*[:\-]\s*(?:performance\s+review\s*(?:for)?\s*)?(.+)$/i,
    ];

    for (const line of top) {
      for (const rx of patterns) {
        const m = line.match(rx);
        if (!m || !m[1]) continue;

        const candidate = normalizeCommaName(m[1]);
        if (!candidate) continue;

        if (isValidPersonName(candidate)) {
          return candidate;
        }
      }

      // Additional pattern: "Performance Review for Jane Doe" (not necessarily a key/value format)
      // Keep strict: only accept if the suffix looks like a valid 2-4 part person name.
      const m2 = line.match(/\bperformance\s+review\b\s*(?:for)?\s+([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30}){1,3})\s*$/i);
      if (m2 && m2[1]) {
        const candidate = normalizeCommaName(m2[1]);
        if (candidate && isValidPersonName(candidate)) return candidate;
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

/**
 * PUBLIC_INTERFACE
 */
function extractBestNameAndRoleFromDocuments(docs) {
  /**
   * Extract best-effort subject name + role from a set of categorized documents.
   *
   * Precedence:
   * 1) If a RESUME document exists, always derive name/role from the resume text.
   * 2) Else if exactly one document exists with text, derive from that doc (single-doc PR/JD case).
   * 3) Else fall back to combined text.
   *
   * Input document shape is intentionally loose to support both:
   * - orchestration extracted rows ({ textContent, metadataJson: {category} })
   * - ai route payloads and other internal callers ({ text, category })
   *
   * @param {Array<{category?: string|null, metadataJson?: object|null, textContent?: string|null, text?: string|null}>} docs
   * @returns {{ name: string, role: string, confidence: { name: 'high'|'medium'|'low'|'none', role: 'high'|'medium'|'low'|'none' } }}
   */
  const normalizedDocs = (Array.isArray(docs) ? docs : []).map((d) => ({
    category: d?.metadataJson?.category ?? d?.category ?? null,
    textContent: d?.textContent ?? null,
    text: d?.text ?? null
  }));

  const bestText = _selectBestTextForNameExtraction(normalizedDocs);
  return extractNameAndCurrentRole(bestText);
}

module.exports = {
  extractNameAndCurrentRole,
  extractBestNameAndRoleFromDocuments
};
