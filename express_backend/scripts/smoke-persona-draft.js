'use strict';

/**
 * Smoke test script:
 * - Starts no server; directly calls personaService.generatePersonaDraft on provided text
 * - Attempts to persist via personaService.createPersonaDraft (DB optional)
 * - Prints personaDraftId and saved JSON
 *
 * Usage:
 *   node scripts/smoke-persona-draft.js "<resume text here>"
 *
 * Notes:
 * - If BEDROCK_MODEL_ID is unset, generation will run in mock mode.
 * - If MySQL env vars are unset, persistence will be skipped and personaDraftId will be null.
 */

const personaService = require('../src/services/personaService');

async function main() {
  const sourceText = process.argv.slice(2).join(' ').trim();
  if (!sourceText) {
    // eslint-disable-next-line no-console
    console.error('Provide resume text as a single argument (quoted).');
    process.exitCode = 2;
    return;
  }

  const { persona, mode, warnings } = await personaService.generatePersonaDraft(sourceText, { context: null });

  const persisted = await personaService.createPersonaDraft({
    personaDraftJson: persona,
    alignmentScore: 0
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode,
        warnings,
        personaDraftId: persisted.personaDraftId,
        persisted: persisted.persisted,
        savedPersonaDraftJson: persisted.savedPersonaDraftJson || persona
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Smoke test failed:', err);
  process.exitCode = 1;
});
