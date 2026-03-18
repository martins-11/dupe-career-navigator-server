

/**
 * Document category semantics used by the MVP upload + orchestration flow.
 *
 * Categories are intentionally limited to 3 primary items:
 * - resume
 * - job_description
 * - performance_review
 *
 * This module is used for:
 * - upload validation
 * - orchestration auto-selection of latest documents per category
 */

/**
 * PUBLIC_INTERFACE
 * Canonical document categories supported by the MVP.
 */
export const DOCUMENT_CATEGORIES = Object.freeze({
  RESUME: 'resume',
  JOB_DESCRIPTION: 'job_description',
  PERFORMANCE_REVIEW: 'performance_review'
});

/**
 * PUBLIC_INTERFACE
 * List of allowed document category strings.
 */
export const DOCUMENT_CATEGORY_VALUES = Object.freeze(Object.values(DOCUMENT_CATEGORIES));

/**
 * PUBLIC_INTERFACE
 * Normalize a category string into canonical form.
 *
 * Accepts common aliases to be forgiving with clients:
 * - "jd" -> job_description
 * - "jobDescription" -> job_description
 * - "performance" | "360" | "review" -> performance_review
 *
 * @param {string|null|undefined} categoryRaw
 * @returns {string|null} canonical category or null if not recognized
 */
export function normalizeDocumentCategory(categoryRaw) {
  const raw = categoryRaw == null ? '' : String(categoryRaw).trim();
  if (!raw) return null;

  const lowered = raw.toLowerCase();

  if (lowered === 'resume' || lowered === 'cv') return DOCUMENT_CATEGORIES.RESUME;

  if (
    lowered === 'job_description' ||
    lowered === 'job-description' ||
    lowered === 'jobdescription' ||
    lowered === 'job description' ||
    lowered === 'jd'
  ) {
    return DOCUMENT_CATEGORIES.JOB_DESCRIPTION;
  }

  if (
    lowered === 'performance_review' ||
    lowered === 'performance-review' ||
    lowered === 'performance review' ||
    lowered === 'review' ||
    lowered === '360' ||
    lowered === '360_feedback' ||
    lowered === '360 feedback' ||
    lowered === 'performance' ||
    lowered === 'feedback'
  ) {
    return DOCUMENT_CATEGORIES.PERFORMANCE_REVIEW;
  }

  return null;
}

/**
 * PUBLIC_INTERFACE
 * Validate that an input is a supported canonical category.
 *
 * @param {string|null|undefined} category
 * @returns {boolean}
 */
export function isSupportedDocumentCategory(category) {
  return DOCUMENT_CATEGORY_VALUES.includes(String(category || ''));
}



