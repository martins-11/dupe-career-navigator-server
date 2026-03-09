# Bedrock Initial Recommendations Debugging

This document explains:

1) How `/api/recommendations/initial` resolves `personaId -> finalPersona JSON`
2) How to capture raw Bedrock output + parsing/validation stats when Bedrock falls back

## 1) personaId → persona JSON resolution path

Route: `src/routes/recommendations.js`

Endpoint: `GET /api/recommendations/initial?personaId=<uuid>`

Resolution logic (best-effort, in order):

1. `personasRepo.getFinal(personaId)`  
   - Intended source of truth (finalized persona JSON)
2. `personasRepo.getLatestPersonaVersion(personaId)`  
   - Compatibility fallback for older data shapes where only versions exist
3. `personasRepo.getDraft(personaId)`  
   - If final is missing, will still attempt to operate on draft-like data
4. Request-provided persona JSON (optional additive):
   - `query.finalPersonaJson=<json-string>`
   - or `body.finalPersona` (if called via POST in some environments)

If none of the above produce a usable object, the endpoint synthesizes a minimal placeholder persona object so the UI can still render.

The resolved persona object is passed into:
- `src/services/recommendationsInitialService.js`
  - `generateInitialRecommendationsPersonaDrivenBedrockOnly({ finalPersona, personaId })`
- which calls:
- `src/services/bedrockService.js`
  - `getInitialRecommendations(finalPersona, { context: null })`

## 2) Capturing raw Bedrock output + validation stats

The initial recommendations Bedrock call lives in:
- `src/services/bedrockService.js` → `getInitialRecommendations()`

Diagnostics are **environment-gated** to avoid leaking model output in normal operation.

### Enable debug capture

Set:

- `BEDROCK_DEBUG_RAW_OUTPUT=true`

When enabled and Bedrock output fails parsing/validation, the endpoint will surface additional information under:

- Response: `meta.bedrockError.details`

Including (when available):

- `details.rawText` (first ~5000 chars of Claude text output)
- `details.extractedText` (the extracted JSON array substring, if any)
- `details.extractedArrayPreview` (first few parsed array entries)
- `details.validationStats` (counts + rejection reasons)
  - `inputCount`, `acceptedCount`, `rejectedCount`, `rejectedReasons`, `rejectedSamples`

### Interpreting `bedrockUsedFallback`

- `meta.bedrockUsedFallback=true` means **Bedrock generation did not produce 5 validated roles** and the service returned deterministic fallback roles.
- `meta.bedrockUsedFallback=false` means Bedrock produced and validated 5 roles successfully.

If you see `bedrockUsedFallback=true` with `bedrock_insufficient_roles`, check `meta.bedrockError.details.validationStats` to see exactly why roles were rejected (e.g., missing title/industry/skills length issues).

## Notes

- The validator for initial recommendations accepts both:
  - prompt-schema keys (`title`, `salary_lpa_range`, ...)
  - role-card keys (`role_title`, `role_id`, ...)
- If Bedrock returns objects but the validator rejects all of them, it will appear as `0 valid roles` even though the model returned content; debug capture is designed to make that visible.
