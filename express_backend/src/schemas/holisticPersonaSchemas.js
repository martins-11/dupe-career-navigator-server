'use strict';

const { getZod } = require('../utils/zod');

let _schemasPromise;

/**
 * Holistic Persona (Career Navigator) schemas.
 *
 * These schemas provide strict request/response validation for the 5 new /api endpoints:
 * - GET /api/recommendations/roles
 * - POST /api/recommendations/compare
 * - GET /api/paths/multiverse
 * - POST /api/plan/milestones
 * - PUT /api/profile/scoring
 *
 * They are intentionally additive and align with existing services:
 * - orchestrationService (draft/final persona generation pipeline)
 * - personaService (Bedrock-backed persona draft)
 *
 * NOTE:
 * - The endpoints can be used DB-less (memory repos) and AI-less (mock mode) depending on env vars.
 */

async function _initSchemas() {
  const { z } = await getZod();

  // -----------------------------
  // Common / utilities
  // -----------------------------

  const UuidSchema = z.string().uuid();

  function _optionalNonEmptyString() {
    return z.string().transform((v) => String(v).trim()).refine((v) => v.length > 0, 'Required').optional();
  }

  // PUBLIC_INTERFACE
  function parseWithZod(schema, input) {
    /** Parse input with Zod and return { ok, data } or { ok, error }. */
    const res = schema.safeParse(input);
    if (res.success) return { ok: true, data: res.data };
    return { ok: false, error: res.error };
  }

  // PUBLIC_INTERFACE
  function enforceResponse(schema, payload) {
    /**
     * Enforce response validation (defensive programming).
     * Throws a ZodError which is handled by utils/errors.sendError().
     */
    return schema.parse(payload);
  }

  // -----------------------------
  // /api/recommendations/roles
  // -----------------------------

  /**
   * Phase 1 response payload per role (per user instructions):
   * - role_id
   * - role_title
   * - industry
   * - match_reason
   * - estimated_salary_range
   */
  const RecommendedRoleSchema = z
    .object({
      role_id: z.string().min(1),
      role_title: z.string().min(1),
      industry: z.string().nullable().optional(),
      match_reason: z.string().min(1),
      estimated_salary_range: z.string().nullable().optional()
    })
    .strict();

  const RecommendationsRolesResponseSchema = z
    .object({
      roles: z.array(RecommendedRoleSchema).min(5)
    })
    .strict();

  // -----------------------------
  // /api/recommendations/compare
  // -----------------------------

  const RoleCompareRequestSchema = z
    .object({
      leftRoleId: z.string().min(1),
      rightRoleId: z.string().min(1),
      /**
       * context is additive; may include personaId/buildId/sourceText/targetRole/etc.
       * We intentionally allow arbitrary keys to avoid breaking clients.
       */
      context: z.record(z.any()).nullable().optional()
    })
    .strict();

  const RoleCompareResponseSchema = z
    .object({
      leftRoleId: z.string().min(1),
      rightRoleId: z.string().min(1),
      comparison: z
        .object({
          summary: z.string().min(1),
          differences: z.array(z.string())
        })
        .strict()
    })
    .strict();

  // -----------------------------
  // /api/paths/multiverse
  // -----------------------------

  const CareerPathSchema = z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      steps: z.array(z.string().min(1)).min(1),
      /**
       * Additive metadata that the UI can use (non-breaking).
       * Not part of the OpenAPI placeholder schema, but safe for clients that ignore extra keys.
       */
      metadata: z.record(z.any()).optional()
    })
    .strict();

  const PathsMultiverseResponseSchema = z
    .object({
      paths: z.array(CareerPathSchema)
    })
    .strict();

  // -----------------------------
  // /api/plan/milestones
  // -----------------------------

  const PlanMilestonesRequestSchema = z
    .object({
      goal: z.string().nullable().optional(),
      timeframeWeeks: z.number().int().min(1).max(520).nullable().optional(),
      context: z.record(z.any()).nullable().optional()
    })
    .strict();

  const PlanMilestoneSchema = z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      description: z.string().nullable().optional(),
      order: z.number().int().min(1)
    })
    .strict();

  const PlanMilestonesResponseSchema = z
    .object({
      goal: z.string().min(1),
      timeframeWeeks: z.number().int().min(1),
      milestones: z.array(PlanMilestoneSchema).min(1)
    })
    .strict();

  // -----------------------------
  // /api/profile/scoring
  // -----------------------------

  /**
   * 3/2 rule override:
   * We model this as a structured override payload but keep scoring object flexible.
   */
  const ProfileScoringOverrideSchema = z
    .object({
      rule: z.literal('3/2'),
      enabled: z.boolean(),
      /**
       * Optional manual overall score override (0..100).
       * If omitted, server computes from sub-scores where possible.
       */
      overallOverride: z.number().min(0).max(100).nullable().optional(),
      /**
       * Optional notes for audit/UI display.
       */
      note: z.string().max(2000).nullable().optional()
    })
    .strict();

  const ProfileScoringRequestSchema = z
    .object({
      userId: z.string().uuid().nullable().optional(),
      personaId: z.string().uuid().nullable().optional(),
      buildId: z.string().uuid().nullable().optional(),
      /**
       * scoring is intentionally flexible; we validate key parts we use.
       */
      scoring: z.record(z.any()).nullable().optional(),
      override: ProfileScoringOverrideSchema.nullable().optional()
    })
    .strict();

  const ProfileScoringResponseSchema = z
    .object({
      status: z.literal('ok'),
      scoring: z.record(z.any())
    })
    .strict();

  return {
    // Helpers
    parseWithZod,
    enforceResponse,

    // Roles
    RecommendedRoleSchema,
    RecommendationsRolesResponseSchema,

    // Compare
    RoleCompareRequestSchema,
    RoleCompareResponseSchema,

    // Paths
    CareerPathSchema,
    PathsMultiverseResponseSchema,

    // Plan
    PlanMilestonesRequestSchema,
    PlanMilestonesResponseSchema,
    PlanMilestoneSchema,

    // Profile scoring
    ProfileScoringRequestSchema,
    ProfileScoringResponseSchema,
    ProfileScoringOverrideSchema,

    // Common exports if needed later
    UuidSchema,
    _optionalNonEmptyString
  };
}

/**
 * PUBLIC_INTERFACE
 * @returns {Promise<ReturnType<_initSchemas>>}
 */
async function getHolisticPersonaSchemas() {
  /** Lazily initialize Zod schemas without triggering ESM/CJS crashes at require-time. */
  if (!_schemasPromise) _schemasPromise = _initSchemas();
  return _schemasPromise;
}

module.exports = {
  getHolisticPersonaSchemas
};
