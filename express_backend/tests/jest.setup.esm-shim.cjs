'use strict';

/**
 * Jest setup shim (CommonJS)
 *
 * Why this exists:
 * - This repo is ESM-first ("type":"module"), but Jest can still load setup hooks in a CJS context.
 * - Some legacy tests call `require(...)`.
 * - Some ESM tests refer to `jest` as a global (which is not automatically present in ESM mode).
 *
 * This shim:
 * 1) Provides `globalThis.require` for ESM tests that still call `require`.
 * 2) Ensures `jest` is available as a global by importing it from '@jest/globals'.
 */

const { createRequire } = require('node:module');

// Provide a CommonJS-like `require` for tests that still call it.
globalThis.require = createRequire(__filename);

/**
 * Provide Jest globals in ESM mode for tests that reference `jest` directly.
 * (Some suites already import { jest } from '@jest/globals', but this keeps older ones working.)
 */
try {
  // eslint-disable-next-line global-require
  const { jest } = require('@jest/globals');
  globalThis.jest = jest;
} catch (_) {
  // If '@jest/globals' isn't available for some reason, do not hard-crash here.
}

/**
 * Hard-disable Bedrock/AWS during tests:
 * - Even if BEDROCK_DISABLE is accidentally unset, ensure the AWS SDK client is mocked.
 * - This prevents credential-provider-chain hangs/crashes in CI.
 */
try {
  const { jest } = require('@jest/globals');

  jest.mock('@aws-sdk/client-bedrock-runtime', () => {
    class BedrockRuntimeClient {
      constructor() {
        // If production code ever tries to instantiate this in tests, fail fast and loudly.
        throw new Error('BedrockRuntimeClient should not be constructed in Jest (AWS disabled).');
      }
    }

    class InvokeModelCommand {
      constructor(_args) {
        // no-op placeholder
      }
    }

    return { BedrockRuntimeClient, InvokeModelCommand };
  });
} catch (_) {
  // no-op: do not break test initialization if jest globals are unavailable for some reason
}
