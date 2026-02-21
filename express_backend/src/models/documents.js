'use strict';

const { z } = require('zod');

const uuid = z.string().uuid();

const DocumentCreateRequest = z.object({
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

const ExtractedTextUpsertRequest = z.object({
  extractor: z.string().nullable().optional(),
  extractorVersion: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  textContent: z.string().min(1),
  metadataJson: z.record(z.any()).optional()
});

module.exports = {
  DocumentCreateRequest,
  ExtractedTextUpsertRequest
};
