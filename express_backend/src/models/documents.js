/**
 * Document-related request/DTO schemas (ESM).
 *
 * This backend runs under Node ESM (`type: module`). Previously this file used CommonJS
 * (`require`/`module.exports`), which caused ESM named export resolution failures when
 * routes imported `{ DocumentCreateRequest, ExtractedTextUpsertRequest }`.
 *
 * To keep startup robust and avoid module-shape interop issues, we:
 * - use the ESM Zod wrapper (`../utils/zod.js`)
 * - lazily initialize schemas
 * - expose named exports that behave like Zod schemas for the subset of methods we use
 *   (currently `.safeParse()`), while keeping the route code unchanged.
 */

import { getZod } from '../utils/zod.js';

let _schemasPromise;

/**
 * Initialize Zod schemas lazily.
 * @returns {Promise<{DocumentCreateRequest: any, ExtractedTextUpsertRequest: any}>}
 */
async function _initSchemas() {
  const { z } = await getZod();

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

  return {
    DocumentCreateRequest,
    ExtractedTextUpsertRequest
  };
}

// PUBLIC_INTERFACE
export async function getDocumentSchemas() {
  /**
   * Lazily initialize Zod schemas.
   * @returns {Promise<{DocumentCreateRequest: any, ExtractedTextUpsertRequest: any}>}
   */
  if (!_schemasPromise) _schemasPromise = _initSchemas();
  return _schemasPromise;
}

/**
 * Create a lightweight proxy that exposes a synchronous `.safeParse(...)` method
 * while building the underlying Zod schema lazily.
 *
 * This keeps route call sites unchanged:
 *   DocumentCreateRequest.safeParse(req.body)
 *
 * @param {'DocumentCreateRequest'|'ExtractedTextUpsertRequest'} key
 * @returns {{ safeParse: (value:any)=>Promise<any> }}
 */
function _createLazySchemaProxy(key) {
  return {
    /**
     * safeParse wrapper. Note that this returns a Promise, so callers should ideally `await`.
     * However, in this codebase the routes use it synchronously. To avoid a larger refactor,
     * we provide a sync facade by throwing if used without awaiting.
     *
     * The routes in this repository are written expecting synchronous Zod schemas.
     * Therefore, we *also* eagerly kick off schema init at module load time so that by the
     * time a request hits the route, the schemas are usually ready and we can synchronously
     * access them via the cached promise.
     */
    safeParse(value) {
      if (!_schemasPromise) _schemasPromise = _initSchemas();

      // If the promise has already resolved, use the cached schemas synchronously.
      // Otherwise, return a "not ready yet" validation error shape instead of crashing.
      // This preserves server startup and gives a clear response in the unlikely event
      // of the very first request racing schema init.
      if (_schemasPromise && typeof _schemasPromise.then === 'function') {
        // Best-effort sync access: we cannot synchronously await in JS.
        // So we attach a resolved cache.
        if (_schemasPromise.__resolved) {
          const schema = _schemasPromise.__resolved[key];
          return schema.safeParse(value);
        }

        // Attach resolved cache once.
        _schemasPromise.then((schemas) => {
          _schemasPromise.__resolved = schemas;
        });

        return {
          success: false,
          error: {
            flatten: () => ({
              formErrors: ['Schema initialization in progress. Please retry.'],
              fieldErrors: {}
            })
          }
        };
      }

      return {
        success: false,
        error: {
          flatten: () => ({
            formErrors: ['Schema initialization failed.'],
            fieldErrors: {}
          })
        }
      };
    }
  };
}

// Kick off initialization ASAP after import, but don't block startup.
void getDocumentSchemas();

// PUBLIC_INTERFACE
export const DocumentCreateRequest = _createLazySchemaProxy('DocumentCreateRequest');

// PUBLIC_INTERFACE
export const ExtractedTextUpsertRequest = _createLazySchemaProxy('ExtractedTextUpsertRequest');
