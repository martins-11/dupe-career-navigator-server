/**
 * Document-related request/DTO schemas (ESM).
 *
 * Problem (bug):
 * - Previous implementation attempted to lazily initialize Zod schemas asynchronously and expose them
 *   via a proxy with a synchronous `.safeParse()` facade.
 * - Routes use these schemas synchronously (e.g., DocumentCreateRequest.safeParse(req.body)).
 * - On the first request after process start, schema initialization could race, returning a synthetic
 *   validation error: "Schema initialization in progress. Please retry."
 *
 * Impact:
 * - Breaks document creation and extracted text upsert flows intermittently.
 * - Cascades into orchestration/run-all and ingestion flows, producing confusing downstream failures.
 *
 * Fix:
 * - Define schemas synchronously using the ESM/CJS-safe Zod wrapper `getZodSync()`.
 * - Export real Zod schemas; keep route call sites unchanged.
 */

import { getZodSync } from '../utils/zod.js';

const { z } = getZodSync();

const uuid = z.string().uuid();

// PUBLIC_INTERFACE
export const DocumentCreateRequest = z.object({
  userId: uuid.nullable().optional(),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1).nullable().optional(),

  /**
   * Additive semantics:
   * category is used by the MVP to auto-select the latest docs for orchestration.
   * Canonical values are defined in models/documentCategories.js
   */
  category: z.string().min(1).nullable().optional(),

  source: z.string().nullable().optional(),
  storageProvider: z.string().nullable().optional(),
  storagePath: z.string().nullable().optional(),
  fileSizeBytes: z.number().int().nonnegative().nullable().optional(),
  sha256: z.string().min(16).nullable().optional()
});

// PUBLIC_INTERFACE
export const ExtractedTextUpsertRequest = z.object({
  extractor: z.string().nullable().optional(),
  extractorVersion: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  textContent: z.string().min(1),
  metadataJson: z.record(z.any()).optional()
});

/**
 * PUBLIC_INTERFACE
 * Backward-compatible helper retained for any callsites that may have been introduced while the
 * proxy-based approach existed.
 *
 * @returns {Promise<{DocumentCreateRequest: any, ExtractedTextUpsertRequest: any}>}
 */
export async function getDocumentSchemas() {
  return {
    DocumentCreateRequest,
    ExtractedTextUpsertRequest
  };
}
