/**
 * Holistic Persona (Career Navigator) schemas (ESM).
 *
 * These schemas provide strict request/response validation for:
 * - GET /api/recommendations/roles
 * - POST /api/recommendations/compare
 * - GET /api/paths/multiverse
 * - POST /api/plan/milestones
 * - PUT /api/profile/scoring
 *
 * Important:
 * - This backend is ESM ("type":"module").
 * - Zod may resolve as CJS in some installs, so we must use the local interop-safe wrapper.
 */

import { getZodSync } from '../utils/zod.js';

const { z } = getZodSync();

/**
 * -----------------------------
 * Common / utilities
 * -----------------------------
 */

export const UuidSchema = z.string().uuid();

function _optionalNonEmptyString() {
  return z
    .string()
    .transform((v) => String(v).trim())
    .refine((v) => v.length > 0, 'Required')
    .optional();
}

// PUBLIC_INTERFACE
export function parseWithZod(schema, input) {
  /** Parse input with Zod and return { ok, data } or { ok, error }. */
  const res = schema.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  return { ok: false, error: res.error };
}

// PUBLIC_INTERFACE
export function enforceResponse(schema, payload) {
  /**
   * Enforce response validation (defensive programming).
   * Throws a ZodError which is handled by utils/errors.sendError().
   */
  return schema.parse(payload);
}

/**
 * -----------------------------
 * /api/recommendations/roles
 * -----------------------------
 */

export const RecommendedRoleSchema = z
  .object({
    role_id: z.string().min(1),
    role_title: z.string().min(1),
    industry: z.string().nullable().optional(),
    match_reason: z.string().min(1),
    estimated_salary_range: z.string().nullable().optional()
  })
  .strict();

export const RecommendationsRolesResponseSchema = z
  .object({
    roles: z.array(RecommendedRoleSchema).min(5)
  })
  .strict();

/**
 * -----------------------------
 * /api/recommendations/compare
 * -----------------------------
 */

export const RoleCompareRequestSchema = z
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

export const RoleCompareResponseSchema = z
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

/**
 * -----------------------------
 * /api/paths/multiverse
 * -----------------------------
 */

export const CareerPathSchema = z
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

export const PathsMultiverseResponseSchema = z
  .object({
    paths: z.array(CareerPathSchema)
  })
  .strict();

/**
 * -----------------------------
 * /api/plan/milestones
 * -----------------------------
 */

export const PlanMilestonesRequestSchema = z
  .object({
    goal: z.string().nullable().optional(),
    timeframeWeeks: z.number().int().min(1).max(520).nullable().optional(),
    context: z.record(z.any()).nullable().optional()
  })
  .strict();

export const PlanMilestoneSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    order: z.number().int().min(1)
  })
  .strict();

export const PlanMilestonesResponseSchema = z
  .object({
    goal: z.string().min(1),
    timeframeWeeks: z.number().int().min(1),
    milestones: z.array(PlanMilestoneSchema).min(1)
  })
  .strict();

/**
 * -----------------------------
 * /api/profile/scoring
 * -----------------------------
 */

export const ProfileScoringOverrideSchema = z
  .object({
    rule: z.literal('3/2'),
    enabled: z.boolean(),
    /**
     * Optional manual overall score override (0..100).
     * If omitted, server computes from sub-scores where possible.
     */
    overallOverride: z.number().min(0).max(100).nullable().optional(),
    /** Optional notes for audit/UI display. */
    note: z.string().max(2000).nullable().optional()
  })
  .strict();

export const ProfileScoringRequestSchema = z
  .object({
    userId: z.string().uuid().nullable().optional(),
    personaId: z.string().uuid().nullable().optional(),
    buildId: z.string().uuid().nullable().optional(),
    /** scoring is intentionally flexible; we validate key parts we use. */
    scoring: z.record(z.any()).nullable().optional(),
    override: ProfileScoringOverrideSchema.nullable().optional()
  })
  .strict();

export const ProfileScoringResponseSchema = z
  .object({
    status: z.literal('ok'),
    scoring: z.record(z.any())
  })
  .strict();

// PUBLIC_INTERFACE
export function getHolisticPersonaSchemas() {
  /**
   * Backward-compatible accessor (some older code used an async getter).
   * Returns the ESM exports in a stable object shape.
   */
  return {
    parseWithZod,
    enforceResponse,

    RecommendedRoleSchema,
    RecommendationsRolesResponseSchema,

    RoleCompareRequestSchema,
    RoleCompareResponseSchema,

    CareerPathSchema,
    PathsMultiverseResponseSchema,

    PlanMilestonesRequestSchema,
    PlanMilestonesResponseSchema,
    PlanMilestoneSchema,

    ProfileScoringRequestSchema,
    ProfileScoringResponseSchema,
    ProfileScoringOverrideSchema,

    UuidSchema,
    _optionalNonEmptyString
  };
}

export default getHolisticPersonaSchemas();
