/**
 * Jest ESM shim
 *
 * Jest runs this repo's `.js` tests as ESM due to `"type": "module"`.
 * A few legacy tests still use `require(...)`. In ESM, `require` is not defined,
 * so those tests fail with `ReferenceError: require is not defined`.
 *
 * This shim provides a `global.require` implementation using Node's `createRequire`.
 *
 * It is intentionally a `.js` file (ESM in this repo), so we can use `import` here.
 */

import { createRequire } from 'node:module';

// Provide a CommonJS-like `require` for tests that still call it.
globalThis.require = createRequire(import.meta.url);
